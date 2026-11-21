import { DEFAULT_EBAY_FEE_PCT, roundCurrency } from "./stale-engine";
import { getEnvReadiness } from "./supabase";
import type {
  CrossListDraftPayload,
  CrossListPriceBreakdown,
  InventoryItem,
  MarketplaceAccount,
  MarketplaceType,
} from "./types";

const MARKETPLACE_TITLE_LIMITS: Record<MarketplaceType, number> = {
  ebay: 80,
  etsy: 140,
  poshmark: 80,
  mercari: 80,
  facebook: 99,
};

const DEFAULT_CHANNEL_FEES: Record<
  MarketplaceType,
  { feePct: number; markupPct: number }
> = {
  ebay: { feePct: 13.25, markupPct: 0 },
  etsy: { feePct: 9.5, markupPct: 5 },
  poshmark: { feePct: 20, markupPct: 12 },
  mercari: { feePct: 10, markupPct: 5 },
  facebook: { feePct: 5, markupPct: 0 },
};

interface EtsyTaxonomyMatch {
  taxonomyId: number;
  categoryPath: string;
  whenMade: string;
}

const ETSY_TAXONOMY_RULES: Array<{
  keywords: RegExp;
  match: EtsyTaxonomyMatch;
}> = [
  {
    keywords: /camera|slr|lens|35mm|film|olympus|canon|nikon/i,
    match: {
      taxonomyId: 830,
      categoryPath: "Electronics & Accessories > Cameras > Film Cameras",
      whenMade: "1980s",
    },
  },
  {
    keywords: /walkman|cassette|audio|radio|turntable|sony/i,
    match: {
      taxonomyId: 834,
      categoryPath: "Electronics & Accessories > Audio > Vintage Audio",
      whenMade: "1980s",
    },
  },
  {
    keywords: /nintendo|n64|controller|gameboy|playstation|sega|video game/i,
    match: {
      taxonomyId: 851,
      categoryPath: "Electronics & Accessories > Video Games > Retro Gaming",
      whenMade: "1990_1999",
    },
  },
  {
    keywords: /jeans|denim|levi/i,
    match: {
      taxonomyId: 491,
      categoryPath: "Clothing > Unisex Adult Clothing > Vintage Jeans",
      whenMade: "1990_1999",
    },
  },
  {
    keywords: /jacket|fleece|pullover|carhartt|patagonia|outerwear|coat/i,
    match: {
      taxonomyId: 482,
      categoryPath: "Clothing > Men's Clothing > Jackets & Coats",
      whenMade: "2000_2006",
    },
  },
  {
    keywords: /shoe|sneaker|boot|new balance|red wing|nike/i,
    match: {
      taxonomyId: 1435,
      categoryPath: "Shoes > Men's Shoes > Sneakers & Boots",
      whenMade: "2020_2026",
    },
  },
  {
    keywords: /handbag|crossbody|purse|coach|bag|tote/i,
    match: {
      taxonomyId: 132,
      categoryPath: "Bags & Purses > Handbags > Crossbody Bags",
      whenMade: "1990_1999",
    },
  },
  {
    keywords: /dutch oven|le creuset|cookware|cast iron|kitchen/i,
    match: {
      taxonomyId: 1030,
      categoryPath: "Home & Living > Kitchen & Dining > Cookware",
      whenMade: "2000_2006",
    },
  },
];

