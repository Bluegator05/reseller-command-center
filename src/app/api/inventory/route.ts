import { NextResponse } from "next/server";
import {
  applyDemoNotBulkBuy,
  applyDemoPriceWatcherAction,
  createDemoInventoryItem,
  deleteDemoInventoryItem,
  promoteDemoDraftToActive,
  updateDemoInventoryItem,
} from "@/lib/demo-store";
import { isEbayConfigured, withdrawEbayOffer } from "@/lib/ebay";
import { deactivateEtsyListing, isEtsyConfigured } from "@/lib/etsy";
import { loadCommandCenterData } from "@/lib/inventory-loader";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type {
  ItemDetailUpdateRequest,
  MarketplaceListing,
  QuickAddItemRequest,
} from "@/lib/types";

export async function GET() {
  try {
    const payload = await loadCommandCenterData();
    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load inventory";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as
      | (QuickAddItemRequest & { action?: "create" })
      | { action: "promote_draft"; itemId: string }
      | {
          action: "dispose";
          itemId: string;
          disposition: "donated" | "discarded";
          note?: string;
        }
      | {
          action: "set_relist_count";
          itemId: string;
          relistCount: number;
          lastRelistedAt?: string | null;
        }
      | {
          action: "set_stale_exempt";
          itemId: string;
          exempt: boolean;
        }
      | {
          action: "set_not_bulk_buy";
          itemIds: string[];
          notBulkBuy: boolean;
        }
      | {
          action: "price_watcher_action";
          itemId: string;
          mode: "skip_stage" | "keep" | "reopen";
          stage?: 30 | 45 | 60;
        }
      | {
          action: "set_bin_audit";
          itemId?: string;
          itemIds?: string[];
          auditStatus: "verified" | "missing" | null;
        }
      | {
          action: "complete_inventory_audit";
          totalItems: number;
          verifiedCount: number;
          missingCount: number;
          notes?: string | null;
        }
      | {
          action: "restore_disposed";
          itemId: string;
        }
      | {
          action: "resolve_sold_end_everywhere";
          itemId: string;
        }
      | {
          action: "dismiss_sold_conflict";
          itemId: string;
        };

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (body.action === "complete_inventory_audit") {
      const nowIso = new Date().toISOString();
      const newRecord = {
        id: `audit-${Date.now()}`,
        completedAt: nowIso,
        totalItems: Math.max(0, Math.floor(Number(body.totalItems) || 0)),
        verifiedCount: Math.max(0, Math.floor(Number(body.verifiedCount) || 0)),
        missingCount: Math.max(0, Math.floor(Number(body.missingCount) || 0)),
        notes: body.notes?.trim() ? body.notes.trim().slice(0, 160) : null,
      };

      if (supabase && envReadiness.isSupabaseReady) {
        const { data: existingLog } = await supabase
          .from("inventory_items")
          .select("id, item_specifics")
          .eq("sku", "__RCC_AUDIT_LOG__")
          .maybeSingle();

        const prevSpecs = (existingLog?.item_specifics || {}) as Record<
          string,
          unknown
        >;
        const prevHistory = Array.isArray(prevSpecs.audit_history)
          ? prevSpecs.audit_history
          : [];
        const nextHistory = [newRecord, ...prevHistory].slice(0, 25);

        if (existingLog?.id) {
          const { error: updErr } = await supabase
            .from("inventory_items")
            .update({
              item_specifics: { ...prevSpecs, audit_history: nextHistory },
              updated_at: nowIso,
            })
            .eq("id", existingLog.id);
          if (updErr) {
            return NextResponse.json({ error: updErr.message }, { status: 400 });
          }
        } else {
          const { error: insErr } = await supabase
            .from("inventory_items")
            .insert({
              sku: "__RCC_AUDIT_LOG__",
              title: "System Inventory Audit History",
              condition: "System",
              cogs: 0,
              prep_cost: 0,
              target_price: 0,
              floor_price: 0,
              status: "archived",
              item_specifics: { audit_history: nextHistory },
              updated_at: nowIso,
            });
          if (insErr) {
            return NextResponse.json({ error: insErr.message }, { status: 400 });
          }
        }

        return NextResponse.json({
          mode: "live",
          record: newRecord,
          auditHistory: nextHistory,
        });
      }

      return NextResponse.json({
        mode: "demo",
        record: newRecord,
        auditHistory: [newRecord],
      });
    }

    if (body.action === "set_bin_audit") {
      const targetIds = Array.from(
        new Set(
          [
            ...(Array.isArray(body.itemIds) ? body.itemIds : []),
            ...(body.itemId ? [body.itemId] : []),
          ].filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        )
      );
      if (targetIds.length === 0) {
        return NextResponse.json({ error: "Missing itemId or itemIds" }, { status: 400 });
      }
      const nextStatus: "verified" | "missing" | null =
        body.auditStatus === "verified" || body.auditStatus === "missing"
          ? body.auditStatus
          : null;
      const nowIso = new Date().toISOString();

      if (supabase && envReadiness.isSupabaseReady) {
        const { data: existingRows, error: fetchErr } = await supabase
          .from("inventory_items")
          .select("id, item_specifics")
          .in("id", targetIds);
        if (fetchErr) {
          return NextResponse.json({ error: fetchErr.message }, { status: 400 });
        }

        const rows = existingRows ?? [];
        await Promise.all(
          rows.map(async (row) => {
            const specs = (row.item_specifics || {}) as Record<string, unknown>;
            const nextSpecs: Record<string, unknown> = { ...specs };
            if (nextStatus) {
              nextSpecs.audit_status = nextStatus;
              nextSpecs.audit_verified_at = nowIso;
            } else {
              delete nextSpecs.audit_status;
              delete nextSpecs.audit_verified_at;
            }
            await supabase
              .from("inventory_items")
              .update({ item_specifics: nextSpecs, updated_at: nowIso })
              .eq("id", row.id);
          })
        );

        return NextResponse.json({
          mode: "live",
          updatedCount: rows.length,
          auditStatus: nextStatus,
          auditVerifiedAt: nextStatus ? nowIso : null,
        });
      }

      return NextResponse.json({
        mode: "demo",
        updatedCount: targetIds.length,
        auditStatus: nextStatus,
        auditVerifiedAt: nextStatus ? nowIso : null,
      });
    }

    if (body.action === "set_stale_exempt") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      const exempt = Boolean(body.exempt);
      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        const { data: existing, error: fetchErr } = await supabase
          .from("inventory_items")
          .select("id, item_specifics")
          .eq("id", body.itemId)
          .single();
        if (fetchErr || !existing) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        const specs = (existing.item_specifics || {}) as Record<string, unknown>;
        const nextSpecs: Record<string, unknown> = { ...specs };
        if (exempt) {
          nextSpecs.stale_radar_exempt = "true";
        } else {
          delete nextSpecs.stale_radar_exempt;
        }
        const { data: updated, error: updErr } = await supabase
          .from("inventory_items")
          .update({ item_specifics: nextSpecs, updated_at: nowIso })
          .eq("id", body.itemId)
          .select("*")
          .single();
        if (updErr) {
          return NextResponse.json({ error: updErr.message }, { status: 400 });
        }
        return NextResponse.json({ mode: "live", item: updated, exempt });
      }
      return NextResponse.json({ mode: "demo", exempt });
    }

    if (body.action === "set_not_bulk_buy") {
      const ids = Array.isArray(body.itemIds)
        ? body.itemIds.filter((s) => typeof s === "string" && s.trim())
        : [];
      if (ids.length === 0) {
        return NextResponse.json(
          { error: "Provide at least one itemId" },
          { status: 400 }
        );
      }
      const notBulkBuy = Boolean(body.notBulkBuy);

      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        let updatedCount = 0;

        for (let i = 0; i < ids.length; i += 100) {
          const chunk = ids.slice(i, i + 100);
          const { data: rows, error: fetchErr } = await supabase
            .from("inventory_items")
            .select("id, item_specifics")
            .in("id", chunk);
          if (fetchErr) {
            return NextResponse.json(
              { error: fetchErr.message },
              { status: 400 }
            );
          }

          const list = rows ?? [];
          for (let j = 0; j < list.length; j += 15) {
            const batch = list.slice(j, j + 15);
            await Promise.all(
              batch.map(async (row) => {
                const specs = (row.item_specifics || {}) as Record<
                  string,
                  unknown
                >;
                const nextSpecs: Record<string, unknown> = { ...specs };
                if (notBulkBuy) {
                  nextSpecs.not_bulk_buy = "true";
                } else {
                  delete nextSpecs.not_bulk_buy;
                }
                const { error: updErr } = await supabase
                  .from("inventory_items")
                  .update({ item_specifics: nextSpecs, updated_at: nowIso })
                  .eq("id", row.id);
                if (!updErr) updatedCount += 1;
              })
            );
          }
        }

        return NextResponse.json({
          mode: "live",
          updatedCount,
          notBulkBuy,
        });
      }

      const updatedCount = applyDemoNotBulkBuy({
        itemIds: ids,
        notBulkBuy,
      });
      return NextResponse.json({
        mode: "demo",
        updatedCount,
        notBulkBuy,
      });
    }

    if (body.action === "price_watcher_action") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      const mode = body.mode;
      const validStage =
        body.stage === 30 || body.stage === 45 || body.stage === 60
          ? body.stage
          : undefined;

      if (mode === "skip_stage" && !validStage) {
        return NextResponse.json(
          { error: "Missing valid stage (30, 45, or 60)" },
          { status: 400 }
        );
      }

      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        const { data: existing, error: fetchErr } = await supabase
          .from("inventory_items")
          .select("id, sku, item_specifics")
          .eq("id", body.itemId)
          .single();
        if (fetchErr || !existing) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }

        const specs = (existing.item_specifics || {}) as Record<string, unknown>;
        const nextSpecs: Record<string, unknown> = { ...specs };
        const prevLog = Array.isArray(specs.activity_log) ? specs.activity_log : [];

        let logTitle = "Price Watcher updated";
        let logDetail = "";
        if (mode === "skip_stage" && validStage) {
          const prevStage = Number(specs.price_watcher_stage) || 0;
          nextSpecs.price_watcher_stage = String(Math.max(prevStage, validStage));
          nextSpecs.price_watcher_last_action_at = nowIso;
          logTitle = `Price Watcher: Skipped ${validStage}d drop`;
          logDetail = `Acknowledged ${validStage}-day markdown without lowering price`;
        } else if (mode === "keep") {
          nextSpecs.price_watcher_stage = "90";
          nextSpecs.price_watcher_decision = "keep";
          nextSpecs.price_watcher_decision_at = nowIso;
          logTitle = "Price Watcher: Keep listing (90d+)";
          logDetail = "Decided to keep active instead of delisting/donating";
        } else if (mode === "reopen") {
          delete nextSpecs.price_watcher_decision;
          delete nextSpecs.price_watcher_decision_at;
          if (String(nextSpecs.price_watcher_stage) === "90") {
            nextSpecs.price_watcher_stage = "60";
          }
          logTitle = "Price Watcher: Re-opened 90d decision";
          logDetail = "Moved back into 90-day Keep vs Delist/Donate review queue";
        }

        nextSpecs.activity_log = [
          {
            id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            type: "note",
            timestamp: nowIso,
            title: logTitle,
            detail: logDetail,
          },
          ...prevLog.slice(0, 49),
        ];

        const { data: updated, error: updErr } = await supabase
          .from("inventory_items")
          .update({ item_specifics: nextSpecs, updated_at: nowIso })
          .eq("id", body.itemId)
          .select("*")
          .single();
        if (updErr) {
          return NextResponse.json({ error: updErr.message }, { status: 400 });
        }
        return NextResponse.json({ mode: "live", item: updated, actionMode: mode });
      }

      const demoItem = applyDemoPriceWatcherAction({
        itemId: body.itemId,
        mode,
        stage: validStage,
      });
      return NextResponse.json({
        mode: "demo",
        item: demoItem,
        actionMode: mode,
      });
    }

    if (body.action === "set_relist_count") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      const nextCount = Math.max(0, Math.floor(Number(body.relistCount) || 0));
      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        const { data: existing, error: fetchErr } = await supabase
          .from("inventory_items")
          .select("id, item_specifics")
          .eq("id", body.itemId)
          .single();
        if (fetchErr || !existing) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        const specs = (existing.item_specifics || {}) as Record<string, unknown>;
        const nextSpecs: Record<string, unknown> = {
          ...specs,
          relist_count: String(nextCount),
        };
        if (nextCount > 0) {
          nextSpecs.last_relisted_at =
            body.lastRelistedAt ||
            (typeof specs.last_relisted_at === "string"
              ? specs.last_relisted_at
              : nowIso);
        } else {
          delete nextSpecs.last_relisted_at;
        }
        const { data: updated, error: updErr } = await supabase
          .from("inventory_items")
          .update({ item_specifics: nextSpecs, updated_at: nowIso })
          .eq("id", body.itemId)
          .select("*")
          .single();
        if (updErr) {
          return NextResponse.json({ error: updErr.message }, { status: 400 });
        }
        return NextResponse.json({ mode: "live", item: updated, relistCount: nextCount });
      }
      return NextResponse.json({ mode: "demo", relistCount: nextCount });
    }

    if (body.action === "dispose") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      const disposition =
        body.disposition === "discarded" ? "discarded" : "donated";
      const nowIso = new Date().toISOString();
      const dateTag = nowIso.slice(0, 10);

      if (supabase && envReadiness.isSupabaseReady) {
        const { data: item, error: itemErr } = await supabase
          .from("inventory_items")
          .select("*")
          .eq("id", body.itemId)
          .single();
        if (itemErr || !item) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }

        const { data: listingsData } = await supabase
          .from("marketplace_listings")
          .select("*")
          .eq("item_id", item.id)
          .in("status", ["active", "draft"]);

        const activeListings = (listingsData ?? []) as MarketplaceListing[];
        const endedChannels: string[] = [];
        const queuedDelists: string[] = [];
        const errors: string[] = [];

        for (const lst of activeListings) {
          const isApi = lst.marketplace === "ebay" || lst.marketplace === "etsy";
          if (isApi) {
            try {
              if (
                lst.marketplace === "ebay" &&
                lst.external_listing_id &&
                isEbayConfigured()
              ) {
                await withdrawEbayOffer(lst.external_listing_id, item.sku);
              } else if (
                lst.marketplace === "etsy" &&
                lst.external_listing_id &&
                isEtsyConfigured()
              ) {
                await deactivateEtsyListing(lst.external_listing_id);
              }
              endedChannels.push(lst.marketplace.toUpperCase());
            } catch (err) {
              errors.push(
                `${lst.marketplace.toUpperCase()}: ${err instanceof Error ? err.message : "Failed to end"}`
              );
            }
            await supabase
              .from("marketplace_listings")
              .update({ status: "ended", last_synced_at: nowIso })
              .eq("id", lst.id);
          } else {
            // Queue urgent extension auto-delist for Poshmark / Mercari / Facebook
            await supabase.from("channel_jobs").insert({
              item_id: item.id,
              listing_id: lst.id,
              marketplace: lst.marketplace,
              action: "delist",
              execution_mode: "extension",
              payload: {
                sku: item.sku,
                title: item.title,
                externalListingId: lst.external_listing_id,
                externalUrl: lst.external_url,
                reason: disposition.toUpperCase(),
              },
              status: "pending",
              attempts: 0,
            });
            queuedDelists.push(lst.marketplace.toUpperCase());
          }
        }

        const existingSpecs = (item.item_specifics || {}) as Record<
          string,
          unknown
        >;
        const prevLog = Array.isArray(existingSpecs.activity_log)
          ? existingSpecs.activity_log
          : [];
        const tag = `[${disposition.toUpperCase()} ${dateTag}]${body.note?.trim() ? ` ${body.note.trim()}` : ""}`;
        const nextNotes = item.notes ? `${item.notes} · ${tag}` : tag;

        await supabase
          .from("inventory_items")
          .update({
            status: "archived",
            notes: nextNotes,
            item_specifics: {
              ...existingSpecs,
              disposition,
              disposition_at: nowIso,
              disposal_status: disposition,
              disposal_date: nowIso,
              disposal_notes: body.note?.trim() || null,
              activity_log: [
                {
                  id: `evt-${Date.now()}`,
                  type: disposition,
                  timestamp: nowIso,
                  title:
                    disposition === "donated"
                      ? "Marked as Donated"
                      : "Marked as Discarded",
                  detail: body.note?.trim() || "Removed from active inventory",
                },
                ...prevLog.slice(0, 49),
              ],
            },
            updated_at: nowIso,
          })
          .eq("id", item.id);

        const label = disposition === "donated" ? "Donated" : "Discarded";
        const parts: string[] = [];
        if (endedChannels.length > 0) parts.push(`ended ${endedChannels.join(", ")}`);
        if (queuedDelists.length > 0)
          parts.push(`queued auto-delist on ${queuedDelists.join(", ")}`);

        return NextResponse.json({
          mode: "live",
          disposition,
          endedChannels,
          queuedDelists,
          errors,
          message: `${label} ${item.sku}${parts.length > 0 ? ` — ${parts.join(" & ")}` : ""}.`,
        });
      }

      deleteDemoInventoryItem(body.itemId);
      return NextResponse.json({
        mode: "demo",
        disposition,
        endedChannels: ["EBAY"],
        queuedDelists: [],
        message: `Marked item ${disposition} in demo store.`,
      });
    }

    if (body.action === "restore_disposed") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        const { data: item, error: itemErr } = await supabase
          .from("inventory_items")
          .select("id, sku, item_specifics")
          .eq("id", body.itemId)
          .single();
        if (itemErr || !item) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        const existingSpecs = (item.item_specifics || {}) as Record<
          string,
          unknown
        >;
        const nextSpecs: Record<string, unknown> = { ...existingSpecs };
        delete nextSpecs.disposition;
        delete nextSpecs.disposition_at;
        delete nextSpecs.disposal_status;
        delete nextSpecs.disposal_date;
        delete nextSpecs.disposal_notes;
        const prevLog = Array.isArray(existingSpecs.activity_log)
          ? existingSpecs.activity_log
          : [];
        nextSpecs.activity_log = [
          {
            id: `evt-${Date.now()}`,
            type: "restored",
            timestamp: nowIso,
            title: "Restored to Draft Inventory",
            detail: "Removed donated/discarded status",
          },
          ...prevLog.slice(0, 49),
        ];

        const { error: updErr } = await supabase
          .from("inventory_items")
          .update({
            status: "draft",
            item_specifics: nextSpecs,
            updated_at: nowIso,
          })
          .eq("id", item.id);
        if (updErr) {
          return NextResponse.json({ error: updErr.message }, { status: 400 });
        }
        return NextResponse.json({
          mode: "live",
          message: `Restored ${item.sku} back to Draft Inventory.`,
        });
      }
      return NextResponse.json({ mode: "demo", message: "Restored in demo mode." });
    }

    if (body.action === "resolve_sold_end_everywhere") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      const nowIso = new Date().toISOString();

      if (supabase && envReadiness.isSupabaseReady) {
        const { data: item, error: itemErr } = await supabase
          .from("inventory_items")
          .select("*")
          .eq("id", body.itemId)
          .single();
        if (itemErr || !item) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }

        const { data: listingsData } = await supabase
          .from("marketplace_listings")
          .select("*")
          .eq("item_id", item.id)
          .in("status", ["active", "draft"]);

        const activeListings = (listingsData ?? []) as MarketplaceListing[];

        const { data: existingDelists } = await supabase
          .from("channel_jobs")
          .select("marketplace, status")
          .eq("item_id", item.id)
          .eq("action", "delist")
          .in("status", ["pending", "processing"]);
        const alreadyQueued = new Set(
          (existingDelists ?? []).map((j) => String(j.marketplace))
        );

        const endedChannels: string[] = [];
        const queuedDelists: string[] = [];
        const errors: string[] = [];

        for (const lst of activeListings) {
          const isApi = lst.marketplace === "ebay" || lst.marketplace === "etsy";
          if (isApi) {
            try {
              if (
                lst.marketplace === "ebay" &&
                lst.external_listing_id &&
                isEbayConfigured()
              ) {
                await withdrawEbayOffer(lst.external_listing_id, item.sku);
              } else if (
                lst.marketplace === "etsy" &&
                lst.external_listing_id &&
                isEtsyConfigured()
              ) {
                await deactivateEtsyListing(lst.external_listing_id);
              }
              endedChannels.push(lst.marketplace.toUpperCase());
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : "Failed to end";
              if (/closed|already ended|not active|does not exist/i.test(errMsg)) {
                endedChannels.push(lst.marketplace.toUpperCase());
              } else {
                errors.push(`${lst.marketplace.toUpperCase()}: ${errMsg}`);
              }
            }
            await supabase
              .from("marketplace_listings")
              .update({ status: "ended", last_synced_at: nowIso })
              .eq("id", lst.id);
          } else {
            if (!alreadyQueued.has(lst.marketplace)) {
              await supabase.from("channel_jobs").insert({
                item_id: item.id,
                listing_id: lst.id,
                marketplace: lst.marketplace,
                action: "delist",
                execution_mode: "extension",
                payload: {
                  sku: item.sku,
                  title: item.title,
                  externalListingId: lst.external_listing_id,
                  externalUrl: lst.external_url,
                  reason: "ALREADY_SOLD_CONFLICT",
                },
                status: "pending",
                attempts: 0,
              });
              queuedDelists.push(lst.marketplace.toUpperCase());
            } else {
              queuedDelists.push(`${lst.marketplace.toUpperCase()} (already queued)`);
            }
            await supabase
              .from("marketplace_listings")
              .update({ status: "ended", last_synced_at: nowIso })
              .eq("id", lst.id);
          }
        }

        const existingSpecs = (item.item_specifics || {}) as Record<
          string,
          unknown
        >;
        const prevLog = Array.isArray(existingSpecs.activity_log)
          ? existingSpecs.activity_log
          : [];
        const detailParts: string[] = [];
        if (endedChannels.length > 0) {
          detailParts.push(`Ended on ${endedChannels.join(", ")}`);
        }
        if (queuedDelists.length > 0) {
          detailParts.push(`Queued delist on ${queuedDelists.join(", ")}`);
        }

        const nextSpecs: Record<string, unknown> = {
          ...existingSpecs,
          activity_log: [
            {
              id: `evt-${Date.now()}`,
              type: "delisted",
              timestamp: nowIso,
              title: "Ended & Delisted Everywhere (Already Sold)",
              detail:
                detailParts.length > 0
                  ? detailParts.join(" · ")
                  : "Marked item Sold and removed from Active Inventory",
            },
            ...prevLog.slice(0, 49),
          ],
        };

        await supabase
          .from("inventory_items")
          .update({
            status: "sold",
            item_specifics: nextSpecs,
            updated_at: nowIso,
          })
          .eq("id", item.id);

        const msgParts: string[] = [];
        if (endedChannels.length > 0) {
          msgParts.push(`ended on ${endedChannels.join(", ")} via API`);
        }
        if (queuedDelists.length > 0) {
          msgParts.push(`queued Auto-Pilot delist on ${queuedDelists.join(", ")}`);
        }
        if (errors.length > 0) {
          msgParts.push(`warning: ${errors.join("; ")}`);
        }

        return NextResponse.json({
          mode: "live",
          sku: item.sku,
          endedChannels,
          queuedDelists,
          errors,
          message: `Marked ${item.sku} Sold${msgParts.length > 0 ? ` — ${msgParts.join(" · ")}` : ""}.`,
        });
      }

      deleteDemoInventoryItem(body.itemId);
      return NextResponse.json({
        mode: "demo",
        endedChannels: ["EBAY"],
        queuedDelists: [],
        message: "Ended & marked sold in demo store.",
      });
    }

    if (body.action === "dismiss_sold_conflict") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      const nowIso = new Date().toISOString();
      if (supabase && envReadiness.isSupabaseReady) {
        const { data: item, error: itemErr } = await supabase
          .from("inventory_items")
          .select("id, sku, item_specifics")
          .eq("id", body.itemId)
          .single();
        if (itemErr || !item) {
          return NextResponse.json({ error: "Item not found" }, { status: 404 });
        }
        const existingSpecs = (item.item_specifics || {}) as Record<
          string,
          unknown
        >;
        const nextSpecs: Record<string, unknown> = {
          ...existingSpecs,
          sold_conflict_dismissed_at: nowIso,
        };
        const { error: updErr } = await supabase
          .from("inventory_items")
          .update({ item_specifics: nextSpecs, updated_at: nowIso })
          .eq("id", item.id);
        if (updErr) {
          return NextResponse.json({ error: updErr.message }, { status: 400 });
        }
        return NextResponse.json({
          mode: "live",
          message: `Kept ${item.sku} active and cleared the sold-conflict alert.`,
        });
      }
      return NextResponse.json({
        mode: "demo",
        message: "Cleared sold-conflict alert in demo mode.",
      });
    }

    if (body.action === "promote_draft") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        const { data: item, error } = await supabase
          .from("inventory_items")
          .update({ status: "active", updated_at: nowIso })
          .eq("id", body.itemId)
          .select("*")
          .single();
        if (error || !item) {
          return NextResponse.json(
            { error: error?.message || "Draft item not found" },
            { status: 400 }
          );
        }
        const isFbOnly =
          (item.item_specifics as Record<string, unknown> | null)?.fb_local_only ===
          "true";
        await supabase.from("marketplace_listings").upsert(
          {
            item_id: item.id,
            marketplace: isFbOnly ? "facebook" : "ebay",
            listed_price: item.target_price,
            shipping_price: isFbOnly ? 0 : 8.95,
            status: "active",
            listed_at: nowIso,
            last_synced_at: nowIso,
          },
          { onConflict: "item_id,marketplace" }
        );
        return NextResponse.json({ mode: "live", item });
      }

      const promoted = promoteDemoDraftToActive(body.itemId);
      if (!promoted) {
        return NextResponse.json(
          { error: "Draft item not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({ mode: "demo", item: promoted });
    }

    const req = body as QuickAddItemRequest;
    if (!req?.title?.trim()) {
      return NextResponse.json(
        { error: "Item title is required" },
        { status: 400 }
      );
    }

    if (supabase && envReadiness.isSupabaseReady) {
      const nowIso = new Date().toISOString();
      const isFbOnly = Boolean(req.fbLocalOnly);
      const sku =
        req.sku?.trim() ||
        `${isFbOnly ? "FB" : "SKU"}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const { data: created, error } = await supabase
        .from("inventory_items")
        .insert({
          sku,
          title: req.title.trim(),
          condition: req.condition?.trim() || "Pre-owned — Very Good",
          brand: req.brand?.trim() || null,
          category_hint: req.category_hint?.trim() || null,
          cogs: Number(req.cogs) || 0,
          prep_cost: Number(req.prep_cost) || 0,
          target_price: Number(req.target_price) || 0,
          floor_price: Number(req.floor_price) || 0,
          bin_location: req.bin_location?.trim() || null,
          source_location: req.source_location?.trim() || null,
          source_type: req.source_type || "thrift",
          payment_method: req.payment_method || "Business Amex",
          receipt_ref: req.receipt_ref?.trim() || null,
          tax_category: req.tax_category || "inventory_cogs",
          notes: req.notes?.trim() || null,
          weight_oz: req.weight_oz ?? null,
          length_in: req.length_in ?? null,
          width_in: req.width_in ?? null,
          height_in: req.height_in ?? null,
          item_specifics: isFbOnly
            ? { fb_local_only: "true", fulfillment_type: "local_pickup" }
            : {},
          status: req.initialStatus,
          acquired_at: req.acquired_at || nowIso,
        })
        .select("*")
        .single();

      if (error || !created) {
        return NextResponse.json(
          { error: error?.message || "Failed to create item" },
          { status: 400 }
        );
      }

      if (req.initialStatus === "active") {
        await supabase.from("marketplace_listings").insert({
          item_id: created.id,
          marketplace: isFbOnly ? "facebook" : "ebay",
          listed_price: created.target_price,
          shipping_price: isFbOnly ? 0 : 8.95,
          status: "active",
          listed_at: nowIso,
          last_synced_at: nowIso,
        });
      }
      return NextResponse.json({ mode: "live", item: created }, { status: 201 });
    }

    const item = createDemoInventoryItem(req);
    return NextResponse.json({ mode: "demo", item }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create inventory item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as ItemDetailUpdateRequest;
    if (!body?.itemId) {
      return NextResponse.json(
        { error: "Missing required itemId" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (supabase && envReadiness.isSupabaseReady) {
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      const allowedFields: Array<keyof ItemDetailUpdateRequest> = [
        "sku",
        "title",
        "condition",
        "brand",
        "category_hint",
        "cogs",
        "prep_cost",
        "target_price",
        "floor_price",
        "bin_location",
        "source_location",
        "source_type",
        "payment_method",
        "receipt_ref",
        "tax_category",
        "notes",
        "acquired_at",
        "weight_oz",
        "length_in",
        "width_in",
        "height_in",
      ];
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
        }
      }

      const { data, error } = await supabase
        .from("inventory_items")
        .update(updates)
        .eq("id", body.itemId)
        .select("*")
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", item: data });
    }

    const updated = updateDemoInventoryItem(body);
    if (!updated) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ mode: "demo", item: updated });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update inventory item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json(
        { error: "Missing required id query parameter" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (supabase && envReadiness.isSupabaseReady) {
      const { error } = await supabase
        .from("inventory_items")
        .delete()
        .eq("id", id);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", deletedId: id });
    }

    const removed = deleteDemoInventoryItem(id);
    if (!removed) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ mode: "demo", deletedId: id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete inventory item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
