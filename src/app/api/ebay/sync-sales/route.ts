import { NextResponse } from "next/server";
import { cascadeDelistOtherChannelsForSoldItem } from "@/lib/auto-delist";
import { fetchEbaySalesOrders, isEbayConfigured } from "@/lib/ebay";
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
          "id, external_order_id, fulfillment_status, refund_amount, marketplace_fees, shipped_at"
        )
        .eq("marketplace", "ebay")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.external_order_id) {
          existingOrders.set(row.external_order_id, {
            id: row.id,
            fulfillment_status: row.fulfillment_status,
            refund_amount: Number(row.refund_amount ?? 0),
            marketplace_fees: Number(row.marketplace_fees ?? 0),
            shipped_at: row.shipped_at ?? null,
          });
        }
      }
      if ((data ?? []).length < 1000) break;
    }

    // 2. Load existing inventory_items (SKU -> id) and eBay listings (legacyItemId -> item_id)
    const skuToItemId = new Map<string, string>();
    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("id, sku")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.sku) skuToItemId.set(row.sku.trim().toLowerCase(), row.id);
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

    for (const line of orders) {
      const existing = existingOrders.get(line.externalOrderId);
      if (existing) {
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

      // Prevent duplicate entries within the same batch
      existingOrders.set(line.externalOrderId, {
        id: "pending",
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

    return NextResponse.json({
      mode: "live",
      importedCount,
      updatedCount,
      skippedCount,
      delistedCount: delistedCount.total,
      totalFetched: orders.length,
      sourceApi,
      daysBack: effectiveDays,
      message:
        importedCount > 0
          ? `Imported ${importedCount} eBay sale${importedCount === 1 ? "" : "s"}${delistedCount.total > 0 ? ` & queued ${delistedCount.total} auto-delist${delistedCount.total === 1 ? "" : "s"}` : ""}${updatedCount > 0 ? ` (${updatedCount} updated)` : ""}.`
          : updatedCount > 0
            ? `Updated ${updatedCount} existing eBay order${updatedCount === 1 ? "" : "s"} (all ${orders.length} orders already synced).`
            : `All ${orders.length} eBay orders from the past ${effectiveDays} days are already up to date.`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "eBay sales import failed";
    console.error("[/api/ebay/sync-sales] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
