import { NextResponse } from "next/server";
import { fetchEbayItemDetails, isEbayConfigured } from "@/lib/ebay";
import { generateGeminiJson, getGeminiApiKey } from "@/lib/gemini-client";
import { roundCurrency } from "@/lib/stale-engine";

export const maxDuration = 30;

export interface SanityCheckItem {
  area: "Price" | "Title SEO" | "Shipping" | "Traffic" | "Photos" | "Lifecycle";
  status: "ok" | "warn" | "fix";
  finding: string;
  suggestion: string;
}

export interface RelistSanityCheckResponse {
  mode: "gemini" | "heuristic";
  modelUsed: string;
  verdict: "relist_ready" | "fix_first" | "consider_donate";
  primaryDiagnosis: string;
  checks: SanityCheckItem[];
  suggestedTitle: string;
  suggestedPrice: number;
  estSoldLow: number;
  estSoldMedian: number;
  estSoldHigh: number;
  shippingAdvice: string;
  compSearchQuery: string;
  ebaySoldUrl: string;
  ebayActiveUrl: string;
  photoCount: number;
  specificsCount: number;
}

interface RelistCheckBody {
  sku: string;
  title: string;
  brand?: string | null;
  condition?: string | null;
  categoryHint?: string | null;
  listedPrice: number;
  shippingPrice?: number;
  floorPrice: number;
  cogs: number;
  daysListed: number;
  viewsCount: number;
  watchersCount: number;
  promotedAdRatePct?: number;
  relistCount?: number;
  weightOz?: number | null;
  imageUrls?: string[];
  externalListingId?: string | null;
}

