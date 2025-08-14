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
      // v6: createWorker(langs, oem, options). This loads+inits 'eng'
      return await createWorker("eng", 1, {
        logger: DEBUG ? (m) => console.log("[tesseract]", m) : undefined,
      });
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
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height || height < 140) {
    dlog("skip OCR: tiny or invalid image", { width, height });
    return { shouldCrop: false, cropTopPx: 0 };
  }

  // Process only the top band (where "created with TradingView.com …" lives)
  const ocrHeight = Math.max(64, Math.round(height * 0.22));
  const scale = width < 1400 ? Math.min(2.2, 1400 / width) : 1;

  const prep = img.extract({ left: 0, top: 0, width, height: ocrHeight });
  const topSlice = await (scale !== 1 ? prep.resize(Math.round(width * scale)) : prep)
    .greyscale()
    .normalize()
    .sharpen()
    .threshold(180)
    .toBuffer();

  const worker = await getWorker();
  dlog("running OCR on top slice…", { width, ocrHeight, scale });

  let data;
  try {
    const res = await withTimeout(worker.recognize(topSlice), OCR_TIMEOUT_MS, "tesseract.recognize");
    data = res?.data;
  } catch (err) {
    console.error("[anonymizer] OCR failed/timeout → skip crop:", err.message || err);
    // Optionally: worker might be stuck; reset so next run re-creates it
    workerPromise = null;
    return { shouldCrop: false, cropTopPx: 0 };
  }

  const rawText = (data?.text || "");
  const text = rawText.toLowerCase().replace(/[^a-z0-9 .]/g, " ");
  dlog("ocr text (first 120):", text.slice(0, 120));

  // Fuzzy header detection to survive minor OCR glitches
  const hasTV = /trading\s*view/.test(text) || text.includes("tradingview");
  const hasHeader = hasTV && (text.includes("created") || text.includes("created with"));
  if (!hasHeader) {
    dlog("no TradingView header detected, skip crop");
    return { shouldCrop: false, cropTopPx: 0 };
  }

  // Locate the bottom of header words and crop a little below
  let maxBottomUpscaled = 0;
  for (const w of data?.words || []) {
    const word = (w.text || "").toLowerCase();
    if (
      word.includes("trading") ||
      word.includes("view") ||
      word.includes("tradingview") ||
      word.includes("created") ||
      word.includes("with")
    ) {
      maxBottomUpscaled = Math.max(maxBottomUpscaled, (w.bbox?.y1 ?? 0));
    }
  }

  const maxBottom = Math.round(maxBottomUpscaled / (scale || 1));
  const pad = Math.round(height * 0.01) + 6;
  const cropTopPx = Math.min(
    Math.max(0, Math.round(maxBottom + pad)),
    Math.round(height * 0.12) // cap so we never over-crop
  );

  const finalCrop = cropTopPx > 0 ? cropTopPx : Math.round(height * 0.07);
  dlog("header detected → crop", { maxBottom, finalCrop });
  return { shouldCrop: true, cropTopPx: finalCrop };
}

function isProcessableImage(file) {
  const name = file.name || "";
  if (SKIP_EXT_RE.test(name)) return false; // keep GIFs
  if (IMAGE_EXT_RE.test(name)) return true;
  // no extension? try buffer
  return Buffer.isBuffer(file.attachment);
}

/**
 * If header detected, crop from top. Never throws (fail-open).
 * @param {{attachment:Buffer, name?:string}} file
 */
export async function anonymizeTradingViewIfNeeded(file) {
  try {
    if (!isProcessableImage(file)) return file;
    if (!Buffer.isBuffer(file.attachment)) return file;

    const { shouldCrop, cropTopPx } = await detectTradingViewHeaderTop(file.attachment);
    if (!shouldCrop || cropTopPx <= 0) return file;

    const img = sharp(file.attachment);
    const meta = await img.metadata();
    const { width, height } = meta;
    if (!width || !height || cropTopPx >= height - 10) return file;

    const cropped = await img
      .extract({ left: 0, top: cropTopPx, width, height: height - cropTopPx })
      .toBuffer();

    dlog("cropped", { removedTopPx: cropTopPx, newHeight: height - cropTopPx });
    return { ...file, attachment: cropped };
  } catch (err) {
    console.error("[anonymizer] anonymizeTradingViewIfNeeded failed → send original:", err);
    return file; // fail-open to never block sending
  }
}
