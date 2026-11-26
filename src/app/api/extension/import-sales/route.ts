import { NextResponse } from "next/server";
import { cascadeDelistOtherChannelsForSoldItem } from "@/lib/auto-delist";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type { MarketplaceType, OrderFulfillmentStatus } from "@/lib/types";

export const maxDuration = 60;

interface ScannedSaleInput {
  externalOrderId: string;
  externalListingId?: string | null;
  sku?: string | null;
  title: string;
  imageUrl?: string | null;
  grossSalePrice: number;
  marketplaceFees?: number | null;
  shippingCost?: number | null;
  refundAmount?: number | null;
  fulfillmentStatus?: OrderFulfillmentStatus | null;
  soldAt?: string | null;
}

type ImportableSalesMarketplace = Exclude<MarketplaceType, "ebay">;

interface ImportSalesBody {
  marketplace: ImportableSalesMarketplace;
  sales: ScannedSaleInput[];
  cascadeDelist?: boolean;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "new",
  "nwt",
  "nwot",
  "euc",
  "guc",
  "size",
  "sz",
  "mens",
  "men",
  "womens",
  "women",
  "vintage",
  "lot",
  "of",
  "in",
  "on",
  "to",
  "by",
]);

function tokenize(raw: string): Set<string> {
  return new Set(
    String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
  );
}

function titleScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const w of a) {
    if (b.has(w)) hit += 1;
  }
  const dice = (2 * hit) / (a.size + b.size);
  const contain = hit / Math.min(a.size, b.size);
  return dice * 0.65 + contain * 0.35;
}

function estimateMarketplaceFee(
  marketplace: ImportableSalesMarketplace,
  gross: number
): number {
  if (gross <= 0) return 0;
  if (marketplace === "poshmark") {
    return gross < 15 ? 2.95 : roundCurrency(gross * 0.2);
  }
  if (marketplace === "mercari") {
    return roundCurrency(gross * 0.1);
  }
  if (marketplace === "etsy") {
    // 6.5% transaction fee + 3% + $0.25 payment processing + $0.20 listing fee
    return roundCurrency(gross * 0.095 + 0.45);
  }
  return roundCurrency(Math.max(0.8, gross * 0.1));
}

