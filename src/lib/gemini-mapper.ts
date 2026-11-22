import { generateGeminiJson, getGeminiApiKey } from "./gemini-client";
import {
  evaluateMarketplaceCompliance,
  inferStructuredCategory,
  mapConditionForMarketplace,
  MARKETPLACE_LIMITS,
  sanitizeMarketplaceCopy,
} from "./marketplace-compliance";
import { DEFAULT_EBAY_FEE_PCT, roundCurrency } from "./stale-engine";
import { getEnvReadiness } from "./supabase";
import type {
  ComplianceIssue,
  CrossListDraftPayload,
  CrossListPriceBreakdown,
  InventoryItem,
  MarketplaceAccount,
  MarketplaceType,
  StructuredCategoryMapping,
} from "./types";

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
  isSupply?: boolean;
}

const ETSY_TAXONOMY_RULES: Array<{
  keywords: RegExp;
  match: EtsyTaxonomyMatch;
}> = [
  {
    keywords:
      /stampin|punch|die cut|scrapbook|rubber stamp|clear stamp|embossing|cardstock|yarn|crochet|knitting|sewing pattern|craft supply/i,
    match: {
      taxonomyId: 6692,
      categoryPath: "Craft Supplies & Tools > Paper, Party & Kids > Paper Punches & Stamps",
      whenMade: "2020_2026",
      isSupply: true,
    },
  },
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
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Fee-adjusted cross-listing price calculator.
 * Preserves or improves net margin relative to eBay while respecting markup,
 * whole-dollar rules (Poshmark/Mercari/FB), minimum prices, and floor_price.
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
  const limits = MARKETPLACE_LIMITS[targetMarketplace];
  const targetFeePct = Number(
    targetAccount?.default_fee_pct ?? defaults.feePct
  );
  const targetMarkupPct = Number(
    targetAccount?.price_markup_pct ?? defaults.markupPct
  );

  const ebayFeeAmt = roundCurrency(ebayListedPrice * (ebayFeePct / 100));
  const ebayNetProfit = roundCurrency(ebayListedPrice - ebayFeeAmt - cogs);

  const feeRatio = (1 - ebayFeePct / 100) / Math.max(0.5, 1 - targetFeePct / 100);
  const feeAdjusted = ebayListedPrice * feeRatio;
  const markedUp = feeAdjusted * (1 + targetMarkupPct / 100);

  const rawSuggested = roundCurrency(markedUp);
  let cleanedPrice: number;
  if (limits.wholeDollarOnly) {
    cleanedPrice = Math.max(limits.minPrice, Math.ceil(rawSuggested));
  } else {
    cleanedPrice =
      rawSuggested >= 50
        ? Math.ceil(rawSuggested)
        : roundCurrency(Math.ceil(rawSuggested) - 0.01);
  }

  const respectedFloor = cleanedPrice >= floorPrice;
  const suggestedPrice = respectedFloor
    ? cleanedPrice
    : limits.wholeDollarOnly
      ? Math.max(limits.minPrice, Math.ceil(floorPrice))
      : roundCurrency(floorPrice);
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
  const looksVintage = /\b(vintage|vtg|retro|antique|19[5-9]\d|200[0-6]|70s|80s|90s|y2k)\b/i.test(
    haystack
  );
  return {
    taxonomyId: 1,
    categoryPath: looksVintage
      ? "Vintage & Collectibles > General Curated Goods"
      : "Home & Living > General Goods",
    whenMade: looksVintage ? "1990_1999" : "2020_2026",
    isSupply: false,
  };
}

function formatCategoryBreadcrumb(sc: StructuredCategoryMapping): string {
  return [sc.department, sc.category, sc.subcategory]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(" > ");
}

