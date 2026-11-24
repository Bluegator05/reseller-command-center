import type { SupabaseClient } from "@supabase/supabase-js";
import { roundCurrency } from "./stale-engine";
import type { BulkBuyRecord, ItemActivityEvent } from "./types";

export const BULK_BUYS_SKU = "__RCC_BULK_BUYS__";

export async function readBulkBuys(supabase: SupabaseClient): Promise<{
  rowId: string | null;
  specs: Record<string, unknown>;
  bulkBuys: BulkBuyRecord[];
}> {
  const { data } = await supabase
    .from("inventory_items")
    .select("id, item_specifics")
    .eq("sku", BULK_BUYS_SKU)
    .maybeSingle();

  const specs = (data?.item_specifics || {}) as Record<string, unknown>;
  const raw = specs.bulk_buys;
  const bulkBuys: BulkBuyRecord[] = Array.isArray(raw)
    ? (raw as BulkBuyRecord[])
    : [];

  return {
    rowId: data?.id ? String(data.id) : null,
    specs,
    bulkBuys,
  };
}

export async function writeBulkBuys(
  supabase: SupabaseClient,
  rowId: string | null,
  existingSpecs: Record<string, unknown>,
  bulkBuys: BulkBuyRecord[]
): Promise<void> {
  const nowIso = new Date().toISOString();
  const nextSpecs = {
    ...existingSpecs,
    bulk_buys: bulkBuys,
  };

  if (rowId) {
    const { error } = await supabase
      .from("inventory_items")
      .update({ item_specifics: nextSpecs, updated_at: nowIso })
      .eq("id", rowId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("inventory_items").insert({
      sku: BULK_BUYS_SKU,
      title: "System Bulk Buys Ledger (Do Not List)",
      condition: "New",
      cogs: 0,
      prep_cost: 0,
      target_price: 0,
      floor_price: 0,
      status: "archived",
      item_specifics: nextSpecs,
      acquired_at: nowIso,
      updated_at: nowIso,
    });
    if (error) throw new Error(error.message);
  }
}

export function appendBulkBuyActivity(
  specs: Record<string, unknown>,
  evt: Omit<ItemActivityEvent, "id">
): ItemActivityEvent[] {
  const prev = Array.isArray(specs.activity_log)
    ? (specs.activity_log as ItemActivityEvent[])
    : [];
  return [
    {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ...evt,
    },
    ...prev.slice(0, 49),
  ];
}

export function skuMatchesLotCode(sku: string, lotCode: string): boolean {
  const cleanLot = lotCode.trim().toUpperCase();
  if (!cleanLot || cleanLot.length < 2) return false;
  const upperSku = sku.trim().toUpperCase();
  if (!upperSku || upperSku.startsWith("__RCC_")) return false;
  // Match as standalone token or prefix (e.g. "SA926" matches "SA926 12/28/25 G1-L030" or "SA926-001")
  const escaped = cleanLot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s\\-_/])${escaped}($|[\\s\\-_/])`, "i");
  return re.test(upperSku) || upperSku.startsWith(cleanLot);
}

/**
 * Re-splits a Bulk Buy's total_spent across all unlocked current/active items
 * while preserving:
 * 1) Closed prior tax year sales (never shift past-year COGS)
 * 2) Individually locked item costs
 */
export async function rebalanceBulkBuyCosts(
  supabase: SupabaseClient,
  bulkBuy: BulkBuyRecord
): Promise<{
  totalItems: number;
  rebalancedCount: number;
  closedYearHeld: number;
  lockedHeld: number;
  sharedPool: number;
  perShareCost: number;
}> {
  const { data: linkedRows, error } = await supabase
    .from("inventory_items")
    .select("id, sku, cogs, status, item_specifics")
    .contains("item_specifics", { bulk_buy_id: bulkBuy.id });

  if (error) {
    throw new Error(`Failed loading bulk buy items: ${error.message}`);
  }

  const rows = (linkedRows ?? []) as Array<{
    id: string;
    sku: string;
    cogs: number;
    status: string;
    item_specifics?: Record<string, unknown> | null;
  }>;

  if (rows.length === 0) {
    return {
      totalItems: 0,
      rebalancedCount: 0,
      closedYearHeld: 0,
      lockedHeld: 0,
      sharedPool: roundCurrency(bulkBuy.total_spent),
      perShareCost: 0,
    };
  }

  // Look up earliest sold_at per item to protect prior closed tax years
  const itemIds = rows.map((r) => r.id);
  const soldYearByItem = new Map<string, number>();
  for (let i = 0; i < itemIds.length; i += 200) {
    const { data: orderRows } = await supabase
      .from("sales_orders")
      .select("item_id, sold_at")
      .in("item_id", itemIds.slice(i, i + 200));
    for (const o of orderRows ?? []) {
      if (!o.item_id || !o.sold_at) continue;
      const yr = new Date(String(o.sold_at)).getFullYear();
      if (!Number.isFinite(yr)) continue;
      const prev = soldYearByItem.get(String(o.item_id));
      if (prev === undefined || yr < prev) {
        soldYearByItem.set(String(o.item_id), yr);
      }
    }
  }

  const currentYear = new Date().getFullYear();
  let closedYearHeld = 0;
  let lockedHeld = 0;

  const unlocked: Array<{
    id: string;
    currentCogs: number;
    weight: number;
  }> = [];

  for (const r of rows) {
    const sp = (r.item_specifics || {}) as Record<string, unknown>;
    const soldYear = soldYearByItem.get(r.id);
    const isClosedTaxYear =
      soldYear !== undefined && soldYear < currentYear;
    const isLocked =
      sp.bulk_buy_locked === true || sp.bulk_buy_locked === "true";

    if (isClosedTaxYear) {
      closedYearHeld = roundCurrency(closedYearHeld + Number(r.cogs || 0));
    } else if (isLocked) {
      lockedHeld = roundCurrency(lockedHeld + Number(r.cogs || 0));
    } else {
      const rawQty = Number(sp.quantity_purchased ?? sp.quantity_available ?? 1);
      const weight =
        bulkBuy.split_mode === "by_unit" && Number.isFinite(rawQty) && rawQty > 1
          ? Math.floor(rawQty)
          : 1;
      unlocked.push({
        id: r.id,
        currentCogs: Number(r.cogs || 0),
        weight,
      });
    }
  }

  const sharedPool = Math.max(
    0,
    roundCurrency(bulkBuy.total_spent - closedYearHeld - lockedHeld)
  );
  const totalWeight = unlocked.reduce((s, u) => s + u.weight, 0);

  if (unlocked.length === 0 || totalWeight === 0) {
    return {
      totalItems: rows.length,
      rebalancedCount: 0,
      closedYearHeld,
      lockedHeld,
      sharedPool,
      perShareCost: 0,
    };
  }

  // Exact cent-accurate allocation so the sum equals sharedPool
  const totalCents = Math.round(sharedPool * 100);
  const baseCentsPerUnit = Math.floor(totalCents / totalWeight);
  let remainderCents = totalCents - baseCentsPerUnit * totalWeight;

  const nowIso = new Date().toISOString();
  const updates: Array<{ id: string; nextCogs: number }> = [];

  for (const u of unlocked) {
    let itemCents = baseCentsPerUnit * u.weight;
    if (remainderCents > 0) {
      const bump = Math.min(remainderCents, u.weight);
      itemCents += bump;
      remainderCents -= bump;
    }
    const nextCogs = roundCurrency(itemCents / 100);
    if (Math.abs(nextCogs - u.currentCogs) > 0.004) {
      updates.push({ id: u.id, nextCogs });
    }
  }

  for (let i = 0; i < updates.length; i += 15) {
    const batch = updates.slice(i, i + 15);
    await Promise.all(
      batch.map((u) =>
        supabase
          .from("inventory_items")
          .update({ cogs: u.nextCogs, updated_at: nowIso })
          .eq("id", u.id)
      )
    );
  }

  return {
    totalItems: rows.length,
    rebalancedCount: updates.length,
    closedYearHeld,
    lockedHeld,
    sharedPool,
    perShareCost: roundCurrency(sharedPool / totalWeight),
  };
}