export function stripHtmlToPlainText(htmlOrText: string | null): string {
  if (!htmlOrText) return "";
  return htmlOrText
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Fee-adjusted cross-listing price calculator.
 * Preserves or improves net margin relative to eBay while respecting markup & floor_price.
 */
export function computeCrossListPrice(params: {
  ebayListedPrice: number;
  cogs: number;
  floorPrice: number;
  targetMarketplace: MarketplaceType;
  ebayFeePct?: number;
  targetAccount?: MarketplaceAccount;
}): CrossListPriceBreakdown {
  const {
    ebayListedPrice,
    cogs,
    floorPrice,
    targetMarketplace,
    ebayFeePct = DEFAULT_EBAY_FEE_PCT,
    targetAccount,
  } = params;

  const defaults = DEFAULT_CHANNEL_FEES[targetMarketplace];
  const targetFeePct = Number(
    targetAccount?.default_fee_pct ?? defaults.feePct
  );
  const targetMarkupPct = Number(
    targetAccount?.price_markup_pct ?? defaults.markupPct
  );

  const ebayFeeAmt = roundCurrency(ebayListedPrice * (ebayFeePct / 100));
  const ebayNetProfit = roundCurrency(ebayListedPrice - ebayFeeAmt - cogs);

  // Price needed to preserve net profit after target marketplace fees + optional markup cushion
  const feeRatio = (1 - ebayFeePct / 100) / Math.max(0.5, 1 - targetFeePct / 100);
  const feeAdjusted = ebayListedPrice * feeRatio;
  const markedUp = feeAdjusted * (1 + targetMarkupPct / 100);

  // Round to clean retail ending (.00 or .99 when under $50)
  const rawSuggested = roundCurrency(markedUp);
  const cleanedPrice =
    rawSuggested >= 50 ? Math.ceil(rawSuggested) : roundCurrency(Math.ceil(rawSuggested) - 0.01);

  const respectedFloor = cleanedPrice >= floorPrice;
  const suggestedPrice = respectedFloor ? cleanedPrice : roundCurrency(floorPrice);
  const targetFeeAmount = roundCurrency(suggestedPrice * (targetFeePct / 100));
  const targetNetProfit = roundCurrency(suggestedPrice - targetFeeAmount - cogs);
  const netProfitDelta = roundCurrency(targetNetProfit - ebayNetProfit);

  return {
    ebayListedPrice: roundCurrency(ebayListedPrice),
    ebayFeePct,
    ebayNetProfit,
    targetFeePct,
    targetMarkupPct,
    suggestedPrice,
    targetFeeAmount,
    targetNetProfit,
    netProfitDelta,
    floorPrice: roundCurrency(floorPrice),
    respectedFloor,
  };
}

function sanitizeEtsyTags(rawTags: string[]): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];

  for (const tag of rawTags) {
    const cleaned = tag
      .replace(/[^a-zA-Z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20)
      .trim();

    if (cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(cleaned);
    if (valid.length >= 13) break;
  }

  return valid;
}

function matchEtsyTaxonomy(item: InventoryItem): EtsyTaxonomyMatch {
  const haystack = `${item.title} ${item.category_hint ?? ""} ${item.brand ?? ""}`;
  for (const rule of ETSY_TAXONOMY_RULES) {
    if (rule.keywords.test(haystack)) {
      return rule.match;
    }
  }
  return {
    taxonomyId: 1,
    categoryPath: "Vintage & Collectibles > General Curated Goods",
    whenMade: "2000_2006",
  };
}

function buildHeuristicDraft(params: {
  item: InventoryItem;
  ebayListedPrice: number;
  targetMarketplace: MarketplaceType;
  targetAccount?: MarketplaceAccount;
}): CrossListDraftPayload {
  const { item, ebayListedPrice, targetMarketplace, targetAccount } = params;
  const maxLen = MARKETPLACE_TITLE_LIMITS[targetMarketplace];
  const taxonomy = matchEtsyTaxonomy(item);
  const pricing = computeCrossListPrice({
    ebayListedPrice,
    cogs: Number(item.cogs),
    floorPrice: Number(item.floor_price),
    targetMarketplace,
    targetAccount,
  });

  // Optimize title for Etsy SEO (or shorten for Poshmark/Mercari 80-char caps)
  let mappedTitle = item.title.replace(/\s+/g, " ").trim();
  if (targetMarketplace === "etsy") {
    const suffixParts: string[] = [];
    if (item.category_hint && !mappedTitle.toLowerCase().includes(item.category_hint.toLowerCase())) {
      suffixParts.push(item.category_hint);
    }
    if (!/vintage|retro|classic/i.test(mappedTitle) && taxonomy.whenMade !== "2020_2026") {
      suffixParts.push("Vintage Curated");
    }
    if (suffixParts.length > 0 && mappedTitle.length + suffixParts.join(" | ").length + 3 <= maxLen) {
      mappedTitle = `${mappedTitle} | ${suffixParts.join(" | ")}`;
    }
  }
  if (mappedTitle.length > maxLen) {
    mappedTitle = mappedTitle.slice(0, maxLen - 1).trim();
  }

  const basePlain =
    item.description_plain?.trim() ||
    stripHtmlToPlainText(item.description_html) ||
    item.title;

  const specLines = Object.entries(item.item_specifics || {}).map(
    ([k, v]) => `• ${k}: ${Array.isArray(v) ? v.join(", ") : v}`
  );

  const descriptionSections = [
    basePlain,
    "",
    "Item Details:",
    item.brand ? `• Brand: ${item.brand}` : null,
    `• Condition: ${item.condition}`,
    item.weight_oz ? `• Approx. Weight: ${item.weight_oz} oz` : null,
    ...specLines,
    "",
    `Inventory Ref: ${item.sku}`,
  ].filter((line): line is string => line !== null);

  const rawTagCandidates: string[] = [];
  if (item.brand) rawTagCandidates.push(item.brand);
  if (item.category_hint) rawTagCandidates.push(item.category_hint);
  if (taxonomy.whenMade !== "2020_2026") rawTagCandidates.push("vintage");
  rawTagCandidates.push("reseller curated");

  for (const val of Object.values(item.item_specifics || {})) {
    const str = Array.isArray(val) ? val.join(" ") : String(val);
    rawTagCandidates.push(str);
  }

  const titleWords = item.title
    .split(/[\s/,|()-]+/)
    .filter((w) => w.length >= 4 && !/^(with|mens|womens|size|tested|good|very)$/i.test(w));
  for (let i = 0; i < titleWords.length; i++) {
    rawTagCandidates.push(titleWords[i]);
    if (i + 1 < titleWords.length) {
      rawTagCandidates.push(`${titleWords[i]} ${titleWords[i + 1]}`);
    }
  }

  const tags = sanitizeEtsyTags(rawTagCandidates);

  return {
    itemId: item.id,
    sku: item.sku,
    targetMarketplace,
    mapperMode: "heuristic",
    modelUsed: "deterministic-mapper-v1",
    sourceTitle: item.title,
    mappedTitle,
    maxTitleLength: maxLen,
    descriptionPlain: descriptionSections.join("\n"),
    taxonomyId: taxonomy.taxonomyId,
    categoryPath: taxonomy.categoryPath,
    whoMade: "someone_else",
    whenMade: taxonomy.whenMade,
    isSupply: false,
    tags,
    pricing,
    translationNotes: [
      `Stripped HTML and formatted ${specLines.length} item specifics into plain-text bullets.`,
      `Mapped to Etsy taxonomy #${taxonomy.taxonomyId} (${taxonomy.categoryPath}).`,
      `Adjusted price from $${ebayListedPrice.toFixed(2)} to $${pricing.suggestedPrice.toFixed(2)} for ${pricing.targetFeePct}% fee + ${pricing.targetMarkupPct}% cushion.`,
      `Generated ${tags.length}/13 Etsy-compliant SEO tags (<=20 chars each).`,
    ],
  };
}

/**
 * Translates an eBay master inventory item into a marketplace-ready cross-list payload.
 * Uses Gemini API when GEMINI_API_KEY is configured, falling back seamlessly to the
 * deterministic mapper so Phase 2 workflows remain fast and testable without API keys.
 */
export async function mapItemForMarketplace(params: {
  item: InventoryItem;
  ebayListedPrice: number;
  targetMarketplace: MarketplaceType;
  targetAccount?: MarketplaceAccount;
}): Promise<CrossListDraftPayload> {
  const heuristic = buildHeuristicDraft(params);
  const env = getEnvReadiness();

  if (!env.isGeminiReady) {
    return heuristic;
  }

  const apiKey = process.env.GEMINI_API_KEY!.trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const maxLen = MARKETPLACE_TITLE_LIMITS[params.targetMarketplace];

  const prompt = [
    `You are an e-commerce cross-listing field mapper converting an eBay listing for ${params.targetMarketplace.toUpperCase()}.`,
    `Return ONLY valid JSON matching this schema:`,
    `{`,
    `  "mappedTitle": string (<= ${maxLen} characters, keyword-rich, no spammy caps),`,
    `  "descriptionPlain": string (clean plain text, zero HTML tags, bullet points for specifics),`,
    `  "categoryPath": string (best ${params.targetMarketplace} category breadcrumb),`,
    `  "whenMade": string (one of: "2020_2026", "2010_2019", "2000_2006", "1990_1999", "1980s", "1970s", "before_1970"),`,
    `  "tags": string[] (up to 13 SEO tags, each <= 20 characters, alphanumeric and spaces only),`,
    `  "translationNotes": string[] (2-4 concise notes explaining title/category/description adjustments)`,
    `}`,
    ``,
    `Source Listing:`,
    JSON.stringify({
      sku: params.item.sku,
      title: params.item.title,
      brand: params.item.brand,
      condition: params.item.condition,
      category_hint: params.item.category_hint,
      description_plain:
        params.item.description_plain ||
        stripHtmlToPlainText(params.item.description_html),
      item_specifics: params.item.item_specifics,
      weight_oz: params.item.weight_oz,
      suggested_price: heuristic.pricing.suggestedPrice,
    }),
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: "application/json",
          },
        }),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error("Empty Gemini response");
    }

    const parsed = JSON.parse(rawText) as {
      mappedTitle?: string;
      descriptionPlain?: string;
      categoryPath?: string;
      whenMade?: string;
      tags?: string[];
      translationNotes?: string[];
    };

    return {
      ...heuristic,
      mapperMode: "gemini",
      modelUsed: model,
      mappedTitle: (parsed.mappedTitle || heuristic.mappedTitle)
        .slice(0, maxLen)
        .trim(),
      descriptionPlain:
        stripHtmlToPlainText(parsed.descriptionPlain || "") ||
        heuristic.descriptionPlain,
      categoryPath: parsed.categoryPath || heuristic.categoryPath,
      whenMade: parsed.whenMade || heuristic.whenMade,
      tags:
        Array.isArray(parsed.tags) && parsed.tags.length > 0
          ? sanitizeEtsyTags(parsed.tags)
          : heuristic.tags,
      translationNotes:
        Array.isArray(parsed.translationNotes) &&
        parsed.translationNotes.length > 0
          ? parsed.translationNotes
          : heuristic.translationNotes,
    };
  } catch (error) {
    console.warn(
      "[gemini-mapper] Falling back to deterministic mapper:",
      error instanceof Error ? error.message : error
    );
    return heuristic;
  }
}
