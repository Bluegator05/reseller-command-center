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
  hasRealListedAt?: boolean;
  viewsCount: number;
  watchersCount: number;
  impressionsCount: number;
  promotedAdRatePct?: number;
  weightOz: number | null;
  quantityAvailable: number;
  quantityTotal?: number;
  quantitySold?: number;
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
const EBAY_SITE_NAME_TO_ID: Record<string, string> = {
  us: "0",
  canada: "2",
  uk: "3",
  australia: "15",
  austria: "16",
  belgium_french: "23",
  france: "71",
  germany: "77",
  ebaymotors: "100",
  motors: "100",
  italy: "101",
  belgium_dutch: "123",
  netherlands: "146",
  spain: "186",
  switzerland: "193",
  hongkong: "201",
  india: "203",
  ireland: "205",
  malaysia: "207",
  canadafrench: "210",
  philippines: "211",
  poland: "212",
  singapore: "216",
};

function resolveEbaySiteId(siteName?: string | null): string {
  if (!siteName) return "0";
  const key = siteName.trim().toLowerCase();
  if (/^\d+$/.test(key)) return key;
  return EBAY_SITE_NAME_TO_ID[key] || "0";
}

function isWrongEbaySiteError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /not\s+created\s+on\s+this\s+eBay\s+site|different\s+eBay\s+site|created\s+on\s+a\s+different\s+site|site\s*id\s*(mismatch|invalid)|21916519|21916518/i.test(
    msg
  );
}

async function ebayTradingRequest(
  callName: string,
  innerXml: string,
  siteId = "0"
): Promise<string> {
  const token = await getEbayAccessToken();
  const { apiBase } = getEbayBaseUrls();
  const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${callName}Request>`;

  const sendOnce = async (targetSiteId: string): Promise<string> => {
    const response = await fetch(`${apiBase}/ws/api.dll`, {
      method: "POST",
      headers: {
        "X-EBAY-API-SITEID": targetSiteId,
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
  };

  try {
    return await sendOnce(siteId);
  } catch (err) {
    // Listings created on eBay Motors use SiteID 100 instead of US SiteID 0
    if (siteId === "0" && isWrongEbaySiteError(err)) {
      console.warn(
        `[ebay] ${callName} hit wrong eBay site on SiteID 0 — retrying on eBay Motors (SiteID 100)`
      );
      return await sendOnce("100");
    }
    throw err;
  }
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
  categoryId: string | null;
  categoryHint: string | null;
  itemSpecifics: Record<string, string[]>;
  weightOz: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  shippingProfileName: string | null;
  shippingType: string | null;
  currentPrice: number | null;
  bestOfferEnabled: boolean;
  bestOfferAutoAcceptPrice: number | null;
  minimumBestOfferPrice: number | null;
  site: string;
  siteId: string;
}

/**
 * Fetches full listing details from eBay Trading API `GetItem` — including ALL
 * full-resolution photos (`<PictureURL>` array, up to 24), full HTML/plain
 * description, Brand, Item Specifics, real ShippingPackageDetails weight/dims,
 * and live Best Offer auto-accept / auto-decline thresholds.
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
    const categoryId = extractXmlTag(categoryBlock, "CategoryID");
    const categoryHint = extractXmlTag(categoryBlock, "CategoryName");

    // Extract live package weight & dimensions from ShippingPackageDetails / CalculatedShippingRate
    const pkgBlock =
      extractXmlTag(itemBlock, "ShippingPackageDetails") ||
      extractXmlTag(itemBlock, "CalculatedShippingRate") ||
      "";
    const wMajor = Number(extractXmlTag(pkgBlock, "WeightMajor") || 0);
    const wMinor = Number(extractXmlTag(pkgBlock, "WeightMinor") || 0);
    const totalOz = wMajor * 16 + wMinor;
    const weightOz =
      Number.isFinite(totalOz) && totalOz > 0 ? Math.round(totalOz) : null;

    const rawLen = Number(extractXmlTag(pkgBlock, "PackageLength") || 0);
    const rawWid = Number(extractXmlTag(pkgBlock, "PackageWidth") || 0);
    const rawHgt = Number(extractXmlTag(pkgBlock, "PackageDepth") || 0);
    const lengthIn = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : null;
    const widthIn = Number.isFinite(rawWid) && rawWid > 0 ? rawWid : null;
    const heightIn = Number.isFinite(rawHgt) && rawHgt > 0 ? rawHgt : null;

    const shipProfileBlock = extractXmlTag(itemBlock, "SellerShippingProfile") || "";
    const shippingProfileName = extractXmlTag(
      shipProfileBlock,
      "ShippingProfileName"
    );
    const shipDetailsBlock = extractXmlTag(itemBlock, "ShippingDetails") || "";
    const shippingType = extractXmlTag(shipDetailsBlock, "ShippingType");

    // Extract live Buy It Now price & Best Offer auto-accept / minimum (auto-decline) thresholds
    const sellingStatusBlock = extractXmlTag(itemBlock, "SellingStatus") || "";
    const rawCurrentPrice = Number(
      extractXmlTag(sellingStatusBlock, "CurrentPrice") ||
        extractXmlTag(itemBlock, "StartPrice") ||
        0
    );
    const currentPrice =
      Number.isFinite(rawCurrentPrice) && rawCurrentPrice > 0
        ? roundCurrency(rawCurrentPrice)
        : null;

    const bestOfferBlock = extractXmlTag(itemBlock, "BestOfferDetails") || "";
    const bestOfferEnabled =
      extractXmlTag(bestOfferBlock, "BestOfferEnabled")?.toLowerCase() === "true";

    const listingDetailsBlock = extractXmlTag(itemBlock, "ListingDetails") || "";
    const rawAutoAccept = Number(
      extractXmlTag(listingDetailsBlock, "BestOfferAutoAcceptPrice") || 0
    );
    const rawMinOffer = Number(
      extractXmlTag(listingDetailsBlock, "MinimumBestOfferPrice") || 0
    );
    const bestOfferAutoAcceptPrice =
      Number.isFinite(rawAutoAccept) && rawAutoAccept > 0
        ? roundCurrency(rawAutoAccept)
        : null;
    const minimumBestOfferPrice =
      Number.isFinite(rawMinOffer) && rawMinOffer > 0
        ? roundCurrency(rawMinOffer)
        : null;

    // Extract listing-level <Site> (strip <Seller> first because Seller.Site is always US even for eBayMotors listings)
    const itemWithoutSeller = itemBlock
      .replace(/<Seller\b[^>]*>[\s\S]*?<\/Seller>/gi, "")
      .replace(/<Buyer\b[^>]*>[\s\S]*?<\/Buyer>/gi, "");
    const site = extractXmlTag(itemWithoutSeller, "Site") || "US";
    const siteId = resolveEbaySiteId(site);

    return {
      itemId: cleanId,
      imageUrls,
      descriptionHtml,
      descriptionPlain,
      brand,
      condition,
      categoryId,
      categoryHint,
      itemSpecifics,
      weightOz,
      lengthIn,
      widthIn,
      heightIn,
      shippingProfileName,
      shippingType,
      currentPrice,
      bestOfferEnabled,
      bestOfferAutoAcceptPrice,
      minimumBestOfferPrice,
      site,
      siteId,
    };
  } catch (err) {
    console.warn(`[ebay] GetItem(${cleanId}) warning:`, err);
    return null;
  }
}

/**
 * Lightweight Trading API `GetItem` call requesting only PictureDetails to
 * backfill thumbnails for historical sold eBay orders.
 */
export async function fetchEbayItemThumbnail(
  itemId: string
): Promise<string | null> {
  const cleanId = itemId.trim();
  if (!cleanId || !/^\d+$/.test(cleanId)) return null;
  if (!isEbayConfigured()) return null;

  try {
    const xml = await ebayTradingRequest(
      "GetItem",
      `<ItemID>${cleanId}</ItemID>
      <OutputSelector>Item.PictureDetails.PictureURL</OutputSelector>
      <OutputSelector>Item.PictureDetails.GalleryURL</OutputSelector>`
    );

    const picBlock = extractXmlTag(xml, "PictureDetails") || xml;
    const firstPic = extractAllXmlTags(picBlock, "PictureURL")[0];
    const gallery = extractXmlTag(picBlock, "GalleryURL");
    const chosen = firstPic || gallery;
    return chosen ? upgradeEbayImageUrl(chosen) || chosen : null;
  } catch {
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
  availableQuantity?: number;
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
 * `GetMyeBaySelling`, capturing real WatchCount, HitCount, QuantityAvailable, and StartTime.
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
        <Sort>StartTimeDescending</Sort>
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
      const rawStartTime =
        extractXmlTag(listingDetailsBlock, "StartTime") ||
        extractXmlTag(block, "StartTime");
      const hasRealStartTime = Boolean(
        rawStartTime && !Number.isNaN(Date.parse(rawStartTime))
      );
      const startTime = hasRealStartTime
        ? new Date(Date.parse(rawStartTime!)).toISOString()
        : new Date().toISOString();
      const viewItemUrl =
        extractXmlTag(listingDetailsBlock, "ViewItemURL") ||
        `${webBase}/${itemId}`;

      const watchCount = Number(extractXmlTag(block, "WatchCount") || 0) || 0;
      const hitCount = Number(extractXmlTag(block, "HitCount") || 0) || 0;

      const rawQtyAvail = extractXmlTag(block, "QuantityAvailable");
      const rawQtyTotal = Number(extractXmlTag(block, "Quantity") || 1) || 1;
      const rawQtySold =
        Number(extractXmlTag(sellingStatusBlock, "QuantitySold") || 0) || 0;
      const computedQtyAvail =
        rawQtyAvail !== null && rawQtyAvail !== "" && Number.isFinite(Number(rawQtyAvail))
          ? Math.floor(Number(rawQtyAvail))
          : Math.floor(rawQtyTotal - rawQtySold);
      // Skip sold-out / Out-Of-Stock (0 available qty) listings so eBay OOS listings never stay active
      if (computedQtyAvail <= 0) continue;
      const quantityAvailable = Math.max(1, computedQtyAvail);

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
        hasRealListedAt: hasRealStartTime,
        viewsCount: hitCount,
        watchersCount: watchCount,
        impressionsCount: hitCount,
        weightOz: null,
        quantityAvailable,
        quantityTotal: Math.max(quantityAvailable, Math.floor(rawQtyTotal), quantityAvailable + Math.max(0, Math.floor(rawQtySold))),
        quantitySold: Math.max(0, Math.floor(rawQtySold)),
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
 * Lightweight Trading API `GetMyeBaySelling` check returning ONLY live active
 * ItemIDs, SKUs, and remaining QuantityAvailable (strictly > 0).
 * Used by sales sync to distinguish truly sold-out listings from multi-quantity
 * listings that still have units live on eBay. Returns null if eBay fails.
 */
export async function fetchLiveActiveEbayIds(limit = 2000): Promise<{
  listingIds: Set<string>;
  skus: Set<string>;
  qtyByListingId: Map<string, number>;
  qtyBySku: Map<string, number>;
} | null> {
  if (!isEbayConfigured()) return null;
  try {
    const listingIds = new Set<string>();
    const skus = new Set<string>();
    const qtyByListingId = new Map<string, number>();
    const qtyBySku = new Map<string, number>();
    const entriesPerPage = Math.min(limit, 200);
    const maxPages = Math.max(1, Math.ceil(limit / entriesPerPage));
    let seen = 0;

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
        <OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
        <OutputSelector>ActiveList.ItemArray.Item.SKU</OutputSelector>
        <OutputSelector>ActiveList.ItemArray.Item.Quantity</OutputSelector>
        <OutputSelector>ActiveList.ItemArray.Item.QuantityAvailable</OutputSelector>
        <OutputSelector>ActiveList.ItemArray.Item.SellingStatus.QuantitySold</OutputSelector>
        <OutputSelector>ActiveList.PaginationResult</OutputSelector>`
      );

      const activeListBlock = extractXmlTag(xml, "ActiveList") || xml;
      const itemBlocks = extractAllXmlTags(activeListBlock, "Item");
      if (itemBlocks.length === 0) break;

      for (const block of itemBlocks) {
        const itemId = extractXmlTag(block, "ItemID")?.trim();
        if (!itemId) continue;
        const rawSku = extractXmlTag(block, "SKU")?.trim() || "";
        const sellingStatusBlock = extractXmlTag(block, "SellingStatus") || "";
        const rawQtyAvail = extractXmlTag(block, "QuantityAvailable");
        const rawQtyTotal = Number(extractXmlTag(block, "Quantity") || 1) || 1;
        const rawQtySold =
          Number(extractXmlTag(sellingStatusBlock, "QuantitySold") || 0) || 0;
        const computedQtyAvail =
          rawQtyAvail !== null && rawQtyAvail !== "" && Number.isFinite(Number(rawQtyAvail))
            ? Math.floor(Number(rawQtyAvail))
            : Math.floor(rawQtyTotal - rawQtySold);

        if (computedQtyAvail <= 0) continue;

        listingIds.add(itemId);
        qtyByListingId.set(itemId, computedQtyAvail);
        if (rawSku) {
          const skuKey = rawSku.toLowerCase();
          skus.add(skuKey);
          qtyBySku.set(skuKey, computedQtyAvail);
        }
        seen += 1;
      }

      const totalPages =
        Number(
          extractXmlTag(
            extractXmlTag(activeListBlock, "PaginationResult") || "",
            "TotalNumberOfPages"
          ) || 1
        ) || 1;
      if (page >= totalPages || seen >= limit) break;
    }

    return { listingIds, skus, qtyByListingId, qtyBySku };
  } catch (err) {
    console.warn("[ebay] fetchLiveActiveEbayIds warning:", err);
    return null;
  }
}