function normalizeIsoDate(raw?: string | null): string {
  if (raw) {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString();
    }
  }
  return new Date().toISOString();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ImportSalesBody;
    const marketplace = body?.marketplace;
    if (
      marketplace !== "poshmark" &&
      marketplace !== "mercari" &&
      marketplace !== "facebook" &&
      marketplace !== "etsy"
    ) {
      return NextResponse.json(
        { error: "marketplace must be poshmark, mercari, etsy, or facebook" },
        { status: 400 }
      );
    }

    const rawSales = Array.isArray(body.sales) ? body.sales : [];
    if (rawSales.length === 0) {
      return NextResponse.json({
        mode: "live",
        marketplace,
        importedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        totalReceived: 0,
        message: `No ${marketplace} sold orders were found on the page.`,
      });
    }

    const supabase = getSupabaseServerClient();
    if (!supabase || !isSupabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured in this environment." },
        { status: 400 }
      );
    }

    // 1. Load existing sales_orders for this marketplace to avoid duplicates
    const existingSales = new Map<
      string,
      {
        id: string;
        item_id: string;
        fulfillment_status: string;
        marketplace_fees: number;
        refund_amount: number;
      }
    >();

    for (let from = 0; from < 5000; from += 1000) {
      const { data, error } = await supabase
        .from("sales_orders")
        .select(
          "id, item_id, external_order_id, fulfillment_status, marketplace_fees, refund_amount"
        )
        .eq("marketplace", marketplace)
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.external_order_id) {
          existingSales.set(row.external_order_id, {
            id: row.id,
            item_id: row.item_id,
            fulfillment_status: row.fulfillment_status,
            marketplace_fees: Number(row.marketplace_fees ?? 0),
            refund_amount: Number(row.refund_amount ?? 0),
          });
        }
      }
      if ((data ?? []).length < 1000) break;
    }

    // 2. Load existing inventory_items & marketplace_listings so sold items link to real SKUs/COGS
    const existingItems: Array<{
      id: string;
      sku: string;
      titleTokens: Set<string>;
    }> = [];
    const skuSet = new Set<string>();
    const itemsWithImages = new Set<string>();

    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("id, sku, title, image_urls")
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.sku) skuSet.add(row.sku.trim().toLowerCase());
        if (Array.isArray(row.image_urls) && row.image_urls.length > 0) {
          itemsWithImages.add(row.id);
        }
        existingItems.push({
          id: row.id,
          sku: row.sku,
          titleTokens: tokenize(row.title || ""),
        });
      }
      if ((data ?? []).length < 1000) break;
    }

    const listingIdToItemId = new Map<string, string>();
    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await supabase
        .from("marketplace_listings")
        .select("item_id, external_listing_id")
        .eq("marketplace", marketplace)
        .range(from, from + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.external_listing_id) {
          listingIdToItemId.set(row.external_listing_id.trim(), row.item_id);
        }
      }
      if ((data ?? []).length < 1000) break;
    }

    const prefix =
      marketplace === "poshmark"
        ? "PM"
        : marketplace === "mercari"
          ? "MC"
          : marketplace === "etsy"
            ? "ET"
            : "FB";

    const skuToItemId = new Map<string, string>();
    for (const cand of existingItems) {
      if (cand.sku) {
        skuToItemId.set(cand.sku.trim().toLowerCase(), cand.id);
      }
    }

    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    const newRows: Array<{
      item_id: string;
      marketplace: ImportableSalesMarketplace;
      external_order_id: string;
      gross_sale_price: number;
      marketplace_fees: number;
      shipping_cost: number;
      refund_amount: number;
      fulfillment_status: OrderFulfillmentStatus;
      shipped_at: string | null;
      restocked: boolean;
      sold_at: string;
    }> = [];

    for (const raw of rawSales) {
      const extOrderId = String(raw.externalOrderId || "").trim();
      const title = String(raw.title || "").trim();
      if (!extOrderId || !title) continue;

      const cleanImageUrl =
        typeof raw.imageUrl === "string" && /^https?:\/\//i.test(raw.imageUrl.trim())
          ? raw.imageUrl.trim()
          : null;

      const gross = roundCurrency(Math.max(0, Number(raw.grossSalePrice) || 0));
      const fees =
        raw.marketplaceFees !== undefined &&
        raw.marketplaceFees !== null &&
        Number.isFinite(Number(raw.marketplaceFees)) &&
        Number(raw.marketplaceFees) >= 0
          ? roundCurrency(Number(raw.marketplaceFees))
          : estimateMarketplaceFee(marketplace, gross);
      const shippingCost = roundCurrency(
        Math.max(0, Number(raw.shippingCost) || 0)
      );
      const status: OrderFulfillmentStatus =
        raw.fulfillmentStatus &&
        [
          "to_ship",
          "picked",
          "shipped",
          "returned",
          "partial_refund",
          "unpaid",
        ].includes(raw.fulfillmentStatus)
          ? raw.fulfillmentStatus
          : "shipped";
      const refundAmount =
        raw.refundAmount !== undefined &&
        raw.refundAmount !== null &&
        Number(raw.refundAmount) > 0
          ? roundCurrency(Number(raw.refundAmount))
          : status === "returned" || status === "unpaid"
            ? gross
            : 0;
      const soldAt = normalizeIsoDate(raw.soldAt);

      const existing = existingSales.get(extOrderId);
      if (existing) {
        if (
          cleanImageUrl &&
          existing.item_id &&
          !itemsWithImages.has(existing.item_id)
        ) {
          const { error: picErr } = await supabase
            .from("inventory_items")
            .update({ image_urls: [cleanImageUrl] })
            .eq("id", existing.item_id);
          if (!picErr) itemsWithImages.add(existing.item_id);
        }

        const needsUpdate =
          existing.fulfillment_status !== status ||
          Math.abs(existing.marketplace_fees - fees) > 0.01 ||
          Math.abs(existing.refund_amount - refundAmount) > 0.01;
        if (needsUpdate) {
          const { error: updErr } = await supabase
            .from("sales_orders")
            .update({
              fulfillment_status: status,
              marketplace_fees: fees,
              refund_amount: refundAmount,
              ...(status === "shipped" ? { shipped_at: soldAt } : {}),
            })
            .eq("id", existing.id);
          if (!updErr) updatedCount += 1;
        } else {
          skippedCount += 1;
        }
        continue;
      }

      // Resolve parent inventory_items ID (exact SKU -> external listing ID -> fuzzy title)
      let itemId: string | null =
        (raw.sku ? skuToItemId.get(raw.sku.trim().toLowerCase()) ?? null : null) ||
        (raw.externalListingId
          ? listingIdToItemId.get(raw.externalListingId.trim()) ?? null
          : null) ||
        null;

      if (!itemId) {
        const tok = tokenize(title);
        let bestId: string | null = null;
        let bestScore = 0;
        for (const cand of existingItems) {
          const s = titleScore(tok, cand.titleTokens);
          if (s > bestScore) {
            bestScore = s;
            bestId = cand.id;
          }
        }
        if (bestScore >= 0.72 && bestId) {
          itemId = bestId;
        }
      }

      if (!itemId) {
        const cleanId = extOrderId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-16);
        let sku = `${prefix}-SOLD-${cleanId || Date.now().toString(36)}`;
        if (skuSet.has(sku.toLowerCase())) {
          sku = `${sku}-${Math.random().toString(36).slice(2, 6)}`;
        }
        const { data: created, error: createErr } = await supabase
          .from("inventory_items")
          .insert({
            sku,
            title: title.slice(0, 200),
            condition: "Used",
            cogs: 0,
            prep_cost: 0,
            target_price: Math.max(0.01, gross),
            floor_price: Math.max(0.01, gross),
            status: "sold",
            acquired_at: soldAt,
            ...(cleanImageUrl ? { image_urls: [cleanImageUrl] } : {}),
          })
          .select("id")
          .single();

        if (createErr || !created?.id) {
          console.warn(
            "[import-sales] Skipping sale due to inventory_items insert error:",
            extOrderId,
            createErr?.message
          );
          continue;
        }

        itemId = String(created.id);
        skuSet.add(sku.toLowerCase());
        if (cleanImageUrl) itemsWithImages.add(itemId);
        existingItems.push({ id: itemId, sku, titleTokens: tokenize(title) });
        if (raw.externalListingId) {
          listingIdToItemId.set(raw.externalListingId.trim(), itemId);
        }
      } else if (cleanImageUrl && !itemsWithImages.has(itemId)) {
        const { error: picErr } = await supabase
          .from("inventory_items")
          .update({ image_urls: [cleanImageUrl] })
          .eq("id", itemId);
        if (!picErr) itemsWithImages.add(itemId);
      }

      existingSales.set(extOrderId, {
        id: "pending",
        item_id: itemId,
        fulfillment_status: status,
        marketplace_fees: fees,
        refund_amount: refundAmount,
      });

      newRows.push({
        item_id: itemId,
        marketplace,
        external_order_id: extOrderId,
        gross_sale_price: gross,
        marketplace_fees: fees,
        shipping_cost: shippingCost,
        refund_amount: refundAmount,
        fulfillment_status: status,
        shipped_at: status === "shipped" ? soldAt : null,
        restocked: false,
        sold_at: soldAt,
      });
    }

    for (let i = 0; i < newRows.length; i += 100) {
      const chunk = newRows.slice(i, i + 100);
      const { error: insErr } = await supabase.from("sales_orders").insert(chunk);
      if (insErr) {
        throw new Error(`Failed saving imported ${marketplace} sales: ${insErr.message}`);
      }
      importedCount += chunk.length;
    }

    // Mark the selling channel's own marketplace_listings row as "sold" for all
    // paid/shipped orders so sold Poshmark/Mercari/FB listings never stay stuck as Active
    const paidSoldItemIds = [
      ...new Set(
        [...existingSales.values()]
          .filter(
            (s) =>
              s.item_id &&
              s.fulfillment_status !== "unpaid" &&
              s.fulfillment_status !== "returned"
          )
          .map((s) => s.item_id)
      ),
    ];
    if (paidSoldItemIds.length > 0) {
      const nowIso = new Date().toISOString();
      for (let i = 0; i < paidSoldItemIds.length; i += 100) {
        const chunk = paidSoldItemIds.slice(i, i + 100);
        await supabase
          .from("marketplace_listings")
          .update({ status: "sold", last_synced_at: nowIso })
          .eq("marketplace", marketplace)
          .in("item_id", chunk)
          .in("status", ["active", "draft"]);
      }
    }

    // Anti-Double-Sell Cascade: ONLY for brand-new paid sales from the past 7 days
    let delistedCount = 0;
    if (body.cascadeDelist && newRows.length > 0) {
      const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const itemById = new Map(existingItems.map((it) => [it.id, it]));
      const rawByOrder = new Map(
        rawSales.map((s) => [String(s.externalOrderId || "").trim(), s])
      );
      for (const row of newRows) {
        if (
          row.fulfillment_status === "unpaid" ||
          row.fulfillment_status === "returned"
        ) {
          continue;
        }
        const soldMs = Date.parse(row.sold_at);
        if (!Number.isNaN(soldMs) && soldMs < sevenDaysAgoMs) continue;
        const inv = itemById.get(row.item_id);
        const orig = rawByOrder.get(row.external_order_id);
        const cascaded = await cascadeDelistOtherChannelsForSoldItem({
          itemId: row.item_id,
          soldOnMarketplace: marketplace,
          externalOrderId: row.external_order_id,
          sku: inv?.sku,
          title: orig?.title,
        });
        delistedCount += cascaded.length;
      }
    }

    const label =
      marketplace === "poshmark"
        ? "Poshmark"
        : marketplace === "mercari"
          ? "Mercari"
          : "Facebook";

    return NextResponse.json({
      mode: "live",
      marketplace,
      importedCount,
      updatedCount,
      skippedCount,
      delistedCount,
      totalReceived: rawSales.length,
      message:
        importedCount > 0
          ? `Imported ${importedCount} ${label} sale${importedCount === 1 ? "" : "s"}${delistedCount > 0 ? ` & auto-delisted ${delistedCount} cross-listing${delistedCount === 1 ? "" : "s"}` : ""}${updatedCount > 0 ? ` (${updatedCount} updated)` : ""}!`
          : updatedCount > 0
            ? `Updated ${updatedCount} existing ${label} sale${updatedCount === 1 ? "" : "s"}.`
            : `All ${rawSales.length} ${label} sales are already up to date in your Sales Ledger.`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Marketplace sales import failed";
    console.error("[/api/extension/import-sales] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
