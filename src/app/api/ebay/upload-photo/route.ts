import { NextResponse } from "next/server";
import { isEbayConfigured, uploadEbayHostedPicture } from "@/lib/ebay";

export const maxDuration = 30;

/**
 * POST /api/ebay/upload-photo
 * Uploads a single resized, EXIF-stripped JPEG photo directly to eBay Picture
 * Services (EPS) via `UploadSiteHostedPictures` and returns its permanent
 * `i.ebayimg.com` HTTPS URL.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      imageBase64?: string;
      fileName?: string;
    };

    const raw = (body.imageBase64 || "").trim();
    if (!raw) {
      return NextResponse.json(
        { error: "Missing imageBase64 payload" },
        { status: 400 }
      );
    }

    // If it's already an HTTPS URL (e.g. from an existing Death Pile draft), pass straight through
    if (/^https?:\/\//i.test(raw)) {
      return NextResponse.json({ mode: "passthrough", url: raw });
    }

    if (!isEbayConfigured()) {
      return NextResponse.json({
        mode: "demo",
        url: raw.startsWith("data:") ? raw : `data:image/jpeg;base64,${raw}`,
      });
    }

    const match = raw.match(/^data:([^;]+);base64,(.+)$/);
    const cleanB64 = match ? match[2] : raw;
    const buffer = Buffer.from(cleanB64, "base64");

    if (buffer.byteLength < 64) {
      return NextResponse.json(
        { error: "Uploaded image buffer is empty or invalid" },
        { status: 400 }
      );
    }

    const url = await uploadEbayHostedPicture(
      buffer,
      body.fileName || "listing-photo.jpg"
    );

    return NextResponse.json({ mode: "live", url });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to upload photo to eBay";
    console.error("[/api/ebay/upload-photo] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
