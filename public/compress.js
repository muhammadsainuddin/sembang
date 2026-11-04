export function formatBytes(n) { return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
export async function compressImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif'].includes(file.type)) throw new Error('Choose a photo from your gallery. JPG, PNG, WebP, GIF, HEIC, HEIF, and AVIF are supported when your device can decode them.');
  if (file.size > 25 * 1024 * 1024) throw new Error('The original image can be at most 25 MB.');
  let image;
  try { image = await createImageBitmap(file); } catch { throw new Error('This file could not be read as an image.'); }
  try {
    const ratio = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    let blob;
    const draw = () => { const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); };
    draw();
    for (const quality of [.82, .7, .58]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob) throw new Error('The image could not be compressed.');
      if (blob.size <= 1024 * 1024) break;
    }
    while (blob.size > 1024 * 1024 && canvas.width > 500 && canvas.height > 500) {
      canvas.width = Math.round(canvas.width * .8); canvas.height = Math.round(canvas.height * .8); draw();
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .65));
      if (!blob) throw new Error('The image could not be compressed.');
    }
    if (blob.size > 2 * 1024 * 1024) throw new Error('The image is still too large after compression. Choose a smaller image.');
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + (blob.type === 'image/webp' ? '.webp' : '.png'), originalSize: file.size, size: blob.size, width: canvas.width, height: canvas.height, mime: blob.type, still: file.type === 'image/gif' };
  } finally { image.close(); }
}

export async function compressAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 15 * 1024 * 1024) throw new Error('The original photo can be at most 15 MB.');
  let image;
  try { image = await createImageBitmap(file); } catch { throw new Error('This file could not be read as a photo.'); }
  try {
    const side = Math.min(image.width, image.height);
    const sx = Math.round((image.width - side) / 2), sy = Math.round((image.height - side) / 2);
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, sx, sy, side, side, 0, 0, 512, 512);
    let blob;
    for (const quality of [.84, .74, .64]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob) throw new Error('The photo could not be processed.');
      if (blob.size <= 500 * 1024) break;
    }
    if (blob.size > 512 * 1024) throw new Error('The photo is still too large after compression.');
    return blob;
  } finally { image.close(); }
}
