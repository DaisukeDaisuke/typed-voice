import fs from "node:fs";
import path from "node:path";

const inputPath = process.argv[2];
const outputDirectory = process.argv[3];

if (!inputPath || !outputDirectory) {
  console.error("Usage: node scripts/build-kanalizer-dictionary.mjs <dataset.jsonl> <output-dir>");
  process.exit(2);
}

const sourceRevision = process.env.KANALIZER_DATASET_REVISION || "unknown";
const rows = fs
  .readFileSync(inputPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .map((row) => ({
    word: String(row.word || "").toLowerCase(),
    reading: Array.isArray(row.kata) ? String(row.kata[0] || "") : "",
  }))
  .filter(({ word, reading }) => /^[a-z]+$/.test(word) && reading.length > 0);

rows.sort((a, b) => {
  const lengthDelta = a.word.length - b.word.length;
  if (lengthDelta) return lengthDelta;
  const firstDelta = a.word.charCodeAt(0) - b.word.charCodeAt(0);
  if (firstDelta) return firstDelta;
  return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
});

const maxWordLength = rows.reduce((max, row) => Math.max(max, row.word.length), 0);
const bucketCount = maxWordLength * 26;
const buckets = Array.from({ length: bucketCount }, () => ({ start: 0, count: 0 }));
const poolParts = [];
const records = [];
let poolBytes = 0;

for (const row of rows) {
  const wordBytes = Buffer.from(row.word, "ascii");
  const readingBytes = Buffer.from(row.reading, "utf8");
  const wordOffset = poolBytes;
  poolParts.push(wordBytes);
  poolBytes += wordBytes.length;
  const readingOffset = poolBytes;
  poolParts.push(readingBytes);
  poolBytes += readingBytes.length;
  records.push({ wordOffset, readingOffset, readingLength: readingBytes.length, wordLength: wordBytes.length, first: wordBytes[0] - 97 });
}

for (let index = 0; index < records.length; index += 1) {
  const record = records[index];
  const bucketIndex = (record.wordLength - 1) * 26 + record.first;
  const bucket = buckets[bucketIndex];
  if (bucket.count === 0) bucket.start = index;
  bucket.count += 1;
}

const headerSize = 32;
const bucketRecordSize = 8;
const dictionaryRecordSize = 10;
const indexBytes = Buffer.alloc(headerSize + bucketCount * bucketRecordSize + records.length * dictionaryRecordSize);
indexBytes.write("KDX1", 0, 4, "ascii");
indexBytes.writeUInt16LE(1, 4);
indexBytes.writeUInt16LE(maxWordLength, 6);
indexBytes.writeUInt32LE(records.length, 8);
indexBytes.writeUInt32LE(poolBytes, 12);
indexBytes.writeUInt32LE(bucketCount, 16);
indexBytes.writeUInt32LE(dictionaryRecordSize, 20);
indexBytes.writeUInt32LE(headerSize, 24);
indexBytes.writeUInt32LE(headerSize + bucketCount * bucketRecordSize, 28);

let offset = headerSize;
for (const bucket of buckets) {
  indexBytes.writeUInt32LE(bucket.start, offset);
  indexBytes.writeUInt32LE(bucket.count, offset + 4);
  offset += bucketRecordSize;
}
for (const record of records) {
  indexBytes.writeUInt32LE(record.wordOffset, offset);
  indexBytes.writeUInt32LE(record.readingOffset, offset + 4);
  indexBytes.writeUInt16LE(record.readingLength, offset + 8);
  offset += dictionaryRecordSize;
}

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, "dictionary.idx"), indexBytes);
fs.writeFileSync(path.join(outputDirectory, "dictionary.str"), Buffer.concat(poolParts));
fs.writeFileSync(
  path.join(outputDirectory, "metadata.json"),
  `${JSON.stringify({
    format: "KDX1",
    version: 1,
    source: "VOICEVOX/kanalizer-dataset",
    sourceRevision,
    recordCount: records.length,
    maxWordLength,
    indexBytes: indexBytes.length,
    stringBytes: poolBytes,
  }, null, 2)}\n`,
);

console.log(`records=${records.length}`);
console.log(`maxWordLength=${maxWordLength}`);
console.log(`dictionary.idx=${indexBytes.length}`);
console.log(`dictionary.str=${poolBytes}`);

