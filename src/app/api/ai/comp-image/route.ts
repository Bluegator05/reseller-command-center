import { NextResponse } from "next/server";

export interface ImageCompResponse {
  mode: "gemini" | "demo";
  modelUsed: string;
  itemTitle: string;
  ebaySearchQuery: string;
  brand: string;
  category: string;
  estLowPrice: number;
  estMedianPrice: number;
  estHighPrice: number;
  estWeightOz: number;
  estLengthIn: number;
  estWidthIn: number;
  estHeightIn: number;
  isMediaEligible: boolean;
  inspectionTips: string[];
  ebaySoldUrl: string;
  ebayActiveUrl: string;
}

/**
 * POST /api/ai/comp-image
 * Accepts a base64 JPEG/WebP/PNG snapshot from iPhone camera or desktop upload,
 * identifies the item with Gemini 2.5 Flash multimodal vision, and returns an
 * optimized eBay Sold Comps query, estimated price range, package weight/dims,
 * Media Mail eligibility, and in-store condition checkpoints.
 */
export async function POST(request: Request) {
  let body: {
    imageBase64?: string;
    mimeType?: string;
    fileName?: string;
    hint?: string;
  };
  try {
    body = (await request.json()) as {
      imageBase64?: string;
      mimeType?: string;
      fileName?: string;
      hint?: string;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const rawB64 = (body.imageBase64 || "").trim();
  if (!rawB64) {
    return NextResponse.json(
      { error: "Provide imageBase64 from camera or upload" },
      { status: 400 }
    );
  }

  // Strip optional data URL prefix
  const dataUrlMatch = rawB64.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = dataUrlMatch?.[1] || body.mimeType || "image/jpeg";
  const cleanBase64 = dataUrlMatch?.[2] || rawB64;

  const apiKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    ""
  ).trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

  if (apiKey) {
    try {
      const prompt = `You are an expert eBay reseller sourcing assistant standing in a thrift store or estate sale.
Inspect this item photo${body.hint ? ` (reseller hint: "${body.hint}")` : ""} and return ONLY valid JSON with these exact keys:
{
  "itemTitle": "Concise eBay-ready item title (max 75 chars, include brand/model/size if visible)",
  "ebaySearchQuery": "Clean 4-7 word search query optimized for eBay Sold Comps (no filler words)",
  "brand": "Brand name or Unbranded",
  "category": "Short category (e.g. Film Camera, Mens Outerwear, Vintage Electronics, Cookware, Books/Media)",
  "estLowPrice": number (conservative USD sold price),
  "estMedianPrice": number (typical USD sold price),
  "estHighPrice": number (top condition USD sold price),
  "estWeightOz": number (packaged shipping weight in ounces),
  "estLengthIn": number (packaged box length in inches),
  "estWidthIn": number (packaged box width in inches),
  "estHeightIn": number (packaged box height in inches),
  "isMediaEligible": boolean (true ONLY for books, vinyl records, CDs, DVDs, VHS, sheet music; false for video games/electronics/apparel),
  "inspectionTips": ["Short in-store flaw/test check #1", "Short check #2", "Short check #3"]
}`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: cleanBase64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let detail = `Gemini Vision HTTP ${res.status} (${model})`;
        try {
          const parsedErr = JSON.parse(errBody) as {
            error?: { message?: string };
          };
          if (parsedErr.error?.message) {
            detail = `${detail}: ${parsedErr.error.message}`;
          }
        } catch {
          if (errBody) detail = `${detail}: ${errBody.slice(0, 180)}`;
        }
        return NextResponse.json({ error: detail }, { status: 502 });
      }

      const json = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      const rawText = (
        json.candidates?.[0]?.content?.parts?.[0]?.text || ""
      )
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      if (!rawText) {
        return NextResponse.json(
          { error: `Gemini (${model}) returned an empty response for this photo.` },
          { status: 502 }
        );
      }

      const parsed = JSON.parse(rawText) as Partial<ImageCompResponse>;
      const query = (
        parsed.ebaySearchQuery ||
        parsed.itemTitle ||
        body.hint ||
        "vintage collectible"
      ).trim();

      const payload: ImageCompResponse = {
        mode: "gemini",
        modelUsed: model,
        itemTitle: (parsed.itemTitle || query).slice(0, 80),
        ebaySearchQuery: query,
        brand: parsed.brand || "Unbranded",
        category: parsed.category || "General",
        estLowPrice: Math.max(1, Number(parsed.estLowPrice) || 25),
        estMedianPrice: Math.max(1, Number(parsed.estMedianPrice) || 45),
        estHighPrice: Math.max(1, Number(parsed.estHighPrice) || 75),
        estWeightOz: Math.max(2, Number(parsed.estWeightOz) || 18),
        estLengthIn: Math.max(4, Number(parsed.estLengthIn) || 10),
        estWidthIn: Math.max(4, Number(parsed.estWidthIn) || 8),
        estHeightIn: Math.max(1, Number(parsed.estHeightIn) || 4),
        isMediaEligible: Boolean(parsed.isMediaEligible),
        inspectionTips:
          Array.isArray(parsed.inspectionTips) &&
          parsed.inspectionTips.length > 0
            ? parsed.inspectionTips.slice(0, 4).map(String)
            : [
                "Check for cracks, stains, missing parts, or battery corrosion.",
                "Verify exact model number on the underside or inner tag.",
              ],
        ebaySoldUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`,
        ebayActiveUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`,
      };

      return NextResponse.json(payload);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Gemini Vision request failed";
      return NextResponse.json(
        { error: `Gemini Vision error (${model}): ${msg}` },
        { status: 502 }
      );
    }
  }

  // Clean fallback when GEMINI_API_KEY is not yet configured:
  // Never fabricate a fake product name for a real user photo.
  const hintClean = (body.hint || "").trim();

  const payload: ImageCompResponse = {
    mode: "demo",
    modelUsed: "vision-not-configured",
    itemTitle: hintClean,
    ebaySearchQuery: hintClean,
    brand: "",
    category: "Unidentified (Connect GEMINI_API_KEY for live AI vision)",
    estLowPrice: 0,
    estMedianPrice: 0,
    estHighPrice: 0,
    estWeightOz: 0,
    estLengthIn: 0,
    estWidthIn: 0,
    estHeightIn: 0,
    isMediaEligible: false,
    inspectionTips: [
      "Photo attached! Add GEMINI_API_KEY in Vercel Environment Variables to enable automatic Gemini 2.5 Flash Vision identification from iPhone photos.",
      "Until connected, type the item brand/model below to open eBay Sold Comps and run profit + shipping math.",
    ],
    ebaySoldUrl: hintClean
      ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(hintClean)}&LH_Sold=1&LH_Complete=1`
      : "https://www.ebay.com/sch/i.html?_nkw=&LH_Sold=1&LH_Complete=1",
    ebayActiveUrl: hintClean
      ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(hintClean)}`
      : "https://www.ebay.com/",
  };

  return NextResponse.json(payload);
}
