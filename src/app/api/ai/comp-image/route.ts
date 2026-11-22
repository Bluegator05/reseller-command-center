import { NextResponse } from "next/server";
import { generateGeminiJson, getGeminiApiKey } from "@/lib/gemini-client";

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
  isLocalPickupRecommended?: boolean;
  inspectionTips: string[];
  ebaySoldUrl: string;
  ebayActiveUrl: string;
  facebookSoldUrl: string;
  facebookActiveUrl: string;
}

export const maxDuration = 30;

/**
 * POST /api/ai/comp-image
 * Accepts a base64 JPEG/WebP/PNG snapshot from iPhone camera or desktop upload,
 * identifies the item with Gemini 4 Hydrogen multimodal vision (falling back to
 * Gemini 3.8 Flash / 3.5 Flash-Lite if needed), and returns an optimized eBay
 * & Facebook Marketplace Sold Comps query, estimated price range, package weight/dims,
 * Media Mail eligibility, local-pickup flag, and in-store condition checkpoints.
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

  const apiKey = getGeminiApiKey();

  if (apiKey) {
    try {
      const prompt = `You are an expert reseller sourcing assistant standing in a thrift store or estate sale.
Inspect this item photo${body.hint ? ` (reseller hint: "${body.hint}")` : ""} carefully. Read any visible brand names, model numbers, labels, tags, or markings. Do NOT invent a brand or model number if it is not clearly visible in the photo — describe the exact visible item type/material/features instead.
Return ONLY valid JSON with these exact keys:
{
  "itemTitle": "Concise listing-ready item title (max 75 chars, include brand/model/size only if clearly visible)",
  "ebaySearchQuery": "Clean 4-7 word search query optimized for eBay & Facebook Marketplace Sold Comps (no filler words)",
  "brand": "Exact visible brand name, or Unbranded",
  "category": "Short category (e.g. Film Camera, Mens Outerwear, Vintage Electronics, Cookware, Furniture, Books/Media)",
  "estLowPrice": number (conservative USD sold price),
  "estMedianPrice": number (typical USD sold price),
  "estHighPrice": number (top condition USD sold price),
  "estWeightOz": number (packaged shipping weight in ounces),
  "estLengthIn": number (packaged box length in inches),
  "estWidthIn": number (packaged box width in inches),
  "estHeightIn": number (packaged box height in inches),
  "isMediaEligible": boolean (true ONLY for books, vinyl records, CDs, DVDs, VHS, sheet music; false for video games/electronics/apparel/signs),
  "isLocalPickupRecommended": boolean (true if the item is bulky/oversized/heavy furniture, large mirror, framed wall art >30in, bike, lawn equipment, or impractical to ship economically),
  "inspectionTips": ["Short in-store flaw/test check #1", "Short check #2", "Short check #3"]
}`;

      const { data: parsed, modelUsed } =
        await generateGeminiJson<Partial<ImageCompResponse>>({
          task: "vision",
          apiKey,
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: cleanBase64,
              },
            },
          ],
        });

      const query = (
        parsed.ebaySearchQuery ||
        parsed.itemTitle ||
        body.hint ||
        "vintage collectible"
      ).trim();

      const estWeightOz = Math.max(2, Number(parsed.estWeightOz) || 18);
      const estLengthIn = Math.max(4, Number(parsed.estLengthIn) || 10);
      const estWidthIn = Math.max(4, Number(parsed.estWidthIn) || 8);
      const estHeightIn = Math.max(1, Number(parsed.estHeightIn) || 4);
      const longestSide = Math.max(estLengthIn, estWidthIn, estHeightIn);
      const isLocalPickupRecommended =
        Boolean(parsed.isLocalPickupRecommended) ||
        estWeightOz >= 400 ||
        longestSide >= 30;

      const payload: ImageCompResponse = {
        mode: "gemini",
        modelUsed,
        itemTitle: (parsed.itemTitle || query).slice(0, 80),
        ebaySearchQuery: query,
        brand: parsed.brand || "Unbranded",
        category: parsed.category || "General",
        estLowPrice: Math.max(1, Number(parsed.estLowPrice) || 25),
        estMedianPrice: Math.max(1, Number(parsed.estMedianPrice) || 45),
        estHighPrice: Math.max(1, Number(parsed.estHighPrice) || 75),
        estWeightOz,
        estLengthIn,
        estWidthIn,
        estHeightIn,
        isMediaEligible: Boolean(parsed.isMediaEligible),
        isLocalPickupRecommended,
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
        facebookSoldUrl: `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}&availability=out%20of%20stock`,
        facebookActiveUrl: `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`,
      };

      return NextResponse.json(payload);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Gemini Vision request failed";
      return NextResponse.json(
        { error: `Gemini Vision error: ${msg}` },
        { status: 502 }
      );
    }
  }

  // Clean fallback when GEMINI_API_KEY is not yet configured:
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
    isLocalPickupRecommended: false,
    inspectionTips: [
      "Photo attached! Add GEMINI_API_KEY in Vercel Environment Variables to enable automatic Gemini 4 Hydrogen Vision identification from iPhone photos.",
      "Until connected, type the item brand/model below to open eBay or Facebook Sold Comps and run profit math.",
    ],
    ebaySoldUrl: hintClean
      ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(hintClean)}&LH_Sold=1&LH_Complete=1`
      : "https://www.ebay.com/sch/i.html?_nkw=&LH_Sold=1&LH_Complete=1",
    ebayActiveUrl: hintClean
      ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(hintClean)}`
      : "https://www.ebay.com/",
    facebookSoldUrl: hintClean
      ? `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(hintClean)}&availability=out%20of%20stock`
      : "https://www.facebook.com/marketplace/",
    facebookActiveUrl: hintClean
      ? `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(hintClean)}`
      : "https://www.facebook.com/marketplace/",
  };

  return NextResponse.json(payload);
}
