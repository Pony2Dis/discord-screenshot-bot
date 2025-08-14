// utils/anonymizeTradingView.mjs
import sharp from "sharp";
import Tesseract from "tesseract.js";

const DEBUG = process.env.TESS_DEBUG === "1";
const OCR_TIMEOUT_MS = Number(process.env.TESS_TIMEOUT_MS || 10000);
const PROCESSABLE = /\.(png|jpe?g|webp)$/i;

function dlog(...args) {
  if (DEBUG) console.log("[anonymizer]", ...args);
}

async function detectCrop(buffer) {
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  const sliceHeight = Math.round(height * 0.15);

  const topSlice = await image
    .extract({ left: 0, top: 0, width, height: sliceHeight })
    .greyscale()
    .normalize()
    .sharpen()
    .threshold(180)
    .negate() // Invert to make text black on white for better OCR
    .toBuffer();

  dlog("OCR slice:", { width, sliceHeight });
  let ocrResult;
  try {
    const ocrOptions = {};
    if (DEBUG) {
      ocrOptions.logger = (m) => console.log("[ocr]", m);
    }
    ocrResult = await Promise.race([
      Tesseract.recognize(topSlice, "eng", ocrOptions),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("OCR timeout")), OCR_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("[anonymizer] OCR failed:", err);
    return 0;
  }

  const words = ocrResult?.data?.words || [];
  let maxY = 0;
  for (const w of words) {
    if (w.bbox?.y1 > maxY) maxY = w.bbox.y1;
  }

  const cropPx = Math.min(maxY, height - 1);
  return cropPx > 10 ? cropPx : 0;
}

export async function anonymizeTradingViewIfNeeded(file) {
  try {
    if (!file.name || !PROCESSABLE.test(file.name)) return file;
    if (!Buffer.isBuffer(file.attachment)) return file;

    const cropTop = await detectCrop(file.attachment);
    if (!cropTop) return file;

    const image = sharp(file.attachment);
    const { width, height } = await image.metadata();
    const croppedBuffer = await image
      .extract({ left: 0, top: cropTop, width, height: height - cropTop })
      .toBuffer();

    dlog("cropped header:", { cropTop, newHeight: height - cropTop });
    return { ...file, attachment: croppedBuffer };
  } catch (err) {
    console.error("[anonymizer] processing failed, sending original:", err);
    return file;
  }
}