import { NextResponse } from "next/server";
import { cascadeDelistOtherChannelsForSoldItem } from "@/lib/auto-delist";
import {
  fetchEbayItemThumbnail,
  fetchEbaySalesOrders,
  fetchLiveActiveEbayIds,
  isEbayConfigured,
} from "@/lib/ebay";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      daysBack?: number;
      cascadeDelist?: boolean;
    };
    const cascadeDelist = Boolean(body?.cascadeDelist);
    const daysBack = Math.max(
      1,
      Math.min(730, Math.round(Number(body?.daysBack) || 365))
    );

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (!supabase || !envReadiness.isSupabaseReady) {
      return NextResponse.json(
        { error: "Supabase is not configured in this environment." },
        { status: 400 }
      );
    }

    if (!isEbayConfigured()) {
      return NextResponse.json(
        { error: "eBay Production OAuth credentials are not configured." },
        { status: 400 }
      );
    }

    const { orders, sourceApi, daysBack: effectiveDays } =
      await fetchEbaySalesOrders(daysBack);

    if (orders.length === 0) {
      return NextResponse.json({
        mode: "live",
        importedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        totalFetched: 0,
        sourceApi,
        daysBack: effectiveDays,
        message: `No eBay sales found in the past ${effectiveDays} days.`,
      });
    }

    // 1. Load existing eBay sales_orders to avoid duplicates & allow status updates
    const existingOrders = new Map<
      string,
      {
        id: string;
        item_id: string;
        fulfillment_status: string;
        refund_amount: number;
        marketplace_fees: number;
        shipped_at: string | null;
      }
    >();

    for (let from = 0; from < 5000; from += 1000) {
      const { data, error } = await supabase
        .from("sales_orders")
        .select(
          "id, item_id, external_order_id, fulfillment_status, refund_amount, marketplace_fees, shipped_at"
        )
        .eq("marketplace", "ebay")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.external_order_id) {
          existingOrders.set(row.external_order_id, {
            id: row.id,
            item_id: row.item_id,
            fulfillment_status: row.fulfillment_status,
            refund_amount: Number(row.refund_amount ?? 0),
            marketplace_fees: Number(row.marketplace_fees ?? 0),
            shipped_at: row.shipped_at ?? null,
          });
        }
      }
      if ((data ?? []).length < 1000) break;
    }

    // 2. Load existing inventory_items (SKU -> id, plus which ones already have photos)
    const skuToItemId = new Map<string, string>();
    const itemsWithImages = new Set<string>();
    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("id, sku, image_urls")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.sku) skuToItemId.set(row.sku.trim().toLowerCase(), row.id);
        if (Array.isArray(row.image_urls) && row.image_urls.length > 0) {
          itemsWithImages.add(row.id);
        }
      }
      if ((data ?? []).length < 1000) break;
    }

    const legacyIdToItemId = new Map<string, string>();
    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await supabase
        .from("marketplace_listings")
        .select("item_id, external_listing_id")
        .eq("marketplace", "ebay")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.external_listing_id) {
          legacyIdToItemId.set(row.external_listing_id.trim(), row.item_id);
        }
      }
      if ((data ?? []).length < 1000) break;
    }

    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    // 3. Separate existing updates vs brand-new orders
    const newSalesPayloads: Array<{
      item_id: string;
      marketplace: "ebay";
      external_order_id: string;
      gross_sale_price: number;
      marketplace_fees: number;
      shipping_cost: number;
      refund_amount: number;
      fulfillment_status: string;
      tracking_number: string | null;
      shipped_at: string | null;
      return_reason: string | null;
      restocked: boolean;
      sold_at: string;
    }> = [];

    // Collect (itemId -> legacyItemId) pairs missing a thumbnail so we can backfill them
    const missingPhotos = new Map<string, string>();
    // Collect buyer shipping locations per itemId + externalOrderId for Buyer Map & Shipping Zone analytics
    const buyerLocationsByItem = new Map<
      string,
      Array<{
        orderId: string;
        city: string | null;
        state: string | null;
        postal: string | null;
        country: string | null;
        quantity: number;
      }>
    >();
    const recordBuyerLoc = (
      invId: string | null | undefined,
      orderId: string,
      city?: string | null,
      state?: string | null,
      postal?: string | null,
      country?: string | null,
      quantity?: number | null
    ) => {
      if (!invId || !orderId) return;
      const cleanQty =
        Number.isFinite(Number(quantity)) && Number(quantity) >= 1
          ? Math.floor(Number(quantity))
          : 1;
      const list = buyerLocationsByItem.get(invId) ?? [];
      list.push({
        orderId,
        city: city ?? null,
        state: state ?? null,
        postal: postal ?? null,
        country: country ?? null,
        quantity: cleanQty,
      });
      buyerLocationsByItem.set(invId, list);
    };

    for (const line of orders) {
      const existing = existingOrders.get(line.externalOrderId);
      if (existing) {
        recordBuyerLoc(
          existing.item_id,
          line.externalOrderId,
          line.buyerCity,
          line.buyerState,
          line.buyerPostal,
          line.buyerCountry,
          line.quantity
        );
        if (
          line.legacyItemId &&
          existing.item_id &&
          !itemsWithImages.has(existing.item_id) &&
          !missingPhotos.has(existing.item_id)
        ) {
          missingPhotos.set(existing.item_id, line.legacyItemId);
        }

        const needsUpdate =
          existing.fulfillment_status !== line.fulfillmentStatus ||
          Math.abs(existing.refund_amount - line.refundAmount) > 0.01 ||
          Math.abs(existing.marketplace_fees - line.marketplaceFees) > 0.01 ||
          (!existing.shipped_at && Boolean(line.shippedAt));

        if (needsUpdate) {
          const { error: updErr } = await supabase
            .from("sales_orders")
            .update({
              fulfillment_status: line.fulfillmentStatus,
              refund_amount: line.refundAmount,
              marketplace_fees: line.marketplaceFees,
              shipped_at: line.shippedAt ?? existing.shipped_at,
              ...(line.trackingNumber
                ? { tracking_number: line.trackingNumber }
                : {}),
              ...(line.returnReason ? { return_reason: line.returnReason } : {}),
            })
            .eq("id", existing.id);
          if (!updErr) updatedCount += 1;
        } else {
          skippedCount += 1;
        }
        continue;
      }

      // Resolve or create the parent inventory_items record (required by FK)
      let itemId =
        (line.legacyItemId ? legacyIdToItemId.get(line.legacyItemId) : null) ||
        skuToItemId.get(line.sku.trim().toLowerCase()) ||
        null;

      if (!itemId) {
        let candidateSku = line.sku.trim();
        if (!candidateSku || skuToItemId.has(candidateSku.toLowerCase())) {
          candidateSku = `EBAY-SOLD-${line.legacyItemId || line.externalOrderId}`;
        }
        if (skuToItemId.has(candidateSku.toLowerCase())) {
          candidateSku = `${candidateSku}-${line.externalOrderId.slice(-6)}`;
        }

        const { data: createdItem, error: itemErr } = await supabase
          .from("inventory_items")
          .insert({
            sku: candidateSku,
            title: line.title.slice(0, 200),
            condition: "Used",
            cogs: 0,
            prep_cost: 0,
            target_price: Math.max(0.01, line.grossSalePrice),
            floor_price: Math.max(0.01, line.grossSalePrice),
            status: "sold",
            acquired_at: line.soldAt,
          })
          .select("id, sku")
          .single();

        if (itemErr || !createdItem) {
          // If a race/duplicate SKU occurred, look it up directly
          const { data: fallback } = await supabase
            .from("inventory_items")
            .select("id, sku")
            .eq("sku", candidateSku)
            .maybeSingle();
          if (!fallback?.id) {
            console.warn(
              "[sync-sales] Skipping order due to item insert error:",
              line.externalOrderId,
              itemErr?.message
            );
            continue;
          }
          itemId = String(fallback.id);
        } else {
          itemId = String(createdItem.id);
        }

        skuToItemId.set(candidateSku.toLowerCase(), itemId);
        if (line.legacyItemId) {
          legacyIdToItemId.set(line.legacyItemId, itemId);
        }
      }

      if (!itemId) continue;

      recordBuyerLoc(
        itemId,
        line.externalOrderId,
        line.buyerCity,
        line.buyerState,
        line.buyerPostal,
        line.buyerCountry,
        line.quantity
      );

      if (
        line.legacyItemId &&
        !itemsWithImages.has(itemId) &&
        !missingPhotos.has(itemId)
      ) {
        missingPhotos.set(itemId, line.legacyItemId);
      }

      // Prevent duplicate entries within the same batch
      existingOrders.set(line.externalOrderId, {
        id: "pending",
        item_id: itemId,
        fulfillment_status: line.fulfillmentStatus,
        refund_amount: line.refundAmount,
        marketplace_fees: line.marketplaceFees,
        shipped_at: line.shippedAt,
      });

      newSalesPayloads.push({
        item_id: itemId,
        marketplace: "ebay",
        external_order_id: line.externalOrderId,
        gross_sale_price: line.grossSalePrice,
        marketplace_fees: line.marketplaceFees,
        shipping_cost: line.shippingCost,
        refund_amount: line.refundAmount,
        fulfillment_status: line.fulfillmentStatus,
        tracking_number: line.trackingNumber,
        shipped_at: line.shippedAt,
        return_reason: line.returnReason,
        restocked: false,
        sold_at: line.soldAt,
      });
    }

    // 4. Batch-insert new sales_orders in chunks of 100
    for (let i = 0; i < newSalesPayloads.length; i += 100) {
      const chunk = newSalesPayloads.slice(i, i + 100);
      const { error: insErr } = await supabase.from("sales_orders").insert(chunk);
      if (insErr) {
        throw new Error(`Failed saving imported eBay sales: ${insErr.message}`);
      }
      importedCount += chunk.length;
    }

    // 4b. Backfill thumbnails for sold eBay items missing photos (fast GetItem OutputSelector)
    let photosBackfilled = 0;
    if (missingPhotos.size > 0) {
      const deadline = Date.now() + 20_000;
      const entries = [...missingPhotos.entries()].slice(0, 60);
      const batchSize = 6;
      for (let i = 0; i < entries.length; i += batchSize) {
        if (Date.now() > deadline) break;
        const batch = entries.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async ([invId, legacyId]) => {
            const thumb = await fetchEbayItemThumbnail(legacyId);
            if (!thumb) return;
            const { error: picErr } = await supabase
              .from("inventory_items")
              .update({ image_urls: [thumb] })
              .eq("id", invId);
            if (!picErr) {
              photosBackfilled += 1;
              itemsWithImages.add(invId);
            }
          })
        );
      }
    }

    // 4c. Backfill buyer city/state/postal/country into inventory_items.item_specifics
    let buyerLocationsSaved = 0;
    if (buyerLocationsByItem.size > 0) {
      const itemIds = [...buyerLocationsByItem.keys()];
      for (let i = 0; i < itemIds.length; i += 100) {
        const chunkIds = itemIds.slice(i, i + 100);
        const { data: invRows } = await supabase
          .from("inventory_items")
          .select("id, item_specifics")
          .in("id", chunkIds);

        const toUpdate: Array<{
          id: string;
          specs: Record<string, unknown>;
        }> = [];

        for (const r of invRows ?? []) {
          const id = String(r.id);
          const locs = buyerLocationsByItem.get(id);
          if (!locs || locs.length === 0) continue;
          const existingSpecs = (r.item_specifics || {}) as Record<
            string,
            unknown
          >;
          const existingOrderLocs =
            existingSpecs.order_locations &&
            typeof existingSpecs.order_locations === "object"
              ? {
                  ...(existingSpecs.order_locations as Record<
                    string,
                    {
                      city?: string | null;
                      state?: string | null;
                      postal?: string | null;
                      country?: string | null;
                    }
                  >),
                }
              : {};

          const existingOrderQtys =
            existingSpecs.order_quantities &&
            typeof existingSpecs.order_quantities === "object"
              ? {
                  ...(existingSpecs.order_quantities as Record<string, number>),
                }
              : {};
          const existingQtyOverrides =
            existingSpecs.order_quantity_overrides &&
            typeof existingSpecs.order_quantity_overrides === "object"
              ? (existingSpecs.order_quantity_overrides as Record<
                  string,
                  boolean
                >)
              : {};

          let changed = false;
          for (const loc of locs) {
            if (loc.city || loc.state || loc.country) {
              const prev = existingOrderLocs[loc.orderId];
              if (
                !prev ||
                prev.city !== loc.city ||
                prev.state !== loc.state ||
                prev.country !== loc.country
              ) {
                existingOrderLocs[loc.orderId] = {
                  city: loc.city,
                  state: loc.state,
                  postal: loc.postal,
                  country: loc.country,
                };
                changed = true;
              }
            }
            if (
              !existingQtyOverrides[loc.orderId] &&
              existingOrderQtys[loc.orderId] !== loc.quantity
            ) {
              existingOrderQtys[loc.orderId] = loc.quantity;
              changed = true;
            }
          }
          const latestWithLoc =
            locs.find((l) => l.city || l.state || l.country) ?? locs[0];
          if (
            (latestWithLoc.city || latestWithLoc.state || latestWithLoc.country) &&
            (existingSpecs.buyer_city !== latestWithLoc.city ||
              existingSpecs.buyer_state !== latestWithLoc.state ||
              existingSpecs.buyer_country !== latestWithLoc.country)
          ) {
            changed = true;
          }

          if (changed) {
            toUpdate.push({
              id,
              specs: {
                ...existingSpecs,
                ...(latestWithLoc.city || latestWithLoc.state || latestWithLoc.country
                  ? {
                      buyer_city: latestWithLoc.city,
                      buyer_state: latestWithLoc.state,
                      buyer_postal: latestWithLoc.postal,
                      buyer_country: latestWithLoc.country,
                    }
                  : {}),
                order_locations: existingOrderLocs,
                ...(Object.keys(existingOrderQtys).length > 0
                  ? { order_quantities: existingOrderQtys }
                  : {}),
              },
            });
          }
        }

        for (let j = 0; j < toUpdate.length; j += 10) {
          const batch = toUpdate.slice(j, j + 10);
          await Promise.all(
            batch.map(async (u) => {
              const { error: locErr } = await supabase
                .from("inventory_items")
                .update({ item_specifics: u.specs })
                .eq("id", u.id);
              if (!locErr) buyerLocationsSaved += 1;
            })
          );
        }
      }
    }

    // 4d. Reconcile any currently "active" inventory items that already have a paid/shipped
    //     eBay sale against eBay's live ActiveList (qty > 0). Truly sold-out items are
    //     marked Sold immediately; multi-quantity items still live on eBay stay Active!
    let reconciledSoldCount = 0;
    const paidEbayItemIds = [
      ...new Set(
        [...existingOrders.values()]
          .filter(
            (o) =>
              o.item_id &&
              o.fulfillment_status !== "unpaid" &&
              o.fulfillment_status !== "returned"
          )
          .map((o) => o.item_id)
      ),
    ];

    if (paidEbayItemIds.length > 0) {
      const candidateActiveListings: Array<{
        listingId: string;
        itemId: string;
        externalListingId: string | null;
        sku: string;
        itemSpecifics: Record<string, unknown>;
      }> = [];

      for (let i = 0; i < paidEbayItemIds.length; i += 100) {
        const chunk = paidEbayItemIds.slice(i, i + 100);
        const { data: activeRows } = await supabase
          .from("marketplace_listings")
          .select("id, item_id, external_listing_id, inventory_items(sku, status, item_specifics)")
          .eq("marketplace", "ebay")
          .eq("status", "active")
          .in("item_id", chunk);

        for (const r of activeRows ?? []) {
          const invRaw = r.inventory_items as
            | { sku?: string; status?: string; item_specifics?: Record<string, unknown> }
            | Array<{ sku?: string; status?: string; item_specifics?: Record<string, unknown> }>
            | null;
          const inv = Array.isArray(invRaw) ? invRaw[0] : invRaw;
          candidateActiveListings.push({
            listingId: String(r.id),
            itemId: String(r.item_id),
            externalListingId: r.external_listing_id
              ? String(r.external_listing_id).trim()
              : null,
            sku: String(inv?.sku || "").trim(),
            itemSpecifics:
              (inv?.item_specifics as Record<string, unknown> | null) ?? {},
          });
        }
      }

      if (candidateActiveListings.length > 0) {
        const liveEbay = await fetchLiveActiveEbayIds(2000);
        if (liveEbay && (liveEbay.listingIds.size > 0 || liveEbay.skus.size > 0)) {
          const nowIso = new Date().toISOString();
          const soldListingIds: string[] = [];
          const soldItemIds: string[] = [];
          const qtyUpdates: Array<{
            itemId: string;
            specs: Record<string, unknown>;
          }> = [];

          for (const cand of candidateActiveListings) {
            const skuKey = cand.sku.toLowerCase();
            const liveById =
              cand.externalListingId &&
              liveEbay.listingIds.has(cand.externalListingId);
            const liveBySku = skuKey && liveEbay.skus.has(skuKey);

            if (!liveById && !liveBySku) {
              soldListingIds.push(cand.listingId);
              soldItemIds.push(cand.itemId);
            } else {
              const liveQty =
                (cand.externalListingId
                  ? liveEbay.qtyByListingId.get(cand.externalListingId)
                  : undefined) ??
                (skuKey ? liveEbay.qtyBySku.get(skuKey) : undefined);
              if (
                liveQty &&
                String(cand.itemSpecifics.quantity_available || "") !==
                  String(liveQty)
              ) {
                qtyUpdates.push({
                  itemId: cand.itemId,
                  specs: {
                    ...cand.itemSpecifics,
                    quantity_available: String(liveQty),
                  },
                });
              }
            }
          }

          for (let i = 0; i < soldListingIds.length; i += 100) {
            await supabase
              .from("marketplace_listings")
              .update({ status: "sold", last_synced_at: nowIso })
              .in("id", soldListingIds.slice(i, i + 100));
          }
          const uniqueSoldItemIds = [...new Set(soldItemIds)];
          for (let i = 0; i < uniqueSoldItemIds.length; i += 100) {
            await supabase
              .from("inventory_items")
              .update({ status: "sold", updated_at: nowIso })
              .in("id", uniqueSoldItemIds.slice(i, i + 100));
          }
          reconciledSoldCount = uniqueSoldItemIds.length;

          for (let i = 0; i < qtyUpdates.length; i += 10) {
            await Promise.all(
              qtyUpdates.slice(i, i + 10).map((q) =>
                supabase
                  .from("inventory_items")
                  .update({ item_specifics: q.specs, updated_at: nowIso })
                  .eq("id", q.itemId)
              )
            );
          }
        }
      }
    }

    // 5. Anti-Double-Sell Cascade (ONLY when explicitly enabled for live sale watch,
    //    and strictly limited to brand-new paid sales from the past 7 days!)
    const delistedCount = { total: 0 };
    if (cascadeDelist && newSalesPayloads.length > 0) {
      const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const lineByOrderId = new Map(orders.map((o) => [o.externalOrderId, o]));
      for (const row of newSalesPayloads) {
        if (
          row.fulfillment_status === "unpaid" ||
          row.fulfillment_status === "returned"
        ) {
          continue;
        }
        const soldMs = Date.parse(row.sold_at);
        if (!Number.isNaN(soldMs) && soldMs < sevenDaysAgoMs) continue;
        const orig = lineByOrderId.get(row.external_order_id);
        const cascaded = await cascadeDelistOtherChannelsForSoldItem({
          itemId: row.item_id,
          soldOnMarketplace: "ebay",
          externalOrderId: row.external_order_id,
          sku: orig?.sku,
          title: orig?.title,
        });
        delistedCount.total += cascaded.length;
      }
    }

    const photoNote =
      photosBackfilled > 0
        ? ` · Added ${photosBackfilled} item photo${photosBackfilled === 1 ? "" : "s"}`
        : "";
    const locNote =
      buyerLocationsSaved > 0
        ? ` · Synced ${buyerLocationsSaved} buyer map location${buyerLocationsSaved === 1 ? "" : "s"}`
        : "";
    const soldCleanNote =
      reconciledSoldCount > 0
        ? ` · Removed ${reconciledSoldCount} already-sold item${reconciledSoldCount === 1 ? "" : "s"} from Active Inventory`
        : "";

    return NextResponse.json({
      mode: "live",
      importedCount,
      updatedCount,
      skippedCount,
      photosBackfilled,
      buyerLocationsSaved,
      reconciledSoldCount,
      delistedCount: delistedCount.total,
      totalFetched: orders.length,
      sourceApi,
      daysBack: effectiveDays,
      message:
        importedCount > 0
          ? `Imported ${importedCount} eBay sale${importedCount === 1 ? "" : "s"}${delistedCount.total > 0 ? ` & queued ${delistedCount.total} auto-delist${delistedCount.total === 1 ? "" : "s"}` : ""}${updatedCount > 0 ? ` (${updatedCount} updated)` : ""}${soldCleanNote}${photoNote}${locNote}.`
          : updatedCount > 0
            ? `Updated ${updatedCount} existing eBay order${updatedCount === 1 ? "" : "s"}${soldCleanNote}${photoNote}${locNote}.`
            : reconciledSoldCount > 0 || photosBackfilled > 0 || buyerLocationsSaved > 0
              ? `Synced eBay orders${soldCleanNote}${photoNote}${locNote}!`
              : `All ${orders.length} eBay orders from the past ${effectiveDays} days are already up to date.`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "eBay sales import failed";
    console.error("[/api/ebay/sync-sales] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
