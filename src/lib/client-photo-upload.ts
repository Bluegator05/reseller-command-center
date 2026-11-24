/**
 * Resizes an uploaded image file in the browser (automatically stripping EXIF/GPS)
 * and uploads it via `/api/ebay/upload-photo` to obtain a permanent HTTPS URL.
 * Falls back cleanly to a compact JPEG data URL if hosted upload is unavailable.
 */
async function resizeImageFileToDataUrl(
  file: File,
  maxDim: number,
  quality: number
): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode image"));
    el.src = rawDataUrl;
  });

  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return rawDataUrl;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

export async function uploadSalePhotoFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please select an image file (JPG, PNG, or WebP).");
  }

  const uploadDataUrl = await resizeImageFileToDataUrl(file, 1200, 0.86);

  try {
    const res = await fetch("/api/ebay/upload-photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: uploadDataUrl,
        fileName: file.name || "sale-photo.jpg",
      }),
    });
    const data = (await res.json()) as { url?: string };
    if (res.ok && data.url && /^https?:\/\//i.test(data.url)) {
      return data.url;
    }
  } catch {
    // Fall through to compact inline data URL fallback
  }

  // Compact inline fallback (~35–65KB) so photo saving never fails if eBay EPS is offline
  return resizeImageFileToDataUrl(file, 640, 0.78);
}
