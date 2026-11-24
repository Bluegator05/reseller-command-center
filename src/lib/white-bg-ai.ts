"use client";

/**
 * Client-side neural subject segmentation for studio White Background mode.
 *
 * Uses `@imgly/background-removal` (IS-Net FP16 neural segmentation model via WASM)
 * so white/cream/light-colored items (white plush, white shoes, white shirts, porcelain)
 * keep 100% of their original pixels intact instead of getting chewed up by RGB flood-fill.
 *
 * Dynamically imported only when the user clicks "White" so initial page load stays tiny.
 */

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(",");
  const mimeMatch = header?.match(/data:([^;]+);base64/i);
  const mime = mimeMatch?.[1] || "image/jpeg";
  const binary = atob(b64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read cutout image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Runs neural subject segmentation on an image data URL and returns a transparent PNG
 * data URL containing ONLY the foreground product with clean feathered alpha edges.
 */
export async function generateSubjectCutoutPng(
  sourceDataUrl: string,
  onProgress?: (label: string) => void
): Promise<string> {
  onProgress?.("Loading AI cutout…");
  const { removeBackground } = await import("@imgly/background-removal");

  const inputBlob = dataUrlToBlob(sourceDataUrl);

  const resultBlob = await removeBackground(inputBlob, {
    model: "isnet_fp16",
    output: {
      format: "image/png",
      quality: 1,
    },
    progress: (key: string, current: number, total: number) => {
      if (!onProgress) return;
      if (key.startsWith("fetch:")) {
        const pct =
          total > 0 ? Math.min(99, Math.round((current / total) * 100)) : 0;
        onProgress(
          pct > 0 ? `Loading AI model… ${pct}%` : "Loading AI model…"
        );
      } else if (key.startsWith("compute:")) {
        onProgress("Removing background…");
      }
    },
  });

  return blobToDataUrl(resultBlob);
}
