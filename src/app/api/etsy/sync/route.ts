import { NextResponse } from "next/server";
import { simulateDemoEtsySync } from "@/lib/demo-store";
import { fetchActiveEtsyListings, isEtsyConfigured } from "@/lib/etsy";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { EtsySyncResponse } from "@/lib/types";

/**
 * POST /api/etsy/sync
 * Syncs active Etsy Open API v3 shop listings into `marketplace_listings`
 * matched against `inventory_items.sku`.
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  const canRunLive = Boolean(
    supabase && isSupabaseConfigured() && isEtsyConfigured()
  );

  if (!canRunLive) {
    const demo = simulateDemoEtsySync();
    const res: EtsySyncResponse = {
      mode: "demo",
      syncedCount: demo.syncedCount,
      matchedCount: demo.syncedCount,
      syncedAt: demo.syncedAt,
      message: `Demo Etsy sync complete: refreshed ${demo.syncedCount} cross-listed Etsy SKU${demo.syncedCount === 1 ? "" : "s"} (views & favorites updated).`,
    };
    return NextResponse.json(res);
  }

  try {
    const etsyListings = await fetchActiveEtsyListings(100);
    const syncedAt = new Date().toISOString();
    let matchedCount = 0;

    for (const listing of etsyListings) {
      if (!listing.sku) continue;

      const { data: inv } = await supabase!
        .from("inventory_items")
        .select("id")
        .eq("sku", listing.sku)
        .maybeSingle();

      if (!inv) continue;
      matchedCount += 1;

      await supabase!.from("marketplace_listings").upsert(
        {
          item_id: inv.id,
          marketplace: "etsy",
          external_listing_id: listing.listingId,
          external_url: listing.url,
          listed_price: listing.price,
          shipping_price: 0,
          status: "active",
          views_count: listing.views,
          watchers_count: listing.numFavorers,
          impressions_count: listing.views * 8,
          listed_at: new Date(listing.createdTimestamp * 1000).toISOString(),
          last_synced_at: syncedAt,
        },
        { onConflict: "item_id,marketplace" }
      );
    }

    await supabase!.from("marketplace_accounts").upsert(
      {
        marketplace: "etsy",
        is_api_connected: true,
        default_fee_pct: 9.5,
        price_markup_pct: 5.0,
        updated_at: syncedAt,
      },
      { onConflict: "marketplace" }
    );

    const res: EtsySyncResponse = {
      mode: "live",
      syncedCount: etsyListings.length,
      matchedCount,
      syncedAt,
      message: `Live Etsy sync complete: ${matchedCount}/${etsyListings.length} active Etsy listings matched to master SKUs.`,
    };

    return NextResponse.json(res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Etsy sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
