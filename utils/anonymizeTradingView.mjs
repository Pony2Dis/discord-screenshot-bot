// /utils/anonymizeTradingView.js
// npm i sharp tesseract.js
import sharp from "sharp";
import { createWorker } from "tesseract.js";

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;
const SKIP_EXT_RE  = /\.(gif|apng)$/i; // don't process animated

let workerPromise;

/** Lazy-init a shared Tesseract worker (ENG only) */
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker({ logger: null });
      await worker.loadLanguage("eng");
      await worker.initialize("eng");
      return worker;
    })();
  }
  return workerPromise;
}

/** Returns { shouldCrop, cropTopPx } by reading only the top strip */
async function detectTradingViewHeaderTop(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { width, height } = meta;
  if (!width || !height) return { shouldCrop: false, cropTopPx: 0 };

  // Look at the top 20% for the header text, OCR that region only
  const ocrHeight = Math.max(60, Math.round(height * 0.20));
  const topSlice = await img
    .extract({ left: 0, top: 0, width, height: ocrHeight })
    .greyscale()
    .linear(1.4, -30)        // boost contrast a bit
    .toBuffer();

  const worker = await getWorker();
  const { data } = await worker.recognize(topSlice);

  const text = (data?.text || "").toLowerCase();
  const hasHeader =
    text.includes("created with tradingview.com") ||
    (text.includes("tradingview.com") && text.includes("created with"));

  if (!hasHeader) return { shouldCrop: false, cropTopPx: 0 };

  // Find the bottom Y of any word from that header line and crop a bit below it
  let maxBottom = 0;
  for (const w of data.words || []) {
    const word = (w.text || "").toLowerCase();
    if (
      word.includes("tradingview.com") ||
      word.includes("created") ||
      word.includes("with")
    ) {
      maxBottom = Math.max(maxBottom, (w.bbox?.y1 ?? 0));
    }
  }

  // Convert from OCR-slice coords to full-image coords, add padding
  const pad = Math.round(height * 0.01) + 6; // ~1% + few px
  const cropTopPx = Math.min(
    Math.max(0, Math.round(maxBottom + pad)),
    Math.round(height * 0.12) // hard cap 12% so we never over-crop
  );

  // If OCR boxes failed, fall back to a safe default ~7% of height
  const finalCrop = cropTopPx > 0 ? cropTopPx : Math.round(height * 0.07);
  return { shouldCrop: true, cropTopPx: finalCrop };
}

/** Decide if file is an image we should consider */
function isProcessableImage(file) {
  const name = file.name || "";
  if (SKIP_EXT_RE.test(name)) return false;     // keep GIFs intact
  if (IMAGE_EXT_RE.test(name)) return true;
  // No extension? Try a quick sniff: assume Buffer = image if Sharp can parse.
  return Buffer.isBuffer(file.attachment);
}

/**
 * If a TradingView header with username is detected, crop it from the top.
 * Returns a file object compatible with discord.js { attachment: Buffer, name }.
 */
export async function anonymizeTradingViewIfNeeded(file) {
  try {
    if (!isProcessableImage(file)) return file;

    // Ensure we have a Buffer
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
    // On any failure, fail open (return original)
    console.warn("anonymizeTradingViewIfNeeded failed:", err);
    return file;
  }
}
