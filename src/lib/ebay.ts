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
  promotedAdRatePct?: number;
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

  const rawText = await response.text();
  if (!rawText.trim()) {
    return {} as T;
  }

  return JSON.parse(rawText) as T;
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
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function upgradeEbayImageUrl(url: string): string {
  const clean = decodeXmlEntities(url).trim();
  if (!clean) return "";
  if (/i\.ebayimg\.com/i.test(clean)) {
    return clean
      .replace(/\/s-l(?:64|96|140|200|225|300|400|500)\.(jpg|jpeg|png|webp)/i, "/s-l1600.$1")
      .replace(/\$_(?:1|12|35)\.(JPG|JPEG|PNG)/i, "$_57.$1");
  }
  return clean;
}

export interface EbayFullItemDetails {
  itemId: string;
  imageUrls: string[];
  descriptionHtml: string;
  descriptionPlain: string;
  brand: string | null;
  condition: string | null;
  categoryHint: string | null;
  itemSpecifics: Record<string, string[]>;
}

/**
 * Fetches full listing details from eBay Trading API `GetItem` — including ALL
 * full-resolution photos (`<PictureURL>` array, up to 24), full HTML/plain
 * description, Brand, and Item Specifics (`GetMyeBaySelling` only returns 1
 * thumbnail `<GalleryURL>` and no description).
 */
