// utils/anonymizeTradingView.mjs
import sharp from "sharp";
import { createWorker } from "tesseract.js";

// Toggle detailed logs with env: TESS_DEBUG=1
const DEBUG = process.env.TESS_DEBUG === "1";
// Timeout for any Tesseract OCR operation (in milliseconds)
const OCR_TIMEOUT_MS = Number(process.env.TESS_TIMEOUT_MS || 10000);

// File extension regexes
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const SKIP_EXT_RE  = /\.(gif|apng)$/i;

let workerPromise;

/**
 * Conditional debug logger
 */
function dlog(...args) {
  if (DEBUG) console.log("[anonymizer]", ...args);
}

/**
 * Lazily create and initialize a single Tesseract worker.
 * In v6, loadLanguage takes an array.
 */
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      dlog("creating tesseract worker…");
      const worker = createWorker({
        logger: DEBUG ? (m) => console.log("[tesseract]", m) : undefined,
      });
      // load the core WASM, then the language data
      await worker.load();
      await worker.loadLanguage(["eng"]);
      await worker.initialize("eng");
      return worker;
    })();
  }
  return workerPromise;
}

/**
 * Wrap a promise with a timeout.
 */
function withTimeout(promise, ms, label = "operation") {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Run OCR on the top slice of the image to detect where the TradingView header ends.
 * Returns { shouldCrop, cropTopPx }.
 */
async function detectTradingViewHeaderTop(buffer) {
  try {
    const img = sharp(buffer);
    const { width, height } = await img.metadata();

    // Take top 15% of height
    const ocrHeight = Math.round(height * 0.15);
    const topSlice = await img
      .extract({ left: 0, top: 0, width, height: ocrHeight })
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

    // Find maximum bottom Y of any detected word
    let maxBottom = 0;
    for (const w of data.words || []) {
      if (w.bbox && typeof w.bbox.y1 === "number") {
        maxBottom = Math.max(maxBottom, w.bbox.y1);
      }
    }

    // If the header is more than 10px tall, crop it
    const cropTopPx = Math.round(maxBottom);
    return { shouldCrop: cropTopPx > 10, cropTopPx };
  } catch (err) {
    console.error("[anonymizer] OCR failed — will not crop:", err);
    return { shouldCrop: false, cropTopPx: 0 };
  }
}

/**
 * Determine if this file object has an image attachment we can process.
 * We expect { name, attachment: Buffer }.
 */
function isProcessableImage(file) {
  const name = file.name || "";
  if (SKIP_EXT_RE.test(name)) return false;
  if (IMAGE_EXT_RE.test(name)) return true;
  return Buffer.isBuffer(file.attachment);
}

/**
 * If the image is a TradingView chart with a header, crop off the header.
 * Otherwise return the original file object.
 */
export async function anonymizeTradingViewIfNeeded(file) {
  try {
    if (!isProcessableImage(file) || !Buffer.isBuffer(file.attachment)) {
      return file;
    }

    const { shouldCrop, cropTopPx } = await detectTradingViewHeaderTop(file.attachment);
    if (!shouldCrop || cropTopPx <= 0) {
      dlog("no cropping needed");
      return file;
    }

    // Read metadata again to crop correctly
    const img = sharp(file.attachment);
    const { width, height } = await img.metadata();
    if (cropTopPx >= height - 10) {
      dlog("detected crop height too large, skipping");
      return file;
    }

    const croppedBuffer = await img
      .extract({ left: 0, top: cropTopPx, width, height: height - cropTopPx })
      .toBuffer();

    dlog("cropped image", { removedTopPx: cropTopPx, newHeight: height - cropTopPx });
    return { ...file, attachment: croppedBuffer };
  } catch (err) {
    console.error("[anonymizer] anonymizeTradingViewIfNeeded failed — sending original:", err);
    return file;
  }
}