/**
 * Pulls active eBay listings from BOTH Trading API (Seller Hub / Mobile App,
 * with real WatchCount, HitCount & StartTime) AND Sell Inventory API, merging
 * them without duplicates so 100% of active eBay listings sync cleanly.
 * Also reports `tradingSucceeded` so callers know it is safe to reconcile
 * disappeared/sold listings against the full active catalog.
 */
export async function fetchActiveEbayOffersWithMeta(
  limit = 2000
): Promise<{ offers: NormalizedEbayOffer[]; tradingSucceeded: boolean }> {
  const { webBase } = getEbayBaseUrls();
  const byListingId = new Map<string, NormalizedEbayOffer>();
  const bySku = new Map<string, NormalizedEbayOffer>();
  let tradingError: Error | null = null;
  let tradingSucceeded = false;

  // 1. Primary pull: Trading API GetMyeBaySelling (covers Seller Hub + App + real Watchers/Views)
  try {
    const tradingItems = await fetchActiveTradingListings(limit);
    tradingSucceeded = true;
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
            (o.status === "PUBLISHED" || o.listing?.listingStatus === "ACTIVE") &&
            (typeof o.availableQuantity !== "number" || o.availableQuantity > 0)
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
          const offerQty =
            typeof offer.availableQuantity === "number" && offer.availableQuantity >= 1
              ? Math.floor(offer.availableQuantity)
              : 1;

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
            const invSoldQty = Math.max(0, Math.floor(Number(offer.listing?.soldQuantity || 0)));
            if (offerQty > 1) existing.quantityAvailable = offerQty;
            existing.quantitySold = Math.max(existing.quantitySold ?? 0, invSoldQty);
            existing.quantityTotal = Math.max(
              existing.quantityTotal ?? 1,
              existing.quantityAvailable + (existing.quantitySold ?? 0)
            );
            if (
              existing.imageUrls.length === 0 &&
              inv.product?.imageUrls?.length
            ) {
              existing.imageUrls = inv.product.imageUrls;
            }
          } else {
            const invSoldQty = Math.max(0, Math.floor(Number(offer.listing?.soldQuantity || 0)));
            const hasRealOfferStartDate = Boolean(
              offer.listingStartDate &&
                !Number.isNaN(Date.parse(offer.listingStartDate))
            );
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
              listedAt: hasRealOfferStartDate
                ? new Date(Date.parse(offer.listingStartDate!)).toISOString()
                : new Date().toISOString(),
              hasRealListedAt: hasRealOfferStartDate,
              viewsCount: 0,
              watchersCount: 0,
              impressionsCount: 0,
              weightOz,
              quantityAvailable: offerQty,
              quantityTotal: offerQty + invSoldQty,
              quantitySold: invSoldQty,
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

  return { offers: Array.from(bySku.values()), tradingSucceeded };
}

export async function fetchActiveEbayOffers(
  limit = 2000
): Promise<NormalizedEbayOffer[]> {
  const { offers } = await fetchActiveEbayOffersWithMeta(limit);
  return offers;
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

interface BestOfferPlan {
  autoAcceptToSet: number | null;
  minOfferToSet: number | null;
  deleteAutoAccept: boolean;
  deleteMinOffer: boolean;
  listingDetailsXml: string;
  deletedFieldsXml: string;
  note: string | null;
}

function isBestOfferUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /best\s*offer[^.\n]*(unavailable|disabled|not\s*(available|supported|allowed|applicable)|cannot\s*be\s*(enabled|used))|21915292|219026/i.test(
    msg
  );
}

function isBestOfferThresholdError(err: unknown): boolean {
  if (isBestOfferUnavailableError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err || "");
  return /best\s*offer|auto[- ]?accept|minimum.*offer|auto[- ]?decline|2191660[3456]/i.test(
    msg
  );
}

function parseIncompatibleAspectPairError(err: unknown): {
  badValue: string;
  targetAspect: string;
  driverAspect: string;
  driverValue: string;
} | null {
  const msg = err instanceof Error ? err.message : String(err || "");
  const m = msg.match(
    /"([^"]+)"\s+is\s+not\s+a\s+valid\s+(?:value\s+for\s+)?(.+?)\s+for\s+(?:the\s+)?(.+?)\s+"([^"]+)"\./i
  );
  if (!m) return null;
  return {
    badValue: m[1].trim(),
    targetAspect: m[2].trim(),
    driverAspect: m[3].trim(),
    driverValue: m[4].trim(),
  };
}

function parseInvalidItemSpecificError(
  err: unknown
): { badValue: string; aspectName: string } | null {
  if (parseIncompatibleAspectPairError(err)) return null;
  const msg = err instanceof Error ? err.message : String(err || "");
  const m = msg.match(
    /"([^"]+)"\s+is\s+not\s+a\s+valid\s+value\s+for\s+([^.]+?)\./i
  );
  if (!m) return null;
  return {
    badValue: m[1].trim(),
    aspectName: m[2].trim(),
  };
}

function buildItemSpecificsXml(
  specsMap: Map<string, { name: string; values: string[] }>
): string {
  const nvlXml = [...specsMap.values()]
    .filter((entry) => entry.name.trim() && entry.values.length > 0)
    .slice(0, 35)
    .map(
      (entry) => `      <NameValueList>
        <Name>${escapeXml(entry.name.trim().slice(0, 40))}</Name>
        ${entry.values
          .slice(0, 5)
          .map((v) => `<Value>${escapeXml(v.trim().slice(0, 65))}</Value>`)
          .join("\n        ")}
      </NameValueList>`
    )
    .join("\n");
  return nvlXml ? `<ItemSpecifics>\n${nvlXml}\n    </ItemSpecifics>` : "";
}

interface EbayTaxonomyAspect {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectRequired?: boolean;
    aspectMode?: string;
  };
  aspectValues?: Array<{
    localizedValue?: string;
    valueConstraints?: Array<{
      applicableForLocalizedAspectName?: string;
      applicableForLocalizedAspectValues?: string[];
    }>;
  }>;
}

async function fetchEbayCategoryAspects(
  categoryId: string,
  siteId = "0"
): Promise<EbayTaxonomyAspect[]> {
  if (!categoryId || !/^\d+$/.test(categoryId)) return [];
  const treeId = siteId === "100" ? "100" : "0";
  try {
    const data = await ebayRequest<{ aspects?: EbayTaxonomyAspect[] }>(
      `/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(
        categoryId
      )}`
    );
    return data.aspects || [];
  } catch (err) {
    console.warn(
      `[ebay] Taxonomy get_item_aspects_for_category(${categoryId}) warning:`,
      err
    );
    return [];
  }
}

async function fetchEbayCategoryAspectOptions(
  categoryId: string,
  aspectName: string,
  siteId = "0"
): Promise<{ required: boolean; values: string[] } | null> {
  const aspects = await fetchEbayCategoryAspects(categoryId, siteId);
  const target = aspectName.trim().toLowerCase();
  const matched = aspects.find(
    (a) => a.localizedAspectName?.trim().toLowerCase() === target
  );
  if (!matched) return null;
  const values = (matched.aspectValues || [])
    .map((v) => v.localizedValue?.trim() || "")
    .filter(Boolean);
  return {
    required: Boolean(matched.aspectConstraint?.aspectRequired),
    values,
  };
}

async function resolveCompatibleEbayDependentAspect(params: {
  categoryId: string | null | undefined;
  targetAspect: string;
  badValue: string;
  driverAspect: string;
  driverValue: string;
  siteId?: string;
}): Promise<
  | { action: "replace"; value: string; sampleOptions: string[] }
  | { action: "remove"; sampleOptions: string[] }
  | { action: "unmatched"; sampleOptions: string[] }
