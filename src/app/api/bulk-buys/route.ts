import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appendBulkBuyActivity as appendActivity,
  readBulkBuys,
  rebalanceBulkBuyCosts,
  skuMatchesLotCode,
  writeBulkBuys,
} from "@/lib/bulk-buy-costs";
import { roundCurrency } from "@/lib/stale-engine";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type { BulkBuyRecord } from "@/lib/types";

async function attachItemsToBulkBuy(
  supabase: SupabaseClient,
  bulkBuy: BulkBuyRecord,
  itemIds: string[]
): Promise<number> {
  if (itemIds.length === 0) return 0;
  const nowIso = new Date().toISOString();
  let attached = 0;

  for (let i = 0; i < itemIds.length; i += 100) {
    const chunk = itemIds.slice(i, i + 100);
    const { data: rows } = await supabase
      .from("inventory_items")
      .select("id, source_location, source_type, acquired_at, item_specifics")
      .in("id", chunk);

    const list = rows ?? [];
    for (let j = 0; j < list.length; j += 15) {
      const batch = list.slice(j, j + 15);
      await Promise.all(
        batch.map(async (row) => {
          const specs = (row.item_specifics || {}) as Record<string, unknown>;
          const nextSpecs: Record<string, unknown> = {
            ...specs,
            bulk_buy_id: bulkBuy.id,
            bulk_buy_locked: false,
            activity_log: appendActivity(specs, {
              type: "bulk_buy_added",
              timestamp: nowIso,
              title: "Added to bulk buy",
              detail: `Linked to ${bulkBuy.name}`,
            }),
          };

          const patch: Record<string, unknown> = {
            item_specifics: nextSpecs,
            updated_at: nowIso,
          };
          if (!row.source_location && bulkBuy.source_location) {
            patch.source_location = bulkBuy.source_location;
          }
          if (!row.source_type && bulkBuy.source_type) {
            patch.source_type = bulkBuy.source_type;
          }
          if (!row.acquired_at && bulkBuy.purchase_date) {
            patch.acquired_at = `${bulkBuy.purchase_date}T12:00:00Z`;
          }

          const { error } = await supabase
            .from("inventory_items")
            .update(patch)
            .eq("id", row.id);
          if (!error) attached += 1;
        })
      );
    }
  }

  return attached;
}

async function findMatchingSkuItemIds(
  supabase: SupabaseClient,
  lotCode: string,
  excludeBulkBuyId?: string
): Promise<string[]> {
  const clean = lotCode.trim();
  if (!clean || clean.length < 2) return [];
  const matched: string[] = [];

  for (let from = 0; from < 5000; from += 1000) {
    const { data, error } = await supabase
      .from("inventory_items")
      .select("id, sku, item_specifics")
      .ilike("sku", `%${clean}%`)
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;

    for (const row of data) {
      const sku = String(row.sku || "");
      if (!skuMatchesLotCode(sku, clean)) continue;
      const sp = (row.item_specifics || {}) as Record<string, unknown>;
      const existingBb =
        typeof sp.bulk_buy_id === "string" ? sp.bulk_buy_id.trim() : "";
      if (existingBb && existingBb !== excludeBulkBuyId) continue;
      if (existingBb === excludeBulkBuyId) continue;
      matched.push(String(row.id));
    }

    if (data.length < 1000) break;
  }

  return matched;
}

