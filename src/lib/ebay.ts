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

const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
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
 * Pulls active eBay Inventory items and their published offers using Sell Inventory API.
 * Enriches traffic metrics when Sell Analytics traffic report is accessible.
 */
export async function fetchActiveEbayOffers(
  limit = 100
): Promise<NormalizedEbayOffer[]> {
  const { webBase } = getEbayBaseUrls();
  const invRes = await ebayRequest<{
    inventoryItems?: EbayInventoryItemRecord[];
  }>(`/sell/inventory/v1/inventory_item?limit=${Math.min(limit, 200)}&offset=0`);

  const inventoryItems = invRes.inventoryItems ?? [];
  const normalized: NormalizedEbayOffer[] = [];

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

        normalized.push({
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
        });
      }
    } catch {
      // Skip SKUs that do not yet have published offers
      continue;
    }
  }

  return normalized;
}

/**
 * Resolves an eBay Sell Inventory API offerId.
 * Because `marketplace_listings.external_listing_id` stores the public 12-digit
 * eBay Item Number (needed for item URLs & Negotiation API), we look up the
 * underlying offerId by SKU when needed.
 */
async function resolveEbayOfferId(
  offerOrListingId: string,
  sku?: string
): Promise<string> {
  if (sku) {
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
      // Fall back to passed ID
    }
  }
  return offerOrListingId;
}

/**
 * Updates an active eBay offer price via Sell Inventory API.
 * Fetches the full offer payload first so eBay required fields are preserved.
 */
export async function updateEbayOfferPrice(params: {
  offerId: string;
  sku?: string;
  newPrice: number;
  currency?: string;
}): Promise<{ offerId: string; updatedPrice: number }> {
  const { offerId: rawId, sku, newPrice, currency = "USD" } = params;
  const offerId = await resolveEbayOfferId(rawId, sku);
  const formattedPrice = roundCurrency(newPrice).toFixed(2);

  const existingOffer = await ebayRequest<Record<string, unknown>>(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
  );

  const existingPricing =
    (existingOffer.pricingSummary as Record<string, unknown> | undefined) || {};

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

  await ebayRequest(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
    method: "PUT",
    body: JSON.stringify(updatedPayload),
  });

  return {
    offerId,
    updatedPrice: Number(formattedPrice),
  };
}

/**
 * Executes TRUE End & Sell Similar on eBay (NOT eBay's legacy Relist):
 * 1. Fetches the full active offer payload.
 * 2. Withdraws (ends) the stale listing via `/offer/{offerId}/withdraw`.
 * 3. Deletes the withdrawn offer via `DELETE /offer/{offerId}` so eBay clears
 *    the old offer entity (preventing Error 25002 on duplicate SKU/marketplace).
 * 4. Creates a brand-new Offer via `POST /sell/inventory/v1/offer`.
 * 5. Publishes the new Offer via `POST /offer/{newOfferId}/publish`, forcing
 *    eBay to assign a brand-new 12-digit eBay Item Number (`listingId`) and
 *    fresh "Newly Listed" Cassini search boost.
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
  const offerId = await resolveEbayOfferId(rawId, sku);
  const { webBase } = getEbayBaseUrls();

  const existingOffer = await ebayRequest<Record<string, unknown>>(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`
  );

  const previousListingId =
    ((existingOffer.listing as Record<string, unknown> | undefined)
      ?.listingId as string | undefined) ?? null;

  // 1. End (withdraw) the stale active listing
  await ebayRequest(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
    { method: "POST" }
  );

  // 2. Delete the withdrawn offer entity so eBay allows a brand-new offer for this SKU
  await ebayRequest(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
    method: "DELETE",
  });

  // 3. Strip read-only identifiers and create a completely fresh offer (Sell Similar)
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

  // 4. Publish the brand-new offer to receive a brand-new eBay Item Number
  const published = await ebayRequest<{ listingId: string }>(
    `/sell/inventory/v1/offer/${encodeURIComponent(created.offerId)}/publish`,
    { method: "POST" }
  );

  return {
    previousOfferId: offerId,
    previousListingId,
    newOfferId: created.offerId,
    newListingId: published.listingId,
    newExternalUrl: `${webBase}/${published.listingId}`,
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
        allowCounterOffer: true,
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
 * Withdraws (ends) an active eBay offer via Sell Inventory API.
 * Used by Phase 4 anti-double-sell when an item sells on another marketplace.
 */
export async function withdrawEbayOffer(offerId: string): Promise<void> {
  await ebayRequest(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
    { method: "POST" }
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
