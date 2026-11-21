import { NextResponse } from "next/server";
import {
  applyDemoPromoteListing,
  getDemoStore,
  recordDemoJob,
} from "@/lib/demo-store";
import { isEbayConfigured, promoteEbayListing } from "@/lib/ebay";
import { calculateDaysListed } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { InventoryItem, MarketplaceListing } from "@/lib/types";

interface PromoteAutomationBody {
  minDaysListed?: number;
  adRatePct?: number;
  listingIds?: string[];
}

interface JoinedListing extends MarketplaceListing {
  inventory_items: InventoryItem | InventoryItem[] | null;
}

/**
 * POST /api/automations/promote
 * Auto-Promotes eligible eBay listings (>= 30 days listed by default) to a 4% Promoted Listings ad rate.
 * Can be called manually via UI "Run Auto-Promote Now" or on a daily schedule (Vercel Cron / pg_cron).
 */
export async function POST(request: Request) {
  let body: PromoteAutomationBody = {};
  try {
    body = (await request.json()) as PromoteAutomationBody;
  } catch {
    // Allow empty body (e.g., cron trigger)
  }

  const minDaysListed = Math.max(1, Number(body.minDaysListed ?? 30));
  const adRatePct = Math.max(2, Math.min(20, Number(body.adRatePct ?? 4)));
  const specificIds = Array.isArray(body.listingIds)
    ? new Set(body.listingIds)
    : null;

  const supabase = getSupabaseServerClient();
  const useLive = Boolean(
    supabase && isSupabaseConfigured() && isEbayConfigured()
  );
  const nowIso = new Date().toISOString();

  if (!useLive) {
    const store = getDemoStore();
    const itemById = new Map(store.items.map((i) => [i.id, i]));
    const promoted: Array<{
      listingId: string;
      sku: string;
      daysListed: number;
      adRatePct: number;
    }> = [];

    for (const listing of store.listings) {
      if (listing.marketplace !== "ebay" || listing.status !== "active") {
        continue;
      }
      const item = itemById.get(listing.item_id);
      if (!item || item.status === "sold") continue;

      const days = calculateDaysListed(listing.listed_at);
      const alreadyPromoted = Number(listing.promoted_ad_rate_pct ?? 0) >= adRatePct;

      const isTarget = specificIds
        ? specificIds.has(listing.id)
        : days >= minDaysListed && !alreadyPromoted;

      if (!isTarget) continue;

      applyDemoPromoteListing(listing.id, adRatePct);
      recordDemoJob({
        item_id: item.id,
        listing_id: listing.id,
        marketplace: "ebay",
        action: "promote_listing",
        execution_mode: "api",
        payload: {
          adRatePct,
          daysListed: days,
          rule: `${minDaysListed}d+ Auto-Promote to ${adRatePct}%`,
        },
        status: "completed",
        attempts: 1,
        error_message: null,
        created_at: nowIso,
        started_at: nowIso,
        completed_at: nowIso,
        item_sku: item.sku,
        item_title: item.title,
      });

      promoted.push({
        listingId: listing.id,
        sku: item.sku,
        daysListed: days,
        adRatePct,
      });
    }

    return NextResponse.json({
      mode: "demo",
      minDaysListed,
      adRatePct,
      promotedCount: promoted.length,
      promoted,
      message:
        promoted.length > 0
          ? `Auto-Promoted ${promoted.length} eBay listing${promoted.length === 1 ? "" : "s"} (${minDaysListed}d+) to ${adRatePct}% ad rate.`
          : `All ${minDaysListed}d+ eBay listings are already promoted at ${adRatePct}% or higher.`,
    });
  }

  try {
    const { data, error } = await supabase!
      .from("marketplace_listings")
      .select("*, inventory_items(*)")
      .eq("marketplace", "ebay")
      .eq("status", "active");

    if (error) throw error;

    const rows = (data ?? []) as JoinedListing[];
    const promoted: Array<{
      listingId: string;
      sku: string;
      daysListed: number;
      adRatePct: number;
    }> = [];

    for (const listing of rows) {
      const inv = Array.isArray(listing.inventory_items)
        ? listing.inventory_items[0]
        : listing.inventory_items;
      if (!inv || inv.status === "sold") continue;

      const days = calculateDaysListed(listing.listed_at);
      const alreadyPromoted = Number(listing.promoted_ad_rate_pct ?? 0) >= adRatePct;
      const isTarget = specificIds
        ? specificIds.has(listing.id)
        : days >= minDaysListed && !alreadyPromoted;

      if (!isTarget || !listing.external_listing_id) continue;

      await promoteEbayListing({
        listingId: listing.external_listing_id,
        adRatePct,
      });

      await supabase!
        .from("marketplace_listings")
        .update({
          promoted_ad_rate_pct: adRatePct,
          last_synced_at: nowIso,
        })
        .eq("id", listing.id);

      await supabase!.from("channel_jobs").insert({
        item_id: inv.id,
        listing_id: listing.id,
        marketplace: "ebay",
        action: "promote_listing",
        execution_mode: "api",
        payload: { adRatePct, daysListed: days },
        status: "completed",
        attempts: 1,
        started_at: nowIso,
        completed_at: new Date().toISOString(),
      });

      promoted.push({
        listingId: listing.id,
        sku: inv.sku,
        daysListed: days,
        adRatePct,
      });
    }

    return NextResponse.json({
      mode: "live",
      minDaysListed,
      adRatePct,
      promotedCount: promoted.length,
      promoted,
      message: `Live Auto-Promote complete: promoted ${promoted.length} listing${promoted.length === 1 ? "" : "s"} to ${adRatePct}%.`,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Auto-Promote automation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
