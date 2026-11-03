export function formatBytes(n) { return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
export async function compressImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Pilih gambar JPG, PNG, WebP atau GIF.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Gambar asal maksimum ialah 25 MB.');
  let image;
  try { image = await createImageBitmap(file); } catch { throw new Error('Fail ini tidak dapat dibaca sebagai gambar.'); }
  try {
    const ratio = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    let blob;
    const draw = () => { const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); };
    draw();
    for (const quality of [.82, .7, .58]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
      if (!blob) throw new Error('Gambar tidak dapat dimampatkan.');
      if (blob.size <= 1024 * 1024) break;
    }
    while (blob.size > 1024 * 1024 && canvas.width > 500 && canvas.height > 500) {
      canvas.width = Math.round(canvas.width * .8); canvas.height = Math.round(canvas.height * .8); draw();
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .65));
      if (!blob) throw new Error('Gambar tidak dapat dimampatkan.');
    }
    if (blob.size > 2 * 1024 * 1024) throw new Error('Gambar masih terlalu besar selepas dimampatkan. Pilih gambar lebih kecil.');
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + (blob.type === 'image/webp' ? '.webp' : '.png'), originalSize: file.size, size: blob.size, width: canvas.width, height: canvas.height, mime: blob.type, still: file.type === 'image/gif' };
  } finally { image.close(); }
}
