import { getDemoStore } from "./demo-store";
import { DEFAULT_EBAY_FEE_PCT, enrichStaleRadarRow, roundCurrency } from "./stale-engine";
import { getEnvReadiness, getSupabaseServerClient } from "./supabase";
import type {
  BusinessExpense,
  ChannelJob,
  CommandCenterPayload,
  CrossChannelListingSummary,
  InventoryItem,
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

  if (supabase && envReadiness.isSupabaseReady) {
    try {
      const [
        allListingsRes,
        accountsRes,
        jobsRes,
        ordersRes,
        draftsRes,
        expensesRes,
      ] = await Promise.all([
        supabase
          .from("marketplace_listings")
          .select("*, inventory_items(*)")
          .in("status", ["active", "draft"])
          .order("listed_at", { ascending: true }),
        supabase.from("marketplace_accounts").select("*"),
        supabase
          .from("channel_jobs")
          .select("*, inventory_items(sku, title)")
          .order("created_at", { ascending: false })
          .limit(50),
        supabase
          .from("sales_orders")
          .select(
            "*, inventory_items(sku, title, cogs, prep_cost, source_location, source_type, acquired_at, bin_location, weight_oz, length_in, width_in, height_in)"
          )
          .order("sold_at", { ascending: false })
          .limit(500),
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
      ]);

      if (allListingsRes.error) {
        throw allListingsRes.error;
      }

      const accounts = (accountsRes.data ?? []) as MarketplaceAccount[];
      const ebayFeePct =
        accounts.find((a) => a.marketplace === "ebay")?.default_fee_pct ??
        DEFAULT_EBAY_FEE_PCT;

      const joinedRows = (allListingsRes.data ?? []) as JoinedListingRecord[];
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
      for (const row of joinedRows) {
        if (row.marketplace !== "ebay" || row.status !== "active") continue;
        const inv = Array.isArray(row.inventory_items)
          ? row.inventory_items[0]
          : row.inventory_items;
        if (!inv || inv.status === "sold") continue;
        items.push(
          enrichStaleRadarRow(
            row,
            inv,
            Number(ebayFeePct),
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
              }
            | Array<{
                sku?: string;
                title?: string;
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
              }>
            | null;
        };
        const inv = Array.isArray(rec.inventory_items)
          ? rec.inventory_items[0]
          : rec.inventory_items;
        const cogs = Number(inv?.cogs ?? 0);
        const prepCost = Number(inv?.prep_cost ?? 0);
        const netProfit = Number(rec.net_profit ?? 0);
        const delistedChannels = allJobs
          .filter((j) => j.item_id === rec.item_id && j.action === "delist")
          .map((j) => j.marketplace);
        const pkgDims =
          inv?.length_in && inv?.width_in && inv?.height_in
            ? `${inv.length_in}×${inv.width_in}×${inv.height_in} in`
            : null;
        const status: OrderFulfillmentStatus =
          rec.fulfillment_status ?? "shipped";
        const cogsApplied =
          rec.restocked || status === "unpaid" ? 0 : cogs + prepCost;

        return {
          id: rec.id,
          item_id: rec.item_id,
          sku: inv?.sku || rec.item_id.slice(0, 8),
          title: inv?.title || "Sold Item",
          marketplace: rec.marketplace,
          external_order_id: rec.external_order_id,
          gross_sale_price: Number(rec.gross_sale_price),
          marketplace_fees: Number(rec.marketplace_fees),
          shipping_cost: Number(rec.shipping_cost),
          refund_amount: Number(rec.refund_amount ?? 0),
          cogs,
          prep_cost: prepCost,
          source_location: inv?.source_location ?? null,
          source_type: inv?.source_type ?? null,
          acquired_at: inv?.acquired_at ?? null,
          bin_location: inv?.bin_location ?? null,
          weight_oz: inv?.weight_oz ?? null,
          pkg_dimensions: pkgDims,
          fulfillment_status: status,
          tracking_number: rec.tracking_number ?? null,
          shipped_at: rec.shipped_at ?? null,
          return_reason: rec.return_reason ?? null,
          restocked: Boolean(rec.restocked),
          net_profit: netProfit,
          true_net_after_cogs: roundCurrency(netProfit - cogsApplied),
          sold_at: rec.sold_at,
          delisted_channels: delistedChannels,
          source:
            rec.marketplace === "ebay" || rec.marketplace === "etsy"
              ? "webhook"
              : "inbound_email",
        };
      });

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
        accounts,
        recentJobs: allJobs.slice(0, 20),
        extensionJobs: allJobs.filter((j) => j.execution_mode === "extension"),
        salesOrders,
        expenses: (expensesRes.data ?? []) as BusinessExpense[],
        lastSyncedAt,
        etsyActiveCount: etsyListings.length,
        etsyLastSyncedAt,
        channelCounts,
      };
    } catch (error) {
      console.error(
        "[inventory-loader] Falling back to demo store after Supabase error:",
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

  rows.sort((a, b) => b.days_listed - a.days_listed);
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
  };
}
