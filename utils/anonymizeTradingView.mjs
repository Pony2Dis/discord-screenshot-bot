// /utils/anonymizeTradingView.mjs
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;
const SKIP_EXT_RE  = /\.(gif|apng)$/i;

let workerPromise;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng', 1, {
        logger: m => console.log(m) // ✅ allowed, but must be outside worker.postMessage()
      });
      return worker;
    })();
  }
  return workerPromise;
}

async function detectTradingViewHeaderTop(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) return { shouldCrop: false, cropTopPx: 0 };

  const ocrHeight = Math.max(60, Math.round(height * 0.20));
  const topSlice = await img
    .extract({ left: 0, top: 0, width, height: ocrHeight })
    .greyscale()
    .linear(1.4, -30)
    .toBuffer();

  const worker = await getWorker();
  const { data } = await worker.recognize(topSlice);
  const text = (data?.text || "").toLowerCase();

  const hasHeader =
    text.includes("created with tradingview.com") ||
    (text.includes("tradingview.com") && text.includes("created with"));

  if (!hasHeader) return { shouldCrop: false, cropTopPx: 0 };

  let maxBottom = 0;
  for (const w of data.words || []) {
    const word = (w.text || "").toLowerCase();
    if (word.includes("tradingview.com") || word.includes("created") || word.includes("with")) {
      maxBottom = Math.max(maxBottom, (w.bbox?.y1 ?? 0));
    }
  }

  const pad = Math.round(height * 0.01) + 6;
  const cropTopPx = Math.min(
    Math.max(0, Math.round(maxBottom + pad)),
    Math.round(height * 0.12)
  );

  const finalCrop = cropTopPx > 0 ? cropTopPx : Math.round(height * 0.07);
  return { shouldCrop: true, cropTopPx: finalCrop };
}

function isProcessableImage(file) {
  const name = file.name || "";
  if (SKIP_EXT_RE.test(name)) return false;
  if (IMAGE_EXT_RE.test(name)) return true;
  return Buffer.isBuffer(file.attachment);
}

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

    return { ...file, attachment: cropped };
  } catch (err) {
    console.warn("anonymizeTradingViewIfNeeded failed:", err);
    return file; // fail-open
  }
}
