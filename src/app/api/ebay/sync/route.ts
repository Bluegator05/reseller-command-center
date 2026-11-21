import { NextResponse } from "next/server";
import { simulateDemoEbaySync } from "@/lib/demo-store";
import { fetchActiveEbayOffers, isEbayConfigured } from "@/lib/ebay";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { EbaySyncResponse } from "@/lib/types";

/**
 * POST /api/ebay/sync
 * Pulls active eBay offers into Supabase `inventory_items` and `marketplace_listings`.
 * When live eBay/Supabase credentials are not configured yet, runs against the interactive demo store.
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
    const offers = await fetchActiveEbayOffers(200);
    const syncedAt = new Date().toISOString();
    let createdCount = 0;
    let updatedCount = 0;

    for (const offer of offers) {
      const { data: existingItem, error: lookupError } = await supabase!
        .from("inventory_items")
        .select("id, cogs, target_price, floor_price")
        .eq("sku", offer.sku)
        .maybeSingle();

      if (lookupError) {
        throw lookupError;
      }

      let itemId: string;

      if (existingItem) {
        itemId = existingItem.id;
        updatedCount += 1;

        const { error: updateItemError } = await supabase!
          .from("inventory_items")
          .update({
            title: offer.title,
            description_html: offer.descriptionHtml || null,
            description_plain: offer.descriptionPlain || null,
            condition: offer.condition,
            brand: offer.brand,
            category_hint: offer.categoryHint,
            weight_oz: offer.weightOz,
            item_specifics: offer.itemSpecifics,
            image_urls: offer.imageUrls,
            status: "active",
            updated_at: syncedAt,
          })
          .eq("id", itemId);

        if (updateItemError) throw updateItemError;
      } else {
        createdCount += 1;
        const defaultFloor = roundCurrency(offer.listedPrice * 0.7);

        const { data: insertedItem, error: insertItemError } = await supabase!
          .from("inventory_items")
          .insert({
            sku: offer.sku,
            title: offer.title,
            description_html: offer.descriptionHtml || null,
            description_plain: offer.descriptionPlain || null,
            condition: offer.condition,
            brand: offer.brand,
            category_hint: offer.categoryHint,
            cogs: 0,
            target_price: offer.listedPrice,
            floor_price: defaultFloor,
            weight_oz: offer.weightOz,
            item_specifics: offer.itemSpecifics,
            image_urls: offer.imageUrls,
            status: "active",
            acquired_at: offer.listedAt,
            updated_at: syncedAt,
          })
          .select("id")
          .single();

        if (insertItemError || !insertedItem) {
          throw insertItemError || new Error(`Failed to insert SKU ${offer.sku}`);
        }
        itemId = insertedItem.id;
      }

      const { error: upsertListingError } = await supabase!
        .from("marketplace_listings")
        .upsert(
          {
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
            listed_at: offer.listedAt,
            last_synced_at: syncedAt,
          },
          { onConflict: "item_id,marketplace" }
        );

      if (upsertListingError) throw upsertListingError;
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
      createdCount,
      updatedCount,
      syncedAt,
      message: `Live eBay sync complete: ${createdCount} created, ${updatedCount} updated.`,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "eBay sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