> {
  const {
    categoryId,
    targetAspect,
    badValue,
    driverAspect,
    driverValue,
    siteId = "0",
  } = params;

  const targetLower = targetAspect.trim().toLowerCase();
  const driverLower = driverAspect.trim().toLowerCase();
  const driverValLower = driverValue.trim().toLowerCase();
  const badLower = badValue.trim().toLowerCase();

  const aspects = categoryId
    ? await fetchEbayCategoryAspects(categoryId, siteId)
    : [];
  const targetMeta = aspects.find(
    (a) => a.localizedAspectName?.trim().toLowerCase() === targetLower
  );
  const driverMeta = aspects.find(
    (a) => a.localizedAspectName?.trim().toLowerCase() === driverLower
  );

  const compatible: string[] = [];

  // 1. Forward constraint lookup: driverAspect (e.g. Size = "5") -> applicable targetAspect (e.g. Size Type = ["Juniors"])
  if (driverMeta?.aspectValues) {
    const driverValEntry = driverMeta.aspectValues.find(
      (v) => v.localizedValue?.trim().toLowerCase() === driverValLower
    );
    for (const vc of driverValEntry?.valueConstraints || []) {
      if (
        vc.applicableForLocalizedAspectName?.trim().toLowerCase() === targetLower
      ) {
        for (const allowed of vc.applicableForLocalizedAspectValues || []) {
          const clean = allowed.trim();
          if (clean && !compatible.includes(clean)) compatible.push(clean);
        }
      }
    }
  }

  // 2. Reverse constraint lookup: targetAspect values whose valueConstraints list driverValue
  if (compatible.length === 0 && targetMeta?.aspectValues) {
    for (const tv of targetMeta.aspectValues) {
      const valName = tv.localizedValue?.trim();
      if (!valName) continue;
      const matchesDriver = (tv.valueConstraints || []).some(
        (vc) =>
          vc.applicableForLocalizedAspectName?.trim().toLowerCase() ===
            driverLower &&
          (vc.applicableForLocalizedAspectValues || []).some(
            (dv) => dv.trim().toLowerCase() === driverValLower
          )
      );
      if (matchesDriver && !compatible.includes(valName)) {
        compatible.push(valName);
      }
    }
  }

  const usable = compatible.filter((v) => v.toLowerCase() !== badLower);
  if (usable.length > 0) {
    return { action: "replace", value: usable[0], sampleOptions: usable.slice(0, 12) };
  }

  // 3. Deterministic eBay clothing Size -> Size Type fallback
  if (targetLower === "size type" && driverLower === "size") {
    const cleanDriver = driverValue.trim().toUpperCase();
    let inferred: string | null = null;
    if (/^\d+$/.test(cleanDriver)) {
      const n = Number(cleanDriver);
      if (n % 2 === 1 && n >= 1 && n <= 21) {
        inferred = "Juniors";
      } else if (n % 2 === 0 && n >= 14 && n <= 32) {
        inferred = badLower === "regular" ? "Plus" : "Regular";
      } else if (n % 2 === 0 && n >= 0 && n <= 14) {
        inferred = "Regular";
      }
    } else if (/^(\d+P|X{0,2}[SML]P)$/i.test(cleanDriver)) {
      inferred = "Petite";
    } else if (/^([1-6]X|\d+W)$/i.test(cleanDriver)) {
      inferred = "Plus";
    } else if (/^(X{0,3}[ML]T|\d+T)$/i.test(cleanDriver) && !/^[2-5]T$/i.test(cleanDriver)) {
      inferred = "Tall";
    }
    if (inferred && inferred.toLowerCase() !== badLower) {
      return { action: "replace", value: inferred, sampleOptions: [inferred] };
    }
  }

  const targetOptions = (targetMeta?.aspectValues || [])
    .map((v) => v.localizedValue?.trim() || "")
    .filter(Boolean)
    .slice(0, 12);

  if (targetMeta && !targetMeta.aspectConstraint?.aspectRequired) {
    return { action: "remove", sampleOptions: targetOptions };
  }

  return { action: "unmatched", sampleOptions: targetOptions };
}

