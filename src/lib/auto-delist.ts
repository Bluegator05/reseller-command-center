import {
  getDemoStore,
  recordDemoJob,
  recordDemoSaleAndDelist,
} from "./demo-store";
import { isEbayConfigured, withdrawEbayOffer } from "./ebay";
import { deactivateEtsyListing, isEtsyConfigured } from "./etsy";
import { roundCurrency } from "./stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "./supabase";
import type {
  AutoDelistCascadeItem,
  AutoDelistCascadeResult,
  InventoryItem,
  MarketplaceListing,
  MarketplaceType,
  SalesOrderRecord,
} from "./types";

const DEFAULT_FEES: Record<MarketplaceType, number> = {
  ebay: 13.25,
  etsy: 9.5,
  poshmark: 20.0,
  mercari: 10.0,
  facebook: 5.0,
};

export interface ProcessSaleInput {
  itemId?: string;
  sku?: string;
  externalListingId?: string;
  marketplace: MarketplaceType;
  externalOrderId?: string | null;
  grossSalePrice?: number | null;
  shippingCost?: number;
  source: "webhook" | "inbound_email" | "manual";
}

/**
 * Atomic Anti-Double-Sell & Auto-Delist Cascade:
 * 1. Marks `inventory_items.status = 'sold'` and selling listing `'sold'`.
 * 2. Inserts a `sales_orders` ledger entry with calculated fees & net profit.
 * 3. Immediately delists all OTHER active API listings (eBay/Etsy) and queues
 *    urgent `action = 'delist'` extension jobs for Poshmark, Mercari, and FB Marketplace.
 */