export async function POST(request: Request) {
  let body: RelistCheckBody;
  try {
    body = (await request.json()) as RelistCheckBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const title = (body.title || "").trim();
  const listedPrice = Math.max(0, Number(body.listedPrice) || 0);
  const shippingPrice = Math.max(0, Number(body.shippingPrice) || 0);
  const floorPrice = Math.max(0, Number(body.floorPrice) || 0);
  const cogs = Math.max(0, Number(body.cogs) || 0);
  const daysListed = Math.max(0, Number(body.daysListed) || 0);
  const views = Math.max(0, Number(body.viewsCount) || 0);
  const watchers = Math.max(0, Number(body.watchersCount) || 0);
  const promotedRate = Math.max(0, Number(body.promotedAdRatePct) || 0);
  const relistCount = Math.max(0, Number(body.relistCount) || 0);

  let photoCount = Array.isArray(body.imageUrls) ? body.imageUrls.length : 0;
  let specificsCount = 0;
  let liveDescriptionSnippet = "";
  let primaryPhotoUrl = body.imageUrls?.[0] || null;

  // Pull live eBay photo count + specifics count if available (fast single GetItem)
  if (
    body.externalListingId &&
    /^\d+$/.test(body.externalListingId.trim()) &&
    isEbayConfigured()
  ) {
    const details = await fetchEbayItemDetails(body.externalListingId.trim());
    if (details) {
      if (details.imageUrls.length > 0) {
        photoCount = details.imageUrls.length;
        primaryPhotoUrl = details.imageUrls[0];
      }
      specificsCount = Object.keys(details.itemSpecifics || {}).length;
      liveDescriptionSnippet = (details.descriptionPlain || "").slice(0, 350);
    }
  }

  // Deterministic telemetry signals
  const checks: SanityCheckItem[] = [];

  // 1. Traffic pattern (Views vs Watchers)
  if (views < 15 && daysListed >= 30) {
    checks.push({
      area: "Traffic",
      status: "fix",
      finding: `Only ${views} views in ${daysListed} days (${promotedRate}% promoted).`,
      suggestion:
        promotedRate < 4
          ? "Visibility problem — upgrade title keywords and consider promoting at 4% after relisting."
          : "Visibility problem — buyers aren't clicking. Upgrade title keywords or swap main cover photo.",
    });
  } else if ((views >= 25 || watchers >= 3) && daysListed >= 30) {
    checks.push({
      area: "Traffic",
      status: "warn",
      finding: `${views} views & ${watchers} watcher${watchers === 1 ? "" : "s"} in ${daysListed}d, but no buyer checked out.`,
      suggestion:
        "Buyers are finding and liking this item, then bouncing on total price (Item + Shipping). Trim price or verify shipping weight.",
    });
  } else {
    checks.push({
      area: "Traffic",
      status: "ok",
      finding: `${views} views and ${watchers} watchers over ${daysListed} days.`,
      suggestion: "Fresh Item ID via Sell Similar should restore Newly Listed exposure.",
    });
  }

  // 2. Photos & Completeness
  if (photoCount > 0 && photoCount < 4) {
    checks.push({
      area: "Photos",
      status: "warn",
      finding: `Only ${photoCount} photo${photoCount === 1 ? "" : "s"} on eBay${specificsCount > 0 ? ` · ${specificsCount} item specifics` : ""}.`,
      suggestion:
        "Listings with 5+ bright photos (front, back, tags, flaws) convert noticeably faster.",
    });
  } else {
    checks.push({
      area: "Photos",
      status: "ok",
      finding: `${photoCount || "Photos"} attached${specificsCount > 0 ? ` · ${specificsCount} item specifics filled` : ""}.`,
      suggestion: "Make sure the cover photo is bright, cropped tight, and uncluttered.",
    });
  }

  // 3. Lifecycle / Relist History
  if (relistCount >= 1) {
    checks.push({
      area: "Lifecycle",
      status: relistCount >= 2 || listedPrice <= 10 ? "fix" : "warn",
      finding: `Already relisted ${relistCount}× before and still unsold (${daysListed}d).`,
      suggestion:
        listedPrice <= 12
          ? "Low-dollar repeat sit — drop to liquidation price or Donate / Toss to reclaim shelf space."
          : "Make a real change to Title or Price before relisting again so it doesn't repeat the same cycle.",
    });
  } else {
    checks.push({
      area: "Lifecycle",
      status: "ok",
      finding: "Original listing (never relisted yet).",
      suggestion: "Good candidate for a fresh Cassini Item ID once price & title check out.",
    });
  }

  // Call Gemini (with main photo if available!) for Market Comps, Title SEO & Shipping sanity check
  interface GeminiSanityOutput {
    verdict: "relist_ready" | "fix_first" | "consider_donate";
    primaryDiagnosis: string;
    compSearchQuery: string;
    estSoldLow: number;
    estSoldMedian: number;
    estSoldHigh: number;
    suggestedPrice: number;
    priceStatus: "ok" | "warn" | "fix";
    priceFinding: string;
    priceSuggestion: string;
    titleStatus: "ok" | "warn" | "fix";
    titleFinding: string;
    suggestedTitle: string;
    shippingStatus: "ok" | "warn" | "fix";
    shippingFinding: string;
    shippingAdvice: string;
  }

  const apiKey = getGeminiApiKey();
  let ai: Partial<GeminiSanityOutput> = {};
  let mode: "gemini" | "heuristic" = "heuristic";
  let modelUsed = "heuristic";

  if (apiKey) {
    try {
      const prompt = `You are a blunt, data-driven veteran eBay reseller auditing a stale listing BEFORE the seller clicks "End & Sell Similar".
The seller wants to know WHY this item sat unsold instead of blindly reposting the same problem.

LISTING TELEMETRY:
- Current Title (${title.length}/80 chars): "${title}"
- Brand: ${body.brand || "Unknown"}
- Condition: ${body.condition || "Used"}
- Category: ${body.categoryHint || "Unknown"}
- Current Ask Price: $${listedPrice.toFixed(2)}
- Shipping Charged: ${shippingPrice > 0 ? `$${shippingPrice.toFixed(2)}` : "Calculated / Buyer Pays"}
- Seller COGS: $${cogs.toFixed(2)} | Floor Price: $${floorPrice.toFixed(2)}
- Days Listed: ${daysListed} | Views: ${views} | Watchers: ${watchers} | Promoted: ${promotedRate}%
- Times Relisted Already: ${relistCount}
- Photos: ${photoCount} | Item Specifics: ${specificsCount}
- Packaged Weight (if set): ${body.weightOz ? `${body.weightOz} oz` : "Not set"}
${liveDescriptionSnippet ? `- Description snippet: ${liveDescriptionSnippet}` : ""}

Analyze pricing vs realistic eBay sold comps, title keyword SEO (80-char limit), and shipping cost proportionality (note: seller uses Calculated USPS Ground Advantage or UPS Ground — NEVER recommend USPS Priority Mail).

Return ONLY valid JSON with these exact keys:
{
  "verdict": "relist_ready" | "fix_first" | "consider_donate",
  "primaryDiagnosis": "Blunt 1-2 sentence explanation of the #1 reason this listing likely sat unsold",
  "compSearchQuery": "Clean 4-7 word eBay Sold Comps search query",
  "estSoldLow": number,
  "estSoldMedian": number,
  "estSoldHigh": number,
  "suggestedPrice": number (realistic competitive Buy It Now price — can be lower than current ask if overpriced),
  "priceStatus": "ok" | "warn" | "fix",
  "priceFinding": "Short factual comparison vs typical eBay sold range",
  "priceSuggestion": "Concrete pricing recommendation",
  "titleStatus": "ok" | "warn" | "fix",
  "titleFinding": "What is weak or missing in the current title (or confirm it's strong)",
  "suggestedTitle": "Upgraded high-converting eBay SEO title, strictly <= 80 chars, Title Case, NO invented brand/model",
  "shippingStatus": "ok" | "warn" | "fix",
  "shippingFinding": "Check if shipping price or weight looks too high for this item's value",
  "shippingAdvice": "Specific Ground Advantage / UPS Ground weight/shipping sanity tip (never mention Priority Mail)"
}`;

      const parts: Array<
        { text: string } | { inline_data: { mime_type: string; data: string } }
      > = [{ text: prompt }];

      // Attach main photo if fetchable quickly so Gemini can check photo/item quality too
      if (primaryPhotoUrl && /^https?:\/\//i.test(primaryPhotoUrl)) {
        try {
          const imgRes = await fetch(primaryPhotoUrl, {
            signal: AbortSignal.timeout(4500),
          });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (buf.byteLength > 200 && buf.byteLength < 3_500_000) {
              parts.push({
                inline_data: {
                  mime_type: imgRes.headers.get("content-type") || "image/jpeg",
                  data: buf.toString("base64"),
                },
              });
            }
          }
        } catch {
          // Proceed text-only if image fetch times out
        }
      }

      const res = await generateGeminiJson<Partial<GeminiSanityOutput>>({
        task: "vision",
        apiKey,
        parts,
      });
      ai = res.data || {};
      mode = "gemini";
      modelUsed = res.modelUsed;
    } catch (err) {
      console.warn("[/api/ai/relist-check] Gemini fallback:", err);
    }
  }

  const estSoldMedian = roundCurrency(
    Math.max(3, Number(ai.estSoldMedian) || listedPrice * 0.85)
  );
  const estSoldLow = roundCurrency(
    Math.max(2, Number(ai.estSoldLow) || estSoldMedian * 0.75)
  );
  const estSoldHigh = roundCurrency(
    Math.max(estSoldMedian, Number(ai.estSoldHigh) || estSoldMedian * 1.25)
  );
  const suggestedPrice = roundCurrency(
    Math.max(3, Number(ai.suggestedPrice) || Math.max(floorPrice, listedPrice * 0.9))
  );
  const suggestedTitle = (ai.suggestedTitle || title).trim().slice(0, 80);

  // Prepend AI Price, Title SEO, and Shipping checks to the front so highest-impact issues appear first
  const priceCheck: SanityCheckItem = {
    area: "Price",
    status:
      ai.priceStatus === "ok" || ai.priceStatus === "warn" || ai.priceStatus === "fix"
        ? ai.priceStatus
        : listedPrice > estSoldMedian * 1.15
          ? "fix"
          : "ok",
    finding:
      ai.priceFinding ||
      `Listed at $${listedPrice.toFixed(2)} vs estimated comps $${estSoldLow.toFixed(0)}–$${estSoldHigh.toFixed(0)}.`,
    suggestion:
      ai.priceSuggestion ||
      (suggestedPrice < listedPrice
        ? `Consider relisting at $${suggestedPrice.toFixed(2)} to trigger quicker conversion.`
        : "Pricing looks aligned with market comps — verify live Sold Comps link."),
  };

  const titleCheck: SanityCheckItem = {
    area: "Title SEO",
    status:
      ai.titleStatus === "ok" || ai.titleStatus === "warn" || ai.titleStatus === "fix"
        ? ai.titleStatus
        : title.length < 48
          ? "warn"
          : "ok",
    finding:
      ai.titleFinding ||
      (title.length < 48
        ? `Title is only ${title.length}/80 chars — leaving search keywords on the table.`
        : `Title uses ${title.length}/80 characters cleanly.`),
    suggestion:
      suggestedTitle.toLowerCase() !== title.toLowerCase()
        ? `Try upgraded title: "${suggestedTitle}"`
        : "Title keywords look solid.",
  };

  const highShipRatio =
    shippingPrice > 0 && listedPrice > 0 && shippingPrice / listedPrice >= 0.5;
  const shippingCheck: SanityCheckItem = {
    area: "Shipping",
    status:
      ai.shippingStatus === "ok" ||
      ai.shippingStatus === "warn" ||
      ai.shippingStatus === "fix"
        ? ai.shippingStatus
        : highShipRatio
          ? "warn"
          : "ok",
    finding:
      ai.shippingFinding ||
      (highShipRatio
        ? `Shipping ($${shippingPrice.toFixed(2)}) is ${Math.round((shippingPrice / listedPrice) * 100)}% of item price ($${listedPrice.toFixed(2)}).`
        : shippingPrice > 0
          ? `Shipping set around $${shippingPrice.toFixed(2)}.`
          : "Buyer pays calculated shipping."),
    suggestion:
      ai.shippingAdvice ||
      "Double-check packaged weight on eBay so Calculated USPS Ground Advantage / UPS Ground isn't overcharging buyers.",
  };

  const allChecks = [priceCheck, titleCheck, shippingCheck, ...checks];
  const hasFix = allChecks.some((c) => c.status === "fix");
  const verdict: RelistSanityCheckResponse["verdict"] =
    ai.verdict === "relist_ready" ||
    ai.verdict === "fix_first" ||
    ai.verdict === "consider_donate"
      ? ai.verdict
      : relistCount >= 2 && listedPrice <= 12
        ? "consider_donate"
        : hasFix
          ? "fix_first"
          : "relist_ready";

  const compQuery = (ai.compSearchQuery || title).trim();
  const encQ = encodeURIComponent(compQuery);

  const response: RelistSanityCheckResponse = {
    mode,
    modelUsed,
    verdict,
    primaryDiagnosis:
      ai.primaryDiagnosis ||
      (views < 15
        ? `Low traffic (${views} views in ${daysListed}d) points to a title keyword or visibility bottleneck.`
        : `Buyers have viewed this ${views} times without buying — check price + shipping against live Sold Comps before relisting.`),
    checks: allChecks,
    suggestedTitle,
    suggestedPrice,
    estSoldLow,
    estSoldMedian,
    estSoldHigh,
    shippingAdvice: shippingCheck.suggestion,
    compSearchQuery: compQuery,
    ebaySoldUrl: `https://www.ebay.com/sch/i.html?_nkw=${encQ}&LH_Sold=1&LH_Complete=1&_sop=13`,
    ebayActiveUrl: `https://www.ebay.com/sch/i.html?_nkw=${encQ}&_sop=15`,
    photoCount,
    specificsCount,
  };

  return NextResponse.json(response);
}
