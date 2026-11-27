import { NextResponse } from "next/server";
import {
  appendBulkBuyActivity,
  readBulkBuys,
  rebalanceBulkBuyCosts,
} from "@/lib/bulk-buy-costs";
import {
  recordDemoLocalFacebookSale,
  updateDemoSalesOrder,
} from "@/lib/demo-store";
import { isEbayConfigured, withdrawEbayOffer } from "@/lib/ebay";
import { deactivateEtsyListing, isEtsyConfigured } from "@/lib/etsy";
import { roundCurrency } from "@/lib/stale-engine";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type {
  InventoryItem,
  MarketplaceListing,
  MarketplaceType,
  RecordLocalFacebookSaleRequest,
  RecordLocalFacebookSaleResponse,
  SalesOrderUpdateRequest,
} from "@/lib/types";

function resolveSoldAtIso(raw?: string | null): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (trimmed === todayStr) return new Date().toISOString();
    return `${trimmed}T12:00:00.000Z`;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed)
    ? new Date().toISOString()
    : new Date(parsed).toISOString();
}

/**
 * POST /api/sales
 * Single entry point for recording a Local Facebook Marketplace sale:
 * - Supports both Quick Unlisted items (e.g. straight out of a Bulk Buy lot)
 *   and Existing Inventory SKUs (auto-delisting other channels if cross-listed).
 * - Defaults to $0 fees, $0 shipping, and completed ("shipped") status so it
 *   does not clutter the Pick List.
 * - Links to a Bulk Buy (when chosen) and automatically re-splits that Bulk
 *   Buy's COGS across unlocked items so Bulk Buys, Sales, Inventory, and Taxes
 *   all stay 100% in sync.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RecordLocalFacebookSaleRequest;
    const mode = body.mode === "existing" ? "existing" : "unlisted";
    const salePrice = roundCurrency(Number(body.salePrice || 0));

    if (!Number.isFinite(salePrice) || salePrice <= 0) {
      return NextResponse.json(
        { error: "Enter a valid sale price greater than $0." },
        { status: 400 }
      );
    }

    if (mode === "unlisted" && !body.title?.trim()) {
      return NextResponse.json(
        { error: "Enter an item title for this local Facebook sale." },
        { status: 400 }
      );
    }
    if (mode === "existing" && !body.itemId?.trim()) {
      return NextResponse.json(
        { error: "Select an inventory item to mark sold." },
        { status: 400 }
      );
    }

    const soldAtIso = resolveSoldAtIso(body.soldAt);
    const paymentMethod = (body.paymentMethod || "Cash").trim() || "Cash";
    const buyerName = body.buyerName?.trim() || null;
    const notes = body.notes?.trim() || null;
    const bulkBuyId = body.bulkBuyId?.trim() || null;
    const standaloneCogs = roundCurrency(
      Math.max(0, Number(body.standaloneCogs || 0))
    );
    const marketplaceFees = roundCurrency(
      Math.max(0, Number(body.marketplaceFees || 0))
    );
    const shippingCost = roundCurrency(
      Math.max(0, Number(body.shippingCost || 0))
    );
    const rawImageUrl = (body.imageUrl || "").trim();
    const cleanImageUrl =
      rawImageUrl &&
      (/^(https?:\/\/|data:image\/)/i.test(rawImageUrl))
        ? rawImageUrl
        : null;

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (!supabase || !envReadiness.isSupabaseReady) {
      const demo = recordDemoLocalFacebookSale({
        mode,
        itemId: body.itemId,
        title: body.title,
        sku: body.sku,
        salePrice,
        soldAtIso,
        paymentMethod,
        buyerName,
        notes,
        bulkBuyId,
        standaloneCogs,
        marketplaceFees,
        shippingCost,
        imageUrl: cleanImageUrl,
      });
      const resp: RecordLocalFacebookSaleResponse = {
        mode: "demo",
        ...demo,
        bulkBuyName: null,
        message: `Logged local FB sale: ${demo.title} ($${salePrice.toFixed(2)}, ${paymentMethod}).`,
      };
      return NextResponse.json(resp);
    }

    const nowIso = new Date().toISOString();
    const shortTag = Date.now().toString(36).slice(-5).toUpperCase();

    // Load selected Bulk Buy (if any)
    const { bulkBuys } = await readBulkBuys(supabase);
    const selectedBulkBuy = bulkBuyId
      ? bulkBuys.find((b) => b.id === bulkBuyId) || null
      : null;

    if (bulkBuyId && !selectedBulkBuy) {
      return NextResponse.json(
        { error: "Selected Bulk Buy was not found." },
        { status: 404 }
      );
    }

    let itemId = "";
    let finalSku = "";
    let finalTitle = "";
    let previousBulkBuyId: string | null = null;
    const delistedChannels: MarketplaceType[] = [];

    const trackingLabel = `Local Pickup (${paymentMethod}${buyerName ? ` · ${buyerName}` : ""})`;
    const saleLogDetail = [
      `Sold locally on Facebook Marketplace for $${salePrice.toFixed(2)}`,
      paymentMethod,
      buyerName ? `Buyer: ${buyerName}` : null,
      selectedBulkBuy ? `Bulk Buy: ${selectedBulkBuy.name}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (mode === "unlisted") {
      finalTitle = body.title!.trim().slice(0, 200);
      const lotPrefix = selectedBulkBuy?.lot_code?.trim().toUpperCase();
      const baseSku =
        body.sku?.trim() ||
        (lotPrefix ? `${lotPrefix}-FB-${shortTag}` : `FB-LOCAL-${shortTag}`);

      const specs: Record<string, unknown> = {
        fb_local_only: "true",
        fb_payment_method: paymentMethod,
        ...(buyerName ? { fb_buyer_name: buyerName } : {}),
        ...(selectedBulkBuy
          ? {
              bulk_buy_id: selectedBulkBuy.id,
              bulk_buy_locked: false,
            }
          : {}),
      };

      const activityEvents = appendBulkBuyActivity(specs, {
        type: "sold",
        timestamp: soldAtIso,
        title: "Sold on Facebook Marketplace (Local)",
        detail: saleLogDetail,
      });
      if (selectedBulkBuy) {
        activityEvents.push({
          id: `evt-${Date.now()}-bb`,
          type: "bulk_buy_added",
          timestamp: nowIso,
          title: `Linked to Bulk Buy: ${selectedBulkBuy.name}`,
          detail: `Shared lot cost re-split across ${selectedBulkBuy.name}`,
        });
      }
      specs.activity_log = activityEvents;

      const noteChunks = [
        notes,
        buyerName ? `FB Buyer: ${buyerName}` : null,
        `Local FB Pickup (${paymentMethod})`,
      ].filter(Boolean);

      const insertPayload = {
        sku: baseSku,
        title: finalTitle,
        condition: "Used",
        cogs: selectedBulkBuy ? 0 : standaloneCogs,
        prep_cost: 0,
        target_price: salePrice,
        floor_price: salePrice,
        bin_location: "Local Pickup",
        source_location: selectedBulkBuy?.source_location || "Facebook Local",
        source_type: selectedBulkBuy?.source_type || "thrift",
        payment_method: paymentMethod,
        notes: noteChunks.join(" · "),
        item_specifics: specs,
        image_urls: cleanImageUrl ? [cleanImageUrl] : [],
        status: "sold" as const,
        acquired_at: selectedBulkBuy?.purchase_date || soldAtIso,
        updated_at: nowIso,
      };

      let createdItem: InventoryItem | null = null;
      const { data: firstTry, error: firstErr } = await supabase
        .from("inventory_items")
        .insert(insertPayload)
        .select("*")
        .single();

      if (firstErr || !firstTry) {
        const retrySku = `${baseSku}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
        const { data: retryData, error: retryErr } = await supabase
          .from("inventory_items")
          .insert({ ...insertPayload, sku: retrySku })
          .select("*")
          .single();
        if (retryErr || !retryData) {
          throw new Error(
            retryErr?.message || firstErr?.message || "Failed creating item record"
          );
        }
        createdItem = retryData as InventoryItem;
      } else {
        createdItem = firstTry as InventoryItem;
      }

      itemId = createdItem.id;
      finalSku = createdItem.sku;
      finalTitle = createdItem.title;
    } else {
      // mode === "existing"
      const { data: existingData, error: fetchErr } = await supabase
        .from("inventory_items")
        .select("*")
        .eq("id", body.itemId!.trim())
        .single();
      if (fetchErr || !existingData) {
        return NextResponse.json(
          { error: "Selected inventory item not found." },
          { status: 404 }
        );
      }
      const existingItem = existingData as InventoryItem;
      itemId = existingItem.id;
      finalSku = existingItem.sku;
      finalTitle = existingItem.title;

      const existingSpecs = (existingItem.item_specifics || {}) as Record<
        string,
        unknown
      >;
      previousBulkBuyId =
        typeof existingSpecs.bulk_buy_id === "string" &&
        existingSpecs.bulk_buy_id.trim()
          ? existingSpecs.bulk_buy_id.trim()
          : null;

      const rawQty = Number(existingSpecs.quantity_available);
      const qtyAvail =
        Number.isFinite(rawQty) && rawQty > 1 ? Math.floor(rawQty) : 1;
      const isMultiQtyRemaining = qtyAvail > 1;

      const nextSpecs: Record<string, unknown> = {
        ...existingSpecs,
        fb_payment_method: paymentMethod,
        ...(buyerName ? { fb_buyer_name: buyerName } : {}),
        ...(isMultiQtyRemaining
          ? { quantity_available: String(qtyAvail - 1) }
          : {}),
      };

      if (selectedBulkBuy) {
        const alreadySameLot = previousBulkBuyId === selectedBulkBuy.id;
        nextSpecs.bulk_buy_id = selectedBulkBuy.id;
        if (!alreadySameLot) {
          nextSpecs.bulk_buy_locked = false;
        }
      }

      nextSpecs.activity_log = appendBulkBuyActivity(nextSpecs, {
        type: "sold",
        timestamp: soldAtIso,
        title: "Sold on Facebook Marketplace (Local)",
        detail: saleLogDetail,
      });

      const itemUpdate: Record<string, unknown> = {
        status: isMultiQtyRemaining ? "active" : "sold",
        payment_method: paymentMethod,
        item_specifics: nextSpecs,
        updated_at: nowIso,
      };
      if (cleanImageUrl) {
        const prevImgs = Array.isArray(existingItem.image_urls)
          ? existingItem.image_urls
          : [];
        itemUpdate.image_urls = [
          cleanImageUrl,
          ...prevImgs.filter((u) => u !== cleanImageUrl),
        ];
      }
      if (notes) {
        itemUpdate.notes = existingItem.notes
          ? `${existingItem.notes} · FB Local: ${notes}`
          : `FB Local: ${notes}`;
      }
      if (!selectedBulkBuy && standaloneCogs > 0 && Number(existingItem.cogs || 0) <= 0) {
        itemUpdate.cogs = standaloneCogs;
      }

      const { error: updErr } = await supabase
        .from("inventory_items")
        .update(itemUpdate)
        .eq("id", existingItem.id);
      if (updErr) {
        throw new Error(`Failed updating inventory item: ${updErr.message}`);
      }

      // If single-qty item is now sold out, auto-delist from all other active channels!
      if (!isMultiQtyRemaining) {
        const { data: listingsData } = await supabase
          .from("marketplace_listings")
          .select("*")
          .eq("item_id", existingItem.id)
          .in("status", ["active", "draft"]);

        const activeListings = (listingsData ?? []) as MarketplaceListing[];
        for (const lst of activeListings) {
          if (lst.marketplace === "facebook") {
            await supabase
              .from("marketplace_listings")
              .update({ status: "sold", last_synced_at: nowIso })
              .eq("id", lst.id);
            continue;
          }

          if (lst.marketplace === "ebay" || lst.marketplace === "etsy") {
            try {
              if (
                lst.marketplace === "ebay" &&
                lst.external_listing_id &&
                isEbayConfigured()
              ) {
                await withdrawEbayOffer(lst.external_listing_id, existingItem.sku);
              } else if (
                lst.marketplace === "etsy" &&
                lst.external_listing_id &&
                isEtsyConfigured()
              ) {
                await deactivateEtsyListing(lst.external_listing_id);
              }
            } catch (delistErr) {
              console.warn(
                `[/api/sales] Auto-delist warning (${lst.marketplace} ${existingItem.sku}):`,
                delistErr
              );
            }
            await supabase
              .from("marketplace_listings")
              .update({ status: "ended", last_synced_at: nowIso })
              .eq("id", lst.id);
            delistedChannels.push(lst.marketplace);
          } else {
            await supabase.from("channel_jobs").insert({
              item_id: existingItem.id,
              listing_id: lst.id,
              marketplace: lst.marketplace,
              action: "delist",
              execution_mode: "extension",
              payload: {
                sku: existingItem.sku,
                title: existingItem.title,
                externalListingId: lst.external_listing_id,
                externalUrl: lst.external_url,
                soldOn: "facebook",
              },
              status: "pending",
              attempts: 0,
            });
            delistedChannels.push(lst.marketplace);
          }
        }
      }
    }

    // Insert the completed sales_orders ledger record (net_profit is DB-generated)
    const { data: createdOrder, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({
        item_id: itemId,
        marketplace: "facebook",
        external_order_id: `FB-LOCAL-${shortTag}`,
        gross_sale_price: salePrice,
        marketplace_fees: marketplaceFees,
        shipping_cost: shippingCost,
        refund_amount: 0,
        fulfillment_status: "shipped",
        tracking_number: trackingLabel,
        shipped_at: soldAtIso,
        restocked: false,
        sold_at: soldAtIso,
      })
      .select("id")
      .single();

    if (orderErr || !createdOrder) {
      throw new Error(
        `Failed saving Facebook sale to sales_orders: ${orderErr?.message || "Unknown error"}`
      );
    }

    // Re-split Bulk Buy COGS automatically (and old lot if moved between Bulk Buys)
    let rebalancedCount = 0;
    let perShareCost: number | undefined;
    if (selectedBulkBuy) {
      const reb = await rebalanceBulkBuyCosts(supabase, selectedBulkBuy);
      rebalancedCount = reb.rebalancedCount;
      perShareCost = reb.perShareCost;
    }
    if (previousBulkBuyId && previousBulkBuyId !== selectedBulkBuy?.id) {
      const prevLot = bulkBuys.find((b) => b.id === previousBulkBuyId);
      if (prevLot) {
        await rebalanceBulkBuyCosts(supabase, prevLot);
      }
    }

    // Read final COGS applied to this item after rebalancing
    const { data: finalItemRow } = await supabase
      .from("inventory_items")
      .select("cogs")
      .eq("id", itemId)
      .single();
    const cogsApplied = roundCurrency(Number(finalItemRow?.cogs ?? 0));

    const summaryParts = [
      `$${salePrice.toFixed(2)} (${paymentMethod})`,
      selectedBulkBuy
        ? `credited to ${selectedBulkBuy.name} & re-split COGS ($${cogsApplied.toFixed(2)}/item)`
        : cogsApplied > 0
          ? `COGS $${cogsApplied.toFixed(2)}`
          : null,
      delistedChannels.length > 0
        ? `auto-delisted ${delistedChannels.map((c) => c.toUpperCase()).join(", ")}`
        : null,
    ].filter(Boolean);

    const response: RecordLocalFacebookSaleResponse = {
      mode: "live",
      orderId: String(createdOrder.id),
      itemId,
      sku: finalSku,
      title: finalTitle,
      grossSalePrice: salePrice,
      cogsApplied,
      bulkBuyName: selectedBulkBuy?.name ?? null,
      rebalancedCount,
      perShareCost,
      delistedChannels,
      message: `${finalTitle} — ${summaryParts.join(" · ")}.`,
    };

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to record local Facebook sale",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as SalesOrderUpdateRequest;
    if (!body?.orderId) {
      return NextResponse.json(
        { error: "Missing required orderId" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (supabase && envReadiness.isSupabaseReady) {
      const updates: Record<string, unknown> = {};
      if (body.fulfillment_status) {
        updates.fulfillment_status = body.fulfillment_status;
        if (body.fulfillment_status === "shipped") {
          updates.shipped_at = new Date().toISOString();
        }
      }
      if (body.tracking_number !== undefined) {
        updates.tracking_number = body.tracking_number;
      }
      if (body.refund_amount !== undefined) {
        updates.refund_amount = body.refund_amount;
      }
      if (body.return_reason !== undefined) {
        updates.return_reason = body.return_reason;
      }
      if (body.restockAndRelist) {
        updates.restocked = true;
      }
      if (
        typeof body.shipping_cost === "number" &&
        Number.isFinite(body.shipping_cost) &&
        body.shipping_cost >= 0
      ) {
        updates.shipping_cost = Math.round(body.shipping_cost * 100) / 100;
      }

      // Fetch current order if we need item_id or net_profit recalculation
      const { data: currentOrder, error: fetchErr } = await supabase
        .from("sales_orders")
        .select("*")
        .eq("id", body.orderId)
        .single();

      if (fetchErr || !currentOrder) {
        return NextResponse.json(
          { error: fetchErr?.message || "Order not found" },
          { status: 404 }
        );
      }

      let order = currentOrder;
      if (Object.keys(updates).length > 0) {
        const { data: updatedOrder, error } = await supabase
          .from("sales_orders")
          .update(updates)
          .eq("id", body.orderId)
          .select("*")
          .single();

        if (error || !updatedOrder) {
          return NextResponse.json(
            { error: error?.message || "Order update failed" },
            { status: 400 }
          );
        }
        order = updatedOrder;
      }

      if (
        typeof body.cogs === "number" &&
        Number.isFinite(body.cogs) &&
        body.cogs >= 0 &&
        order.item_id
      ) {
        await supabase
          .from("inventory_items")
          .update({
            cogs: Math.round(body.cogs * 100) / 100,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.item_id);
      }

      if (body.image_url !== undefined && order.item_id) {
        const trimmedImg =
          typeof body.image_url === "string" ? body.image_url.trim() : "";
        const validImg =
          trimmedImg && /^(https?:\/\/|data:image\/)/i.test(trimmedImg)
            ? trimmedImg
            : null;
        const { data: invRow } = await supabase
          .from("inventory_items")
          .select("image_urls")
          .eq("id", order.item_id)
          .maybeSingle();
        const prevImgs = Array.isArray(invRow?.image_urls)
          ? (invRow.image_urls as string[])
          : [];
        const nextImgs = validImg
          ? [validImg, ...prevImgs.filter((u) => u !== validImg)]
          : [];
        const { error: imgErr } = await supabase
          .from("inventory_items")
          .update({
            image_urls: nextImgs,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.item_id);
        if (imgErr) {
          return NextResponse.json(
            { error: `Failed to save photo: ${imgErr.message}` },
            { status: 400 }
          );
        }
      }

      if (
        typeof body.quantity === "number" &&
        Number.isFinite(body.quantity) &&
        body.quantity >= 1 &&
        order.item_id
      ) {
        const cleanQty = Math.min(999, Math.max(1, Math.floor(body.quantity)));
        const { data: invRow } = await supabase
          .from("inventory_items")
          .select("item_specifics")
          .eq("id", order.item_id)
          .maybeSingle();
        const prevSpecs =
          invRow?.item_specifics && typeof invRow.item_specifics === "object"
            ? { ...(invRow.item_specifics as Record<string, unknown>) }
            : {};
        const prevQtys =
          prevSpecs.order_quantities &&
          typeof prevSpecs.order_quantities === "object"
            ? { ...(prevSpecs.order_quantities as Record<string, number>) }
            : {};
        const prevOverrides =
          prevSpecs.order_quantity_overrides &&
          typeof prevSpecs.order_quantity_overrides === "object"
            ? {
                ...(prevSpecs.order_quantity_overrides as Record<
                  string,
                  boolean
                >),
              }
            : {};

        prevQtys[order.id] = cleanQty;
        prevOverrides[order.id] = true;
        if (order.external_order_id) {
          prevQtys[order.external_order_id] = cleanQty;
          prevOverrides[order.external_order_id] = true;
        }

        const { error: qtyErr } = await supabase
          .from("inventory_items")
          .update({
            item_specifics: {
              ...prevSpecs,
              order_quantities: prevQtys,
              order_quantity_overrides: prevOverrides,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.item_id);
        if (qtyErr) {
          return NextResponse.json(
            { error: `Failed to save quantity: ${qtyErr.message}` },
            { status: 400 }
          );
        }
      }

      if (body.restockAndRelist && order.item_id) {
        const nowIso = new Date().toISOString();
        await supabase
          .from("inventory_items")
          .update({ status: "active", updated_at: nowIso })
          .eq("id", order.item_id);
        await supabase
          .from("marketplace_listings")
          .update({
            status: "active",
            listed_at: nowIso,
            views_count: 0,
            watchers_count: 0,
          })
          .eq("item_id", order.item_id)
          .eq("marketplace", "ebay");
      }

      return NextResponse.json({
        mode: "live",
        order,
        restocked: Boolean(body.restockAndRelist),
      });
    }

    const result = updateDemoSalesOrder(body);
    if (!result) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    return NextResponse.json({ mode: "demo", ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update sales order",
      },
      { status: 500 }
    );
  }
}