function pickBestEbayAspectValue(
  badValue: string,
  allowedValues: string[]
): string | null {
  if (allowedValues.length === 0) return null;
  const clean = badValue.trim();
  const lower = clean.toLowerCase();
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, "");

  const byLower = new Map<string, string>();
  const byCompact = new Map<string, string>();
  for (const val of allowedValues) {
    const l = val.toLowerCase();
    if (!byLower.has(l)) byLower.set(l, val);
    const c = compact(val);
    if (c && !byCompact.has(c)) byCompact.set(c, val);
  }

  // 1. Exact case-insensitive or compact alphanumeric match
  if (byLower.has(lower)) return byLower.get(lower)!;
  if (byCompact.has(compact(clean))) return byCompact.get(compact(clean))!;

  // 2. Common size / abbreviation aliases
  const aliasGroups: string[][] = [
    ["xxs", "2xs", "xx-small", "extra extra small"],
    ["xs", "x-small", "extra small"],
    ["s", "sm", "small"],
    ["m", "med", "medium", "regular"],
    ["l", "lg", "lrg", "large"],
    ["xl", "x-large", "extra large"],
    ["2xl", "xxl", "2x", "xx-large", "extra extra large"],
    ["3xl", "xxxl", "3x", "xxx-large"],
    ["4xl", "xxxxl", "4x"],
    ["os", "osfa", "one size", "one size fits all", "one size fits most"],
    ["nb", "newborn"],
  ];
  for (const group of aliasGroups) {
    if (group.includes(lower) || group.includes(compact(clean))) {
      for (const cand of group) {
        if (byLower.has(cand)) return byLower.get(cand)!;
        if (byCompact.has(compact(cand))) return byCompact.get(compact(cand))!;
      }
    }
  }

  // 3. Baby / infant month sizing (e.g. "2M" -> "2 Months" or "0-3 Months" when category uses month buckets)
  const monthMatch = clean.match(/^(\d+(?:\.\d+)?)\s*m(?:o|os|onths?)?$/i);
  if (monthMatch) {
    const n = Number(monthMatch[1]);
    for (const cand of [
      `${monthMatch[1]} months`,
      `${monthMatch[1]} month`,
      `${monthMatch[1]} mo`,
      `${monthMatch[1]}m`,
    ]) {
      if (byLower.has(cand)) return byLower.get(cand)!;
      if (byCompact.has(compact(cand))) return byCompact.get(compact(cand))!;
    }
    // Narrowest matching month range (e.g. "0-3 Months" for 2M)
    let bestRange: { val: string; span: number } | null = null;
    for (const val of allowedValues) {
      const rm = val.match(/^(\d+)\s*[-–to]+\s*(\d+)\s*months?$/i);
      if (!rm) continue;
      const lo = Number(rm[1]);
      const hi = Number(rm[2]);
      if (n >= lo && n <= hi) {
        const span = hi - lo;
        if (!bestRange || span < bestRange.span) {
          bestRange = { val, span };
        }
      }
    }
    if (bestRange) return bestRange.val;
  }

  // 4. Numeric + fit/width/length suffix (e.g. "2M" -> "2 Medium", "2 Regular", "2"; "8.5W" -> "8.5"; "10P" -> "10P" / "10")
  const numSuffix = clean.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (numSuffix) {
    const num = numSuffix[1];
    const suf = numSuffix[2].toLowerCase();
    const suffixExpansions: Record<string, string[]> = {
      m: ["medium", "regular", "med", "m"],
      r: ["regular", "reg", "r"],
      p: ["petite", "p"],
      t: ["tall", "t"],
      w: ["wide", "women's", "w"],
      l: ["long", "l"],
      s: ["short", "s"],
      d: ["medium", "d"],
      b: ["medium", "b"],
      n: ["narrow", "n"],
    };
    const expanded = suffixExpansions[suf] || [suf];
    for (const exp of expanded) {
      for (const cand of [`${num} ${exp}`, `${num}${exp}`, `size ${num} ${exp}`]) {
        if (byLower.has(cand)) return byLower.get(cand)!;
        if (byCompact.has(compact(cand))) return byCompact.get(compact(cand))!;
      }
    }
    for (const cand of [num, `size ${num}`, `us ${num}`, `${num} us`]) {
      if (byLower.has(cand)) return byLower.get(cand)!;
      if (byCompact.has(compact(cand))) return byCompact.get(compact(cand))!;
    }
  }

  // 5. Prefix-stripped sizes (e.g. "US 8" -> "8", "Size 2" -> "2")
  const prefixStrip = clean.match(/^(?:us|size|sz|eu|uk)\s*[:#-]?\s*([a-z0-9.]+)$/i);
  if (prefixStrip) {
    const bare = prefixStrip[1].toLowerCase();
    if (byLower.has(bare)) return byLower.get(bare)!;
    if (byCompact.has(compact(bare))) return byCompact.get(compact(bare))!;
  }

  return null;
}

async function resolveValidEbayAspectReplacement(params: {
  categoryId: string | null | undefined;
  aspectName: string;
  badValue: string;
  siteId?: string;
}): Promise<
  | { action: "replace"; value: string; sampleOptions: string[] }
  | { action: "remove"; sampleOptions: string[] }
  | { action: "unmatched"; sampleOptions: string[] }
> {
  const { categoryId, aspectName, badValue, siteId = "0" } = params;
  const aspectInfo = categoryId
    ? await fetchEbayCategoryAspectOptions(categoryId, aspectName, siteId)
    : null;
  const allowedValues = aspectInfo?.values || [];
  const sampleOptions = allowedValues.slice(0, 12);

  if (allowedValues.length > 0) {
    const matched = pickBestEbayAspectValue(badValue, allowedValues);
    if (matched && matched.toLowerCase() !== badValue.trim().toLowerCase()) {
      return { action: "replace", value: matched, sampleOptions };
    }
    if (aspectInfo && !aspectInfo.required) {
      return { action: "remove", sampleOptions };
    }
    return { action: "unmatched", sampleOptions };
  }

  // Fallback when Taxonomy API didn't return options for this category:
  // strip single trailing width/fit letter from numeric size (e.g. "2M" -> "2", "8.5W" -> "8.5")
  const numFit = badValue.trim().match(/^(\d+(?:\.\d+)?)\s*[mwrdbnlps]$/i);
  if (numFit) {
    return { action: "replace", value: numFit[1], sampleOptions: [] };
  }

  return { action: "unmatched", sampleOptions: [] };
}

/**
 * Reconciles eBay Best Offer Auto-Accept and Minimum Best Offer (auto-decline)
 * thresholds against a target Buy It Now price so eBay NEVER rejects
 * `RelistFixedPriceItem` or `ReviseFixedPriceItem` when the asking price drops.
 *
 * eBay rules:
 * - BestOfferAutoAcceptPrice must be strictly < StartPrice (and >= $0.99)
 * - MinimumBestOfferPrice must be strictly < BestOfferAutoAcceptPrice (if set) AND < StartPrice (and >= $0.99)
 */
function resolveBestOfferPlan(params: {
  targetPrice: number;
  previousPrice?: number | null;
  existingAutoAccept: number | null;
  existingMinOffer: number | null;
  requestedAutoAccept?: number | null; // undefined = preserve/auto-scale, null = clear
  requestedMinOffer?: number | null; // undefined = preserve/auto-scale, null = clear
  currency?: string;
}): BestOfferPlan {
  const {
    targetPrice,
    previousPrice,
    existingAutoAccept,
    existingMinOffer,
    requestedAutoAccept,
    requestedMinOffer,
    currency = "USD",
  } = params;

  const cleanTarget = roundCurrency(targetPrice);
  const stepDown = (ceiling: number): number => {
    const gap = ceiling >= 10 ? 0.5 : ceiling >= 3 ? 0.25 : 0.05;
    return roundCurrency(ceiling - gap);
  };

  let nextAutoAccept: number | null = existingAutoAccept;
  let autoAcceptChanged = false;
  let deleteAutoAccept = false;

  if (requestedAutoAccept === null) {
    nextAutoAccept = null;
    if (existingAutoAccept !== null) {
      deleteAutoAccept = true;
      autoAcceptChanged = true;
    }
  } else if (typeof requestedAutoAccept === "number" && requestedAutoAccept > 0) {
    let val = roundCurrency(requestedAutoAccept);
    if (val >= cleanTarget) {
      val = stepDown(cleanTarget);
    }
    if (val < 0.99) {
      nextAutoAccept = null;
      if (existingAutoAccept !== null) {
        deleteAutoAccept = true;
        autoAcceptChanged = true;
      }
    } else {
      nextAutoAccept = val;
      if (existingAutoAccept === null || Math.abs(val - existingAutoAccept) > 0.005) {
        autoAcceptChanged = true;
      }
    }
  } else if (existingAutoAccept !== null && existingAutoAccept >= cleanTarget - 0.01) {
    // Existing auto-accept would block the new lower price — scale proportionally
    const ratio =
      previousPrice && previousPrice > 0 && existingAutoAccept < previousPrice
        ? existingAutoAccept / previousPrice
        : 0.9;
    let scaled = roundCurrency(cleanTarget * Math.min(0.95, Math.max(0.5, ratio)));
    if (scaled >= cleanTarget) {
      scaled = stepDown(cleanTarget);
    }
    if (scaled < 0.99) {
      nextAutoAccept = null;
      deleteAutoAccept = true;
      autoAcceptChanged = true;
    } else {
      nextAutoAccept = scaled;
      autoAcceptChanged = true;
    }
  }

  const minCeiling = nextAutoAccept !== null ? nextAutoAccept : cleanTarget;
  let nextMinOffer: number | null = existingMinOffer;
  let minOfferChanged = false;
  let deleteMinOffer = false;

  if (requestedMinOffer === null) {
    nextMinOffer = null;
    if (existingMinOffer !== null) {
      deleteMinOffer = true;
      minOfferChanged = true;
    }
  } else if (typeof requestedMinOffer === "number" && requestedMinOffer > 0) {
    let val = roundCurrency(requestedMinOffer);
    if (val >= minCeiling) {
      val = stepDown(minCeiling);
    }
    if (val < 0.99) {
      nextMinOffer = null;
      if (existingMinOffer !== null) {
        deleteMinOffer = true;
        minOfferChanged = true;
      }
    } else {
      nextMinOffer = val;
      if (existingMinOffer === null || Math.abs(val - existingMinOffer) > 0.005) {
        minOfferChanged = true;
      }
    }
  } else if (existingMinOffer !== null && existingMinOffer >= minCeiling - 0.01) {
    // Existing minimum best offer would block the new lower price — scale proportionally
    const ratio =
      previousPrice && previousPrice > 0 && existingMinOffer < previousPrice
        ? existingMinOffer / previousPrice
        : 0.75;
    let scaled = roundCurrency(cleanTarget * Math.min(0.85, Math.max(0.4, ratio)));
    if (scaled >= minCeiling) {
      scaled = stepDown(minCeiling);
    }
    if (scaled < 0.99) {
      nextMinOffer = null;
      deleteMinOffer = true;
      minOfferChanged = true;
    } else {
      nextMinOffer = scaled;
      minOfferChanged = true;
    }
  }

  const autoAcceptToSet =
    autoAcceptChanged && !deleteAutoAccept && nextAutoAccept !== null
      ? nextAutoAccept
      : null;
  const minOfferToSet =
    minOfferChanged && !deleteMinOffer && nextMinOffer !== null
      ? nextMinOffer
      : null;

  const listingDetailLines: string[] = [];
  if (autoAcceptToSet !== null) {
    listingDetailLines.push(
      `      <BestOfferAutoAcceptPrice currencyID="${currency}">${autoAcceptToSet.toFixed(2)}</BestOfferAutoAcceptPrice>`
    );
  }
  if (minOfferToSet !== null) {
    listingDetailLines.push(
      `      <MinimumBestOfferPrice currencyID="${currency}">${minOfferToSet.toFixed(2)}</MinimumBestOfferPrice>`
    );
  }
  const listingDetailsXml =
    listingDetailLines.length > 0
      ? `<ListingDetails>\n${listingDetailLines.join("\n")}\n    </ListingDetails>`
      : "";

  const deletedFieldLines: string[] = [];
  if (deleteAutoAccept) {
    deletedFieldLines.push(
      `<DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>`
    );
  }
  if (deleteMinOffer) {
    deletedFieldLines.push(
      `<DeletedField>Item.ListingDetails.MinimumBestOfferPrice</DeletedField>`
    );
  }
  const deletedFieldsXml = deletedFieldLines.join("\n    ");

  let note: string | null = null;
  if (autoAcceptChanged || minOfferChanged) {
    const parts: string[] = [];
    if (deleteAutoAccept && deleteMinOffer) {
      parts.push("Best Offer auto-rules cleared");
    } else {
      if (autoAcceptToSet !== null) {
        parts.push(`auto-accept $${autoAcceptToSet.toFixed(2)}`);
      } else if (deleteAutoAccept) {
        parts.push("auto-accept cleared");
      }
      if (minOfferToSet !== null) {
        parts.push(`min offer $${minOfferToSet.toFixed(2)}`);
      } else if (deleteMinOffer) {
        parts.push("min offer cleared");
      }
    }
    if (parts.length > 0) {
      note = `Best Offer (${parts.join(", ")})`;
    }
  }

  return {
    autoAcceptToSet,
    minOfferToSet,
    deleteAutoAccept,
    deleteMinOffer,
    listingDetailsXml,
    deletedFieldsXml,
    note,
  };
}

/**
 * Updates an active eBay listing price.
 * Uses Sell Inventory API if managed as an Offer, or Trading API
 * `ReviseFixedPriceItem` for standard Seller Hub / mobile app listings.
 * Automatically reconciles any Best Offer Auto-Accept / Minimum Offer rules
 * that would otherwise block a lower asking price.
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
    const prevPriceVal = Number(
      (existingPricing.price as { value?: string } | undefined)?.value || 0
    );

    const updatedPayload: Record<string, unknown> = {
      ...existingOffer,
      pricingSummary: {
        ...existingPricing,
        price: {
          value: formattedPrice,
          currency,
        },
      },
    };

    // Reconcile Inventory API bestOfferTerms if autoAcceptPrice / autoDeclinePrice conflict
    const policies =
      (existingOffer.listingPolicies as Record<string, unknown> | undefined) ||
      null;
    const bestOfferTerms =
      (policies?.bestOfferTerms as Record<string, unknown> | undefined) || null;
    if (bestOfferTerms) {
      const existingAuto = Number(
        (bestOfferTerms.autoAcceptPrice as { value?: string } | undefined)
          ?.value || 0
      );
      const existingMin = Number(
        (bestOfferTerms.autoDeclinePrice as { value?: string } | undefined)
          ?.value || 0
      );
      const plan = resolveBestOfferPlan({
        targetPrice: Number(formattedPrice),
        previousPrice: prevPriceVal > 0 ? prevPriceVal : null,
        existingAutoAccept: existingAuto > 0 ? existingAuto : null,
        existingMinOffer: existingMin > 0 ? existingMin : null,
        currency,
      });
      if (
        plan.autoAcceptToSet !== null ||
        plan.minOfferToSet !== null ||
        plan.deleteAutoAccept ||
        plan.deleteMinOffer
      ) {
        const nextTerms: Record<string, unknown> = { ...bestOfferTerms };
        if (plan.deleteAutoAccept) delete nextTerms.autoAcceptPrice;
        else if (plan.autoAcceptToSet !== null) {
          nextTerms.autoAcceptPrice = {
            value: plan.autoAcceptToSet.toFixed(2),
            currency,
          };
        }
        if (plan.deleteMinOffer) delete nextTerms.autoDeclinePrice;
        else if (plan.minOfferToSet !== null) {
          nextTerms.autoDeclinePrice = {
            value: plan.minOfferToSet.toFixed(2),
            currency,
          };
        }
        updatedPayload.listingPolicies = {
          ...policies,
          bestOfferTerms: nextTerms,
        };
      }
    }

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
  const existingDetails = await fetchEbayItemDetails(rawId);
  const listingSiteId = existingDetails?.siteId || "0";
  const bestOfferPlan = resolveBestOfferPlan({
    targetPrice: Number(formattedPrice),
    previousPrice: existingDetails?.currentPrice ?? null,
    existingAutoAccept: existingDetails?.bestOfferAutoAcceptPrice ?? null,
    existingMinOffer: existingDetails?.minimumBestOfferPrice ?? null,
    currency,
  });

  const revisePriceWithoutBestOffer = async (): Promise<void> => {
    try {
      await ebayTradingRequest(
        "ReviseFixedPriceItem",
        `<Item>
        <ItemID>${rawId}</ItemID>
        <StartPrice currencyID="${currency}">${formattedPrice}</StartPrice>
        <BestOfferDetails>
          <BestOfferEnabled>false</BestOfferEnabled>
        </BestOfferDetails>
      </Item>`,
        listingSiteId
      );
    } catch (errA) {
      if (!isBestOfferUnavailableError(errA) && !isBestOfferThresholdError(errA)) {
        throw errA;
      }
      await ebayTradingRequest(
        "ReviseFixedPriceItem",
        `<Item>
        <ItemID>${rawId}</ItemID>
        <StartPrice currencyID="${currency}">${formattedPrice}</StartPrice>
      </Item>`,
        listingSiteId
      );
    }
  };

  try {
    await ebayTradingRequest(
      "ReviseFixedPriceItem",
      `<Item>
      <ItemID>${rawId}</ItemID>
      <StartPrice currencyID="${currency}">${formattedPrice}</StartPrice>
      ${bestOfferPlan.listingDetailsXml}
    </Item>
    ${bestOfferPlan.deletedFieldsXml}`,
      listingSiteId
    );
  } catch (err) {
    if (isBestOfferUnavailableError(err)) {
      await revisePriceWithoutBestOffer();
    } else if (isBestOfferThresholdError(err)) {
      try {
        await ebayTradingRequest(
          "ReviseFixedPriceItem",
          `<Item>
          <ItemID>${rawId}</ItemID>
          <StartPrice currencyID="${currency}">${formattedPrice}</StartPrice>
        </Item>
        <DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>
        <DeletedField>Item.ListingDetails.MinimumBestOfferPrice</DeletedField>`,
          listingSiteId
        );
      } catch (retryErr) {
        if (isBestOfferUnavailableError(retryErr)) {
          await revisePriceWithoutBestOffer();
        } else {
          throw retryErr;
        }
      }
    } else {
      throw err;
    }
  }

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
 *   (which mints a brand-new 12-digit ItemID with optional updated StartPrice,
 *   Title, ItemSpecifics, Package Weight/Dims, and reconciled Best Offer thresholds).
 */
export async function endAndSellSimilarEbayOffer(params: {
  offerId: string;
  sku?: string;
  newPrice?: number;
  newTitle?: string;
  weightOz?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  addItemSpecifics?: Array<{ name: string; value: string }>;
  bestOfferAutoAcceptPrice?: number | null;
  minimumBestOfferPrice?: number | null;
}): Promise<{
  previousOfferId: string;
  previousListingId: string | null;
  newOfferId: string;
  newListingId: string;
  newExternalUrl: string;
  bestOfferNote?: string | null;
}> {
  const {
    offerId: rawId,
    sku,
    newPrice,
    newTitle,
    weightOz,
    lengthIn,
    widthIn,
    heightIn,
    addItemSpecifics,
    bestOfferAutoAcceptPrice,
    minimumBestOfferPrice,
  } = params;
  const cleanNewTitle = newTitle?.trim().slice(0, 80) || "";
  const cleanAddSpecs = (addItemSpecifics || []).filter(
    (s) => s.name?.trim() && s.value?.trim()
  );
  const hasPkgOverride =
    (typeof weightOz === "number" && weightOz > 0) ||
    (typeof lengthIn === "number" && lengthIn > 0);
  const hasBestOfferOverride =
    bestOfferAutoAcceptPrice !== undefined ||
    minimumBestOfferPrice !== undefined;
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

    // If title, specifics, or weight changed on Inventory API, update the inventory item first
    if ((cleanNewTitle || cleanAddSpecs.length > 0 || hasPkgOverride) && sku) {
      try {
        const invItem = await ebayRequest<Record<string, unknown>>(
          `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`
        );
        const prod =
          (invItem.product as Record<string, unknown> | undefined) || {};
        const aspects = {
          ...((prod.aspects as Record<string, string[]> | undefined) || {}),
        };
        for (const s of cleanAddSpecs) {
          aspects[s.name.trim()] = [s.value.trim().slice(0, 65)];
        }
        const nextPkg = {
          ...((invItem.packageWeightAndSize as Record<string, unknown> | undefined) ||
            {}),
        };
        if (typeof weightOz === "number" && weightOz > 0) {
          nextPkg.weight = { value: roundCurrency(weightOz), unit: "OUNCE" };
        }
        if (
          typeof lengthIn === "number" &&
          lengthIn > 0 &&
          typeof widthIn === "number" &&
          widthIn > 0 &&
          typeof heightIn === "number" &&
          heightIn > 0
        ) {
          nextPkg.dimensions = {
            length: lengthIn,
            width: widthIn,
            height: heightIn,
            unit: "INCH",
          };
        }
        await ebayRequest(
          `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              ...invItem,
              product: {
                ...prod,
                ...(cleanNewTitle ? { title: cleanNewTitle } : {}),
                ...(cleanAddSpecs.length > 0 ? { aspects } : {}),
              },
              ...(hasPkgOverride ? { packageWeightAndSize: nextPkg } : {}),
            }),
          }
        );
      } catch (err) {
        console.warn("[ebay] Inventory item update warning:", err);
      }
    }

    const clonePayload: Record<string, unknown> = { ...existingOffer };
    delete clonePayload.offerId;
    delete clonePayload.status;
    delete clonePayload.listing;
    delete clonePayload.listingStartDate;

    const existingPricing =
      (clonePayload.pricingSummary as Record<string, unknown> | undefined) ||
      {};
    const prevPriceVal = Number(
      (existingPricing.price as { value?: string } | undefined)?.value || 0
    );
    const effectiveTargetPrice =
      typeof newPrice === "number" && newPrice > 0
        ? roundCurrency(newPrice)
        : prevPriceVal;

    if (typeof newPrice === "number" && newPrice > 0) {
      clonePayload.pricingSummary = {
        ...existingPricing,
        price: {
          value: effectiveTargetPrice.toFixed(2),
          currency: "USD",
        },
      };
    }

    // Reconcile Inventory API Best Offer terms against the new price
    let bestOfferNote: string | null = null;
    const policies =
      (clonePayload.listingPolicies as Record<string, unknown> | undefined) ||
      null;
    const bestOfferTerms =
      (policies?.bestOfferTerms as Record<string, unknown> | undefined) || null;
    if (
      effectiveTargetPrice > 0 &&
      (bestOfferTerms || hasBestOfferOverride)
    ) {
      const existingAuto = Number(
        (bestOfferTerms?.autoAcceptPrice as { value?: string } | undefined)
          ?.value || 0
      );
      const existingMin = Number(
        (bestOfferTerms?.autoDeclinePrice as { value?: string } | undefined)
          ?.value || 0
      );
      const plan = resolveBestOfferPlan({
        targetPrice: effectiveTargetPrice,
        previousPrice: prevPriceVal > 0 ? prevPriceVal : null,
        existingAutoAccept: existingAuto > 0 ? existingAuto : null,
        existingMinOffer: existingMin > 0 ? existingMin : null,
        requestedAutoAccept: bestOfferAutoAcceptPrice,
        requestedMinOffer: minimumBestOfferPrice,
      });
      bestOfferNote = plan.note;
      if (
        plan.autoAcceptToSet !== null ||
        plan.minOfferToSet !== null ||
        plan.deleteAutoAccept ||
        plan.deleteMinOffer
      ) {
        const nextTerms: Record<string, unknown> = {
          bestOfferEnabled: true,
          ...(bestOfferTerms || {}),
        };
        if (plan.deleteAutoAccept) delete nextTerms.autoAcceptPrice;
        else if (plan.autoAcceptToSet !== null) {
          nextTerms.autoAcceptPrice = {
            value: plan.autoAcceptToSet.toFixed(2),
            currency: "USD",
          };
        }
        if (plan.deleteMinOffer) delete nextTerms.autoDeclinePrice;
        else if (plan.minOfferToSet !== null) {
          nextTerms.autoDeclinePrice = {
            value: plan.minOfferToSet.toFixed(2),
            currency: "USD",
          };
        }
        clonePayload.listingPolicies = {
          ...(policies || {}),
          bestOfferTerms: nextTerms,
        };
      }
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
      bestOfferNote,
    };
  }

  // Seller Hub / Trading API path:
  // ALWAYS fetch live GetItem details BEFORE ending the listing whenever price,
  // Best Offer rules, Item Specifics, or Package Details are involved so we:
  // 1) Safely merge ItemSpecifics without wiping existing fields
  // 2) Auto-adjust or clear any Best Offer Auto-Accept / Minimum Best Offer rules
  //    that are >= the new StartPrice (preventing eBay from rejecting the relist!)
  const existingDetails = await fetchEbayItemDetails(rawId);

  let mergedSpecsXml = "";
  let pkgOverrideXml = "";

  if (cleanAddSpecs.length > 0) {
    const mergedMap = new Map<string, { name: string; values: string[] }>();
    for (const [k, vals] of Object.entries(
      existingDetails?.itemSpecifics || {}
    )) {
      if (k.trim() && Array.isArray(vals) && vals.length > 0) {
        mergedMap.set(k.trim().toLowerCase(), { name: k.trim(), values: vals });
      }
    }
    for (const s of cleanAddSpecs) {
      const key = s.name.trim().toLowerCase();
      mergedMap.set(key, {
        name: s.name.trim().slice(0, 40),
        values: [s.value.trim().slice(0, 65)],
      });
    }
    const nvlXml = [...mergedMap.values()]
      .slice(0, 35)
      .map(
        (entry) => `      <NameValueList>
        <Name>${escapeXml(entry.name)}</Name>
        ${entry.values
          .slice(0, 5)
          .map((v) => `<Value>${escapeXml(v.slice(0, 65))}</Value>`)
          .join("\n        ")}
      </NameValueList>`
      )
      .join("\n");
    if (nvlXml) {
      mergedSpecsXml = `<ItemSpecifics>\n${nvlXml}\n    </ItemSpecifics>`;
    }
  }

  if (hasPkgOverride) {
    const finalOz = Math.max(
      1,
      Math.round(weightOz || existingDetails?.weightOz || 12)
    );
    const wMajor = Math.floor(finalOz / 16);
    const wMinor = finalOz % 16;
    const finalLen = Math.max(
      1,
      Math.round(lengthIn || existingDetails?.lengthIn || 10)
    );
    const finalWid = Math.max(
      1,
      Math.round(widthIn || existingDetails?.widthIn || 8)
    );
    const finalHgt = Math.max(
      1,
      Math.round(heightIn || existingDetails?.heightIn || 4)
    );
    pkgOverrideXml = `<ShippingPackageDetails>
      <MeasurementUnit>English</MeasurementUnit>
      <PackageDepth unit="in">${finalHgt}</PackageDepth>
      <PackageLength unit="in">${finalLen}</PackageLength>
      <PackageWidth unit="in">${finalWid}</PackageWidth>
      <WeightMajor unit="lbs">${wMajor}</WeightMajor>
      <WeightMinor unit="oz">${wMinor}</WeightMinor>
    </ShippingPackageDetails>`;
  }

  const effectiveTargetPrice =
    typeof newPrice === "number" && newPrice > 0
      ? roundCurrency(newPrice)
      : existingDetails?.currentPrice ?? 0;

  const bestOfferPlan =
    effectiveTargetPrice > 0
      ? resolveBestOfferPlan({
          targetPrice: effectiveTargetPrice,
          previousPrice: existingDetails?.currentPrice ?? null,
          existingAutoAccept: existingDetails?.bestOfferAutoAcceptPrice ?? null,
          existingMinOffer: existingDetails?.minimumBestOfferPrice ?? null,
          requestedAutoAccept: bestOfferAutoAcceptPrice,
          requestedMinOffer: minimumBestOfferPrice,
        })
      : {
          autoAcceptToSet: null,
          minOfferToSet: null,
          deleteAutoAccept: false,
          deleteMinOffer: false,
          listingDetailsXml: "",
          deletedFieldsXml: "",
          note: null,
        };

  const listingSiteId = existingDetails?.siteId || "0";

  // EndFixedPriceItem -> RelistFixedPriceItem (fresh 12-digit ItemID)
  // Tolerate "already ended" so a previously interrupted relist can recover cleanly!
  try {
    await ebayTradingRequest(
      "EndFixedPriceItem",
      `<ItemID>${rawId}</ItemID>
       <EndingReason>NotAvailable</EndingReason>`,
      listingSiteId
    );
  } catch (endErr) {
    const endMsg = endErr instanceof Error ? endErr.message : String(endErr || "");
    if (
      !/already\s*(been\s*)?(ended|closed)|has\s*(already\s*)?ended|listing\s*is\s*closed|cannot\s*be\s*ended|closed|1047/i.test(
        endMsg
      )
    ) {
      throw endErr;
    }
    console.warn(`[ebay] EndFixedPriceItem(${rawId}) already ended — continuing to Relist:`, endMsg);
  }

  const titleOverrideXml = cleanNewTitle
    ? `<Title>${escapeXml(cleanNewTitle)}</Title>`
    : "";
  const priceOverrideXml =
    typeof newPrice === "number" && newPrice > 0
      ? `<StartPrice currencyID="USD">${roundCurrency(newPrice).toFixed(2)}</StartPrice>`
      : "";

  const buildBaseRelistXml = (specsXml: string) => `
      <ItemID>${rawId}</ItemID>
      ${titleOverrideXml}
      ${priceOverrideXml}
      ${specsXml}
      ${pkgOverrideXml}`;

  let finalBestOfferNote = bestOfferPlan.note;

  // Executes RelistFixedPriceItem with full Best Offer fallback ladder for a given ItemSpecifics XML
  const attemptRelistWithSpecs = async (specsXml: string): Promise<string> => {
    const baseFieldsXml = buildBaseRelistXml(specsXml);

    // Fallback ladder when eBay says Best Offer is unavailable/disabled for the category or listing type:
    // A) Explicitly set BestOfferEnabled=false (overrides inherited BestOfferEnabled=true)
    // B) Set BestOfferEnabled=false AND delete inherited auto-accept / min-offer thresholds
    // C) Bare relist omitting all BestOfferDetails, ListingDetails, and DeletedField tags
    const relistWithoutBestOffer = async (): Promise<string> => {
      try {
        return await ebayTradingRequest(
          "RelistFixedPriceItem",
          `<Item>${baseFieldsXml}
      <BestOfferDetails>
        <BestOfferEnabled>false</BestOfferEnabled>
      </BestOfferDetails>
    </Item>`,
          listingSiteId
        );
      } catch (errA) {
        if (!isBestOfferUnavailableError(errA) && !isBestOfferThresholdError(errA)) {
          throw errA;
        }
        try {
          return await ebayTradingRequest(
            "RelistFixedPriceItem",
            `<Item>${baseFieldsXml}
      <BestOfferDetails>
        <BestOfferEnabled>false</BestOfferEnabled>
      </BestOfferDetails>
    </Item>
    <DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>
    <DeletedField>Item.ListingDetails.MinimumBestOfferPrice</DeletedField>`,
            listingSiteId
          );
        } catch (errB) {
          if (!isBestOfferUnavailableError(errB) && !isBestOfferThresholdError(errB)) {
            throw errB;
          }
          return await ebayTradingRequest(
            "RelistFixedPriceItem",
            `<Item>${baseFieldsXml}
    </Item>`,
            listingSiteId
          );
        }
      }
    };

    try {
      return await ebayTradingRequest(
        "RelistFixedPriceItem",
        `<Item>${baseFieldsXml}
      ${bestOfferPlan.listingDetailsXml}
    </Item>
    ${bestOfferPlan.deletedFieldsXml}`,
        listingSiteId
      );
    } catch (relistErr) {
      if (isBestOfferUnavailableError(relistErr)) {
        console.warn(
          `[ebay] RelistFixedPriceItem(${rawId}) hit Best Offer unavailable for category/listing type — retrying with Best Offer disabled:`,
          relistErr
        );
        finalBestOfferNote =
          "Best Offer disabled (not supported by this eBay category/listing type)";
        return await relistWithoutBestOffer();
      }
      if (isBestOfferThresholdError(relistErr)) {
        // Last-resort failsafe: if eBay still rejects due to Best Offer thresholds,
        // immediately clear BestOfferAutoAcceptPrice & MinimumBestOfferPrice and retry
        // so the ended listing is NEVER left stranded unpublished!
        console.warn(
          `[ebay] RelistFixedPriceItem(${rawId}) hit Best Offer threshold conflict — retrying with cleared Best Offer auto-rules:`,
          relistErr
        );
        try {
          const xml = await ebayTradingRequest(
            "RelistFixedPriceItem",
            `<Item>${baseFieldsXml}
      </Item>
      <DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>
      <DeletedField>Item.ListingDetails.MinimumBestOfferPrice</DeletedField>`,
            listingSiteId
          );
          finalBestOfferNote = "Best Offer auto-rules cleared to allow lower price";
          return xml;
        } catch (retryErr) {
          if (isBestOfferUnavailableError(retryErr)) {
            console.warn(
              `[ebay] RelistFixedPriceItem(${rawId}) retry hit Best Offer unavailable — retrying with Best Offer disabled:`,
              retryErr
            );
            finalBestOfferNote =
              "Best Offer disabled (not supported by this eBay category/listing type)";
            return await relistWithoutBestOffer();
          }
          throw retryErr;
        }
      }
      throw relistErr;
    }
  };

  // Auto-repair up to 3 invalid or incompatible Item Specifics (e.g. `"2M" is not a valid value for Size`,
  // or `"Regular" is not a valid Size Type for the Size "5"`) using eBay's Taxonomy API.
  let relistXml = "";
  let currentSpecsXml = mergedSpecsXml;
  let workingSpecsMap: Map<string, { name: string; values: string[] }> | null = null;
  const repairedAspects = new Set<string>();
  const specAdjustmentNotes: string[] = [];

  for (let pass = 0; pass < 4; pass++) {
    try {
      relistXml = await attemptRelistWithSpecs(currentSpecsXml);
      break;
    } catch (passErr) {
      const pairErr = parseIncompatibleAspectPairError(passErr);
      const singleErr = pairErr ? null : parseInvalidItemSpecificError(passErr);
      const targetAspectName = pairErr
        ? pairErr.targetAspect
        : singleErr?.aspectName || "";
      const badValue = pairErr ? pairErr.badValue : singleErr?.badValue || "";
      const aspectKey = targetAspectName.toLowerCase();

      if ((!pairErr && !singleErr) || pass >= 3 || repairedAspects.has(aspectKey)) {
        throw passErr;
      }
      repairedAspects.add(aspectKey);

      const resolution = pairErr
        ? await resolveCompatibleEbayDependentAspect({
            categoryId: existingDetails?.categoryId,
            targetAspect: pairErr.targetAspect,
            badValue: pairErr.badValue,
            driverAspect: pairErr.driverAspect,
            driverValue: pairErr.driverValue,
            siteId: listingSiteId,
          })
        : await resolveValidEbayAspectReplacement({
            categoryId: existingDetails?.categoryId,
            aspectName: singleErr!.aspectName,
            badValue: singleErr!.badValue,
            siteId: listingSiteId,
          });

      if (resolution.action === "unmatched") {
        if (resolution.sampleOptions.length > 0) {
          throw new Error(
            `${passErr instanceof Error ? passErr.message : String(passErr)} Valid eBay options for ${targetAspectName}: ${resolution.sampleOptions.join(", ")}`
          );
        }
        throw passErr;
      }

      if (!workingSpecsMap) {
        workingSpecsMap = new Map<string, { name: string; values: string[] }>();
        for (const [k, vals] of Object.entries(
          existingDetails?.itemSpecifics || {}
        )) {
          if (k.trim() && Array.isArray(vals) && vals.length > 0) {
            workingSpecsMap.set(k.trim().toLowerCase(), {
              name: k.trim(),
              values: [...vals],
            });
          }
        }
        for (const s of cleanAddSpecs) {
          workingSpecsMap.set(s.name.trim().toLowerCase(), {
            name: s.name.trim().slice(0, 40),
            values: [s.value.trim().slice(0, 65)],
          });
        }
      }

      const existingEntry = workingSpecsMap.get(aspectKey);
      if (resolution.action === "replace") {
        workingSpecsMap.set(aspectKey, {
          name: existingEntry?.name || targetAspectName,
          values: [resolution.value],
        });
        specAdjustmentNotes.push(
          `${targetAspectName} "${badValue}" → "${resolution.value}"`
        );
        console.warn(
          `[ebay] RelistFixedPriceItem(${rawId}) auto-adjusted ${targetAspectName}: "${badValue}" -> "${resolution.value}"`
        );
      } else {
        workingSpecsMap.delete(aspectKey);
        specAdjustmentNotes.push(
          `Removed incompatible optional ${targetAspectName} ("${badValue}")`
        );
        console.warn(
          `[ebay] RelistFixedPriceItem(${rawId}) removed incompatible optional ${targetAspectName}: "${badValue}"`
        );
      }

      currentSpecsXml = buildItemSpecificsXml(workingSpecsMap);
    }
  }

  if (specAdjustmentNotes.length > 0) {
    finalBestOfferNote = [finalBestOfferNote, ...specAdjustmentNotes]
      .filter(Boolean)
      .join(" · ");
  }

  const newListingId = extractXmlTag(relistXml, "ItemID") || rawId;
  return {
    previousOfferId: rawId,
    previousListingId: rawId,
    newOfferId: newListingId,
    newListingId,
    newExternalUrl: `${webBase}/${newListingId}`,
    bestOfferNote: finalBestOfferNote,
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
  buyerCity?: string | null;
  buyerState?: string | null;
  buyerPostal?: string | null;
  buyerCountry?: string | null;
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
  fulfillmentStartInstructions?: Array<{
    shippingStep?: {
      shipTo?: {
        contactAddress?: {
          city?: string;
          stateOrProvince?: string;
          postalCode?: string;
          countryCode?: string;
        };
      };
    };
  }>;
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

      const shipAddr =
        order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo
          ?.contactAddress;
      const buyerCity = shipAddr?.city?.trim() || null;
      const buyerState = shipAddr?.stateOrProvince?.trim() || null;
      const buyerPostal = shipAddr?.postalCode?.trim() || null;
      const buyerCountry = shipAddr?.countryCode?.trim() || null;

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
          buyerCity,
          buyerState,
          buyerPostal,
          buyerCountry,
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

      const shipAddrBlock = extractXmlTag(ob, "ShippingAddress") || "";
      const buyerCity =
        decodeXmlEntities(extractXmlTag(shipAddrBlock, "CityName") || "").trim() ||
        null;
      const buyerState =
        decodeXmlEntities(
          extractXmlTag(shipAddrBlock, "StateOrProvince") || ""
        ).trim() || null;
      const buyerPostal =
        decodeXmlEntities(extractXmlTag(shipAddrBlock, "PostalCode") || "").trim() ||
        null;
      const buyerCountry =
        decodeXmlEntities(extractXmlTag(shipAddrBlock, "Country") || "").trim() ||
        null;

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
          buyerCity,
          buyerState,
          buyerPostal,
          buyerCountry,
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

function escapeXml(raw: string): string {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function detectImageMime(buf: Buffer, fileName: string): string {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return "image/png";
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return "image/gif";
    }
    if (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString("ascii") === "RIFF" &&
      buf.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Uploads a JPEG/PNG/WEBP image binary directly to eBay Picture Services (EPS)
 * via eBay's modern Commerce Media API (`createImageFromFile` on `apim.ebay.com`)
 * using the existing `sell.inventory` OAuth scope, returning the permanent
 * `i.ebayimg.com` HTTPS URL.
 *
 * (Replaces legacy Trading API `UploadSiteHostedPictures`, which eBay
 * decommissioned with HTTP 404 in late 2026.)
 */
export async function uploadEbayHostedPicture(
  imageBuffer: Buffer,
  fileName = "listing-photo.jpg"
): Promise<string> {
  const token = await getEbayAccessToken();
  const { env } = getEbayBaseUrls();
  const mediaBase =
    env === "SANDBOX" ? "https://apim.sandbox.ebay.com" : "https://apim.ebay.com";
  const endpoint = `${mediaBase}/commerce/media/v1_beta/image/create_image_from_file`;

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "photo.jpg";
  const mimeType = detectImageMime(imageBuffer, safeName);

  const attemptUpload = async (fieldName: "image" | "file") => {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(imageBuffer)], { type: mimeType });
    form.append(fieldName, blob, safeName);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: form,
      cache: "no-store",
    });

    const text = await response.text();
    const locationHeader = response.headers.get("location") || "";
    return { response, text, locationHeader };
  };

  let attempt = await attemptUpload("image");
  if (!attempt.response.ok && attempt.response.status === 400) {
    // Fallback in case eBay's multipart parser expects field name "file"
    const fallback = await attemptUpload("file");
    if (fallback.response.ok) {
      attempt = fallback;
    }
  }

  if (!attempt.response.ok) {
    let errDetail = attempt.text.slice(0, 260);
    try {
      const parsed = JSON.parse(attempt.text) as {
        errors?: Array<{ longMessage?: string; message?: string }>;
      };
      const first = parsed.errors?.[0];
      if (first?.longMessage || first?.message) {
        errDetail = first.longMessage || first.message || errDetail;
      }
    } catch {
      // keep raw snippet
    }
    throw new Error(
      `eBay Media API photo upload failed (${attempt.response.status}): ${errDetail}`
    );
  }

  let imageUrl: string | null = null;
  if (attempt.text.trim()) {
    try {
      const parsed = JSON.parse(attempt.text) as { imageUrl?: string };
      if (parsed.imageUrl) imageUrl = parsed.imageUrl;
    } catch {
      // check Location header below
    }
  }

  // Some Media API responses return the getImage URI in the Location header
  if (!imageUrl && attempt.locationHeader) {
    const getRes = await fetch(attempt.locationHeader, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (getRes.ok) {
      const getData = (await getRes.json().catch(() => ({}))) as {
        imageUrl?: string;
      };
      if (getData.imageUrl) imageUrl = getData.imageUrl;
    }
  }

  if (!imageUrl) {
    throw new Error(
      "eBay Media API createImageFromFile succeeded but did not return an imageUrl."
    );
  }

  return upgradeEbayImageUrl(imageUrl) || imageUrl;
}

export interface SuggestedEbayCategory {
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  percentItemFound: number;
}

/**
 * Fetches top real leaf eBay categories for a search query via Trading API
 * `GetSuggestedCategories` (falls back gracefully to empty array if offline).
 */
export async function suggestEbayCategories(
  query: string
): Promise<SuggestedEbayCategory[]> {
  const cleanQuery = query.trim().slice(0, 120);
  if (!cleanQuery || !isEbayConfigured()) return [];

  try {
    const xml = await ebayTradingRequest(
      "GetSuggestedCategories",
      `<Query>${escapeXml(cleanQuery)}</Query>`
    );

    const blocks = extractAllXmlTags(xml, "SuggestedCategory");
    const out: SuggestedEbayCategory[] = [];
    for (const block of blocks.slice(0, 6)) {
      const catBlock = extractXmlTag(block, "Category") || block;
      const categoryId = extractXmlTag(catBlock, "CategoryID");
      const categoryName = extractXmlTag(catBlock, "CategoryName");
      const parents = extractAllXmlTags(catBlock, "CategoryParentName").map((p) =>
        decodeXmlEntities(p)
      );
      const pct = Number(extractXmlTag(block, "PercentItemFound") || 0);
      if (!categoryId || !categoryName) continue;
      out.push({
        categoryId,
        categoryName,
        categoryPath: [...parents, categoryName].join(" > "),
        percentItemFound: pct,
      });
    }
    return out;
  } catch (err) {
    console.warn("[ebay] GetSuggestedCategories warning:", err);
    return [];
  }
}

export type StudioConditionChoice =
  | "new_sealed"
  | "new_opened"
  | "pre_owned"
  | "for_parts";

/**
 * Queries `GetCategoryFeatures` for a leaf eBay category to pick an exact valid
 * `ConditionID` (prevents eBay "ConditionID not valid for this category" errors).
 */
export async function resolveValidEbayCondition(
  categoryId: string,
  desired: StudioConditionChoice
): Promise<{ conditionId: number | null; conditionName: string }> {
  const defaultMap: Record<StudioConditionChoice, { id: number; name: string }> = {
    new_sealed: { id: 1000, name: "New" },
    new_opened: { id: 1500, name: "Open box" },
    pre_owned: { id: 3000, name: "Used" },
    for_parts: { id: 7000, name: "For parts or not working" },
  };
  const fallback = defaultMap[desired] || defaultMap.pre_owned;

  if (!categoryId || !isEbayConfigured()) {
    return { conditionId: fallback.id, conditionName: fallback.name };
  }

  try {
    const xml = await ebayTradingRequest(
      "GetCategoryFeatures",
      `<CategoryID>${escapeXml(categoryId)}</CategoryID>
      <DetailLevel>ReturnAll</DetailLevel>
      <FeatureID>ConditionEnabled</FeatureID>
      <FeatureID>ConditionValues</FeatureID>`
    );

    const enabled = (extractXmlTag(xml, "ConditionEnabled") || "").toLowerCase();
    if (enabled === "disabled") {
      return { conditionId: null, conditionName: "Not applicable" };
    }

    const condBlocks = extractAllXmlTags(xml, "Condition");
    const valid = condBlocks
      .map((b) => ({
        id: Number(extractXmlTag(b, "ID") || 0),
        name: decodeXmlEntities(extractXmlTag(b, "DisplayName") || ""),
      }))
      .filter((c) => c.id > 0);

    if (valid.length === 0) {
      return { conditionId: fallback.id, conditionName: fallback.name };
    }

    const prefIds: Record<StudioConditionChoice, number[]> = {
      new_sealed: [1000, 1500, 1750, 2750, 3000],
      new_opened: [1500, 1750, 1000, 2750, 3000],
      pre_owned: [3000, 4000, 5000, 2500, 2750, 6000, 1500],
      for_parts: [7000, 6000, 5000, 3000],
    };

    for (const candidateId of prefIds[desired] || prefIds.pre_owned) {
      const hit = valid.find((v) => v.id === candidateId);
      if (hit) {
        return { conditionId: hit.id, conditionName: hit.name };
      }
    }

    return { conditionId: valid[0].id, conditionName: valid[0].name };
  } catch (err) {
    console.warn(`[ebay] GetCategoryFeatures(${categoryId}) warning:`, err);
    return { conditionId: fallback.id, conditionName: fallback.name };
  }
}

interface EbaySellerListingDefaults {
  postalCode: string;
  location: string;
  dispatchTimeMax: number;
  useSellerProfiles: boolean;
  paymentProfileId?: string;
  returnProfileId?: string;
  calculatedShippingProfileId?: string;
  freeShippingProfileId?: string;
}

/**
 * Auto-detects the seller's real PostalCode, Location, and eBay Business Policies
 * (if opted in) from an existing live listing + Account API fulfillment policies.
 * Strictly avoids selecting any USPS Priority Mail policy.
 */
async function detectEbaySellerListingDefaults(
  sampleItemId?: string | null
): Promise<EbaySellerListingDefaults> {
  const defaults: EbaySellerListingDefaults = {
    postalCode: process.env.EBAY_POSTAL_CODE?.trim() || "75001",
    location: process.env.EBAY_LOCATION?.trim() || "United States",
    dispatchTimeMax: 2,
    useSellerProfiles: false,
  };

  let targetSampleId = sampleItemId?.trim() || "";
  if (!targetSampleId) {
    try {
      const activeXml = await ebayTradingRequest(
        "GetMyeBaySelling",
        `<ActiveList>
          <Include>true</Include>
          <Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
        </ActiveList>
        <OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>`
      );
      targetSampleId = extractXmlTag(activeXml, "ItemID") || "";
    } catch {
      // ignore
    }
  }

  if (targetSampleId && /^\d+$/.test(targetSampleId)) {
    try {
      const itemXml = await ebayTradingRequest(
        "GetItem",
        `<ItemID>${targetSampleId}</ItemID>
        <OutputSelector>Item.PostalCode</OutputSelector>
        <OutputSelector>Item.Location</OutputSelector>
        <OutputSelector>Item.DispatchTimeMax</OutputSelector>
        <OutputSelector>Item.SellerProfiles</OutputSelector>`
      );
      const postal = extractXmlTag(itemXml, "PostalCode");
      const loc = extractXmlTag(itemXml, "Location");
      const dispatch = Number(extractXmlTag(itemXml, "DispatchTimeMax") || 0);
      if (postal) defaults.postalCode = postal;
      if (loc) defaults.location = loc;
      if (dispatch > 0 && dispatch <= 5) defaults.dispatchTimeMax = dispatch;

      const profilesBlock = extractXmlTag(itemXml, "SellerProfiles");
      if (profilesBlock) {
        const payBlock = extractXmlTag(profilesBlock, "SellerPaymentProfile") || "";
        const retBlock = extractXmlTag(profilesBlock, "SellerReturnProfile") || "";
        const shipBlock = extractXmlTag(profilesBlock, "SellerShippingProfile") || "";
        const payId = extractXmlTag(payBlock, "PaymentProfileID");
        const retId = extractXmlTag(retBlock, "ReturnProfileID");
        const shipId = extractXmlTag(shipBlock, "ShippingProfileID");
        const shipName = (extractXmlTag(shipBlock, "ShippingProfileName") || "").toLowerCase();

        if (payId && retId) {
          defaults.useSellerProfiles = true;
          defaults.paymentProfileId = payId;
          defaults.returnProfileId = retId;
          if (shipId && !shipName.includes("priority")) {
            if (shipName.includes("free")) {
              defaults.freeShippingProfileId = shipId;
            } else {
              defaults.calculatedShippingProfileId = shipId;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[ebay] Sample listing defaults check warning:", err);
    }
  }

  // If business policies are enabled, also check fulfillment policies via Sell Account API
  // so we pick exact Calculated (non-Priority) vs Free Shipping policies cleanly.
  if (defaults.useSellerProfiles) {
    try {
      const polRes = await ebayRequest<{
        fulfillmentPolicies?: Array<{
          fulfillmentPolicyId?: string;
          name?: string;
          shippingOptions?: Array<{
            costType?: string;
            shippingServices?: Array<{
              shippingServiceCode?: string;
              freeShipping?: boolean;
            }>;
          }>;
        }>;
      }>("/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US");

      const policies = polRes.fulfillmentPolicies || [];
      for (const p of policies) {
        const id = p.fulfillmentPolicyId;
        if (!id) continue;
        const nameLower = (p.name || "").toLowerCase();
        const services = (p.shippingOptions || []).flatMap(
          (o) => o.shippingServices || []
        );
        const hasPriority =
          nameLower.includes("priority") ||
          services.some((s) =>
            (s.shippingServiceCode || "").toLowerCase().includes("priority")
          );
        if (hasPriority) continue; // Strictly never pick USPS Priority Mail!

        const isFree =
          nameLower.includes("free") ||
          services.some((s) => Boolean(s.freeShipping));
        const isCalc = (p.shippingOptions || []).some(
          (o) => (o.costType || "").toUpperCase() === "CALCULATED"
        );

        if (isFree && !defaults.freeShippingProfileId) {
          defaults.freeShippingProfileId = id;
        } else if (isCalc && !defaults.calculatedShippingProfileId) {
          defaults.calculatedShippingProfileId = id;
        }
      }
    } catch {
      // Account API scope optional; sample listing profile IDs still work
    }
  }

  return defaults;
}

export interface PublishEbayListingParams {
  sku: string;
  title: string;
  descriptionHtml: string;
  categoryId: string;
  conditionChoice: StudioConditionChoice;
  conditionDescription?: string | null;
  price: number;
  floorPrice?: number | null;
  quantity?: number;
  imageUrls: string[];
  itemSpecifics: Array<{ name: string; value: string }>;
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  freeShipping: boolean;
  sampleExistingEbayItemId?: string | null;
}

/**
 * Publishes a brand-new Fixed Price (Buy It Now, Good 'Til Cancelled) listing
 * directly to eBay Production via Trading API `AddFixedPriceItem`.
 * Default shipping is Buyer Pays Calculated (USPS Ground Advantage + UPS Ground —
 * strictly NO USPS Priority Mail).
 */
export async function publishEbayFixedPriceListing(
  params: PublishEbayListingParams
): Promise<{
  itemId: string;
  listingUrl: string;
  conditionId: number | null;
  conditionName: string;
}> {
  const { webBase } = getEbayBaseUrls();
  const cleanTitle = params.title.trim().slice(0, 80);
  const cleanSku = params.sku.trim().slice(0, 50);
  const priceStr = Math.max(0.99, roundCurrency(params.price)).toFixed(2);
  const qty = Math.max(1, Math.min(999, Math.round(params.quantity || 1)));

  const [resolvedCond, sellerDefaults] = await Promise.all([
    resolveValidEbayCondition(params.categoryId, params.conditionChoice),
    detectEbaySellerListingDefaults(params.sampleExistingEbayItemId),
  ]);

  const totalOz = Math.max(1, Math.round(params.weightOz || 12));
  const weightMajor = Math.floor(totalOz / 16);
  const weightMinor = totalOz % 16;
  const len = Math.max(1, Math.round(params.lengthIn || 10));
  const wid = Math.max(1, Math.round(params.widthIn || 8));
  const hgt = Math.max(1, Math.round(params.heightIn || 4));

  const picXml = params.imageUrls
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 24)
    .map((u) => `      <PictureURL>${escapeXml(u)}</PictureURL>`)
    .join("\n");

  // Deduplicate and sanitize item specifics (eBay rejects empty names/values or >65 chars)
  const seenSpec = new Set<string>();
  const specXml = params.itemSpecifics
    .filter((s) => s.name?.trim() && s.value?.trim())
    .filter((s) => {
      const k = s.name.trim().toLowerCase();
      if (seenSpec.has(k)) return false;
      seenSpec.add(k);
      return true;
    })
    .slice(0, 30)
    .map(
      (s) => `      <NameValueList>
        <Name>${escapeXml(s.name.trim().slice(0, 40))}</Name>
        <Value>${escapeXml(s.value.trim().slice(0, 65))}</Value>
      </NameValueList>`
    )
    .join("\n");

  const condXml =
    resolvedCond.conditionId !== null
      ? `<ConditionID>${resolvedCond.conditionId}</ConditionID>`
      : "";
  const condDescXml =
    params.conditionDescription?.trim() &&
    resolvedCond.conditionId !== null &&
    resolvedCond.conditionId !== 1000
      ? `<ConditionDescription>${escapeXml(params.conditionDescription.trim().slice(0, 1000))}</ConditionDescription>`
      : "";

  const chosenShippingProfileId = params.freeShipping
    ? sellerDefaults.freeShippingProfileId
    : sellerDefaults.calculatedShippingProfileId;

  let policyOrShippingXml = "";
  if (
    sellerDefaults.useSellerProfiles &&
    sellerDefaults.paymentProfileId &&
    sellerDefaults.returnProfileId &&
    chosenShippingProfileId
  ) {
    policyOrShippingXml = `
    <SellerProfiles>
      <SellerPaymentProfile>
        <PaymentProfileID>${escapeXml(sellerDefaults.paymentProfileId)}</PaymentProfileID>
      </SellerPaymentProfile>
      <SellerReturnProfile>
        <ReturnProfileID>${escapeXml(sellerDefaults.returnProfileId)}</ReturnProfileID>
      </SellerReturnProfile>
      <SellerShippingProfile>
        <ShippingProfileID>${escapeXml(chosenShippingProfileId)}</ShippingProfileID>
      </SellerShippingProfile>
    </SellerProfiles>`;
  } else if (params.freeShipping) {
    policyOrShippingXml = `
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
      <RefundOption>MoneyBack</RefundOption>
      <ReturnsWithinOption>Days_30</ReturnsWithinOption>
      <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
    </ReturnPolicy>
    <ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>USPSGroundAdvantage</ShippingService>
        <ShippingServiceCost currencyID="USD">0.00</ShippingServiceCost>
        <ShippingServiceAdditionalCost currencyID="USD">0.00</ShippingServiceAdditionalCost>
        <FreeShipping>true</FreeShipping>
      </ShippingServiceOptions>
    </ShippingDetails>`;
  } else {
    // Default (99% of listings): Buyer Pays Calculated USPS Ground Advantage + UPS Ground (NO USPS Priority Mail!)
    policyOrShippingXml = `
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
      <RefundOption>MoneyBack</RefundOption>
      <ReturnsWithinOption>Days_30</ReturnsWithinOption>
      <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
    </ReturnPolicy>
    <ShippingDetails>
      <ShippingType>Calculated</ShippingType>
      <CalculatedShippingRate>
        <OriginatingPostalCode>${escapeXml(sellerDefaults.postalCode)}</OriginatingPostalCode>
        <PackagingHandlingCosts currencyID="USD">0.00</PackagingHandlingCosts>
      </CalculatedShippingRate>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>USPSGroundAdvantage</ShippingService>
      </ShippingServiceOptions>
      <ShippingServiceOptions>
        <ShippingServicePriority>2</ShippingServicePriority>
        <ShippingService>UPSGround</ShippingService>
      </ShippingServiceOptions>
    </ShippingDetails>`;
  }

  const floorVal = Number(params.floorPrice || 0);
  const bestOfferXml =
    floorVal > 0 && floorVal < Number(priceStr)
      ? `<BestOfferDetails>
      <BestOfferEnabled>true</BestOfferEnabled>
    </BestOfferDetails>
    <ListingDetails>
      <MinimumBestOfferPrice currencyID="USD">${roundCurrency(floorVal).toFixed(2)}</MinimumBestOfferPrice>
    </ListingDetails>`
      : `<BestOfferDetails>
      <BestOfferEnabled>true</BestOfferEnabled>
    </BestOfferDetails>`;

  const safeDescHtml = (params.descriptionHtml || "").replace(/\]\]>/g, "]]&gt;");

  const innerXml = `<Item>
    <Title>${escapeXml(cleanTitle)}</Title>
    <SKU>${escapeXml(cleanSku)}</SKU>
    <Description><![CDATA[${safeDescHtml}]]></Description>
    <PrimaryCategory>
      <CategoryID>${escapeXml(params.categoryId)}</CategoryID>
    </PrimaryCategory>
    <StartPrice currencyID="USD">${priceStr}</StartPrice>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <Country>US</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>${sellerDefaults.dispatchTimeMax}</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${escapeXml(sellerDefaults.location)}</Location>
    <PostalCode>${escapeXml(sellerDefaults.postalCode)}</PostalCode>
    <Quantity>${qty}</Quantity>
    ${condXml}
    ${condDescXml}
    ${bestOfferXml}
    <PictureDetails>
${picXml}
    </PictureDetails>
    ${specXml ? `<ItemSpecifics>\n${specXml}\n    </ItemSpecifics>` : ""}
    <ShippingPackageDetails>
      <MeasurementUnit>English</MeasurementUnit>
      <PackageDepth unit="in">${hgt}</PackageDepth>
      <PackageLength unit="in">${len}</PackageLength>
      <PackageWidth unit="in">${wid}</PackageWidth>
      <ShippingPackage>PackageThickEnvelope</ShippingPackage>
      <WeightMajor unit="lbs">${weightMajor}</WeightMajor>
      <WeightMinor unit="oz">${weightMinor}</WeightMinor>
    </ShippingPackageDetails>
    ${policyOrShippingXml}
  </Item>`;

  let resXml: string;
  try {
    resXml = await ebayTradingRequest("AddFixedPriceItem", innerXml);
  } catch (addErr) {
    if (isBestOfferUnavailableError(addErr) && bestOfferXml) {
      console.warn(
        `[ebay] AddFixedPriceItem(${cleanSku}) hit Best Offer unavailable for category ${params.categoryId} — retrying without Best Offer:`,
        addErr
      );
      resXml = await ebayTradingRequest(
        "AddFixedPriceItem",
        innerXml.replace(bestOfferXml, "")
      );
    } else {
      throw addErr;
    }
  }
  const newItemId = extractXmlTag(resXml, "ItemID");
  if (!newItemId) {
    throw new Error("eBay AddFixedPriceItem succeeded but did not return an ItemID.");
  }

  return {
    itemId: newItemId,
    listingUrl: `${webBase}/${newItemId}`,
    conditionId: resolvedCond.conditionId,
    conditionName: resolvedCond.conditionName,
  };
}


