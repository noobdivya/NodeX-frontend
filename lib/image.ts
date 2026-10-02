// Prepares a profile photo on the device: centre-crops to a square and
// shrinks to 256×256, so uploads are small (typically 10–30 KB).
const SIZE = 256;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Longest side of a chat photo after resizing. */
const CHAT_MAX_SIDE = 1600;
/** Hard cap for a chat photo after compression. */
export const CHAT_IMAGE_MAX_BYTES = 1024 * 1024;

export type ChatImage = { blob: Blob; width: number; height: number };

/**
 * Prepares a photo for sending in a chat, on this device: scales it down to
 * at most 1600 px and compresses it (WebP, or JPEG where WebP can't be
 * encoded), lowering quality until it is under 1 MB.
 */
export async function toChatImage(file: Blob): Promise<ChatImage> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is too large. Choose one under 20 MB.");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be opened. Try a JPEG or PNG photo.");
  }

  let scale = Math.min(1, CHAT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Your browser can't process images.");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, width, height);

      const quality = 0.82 - attempt * 0.1;
      const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      const webp = await encode("image/webp");
      const blob = webp?.type === "image/webp" ? webp : await encode("image/jpeg");
      if (!blob) throw new Error("Couldn't prepare the photo. Try another one.");
      if (blob.size <= CHAT_IMAGE_MAX_BYTES) return { blob, width, height };
      scale *= 0.8; // still too big: shrink and lower quality
    }
  } finally {
    bitmap.close();
  }
  throw new Error("That photo is too large to send. Try a smaller one.");
}

export async function toAvatarImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("That image is too large. Choose one under 20 MB.");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be opened. Try a JPEG or PNG photo.");
  }

  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can't process images.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();

  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  // WebP is smallest; fall back to JPEG where the browser can't encode WebP.
  const webp = await encode("image/webp");
  const blob = webp?.type === "image/webp" ? webp : await encode("image/jpeg");
  if (!blob) throw new Error("Couldn't prepare the photo. Try another one.");
  return blob;
}