export async function fetchEbayItemDetails(
  itemId: string
): Promise<EbayFullItemDetails | null> {
  const cleanId = itemId.trim();
  if (!cleanId || !/^\d+$/.test(cleanId)) return null;
  if (!isEbayConfigured()) return null;

  try {
    const xml = await ebayTradingRequest(
      "GetItem",
      `<ItemID>${cleanId}</ItemID>
      <DetailLevel>ReturnAll</DetailLevel>
      <IncludeItemSpecifics>true</IncludeItemSpecifics>`
    );

    const itemBlock = extractXmlTag(xml, "Item") || xml;
    const picBlock = extractXmlTag(itemBlock, "PictureDetails") || "";
    const rawPics = extractAllXmlTags(picBlock, "PictureURL")
      .map(upgradeEbayImageUrl)
      .filter(Boolean);
    const gallery = extractXmlTag(picBlock, "GalleryURL");
    if (rawPics.length === 0 && gallery) {
      const upgraded = upgradeEbayImageUrl(gallery);
      if (upgraded) rawPics.push(upgraded);
    }

    // Deduplicate while preserving eBay's exact photo order
    const seen = new Set<string>();
    const imageUrls: string[] = [];
    for (const u of rawPics) {
      if (!seen.has(u)) {
        seen.add(u);
        imageUrls.push(u);
      }
    }

    const descriptionHtml = extractXmlTag(itemBlock, "Description") || "";
    const conditionDesc = extractXmlTag(itemBlock, "ConditionDescription") || "";
    const strippedBody = stripHtmlTags(descriptionHtml);
    const descriptionPlain = conditionDesc && !strippedBody.includes(conditionDesc)
      ? `Condition notes: ${conditionDesc}\n\n${strippedBody}`.trim()
      : strippedBody;

    const specificsBlock = extractXmlTag(itemBlock, "ItemSpecifics") || "";
    const nvlBlocks = extractAllXmlTags(specificsBlock, "NameValueList");
    const itemSpecifics: Record<string, string[]> = {};
    for (const nvl of nvlBlocks) {
      const name = extractXmlTag(nvl, "Name");
      const vals = extractAllXmlTags(nvl, "Value")
        .map((v) => decodeXmlEntities(v))
        .filter(Boolean);
      if (name && vals.length > 0) {
        itemSpecifics[name] = vals;
      }
    }

    const brand =
      itemSpecifics["Brand"]?.[0] ||
      itemSpecifics["Manufacturer"]?.[0] ||
      itemSpecifics["Designer"]?.[0] ||
      null;
    const condition = extractXmlTag(itemBlock, "ConditionDisplayName");
    const categoryBlock = extractXmlTag(itemBlock, "PrimaryCategory") || "";
    const categoryHint = extractXmlTag(categoryBlock, "CategoryName");

    return {
      itemId: cleanId,
      imageUrls,
      descriptionHtml,
      descriptionPlain,
      brand,
      condition,
      categoryHint,
      itemSpecifics,
    };
  } catch (err) {
    console.warn(`[ebay] GetItem(${cleanId}) warning:`, err);
    return null;
  }
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
 * Queries eBay's Negotiation API (`find_eligible_items`) to return ONLY the
 * exact 12-digit eBay listingIds that currently have eligible interested buyers
 * and do NOT already have an active seller-initiated offer.
 */
export async function fetchEligibleOfferListingIds(
  maxItems = 1000
): Promise<string[]> {
  const ids: string[] = [];
  const pageSize = 200;

  for (let offset = 0; offset < maxItems; offset += pageSize) {
    const res = await ebayRequest<{
      eligibleItems?: Array<{ listingId?: string }>;
      total?: number;
    }>(
      `/sell/negotiation/v1/find_eligible_items?limit=${pageSize}&offset=${offset}`,
      {
        headers: {
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
      }
    );

    const batch = (res.eligibleItems ?? [])
      .map((i) => i.listingId)
      .filter((id): id is string => Boolean(id));
    ids.push(...batch);

    const total = res.total ?? batch.length;
    if (batch.length < pageSize || ids.length >= total) break;
  }

  return Array.from(new Set(ids));
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

let cachedCpsCampaignId: string | null = null;

interface EbayCampaignRecord {
  campaignId: string;
  campaignName?: string;
  campaignStatus?: string;
  marketplaceId?: string;
  fundingStrategy?: {
    fundingModel?: string;
    bidPercentage?: string;
  };
  campaignCriterion?: {
    selectionRules?: unknown[];
    autoSelectFutureInventory?: boolean;
  };
}

/**
 * Resolves the eBay Promoted Listings General (`COST_PER_SALE`) key-based campaign ID:
 * 1. Uses explicit `campaignId` arg or `EBAY_AD_CAMPAIGN_ID` env var if set.
 * 2. Otherwise queries running `COST_PER_SALE` campaigns on `EBAY_US` and reuses
 *    an existing key-based campaign (preferring "Reseller Command Center Auto-Promote").
 * 3. If none exists, creates a new key-based `COST_PER_SALE` campaign automatically.
 */
async function resolveOrCreateCpsCampaignId(
  adRatePct: number,
  explicitCampaignId?: string
): Promise<string> {
  const configured =
    explicitCampaignId?.trim() || process.env.EBAY_AD_CAMPAIGN_ID?.trim();
  if (configured) return configured;
  if (cachedCpsCampaignId) return cachedCpsCampaignId;

  const listRes = await ebayRequest<{ campaigns?: EbayCampaignRecord[] }>(
    `/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&funding_strategy=COST_PER_SALE&limit=50`
  );

  const runningKeyBased = (listRes.campaigns ?? []).filter(
    (c) =>
      c.campaignStatus === "RUNNING" &&
      (!c.marketplaceId || c.marketplaceId === "EBAY_US") &&
      (!c.fundingStrategy?.fundingModel ||
        c.fundingStrategy.fundingModel === "COST_PER_SALE") &&
      !c.campaignCriterion?.selectionRules?.length &&
      !c.campaignCriterion?.autoSelectFutureInventory
  );

  const preferred =
    runningKeyBased.find((c) =>
      (c.campaignName || "").toLowerCase().includes("reseller command center")
    ) || runningKeyBased[0];

  if (preferred?.campaignId) {
    cachedCpsCampaignId = preferred.campaignId;
    return preferred.campaignId;
  }

  // Create a dedicated key-based Promoted Listings General (CPS) campaign automatically
  const token = await getEbayAccessToken();
  const { apiBase } = getEbayBaseUrls();
  const createRes = await fetch(`${apiBase}/sell/marketing/v1/ad_campaign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      Accept: "application/json",
    },
    body: JSON.stringify({
      campaignName: "Reseller Command Center Auto-Promote",
      marketplaceId: "EBAY_US",
      startDate: new Date().toISOString(),
      fundingStrategy: {
        fundingModel: "COST_PER_SALE",
        bidPercentage: adRatePct.toFixed(1),
      },
    }),
    cache: "no-store",
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(
      `Failed to create eBay Promoted Listings campaign (${createRes.status}): ${errText}`
    );
  }

  const location = createRes.headers.get("location") || "";
  const idFromHeader = location.split("/").filter(Boolean).at(-1);
  if (idFromHeader) {
    cachedCpsCampaignId = idFromHeader;
    return idFromHeader;
  }

  // Fallback: re-fetch campaigns to pick up the newly created campaign ID
  const afterRes = await ebayRequest<{ campaigns?: EbayCampaignRecord[] }>(
    `/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&funding_strategy=COST_PER_SALE&limit=20`
  );
  const created = (afterRes.campaigns ?? []).find((c) =>
    (c.campaignName || "").toLowerCase().includes("reseller command center")
  );
  if (created?.campaignId) {
    cachedCpsCampaignId = created.campaignId;
    return created.campaignId;
  }

  throw new Error(
    "Created eBay ad campaign but could not read its campaign ID from response."
  );
}

/**
 * Fetches live Promoted Listings General (`COST_PER_SALE`) ad rates for all
 * active ads across the seller's running campaigns so Sync eBay shows real
 * promoted percentages (e.g., 2%, 4%, 7%) instead of 0%.
 */
export async function fetchActivePromotedRates(): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  try {
    const listRes = await ebayRequest<{ campaigns?: EbayCampaignRecord[] }>(
      `/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&funding_strategy=COST_PER_SALE&limit=50`
    );

    const campaigns = (listRes.campaigns ?? []).filter(
      (c) => c.campaignStatus === "RUNNING"
    );

    for (const c of campaigns) {
      for (let offset = 0; offset < 2500; offset += 500) {
        const adsRes = await ebayRequest<{
          ads?: Array<{
            listingId?: string;
            bidPercentage?: string;
            adStatus?: string;
          }>;
          total?: number;
        }>(
          `/sell/marketing/v1/ad_campaign/${encodeURIComponent(c.campaignId)}/ad?limit=500&offset=${offset}`
        );
        const ads = adsRes.ads ?? [];
        for (const ad of ads) {
          if (!ad.listingId) continue;
          if (ad.adStatus && ad.adStatus !== "ACTIVE") continue;
          const pct = Number(ad.bidPercentage ?? 0);
          if (pct > 0) {
            rates.set(ad.listingId, pct);
          }
        }
        if (ads.length < 500) break;
      }
    }
  } catch (err) {
    console.warn(
      "[ebay] Could not fetch promoted listing rates:",
      err instanceof Error ? err.message : err
    );
  }
  return rates;
}

/**
 * Promotes an active eBay listing via eBay Sell Marketing API (Promoted Listings General / CPS).
 * Automatically discovers or creates a running COST_PER_SALE campaign when
 * `EBAY_AD_CAMPAIGN_ID` is not set, and updates the ad bid rate cleanly via
 * `bulk_update_ads_bid_by_listing_id` if the listing is already promoted (Error 35036).
 */
export async function promoteEbayListing(params: {
  listingId: string;
  adRatePct?: number;
  campaignId?: string;
}): Promise<{ adId: string; adRatePct: number; campaignId: string }> {
  const adRate = Math.max(2, Math.min(20, roundCurrency(params.adRatePct ?? 4)));
  const bidStr = adRate.toFixed(1);
  const campaignId = await resolveOrCreateCpsCampaignId(
    adRate,
    params.campaignId
  );

  const tryUpdateBidInCampaign = async (targetCampaignId: string) => {
    const updRes = await ebayRequest<{
      responses?: Array<{
        statusCode?: number;
        listingId?: string;
        errors?: Array<{ message?: string }>;
      }>;
    }>(
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(targetCampaignId)}/bulk_update_ads_bid_by_listing_id`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: [
            {
              listingId: params.listingId,
              bidPercentage: bidStr,
            },
          ],
        }),
      }
    );
    const first = updRes.responses?.[0];
    if (!first || (first.statusCode && first.statusCode >= 200 && first.statusCode < 300)) {
      return {
        adId: `updated-${params.listingId}`,
        adRatePct: adRate,
        campaignId: targetCampaignId,
      };
    }
    return null;
  };

  try {
    const res = await ebayRequest<{ adId?: string }>(
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`,
      {
        method: "POST",
        body: JSON.stringify({
          listingId: params.listingId,
          bidPercentage: bidStr,
        }),
      }
    );

    return {
      adId: res.adId || `ad-${params.listingId}`,
      adRatePct: adRate,
      campaignId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Error 35036 / 35048 / 35049: Ad for this listingId already exists in a campaign
    if (
      msg.includes("35036") ||
      msg.includes("35048") ||
      msg.includes("35049") ||
      msg.toLowerCase().includes("already exists") ||
      msg.toLowerCase().includes("already")
    ) {
      // 1. Try updating bid directly in the primary campaign first
      const directUpdate = await tryUpdateBidInCampaign(campaignId).catch(
        () => null
      );
      if (directUpdate) return directUpdate;

      // 2. Otherwise locate which campaign owns this listing and update bid there
      const found = await ebayRequest<{
        campaigns?: Array<{ campaignId?: string }>;
      }>(
        `/sell/marketing/v1/ad_campaign/find_campaign_by_ad_reference?listing_id=${encodeURIComponent(params.listingId)}`
      );
      const otherCampaignId = found.campaigns?.[0]?.campaignId;
      if (otherCampaignId) {
        const otherUpdate = await tryUpdateBidInCampaign(otherCampaignId);
        if (otherUpdate) return otherUpdate;
      }
    }
    throw err;
  }
}

export interface NormalizedEbaySaleLine {
  externalOrderId: string;
  legacyItemId: string | null;
  sku: string;
  title: string;
  quantity: number;
  grossSalePrice: number;
  marketplaceFees: number;
  shippingCost: number;
  refundAmount: number;
  fulfillmentStatus: "to_ship" | "shipped" | "returned" | "partial_refund" | "unpaid";
  trackingNumber: string | null;
  shippedAt: string | null;
  returnReason: string | null;
  soldAt: string;
}

interface EbayFulfillmentOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate?: string;
  orderFulfillmentStatus?: "FULFILLED" | "IN_PROGRESS" | "NOT_STARTED";
  orderPaymentStatus?: "PAID" | "PENDING" | "FAILED" | "FULLY_REFUNDED" | "PARTIALLY_REFUNDED";
  cancelStatus?: {
    cancelState?: "CANCELED" | "IN_PROGRESS" | "NONE_REQUESTED";
    cancelRequests?: Array<{ cancelReason?: string }>;
  };
  pricingSummary?: {
    priceSubtotal?: { value?: string };
    deliveryCost?: { value?: string };
    total?: { value?: string };
  };
  totalMarketplaceFee?: { value?: string };
  paymentSummary?: {
    refunds?: Array<{
      refundStatus?: string;
      amount?: { value?: string };
    }>;
  };
  lineItems?: Array<{
    lineItemId?: string;
    legacyItemId?: string;
    sku?: string;
    title?: string;
    quantity?: number;
    lineItemCost?: { value?: string };
    deliveryCost?: { shippingCost?: { value?: string } };
    total?: { value?: string };
    lineItemFulfillmentStatus?: "FULFILLED" | "IN_PROGRESS" | "NOT_STARTED";
  }>;
}

/**
 * Fetches historical eBay Seller orders via the Fulfillment API (supports up to 2 years
 * with exact eBay final-value fees & refund totals), falling back to Trading API `GetOrders`
 * (up to 90 days) if Fulfillment API scope is unavailable.
 */
export async function fetchEbaySalesOrders(daysBack = 365): Promise<{
  orders: NormalizedEbaySaleLine[];
  sourceApi: "fulfillment_v1" | "trading_get_orders";
  daysBack: number;
}> {
  const clampedDays = Math.max(7, Math.min(730, Math.round(daysBack)));
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - clampedDays * 24 * 60 * 60 * 1000);
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();

  // 1. Try eBay Fulfillment API (supports up to 2 years + exact totalMarketplaceFee + refunds)
  try {
    const rawOrders: EbayFulfillmentOrder[] = [];
    const limit = 200;
    const filter = `creationdate:[${startIso}..${endIso}]`;

    for (let page = 0; page < 10; page++) {
      const offset = page * limit;
      const res = await ebayRequest<{
        orders?: EbayFulfillmentOrder[];
        total?: number;
      }>(
        `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}&filter=${encodeURIComponent(filter)}`
      );
      const batch = res.orders || [];
      rawOrders.push(...batch);
      if (batch.length < limit || (res.total && rawOrders.length >= res.total)) {
        break;
      }
    }

    const lines: NormalizedEbaySaleLine[] = [];

    for (const order of rawOrders) {
      const items = order.lineItems || [];
      if (items.length === 0) continue;

      const orderShipping = Number(order.pricingSummary?.deliveryCost?.value || 0);
      const orderFeeRaw =
        order.totalMarketplaceFee?.value !== undefined
          ? Number(order.totalMarketplaceFee.value)
          : null;
      const orderRefundTotal = (order.paymentSummary?.refunds || [])
        .filter((r) => r.refundStatus !== "FAILED")
        .reduce((sum, r) => sum + (Number(r.amount?.value) || 0), 0);

      const rawLineGrosses = items.map((li) => {
        const itemCost = Number(li.lineItemCost?.value || 0);
        const shipCost =
          li.deliveryCost?.shippingCost?.value !== undefined
            ? Number(li.deliveryCost.shippingCost.value)
            : items.length === 1
              ? orderShipping
              : 0;
        return { itemCost, shipCost, gross: roundCurrency(itemCost + shipCost) };
      });
      const totalOrderGross = rawLineGrosses.reduce((s, x) => s + x.gross, 0);

      const isCanceled = order.cancelStatus?.cancelState === "CANCELED";
      const cancelReason =
        order.cancelStatus?.cancelRequests?.[0]?.cancelReason || null;

      items.forEach((li, idx) => {
        const { gross, shipCost } = rawLineGrosses[idx];
        const share =
          totalOrderGross > 0 ? gross / totalOrderGross : 1 / items.length;
        const fees =
          orderFeeRaw !== null && Number.isFinite(orderFeeRaw)
            ? roundCurrency(orderFeeRaw * share)
            : roundCurrency(gross * 0.1325 + (idx === 0 ? 0.3 : 0));
        let refund = roundCurrency(orderRefundTotal * share);

        let status: NormalizedEbaySaleLine["fulfillmentStatus"] = "to_ship";
        if (
          isCanceled ||
          order.orderPaymentStatus === "FAILED" ||
          order.orderPaymentStatus === "PENDING"
        ) {
          status = "unpaid";
          if (refund === 0 && isCanceled) refund = gross;
        } else if (
          order.orderPaymentStatus === "FULLY_REFUNDED" ||
          (refund > 0 && refund >= gross - 0.01)
        ) {
          status = "returned";
        } else if (
          order.orderPaymentStatus === "PARTIALLY_REFUNDED" ||
          refund > 0
        ) {
          status = "partial_refund";
        } else if (
          li.lineItemFulfillmentStatus === "FULFILLED" ||
          order.orderFulfillmentStatus === "FULFILLED"
        ) {
          status = "shipped";
        }

        const extOrderId =
          items.length === 1 ? order.orderId : `${order.orderId}#${idx + 1}`;
        const legacyId = li.legacyItemId?.trim() || null;
        const sku =
          (li.sku || "").trim() ||
          (legacyId ? `EBAY-${legacyId}` : `EBAY-ORD-${extOrderId}`);

        lines.push({
          externalOrderId: extOrderId,
          legacyItemId: legacyId,
          sku,
          title: (li.title || "eBay Sold Item").trim(),
          quantity: Math.max(1, Number(li.quantity || 1)),
          grossSalePrice: gross,
          marketplaceFees: fees,
          shippingCost: roundCurrency(shipCost),
          refundAmount: refund,
          fulfillmentStatus: status,
          trackingNumber: null,
          shippedAt:
            status === "shipped"
              ? order.lastModifiedDate || order.creationDate
              : null,
          returnReason: cancelReason,
          soldAt: order.creationDate || new Date().toISOString(),
        });
      });
    }

    return {
      orders: lines,
      sourceApi: "fulfillment_v1",
      daysBack: clampedDays,
    };
  } catch (fulfillmentErr) {
    const msg =
      fulfillmentErr instanceof Error
        ? fulfillmentErr.message
        : String(fulfillmentErr);
    // Only fall back to Trading API GetOrders on permission/scope issues
    if (!msg.includes("401") && !msg.includes("403") && !msg.includes("scope")) {
      throw fulfillmentErr;
    }
  }

  // 2. Fallback: eBay Trading API GetOrders (supports up to 90 days)
  const tradingDays = Math.min(90, clampedDays);
  const tradingStart = new Date(
    endDate.getTime() - tradingDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const lines: NormalizedEbaySaleLine[] = [];

  for (let page = 1; page <= 10; page++) {
    const xml = await ebayTradingRequest(
      "GetOrders",
      `<CreateTimeFrom>${tradingStart}</CreateTimeFrom>
      <CreateTimeTo>${endIso}</CreateTimeTo>
      <OrderRole>Seller</OrderRole>
      <OrderStatus>All</OrderStatus>
      <Pagination>
        <EntriesPerPage>100</EntriesPerPage>
        <PageNumber>${page}</PageNumber>
      </Pagination>`
    );

    const orderBlocks = extractAllXmlTags(xml, "Order");
    for (const ob of orderBlocks) {
      const orderId = extractXmlTag(ob, "OrderID") || "";
      if (!orderId) continue;
      const orderStatus = (extractXmlTag(ob, "OrderStatus") || "").toLowerCase();
      const createdTime =
        extractXmlTag(ob, "CreatedTime") || new Date().toISOString();
      const shippedTime = extractXmlTag(ob, "ShippedTime") || null;
      const orderShipCost = Number(
        extractXmlTag(
          extractXmlTag(ob, "ShippingServiceSelected") || "",
          "ShippingServiceCost"
        ) || 0
      );

      const txBlocks = extractAllXmlTags(ob, "Transaction");
      txBlocks.forEach((tx, idx) => {
        const itemBlock = extractXmlTag(tx, "Item") || "";
        const legacyId = extractXmlTag(itemBlock, "ItemID") || null;
        const title = decodeXmlEntities(
          extractXmlTag(itemBlock, "Title") || "eBay Sold Item"
        );
        const sku =
          decodeXmlEntities(
            extractXmlTag(itemBlock, "SKU") || extractXmlTag(tx, "SKU") || ""
          ).trim() ||
          (legacyId ? `EBAY-${legacyId}` : `EBAY-ORD-${orderId}`);
        const qty = Math.max(1, Number(extractXmlTag(tx, "QuantityPurchased") || 1));
        const unitPrice = Number(extractXmlTag(tx, "TransactionPrice") || 0);
        const lineShip = idx === 0 ? orderShipCost : 0;
        const gross = roundCurrency(unitPrice * qty + lineShip);
        const fvf = Number(extractXmlTag(tx, "FinalValueFee") || 0);
        const fees =
          fvf > 0
            ? roundCurrency(fvf)
            : roundCurrency(gross * 0.1325 + (idx === 0 ? 0.3 : 0));
        const tracking =
          extractXmlTag(tx, "ShipmentTrackingNumber") || null;

        let status: NormalizedEbaySaleLine["fulfillmentStatus"] = "to_ship";
        if (orderStatus.includes("cancel") || orderStatus.includes("inactive")) {
          status = "unpaid";
        } else if (shippedTime || tracking) {
          status = "shipped";
        }

        lines.push({
          externalOrderId:
            txBlocks.length === 1 ? orderId : `${orderId}#${idx + 1}`,
          legacyItemId: legacyId,
          sku,
          title,
          quantity: qty,
          grossSalePrice: gross,
          marketplaceFees: fees,
          shippingCost: roundCurrency(lineShip),
          refundAmount: status === "unpaid" ? gross : 0,
          fulfillmentStatus: status,
          trackingNumber: tracking,
          shippedAt: shippedTime,
          returnReason: null,
          soldAt: createdTime,
        });
      });
    }

    const hasMore = (extractXmlTag(xml, "HasMoreOrders") || "").toLowerCase();
    if (hasMore !== "true" || orderBlocks.length === 0) break;
  }

  return {
    orders: lines,
    sourceApi: "trading_get_orders",
    daysBack: tradingDays,
  };
}

