import { NextResponse } from "next/server";
import { simulateDemoEbaySync } from "@/lib/demo-store";
import {
  fetchActiveEbayOffers,
  fetchActivePromotedRates,
  isEbayConfigured,
  type NormalizedEbayOffer,
} from "@/lib/ebay";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { EbaySyncResponse } from "@/lib/types";

export const maxDuration = 60;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * POST /api/ebay/sync
 * Pulls ALL active eBay listings (up to 2,000 via paginated Trading API + Sell
 * Inventory API) into Supabase `inventory_items` and `marketplace_listings`
 * using batched inserts/upserts so 500–2,000 listings complete in a few seconds.
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  const canRunLive = Boolean(
    supabase && isSupabaseConfigured() && isEbayConfigured()
  );

  if (!canRunLive) {
    const demoResult = simulateDemoEbaySync();
    const response: EbaySyncResponse = {
      mode: "demo",
      syncedCount: demoResult.syncedCount,
      createdCount: demoResult.createdCount,
      updatedCount: demoResult.updatedCount,
      syncedAt: demoResult.syncedAt,
      message:
        demoResult.createdCount > 0
          ? `Demo sync complete: imported ${demoResult.createdCount} new eBay SKU and refreshed ${demoResult.updatedCount} active listings.`
          : `Demo sync complete: refreshed ${demoResult.syncedCount} active eBay listings (connect Supabase + eBay keys in .env.local for live sync).`,
    };
    return NextResponse.json(response);
  }

  try {
    const [offers, promotedRates] = await Promise.all([
      fetchActiveEbayOffers(2000),
      fetchActivePromotedRates(),
    ]);
    const syncedAt = new Date().toISOString();

    // 1. Fetch existing inventory item IDs by SKU in chunks of 200
    const skuToExisting = new Map<
      string,
      { id: string; imageCount: number }
    >();
    const allSkus = offers.map((o) => o.sku);
    for (const skuChunk of chunkArray(allSkus, 200)) {
      const { data: existingRows, error: lookupError } = await supabase!
        .from("inventory_items")
        .select("id, sku, image_urls")
        .in("sku", skuChunk);
      if (lookupError) throw lookupError;
      for (const row of existingRows ?? []) {
        const imgs = Array.isArray(row.image_urls) ? row.image_urls : [];
        skuToExisting.set(row.sku as string, {
          id: row.id as string,
          imageCount: imgs.length,
        });
      }
    }

    const skuToId = new Map<string, string>();
    for (const [sku, meta] of skuToExisting.entries()) {
      skuToId.set(sku, meta.id);
    }

    const newOffers: NormalizedEbayOffer[] = [];
    const existingOffers: Array<{
      id: string;
      existingImageCount: number;
      offer: NormalizedEbayOffer;
    }> = [];

    for (const offer of offers) {
      const existing = skuToExisting.get(offer.sku);
      if (existing) {
        existingOffers.push({
          id: existing.id,
          existingImageCount: existing.imageCount,
          offer,
        });
      } else {
        newOffers.push(offer);
      }
    }

    // 2. Batch-insert brand-new SKUs in chunks of 100
    for (const batch of chunkArray(newOffers, 100)) {
      const rows = batch.map((offer) => ({
        sku: offer.sku,
        title: offer.title,
        description_html: offer.descriptionHtml || null,
        description_plain: offer.descriptionPlain || null,
        condition: offer.condition,
        brand: offer.brand,
        category_hint: offer.categoryHint,
        cogs: 0,
        target_price: offer.listedPrice,
        floor_price: roundCurrency(offer.listedPrice * 0.7),
        weight_oz: offer.weightOz,
        item_specifics: offer.itemSpecifics,
        image_urls: offer.imageUrls,
        status: "active",
        acquired_at: offer.listedAt,
        updated_at: syncedAt,
      }));

      const { data: inserted, error: insertErr } = await supabase!
        .from("inventory_items")
        .insert(rows)
        .select("id, sku");
      if (insertErr) throw insertErr;
      for (const row of inserted ?? []) {
        skuToId.set(row.sku as string, row.id as string);
      }
    }

    // 3. Update existing SKUs in parallel chunks of 20 (preserving user COGS/bins/notes/floor & enriched full photo galleries)
    for (const batch of chunkArray(existingOffers, 20)) {
      await Promise.all(
        batch.map(async ({ id, existingImageCount, offer }) => {
          const patch: Record<string, unknown> = {
            title: offer.title,
            condition: offer.condition,
            category_hint: offer.categoryHint,
            status: "active",
            updated_at: syncedAt,
          };
          if (offer.imageUrls.length >= existingImageCount && offer.imageUrls.length > 0) {
            patch.image_urls = offer.imageUrls;
          }
          if (offer.descriptionHtml) patch.description_html = offer.descriptionHtml;
          if (offer.descriptionPlain) patch.description_plain = offer.descriptionPlain;
          if (offer.brand) patch.brand = offer.brand;
          if (offer.weightOz !== null) patch.weight_oz = offer.weightOz;
          if (Object.keys(offer.itemSpecifics).length > 0) {
            patch.item_specifics = offer.itemSpecifics;
          }

          const { error: updErr } = await supabase!
            .from("inventory_items")
            .update(patch)
            .eq("id", id);
          if (updErr) throw updErr;
        })
      );
    }

    // 4. Batch-upsert marketplace_listings in chunks of 100
    const listingRows = offers
      .map((offer) => {
        const itemId = skuToId.get(offer.sku);
        if (!itemId) return null;
        return {
          item_id: itemId,
          marketplace: "ebay",
          external_listing_id: offer.externalListingId,
          external_url: offer.externalUrl,
          listed_price: offer.listedPrice,
          shipping_price: offer.shippingPrice,
          status: "active",
          views_count: offer.viewsCount,
          watchers_count: offer.watchersCount,
          impressions_count: offer.impressionsCount,
          promoted_ad_rate_pct:
            (offer.externalListingId
              ? promotedRates.get(offer.externalListingId)
              : 0) ?? 0,
          listed_at: offer.listedAt,
          last_synced_at: syncedAt,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (const batch of chunkArray(listingRows, 100)) {
      const { error: upsertErr } = await supabase!
        .from("marketplace_listings")
        .upsert(batch, { onConflict: "item_id,marketplace" });
      if (upsertErr) throw upsertErr;
    }

    await supabase!.from("marketplace_accounts").upsert(
      {
        marketplace: "ebay",
        is_api_connected: true,
        default_fee_pct: 13.25,
        price_markup_pct: 0,
        updated_at: syncedAt,
      },
      { onConflict: "marketplace" }
    );

    const response: EbaySyncResponse = {
      mode: "live",
      syncedCount: offers.length,
      createdCount: newOffers.length,
      updatedCount: existingOffers.length,
      syncedAt,
      message: `Live eBay sync complete: ${offers.length} total listings (${newOffers.length} new, ${existingOffers.length} updated).`,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "eBay sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
