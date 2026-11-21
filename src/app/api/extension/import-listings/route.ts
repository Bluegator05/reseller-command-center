import { NextResponse } from "next/server";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { MarketplaceType } from "@/lib/types";

export const maxDuration = 60;

interface ScannedListingInput {
  externalListingId?: string | null;
  externalUrl?: string | null;
  title: string;
  price?: number;
  sku?: string | null;
}

interface ImportListingsBody {
  // Mode A: Direct 1-item link (from CrossListDrawer or Extension review confirm)
  itemId?: string;
  marketplace: Exclude<MarketplaceType, "ebay">;
  externalUrl?: string | null;
  externalListingId?: string | null;
  listedPrice?: number;
  // Mode B: Bulk scan from Poshmark Closet / Mercari Active Listings / FB Selling page
  listings?: ScannedListingInput[];
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "new",
  "nwt",
  "nwot",
  "euc",
  "guc",
  "vguc",
  "size",
  "sz",
  "mens",
  "men",
  "womens",
  "women",
  "unisex",
  "vintage",
  "vtg",
  "lot",
  "of",
  "in",
  "on",
  "to",
  "by",
  "a",
  "an",
]);

function tokenizeTitle(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreTitleMatch(
  scannedTitle: string,
  invTitle: string,
  invBrand: string | null
): number {
  const aTokens = tokenizeTitle(scannedTitle);
  const bTokens = tokenizeTitle(invTitle);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection += 1;
  }
  if (intersection === 0) return 0;

  // Dice similarity + containment bonus (Poshmark titles are often shorter subsets of eBay titles)
  const dice = (2 * intersection) / (setA.size + setB.size);
  const containment = intersection / Math.min(setA.size, setB.size);
  let score = dice * 0.65 + containment * 0.35;

  if (
    invBrand &&
    invBrand.trim().length >= 2 &&
    scannedTitle.toLowerCase().includes(invBrand.trim().toLowerCase())
  ) {
    score = Math.min(1, score + 0.08);
  }

  return Math.round(score * 100) / 100;
}

