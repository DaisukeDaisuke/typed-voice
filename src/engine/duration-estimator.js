// Adapted from VocoLoco's Apache-2.0 RuleDurationEstimator, itself a port of
// OmniVoice's duration estimator. See NOTICE for attribution.

const WEIGHTS = {
  cjk: 3.0,
  hangul: 2.5,
  kana: 2.2,
  ethiopic: 3.0,
  yi: 3.0,
  indic: 1.8,
  thaiLao: 1.5,
  khmerMyanmar: 1.8,
  arabic: 1.5,
  hebrew: 1.5,
  latin: 1.0,
  cyrillic: 1.0,
  greek: 1.0,
  armenian: 1.0,
  georgian: 1.0,
  punctuation: 0.5,
  space: 0.2,
  digit: 3.5,
  mark: 0.0,
  default: 1.0,
};

function weightForCodePoint(code) {
  if (code === 0x20 || code === 0x3000 || (code >= 0x2000 && code <= 0x200a)) return WEIGHTS.space;
  if (code >= 0x30 && code <= 0x39) return WEIGHTS.digit;
  if ((code >= 0x21 && code <= 0x2f) || (code >= 0x3a && code <= 0x40) || (code >= 0x3000 && code <= 0x303f)) {
    return WEIGHTS.punctuation;
  }
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe20 && code <= 0xfe2f)) return WEIGHTS.mark;
  if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) return WEIGHTS.kana;
  if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || code >= 0x20000) return WEIGHTS.cjk;
  if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) return WEIGHTS.hangul;
  if ((code >= 0x590 && code <= 0x5ff)) return WEIGHTS.hebrew;
  if ((code >= 0x600 && code <= 0x8ff) || (code >= 0xfb50 && code <= 0xfeff)) return WEIGHTS.arabic;
  if (code >= 0x900 && code <= 0xdff) return WEIGHTS.indic;
  if (code >= 0xe00 && code <= 0xeff) return WEIGHTS.thaiLao;
  if ((code >= 0x1000 && code <= 0x109f) || (code >= 0x1780 && code <= 0x17ff)) return WEIGHTS.khmerMyanmar;
  if (code >= 0x1200 && code <= 0x139f) return WEIGHTS.ethiopic;
  if (code >= 0xa000 && code <= 0xa4cf) return WEIGHTS.yi;
  if ((code >= 0x41 && code <= 0x7a) || (code >= 0xc0 && code <= 0x2af)) return WEIGHTS.latin;
  if (code >= 0x370 && code <= 0x3ff) return WEIGHTS.greek;
  if (code >= 0x400 && code <= 0x52f) return WEIGHTS.cyrillic;
  if (code >= 0x530 && code <= 0x58f) return WEIGHTS.armenian;
  if (code >= 0x10a0 && code <= 0x10ff) return WEIGHTS.georgian;
  return WEIGHTS.default;
}

export function calculateTextWeight(text) {
  let total = 0;
  for (const char of text) {
    total += weightForCodePoint(char.codePointAt(0));
  }
  return total;
}

export function estimateTargetTokens(text, { speed = 1, refText = "Nice to meet you.", refTokens = 25 } = {}) {
  const referenceWeight = calculateTextWeight(refText);
  const targetWeight = calculateTextWeight(text);
  if (!(referenceWeight > 0) || !(refTokens > 0) || !(speed > 0)) {
    return 1;
  }
  let estimate = targetWeight / (referenceWeight / refTokens);
  if (estimate < 50) {
    estimate = 50 * Math.pow(estimate / 50, 1 / 3);
  }
  return Math.max(1, Math.round(estimate / speed));
}
