import sharp from "sharp";
import { createWorker } from "tesseract.js";

// Toggle detailed logs with env: TESS_DEBUG=1
const DEBUG = process.env.TESS_DEBUG === "1";
const OCR_TIMEOUT_MS = Number(process.env.TESS_TIMEOUT_MS || 10000);

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;
const SKIP_EXT_RE  = /\.(gif|apng)$/i;

let workerPromise;
function dlog(...args) {
  if (DEBUG) console.log("[anonymizer]", ...args);
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      dlog("creating tesseract worker…");
      const worker = createWorker({
        logger: DEBUG ? (m) => console.log("[tesseract]", m) : undefined
      });
      await worker.load();
      await worker.loadLanguage("eng");
      await worker.initialize("eng");
      return worker;
    })();
  }
  return workerPromise;
}

function withTimeout(promise, ms, label = "operation") {
  let t;
  const timeout = new Promise((_, rej) =>
    (t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms))
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function detectTradingViewHeaderTop(buffer) {
  try {
    const img = sharp(buffer);
    const { width, height } = await img.metadata();
    const ocrHeight = Math.round(height * 0.15);
    const prep = img.extract({ left: 0, top: 0, width, height: ocrHeight });
    const topSlice = await prep
      .greyscale()
      .normalize()
      .sharpen()
      .threshold(180)
      .toBuffer();

    const worker = await getWorker();
    dlog("running OCR on top slice…", { width, ocrHeight });
    const { data } = await withTimeout(
      worker.recognize(topSlice),
      OCR_TIMEOUT_MS,
      "tesseract.recognize"
    );

    let maxBottom = 0;
    for (const w of data?.words || []) {
      const y1 = w.bbox?.y1 || 0;
      maxBottom = Math.max(maxBottom, y1);
    }
    const cropTopPx = Math.round(maxBottom / (width / width));
    return { shouldCrop: cropTopPx > 10, cropTopPx };
  } catch (err) {
    console.error("[anonymizer] OCR failed → sending original image:", err);
    return { shouldCrop: false, cropTopPx: 0 };
  }
}

function isProcessableImage(file) {
  const name = file.name || "";
  if (SKIP_EXT_RE.test(name)) return false;
  if (IMAGE_EXT_RE.test(name)) return true;
  return Buffer.isBuffer(file.attachment);
}

export async function anonymizeTradingViewIfNeeded(file) {
  try {
    if (!isProcessableImage(file) || !Buffer.isBuffer(file.attachment)) {
      return file;
    }

    const { shouldCrop, cropTopPx } = await detectTradingViewHeaderTop(file.attachment);
    if (!shouldCrop || cropTopPx <= 0) return file;

    const img = sharp(file.attachment);
    const { width, height } = await img.metadata();
    if (cropTopPx >= height - 10) return file;

    const cropped = await img
      .extract({ left: 0, top: cropTopPx, width, height: height - cropTopPx })
      .toBuffer();

    dlog("cropped", { removedTopPx: cropTopPx, newHeight: height - cropTopPx });
    return { ...file, attachment: cropped };
  } catch (err) {
    console.error("[anonymizer] anonymizeTradingViewIfNeeded failed → send original:", err);
    return file;
  }
}
