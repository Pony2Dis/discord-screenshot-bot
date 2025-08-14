// utils/anonymizeTradingView.mjs
import sharp from "sharp";
import Tesseract from "tesseract.js";

const DEBUG = process.env.TESS_DEBUG === "1";
const OCR_TIMEOUT_MS = Number(process.env.TESS_TIMEOUT_MS || 10000);

// file extensions we handle (skip gifs/apngs)
const PROCESSABLE = /\.(png|jpe?g|webp)$/i;

// simple debug logger
function dlog(...args) {
  if (DEBUG) console.log("[anonymizer]", ...args);
}

// run OCR on the top slice and decide where to crop
async function detectCrop(buffer) {
  // 1) prep a greyscale high-contrast slice of the top 15% of the image
  const img = sharp(buffer);
  const { width, height } = await img.metadata();
  const sliceHeight = Math.round(height * 0.15);
  const topSlice = await img
    .extract({ left: 0, top: 0, width, height: sliceHeight })
    .greyscale()
    .normalize()
    .sharpen()
    .threshold(180)
    .toBuffer();

  dlog("running OCR…", { sliceHeight, width });
  // 2) perform OCR with the simple recognize API
  const { data } = await Promise.race([
    Tesseract.recognize(topSlice, "eng", {
      logger: DEBUG ? (m) => console.log("[ocr]", m) : undefined,
    }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("OCR timeout")), OCR_TIMEOUT_MS)
    ),
  ]).catch((err) => {
    console.error("[anonymizer] OCR failed:", err);
    return { data: { words: [] } };
  });

  // 3) find the lowest word-bbox.y1 to decide crop point
  let maxY = 0;
  for (const w of data.words || []) {
    if (w.bbox?.y1 > maxY) maxY = w.bbox.y1;
  }

  const cropPx = Math.min(Math.round(maxY), height - 1);
  return cropPx > 10 ? cropPx : 0;
}

// main export: crop off TradingView header if we detected one
export async function anonymizeTradingViewIfNeeded(file) {
  try {
    // skip non-images
    if (!PROCESSABLE.test(file.name || "")) return file;
    if (!Buffer.isBuffer(file.attachment)) return file;

    const cropTop = await detectCrop(file.attachment);
    if (!cropTop) return file;

    // do the actual crop
    const img = sharp(file.attachment);
    const { width, height } = await img.metadata();
    const newBuffer = await img
      .extract({ left: 0, top: cropTop, width, height: height - cropTop })
      .toBuffer();

    dlog("cropped header:", { cropTop, newHeight: height - cropTop });
    return { ...file, attachment: newBuffer };
  } catch (err) {
    console.error("[anonymizer] processing failed, sending original:", err);
    return file;
  }
}
