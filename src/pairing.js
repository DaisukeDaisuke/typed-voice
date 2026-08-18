import "./pairing.css";
import jsQR from "jsqr";
import { decodeRemotePairingQrText, validateRemotePairingPayload } from "./app/remote-mode-policy.js";
import { writeRemotePairing } from "./app/remote-pairing-store.js";
import { resolvePairingScanRect } from "./app/pairing-scan-policy.js";

const video = document.getElementById("pairing-video");
const canvas = document.getElementById("pairing-canvas");
const placeholder = document.getElementById("pairing-camera-placeholder");
const status = document.getElementById("pairing-status");
const retry = document.getElementById("pairing-retry");
const backLocal = document.getElementById("pairing-back-local");
const context = canvas.getContext("2d", { willReadFrequently: true });
const pairingPageUrl = new URL(document.location.href);
let stream = null;
let scanning = false;
let scanTimer = 0;

const localUrl = new URL("index.html", document.baseURI);
const conversation = pairingPageUrl.searchParams.get("conversation");
if (conversation) localUrl.searchParams.set("conversation", conversation);
backLocal.href = localUrl.href;

function stopCamera() {
  scanning = false;
  if (scanTimer) globalThis.clearTimeout(scanTimer);
  scanTimer = 0;
  for (const track of stream?.getTracks?.() ?? []) track.stop();
  stream = null;
  video.srcObject = null;
}

function decodeQrPayload(text) {
  let value;
  try {
    value = decodeRemotePairingQrText(text);
  } catch {
    throw new Error("typed-voice-serverのJSON QRを読み取ってください。");
  }
  return validateRemotePairingPayload(value);
}

async function completePairing(text) {
  const pairing = decodeQrPayload(text);
  scanning = false;
  status.textContent = "QRを読み取りました。接続情報をこの端末へ保存しています…";
  await writeRemotePairing(pairing);
  stopCamera();
  const target = new URL("index.html", document.baseURI);
  target.searchParams.set("server", "1");
  if (conversation) target.searchParams.set("conversation", conversation);
  status.textContent = "保存できました。クライアントモードへ戻ります。";
  document.location.replace(target.href);
}

function getScanRect() {
  return resolvePairingScanRect(video.videoWidth, video.videoHeight);
}

async function scanFrame() {
  if (!scanning) return;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    const scan = getScanRect();
    canvas.width = scan.width;
    canvas.height = scan.height;
    context.drawImage(
      video,
      scan.x,
      scan.y,
      scan.width,
      scan.height,
      0,
      0,
      scan.width,
      scan.height
    );
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
    if (result?.data) {
      try {
        await completePairing(result.data);
        return;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    }
  }
  scanTimer = globalThis.setTimeout(() => void scanFrame(), 120);
}

async function startCamera() {
  retry.hidden = true;
  placeholder.hidden = false;
  placeholder.textContent = "カメラを起動しています…";
  status.textContent = "外側のカメラの使用を許可してください。";
  stopCamera();
  try {
    if (typeof jsQR !== "function") throw new Error("QR読み取り機能を読み込めませんでした。");
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    stream = mediaStream;
    video.srcObject = stream;
    await video.play();
    placeholder.hidden = true;
    status.textContent = "QRを探しています。画面に見える枠よりかなり広い範囲を、元の解像度のまま読み取ります。";
    scanning = true;
    await scanFrame();
  } catch (error) {
    stopCamera();
    placeholder.hidden = false;
    placeholder.textContent = "カメラを起動できませんでした";
    status.textContent = error instanceof Error ? `カメラを起動できませんでした: ${error.message}` : "カメラを起動できませんでした。";
    retry.hidden = false;
  }
}

retry.addEventListener("click", () => void startCamera());
globalThis.addEventListener("pagehide", stopCamera, { once: true });
void startCamera();
