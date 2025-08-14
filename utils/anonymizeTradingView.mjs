// /utils/anonymizeTradingView.mjs
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;
const SKIP_EXT_RE  = /\.(gif|apng)$/i;

let workerPromise;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // v6: createWorker(langs, oem, options). Loads & initializes 'eng'
      return await createWorker('eng', 1, { logger: undefined });
    })();
  }
  return workerPromise;
}

async function detectTradingViewHeaderTop(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height || height < 140) return { shouldCrop: false, cropTopPx: 0 };

  // OCR only the top band; upscale + binarize for robust OCR (dark/light themes)
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
  const { data } = await worker.recognize(topSlice);
  const text = (data?.text || "").toLowerCase().replace(/[^a-z0-9 .]/g, " ");

  // Fuzzy header detection
  const hasTV = /trading\s*view/.test(text) || text.includes("tradingview");
  const hasHeader = hasTV && (text.includes("created") || text.includes("created with"));
  if (!hasHeader) return { shouldCrop: false, cropTopPx: 0 };

  // Find the bottom Y of header words, map back from upscaled coords
  let maxBottom = 0;
  for (const w of data.words || []) {
    const word = (w.text || "").toLowerCase();
    if (word.includes("trading") || word.includes("view") || word.includes("tradingview") || word.includes("created") || word.includes("with")) {
      const y1 = (w.bbox?.y1 ?? 0);
      maxBottom = Math.max(maxBottom, Math.round(y1 / scale));
    }
  }

  const pad = Math.round(height * 0.01) + 6; // a little padding under the header
  const cropTopPx = Math.min(
    Math.max(0, Math.round(maxBottom + pad)),
    Math.round(height * 0.12) // hard cap so we never over-crop
  );

  const finalCrop = cropTopPx > 0 ? cropTopPx : Math.round(height * 0.07);
  return { shouldCrop: true, cropTopPx: finalCrop };
}

function isProcessableImage(file) {
  const name = file.name || "";
  if (SKIP_EXT_RE.test(name)) return false; // leave GIFs alone
  if (IMAGE_EXT_RE.test(name)) return true;
  return Buffer.isBuffer(file.attachment); // no extension? try buffer
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
    return file; // fail-open: never block sending
  }
}
