import { getDemoStore } from "./demo-store";
import { resolveBuyerCoords } from "./geo-lookup";
import { DEFAULT_EBAY_FEE_PCT, enrichStaleRadarRow, roundCurrency } from "./stale-engine";
import { getEnvReadiness, getSupabaseServerClient } from "./supabase";
import type {
  BulkBuyRecord,
  BusinessExpense,
  ChannelJob,
  CommandCenterPayload,
  CrossChannelListingSummary,
  DisposedInventoryRecord,
  InventoryAuditRecord,
  InventoryItem,
  ItemActivityEvent,
  MarketplaceAccount,
  MarketplaceListing,
  MarketplaceType,
  OrderFulfillmentStatus,
  SalesOrderRecord,
  StaleRadarRow,
} from "./types";

interface JoinedListingRecord extends MarketplaceListing {
  inventory_items: InventoryItem | InventoryItem[] | null;
}

function emptyChannelCounts(): Record<MarketplaceType, number> {
  return { ebay: 0, etsy: 0, poshmark: 0, mercari: 0, facebook: 0 };
}

export async function loadCommandCenterData(): Promise<CommandCenterPayload> {
  const envReadiness = getEnvReadiness();
  const supabase = getSupabaseServerClient();

  let supabaseError: string | null = null;

  if (supabase && envReadiness.isSupabaseReady) {
    try {
      const runWithRetry = async <T>(
        fn: () => Promise<T>,
        maxAttempts = 2
      ): Promise<T> => {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await fn();
          } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, 600 * attempt));
            }
          }
        }
        throw lastErr;
      };

      const fetchAllActiveListings = async (): Promise<JoinedListingRecord[]> => {
        const all: JoinedListingRecord[] = [];
        const pageSize = 350;
        for (let from = 0; from < 5000; from += pageSize) {
          const rows = await runWithRetry(async () => {
            const { data: page, error } = await supabase
              .from("marketplace_listings")
              .select("*, inventory_items(*)")
              .in("status", ["active", "draft"])
              .order("listed_at", { ascending: false, nullsFirst: false })
              .order("id", { ascending: false })
              .range(from, from + pageSize - 1);
            if (error) throw error;
            return (page ?? []) as JoinedListingRecord[];
          });
          all.push(...rows);
          if (rows.length < pageSize) break;
        }
        return all;
      };

      const fetchAllSalesOrders = async () => {
        const all: unknown[] = [];
        const pageSize = 400;
        for (let from = 0; from < 2000; from += pageSize) {
          const rows = await runWithRetry(async () => {
            const { data: page, error } = await supabase
              .from("sales_orders")
              .select(
                "*, inventory_items(sku, title, image_urls, cogs, prep_cost, source_location, source_type, acquired_at, bin_location, weight_oz, length_in, width_in, height_in, item_specifics, created_at)"
              )
              .order("sold_at", { ascending: false })
              .range(from, from + pageSize - 1);
            if (error) throw error;
            return page ?? [];
          });
          all.push(...rows);
          if (rows.length < pageSize) break;
        }
        return { data: all };
      };

      const [
        joinedRows,
        accountsRes,
        jobsRes,
        delistStatusRes,
        ordersRes,
        draftsRes,
        expensesRes,
        auditLogRes,
        bulkBuysRes,
        archivedRes,
      ] = await Promise.all([
        fetchAllActiveListings(),
        supabase.from("marketplace_accounts").select("*"),
        supabase
          .from("channel_jobs")
          .select("*, inventory_items(sku, title)")
          .order("created_at", { ascending: false })
          .limit(50),
        supabase
          .from("channel_jobs")
          .select("item_id, marketplace, status")
          .eq("action", "delist")
          .order("created_at", { ascending: false })
          .limit(500),
        fetchAllSalesOrders(),
        supabase
          .from("inventory_items")
          .select("*")
          .eq("status", "draft")
          .order("acquired_at", { ascending: true }),
        supabase
          .from("business_expenses")
          .select("*")
          .order("expense_date", { ascending: false })
          .limit(500),
        supabase
          .from("inventory_items")
          .select("item_specifics")
          .eq("sku", "__RCC_AUDIT_LOG__")
          .maybeSingle(),
        supabase
          .from("inventory_items")
          .select("item_specifics")
          .eq("sku", "__RCC_BULK_BUYS__")
          .maybeSingle(),
        supabase
          .from("inventory_items")
          .select(
            "id, sku, title, image_urls, cogs, prep_cost, bin_location, source_location, source_type, acquired_at, item_specifics, updated_at"
          )
          .eq("status", "archived")
          .order("updated_at", { ascending: false })
          .limit(500),
      ]);

      const rawAuditHistory = (
        auditLogRes.data?.item_specifics as
          | { audit_history?: unknown }
          | undefined
      )?.audit_history;
      const auditHistory: InventoryAuditRecord[] = Array.isArray(rawAuditHistory)
        ? (rawAuditHistory as InventoryAuditRecord[])
        : [];

      const rawBulkBuys = (
        bulkBuysRes.data?.item_specifics as
          | { bulk_buys?: unknown }
          | undefined
      )?.bulk_buys;
      const bulkBuys: BulkBuyRecord[] = Array.isArray(rawBulkBuys)
        ? (rawBulkBuys as BulkBuyRecord[])
        : [];

      const disposedItems: DisposedInventoryRecord[] = [];
      for (const rawArch of archivedRes.data ?? []) {
        const row = rawArch as {
          id: string;
          sku: string;
          title: string;
          image_urls?: string[] | null;
          cogs?: number;
          prep_cost?: number;
          bin_location?: string | null;
          source_location?: string | null;
          source_type?: string | null;
          acquired_at?: string | null;
          item_specifics?: Record<string, unknown> | null;
          updated_at?: string;
        };
        if (row.sku?.startsWith("__RCC_")) continue;
        const sp = (row.item_specifics || {}) as Record<string, unknown>;
        const disp = sp.disposal_status ?? sp.disposition;
        if (disp !== "donated" && disp !== "discarded") continue;
        disposedItems.push({
          id: row.id,
          sku: row.sku,
          title: row.title,
          image_url:
            Array.isArray(row.image_urls) && row.image_urls.length > 0
              ? row.image_urls[0] || null
              : null,
          cogs: Number(row.cogs ?? 0),
          prep_cost: Number(row.prep_cost ?? 0),
          bin_location: row.bin_location ?? null,
          source_location: row.source_location ?? null,
          source_type: row.source_type ?? null,
          acquired_at: row.acquired_at ?? null,
          disposal_status: disp,
          disposal_date:
            (typeof sp.disposal_date === "string" && sp.disposal_date) ||
            (typeof sp.disposition_at === "string" && sp.disposition_at) ||
            row.updated_at ||
            new Date().toISOString(),
          disposal_notes:
            typeof sp.disposal_notes === "string" ? sp.disposal_notes : null,
          bulk_buy_id:
            typeof sp.bulk_buy_id === "string" && sp.bulk_buy_id.trim()
              ? sp.bulk_buy_id.trim()
              : null,
          bulk_buy_locked:
            sp.bulk_buy_locked === true || sp.bulk_buy_locked === "true",
        });
      }

      const accounts = (accountsRes.data ?? []) as MarketplaceAccount[];
      const ebayFeePct =
        accounts.find((a) => a.marketplace === "ebay")?.default_fee_pct ??
        DEFAULT_EBAY_FEE_PCT;

      const crossMap = new Map<string, CrossChannelListingSummary[]>();
      const etsyListings: MarketplaceListing[] = [];
      const channelCounts = emptyChannelCounts();

      for (const row of joinedRows) {
        channelCounts[row.marketplace] =
          (channelCounts[row.marketplace] || 0) + 1;
        if (row.marketplace === "etsy") {
          etsyListings.push(row);
        }
        const summary: CrossChannelListingSummary = {
          listing_id: row.id,
          marketplace: row.marketplace,
          external_listing_id: row.external_listing_id,
          external_url: row.external_url,
          listed_price: Number(row.listed_price),
          status: row.status,
          views_count: row.views_count,
          watchers_count: row.watchers_count,
        };
        const list = crossMap.get(row.item_id) ?? [];
        list.push(summary);
        crossMap.set(row.item_id, list);
      }

      const items: StaleRadarRow[] = [];
      const activeEbayItemIds = new Set<string>();
      for (const row of joinedRows) {
        if (row.marketplace !== "ebay" || row.status !== "active") continue;
        const inv = Array.isArray(row.inventory_items)
          ? row.inventory_items[0]
          : row.inventory_items;
        if (!inv || inv.status === "sold" || inv.status === "archived") continue;
        activeEbayItemIds.add(row.item_id);
        items.push(
          enrichStaleRadarRow(
            row,
            inv,
            Number(ebayFeePct),
            crossMap.get(row.item_id) ?? []
          )
        );
      }
      // Also surface active Facebook-Local-Only items (oversized/local items with no eBay listing)
      for (const row of joinedRows) {
        if (row.marketplace !== "facebook" || row.status !== "active") continue;
        if (activeEbayItemIds.has(row.item_id)) continue;
        const inv = Array.isArray(row.inventory_items)
          ? row.inventory_items[0]
          : row.inventory_items;
        if (!inv || inv.status === "sold" || inv.status === "archived") continue;
        items.push(
          enrichStaleRadarRow(
            row,
            inv,
            0, // 0% fee for Facebook local pickup
            crossMap.get(row.item_id) ?? []
          )
        );
      }

      const allJobs: ChannelJob[] = (jobsRes.data ?? []).map((j) => {
        const record = j as ChannelJob & {
          inventory_items?:
            | { sku?: string; title?: string }
            | Array<{ sku?: string; title?: string }>
            | null;
        };
        const inv = Array.isArray(record.inventory_items)
          ? record.inventory_items[0]
          : record.inventory_items;
        return {
          ...record,
          item_sku: inv?.sku,
          item_title: inv?.title,
        };
      });

      const delistJobsByItem = new Map<
        string,
        Array<{ marketplace: MarketplaceType; status: string }>
      >();
      const rawDelistRows =
        Array.isArray(delistStatusRes.data) && delistStatusRes.data.length > 0
          ? (delistStatusRes.data as Array<{
              item_id: string;
              marketplace: MarketplaceType;
              status: string;
            }>)
          : allJobs
              .filter((j) => j.action === "delist")
              .map((j) => ({
                item_id: j.item_id,
                marketplace: j.marketplace,
                status: j.status,
              }));
      for (const dj of rawDelistRows) {
        if (!dj.item_id) continue;
        const list = delistJobsByItem.get(dj.item_id) ?? [];
        list.push({ marketplace: dj.marketplace, status: dj.status });
        delistJobsByItem.set(dj.item_id, list);
      }

      const salesOrders: SalesOrderRecord[] = (ordersRes.data ?? []).map((o) => {
        const rec = o as {
          id: string;
          item_id: string;
          marketplace: MarketplaceType;
          external_order_id: string | null;
          gross_sale_price: number;
          marketplace_fees: number;
          shipping_cost: number;
          refund_amount?: number;
          fulfillment_status?: OrderFulfillmentStatus;
          tracking_number?: string | null;
          shipped_at?: string | null;
          return_reason?: string | null;
          restocked?: boolean;
          net_profit: number;
          sold_at: string;
          inventory_items?:
            | {
                sku?: string;
                title?: string;
                image_urls?: string[] | null;
                cogs?: number;
                prep_cost?: number;
                source_location?: string | null;
                source_type?: string | null;
                acquired_at?: string | null;
                bin_location?: string | null;
                weight_oz?: number | null;
                length_in?: number | null;
                width_in?: number | null;
                height_in?: number | null;
                item_specifics?: Record<string, unknown> | null;
                created_at?: string | null;
              }
            | Array<{
                sku?: string;
                title?: string;
                image_urls?: string[] | null;
                cogs?: number;
                prep_cost?: number;
                source_location?: string | null;
                source_type?: string | null;
                acquired_at?: string | null;
                bin_location?: string | null;
                weight_oz?: number | null;
                length_in?: number | null;
                width_in?: number | null;
                height_in?: number | null;
                item_specifics?: Record<string, unknown> | null;
                created_at?: string | null;
              }>
            | null;
        };
        const inv = Array.isArray(rec.inventory_items)
          ? rec.inventory_items[0]
          : rec.inventory_items;
        const sp = (inv?.item_specifics || {}) as Record<string, unknown>;
        const cogs = Number(inv?.cogs ?? 0);
        const prepCost = Number(inv?.prep_cost ?? 0);
        const netProfit = Number(rec.net_profit ?? 0);
        const itemDelistJobs = delistJobsByItem.get(rec.item_id) ?? [];
        const delistedChannels = [
          ...new Set(
            itemDelistJobs
              .filter((j) => j.status === "completed")
              .map((j) => j.marketplace)
          ),
        ];
        const delistedSet = new Set(delistedChannels);
        const pendingDelistChannels = [
          ...new Set(
            itemDelistJobs
              .filter(
                (j) => j.status !== "completed" && !delistedSet.has(j.marketplace)
              )
              .map((j) => j.marketplace)
          ),
        ];
        const pkgDims =
          inv?.length_in && inv?.width_in && inv?.height_in
            ? `${inv.length_in}×${inv.width_in}×${inv.height_in} in`
            : null;
        const status: OrderFulfillmentStatus =
          rec.fulfillment_status ?? "shipped";
        const cogsApplied =
          rec.restocked || status === "unpaid" ? 0 : cogs + prepCost;
        const firstImage =
          Array.isArray(inv?.image_urls) && inv.image_urls.length > 0
            ? inv.image_urls[0] || null
            : null;

        // Per-order buyer location lookup (supports multi-qty items where each order has its own buyer!)
        const orderLocMap =
          sp.order_locations && typeof sp.order_locations === "object"
            ? (sp.order_locations as Record<
                string,
                {
                  city?: string | null;
                  state?: string | null;
                  postal?: string | null;
                  country?: string | null;
                }
              >)
            : null;
        const orderLoc =
          (rec.external_order_id && orderLocMap?.[rec.external_order_id]) || null;

        const resolvedCity =
          orderLoc?.city ??
          (typeof sp.buyer_city === "string" ? sp.buyer_city : null);
        const resolvedState =
          orderLoc?.state ??
          (typeof sp.buyer_state === "string" ? sp.buyer_state : null);
        const resolvedPostal =
          orderLoc?.postal ??
          (typeof sp.buyer_postal === "string" ? sp.buyer_postal : null);
        const resolvedCountry =
          orderLoc?.country ??
          (typeof sp.buyer_country === "string" ? sp.buyer_country : null);
        const resolvedCoords = resolveBuyerCoords({
          city: resolvedCity,
          state: resolvedState,
          postal: resolvedPostal,
          country: resolvedCountry,
        });

        const orderQtyMap =
          sp.order_quantities && typeof sp.order_quantities === "object"
            ? (sp.order_quantities as Record<string, unknown>)
            : null;
        const savedQtyRaw =
          (rec.external_order_id && orderQtyMap?.[rec.external_order_id]) ??
          orderQtyMap?.[rec.id];
        const hasSavedQty =
          savedQtyRaw !== undefined &&
          savedQtyRaw !== null &&
          Number.isFinite(Number(savedQtyRaw)) &&
          Number(savedQtyRaw) >= 1;
        const resolvedQuantity = hasSavedQty
          ? Math.floor(Number(savedQtyRaw))
          : 1;

        return {
          id: rec.id,
          item_id: rec.item_id,
          sku: inv?.sku || rec.item_id.slice(0, 8),
          title: inv?.title || "Sold Item",
          image_url: firstImage,
          marketplace: rec.marketplace,
          external_order_id: rec.external_order_id,
          quantity: resolvedQuantity,
          quantity_verified: hasSavedQty,
          gross_sale_price: Number(rec.gross_sale_price),
          marketplace_fees: Number(rec.marketplace_fees),
          ad_fee:
            Number.isFinite(Number(sp.ad_fee)) && Number(sp.ad_fee) > 0
              ? roundCurrency(Number(sp.ad_fee))
              : undefined,
          shipping_cost: Number(rec.shipping_cost),
          refund_amount: Number(rec.refund_amount ?? 0),
          cogs,
          prep_cost: prepCost,
          source_location: inv?.source_location ?? null,
          source_type: inv?.source_type ?? null,
          acquired_at: inv?.acquired_at ?? null,
          listed_at:
            (typeof sp.listed_at === "string" ? sp.listed_at : null) ??
            inv?.created_at ??
            inv?.acquired_at ??
            null,
          bin_location: inv?.bin_location ?? null,
          bulk_buy_id:
            typeof sp.bulk_buy_id === "string" && sp.bulk_buy_id.trim()
              ? sp.bulk_buy_id.trim()
              : null,
          bulk_buy_locked:
            sp.bulk_buy_locked === true || sp.bulk_buy_locked === "true",
          weight_oz: inv?.weight_oz ?? null,
          pkg_dimensions: pkgDims,
          fulfillment_status: status,
          tracking_number: rec.tracking_number ?? null,
          shipped_at: rec.shipped_at ?? null,
          return_reason: rec.return_reason ?? null,
          restocked: Boolean(rec.restocked),
          buyer_city: resolvedCity,
          buyer_state: resolvedState,
          buyer_postal: resolvedPostal,
          buyer_country: resolvedCountry,
          buyer_lat: resolvedCoords?.lat ?? null,
          buyer_lon: resolvedCoords?.lon ?? null,
          activity_log: Array.isArray(sp.activity_log)
            ? (sp.activity_log as ItemActivityEvent[])
            : [],
          net_profit: netProfit,
          true_net_after_cogs: roundCurrency(netProfit - cogsApplied),
          sold_at: rec.sold_at,
          delisted_channels: delistedChannels,
          pending_delist_channels: pendingDelistChannels,
          source:
            rec.marketplace === "ebay" || rec.marketplace === "etsy"
              ? "webhook"
              : "inbound_email",
        };
      });

      // Flag any active single-qty item that ALREADY has a paid/shipped sale in sales_orders
      // so ghost-active sold listings are immediately visible & 1-click reconcilable
      const paidSalesByItem = new Map<
        string,
        Array<{
          id: string;
          marketplace: MarketplaceType;
          external_order_id: string | null;
          sold_at: string;
          gross_sale_price: number;
        }>
      >();
      for (const ord of salesOrders) {
        if (
          ord.fulfillment_status === "unpaid" ||
          ord.fulfillment_status === "returned" ||
          ord.restocked
        ) {
          continue;
        }
        const list = paidSalesByItem.get(ord.item_id) ?? [];
        list.push({
          id: ord.id,
          marketplace: ord.marketplace,
          external_order_id: ord.external_order_id,
          sold_at: ord.sold_at,
          gross_sale_price: ord.gross_sale_price,
        });
        paidSalesByItem.set(ord.item_id, list);
      }
      const dismissedAtByItem = new Map<string, number>();
      for (const row of joinedRows) {
        const inv = Array.isArray(row.inventory_items)
          ? row.inventory_items[0]
          : row.inventory_items;
        const sp = (inv?.item_specifics || {}) as Record<string, unknown>;
        if (typeof sp.sold_conflict_dismissed_at === "string") {
          const ms = Date.parse(sp.sold_conflict_dismissed_at);
          if (!Number.isNaN(ms)) dismissedAtByItem.set(row.item_id, ms);
        }
      }

      for (const item of items) {
        if ((item.quantity_available ?? 1) > 1 || (item.quantity_purchased ?? 1) > 1) {
          continue;
        }
        const rawConflicts = paidSalesByItem.get(item.item_id);
        if (!rawConflicts || rawConflicts.length === 0) continue;

        const syncedMs = item.last_synced_at ? Date.parse(item.last_synced_at) : NaN;
        const dismissedMs = dismissedAtByItem.get(item.item_id) ?? NaN;
        const conflicts = rawConflicts.filter((ord) => {
          const soldMs = Date.parse(ord.sold_at);
          // If the user explicitly dismissed this conflict ("Keep Active"), ignore older sales
          if (!Number.isNaN(dismissedMs) && !Number.isNaN(soldMs) && soldMs <= dismissedMs) {
            return false;
          }
          // If this sale was on eBay and we ALREADY synced live eBay AFTER the sale
          // timestamp, eBay itself confirmed this listing is still live with qty >= 1
          // (e.g. a multi-qty listing with 1 unit left, or restocked/relisted on eBay).
          if (ord.marketplace === "ebay" && !Number.isNaN(syncedMs)) {
            if (!Number.isNaN(soldMs) && syncedMs > soldMs + 5 * 60_000) {
              return false;
            }
          }
          return true;
        });

        if (conflicts.length > 0) {
          item.sold_conflict_orders = conflicts;
        }
      }

      const lastSyncedAt =
        items
          .map((i) => i.last_synced_at)
          .filter((v): v is string => Boolean(v))
          .sort()
          .at(-1) ?? null;

      const etsyLastSyncedAt =
        etsyListings
          .map((l) => l.last_synced_at)
          .filter((v): v is string => Boolean(v))
          .sort()
          .at(-1) ?? null;

      return {
        mode: "live",
        envReadiness,
        items,
        draftItems: (draftsRes.data ?? []) as InventoryItem[],
        disposedItems,
        bulkBuys,
        accounts,
        recentJobs: allJobs.slice(0, 20),
        extensionJobs: allJobs.filter((j) => j.execution_mode === "extension"),
        salesOrders,
        expenses: (expensesRes.data ?? []) as BusinessExpense[],
        lastSyncedAt,
        etsyActiveCount: etsyListings.length,
        etsyLastSyncedAt,
        channelCounts,
        auditHistory,
      };
    } catch (error) {
      if (error instanceof Error) {
        supabaseError = error.message;
      } else if (error && typeof error === "object") {
        const e = error as {
          message?: string;
          code?: string;
          details?: string;
          hint?: string;
        };
        supabaseError =
          [e.code, e.message, e.details].filter(Boolean).join(" — ") ||
          JSON.stringify(error);
      } else {
        supabaseError = String(error);
      }
      console.error(
        "[inventory-loader] Falling back to demo store after Supabase error:",
        supabaseError,
        error
      );
    }
  }

  // Interactive Demo Store fallback
  const store = getDemoStore();
  const itemById = new Map(store.items.map((item) => [item.id, item]));
  const ebayFeePct =
    store.accounts.find((a) => a.marketplace === "ebay")?.default_fee_pct ??
    DEFAULT_EBAY_FEE_PCT;

  const crossMap = new Map<string, CrossChannelListingSummary[]>();
  const channelCounts = emptyChannelCounts();

  for (const listing of store.listings) {
    if (listing.status !== "active" && listing.status !== "draft") continue;
    const inv = itemById.get(listing.item_id);
    if (!inv || inv.status === "sold" || inv.status === "draft") continue;
    channelCounts[listing.marketplace] =
      (channelCounts[listing.marketplace] || 0) + 1;
    const list = crossMap.get(listing.item_id) ?? [];
    list.push({
      listing_id: listing.id,
      marketplace: listing.marketplace,
      external_listing_id: listing.external_listing_id,
      external_url: listing.external_url,
      listed_price: Number(listing.listed_price),
      status: listing.status,
      views_count: listing.views_count,
      watchers_count: listing.watchers_count,
    });
    crossMap.set(listing.item_id, list);
  }

  const rows: StaleRadarRow[] = [];
  for (const listing of store.listings) {
    if (listing.marketplace !== "ebay" || listing.status !== "active") continue;
    const item = itemById.get(listing.item_id);
    if (!item || item.status === "sold" || item.status === "draft") continue;
    rows.push(
      enrichStaleRadarRow(
        listing,
        item,
        ebayFeePct,
        crossMap.get(listing.item_id) ?? []
      )
    );
  }

  rows.sort((a, b) => {
    const aMs = a.listed_at ? Date.parse(a.listed_at) : 0;
    const bMs = b.listed_at ? Date.parse(b.listed_at) : 0;
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });
  const draftItems = store.items.filter((i) => i.status === "draft");

  return {
    mode: "demo",
    envReadiness,
    items: rows,
    draftItems,
    accounts: store.accounts,
    recentJobs: store.jobs.slice(0, 20),
    extensionJobs: store.jobs.filter((j) => j.execution_mode === "extension"),
    salesOrders: store.salesOrders,
    expenses: store.expenses,
    lastSyncedAt: store.lastSyncedAt,
    etsyActiveCount: channelCounts.etsy,
    etsyLastSyncedAt: store.etsyLastSyncedAt,
    channelCounts,
    supabaseError,
  };
}