function extractIdFromUrl(
  marketplace: string,
  url: string | null | undefined
): string | null {
  if (!url) return null;
  if (marketplace === "poshmark") {
    const m = url.match(/([0-9a-f]{24})(?:[/?#]|$)/i);
    if (m) return m[1];
  }
  if (marketplace === "mercari") {
    const m = url.match(/\/item\/(m\d+)/i);
    if (m) return m[1];
  }
  if (marketplace === "facebook") {
    const m = url.match(/\/item\/(\d+)/i);
    if (m) return m[1];
  }
  return url.split("/").filter(Boolean).at(-1)?.slice(0, 64) || null;
}

/**
 * POST /api/extension/import-listings
 * Links already-cross-listed Poshmark, Mercari, or Facebook Marketplace listings
 * into Supabase `marketplace_listings` — either via bulk page scan matching or
 * direct 1-item URL linking.
 */
export async function POST(request: Request) {
  let body: ImportListingsBody;
  try {
    body = (await request.json()) as ImportListingsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const marketplace = body.marketplace;
  if (!["poshmark", "mercari", "facebook", "etsy"].includes(marketplace)) {
    return NextResponse.json(
      { error: "Unsupported marketplace" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  if (!supabase || !isSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Supabase must be connected to import existing listings" },
      { status: 400 }
    );
  }

  const nowIso = new Date().toISOString();

  // Mode A: Direct 1-item link
  if (body.itemId) {
    const extId =
      body.externalListingId?.trim() ||
      extractIdFromUrl(marketplace, body.externalUrl) ||
      `${marketplace}-${Date.now()}`;
    const price = Number(body.listedPrice) || 0;

    const { error } = await supabase.from("marketplace_listings").upsert(
      {
        item_id: body.itemId,
        marketplace,
        external_listing_id: extId,
        external_url: body.externalUrl?.trim() || null,
        listed_price: price > 0 ? price : 0,
        shipping_price: 0,
        status: "active",
        listed_at: nowIso,
        last_synced_at: nowIso,
      },
      { onConflict: "item_id,marketplace" }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Clear any stale pending create jobs for this already-listed item+marketplace
    await supabase
      .from("channel_jobs")
      .delete()
      .eq("item_id", body.itemId)
      .eq("marketplace", marketplace)
      .eq("action", "create")
      .in("status", ["pending", "processing", "needs_user_confirm"]);

    return NextResponse.json({
      mode: "direct_link",
      linked: true,
      itemId: body.itemId,
      marketplace,
      externalListingId: extId,
    });
  }

  // Mode B: Bulk scan matching from Mac Mini Chrome Extension
  const scanned = Array.isArray(body.listings) ? body.listings : [];
  if (scanned.length === 0) {
    return NextResponse.json(
      { error: "No active listings were found on the current page." },
      { status: 400 }
    );
  }

  // Load all active/draft inventory items (paginated past 1,000-row cap)
  const inventory: Array<{
    id: string;
    sku: string;
    title: string;
    brand: string | null;
    target_price: number;
  }> = [];

  for (let from = 0; from < 5000; from += 1000) {
    const { data: page, error } = await supabase
      .from("inventory_items")
      .select("id, sku, title, brand, target_price")
      .in("status", ["active", "draft"])
      .range(from, from + 999);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const rows = (page ?? []) as typeof inventory;
    inventory.push(...rows);
    if (rows.length < 1000) break;
  }

  const autoLinkedRows: Array<Record<string, unknown>> = [];
  const autoLinkedSummary: Array<{
    sku: string;
    title: string;
    confidence: number;
    price: number;
  }> = [];
  const reviewMatches: Array<{
    scannedTitle: string;
    scannedPrice: number;
    externalUrl: string | null;
    externalListingId: string | null;
    candidateItemId: string;
    candidateSku: string;
    candidateTitle: string;
    confidence: number;
  }> = [];
  let unmatchedCount = 0;

  const usedItemIds = new Set<string>();

  for (const item of scanned) {
    const cleanTitle = (item.title || "").trim();
    if (!cleanTitle) continue;

    const extId =
      item.externalListingId?.trim() ||
      extractIdFromUrl(marketplace, item.externalUrl) ||
      `${marketplace}-${Math.random().toString(36).slice(2, 10)}`;

    // 1. Check exact SKU match first
    let bestInv: (typeof inventory)[number] | null = null;
    let bestScore = 0;

    const scannedSkuLower = (item.sku || "").trim().toLowerCase();
    const titleLower = cleanTitle.toLowerCase();

    for (const inv of inventory) {
      if (usedItemIds.has(inv.id)) continue;
      const invSkuLower = inv.sku.trim().toLowerCase();
      if (
        (scannedSkuLower && scannedSkuLower === invSkuLower) ||
        (invSkuLower.length >= 6 &&
          !invSkuLower.startsWith("ebay-") &&
          titleLower.includes(invSkuLower))
      ) {
        bestInv = inv;
        bestScore = 1.0;
        break;
      }

      const score = scoreTitleMatch(cleanTitle, inv.title, inv.brand);
      if (score > bestScore) {
        bestScore = score;
        bestInv = inv;
      }
    }

    const price = Number(item.price) || Number(bestInv?.target_price ?? 0) || 0;

    if (bestInv && bestScore >= 0.65) {
      usedItemIds.add(bestInv.id);
      autoLinkedRows.push({
        item_id: bestInv.id,
        marketplace,
        external_listing_id: extId,
        external_url: item.externalUrl?.trim() || null,
        listed_price: price,
        shipping_price: 0,
        status: "active",
        listed_at: nowIso,
        last_synced_at: nowIso,
      });
      autoLinkedSummary.push({
        sku: bestInv.sku,
        title: bestInv.title,
        confidence: bestScore,
        price,
      });
    } else if (bestInv && bestScore >= 0.38) {
      reviewMatches.push({
        scannedTitle: cleanTitle,
        scannedPrice: price,
        externalUrl: item.externalUrl?.trim() || null,
        externalListingId: extId,
        candidateItemId: bestInv.id,
        candidateSku: bestInv.sku,
        candidateTitle: bestInv.title,
        confidence: bestScore,
      });
    } else {
      unmatchedCount += 1;
    }
  }

  // Batch upsert all high-confidence matches into marketplace_listings
  for (let i = 0; i < autoLinkedRows.length; i += 100) {
    const chunk = autoLinkedRows.slice(i, i + 100);
    const { error: upsertErr } = await supabase
      .from("marketplace_listings")
      .upsert(chunk, { onConflict: "item_id,marketplace" });
    if (upsertErr) {
      return NextResponse.json({ error: upsertErr.message }, { status: 500 });
    }
  }

  // Clear any pending create jobs for items we just confirmed are already listed
  const linkedItemIds = Array.from(usedItemIds);
  for (let i = 0; i < linkedItemIds.length; i += 100) {
    const idChunk = linkedItemIds.slice(i, i + 100);
    await supabase
      .from("channel_jobs")
      .delete()
      .in("item_id", idChunk)
      .eq("marketplace", marketplace)
      .eq("action", "create")
      .in("status", ["pending", "processing", "needs_user_confirm"]);
  }

  return NextResponse.json({
    mode: "bulk_scan",
    marketplace,
    scannedCount: scanned.length,
    matchedCount: autoLinkedRows.length,
    reviewMatches: reviewMatches.slice(0, 30),
    unmatchedCount,
    autoLinked: autoLinkedSummary.slice(0, 20),
  });
}

/**
 * DELETE /api/extension/import-listings?itemId=<uuid>&marketplace=<channel>
 * Unlinks a non-eBay marketplace_listings record (e.g., after a manual delist or accidental link).
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get("itemId")?.trim();
  const marketplace = searchParams.get("marketplace")?.trim();

  if (!itemId || !marketplace || marketplace === "ebay") {
    return NextResponse.json(
      { error: "Provide valid itemId and non-eBay marketplace" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  if (!supabase || !isSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Supabase must be connected" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("marketplace_listings")
    .delete()
    .eq("item_id", itemId)
    .eq("marketplace", marketplace);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ unlinked: true, itemId, marketplace });
}
