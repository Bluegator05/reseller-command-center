import { getEnvReadiness } from "./supabase";
import { roundCurrency } from "./stale-engine";

const EBAY_API_BASE = {
  PRODUCTION: "https://api.ebay.com",
  SANDBOX: "https://api.sandbox.ebay.com",
} as const;

const EBAY_WEB_BASE = {
  PRODUCTION: "https://www.ebay.com/itm",
  SANDBOX: "https://sandbox.ebay.com/itm",
} as const;

export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

interface CachedEbayToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedEbayToken | null = null;

export interface NormalizedEbayOffer {
  sku: string;
  title: string;
  descriptionHtml: string;
  descriptionPlain: string;
  condition: string;
  brand: string | null;
  categoryHint: string | null;
  imageUrls: string[];
  itemSpecifics: Record<string, string | string[]>;
  externalOfferId: string;
  externalListingId: string | null;
  externalUrl: string | null;
  listedPrice: number;
  shippingPrice: number;
  listedAt: string;
  viewsCount: number;
  watchersCount: number;
  impressionsCount: number;
  weightOz: number | null;
}

export function isEbayConfigured(): boolean {
  return getEnvReadiness().isEbayReady;
}

export function getEbayBaseUrls() {
  const env =
    (process.env.EBAY_ENV || "PRODUCTION").toUpperCase() === "SANDBOX"
      ? "SANDBOX"
      : "PRODUCTION";
  return {
    env,
    apiBase: EBAY_API_BASE[env],
    webBase: EBAY_WEB_BASE[env],
  };
}

/**
 * Exchanges EBAY_REFRESH_TOKEN for a short-lived OAuth2 User Access Token,
 * caching it in memory until 60 seconds before expiry.
 */
export async function getEbayAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  const refreshToken = process.env.EBAY_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing eBay OAuth credentials (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN)."
    );
  }

  const { apiBase } = getEbayBaseUrls();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: EBAY_OAUTH_SCOPES,
  });

  const response = await fetch(`${apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `eBay OAuth token refresh failed (${response.status}): ${errText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    accessToken: data.access_token,
    expiresAtMs: now + (data.expires_in || 7200) * 1000,
  };

  return cachedToken.accessToken;
}

async function ebayRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await getEbayAccessToken();
  const { apiBase } = getEbayBaseUrls();

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      Accept: "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`eBay API ${path} failed (${response.status}): ${errText}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

/**
 * Calls eBay Trading API (`ws/api.dll`) using the same OAuth access token via
 * `X-EBAY-API-IAF-TOKEN`, enabling full support for listings created in
 * eBay Seller Hub and the eBay mobile app (including real WatchCount, HitCount,
 * and exact StartTime).
 */
async function ebayTradingRequest(
  callName: string,
  innerXml: string
): Promise<string> {
  const token = await getEbayAccessToken();
  const { apiBase } = getEbayBaseUrls();
  const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${callName}Request>`;

  const response = await fetch(`${apiBase}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1355",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-IAF-TOKEN": token,
      "Content-Type": "text/xml; charset=utf-8",
    },
    body: xmlPayload,
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `eBay Trading API ${callName} failed (${response.status}): ${text.slice(0, 240)}`
    );
  }

  const ack = extractXmlTag(text, "Ack");
  if (ack && ack !== "Success" && ack !== "Warning") {
    const longMsg =
      extractXmlTag(text, "LongMessage") ||
      extractXmlTag(text, "ShortMessage") ||
      "Trading API returned Failure";
    throw new Error(`eBay ${callName} error: ${decodeXmlEntities(longMsg)}`);
  }

  return text;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function extractXmlTag(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : null;
}

