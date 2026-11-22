import { NextResponse } from "next/server";
import {
  suggestEbayCategories,
  type StudioConditionChoice,
  type SuggestedEbayCategory,
} from "@/lib/ebay";
import { generateGeminiJson, getGeminiApiKey } from "@/lib/gemini-client";
import { roundCurrency } from "@/lib/stale-engine";

export const maxDuration = 45;

export interface ListingStudioDraftResponse {
  mode: "gemini" | "heuristic";
  modelUsed: string;
  title: string;
  brand: string;
  conditionChoice: StudioConditionChoice;
  conditionDescription: string;
  descriptionPlain: string;
  descriptionHtml: string;
  facebookCopy: string;
  categorySearchQuery: string;
  suggestedCategories: SuggestedEbayCategory[];
  selectedCategoryId: string;
  selectedCategoryPath: string;
  itemSpecifics: Array<{ name: string; value: string }>;
  suggestedPrice: number;
  lowCompPrice: number;
  highCompPrice: number;
  floorPrice: number;
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  isMediaEligible: boolean;
  isLocalPickupRecommended: boolean;
  ebaySoldUrl: string;
  ebayActiveUrl: string;
  facebookSoldUrl: string;
  facebookActiveUrl: string;
}

interface StudioRequestBody {
  images?: Array<{ base64: string; mimeType?: string }>;
  sku?: string;
  whatIsIt?: string;
  testedStatus?: string;
  conditionInput?: "decide" | StudioConditionChoice;
  included?: string;
  missing?: string;
  flaws?: string;
  measurementsWeight?: string;
  notes?: string;
  lowestPrice?: number | null;
  cogs?: number | null;
}

function buildCleanDescriptionHtml(params: {
  summary: string;
  conditionLine: string;
  testedLine: string;
  includedLine: string;
  missingLine: string;
  flawsLine: string;
  measurementsLine: string;
  bullets: string[];
}): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const rows: string[] = [];
  if (params.conditionLine) {
    rows.push(`<li><strong>Condition:</strong> ${esc(params.conditionLine)}</li>`);
  }
  if (params.testedLine) {
    rows.push(`<li><strong>Testing:</strong> ${esc(params.testedLine)}</li>`);
  }
  if (params.includedLine) {
    rows.push(`<li><strong>Included:</strong> ${esc(params.includedLine)}</li>`);
  }
  if (params.missingLine) {
    rows.push(`<li><strong>Not Included:</strong> ${esc(params.missingLine)}</li>`);
  }
  if (params.flawsLine) {
    rows.push(`<li><strong>Flaws / Wear Noted:</strong> ${esc(params.flawsLine)}</li>`);
  }
  if (params.measurementsLine) {
    rows.push(`<li><strong>Measurements / Details:</strong> ${esc(params.measurementsLine)}</li>`);
  }
  for (const b of params.bullets) {
    if (b.trim()) rows.push(`<li>${esc(b.trim())}</li>`);
  }

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; line-height: 1.55; max-width: 720px;">
  <p style="margin: 0 0 12px 0; font-size: 15px;">${esc(params.summary)}</p>
  ${
    rows.length > 0
      ? `<ul style="margin: 0 0 14px 0; padding-left: 20px; font-size: 14px;">\n    ${rows.join("\n    ")}\n  </ul>`
      : ""
  }
  <p style="margin: 0; font-size: 13px; color: #4b5563;">Please review all photos closely as they are part of the description. Carefully packed and shipped fast via USPS Ground Advantage or UPS Ground.</p>