export async function GET() {
  try {
    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();
    if (!supabase || !envReadiness.isSupabaseReady) {
      return NextResponse.json({ mode: "demo", bulkBuys: [] });
    }
    const { bulkBuys } = await readBulkBuys(supabase);
    return NextResponse.json({ mode: "live", bulkBuys });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load bulk buys",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as
      | {
          action: "create";
          name: string;
          lot_code?: string | null;
          purchase_date?: string;
          source_location?: string;
          source_type?: string;
          storage_location?: string | null;
          total_spent: number;
          split_mode?: "even" | "by_unit";
          notes?: string | null;
          itemIds?: string[];
          autoMatchLotCode?: boolean;
        }
      | {
          action: "update";
          id: string;
          name?: string;
          lot_code?: string | null;
          purchase_date?: string;
          source_location?: string;
          source_type?: string;
          storage_location?: string | null;
          total_spent?: number;
          split_mode?: "even" | "by_unit";
          notes?: string | null;
        }
      | {
          action: "add_items";
          id: string;
          itemIds: string[];
        }
      | {
          action: "remove_items";
          id: string;
          itemIds: string[];
        }
      | {
          action: "auto_match_sku";
          id: string;
        }
      | {
          action: "lock_item_cost";
          id: string;
          itemId: string;
          cost: number;
        }
      | {
          action: "unlock_item_cost";
          id: string;
          itemId: string;
        }
      | {
          action: "delete";
          id: string;
        };

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();
    if (!supabase || !envReadiness.isSupabaseReady) {
      return NextResponse.json(
        { error: "Supabase must be connected to manage Bulk Buys." },
        { status: 400 }
      );
    }

    const { rowId, specs, bulkBuys } = await readBulkBuys(supabase);
    const nowIso = new Date().toISOString();

    if (body.action === "create") {
      const name = body.name?.trim();
      if (!name) {
        return NextResponse.json(
          { error: "Bulk buy name is required." },
          { status: 400 }
        );
      }
      const totalSpent = Math.max(0, roundCurrency(Number(body.total_spent) || 0));
      const newBulkBuy: BulkBuyRecord = {
        id: `bb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        lot_code: body.lot_code?.trim() || null,
        purchase_date: body.purchase_date?.trim() || nowIso.slice(0, 10),
        source_location: body.source_location?.trim() || "Storage Auction",
        source_type: body.source_type?.trim() || "storage_auction",
        storage_location: body.storage_location?.trim() || null,
        total_spent: totalSpent,
        split_mode: body.split_mode === "by_unit" ? "by_unit" : "even",
        notes: body.notes?.trim() || null,
        created_at: nowIso,
        updated_at: nowIso,
      };

      const nextList = [newBulkBuy, ...bulkBuys];
      await writeBulkBuys(supabase, rowId, specs, nextList);

      const targetIds = new Set<string>(
        Array.isArray(body.itemIds) ? body.itemIds : []
      );
      if (body.autoMatchLotCode !== false && newBulkBuy.lot_code) {
        const matched = await findMatchingSkuItemIds(
          supabase,
          newBulkBuy.lot_code,
          newBulkBuy.id
        );
        for (const m of matched) targetIds.add(m);
      }

      const attachedCount = await attachItemsToBulkBuy(
        supabase,
        newBulkBuy,
        [...targetIds]
      );
      const rebalance = await rebalanceBulkBuyCosts(supabase, newBulkBuy);

      return NextResponse.json({
        mode: "live",
        bulkBuy: newBulkBuy,
        bulkBuys: nextList,
        attachedCount,
        rebalance,
        message:
          attachedCount > 0
            ? `Created "${name}" ($${totalSpent.toFixed(2)}) · linked ${attachedCount} item${attachedCount === 1 ? "" : "s"} at ~$${rebalance.perShareCost.toFixed(2)} each.`
            : `Created "${name}" ($${totalSpent.toFixed(2)}). Add items or enter a SKU Lot Code to auto-split COGS.`,
      });
    }

    const idx = bulkBuys.findIndex((b) => b.id === body.id);
    if (idx === -1) {
      return NextResponse.json(
        { error: "Bulk buy not found." },
        { status: 404 }
      );
    }
    const existing = bulkBuys[idx];

    if (body.action === "update") {
      const updated: BulkBuyRecord = {
        ...existing,
        ...(body.name !== undefined ? { name: body.name.trim() || existing.name } : {}),
        ...(body.lot_code !== undefined
          ? { lot_code: body.lot_code?.trim() || null }
          : {}),
        ...(body.purchase_date !== undefined
          ? { purchase_date: body.purchase_date.trim() || existing.purchase_date }
          : {}),
        ...(body.source_location !== undefined
          ? { source_location: body.source_location.trim() || existing.source_location }
          : {}),
        ...(body.source_type !== undefined
          ? { source_type: body.source_type.trim() || existing.source_type }
          : {}),
        ...(body.storage_location !== undefined
          ? { storage_location: body.storage_location?.trim() || null }
          : {}),
        ...(body.total_spent !== undefined
          ? { total_spent: Math.max(0, roundCurrency(Number(body.total_spent) || 0)) }
          : {}),
        ...(body.split_mode !== undefined
          ? { split_mode: body.split_mode === "by_unit" ? "by_unit" : "even" }
          : {}),
        ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
        updated_at: nowIso,
      };
      const nextList = [...bulkBuys];
      nextList[idx] = updated;
      await writeBulkBuys(supabase, rowId, specs, nextList);
      const rebalance = await rebalanceBulkBuyCosts(supabase, updated);
      return NextResponse.json({
        mode: "live",
        bulkBuy: updated,
        bulkBuys: nextList,
        rebalance,
        message: `Updated "${updated.name}" · re-split across ${rebalance.totalItems} item${rebalance.totalItems === 1 ? "" : "s"}.`,
      });
    }

    if (body.action === "add_items") {
      const ids = Array.isArray(body.itemIds)
        ? body.itemIds.filter((s) => typeof s === "string" && s.trim())
        : [];
      const attachedCount = await attachItemsToBulkBuy(supabase, existing, ids);
      const rebalance = await rebalanceBulkBuyCosts(supabase, existing);
      return NextResponse.json({
        mode: "live",
        bulkBuy: existing,
        attachedCount,
        rebalance,
        message: `Added ${attachedCount} item${attachedCount === 1 ? "" : "s"} to "${existing.name}" · shared cost is now $${rebalance.perShareCost.toFixed(2)}/item.`,
      });
    }

    if (body.action === "auto_match_sku") {
      if (!existing.lot_code) {
        return NextResponse.json(
          { error: "Set a SKU Lot Code (e.g. SA926) on this bulk buy first." },
          { status: 400 }
        );
      }
      const matched = await findMatchingSkuItemIds(
        supabase,
        existing.lot_code,
        existing.id
      );
      const attachedCount = await attachItemsToBulkBuy(
        supabase,
        existing,
        matched
      );
      const rebalance = await rebalanceBulkBuyCosts(supabase, existing);
      return NextResponse.json({
        mode: "live",
        bulkBuy: existing,
        attachedCount,
        rebalance,
        message:
          attachedCount > 0
            ? `Matched & added ${attachedCount} item${attachedCount === 1 ? "" : "s"} for "${existing.lot_code}" · now $${rebalance.perShareCost.toFixed(2)}/item.`
            : `All items matching "${existing.lot_code}" are already linked to this bulk buy.`,
      });
    }

    if (body.action === "remove_items") {
      const ids = Array.isArray(body.itemIds) ? body.itemIds : [];
      if (ids.length > 0) {
        const { data: rows } = await supabase
          .from("inventory_items")
          .select("id, item_specifics")
          .in("id", ids);
        for (const r of rows ?? []) {
          const sp = { ...((r.item_specifics || {}) as Record<string, unknown>) };
          delete sp.bulk_buy_id;
          delete sp.bulk_buy_locked;
          await supabase
            .from("inventory_items")
            .update({ item_specifics: sp, updated_at: nowIso })
            .eq("id", r.id);
        }
      }
      const rebalance = await rebalanceBulkBuyCosts(supabase, existing);
      return NextResponse.json({
        mode: "live",
        bulkBuy: existing,
        rebalance,
        message: `Removed ${ids.length} item${ids.length === 1 ? "" : "s"} from "${existing.name}" & re-split remaining items.`,
      });
    }

    if (body.action === "lock_item_cost") {
      const customCost = Math.max(0, roundCurrency(Number(body.cost) || 0));
      const { data: item, error: itemErr } = await supabase
        .from("inventory_items")
        .select("id, sku, item_specifics")
        .eq("id", body.itemId)
        .single();
      if (itemErr || !item) {
        return NextResponse.json({ error: "Item not found" }, { status: 404 });
      }
      const sp = (item.item_specifics || {}) as Record<string, unknown>;
      const nextSpecs: Record<string, unknown> = {
        ...sp,
        bulk_buy_id: existing.id,
        bulk_buy_locked: true,
        activity_log: appendActivity(sp, {
          type: "bulk_buy_cost_locked",
          timestamp: nowIso,
          title: `Cost locked at $${customCost.toFixed(2)}`,
          detail: `Locked inside bulk buy "${existing.name}"`,
        }),
      };
      const { error: updErr } = await supabase
        .from("inventory_items")
        .update({
          cogs: customCost,
          item_specifics: nextSpecs,
          updated_at: nowIso,
        })
        .eq("id", item.id);
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 400 });
      }
      const rebalance = await rebalanceBulkBuyCosts(supabase, existing);
      return NextResponse.json({
        mode: "live",
        bulkBuy: existing,
        rebalance,
        message: `Locked ${item.sku} at $${customCost.toFixed(2)} · remaining unlocked items re-split to $${rebalance.perShareCost.toFixed(2)}.`,
      });
    }

    if (body.action === "unlock_item_cost") {
      const { data: item, error: itemErr } = await supabase
        .from("inventory_items")
        .select("id, sku, item_specifics")
        .eq("id", body.itemId)
        .single();
      if (itemErr || !item) {
        return NextResponse.json({ error: "Item not found" }, { status: 404 });
      }
      const sp = (item.item_specifics || {}) as Record<string, unknown>;
      const nextSpecs: Record<string, unknown> = {
        ...sp,
        bulk_buy_id: existing.id,
        bulk_buy_locked: false,
      };
      await supabase
        .from("inventory_items")
        .update({ item_specifics: nextSpecs, updated_at: nowIso })
        .eq("id", item.id);
      const rebalance = await rebalanceBulkBuyCosts(supabase, existing);
      return NextResponse.json({
        mode: "live",
        bulkBuy: existing,
        rebalance,
        message: `Unlocked ${item.sku} · all unlocked items now share $${rebalance.perShareCost.toFixed(2)} each.`,
      });
    }

    if (body.action === "delete") {
      // Unlink all items from this bulk buy (keeping their current COGS intact)
      const { data: linked } = await supabase
        .from("inventory_items")
        .select("id, item_specifics")
        .contains("item_specifics", { bulk_buy_id: existing.id });
      for (const r of linked ?? []) {
        const sp = { ...((r.item_specifics || {}) as Record<string, unknown>) };
        delete sp.bulk_buy_id;
        delete sp.bulk_buy_locked;
        await supabase
          .from("inventory_items")
          .update({ item_specifics: sp, updated_at: nowIso })
          .eq("id", r.id);
      }
      const nextList = bulkBuys.filter((b) => b.id !== existing.id);
      await writeBulkBuys(supabase, rowId, specs, nextList);
      return NextResponse.json({
        mode: "live",
        bulkBuys: nextList,
        message: `Deleted bulk buy "${existing.name}" (existing item COGS preserved).`,
      });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    console.error("[/api/bulk-buys] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Bulk buy action failed",
      },
      { status: 500 }
    );
  }
}