function extractAllXmlTags(xml: string, tagName: string): string[] {
  const re = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    "gi"
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface EbayInventoryItemRecord {
  sku: string;
  condition?: string;
  product?: {
    title?: string;
    description?: string;
    brand?: string;
    imageUrls?: string[];
    aspects?: Record<string, string[]>;
  };
  packageWeightAndSize?: {
    weight?: { value?: number; unit?: string };
  };
}

interface EbayOfferRecord {
  offerId: string;
  sku: string;
  status?: string;
  categoryId?: string;
  listingDescription?: string;
  pricingSummary?: {
    price?: { value?: string; currency?: string };
  };
  listing?: {
    listingId?: string;
    listingStatus?: string;
    soldQuantity?: number;
  };
  listingStartDate?: string;
}

/**
 * Pulls active Seller Hub / Mobile App / Legacy listings via eBay Trading API
 * `GetMyeBaySelling`, capturing real WatchCount, HitCount, and exact StartTime.
 */
async function fetchActiveTradingListings(
  limit = 2000
): Promise<NormalizedEbayOffer[]> {
  const { webBase } = getEbayBaseUrls();
  const normalized: NormalizedEbayOffer[] = [];
  const entriesPerPage = Math.min(limit, 200);
  const maxPages = Math.max(1, Math.ceil(limit / entriesPerPage));

  for (let page = 1; page <= maxPages; page++) {
    const xml = await ebayTradingRequest(
      "GetMyeBaySelling",
      `<ActiveList>
        <Include>true</Include>
        <Pagination>
          <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
          <PageNumber>${page}</PageNumber>
        </Pagination>
      </ActiveList>
      <DetailLevel>ReturnAll</DetailLevel>`
    );

    const activeListBlock = extractXmlTag(xml, "ActiveList") || xml;
    const itemBlocks = extractAllXmlTags(activeListBlock, "Item");
    if (itemBlocks.length === 0) break;

    for (const block of itemBlocks) {
      const itemId = extractXmlTag(block, "ItemID");
      if (!itemId) continue;

      const rawSku = extractXmlTag(block, "SKU");
      const sku = rawSku && rawSku.length > 0 ? rawSku : `EBAY-${itemId}`;
      const title = extractXmlTag(block, "Title") || `eBay Item #${itemId}`;

      const sellingStatusBlock = extractXmlTag(block, "SellingStatus") || "";
      const currentPriceStr =
        extractXmlTag(sellingStatusBlock, "CurrentPrice") ||
        extractXmlTag(block, "BuyItNowPrice") ||
        extractXmlTag(block, "StartPrice") ||
        "0";
      const listedPrice = roundCurrency(Number(currentPriceStr) || 0);

      const shippingBlock = extractXmlTag(block, "ShippingDetails") || "";
      const shipCostStr =
        extractXmlTag(shippingBlock, "ShippingServiceCost") || "0";
      const shippingPrice = roundCurrency(Number(shipCostStr) || 0);

      const listingDetailsBlock = extractXmlTag(block, "ListingDetails") || "";
      const startTime =
        extractXmlTag(listingDetailsBlock, "StartTime") ||
        new Date().toISOString();
      const viewItemUrl =
        extractXmlTag(listingDetailsBlock, "ViewItemURL") ||
        `${webBase}/${itemId}`;

      const watchCount = Number(extractXmlTag(block, "WatchCount") || 0) || 0;
      const hitCount = Number(extractXmlTag(block, "HitCount") || 0) || 0;

      const picBlock = extractXmlTag(block, "PictureDetails") || "";
      const picUrls = extractAllXmlTags(picBlock, "PictureURL")
        .map((u) => decodeXmlEntities(u))
        .filter(Boolean);
      const galleryUrl = extractXmlTag(picBlock, "GalleryURL");
      if (picUrls.length === 0 && galleryUrl) {
        picUrls.push(galleryUrl);
      }

      const categoryBlock = extractXmlTag(block, "PrimaryCategory") || "";
      const categoryHint = extractXmlTag(categoryBlock, "CategoryName");
      const condition =
        extractXmlTag(block, "ConditionDisplayName") || "Pre-owned";

      normalized.push({
        sku,
        title,
        descriptionHtml: "",
        descriptionPlain: "",
        condition,
        brand: null,
        categoryHint,
        imageUrls: picUrls,
        itemSpecifics: {},
        externalOfferId: itemId,
        externalListingId: itemId,
        externalUrl: viewItemUrl,
        listedPrice,
        shippingPrice,
        listedAt: startTime,
        viewsCount: hitCount,
        watchersCount: watchCount,
        impressionsCount: hitCount,
        weightOz: null,
      });
    }

    const totalPages =
      Number(
        extractXmlTag(
          extractXmlTag(activeListBlock, "PaginationResult") || "",
          "TotalNumberOfPages"
        ) || 1
      ) || 1;
    if (page >= totalPages || normalized.length >= limit) break;
  }

  return normalized.slice(0, limit);
}

/**
 * Pulls active eBay listings from BOTH Trading API (Seller Hub / Mobile App,
 * with real WatchCount, HitCount & StartTime) AND Sell Inventory API, merging
 * them without duplicates so 100% of active eBay listings sync cleanly.
 */
export async function fetchActiveEbayOffers(
  limit = 2000
): Promise<NormalizedEbayOffer[]> {
  const { webBase } = getEbayBaseUrls();
  const byListingId = new Map<string, NormalizedEbayOffer>();
  const bySku = new Map<string, NormalizedEbayOffer>();
  let tradingError: Error | null = null;

  // 1. Primary pull: Trading API GetMyeBaySelling (covers Seller Hub + App + real Watchers/Views)
  try {
    const tradingItems = await fetchActiveTradingListings(limit);
    for (const item of tradingItems) {
      if (bySku.has(item.sku) && item.externalListingId) {
        item.sku = `${item.sku}-${item.externalListingId.slice(-5)}`;
      }
      if (item.externalListingId) byListingId.set(item.externalListingId, item);
      bySku.set(item.sku, item);
    }
  } catch (err) {
    tradingError = err instanceof Error ? err : new Error(String(err));
    console.warn("[ebay] Trading API GetMyeBaySelling warning:", tradingError.message);
  }

  // 2. Secondary pull / enrichment: Sell Inventory API
  try {
    const invRes = await ebayRequest<{
      inventoryItems?: EbayInventoryItemRecord[];
    }>(`/sell/inventory/v1/inventory_item?limit=${Math.min(limit, 200)}&offset=0`);

    const inventoryItems = invRes.inventoryItems ?? [];
    for (const inv of inventoryItems) {
      try {
        const offerRes = await ebayRequest<{ offers?: EbayOfferRecord[] }>(
          `/sell/inventory/v1/offer?sku=${encodeURIComponent(inv.sku)}`
        );

        const publishedOffers = (offerRes.offers ?? []).filter(
          (o) =>
            o.status === "PUBLISHED" || o.listing?.listingStatus === "ACTIVE"
        );

        for (const offer of publishedOffers) {
          const listingId = offer.listing?.listingId || null;
          const priceVal = Number(offer.pricingSummary?.price?.value || 0);
          const descriptionHtml =
            offer.listingDescription || inv.product?.description || "";
          const weightVal = inv.packageWeightAndSize?.weight?.value ?? null;
          const weightUnit = inv.packageWeightAndSize?.weight?.unit;
          const weightOz =
            weightVal !== null
              ? weightUnit === "POUND"
                ? roundCurrency(weightVal * 16)
                : weightVal
              : null;

          const existing =
            (listingId && byListingId.get(listingId)) || bySku.get(inv.sku);

          if (existing) {
            // Enrich Trading API listing with Inventory API specifics/weight/description
            existing.externalOfferId = offer.offerId;
            if (descriptionHtml) {
              existing.descriptionHtml = descriptionHtml;
              existing.descriptionPlain = stripHtmlTags(descriptionHtml);
            }
            if (inv.product?.brand) existing.brand = inv.product.brand;
            if (weightOz !== null) existing.weightOz = weightOz;
            if (inv.product?.aspects) existing.itemSpecifics = inv.product.aspects;
            if (
              existing.imageUrls.length === 0 &&
              inv.product?.imageUrls?.length
            ) {
              existing.imageUrls = inv.product.imageUrls;
            }
          } else {
            const record: NormalizedEbayOffer = {
              sku: inv.sku,
              title: inv.product?.title || `SKU ${inv.sku}`,
              descriptionHtml,
              descriptionPlain: stripHtmlTags(descriptionHtml),
              condition: inv.condition || "USED_EXCELLENT",
              brand: inv.product?.brand || null,
              categoryHint: offer.categoryId || null,
              imageUrls: inv.product?.imageUrls ?? [],
              itemSpecifics: inv.product?.aspects ?? {},
              externalOfferId: offer.offerId,
              externalListingId: listingId || offer.offerId,
              externalUrl: listingId ? `${webBase}/${listingId}` : null,
              listedPrice: roundCurrency(priceVal),
              shippingPrice: 0,
              listedAt: offer.listingStartDate || new Date().toISOString(),
              viewsCount: 0,
              watchersCount: 0,
              impressionsCount: 0,
              weightOz,
            };
            if (record.externalListingId) {
              byListingId.set(record.externalListingId, record);
            }
            bySku.set(record.sku, record);
          }
        }
      } catch {
        continue;
      }
    }
  } catch (invErr) {
    // If both Trading API and Inventory API failed, surface the error
    if (bySku.size === 0) {
      throw tradingError ?? (invErr instanceof Error ? invErr : new Error(String(invErr)));
    }
  }

  return Array.from(bySku.values());
}

/**
 * Resolves an eBay Sell Inventory API offerId (returns null if the listing is a
 * Seller Hub / Trading API listing with no Inventory API offer).
 */
async function resolveInventoryOfferId(
  offerOrListingId: string,
  sku?: string
): Promise<string | null> {
  if (sku && !sku.startsWith("EBAY-")) {
    try {
      const res = await ebayRequest<{ offers?: EbayOfferRecord[] }>(
        `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`
      );
      const match =
        (res.offers ?? []).find(
          (o) =>
            o.offerId === offerOrListingId ||
            o.listing?.listingId === offerOrListingId
        ) ||
        (res.offers ?? []).find(
          (o) =>
            o.status === "PUBLISHED" || o.listing?.listingStatus === "ACTIVE"
        );
      if (match?.offerId) return match.offerId;
    } catch {
      // Not an Inventory API SKU
    }
  }
  return null;
}

/**
 * Updates an active eBay listing price.
 * Uses Sell Inventory API if managed as an Offer, or Trading API
 * `ReviseFixedPriceItem` for standard Seller Hub / mobile app listings.
 */
export async function updateEbayOfferPrice(params: {
  offerId: string;
  sku?: string;
  newPrice: number;
  currency?: string;
}): Promise<{ offerId: string; updatedPrice: number }> {
  const { offerId: rawId, sku, newPrice, currency = "USD" } = params;
  const formattedPrice = roundCurrency(newPrice).toFixed(2);
  const invOfferId = await resolveInventoryOfferId(rawId, sku);

  if (invOfferId) {
    const existingOffer = await ebayRequest<Record<string, unknown>>(
      `/sell/inventory/v1/offer/${encodeURIComponent(invOfferId)}`
    );

    const existingPricing =
      (existingOffer.pricingSummary as Record<string, unknown> | undefined) ||
      {};

    const updatedPayload = {
      ...existingOffer,
      pricingSummary: {
        ...existingPricing,
        price: {
          value: formattedPrice,
          currency,
        },
      },
    };

    await ebayRequest(
      `/sell/inventory/v1/offer/${encodeURIComponent(invOfferId)}`,
      {
        method: "PUT",
        body: JSON.stringify(updatedPayload),
      }
    );

    return {
      offerId: invOfferId,
      updatedPrice: Number(formattedPrice),
    };
  }

  // Fallback for Seller Hub / Trading API listings (12-digit ItemID)
  await ebayTradingRequest(
    "ReviseFixedPriceItem",
    `<Item>
      <ItemID>${rawId}</ItemID>
      <StartPrice currencyID="${currency}">${formattedPrice}</StartPrice>
    </Item>`
  );

  return {
    offerId: rawId,
    updatedPrice: Number(formattedPrice),
  };
}

/**
 * Executes TRUE End & Sell Similar on eBay so eBay assigns a brand-new 12-digit
 * eBay Item Number and fresh "Newly Listed" Cassini boost.
 * - For Inventory API offers: withdraw -> delete -> create fresh offer -> publish.
 * - For Seller Hub / Trading API listings: EndFixedPriceItem -> RelistFixedPriceItem
 *   (which mints a brand-new 12-digit ItemID with optional updated StartPrice).
 */
export async function endAndSellSimilarEbayOffer(params: {
  offerId: string;
  sku?: string;
  newPrice?: number;
}): Promise<{
  previousOfferId: string;
  previousListingId: string | null;
  newOfferId: string;
  newListingId: string;
  newExternalUrl: string;
}> {
  const { offerId: rawId, sku, newPrice } = params;
  const { webBase } = getEbayBaseUrls();
  const invOfferId = await resolveInventoryOfferId(rawId, sku);

  if (invOfferId) {
    const existingOffer = await ebayRequest<Record<string, unknown>>(
      `/sell/inventory/v1/offer/${encodeURIComponent(invOfferId)}`
    );

    const previousListingId =
      ((existingOffer.listing as Record<string, unknown> | undefined)
        ?.listingId as string | undefined) ?? null;

    await ebayRequest(
      `/sell/inventory/v1/offer/${encodeURIComponent(invOfferId)}/withdraw`,
      { method: "POST" }
    );

    await ebayRequest(
      `/sell/inventory/v1/offer/${encodeURIComponent(invOfferId)}`,
      { method: "DELETE" }
    );

    const clonePayload: Record<string, unknown> = { ...existingOffer };
    delete clonePayload.offerId;
    delete clonePayload.status;
    delete clonePayload.listing;
    delete clonePayload.listingStartDate;

    if (typeof newPrice === "number" && newPrice > 0) {
      const existingPricing =
        (clonePayload.pricingSummary as Record<string, unknown> | undefined) ||
        {};
      clonePayload.pricingSummary = {
        ...existingPricing,
        price: {
          value: roundCurrency(newPrice).toFixed(2),
          currency: "USD",
        },
      };
    }

    const created = await ebayRequest<{ offerId: string }>(
      `/sell/inventory/v1/offer`,
      {
        method: "POST",
        body: JSON.stringify(clonePayload),
      }
    );

    const published = await ebayRequest<{ listingId: string }>(
      `/sell/inventory/v1/offer/${encodeURIComponent(created.offerId)}/publish`,
      { method: "POST" }
    );

    return {
      previousOfferId: invOfferId,
      previousListingId,
      newOfferId: created.offerId,
      newListingId: published.listingId,
      newExternalUrl: `${webBase}/${published.listingId}`,
    };
  }

  // Seller Hub / Trading API path: EndFixedPriceItem -> RelistFixedPriceItem (fresh 12-digit ItemID)
  await ebayTradingRequest(
    "EndFixedPriceItem",
    `<ItemID>${rawId}</ItemID>
     <EndingReason>NotAvailable</EndingReason>`
  );

  const priceOverrideXml =
    typeof newPrice === "number" && newPrice > 0
      ? `<StartPrice currencyID="USD">${roundCurrency(newPrice).toFixed(2)}</StartPrice>`
      : "";

  const relistXml = await ebayTradingRequest(
    "RelistFixedPriceItem",
    `<Item>
      <ItemID>${rawId}</ItemID>
      ${priceOverrideXml}
    </Item>`
  );

  const newListingId = extractXmlTag(relistXml, "ItemID") || rawId;
  return {
    previousOfferId: rawId,
    previousListingId: rawId,
    newOfferId: newListingId,
    newListingId,
    newExternalUrl: `${webBase}/${newListingId}`,
  };
}

/**
 * Sends a targeted discount offer to interested buyers/watchers via eBay Negotiation API.
 */
export async function sendEbayOfferToWatchers(params: {
  listingId: string;
  discountPct: number;
  message?: string;
}): Promise<{ offersSent: number }> {
  const {
    listingId,
    discountPct,
    message = "Thanks for watching! Grab it today with an exclusive watcher discount.",
  } = params;

  const result = await ebayRequest<{ offers?: Array<{ offerId: string }> }>(
    `/sell/negotiation/v1/send_offer_to_interested_buyers`,
    {
      method: "POST",
      headers: {
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
      body: JSON.stringify({
        allowCounterOffer: false,
        message,
        offeredItems: [
          {
            discountPercentage: String(Math.max(5, Math.round(discountPct))),
            listingId,
            quantity: 1,
          },
        ],
      }),
    }
  );

  return {
    offersSent: result.offers?.length ?? 0,
  };
}

/**
 * Ends an active eBay listing (supports both Inventory API offers and Seller Hub
 * Trading API ItemIDs). Used by Phase 4 anti-double-sell when an item sells elsewhere.
 */
export async function withdrawEbayOffer(
  offerOrListingId: string,
  sku?: string
): Promise<void> {
  const invOfferId = await resolveInventoryOfferId(offerOrListingId, sku);
  if (invOfferId) {
    await ebayRequest(
      `/sell/inventory/v1/offer/${encodeURIComponent(invOfferId)}/withdraw`,
      { method: "POST" }
    );
    return;
  }

  await ebayTradingRequest(
    "EndFixedPriceItem",
    `<ItemID>${offerOrListingId}</ItemID>
     <EndingReason>NotAvailable</EndingReason>`
  );
}

/**
 * Promotes an active eBay listing via eBay Sell Marketing API (Promoted Listings Standard / CPS).
 * Defaults to a 4.0% ad rate when items cross the 30-day listing threshold.
 */
export async function promoteEbayListing(params: {
  listingId: string;
  adRatePct?: number;
  campaignId?: string;
}): Promise<{ adId: string; adRatePct: number }> {
  const campaignId =
    params.campaignId?.trim() || process.env.EBAY_AD_CAMPAIGN_ID?.trim();
  if (!campaignId) {
    throw new Error(
      "Missing EBAY_AD_CAMPAIGN_ID for Promoted Listings Standard campaign."
    );
  }

  const adRate = Math.max(2, Math.min(20, roundCurrency(params.adRatePct ?? 4)));
  const res = await ebayRequest<{ adId?: string }>(
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`,
    {
      method: "POST",
      body: JSON.stringify({
        listingId: params.listingId,
        bidPercentage: adRate.toFixed(1),
      }),
    }
  );

  return {
    adId: res.adId || `ad-${params.listingId}`,
    adRatePct: adRate,
  };
}
