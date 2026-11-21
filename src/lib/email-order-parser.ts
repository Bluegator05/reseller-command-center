import type { InventoryItem, MarketplaceType, ParsedOrderEmail } from "./types";

export interface RawInboundEmail {
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectMarketplace(from: string, subject: string, body: string): MarketplaceType {
  const hay = `${from} ${subject} ${body}`.toLowerCase();
  if (hay.includes("poshmark")) return "poshmark";
  if (hay.includes("mercari")) return "mercari";
  if (hay.includes("facebook") || hay.includes("marketplace order")) return "facebook";
  if (hay.includes("etsy")) return "etsy";
  return "ebay";
}

function extractCurrencyAmount(text: string, patterns: RegExp[]): number | null {
  for (const regex of patterns) {
    const match = text.match(regex);
    if (match?.[1]) {
      const val = Number(match[1].replace(/,/g, ""));
      if (!Number.isNaN(val) && val > 0) return val;
    }
  }
  return null;
}

/**
 * Parses forwarded sale confirmation emails from Poshmark, Mercari, and Facebook Marketplace
 * into structured order fields ready for anti-double-sell matching and delist cascading.
 */
export function parseInboundOrderEmail(email: RawInboundEmail): ParsedOrderEmail {
  const from = email.from || "";
  const subject = email.subject || "";
  const body = email.text?.trim() || stripHtml(email.html || "");
  const combined = `${subject}\n${body}`;

  const marketplace = detectMarketplace(from, subject, body);

  // 1. Order ID extraction
  const orderPatterns = [
    /order\s*(?:#|id|number)?[:\s#]+([A-Z0-9-]{5,24})/i,
    /confirmation\s*(?:#|code)?[:\s#]+([A-Z0-9-]{5,24})/i,
    /#([0-9]{6,18})/,
  ];
  let orderId: string | null = null;
  for (const pat of orderPatterns) {
    const m = combined.match(pat);
    if (m?.[1]) {
      orderId = m[1].trim();
      break;
    }
  }

  // 2. Embedded Inventory Ref SKU (added automatically by our Phase 2/3 mapper!)
  const skuMatch =
    combined.match(/Inventory\s*Ref[:\s]+([A-Z0-9-]{3,32})/i) ||
    combined.match(/SKU[:\s]+([A-Z0-9-]{3,32})/i);
  const extractedSku = skuMatch?.[1]?.trim().toUpperCase() || null;

  // 3. Gross sale price extraction
  const grossSalePrice = extractCurrencyAmount(combined, [
    /(?:sold\s+for|order\s+total|sale\s+price|item\s+price|price|buyer\s+paid)[^\n$]{0,24}\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
    /\$\s*([0-9,]+(?:\.[0-9]{2}))/,
  ]);

  // 4. Shipping cost extraction
  const shippingCost =
    extractCurrencyAmount(combined, [
      /(?:shipping|label\s+cost|delivery)[^\n$]{0,20}\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
    ]) ?? 0;

  // 5. Item title extraction
  let extractedTitle: string | null = null;
  const titlePatterns = [
    /(?:item|listing|product)[:\s]+["“]?([^\n"”]{6,120})["”]?/i,
    /(?:your\s+item|congrats!\s+you\s+sold|you\s+sold)\s+["“]?([^\n"”$]{6,120})["”]?/i,
    /sold:\s*([^\n]{6,120})/i,
  ];
  for (const pat of titlePatterns) {
    const m = combined.match(pat);
    if (m?.[1]) {
      extractedTitle = m[1].replace(/\s+for\s+\$.*$/i, "").trim();
      break;
    }
  }

  const confidence: ParsedOrderEmail["confidence"] =
    extractedSku && grossSalePrice
      ? "high"
      : (extractedTitle || extractedSku) && grossSalePrice
        ? "medium"
        : "low";

  return {
    marketplace,
    orderId,
    grossSalePrice,
    shippingCost,
    extractedSku,
    extractedTitle,
    confidence,
  };
}

/**
 * Matches a parsed email against active master inventory items:
 * 1) Exact SKU match
 * 2) Highest token-overlap title match (>= 2 shared meaningful tokens)
 */
export function matchParsedEmailToItem(
  parsed: ParsedOrderEmail,
  candidates: InventoryItem[]
): InventoryItem | null {
  if (parsed.extractedSku) {
    const exact = candidates.find(
      (i) => i.sku.toUpperCase() === parsed.extractedSku!.toUpperCase()
    );
    if (exact) return exact;
  }

  if (!parsed.extractedTitle) return null;

  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3)
    );

  const queryTokens = tokenize(parsed.extractedTitle);
  let best: InventoryItem | null = null;
  let bestScore = 0;

  for (const item of candidates) {
    const itemTokens = tokenize(`${item.title} ${item.brand ?? ""} ${item.sku}`);
    let overlap = 0;
    for (const tok of queryTokens) {
      if (itemTokens.has(tok)) overlap += 1;
    }
    const score = overlap / Math.max(1, Math.min(queryTokens.size, itemTokens.size));
    if (overlap >= 2 && score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}
