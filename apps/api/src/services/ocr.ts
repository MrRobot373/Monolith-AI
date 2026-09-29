/**
 * Local OCR for scanned PDFs and images (Tesseract, English model bundled, nothing leaves the server).
 * One worker is shared and jobs run one at a time to keep memory predictable.
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Worker } from "tesseract.js";

const require = createRequire(import.meta.url);

export const ocrEnabled = () => (process.env.OCR_ENABLED ?? "true") !== "false";

export class OcrError extends Error {}

let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  worker ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
    return createWorker("eng", 1, {
      langPath,
      gzip: true,
      cachePath: join(tmpdir(), "aatmiq-ocr"),
      logger: () => {},
      // Failures reject the job below; without this they also surface as uncaught errors.
      errorHandler: () => {},
    });
  })();
  return worker;
}

/** Recognise text in a PNG/JPEG/WebP/TIFF/BMP image. */
export function ocrImage(image: Buffer): Promise<string> {
  const job = queue.then(async () => {
    // Decode first so a broken or disguised file fails cleanly instead of inside the OCR worker.
    const { loadImage } = await import("@napi-rs/canvas");
    try {
      await loadImage(image);
    } catch {
      throw new OcrError("This image couldn't be read. Upload a PNG, JPEG, WebP, TIFF or BMP file.");
    }
    const w = await getWorker();
    const { data } = await w.recognize(image);
    return data.text;
  });
  queue = job.catch(() => {});
  return job;
}

export async function stopOcr() {
  if (!worker) return;
  const w = await worker;
  worker = null;
  await w.terminate();
}
