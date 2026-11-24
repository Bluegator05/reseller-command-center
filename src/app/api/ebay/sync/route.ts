import { NextResponse } from "next/server";
import { simulateDemoEbaySync } from "@/lib/demo-store";
import {
  fetchActiveEbayOffersWithMeta,
  fetchActivePromotedRates,
  isEbayConfigured,
  type NormalizedEbayOffer,
} from "@/lib/ebay";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { EbaySyncResponse, MarketplaceType } from "@/lib/types";

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
 * using batched inserts/upserts, AND reconciles any previously active eBay
 * listings that are no longer live on eBay (marking sold items `sold` and
 * delisted/expired items `ended` so they never stay stuck in Active Inventory).
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
    const [{ offers, tradingSucceeded }, promotedRates] = await Promise.all([
      fetchActiveEbayOffersWithMeta(2000),
      fetchActivePromotedRates(),
    ]);
    const syncedAt = new Date().toISOString();

    // 1. Fetch existing inventory item IDs + item_specifics by SKU in chunks of 200
    const skuToExisting = new Map<
      string,
      { id: string; imageCount: number; itemSpecifics: Record<string, unknown> }
    >();
    const allSkus = offers.map((o) => o.sku);
    for (const skuChunk of chunkArray(allSkus, 200)) {
      const { data: existingRows, error: lookupError } = await supabase!
        .from("inventory_items")
        .select("id, sku, image_urls, item_specifics")
        .in("sku", skuChunk);
      if (lookupError) throw lookupError;
      for (const row of existingRows ?? []) {
        const imgs = Array.isArray(row.image_urls) ? row.image_urls : [];
        skuToExisting.set(row.sku as string, {
          id: row.id as string,
          imageCount: imgs.length,
          itemSpecifics:
            (row.item_specifics as Record<string, unknown> | null) ?? {},
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
      existingSpecs: Record<string, unknown>;
      offer: NormalizedEbayOffer;
    }> = [];

    for (const offer of offers) {
      const existing = skuToExisting.get(offer.sku);
      if (existing) {
        existingOffers.push({
          id: existing.id,
          existingImageCount: existing.imageCount,
          existingSpecs: existing.itemSpecifics,
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
        item_specifics: {
          ...offer.itemSpecifics,
          quantity_available: String(Math.max(1, offer.quantityAvailable || 1)),
          quantity_total: String(
            Math.max(1, offer.quantityTotal || offer.quantityAvailable || 1)
          ),
          quantity_sold: String(Math.max(0, offer.quantitySold || 0)),
        },
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

    // 3. Update existing SKUs in parallel chunks of 20 (preserving user COGS/bins/notes/floor/audit flags & enriched full photo galleries)
    for (const batch of chunkArray(existingOffers, 20)) {
      await Promise.all(
        batch.map(async ({ id, existingImageCount, existingSpecs, offer }) => {
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

          const qtyStr = String(Math.max(1, offer.quantityAvailable || 1));
          const qtyTotalStr = String(
            Math.max(1, offer.quantityTotal || offer.quantityAvailable || 1)
          );
          const qtySoldStr = String(Math.max(0, offer.quantitySold || 0));
          const hasIncomingSpecs = Object.keys(offer.itemSpecifics).length > 0;
          if (
            hasIncomingSpecs ||
            existingSpecs.quantity_available !== qtyStr ||
            existingSpecs.quantity_total !== qtyTotalStr ||
            existingSpecs.quantity_sold !== qtySoldStr
          ) {
            patch.item_specifics = {
              ...existingSpecs,
              ...offer.itemSpecifics,
              quantity_available: qtyStr,
              quantity_total: qtyTotalStr,
              quantity_sold: qtySoldStr,
            };
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
    //    Look up existing listed_at first so offers lacking a real eBay StartTime
    //    (e.g., Sell Inventory API offers without listingStartDate) NEVER overwrite
    //    older items' real listed_at with `syncedAt` and push newly listed items down.
    const existingListedAtByItemId = new Map<string, string>();
    const allSyncedItemIds = Array.from(
      new Set(
        offers
          .map((o) => skuToId.get(o.sku))
          .filter((id): id is string => Boolean(id))
      )
    );
    for (const idChunk of chunkArray(allSyncedItemIds, 200)) {
      const { data: existingListings } = await supabase!
        .from("marketplace_listings")
        .select("item_id, listed_at")
        .eq("marketplace", "ebay")
        .in("item_id", idChunk);
      for (const row of existingListings ?? []) {
        if (row.item_id && typeof row.listed_at === "string" && row.listed_at) {
          existingListedAtByItemId.set(row.item_id as string, row.listed_at);
        }
      }
    }

    const listingRows = offers
      .map((offer) => {
        const itemId = skuToId.get(offer.sku);
        if (!itemId) return null;
        const resolvedListedAt =
          offer.hasRealListedAt !== false
            ? offer.listedAt
            : existingListedAtByItemId.get(itemId) || offer.listedAt;
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
          listed_at: resolvedListedAt,
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

    // 5. Reconcile previously active eBay listings that are NO LONGER live on eBay
    //    (Safety guard: only run when Trading API succeeded cleanly and returned offers)
    let reconciledSoldCount = 0;
    let reconciledEndedCount = 0;
    const crossListedSoldWarnings: Array<{
      itemId: string;
      sku: string;
      title: string;
      marketplaces: MarketplaceType[];
    }> = [];

    if (tradingSucceeded && offers.length > 0) {
      const liveEbayItemIds = new Set(listingRows.map((r) => r.item_id));
      const dbActiveEbayListings: Array<{ id: string; item_id: string }> = [];

      for (let from = 0; from < 5000; from += 1000) {
        const { data: activeRows, error: activeErr } = await supabase!
          .from("marketplace_listings")
          .select("id, item_id")
          .eq("marketplace", "ebay")
          .eq("status", "active")
          .range(from, from + 999);
        if (activeErr) throw activeErr;
        for (const r of activeRows ?? []) {
          dbActiveEbayListings.push({
            id: String(r.id),
            item_id: String(r.item_id),
          });
        }
        if ((activeRows ?? []).length < 1000) break;
      }

      const staleListings = dbActiveEbayListings.filter(
        (l) => !liveEbayItemIds.has(l.item_id)
      );

      if (staleListings.length > 0) {
        const staleItemIds = [...new Set(staleListings.map((l) => l.item_id))];

        // Check which disappeared eBay listings have a paid/shipped sale in sales_orders
        const soldItemIds = new Set<string>();
        for (const chunk of chunkArray(staleItemIds, 200)) {
          const { data: saleRows } = await supabase!
            .from("sales_orders")
            .select("item_id, fulfillment_status, restocked")
            .in("item_id", chunk);
          for (const s of saleRows ?? []) {
            if (
              s.fulfillment_status !== "unpaid" &&
              s.fulfillment_status !== "returned" &&
              !s.restocked
            ) {
              soldItemIds.add(String(s.item_id));
            }
          }
        }

        // Check which disappeared eBay items STILL have active cross-listings on Poshmark/Mercari/Etsy/FB
        const otherActiveByItem = new Map<string, MarketplaceType[]>();
        for (const chunk of chunkArray(staleItemIds, 200)) {
          const { data: otherRows } = await supabase!
            .from("marketplace_listings")
            .select("item_id, marketplace")
            .in("item_id", chunk)
            .neq("marketplace", "ebay")
            .eq("status", "active");
          for (const o of otherRows ?? []) {
            const iid = String(o.item_id);
            const list = otherActiveByItem.get(iid) ?? [];
            const mp = o.marketplace as MarketplaceType;
            if (!list.includes(mp)) list.push(mp);
            otherActiveByItem.set(iid, list);
          }
        }

        const soldListingIds: string[] = [];
        const endedListingIds: string[] = [];
        const markInvSoldIds: string[] = [];
        const markInvArchivedIds: string[] = [];

        for (const st of staleListings) {
          if (soldItemIds.has(st.item_id)) {
            soldListingIds.push(st.id);
            markInvSoldIds.push(st.item_id);
          } else {
            endedListingIds.push(st.id);
            if (!otherActiveByItem.has(st.item_id)) {
              markInvArchivedIds.push(st.item_id);
            }
          }
        }

        for (const chunk of chunkArray(soldListingIds, 100)) {
          await supabase!
            .from("marketplace_listings")
            .update({ status: "sold", last_synced_at: syncedAt })
            .in("id", chunk);
        }
        for (const chunk of chunkArray([...new Set(markInvSoldIds)], 100)) {
          await supabase!
            .from("inventory_items")
            .update({ status: "sold", updated_at: syncedAt })
            .in("id", chunk);
        }
        for (const chunk of chunkArray(endedListingIds, 100)) {
          await supabase!
            .from("marketplace_listings")
            .update({ status: "ended", last_synced_at: syncedAt })
            .in("id", chunk);
        }
        for (const chunk of chunkArray([...new Set(markInvArchivedIds)], 100)) {
          await supabase!
            .from("inventory_items")
            .update({ status: "archived", updated_at: syncedAt })
            .in("id", chunk)
            .eq("status", "active");
        }

        reconciledSoldCount = new Set(markInvSoldIds).size;
        reconciledEndedCount = new Set(
          staleListings
            .filter((s) => !soldItemIds.has(s.item_id))
            .map((s) => s.item_id)
        ).size;

        // Collect warnings for sold eBay items that STILL have active cross-listings elsewhere
        const warnIds = [...soldItemIds].filter((id) =>
          otherActiveByItem.has(id)
        );
        if (warnIds.length > 0) {
          for (const chunk of chunkArray(warnIds, 100)) {
            const { data: warnItems } = await supabase!
              .from("inventory_items")
              .select("id, sku, title")
              .in("id", chunk);
            for (const w of warnItems ?? []) {
              const iid = String(w.id);
              const mps = otherActiveByItem.get(iid) ?? [];
              if (mps.length > 0) {
                crossListedSoldWarnings.push({
                  itemId: iid,
                  sku: String(w.sku || ""),
                  title: String(w.title || ""),
                  marketplaces: mps,
                });
              }
            }
          }
        }
      }
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

    const reconcileParts: string[] = [];
    if (reconciledSoldCount > 0) {
      reconcileParts.push(
        `marked ${reconciledSoldCount} already-sold item${reconciledSoldCount === 1 ? "" : "s"} as Sold`
      );
    }
    if (reconciledEndedCount > 0) {
      reconcileParts.push(
        `removed ${reconciledEndedCount} ended/delisted listing${reconciledEndedCount === 1 ? "" : "s"}`
      );
    }
    const reconcileSuffix =
      reconcileParts.length > 0 ? ` · ${reconcileParts.join(" & ")}` : "";

    const response: EbaySyncResponse = {
      mode: "live",
      syncedCount: offers.length,
      createdCount: newOffers.length,
      updatedCount: existingOffers.length,
      reconciledSoldCount,
      reconciledEndedCount,
      crossListedSoldWarnings,
      syncedAt,
      message: `Live eBay sync complete: ${offers.length} active listings (${newOffers.length} new, ${existingOffers.length} updated)${reconcileSuffix}.`,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "eBay sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