</div>`;
}

export async function POST(request: Request) {
  let body: StudioRequestBody;
  try {
    body = (await request.json()) as StudioRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const rawImages = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  if (rawImages.length === 0 && !body.whatIsIt?.trim()) {
    return NextResponse.json(
      { error: "Add at least 1 photo or describe what the item is." },
      { status: 400 }
    );
  }

  const apiKey = getGeminiApiKey();

  const userFacts = [
    body.whatIsIt?.trim() ? `Seller hint / item name: ${body.whatIsIt.trim()}` : null,
    body.testedStatus && body.testedStatus !== "Doesn't apply"
      ? `Tested status: ${body.testedStatus}`
      : null,
    body.conditionInput && body.conditionInput !== "decide"
      ? `Seller selected condition: ${body.conditionInput}`
      : `Seller wants AI to decide condition accurately from the photos`,
    body.included?.trim() ? `Included: ${body.included.trim()}` : null,
    body.missing?.trim() ? `Missing / NOT included: ${body.missing.trim()}` : null,
    body.flaws?.trim() ? `Flaws noticed by seller: ${body.flaws.trim()}` : null,
    body.measurementsWeight?.trim()
      ? `Measurements / scale weight entered by seller: ${body.measurementsWeight.trim()}`
      : null,
    body.notes?.trim() ? `Extra seller notes: ${body.notes.trim()}` : null,
    body.lowestPrice ? `Lowest price seller would accept: $${body.lowestPrice}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  interface GeminiStudioOutput {
    title: string;
    brand: string;
    ebayCategoryQuery: string;
    compSearchQuery: string;
    conditionChoice: StudioConditionChoice;
    conditionDescription: string;
    summaryParagraph: string;
    extraBullets: string[];
    facebookCopy: string;
    itemSpecifics: Array<{ name: string; value: string }>;
    lowCompPrice: number;
    suggestedPrice: number;
    highCompPrice: number;
    weightOz: number;
    lengthIn: number;
    widthIn: number;
    heightIn: number;
    isMediaEligible: boolean;
    isLocalPickupRecommended: boolean;
  }

  let ai: Partial<GeminiStudioOutput> = {};
  let mode: "gemini" | "heuristic" = "heuristic";
  let modelUsed = "heuristic";

  if (apiKey) {
    try {
      const prompt = `You are a top-rated full-time eBay & multi-channel reseller copywriter creating a ready-to-publish eBay listing.
Inspect ALL provided photos carefully — read every visible brand logo, model number, size tag, material tag, barcode, packaging detail, and visible flaw.
NEVER invent a brand, model number, or feature that is not visible in the photos or stated in the seller facts below.

SELLER FACTS:
${userFacts || "(None provided — rely on photos)"}

Return ONLY valid JSON with these exact keys:
{
  "title": "High-converting eBay SEO title, strictly <= 80 characters, Title Case, NO emojis, NO all-caps spam, NO 'LOOK!' or 'L@@K'",
  "brand": "Exact visible brand name or Unbranded",
  "ebayCategoryQuery": "Clean 3-6 word product type + brand query for eBay category lookup (e.g. 'Men Performance T-Shirt' or 'Christmas Village Collectible Figurine')",
  "compSearchQuery": "Clean 4-7 word search query for eBay & Facebook Sold Comps",
  "conditionChoice": "new_sealed" | "new_opened" | "pre_owned" | "for_parts",
  "conditionDescription": "Honest 1-2 sentence buyer-facing condition & flaw summary (empty string if new_sealed)",
  "summaryParagraph": "Clean 2-3 sentence buyer-friendly product overview stating what it is, key features, and appeal",
  "extraBullets": ["3 to 5 concise factual bullet highlights read from the photos/tags (size, material, color, era, style, model #)"],
  "facebookCopy": "Friendly 3-5 line Facebook Marketplace post with title, condition, flaws/included info, measurements, and local pickup note",
  "itemSpecifics": [
    { "name": "Brand", "value": "..." },
    { "name": "Type", "value": "..." },
    { "name": "Color", "value": "..." }
  ],
  "lowCompPrice": number (conservative USD eBay sold price),
  "suggestedPrice": number (competitive USD eBay Buy It Now price),
  "highCompPrice": number (top-end USD eBay sold price),
  "weightOz": number (PACKAGED shipping weight in ounces; if seller gave grams/lbs/oz, convert accurately and add 3-6 oz for box/poly mailer!),
  "lengthIn": number (packaged shipping box length in inches),
  "widthIn": number (packaged shipping box width in inches),
  "heightIn": number (packaged shipping box height in inches),
  "isMediaEligible": boolean (true ONLY for books, vinyl, CDs, DVDs, VHS),
  "isLocalPickupRecommended": boolean (true if oversized/heavy >20 lbs or >30 in longest side)
}

Important rules for itemSpecifics:
- Include 6 to 10 high-value eBay Item Specifics appropriate for this exact product (e.g. Brand, Type, Model, Color, Size, Department, Material, Style, Occasion, Vintage, MPN, Country/Region of Manufacture).
- Never include empty values or "N/A". Each value must be <= 60 chars.
- If the seller specified flaws, missing items, or testing status, reflect them accurately and honestly.`;

      const imageParts = rawImages.map((img) => {
        const m = (img.base64 || "").match(/^data:([^;]+);base64,(.+)$/);
        return {
          inline_data: {
            mime_type: m?.[1] || img.mimeType || "image/jpeg",
            data: m?.[2] || img.base64,
          },
        };
      });

      const res = await generateGeminiJson<Partial<GeminiStudioOutput>>({
        task: "vision",
        apiKey,
        parts: [{ text: prompt }, ...imageParts],
      });

      ai = res.data || {};
      mode = "gemini";
      modelUsed = res.modelUsed;
    } catch (err) {
      console.warn("[/api/ai/listing-studio] Gemini fallback:", err);
    }
  }

  const title = (ai.title || body.whatIsIt || "Pre-Owned Collectible Item")
    .trim()
    .slice(0, 80);
  const brand = (ai.brand || "Unbranded").trim();

  const resolvedCondition: StudioConditionChoice =
    body.conditionInput && body.conditionInput !== "decide"
      ? body.conditionInput
      : ai.conditionChoice === "new_sealed" ||
          ai.conditionChoice === "new_opened" ||
          ai.conditionChoice === "pre_owned" ||
          ai.conditionChoice === "for_parts"
        ? ai.conditionChoice
        : "pre_owned";

  const conditionLabelMap: Record<StudioConditionChoice, string> = {
    new_sealed: "New, sealed",
    new_opened: "New, open box",
    pre_owned: "Pre-owned",
    for_parts: "For parts or not working",
  };

  const testedLine =
    body.testedStatus && body.testedStatus !== "Doesn't apply"
      ? body.testedStatus
      : "";
  const includedLine = body.included?.trim() || "";
  const missingLine = body.missing?.trim() || "";
  const flawsLine = body.flaws?.trim() || "";
  const measurementsLine = body.measurementsWeight?.trim() || "";

  const conditionDescription = (
    ai.conditionDescription ||
    [
      conditionLabelMap[resolvedCondition],
      testedLine ? `Testing: ${testedLine}` : "",
      flawsLine ? `Flaws: ${flawsLine}` : "",
      missingLine ? `Missing: ${missingLine}` : "",
    ]
      .filter(Boolean)
      .join(". ")
  ).trim();

  const summary =
    ai.summaryParagraph?.trim() ||
    `${title}. ${conditionDescription || "See all photos for full condition and details."}`;
  const extraBullets = Array.isArray(ai.extraBullets)
    ? ai.extraBullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0).slice(0, 6)
    : [];

  const plainLines = [
    summary,
    "",
    `Condition: ${conditionLabelMap[resolvedCondition]}`,
    testedLine ? `Testing: ${testedLine}` : "",
    includedLine ? `Included: ${includedLine}` : "",
    missingLine ? `Not Included: ${missingLine}` : "",
    flawsLine ? `Flaws / Wear Noted: ${flawsLine}` : "",
    measurementsLine ? `Measurements / Details: ${measurementsLine}` : "",
    ...extraBullets.map((b) => `• ${b}`),
    "",
    "Please review all photos closely as they are part of the description. Ships fast via USPS Ground Advantage or UPS Ground.",
  ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""));

  const descriptionPlain = plainLines.join("\n").trim();
  const descriptionHtml = buildCleanDescriptionHtml({
    summary,
    conditionLine: conditionLabelMap[resolvedCondition],
    testedLine,
    includedLine,
    missingLine,
    flawsLine,
    measurementsLine,
    bullets: extraBullets,
  });

  const suggestedPrice = roundCurrency(
    Math.max(4, Number(ai.suggestedPrice) || Number(body.lowestPrice || 0) * 1.35 || 24.99)
  );
  const lowCompPrice = roundCurrency(
    Math.max(3, Number(ai.lowCompPrice) || suggestedPrice * 0.78)
  );
  const highCompPrice = roundCurrency(
    Math.max(suggestedPrice, Number(ai.highCompPrice) || suggestedPrice * 1.28)
  );
  const floorPrice =
    body.lowestPrice && Number(body.lowestPrice) > 0
      ? roundCurrency(Number(body.lowestPrice))
      : roundCurrency(
          Math.max(
            (Number(body.cogs) || 0) * 1.35,
            suggestedPrice * 0.72
          )
        );

  const weightOz = Math.max(2, Math.round(Number(ai.weightOz) || 14));
  const lengthIn = Math.max(4, Math.round(Number(ai.lengthIn) || 10));
  const widthIn = Math.max(4, Math.round(Number(ai.widthIn) || 8));
  const heightIn = Math.max(1, Math.round(Number(ai.heightIn) || 4));
  const longestSide = Math.max(lengthIn, widthIn, heightIn);
  const isLocalPickupRecommended =
    Boolean(ai.isLocalPickupRecommended) || weightOz >= 320 || longestSide >= 30;

  const categorySearchQuery = (
    ai.ebayCategoryQuery ||
    ai.compSearchQuery ||
    title
  ).trim();
  const compQuery = (ai.compSearchQuery || title).trim();

  // Fetch real leaf eBay categories from eBay Trading API!
  const suggestedCategories = await suggestEbayCategories(categorySearchQuery);
  const primaryCat = suggestedCategories[0];

  const rawSpecs = Array.isArray(ai.itemSpecifics) ? ai.itemSpecifics : [];
  const itemSpecifics: Array<{ name: string; value: string }> = [];
  const seenNames = new Set<string>();
  for (const s of rawSpecs) {
    const name = String(s?.name || "").trim();
    const value = String(s?.value || "").trim();
    if (!name || !value || /^n\/?a$/i.test(value)) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    itemSpecifics.push({ name: name.slice(0, 40), value: value.slice(0, 65) });
  }
  if (!seenNames.has("brand") && brand) {
    itemSpecifics.unshift({ name: "Brand", value: brand });
  }

  const facebookCopy = (
    ai.facebookCopy?.trim() ||
    `${title}\n\nCondition: ${conditionLabelMap[resolvedCondition]}${testedLine ? ` (${testedLine})` : ""}${flawsLine ? `\nFlaws noted: ${flawsLine}` : ""}${includedLine ? `\nIncludes: ${includedLine}` : ""}${measurementsLine ? `\nMeasurements: ${measurementsLine}` : ""}\n\nPrice: $${Math.round(suggestedPrice)} — Local pickup available. Message if interested!`
  ).trim();

  const encQ = encodeURIComponent(compQuery);
  const payload: ListingStudioDraftResponse = {
    mode,
    modelUsed,
    title,
    brand,
    conditionChoice: resolvedCondition,
    conditionDescription,
    descriptionPlain,
    descriptionHtml,
    facebookCopy,
    categorySearchQuery,
    suggestedCategories,
    selectedCategoryId: primaryCat?.categoryId || "",
    selectedCategoryPath: primaryCat?.categoryPath || "",
    itemSpecifics,
    suggestedPrice,
    lowCompPrice,
    highCompPrice,
    floorPrice,
    weightOz,
    lengthIn,
    widthIn,
    heightIn,
    isMediaEligible: Boolean(ai.isMediaEligible),
    isLocalPickupRecommended,
    ebaySoldUrl: `https://www.ebay.com/sch/i.html?_nkw=${encQ}&LH_Sold=1&LH_Complete=1&_sop=13`,
    ebayActiveUrl: `https://www.ebay.com/sch/i.html?_nkw=${encQ}&_sop=15`,
    facebookSoldUrl: `https://www.facebook.com/marketplace/search/?query=${encQ}&availability=out%20of%20stock`,
    facebookActiveUrl: `https://www.facebook.com/marketplace/search/?query=${encQ}`,
  };

  return NextResponse.json(payload);
}