export async function processSaleAndCascadeDelist(
  input: ProcessSaleInput
): Promise<AutoDelistCascadeResult> {
  const supabase = getSupabaseServerClient();
  const useLive = Boolean(supabase && isSupabaseConfigured());

  if (!useLive || !supabase) {
    return recordDemoSaleAndDelist(input);
  }

  // 1. Resolve master item
  let item: InventoryItem | null = null;
  if (input.itemId) {
    const { data } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("id", input.itemId)
      .maybeSingle();
    item = (data as InventoryItem | null) ?? null;
  }
  if (!item && input.sku) {
    const { data } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("sku", input.sku)
      .maybeSingle();
    item = (data as InventoryItem | null) ?? null;
  }
  if (!item && input.externalListingId) {
    const { data: lst } = await supabase
      .from("marketplace_listings")
      .select("item_id")
      .eq("external_listing_id", input.externalListingId)
      .maybeSingle();
    if (lst?.item_id) {
      const { data } = await supabase
        .from("inventory_items")
        .select("*")
        .eq("id", lst.item_id)
        .maybeSingle();
      item = (data as InventoryItem | null) ?? null;
    }
  }

  if (!item) {
    throw new Error(
      `Could not match sale to any inventory_items record (sku=${input.sku ?? "none"}, itemId=${input.itemId ?? "none"})`
    );
  }

  const nowIso = new Date().toISOString();
  const [{ data: listingsData }, { data: acctData }] = await Promise.all([
    supabase.from("marketplace_listings").select("*").eq("item_id", item.id),
    supabase
      .from("marketplace_accounts")
      .select("default_fee_pct")
      .eq("marketplace", input.marketplace)
      .maybeSingle(),
  ]);

  const itemListings = (listingsData ?? []) as MarketplaceListing[];
  const soldListing = itemListings.find(
    (l) => l.marketplace === input.marketplace
  );
  const grossPrice = roundCurrency(
    Number(
      input.grossSalePrice ??
        soldListing?.listed_price ??
        item.target_price
    )
  );
  const feePct = Number(
    acctData?.default_fee_pct ?? DEFAULT_FEES[input.marketplace]
  );
  const marketplaceFees = roundCurrency(grossPrice * (feePct / 100));
  const shippingCost = roundCurrency(Number(input.shippingCost ?? 0));

  // 2. Mark master item sold & update selling marketplace listing
  await supabase
    .from("inventory_items")
    .update({ status: "sold", updated_at: nowIso })
    .eq("id", item.id);

  if (soldListing) {
    await supabase
      .from("marketplace_listings")
      .update({ status: "sold", last_synced_at: nowIso })
      .eq("id", soldListing.id);
  }

  // 3. Record sales_orders ledger row
  const { data: orderRow, error: orderError } = await supabase
    .from("sales_orders")
    .insert({
      item_id: item.id,
      marketplace: input.marketplace,
      external_order_id:
        input.externalOrderId || `ORD-${Date.now().toString().slice(-6)}`,
      gross_sale_price: grossPrice,
      marketplace_fees: marketplaceFees,
      shipping_cost: shippingCost,
      sold_at: nowIso,
    })
    .select("*")
    .single();

  if (orderError || !orderRow) {
    throw orderError || new Error("Failed to insert sales_orders row");
  }

  // 4. Cascade delist across all OTHER active/draft listings
  const otherListings = itemListings.filter(
    (l) =>
      l.marketplace !== input.marketplace &&
      (l.status === "active" || l.status === "draft")
  );

  const cascadedDelists: AutoDelistCascadeItem[] = [];

  for (const other of otherListings) {
    const isApi = other.marketplace === "ebay" || other.marketplace === "etsy";
    const executionMode = isApi ? "api" : "extension";

    const { data: jobRow } = await supabase
      .from("channel_jobs")
      .insert({
        item_id: item.id,
        listing_id: other.id,
        marketplace: other.marketplace,
        action: "delist",
        execution_mode: executionMode,
        payload: {
          sku: item.sku,
          title: item.title,
          externalListingId: other.external_listing_id,
          externalUrl: other.external_url,
          reason: `SOLD_ON_${input.marketplace.toUpperCase()}`,
          soldOrderId: orderRow.external_order_id,
        },
        status: isApi ? "processing" : "pending",
        attempts: isApi ? 1 : 0,
        started_at: isApi ? nowIso : null,
      })
      .select("id")
      .single();

    const jobId = jobRow?.id ?? `delist-${other.marketplace}`;

    if (isApi) {
      try {
        if (
          other.marketplace === "ebay" &&
          other.external_listing_id &&
          isEbayConfigured()
        ) {
          await withdrawEbayOffer(other.external_listing_id);
        } else if (
          other.marketplace === "etsy" &&
          other.external_listing_id &&
          isEtsyConfigured()
        ) {
          await deactivateEtsyListing(other.external_listing_id);
        }

        await supabase
          .from("marketplace_listings")
          .update({ status: "ended", last_synced_at: nowIso })
          .eq("id", other.id);

        await supabase
          .from("channel_jobs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        cascadedDelists.push({
          marketplace: other.marketplace,
          executionMode: "api",
          status: "delisted",
          jobId,
          message: `Ended ${other.marketplace.toUpperCase()} listing #${other.external_listing_id} via API`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "API delist failed";
        await supabase
          .from("channel_jobs")
          .update({
            status: "failed",
            error_message: msg,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        cascadedDelists.push({
          marketplace: other.marketplace,
          executionMode: "api",
          status: "failed",
          jobId,
          message: msg,
        });
      }
    } else {
      cascadedDelists.push({
        marketplace: other.marketplace,
        executionMode: "extension",
        status: "queued_extension",
        jobId,
        message: `Queued urgent delist job for ${other.marketplace.toUpperCase()} Extension`,
      });
    }
  }

  const netProfit = roundCurrency(grossPrice - marketplaceFees - shippingCost);
  const cogs = Number(item.cogs);
  const order: SalesOrderRecord = {
    id: orderRow.id,
    item_id: item.id,
    sku: item.sku,
    title: item.title,
    marketplace: input.marketplace,
    external_order_id: orderRow.external_order_id,
    gross_sale_price: grossPrice,
    marketplace_fees: marketplaceFees,
    shipping_cost: shippingCost,
    cogs,
    net_profit: netProfit,
    true_net_after_cogs: roundCurrency(netProfit - cogs),
    sold_at: orderRow.sold_at,
    delisted_channels: cascadedDelists
      .filter((c) => c.status === "delisted")
      .map((c) => c.marketplace),
    pending_delist_channels: cascadedDelists
      .filter((c) => c.status !== "delisted")
      .map((c) => c.marketplace),
    source: input.source,
  };

  return {
    mode: "live",
    order,
    cascadedDelists,
    message:
      cascadedDelists.length > 0
        ? `Sold ${item.sku} on ${input.marketplace.toUpperCase()} ($${grossPrice.toFixed(2)}) — cascaded ${cascadedDelists.length} anti-double-sell delist${cascadedDelists.length === 1 ? "" : "s"}.`
        : `Sold ${item.sku} on ${input.marketplace.toUpperCase()} ($${grossPrice.toFixed(2)}) — no other active channels needed delisting.`,
  };
}

/**
 * Helper to fetch active inventory items for fuzzy order-email matching.
 */
export async function getActiveInventoryForMatching(): Promise<InventoryItem[]> {
  const supabase = getSupabaseServerClient();
  if (supabase && isSupabaseConfigured()) {
    const { data } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("status", "active");
    if (data && data.length > 0) {
      return data as InventoryItem[];
    }
  }
  const store = getDemoStore();
  return store.items.filter((i) => i.status === "active");
}

export function getDemoJobRecorder() {
  return recordDemoJob;
}

/**
 * Safe cascade helper for live eBay / Poshmark / Mercari sale syncs.
 * Only called for BRAND-NEW recent paid sales (within last 7 days) so historical
 * sales imports can never accidentally end active listings.
 */
export async function cascadeDelistOtherChannelsForSoldItem(params: {
  itemId: string;
  soldOnMarketplace: MarketplaceType;
  externalOrderId: string;
  sku?: string;
  title?: string;
}): Promise<AutoDelistCascadeItem[]> {
  const supabase = getSupabaseServerClient();
  if (!supabase || !isSupabaseConfigured()) return [];

  const nowIso = new Date().toISOString();
  const { data: listingsData } = await supabase
    .from("marketplace_listings")
    .select("*")
    .eq("item_id", params.itemId);

  const itemListings = (listingsData ?? []) as MarketplaceListing[];
  if (itemListings.length === 0) return [];

  // Mark selling channel's listing sold
  const soldListing = itemListings.find(
    (l) => l.marketplace === params.soldOnMarketplace
  );
  if (soldListing && soldListing.status !== "sold") {
    await supabase
      .from("marketplace_listings")
      .update({ status: "sold", last_synced_at: nowIso })
      .eq("id", soldListing.id);
  }

  const otherListings = itemListings.filter(
    (l) =>
      l.marketplace !== params.soldOnMarketplace &&
      (l.status === "active" || l.status === "draft")
  );

  // Mark master inventory item sold
  await supabase
    .from("inventory_items")
    .update({ status: "sold", updated_at: nowIso })
    .eq("id", params.itemId);

  if (otherListings.length === 0) return [];

  // Check existing delist jobs for this item to prevent duplicate delist jobs
  const { data: existingDelists } = await supabase
    .from("channel_jobs")
    .select("marketplace, status")
    .eq("item_id", params.itemId)
    .eq("action", "delist")
    .in("status", ["pending", "processing", "completed"]);

  const alreadyQueuedSet = new Set(
    (existingDelists ?? []).map((j) => String(j.marketplace))
  );

  const results: AutoDelistCascadeItem[] = [];

  for (const other of otherListings) {
    if (alreadyQueuedSet.has(other.marketplace)) continue;

    const isApi = other.marketplace === "ebay" || other.marketplace === "etsy";
    const executionMode = isApi ? "api" : "extension";

    const { data: jobRow } = await supabase
      .from("channel_jobs")
      .insert({
        item_id: params.itemId,
        listing_id: other.id,
        marketplace: other.marketplace,
        action: "delist",
        execution_mode: executionMode,
        payload: {
          sku: params.sku || "",
          title: params.title || "",
          externalListingId: other.external_listing_id,
          externalUrl: other.external_url,
          reason: `SOLD_ON_${params.soldOnMarketplace.toUpperCase()}`,
          soldOrderId: params.externalOrderId,
        },
        status: isApi ? "processing" : "pending",
        attempts: isApi ? 1 : 0,
        started_at: isApi ? nowIso : null,
      })
      .select("id")
      .single();

    const jobId = jobRow?.id ?? `delist-${other.marketplace}`;

    if (isApi) {
      try {
        if (
          other.marketplace === "ebay" &&
          other.external_listing_id &&
          isEbayConfigured()
        ) {
          await withdrawEbayOffer(other.external_listing_id, params.sku);
        } else if (
          other.marketplace === "etsy" &&
          other.external_listing_id &&
          isEtsyConfigured()
        ) {
          await deactivateEtsyListing(other.external_listing_id);
        }

        await supabase
          .from("marketplace_listings")
          .update({ status: "ended", last_synced_at: nowIso })
          .eq("id", other.id);

        await supabase
          .from("channel_jobs")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        results.push({
          marketplace: other.marketplace,
          executionMode: "api",
          status: "delisted",
          jobId,
          message: `Auto-ended ${other.marketplace.toUpperCase()} listing #${other.external_listing_id} via API`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "API delist failed";
        await supabase
          .from("channel_jobs")
          .update({
            status: "failed",
            error_message: msg,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        results.push({
          marketplace: other.marketplace,
          executionMode: "api",
          status: "failed",
          jobId,
          message: msg,
        });
      }
    } else {
      results.push({
        marketplace: other.marketplace,
        executionMode: "extension",
        status: "queued_extension",
        jobId,
        message: `Queued urgent ${other.marketplace.toUpperCase()} auto-delist job`,
      });
    }
  }

  return results;
}

