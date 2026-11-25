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
  imageUrl?: string | null;
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
  // Mode C: Import unmatched standalone marketplace listings as new inventory items (e.g. FB Local Only)
  action?: "import_standalone";
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

  // Mode C: Import unmatched standalone listings (e.g. Facebook-Local-Only items not on eBay)
  if (body.action === "import_standalone") {
    const incoming = Array.isArray(body.listings) ? body.listings : [];
    if (incoming.length === 0) {
      return NextResponse.json(
        { error: "Provide at least one listing to import." },
        { status: 400 }
      );
    }

    // Load existing listings on this marketplace to avoid duplicates
    const { data: existingMktRows } = await supabase
      .from("marketplace_listings")
      .select("external_listing_id, item_id, inventory_items(title)")
      .eq("marketplace", marketplace)
      .in("status", ["active", "draft"]);

    const existingExtIds = new Set<string>();
    const existingTitleKeys = new Set<string>();
    for (const r of existingMktRows ?? []) {
      const rec = r as {
        external_listing_id?: string | null;
        inventory_items?:
          | { title?: string | null }
          | Array<{ title?: string | null }>
          | null;
      };
      if (rec.external_listing_id) {
        existingExtIds.add(rec.external_listing_id.trim());
      }
      const inv = Array.isArray(rec.inventory_items)
        ? rec.inventory_items[0]
        : rec.inventory_items;
      if (inv?.title) {
        existingTitleKeys.add(
          inv.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
        );
      }
    }

    const imported: Array<{ id: string; sku: string; title: string; price: number }> = [];
    let skippedCount = 0;

    for (const raw of incoming) {
      const cleanTitle = (raw.title || "").trim();
      if (cleanTitle.length < 3) continue;

      const extId =
        raw.externalListingId?.trim() ||
        extractIdFromUrl(marketplace, raw.externalUrl) ||
        `${marketplace}-${Math.random().toString(36).slice(2, 10)}`;
      const titleKey = cleanTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

      if (existingExtIds.has(extId) || existingTitleKeys.has(titleKey)) {
        skippedCount += 1;
        continue;
      }

      const price = Math.max(0, Number(raw.price) || 0);
      const floorPrice =
        price > 0 ? Math.max(1, Math.round(price * 0.7)) : 0;
      const skuPrefix = marketplace === "facebook" ? "FB" : marketplace.slice(0, 3).toUpperCase();
      const shortToken =
        extId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase() ||
        Math.random().toString(36).slice(2, 8).toUpperCase();
      const sku = `${skuPrefix}-${shortToken}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const imageUrl =
        typeof raw.imageUrl === "string" && raw.imageUrl.trim().startsWith("http")
          ? raw.imageUrl.trim()
          : null;

      const isFb = marketplace === "facebook";
      const { data: created, error: insErr } = await supabase
        .from("inventory_items")
        .insert({
          sku,
          title: cleanTitle,
          condition: "Used",
          cogs: 0,
          prep_cost: 0,
          target_price: price,
          floor_price: floorPrice,
          image_urls: imageUrl ? [imageUrl] : [],
          source_type: "thrift",
          tax_category: "inventory_cogs",
          status: "active",
          acquired_at: nowIso,
          updated_at: nowIso,
          item_specifics: isFb
            ? {
                fb_local_only: "true",
                fulfillment_type: "local_pickup",
                imported_from: "facebook",
              }
            : { imported_from: marketplace },
        })
        .select("id, sku, title")
        .single();

      if (insErr || !created) {
        continue;
      }

      await supabase.from("marketplace_listings").upsert(
        {
          item_id: created.id,
          marketplace,
          external_listing_id: extId,
          external_url: raw.externalUrl?.trim() || null,
          listed_price: price,
          shipping_price: 0,
          status: "active",
          listed_at: nowIso,
          last_synced_at: nowIso,
        },
        { onConflict: "item_id,marketplace" }
      );

      existingExtIds.add(extId);
      existingTitleKeys.add(titleKey);
      imported.push({
        id: created.id as string,
        sku: created.sku as string,
        title: created.title as string,
        price,
      });
    }

    return NextResponse.json({
      mode: "import_standalone",
      marketplace,
      importedCount: imported.length,
      skippedCount,
      imported,
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

  // Also check existing listings already linked on this marketplace by external_listing_id
  const { data: existingChannelRows } = await supabase
    .from("marketplace_listings")
    .select("item_id, external_listing_id")
    .eq("marketplace", marketplace)
    .in("status", ["active", "draft"]);

  const existingByExtId = new Map<string, string>();
  for (const r of existingChannelRows ?? []) {
    const rec = r as { item_id: string; external_listing_id?: string | null };
    if (rec.external_listing_id) {
      existingByExtId.set(rec.external_listing_id.trim(), rec.item_id);
    }
  }
  const invById = new Map(inventory.map((i) => [i.id, i]));

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
    imageUrl: string | null;
    candidateItemId: string;
    candidateSku: string;
    candidateTitle: string;
    confidence: number;
  }> = [];
  const unmatchedListings: Array<{
    title: string;
    price: number;
    externalUrl: string | null;
    externalListingId: string;
    imageUrl: string | null;
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
    const imageUrl =
      typeof item.imageUrl === "string" && item.imageUrl.trim().startsWith("http")
        ? item.imageUrl.trim()
        : null;

    // 0. Check if already linked by exact external_listing_id
    let bestInv: (typeof inventory)[number] | null = null;
    let bestScore = 0;

    const preLinkedItemId = existingByExtId.get(extId);
    if (preLinkedItemId && !usedItemIds.has(preLinkedItemId)) {
      const found = invById.get(preLinkedItemId);
      if (found) {
        bestInv = found;
        bestScore = 1.0;
      }
    }

    // 1. Check exact SKU match or fuzzy title similarity
    const scannedSkuLower = (item.sku || "").trim().toLowerCase();
    const titleLower = cleanTitle.toLowerCase();

    if (!bestInv) {
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
        imageUrl,
        candidateItemId: bestInv.id,
        candidateSku: bestInv.sku,
        candidateTitle: bestInv.title,
        confidence: bestScore,
      });
    } else {
      unmatchedCount += 1;
      if (unmatchedListings.length < 50) {
        unmatchedListings.push({
          title: cleanTitle,
          price,
          externalUrl: item.externalUrl?.trim() || null,
          externalListingId: extId,
          imageUrl,
        });
      }
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
    unmatchedListings,
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
