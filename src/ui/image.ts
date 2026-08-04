/**
 * Read an image file, downscale it, and return a JPEG data URL small enough
 * to live comfortably inside IndexedDB alongside the episode.
 */
export async function fileToSceneImage(file: File, maxDim = 1920, quality = 0.85): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that file as an image.'));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image processing is not available in this browser.');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Tighter compression for character / location gallery photos (IndexedDB-friendly). */
export async function fileToPortraitImage(file: File): Promise<string> {
  return fileToSceneImage(file, 720, 0.72);
}