function buildHeuristicDraft(params: {
  item: InventoryItem;
  ebayListedPrice: number;
  targetMarketplace: MarketplaceType;
  targetAccount?: MarketplaceAccount;
}): CrossListDraftPayload {
  const { item, ebayListedPrice, targetMarketplace, targetAccount } = params;
  const limits = MARKETPLACE_LIMITS[targetMarketplace];
  const taxonomy = matchEtsyTaxonomy(item);
  const structuredCategory = inferStructuredCategory(item, targetMarketplace);
  const pricing = computeCrossListPrice({
    ebayListedPrice,
    cogs: Number(item.cogs),
    floorPrice: Number(item.floor_price),
    targetMarketplace,
    targetAccount,
  });

  let mappedTitle = item.title.replace(/\s+/g, " ").trim();
  if (targetMarketplace === "etsy") {
    const suffixParts: string[] = [];
    if (
      item.category_hint &&
      !mappedTitle.toLowerCase().includes(item.category_hint.toLowerCase())
    ) {
      suffixParts.push(item.category_hint);
    }
    if (
      !taxonomy.isSupply &&
      !/vintage|retro|classic/i.test(mappedTitle) &&
      taxonomy.whenMade !== "2020_2026"
    ) {
      suffixParts.push("Vintage Curated");
    }
    if (
      suffixParts.length > 0 &&
      mappedTitle.length + suffixParts.join(" | ").length + 3 <= limits.maxTitle
    ) {
      mappedTitle = `${mappedTitle} | ${suffixParts.join(" | ")}`;
    }
  }

  const basePlain =
    item.description_plain?.trim() ||
    stripHtmlToPlainText(item.description_html) ||
    item.title;

  const specLines = Object.entries(item.item_specifics || {})
    .slice(0, 12)
    .map(([k, v]) => `• ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);

  const descriptionSections = [
    basePlain,
    "",
    "Item Details:",
    item.brand ? `• Brand: ${item.brand}` : null,
    `• Condition: ${structuredCategory.conditionLabel}`,
    structuredCategory.sizeLabel ? `• Size: ${structuredCategory.sizeLabel}` : null,
    item.weight_oz ? `• Approx. Weight: ${item.weight_oz} oz` : null,
    ...specLines,
  ].filter((line): line is string => line !== null);

  const sanitized = sanitizeMarketplaceCopy({
    title: mappedTitle,
    description: descriptionSections.join("\n"),
    targetMarketplace,
  });

  const compliance = evaluateMarketplaceCompliance({
    item,
    targetMarketplace,
    suggestedPrice: pricing.suggestedPrice,
    whenMade: taxonomy.whenMade,
    isSupply: Boolean(taxonomy.isSupply),
    whoMade: "someone_else",
  });
  compliance.sanitizedAdjustments = [...sanitized.adjustments];
  if (limits.wholeDollarOnly) {
    compliance.sanitizedAdjustments.push(
      `Rounded price to whole dollar ($${pricing.suggestedPrice.toFixed(0)}) per ${targetMarketplace} pricing rules`
    );
  }

  const rawTagCandidates: string[] = [];
  if (item.brand) rawTagCandidates.push(item.brand);
  if (item.category_hint) rawTagCandidates.push(item.category_hint);
  if (taxonomy.isSupply) rawTagCandidates.push("craft supplies");
  else if (taxonomy.whenMade !== "2020_2026") rawTagCandidates.push("vintage");

  for (const val of Object.values(item.item_specifics || {})) {
    const str = Array.isArray(val) ? val.join(" ") : String(val);
    rawTagCandidates.push(str);
  }

  const titleWords = item.title
    .split(/[\s/,|()-]+/)
    .filter(
      (w) => w.length >= 4 && !/^(with|mens|womens|size|tested|good|very)$/i.test(w)
    );
  for (let i = 0; i < titleWords.length; i++) {
    rawTagCandidates.push(titleWords[i]);
    if (i + 1 < titleWords.length) {
      rawTagCandidates.push(`${titleWords[i]} ${titleWords[i + 1]}`);
    }
  }

  const tags = sanitizeEtsyTags(rawTagCandidates);
  const categoryPath =
    targetMarketplace === "etsy"
      ? taxonomy.categoryPath
      : formatCategoryBreadcrumb(structuredCategory);

  return {
    itemId: item.id,
    sku: item.sku,
    targetMarketplace,
    mapperMode: "heuristic",
    modelUsed: "deterministic-mapper-v2",
    sourceTitle: item.title,
    mappedTitle: sanitized.title,
    maxTitleLength: limits.maxTitle,
    maxDescriptionLength: limits.maxDescription,
    descriptionPlain: sanitized.description,
    taxonomyId: taxonomy.taxonomyId,
    categoryPath,
    structuredCategory,
    whoMade: "someone_else",
    whenMade: taxonomy.whenMade,
    isSupply: Boolean(taxonomy.isSupply),
    tags,
    pricing,
    compliance,
    translationNotes: [
      `Stripped HTML & sanitized off-platform text (${specLines.length} specifics preserved).`,
      `Mapped ${targetMarketplace} category: ${categoryPath} · Condition: ${structuredCategory.conditionLabel}${structuredCategory.sizeLabel ? ` · Size: ${structuredCategory.sizeLabel}` : ""}.`,
      `Adjusted price from $${ebayListedPrice.toFixed(2)} to $${pricing.suggestedPrice.toFixed(2)} (${pricing.targetFeePct}% fee + ${pricing.targetMarkupPct}% cushion).`,
      ...sanitized.adjustments,
    ],
  };
}

/**
 * Translates an eBay master inventory item into a marketplace-ready cross-list payload
 * with native marketplace category/condition/size mapping and policy compliance checks.
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

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return heuristic;
  }

  const target = params.targetMarketplace;
  const limits = MARKETPLACE_LIMITS[target];

  const marketplaceRulesGuide: Record<MarketplaceType, string> = {
    poshmark: [
      `Poshmark Departments MUST be one of: "Women", "Men", "Kids", "Home", "Pets", "Electronics".`,
      `Poshmark Categories MUST be an EXACT real Poshmark category under that department:`,
      `- Under "Home": "Accents", "Art", "Bath", "Bedding", "Design", "Dining", "Games", "Holiday", "Kitchen", "Office", "Party Supplies", "Storage & Organization", "Wall Decor", "Other". (For craft supplies, paper punches, stamps, scrapbooking: MUST use department "Home", category "Office", subcategory "Arts & Crafts" — NEVER use "Crafts" as category!)`,
      `- Under "Women": "Accessories", "Bags", "Dresses", "Intimates & Sleepwear", "Jackets & Coats", "Jeans", "Jewelry", "Makeup", "Pants & Jumpsuits", "Shoes", "Shorts", "Skirts", "Sweaters", "Swim", "Tops", "Other".`,
      `- Under "Men": "Accessories", "Bags", "Jackets & Coats", "Jeans", "Pants", "Shirts", "Shoes", "Shorts", "Suits & Blazers", "Sweaters", "Swim", "Other".`,
      `- Under "Electronics": "Cameras, Photo & Video", "Cell Phones & Accessories", "Computers, Laptops & Parts", "Headphones", "Media", "Networking", "Tablets & Accessories", "Video Games & Consoles", "Wearables", "Other".`,
      `Poshmark Condition MUST be one of: "New With Tags (NWT)", "Like New", "Good", "Fair". Size should be "OS" for Home/Bags/Crafts/Electronics or the exact garment/shoe size.`,
      `Poshmark Policy: PROHIBITED items include perfumes, colognes, nail polish, aerosols, flammable liquids, used/opened makeup/skincare, medical devices, supplements, food, weapons/knives, heavy appliances/power tools/TVs/furniture, digital goods, and items over 10 lbs.`,
    ].join(" "),
    mercari: [
      `Mercari uses a 3-level Category tree (department > category > subcategory), e.g. "Arts & crafts > Stamping & embossing > Paper punches" or "Men > Coats & jackets > Fleece jacket".`,
      `Mercari Condition MUST be one of: "New", "Like new", "Good", "Fair", "Poor".`,
      `Mercari Policy: PROHIBITED items include weapons/knives, medical devices, supplements, food, digital goods, gift cards, recalled goods, and counterfeit/replicas. Fragrances/aerosols require a hazmat ground warning.`,
    ].join(" "),
    facebook: [
      `Facebook Marketplace top-level category MUST be one of: "Arts & Crafts", "Home Goods", "Clothing & Accessories", "Bags & Luggage", "Electronics", "Toys & Games", "Antiques & Collectibles", "Tools", "Sporting Goods", "Kitchen & Dining", "Books, Movies & Music", "Musical Instruments", "Jewelry & Watches", "Garden".`,
      `Facebook Condition MUST be one of: "New", "Used - Like New", "Used - Good", "Used - Fair".`,
      `Facebook Commerce Policy: STRICTLY PROHIBITED (high ban risk) are medical/healthcare items (braces, monitors, thermometers, supplements, masks, mobility aids), weapons, alcohol/tobacco/vapes, adult items, digital goods, and recalled items.`,
    ].join(" "),
    etsy: [
      `Etsy ONLY allows Handmade, Vintage (20+ years old, i.e., 2006 or earlier), or Craft Supplies & Tools (isSupply = true, e.g., paper punches, stamps, yarn, beads, fabric, sewing patterns).`,
      `If the item is a modern mass-produced resale item (2007+) and NOT a craft supply, set policyAllowed = false and explain in policyBlockReason.`,
    ].join(" "),
    ebay: `eBay standard resale listing rules.`,
  };

  const prompt = [
    `You are a strict e-commerce cross-listing mapper & policy compliance officer converting an eBay listing for ${target.toUpperCase()}.`,
    marketplaceRulesGuide[target],
    `Never mention "eBay" or other rival marketplaces, external URLs, emails, or phone numbers in mappedTitle or descriptionPlain.`,
    `Return ONLY valid JSON matching this schema:`,
    `{`,
    `  "mappedTitle": string (<= ${limits.maxTitle} chars, keyword-rich, no spammy caps),`,
    `  "descriptionPlain": string (<= ${limits.maxDescription} chars, clean plain text, zero HTML, zero eBay mentions),`,
    `  "department": string | null,`,
    `  "category": string (official ${target} category name),`,
    `  "subcategory": string | null,`,
    `  "conditionLabel": string (exact ${target} condition dropdown label),`,
    `  "sizeLabel": string | null,`,
    `  "whenMade": string (one of: "2020_2026", "2010_2019", "2000_2006", "1990_1999", "1980s", "1970s", "before_1970"),`,
    `  "isSupply": boolean (true if craft supply/tool like stamps, punches, yarn, dies, fabric),`,
    `  "tags": string[] (up to 13 SEO tags, each <= 20 chars, alphanumeric & spaces only),`,
    `  "policyAllowed": boolean (false ONLY if genuinely prohibited by ${target}'s official seller policy),`,
    `  "policyBlockReason": string | null (required if policyAllowed is false),`,
    `  "policyWarnings": string[] (0-2 important seller warnings, e.g., overweight shipping or sealed requirement),`,
    `  "translationNotes": string[] (2-4 concise notes explaining category/title/compliance adjustments)`,
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
    const { data: parsed, modelUsed } = await generateGeminiJson<{
      mappedTitle?: string;
      descriptionPlain?: string;
      department?: string | null;
      category?: string;
      subcategory?: string | null;
      conditionLabel?: string;
      sizeLabel?: string | null;
      whenMade?: string;
      isSupply?: boolean;
      tags?: string[];
      policyAllowed?: boolean;
      policyBlockReason?: string | null;
      policyWarnings?: string[];
      translationNotes?: string[];
    }>({
      task: "mapper",
      apiKey,
      parts: [{ text: prompt }],
    });

    const structuredCategory: StructuredCategoryMapping = {
      department:
        parsed.department !== undefined
          ? parsed.department
          : heuristic.structuredCategory.department,
      category: parsed.category?.trim() || heuristic.structuredCategory.category,
      subcategory:
        parsed.subcategory !== undefined
          ? parsed.subcategory
          : heuristic.structuredCategory.subcategory,
      conditionLabel:
        parsed.conditionLabel?.trim() ||
        mapConditionForMarketplace(params.item.condition, target),
      sizeLabel:
        parsed.sizeLabel !== undefined
          ? parsed.sizeLabel
          : heuristic.structuredCategory.sizeLabel,
    };

    const sanitized = sanitizeMarketplaceCopy({
      title: parsed.mappedTitle || heuristic.mappedTitle,
      description:
        stripHtmlToPlainText(parsed.descriptionPlain || "") ||
        heuristic.descriptionPlain,
      targetMarketplace: target,
    });

    const whenMade = parsed.whenMade || heuristic.whenMade;
    const isSupply =
      typeof parsed.isSupply === "boolean" ? parsed.isSupply : heuristic.isSupply;

    const aiPolicyIssues: ComplianceIssue[] = [];
    if (parsed.policyAllowed === false && parsed.policyBlockReason) {
      aiPolicyIssues.push({
        code: "AI_POLICY_BLOCK",
        severity: "block",
        rule: `${target.toUpperCase()} Seller Policy Check`,
        detail: parsed.policyBlockReason.trim(),
      });
    }
    if (Array.isArray(parsed.policyWarnings)) {
      for (let i = 0; i < Math.min(parsed.policyWarnings.length, 3); i++) {
        const w = String(parsed.policyWarnings[i] || "").trim();
        if (w) {
          aiPolicyIssues.push({
            code: `AI_POLICY_WARN_${i + 1}`,
            severity: "warning",
            rule: `${target.toUpperCase()} Listing Reminder`,
            detail: w,
          });
        }
      }
    }

    const compliance = evaluateMarketplaceCompliance({
      item: params.item,
      targetMarketplace: target,
      suggestedPrice: heuristic.pricing.suggestedPrice,
      whenMade,
      isSupply,
      whoMade: heuristic.whoMade,
      aiPolicyIssues,
    });
    compliance.sanitizedAdjustments = [...sanitized.adjustments];
    if (limits.wholeDollarOnly) {
      compliance.sanitizedAdjustments.push(
        `Rounded price to whole dollar ($${heuristic.pricing.suggestedPrice.toFixed(0)}) per ${target} pricing rules`
      );
    }

    const categoryPath = formatCategoryBreadcrumb(structuredCategory);

    return {
      ...heuristic,
      mapperMode: "gemini",
      modelUsed,
      mappedTitle: sanitized.title,
      descriptionPlain: sanitized.description,
      categoryPath: categoryPath || heuristic.categoryPath,
      structuredCategory,
      whenMade,
      isSupply,
      compliance,
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

