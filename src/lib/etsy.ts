import { getEnvReadiness } from "./supabase";
import { roundCurrency } from "./stale-engine";
import type { CrossListDraftPayload } from "./types";

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const ETSY_OAUTH_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

interface CachedEtsyToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedEtsyToken: CachedEtsyToken | null = null;

export interface EtsyActiveListingSummary {
  listingId: string;
  title: string;
  sku: string | null;
  price: number;
  url: string;
  views: number;
  numFavorers: number;
  state: string;
  createdTimestamp: number;
}

export function isEtsyConfigured(): boolean {
  return getEnvReadiness().isEtsyReady;
}

/**
 * Returns a valid Etsy Open API v3 OAuth2 Bearer token.
 * Uses ETSY_ACCESS_TOKEN directly when provided, or refreshes via ETSY_REFRESH_TOKEN.
 */
export async function getEtsyAccessToken(): Promise<string> {
  const directToken = process.env.ETSY_ACCESS_TOKEN?.trim();
  const refreshToken = process.env.ETSY_REFRESH_TOKEN?.trim();
  const apiKey = process.env.ETSY_API_KEY?.trim();

  if (cachedEtsyToken && cachedEtsyToken.expiresAtMs - 60_000 > Date.now()) {
    return cachedEtsyToken.accessToken;
  }

  if (refreshToken && apiKey) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: apiKey,
      refresh_token: refreshToken,
    });

    const response = await fetch(ETSY_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    });

    if (response.ok) {
      const data = (await response.json()) as {
        access_token: string;
        expires_in?: number;
      };
      cachedEtsyToken = {
        accessToken: data.access_token,
        expiresAtMs: Date.now() + (data.expires_in || 3600) * 1000,
      };
      return cachedEtsyToken.accessToken;
    }
  }

  if (directToken) {
    return directToken;
  }

  throw new Error(
    "Missing Etsy OAuth credentials (ETSY_API_KEY, ETSY_SHOP_ID, and ETSY_ACCESS_TOKEN or ETSY_REFRESH_TOKEN)."
  );
}

async function etsyRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = process.env.ETSY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing ETSY_API_KEY");
  }
  const token = await getEtsyAccessToken();

  const response = await fetch(`${ETSY_API_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Etsy API ${path} failed (${response.status}): ${errText}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

/**
 * Creates a listing in the connected Etsy shop via Open API v3.
 * Optionally activates it immediately when a shipping_profile_id is configured.
 */
export async function createEtsyListing(params: {
  draft: CrossListDraftPayload;
  publishImmediately?: boolean;
}): Promise<{
  externalListingId: string;
  externalUrl: string;
  status: "active" | "draft";
}> {
  const shopId = process.env.ETSY_SHOP_ID?.trim();
  if (!shopId) {
    throw new Error("Missing ETSY_SHOP_ID");
  }

  const shippingProfileId = process.env.ETSY_SHIPPING_PROFILE_ID?.trim();
  const payload: Record<string, unknown> = {
    quantity: 1,
    title: params.draft.mappedTitle.slice(0, 140),
    description: params.draft.descriptionPlain,
    price: roundCurrency(params.draft.pricing.suggestedPrice),
    who_made: params.draft.whoMade,
    when_made: params.draft.whenMade,
    taxonomy_id: params.draft.taxonomyId,
    is_supply: params.draft.isSupply,
    tags: params.draft.tags.slice(0, 13),
    sku: [params.draft.sku],
  };

  if (shippingProfileId) {
    payload.shipping_profile_id = Number(shippingProfileId);
  }

  const created = await etsyRequest<{
    listing_id: number;
    url?: string;
    state?: string;
  }>(`/shops/${encodeURIComponent(shopId)}/listings`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const listingIdStr = String(created.listing_id);
  let finalState: "active" | "draft" = "draft";

  if (params.publishImmediately && shippingProfileId) {
    try {
      await etsyRequest(
        `/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingIdStr)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ state: "active" }),
        }
      );
      finalState = "active";
    } catch {
      // Keep as draft if shop requires additional readiness fields
      finalState = "draft";
    }
  }

  return {
    externalListingId: listingIdStr,
    externalUrl:
      created.url || `https://www.etsy.com/listing/${listingIdStr}`,
    status: finalState,
  };
}

/**
 * Pulls active Etsy shop listings for inventory reconciliation and engagement sync.
 */
export async function fetchActiveEtsyListings(
  limit = 100
): Promise<EtsyActiveListingSummary[]> {
  const shopId = process.env.ETSY_SHOP_ID?.trim();
  if (!shopId) {
    throw new Error("Missing ETSY_SHOP_ID");
  }

  const data = await etsyRequest<{
    results?: Array<{
      listing_id: number;
      title: string;
      skus?: string[];
      price?: { amount: number; divisor: number };
      url?: string;
      views?: number;
      num_favorers?: number;
      state?: string;
      created_timestamp?: number;
    }>;
  }>(
    `/shops/${encodeURIComponent(shopId)}/listings/active?limit=${Math.min(limit, 100)}`
  );

  return (data.results ?? []).map((r) => {
    const price = r.price
      ? roundCurrency(r.price.amount / Math.max(1, r.price.divisor))
      : 0;
    return {
      listingId: String(r.listing_id),
      title: r.title,
      sku: r.skus?.[0] ?? null,
      price,
      url: r.url || `https://www.etsy.com/listing/${r.listing_id}`,
      views: r.views ?? 0,
      numFavorers: r.num_favorers ?? 0,
      state: r.state || "active",
      createdTimestamp: r.created_timestamp || Math.floor(Date.now() / 1000),
    };
  });
}

/**
 * Deactivates an Etsy listing (used by Phase 4 anti-double-sell auto-delist).
 */
export async function deactivateEtsyListing(listingId: string): Promise<void> {
  const shopId = process.env.ETSY_SHOP_ID?.trim();
  if (!shopId) {
    throw new Error("Missing ETSY_SHOP_ID");
  }
  await etsyRequest(
    `/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ state: "inactive" }),
    }
  );
}
