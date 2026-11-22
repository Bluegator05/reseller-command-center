"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  Archive,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Compass,
  Info,
  Lock,
  Plus,
  Puzzle,
  Send,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { AnalyticsTaxPanel } from "./AnalyticsTaxPanel";
import { BinAuditPanel } from "./BinAuditPanel";
import { BuildRoadmapPanel } from "./BuildRoadmapPanel";
import { ChannelStatusStrip } from "./ChannelStatusStrip";
import { CrossListDrawer } from "./CrossListDrawer";
import { ExtensionQueuePanel } from "./ExtensionQueuePanel";
import { ItemDetailModal } from "./ItemDetailModal";
import { QuickAddItemModal } from "./QuickAddItemModal";
import { SalesLedgerPanel } from "./SalesLedgerPanel";
import { SourcingCompsPanel } from "./SourcingCompsPanel";
import { StaleRadarTable } from "./StaleRadarTable";
import { WatcherOffersPanel } from "./WatcherOffersPanel";
import type {
  AutoDelistCascadeResult,
  CommandCenterPayload,
  EbayActionRequest,
  EbayActionResponse,
  EbaySyncResponse,
  EtsyCrossListResult,
  EtsySyncResponse,
  ExpenseCategoryType,
  ItemDetailUpdateRequest,
  JobStatusType,
  MarketplaceType,
  QuickAddItemRequest,
  SalesOrderUpdateRequest,
  StaleRadarRow,
} from "@/lib/types";

interface CommandCenterShellProps {
  initialData: CommandCenterPayload;
}

interface ToastMessage {
  id: string;
  tone: "success" | "info" | "error";
  title: string;
  detail?: string;
}

export function CommandCenterShell({ initialData }: CommandCenterShellProps) {
  const router = useRouter();
  const [data, setData] = useState<CommandCenterPayload>(initialData);
  const [activeTab, setActiveTab] = useState<
    | "radar"
    | "offers"
    | "sourcing"
    | "bins"
    | "extension"
    | "sales"
    | "analytics"
    | "roadmap"
  >("radar");
  const [lockEnabled, setLockEnabled] = useState(false);
  const [mountNow] = useState(() => Date.now());
  const [sentOfferIds, setSentOfferIds] = useState<Set<string>>(new Set());
  const [eligibleOfferExternalIds, setEligibleOfferExternalIds] =
    useState<Set<string> | null>(null);
  const [isCheckingEligible, setIsCheckingEligible] = useState(false);
  const [eligibleChecked, setEligibleChecked] = useState(false);

  const isLiveMode = data.mode === "live";

  const refreshEligibleOffers = useCallback(async () => {
    if (!isLiveMode) return;
    setIsCheckingEligible(true);
    try {
      const res = await fetch("/api/ebay/eligible-offers", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const payload = (await res.json()) as {
        mode?: string;
        listingIds?: string[] | null;
      };
      if (payload.mode === "live" && Array.isArray(payload.listingIds)) {
        setEligibleOfferExternalIds(new Set(payload.listingIds));
        setEligibleChecked(true);
      }
    } catch {
      // ignore transient network errors
    } finally {
      setIsCheckingEligible(false);
    }
  }, [isLiveMode]);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { lockEnabled?: boolean } | null) => {
        if (d?.lockEnabled) setLockEnabled(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isLiveMode) return;
    let cancelled = false;
    fetch("/api/ebay/eligible-offers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { mode?: string; listingIds?: string[] | null } | null) => {
        if (cancelled || !payload) return;
        if (payload.mode === "live" && Array.isArray(payload.listingIds)) {
          setEligibleOfferExternalIds(new Set(payload.listingIds));
          setEligibleChecked(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLiveMode]);
  const [isSyncingEbay, setIsSyncingEbay] = useState(false);
  const [isSyncingEtsy, setIsSyncingEtsy] = useState(false);
  const [busyListingIds, setBusyListingIds] = useState<Set<string>>(new Set());
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const [crossListState, setCrossListState] = useState<{
    row: StaleRadarRow;
    target: Exclude<MarketplaceType, "ebay">;
  } | null>(null);
  const [detailModalItemId, setDetailModalItemId] = useState<string | null>(
    null
  );
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const pushToast = useCallback(
    (tone: ToastMessage["tone"], title: string, detail?: string) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [{ id, tone, title, detail }, ...prev].slice(0, 4));
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 6000);
    },
    []
  );

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const refreshInventory = useCallback(async () => {
    const res = await fetch("/api/inventory", { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Failed to refresh inventory");
    }
    const fresh = (await res.json()) as CommandCenterPayload;
    setData(fresh);
  }, []);

  const handleSyncEbay = useCallback(async () => {
    setIsSyncingEbay(true);
    try {
      const res = await fetch("/api/ebay/sync", { method: "POST" });
      const payload = (await res.json()) as EbaySyncResponse & {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error || "eBay sync failed");
      await refreshInventory();
      pushToast(
        "success",
        payload.mode === "live"
          ? `Synced ${payload.syncedCount} live eBay listings`
          : `Demo Sync: ${payload.syncedCount} active eBay listings`,
        payload.message
      );
    } catch (error) {
      pushToast(
        "error",
        "eBay Sync Failed",
        error instanceof Error ? error.message : "Unknown error"
      );
    } finally {
      setIsSyncingEbay(false);
    }
  }, [pushToast, refreshInventory]);

  const handleSyncEtsy = useCallback(async () => {
    setIsSyncingEtsy(true);
    try {
      const res = await fetch("/api/etsy/sync", { method: "POST" });
      const payload = (await res.json()) as EtsySyncResponse & {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error || "Etsy sync failed");
      await refreshInventory();
      pushToast(
        "success",
        `Etsy Sync: ${payload.syncedCount} cross-listed SKU${payload.syncedCount === 1 ? "" : "s"}`,
        payload.message
      );
    } catch (error) {
      pushToast(
        "error",
        "Etsy Sync Failed",
        error instanceof Error ? error.message : "Unknown error"
      );
    } finally {
      setIsSyncingEtsy(false);
    }
  }, [pushToast, refreshInventory]);

  const handleExecuteAction = useCallback(
    async (request: EbayActionRequest) => {
      const isBulk = request.listingIds.length > 1;
      if (isBulk) {
        setIsBulkBusy(true);
      } else {
        setBusyListingIds((prev) => {
          const next = new Set(prev);
          for (const id of request.listingIds) next.add(id);
          return next;
        });
      }

      try {
        const res = await fetch("/api/ebay/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const payload = (await res.json()) as EbayActionResponse & {
          error?: string;
        };
        if (!res.ok) throw new Error(payload.error || "Failed to execute action");

        await refreshInventory();

        if (payload.results.length === 1) {
          const r = payload.results[0];
          pushToast(
            r.status === "failed"
              ? "error"
              : r.status === "skipped"
                ? "info"
                : "success",
            `${r.sku} — ${r.status === "completed" ? "Action Complete" : r.status === "skipped" ? "Protected / Skipped" : "Failed"}`,
            r.message
          );
        } else {
          pushToast(
            payload.failedCount > 0 ? "error" : "success",
            `Bulk Action: ${payload.completedCount} completed${payload.skippedCount > 0 ? `, ${payload.skippedCount} protected/skipped` : ""}`,
            payload.results
              .slice(0, 2)
              .map((r) => `${r.sku}: ${r.message}`)
              .join(" • ")
          );
        }
      } catch (error) {
        pushToast(
          "error",
          "Intervention Failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      } finally {
        if (isBulk) {
          setIsBulkBusy(false);
        } else {
          setBusyListingIds((prev) => {
            const next = new Set(prev);
            for (const id of request.listingIds) next.delete(id);
            return next;
          });
        }
      }
    },
    [pushToast, refreshInventory]
  );

  const handleBulkCrossListEtsy = useCallback(
    async (itemIds: string[]) => {
      if (itemIds.length === 0) return;
      setIsBulkBusy(true);
      try {
        const res = await fetch("/api/etsy/crosslist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds, publishImmediately: true }),
        });
        const payload = (await res.json()) as {
          completedCount?: number;
          results?: EtsyCrossListResult[];
          error?: string;
        };
        if (!res.ok) throw new Error(payload.error || "Bulk Etsy cross-list failed");

        await refreshInventory();
        pushToast(
          "success",
          `Cross-Listed ${payload.completedCount ?? 0} SKU${payload.completedCount === 1 ? "" : "s"} to Etsy`,
          payload.results
            ?.slice(0, 2)
            .map((r) => `${r.sku} ($${r.listedPrice.toFixed(2)})`)
            .join(" • ")
        );
      } catch (error) {
        pushToast(
          "error",
          "Bulk Etsy Cross-List Failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      } finally {
        setIsBulkBusy(false);
      }
    },
    [pushToast, refreshInventory]
  );

  const handleDrawerPublishedEtsy = useCallback(
    async (result: EtsyCrossListResult) => {
      await refreshInventory();
      pushToast(
        "success",
        `${result.sku} Cross-Listed to Etsy`,
        result.message
      );
    },
    [pushToast, refreshInventory]
  );

  const handleDrawerQueuedExtension = useCallback(
    async (params: {
      marketplace: Exclude<MarketplaceType, "ebay">;
      sku: string;
      price: number;
      launchedLocally?: boolean;
    }) => {
      await refreshInventory();
      pushToast(
        "success",
        params.launchedLocally
          ? `Opening ${params.marketplace.toUpperCase()} & Auto-Filling`
          : `${params.sku} Sent to Mac Mini Auto-Pilot`,
        params.launchedLocally
          ? `Uploading all eBay photos & filling ${params.sku} at $${params.price.toFixed(2)} in a new tab.`
          : `Mac Mini Auto-Pilot will upload all eBay photos and save a ${params.marketplace} Draft at $${params.price.toFixed(2)} within ~30s.`
      );
    },
    [pushToast, refreshInventory]
  );

  const handleUpdateExtensionJob = useCallback(
    async (params: {
      jobId: string;
      status: JobStatusType;
      externalUrl?: string;
      listedPrice?: number;
    }) => {
      try {
        const res = await fetch("/api/extension/jobs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
        if (!res.ok) throw new Error("Failed to update extension job");
        await refreshInventory();
        pushToast(
          params.status === "needs_user_confirm" ? "info" : "success",
          params.status === "needs_user_confirm"
            ? "Paused for Manual Publish Confirmation"
            : "Extension Job Completed",
          params.status === "needs_user_confirm"
            ? "FB Marketplace form filled — confirm once published."
            : "Active marketplace_listings updated."
        );
      } catch (error) {
        pushToast(
          "error",
          "Extension Update Failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    },
    [pushToast, refreshInventory]
  );

  const handleTriggerWebhookSale = useCallback(
    async (params: {
      itemId: string;
      marketplace: "ebay" | "etsy";
      grossSalePrice: number;
    }): Promise<AutoDelistCascadeResult | null> => {
      try {
        const endpoint =
          params.marketplace === "etsy"
            ? "/api/webhooks/etsy"
            : "/api/webhooks/ebay";
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: params.itemId,
            grossSalePrice: params.grossSalePrice,
          }),
        });
        const payload = (await res.json()) as AutoDelistCascadeResult & {
          error?: string;
        };
        if (!res.ok) throw new Error(payload.error || "Webhook processing failed");
        await refreshInventory();
        pushToast("success", "Sale Recorded & Auto-Delist Triggered", payload.message);
        return payload;
      } catch (error) {
        pushToast(
          "error",
          "Webhook Sale Failed",
          error instanceof Error ? error.message : "Unknown error"
        );
        return null;
      }
    },
    [pushToast, refreshInventory]
  );

  const handleTriggerInboundEmail = useCallback(
    async (email: {
      from: string;
      subject: string;
      text: string;
    }): Promise<AutoDelistCascadeResult | null> => {
      try {
        const res = await fetch("/api/inbound/order-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(email),
        });
        const payload = (await res.json()) as AutoDelistCascadeResult & {
          error?: string;
        };
        if (!res.ok) throw new Error(payload.error || "Order email parse failed");
        await refreshInventory();
        pushToast("success", "Order Email Parsed & Auto-Delisted", payload.message);
        return payload;
      } catch (error) {
        pushToast(
          "error",
          "Order Email Parse Failed",
          error instanceof Error ? error.message : "Unknown error"
        );
        return null;
      }
    },
    [pushToast, refreshInventory]
  );

  const staleCount = data.items.filter((i) => i.is_stale).length;

  const eligibleOfferRows = useMemo(() => {
    const cutoff = mountNow - 96 * 60 * 60 * 1000;
    const recentlySent = new Set<string>(sentOfferIds);
    for (const job of data.recentJobs) {
      if (job.action !== "send_offer" || job.status !== "completed") continue;
      if (!job.listing_id) continue;
      const ts = Date.parse(job.completed_at || job.created_at || "");
      if (!Number.isNaN(ts) && ts >= cutoff) {
        recentlySent.add(job.listing_id);
      }
    }
    return data.items
      .filter((row) => {
        if (row.is_at_floor) return false;
        if (recentlySent.has(row.listing_id)) return false;
        if (eligibleOfferExternalIds !== null) {
          return Boolean(
            row.external_listing_id &&
              eligibleOfferExternalIds.has(row.external_listing_id)
          );
        }
        return row.watchers_count > 0;
      })
      .sort((a, b) => b.watchers_count - a.watchers_count);
  }, [data.items, data.recentJobs, eligibleOfferExternalIds, mountNow, sentOfferIds]);

  const extensionActionableCount = data.extensionJobs.filter(
    (j) =>
      j.status === "pending" ||
      j.status === "processing" ||
      j.status === "needs_user_confirm"
  ).length;

  const toShipCount = data.salesOrders.filter(
    (o) =>
      o.fulfillment_status === "to_ship" || o.fulfillment_status === "picked"
  ).length;

  return (
    <div className="min-h-screen flex bg-[#F7F9F8]">
      {/* Persistent Left Icon Navigation Rail (Single Source of Navigation) */}
      <aside className="flex flex-col items-center w-[72px] shrink-0 bg-white border-r border-[#E4E4DD] py-3 px-1.5 sticky top-0 h-screen overflow-y-auto z-40">
        <button
          type="button"
          onClick={() => setActiveTab("radar")}
          title="Reseller Command Center"
          className="w-10 h-10 rounded-xl bg-[#0F766E] text-white flex items-center justify-center shrink-0 mb-3 cursor-pointer"
        >
          <Compass className="w-5 h-5" />
        </button>

        <nav
          aria-label="Command Center Views"
          className="flex flex-col gap-1 w-full"
        >
          <button
            id="tab-stale-radar"
            type="button"
            onClick={() => setActiveTab("radar")}
            className={`relative w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "radar"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <Activity className="w-4 h-4" />
            <span>Inventory</span>
            {staleCount > 0 && (
              <span className="absolute top-1 right-1.5 min-w-[16px] h-4 px-1 rounded-full font-mono tabular-nums text-[9px] font-bold bg-[#B45309] text-white inline-flex items-center justify-center">
                {staleCount}
              </span>
            )}
          </button>

          <button
            id="tab-watcher-offers"
            type="button"
            onClick={() => setActiveTab("offers")}
            className={`relative w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "offers"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <Send className="w-4 h-4" />
            <span>Offers</span>
            {eligibleOfferRows.length > 0 && (
              <span className="absolute top-1 right-1.5 min-w-[16px] h-4 px-1 rounded-full font-mono tabular-nums text-[9px] font-bold bg-[#0F766E] text-white inline-flex items-center justify-center">
                {eligibleOfferRows.length}
              </span>
            )}
          </button>

          <button
            id="tab-extension-queue"
            type="button"
            onClick={() => setActiveTab("extension")}
            className={`relative w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "extension"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <Puzzle className="w-4 h-4" />
            <span>Queue</span>
            {extensionActionableCount > 0 && (
              <span className="absolute top-1 right-1.5 min-w-[16px] h-4 px-1 rounded-full font-mono tabular-nums text-[9px] font-bold bg-[#1D4ED8] text-white inline-flex items-center justify-center">
                {extensionActionableCount}
              </span>
            )}
          </button>

          <button
            id="tab-sales-ledger"
            type="button"
            onClick={() => setActiveTab("sales")}
            className={`relative w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "sales"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Sales</span>
            {toShipCount > 0 && (
              <span className="absolute top-1 right-1.5 min-w-[16px] h-4 px-1 rounded-full font-mono tabular-nums text-[9px] font-bold bg-[#0F766E] text-white inline-flex items-center justify-center">
                {toShipCount}
              </span>
            )}
          </button>

          <button
            id="tab-sourcing-comps"
            type="button"
            onClick={() => setActiveTab("sourcing")}
            className={`w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "sourcing"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span>Sourcing</span>
          </button>

          <button
            id="tab-bin-audit"
            type="button"
            onClick={() => setActiveTab("bins")}
            className={`w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "bins"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <Archive className="w-4 h-4" />
            <span>Bins</span>
          </button>

          <button
            id="tab-analytics-tax"
            type="button"
            onClick={() => setActiveTab("analytics")}
            className={`w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "analytics"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>Taxes</span>
          </button>

          <button
            id="tab-build-roadmap"
            type="button"
            onClick={() => setActiveTab("roadmap")}
            className={`w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              activeTab === "roadmap"
                ? "bg-[#ECFDF5] text-[#0F766E]"
                : "text-[#5C606B] hover:bg-[#F2F6F4] hover:text-[#14151A]"
            }`}
          >
            <ClipboardList className="w-4 h-4" />
            <span>Phases</span>
          </button>
        </nav>

        <div className="mt-auto pt-3 w-full">
          <button
            type="button"
            onClick={async () => {
              if (!lockEnabled) {
                pushToast(
                  "info",
                  "Owner Lock Ready for Vercel",
                  "Set COMMAND_CENTER_PASSCODE in Vercel Environment Variables to require passcode login."
                );
                return;
              }
              await fetch("/api/auth/logout", { method: "POST" });
              router.push("/login");
              router.refresh();
            }}
            title={
              lockEnabled
                ? "Lock Command Center (Sign Out)"
                : "Owner Lock inactive locally — set COMMAND_CENTER_PASSCODE in Vercel"
            }
            className={`w-full py-2 px-1 rounded-xl flex flex-col items-center gap-1 text-[10px] font-semibold transition cursor-pointer ${
              lockEnabled
                ? "text-[#0F766E] hover:bg-[#ECFDF5]"
                : "text-[#8E969D] hover:bg-[#F2F6F4]"
            }`}
          >
            <Lock className="w-4 h-4" />
            <span>{lockEnabled ? "Lock" : "Unlocked"}</span>
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Slim Top Action Bar (No Duplicate Tabs) */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-[#E4E4DD]">
          <div className="max-w-[1380px] mx-auto px-4 sm:px-6 h-13 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-sm sm:text-base font-semibold tracking-[-0.01em] text-[#14151A] truncate">
                Reseller Command Center
              </h1>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                  data.mode === "live"
                    ? "bg-[#ECFDF5] text-[#0F766E]"
                    : "bg-[#EFF6FF] text-[#1D4ED8]"
                }`}
              >
                {data.mode === "live"
                  ? `Live · ${data.envReadiness.ebayEnv}`
                  : "All 4 Phases Built"}
              </span>
            </div>

            <button
              id="btn-quick-add-item"
              type="button"
              onClick={() => setQuickAddOpen(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] transition cursor-pointer whitespace-nowrap shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Item</span>
            </button>
          </div>
        </header>

        <main className="flex-1 max-w-[1380px] w-full mx-auto px-4 sm:px-6 py-5 space-y-5">
        <ChannelStatusStrip
          mode={data.mode}
          accounts={data.accounts}
          channelCounts={data.channelCounts}
          extensionPendingCount={extensionActionableCount}
          lastSyncedAt={data.lastSyncedAt}
          isSyncingEbay={isSyncingEbay}
          isSyncingEtsy={isSyncingEtsy}
          onSyncEbay={handleSyncEbay}
          onSyncEtsy={handleSyncEtsy}
          onOpenExtensionQueue={() => setActiveTab("extension")}
        />

        {activeTab === "sourcing" ? (
          <SourcingCompsPanel
            onSaveToInventory={async (payload: QuickAddItemRequest) => {
              const res = await fetch("/api/inventory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              const result = (await res.json()) as {
                item?: { sku?: string };
                error?: string;
              };
              if (!res.ok) {
                const errMsg = result.error || "Unknown error";
                pushToast("error", "Failed to Save Item", errMsg);
                throw new Error(errMsg);
              }
              await refreshInventory();
              pushToast(
                "success",
                `${result.item?.sku || "Item"} Captured`,
                payload.initialStatus === "draft"
                  ? "Saved to Death Pile Backlog with COGS & shipping estimate."
                  : "Listed live in Active Inventory."
              );
            }}
          />
        ) : activeTab === "bins" ? (
          <BinAuditPanel
            activeItems={data.items}
            draftItems={data.draftItems}
            onOpenItemDetail={(row) => setDetailModalItemId(row.item_id)}
          />
        ) : activeTab === "offers" ? (
          <WatcherOffersPanel
            eligibleRows={eligibleOfferRows}
            isLive={isLiveMode}
            isCheckingEligible={isCheckingEligible}
            eligibleChecked={eligibleChecked}
            isBusy={isBulkBusy}
            onRefreshEligible={refreshEligibleOffers}
            onSendOffer={handleExecuteAction}
            onMarkSent={(rows) => {
              setSentOfferIds((prev) => {
                const next = new Set(prev);
                for (const r of rows) next.add(r.listing_id);
                return next;
              });
              setEligibleOfferExternalIds((prev) => {
                if (!prev) return prev;
                const next = new Set(prev);
                for (const r of rows) {
                  if (r.external_listing_id) next.delete(r.external_listing_id);
                }
                return next;
              });
            }}
          />
        ) : activeTab === "radar" ? (
          <div className="space-y-4">
            <StaleRadarTable
            items={data.items}
            draftItems={data.draftItems}
            extensionJobs={data.extensionJobs}
            channelCounts={data.channelCounts}
            busyListingIds={busyListingIds}
            isBulkBusy={isBulkBusy}
            isLive={isLiveMode}
            onExecuteAction={handleExecuteAction}
            onOpenCrossList={(row, target = "etsy") =>
              setCrossListState({ row, target })
            }
            onBulkCrossListEtsy={handleBulkCrossListEtsy}
            onListEverywhere={async (row) => {
              const missing = (
                ["etsy", "poshmark", "mercari", "facebook"] as Array<
                  Exclude<MarketplaceType, "ebay">
                >
              ).filter(
                (ch) => !row.cross_listings.some((c) => c.marketplace === ch)
              );
              const dispatchedChannels: string[] = [];
              const blockedChannels: string[] = [];
              for (const ch of missing) {
                if (ch === "etsy") {
                  const res = await fetch("/api/etsy/crosslist", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      itemId: row.item_id,
                      publishImmediately: true,
                    }),
                  });
                  const data = (await res.json()) as {
                    results?: unknown[];
                    errors?: Array<{ error?: string }>;
                  };
                  if (res.ok && (data.results?.length ?? 0) > 0) {
                    dispatchedChannels.push("Etsy");
                  } else {
                    blockedChannels.push(
                      `Etsy (${data.errors?.[0]?.error ? "policy blocked" : "skipped"})`
                    );
                  }
                } else {
                  const res = await fetch("/api/extension/jobs", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      itemId: row.item_id,
                      marketplace: ch,
                      action: "create",
                    }),
                  });
                  if (res.ok) {
                    dispatchedChannels.push(
                      ch.charAt(0).toUpperCase() + ch.slice(1)
                    );
                  } else if (res.status === 422) {
                    blockedChannels.push(
                      `${ch.charAt(0).toUpperCase() + ch.slice(1)} (policy blocked)`
                    );
                  }
                }
              }
              await refreshInventory();
              pushToast(
                dispatchedChannels.length > 0 ? "success" : "error",
                dispatchedChannels.length > 0
                  ? `${row.sku} Dispatched (${dispatchedChannels.join(", ")})`
                  : `${row.sku} Blocked on Remaining Channels`,
                blockedChannels.length > 0
                  ? `Policy Guardrail skipped: ${blockedChannels.join(" · ")}.`
                  : `Queued across ${dispatchedChannels.length} compliant marketplace${dispatchedChannels.length === 1 ? "" : "s"}.`
              );
            }}
            onUpdateExtensionJob={handleUpdateExtensionJob}
            onDeleteExtensionJob={async (jobId: string) => {
              const res = await fetch(
                `/api/extension/jobs?id=${encodeURIComponent(jobId)}`,
                { method: "DELETE" }
              );
              if (!res.ok) {
                pushToast(
                  "error",
                  "Failed to Cancel Job",
                  "Could not remove queued job."
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "info",
                "Extension Job Canceled",
                "Removed from queue."
              );
            }}
            onUnlinkMarketplace={async (itemId, marketplace) => {
              const res = await fetch(
                `/api/extension/import-listings?itemId=${encodeURIComponent(itemId)}&marketplace=${encodeURIComponent(marketplace)}`,
                { method: "DELETE" }
              );
              const payload = (await res.json()) as { error?: string };
              if (!res.ok) {
                pushToast(
                  "error",
                  "Failed to Unlink Listing",
                  payload.error || "Unknown error"
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "info",
                `Unlinked from ${marketplace.charAt(0).toUpperCase() + marketplace.slice(1)}`,
                "You can now cross-list this item fresh from the Inventory tab."
              );
            }}
            onRunAutoPromote={async (params) => {
              const res = await fetch("/api/automations/promote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params || { minDaysListed: 30, adRatePct: 4 }),
              });
              const payload = (await res.json()) as {
                promotedCount?: number;
                message?: string;
                error?: string;
              };
              if (!res.ok) {
                pushToast(
                  "error",
                  "Auto-Promote Failed",
                  payload.error || "Unknown error"
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "success",
                `Promoted ${payload.promotedCount ?? 0} Listing${payload.promotedCount === 1 ? "" : "s"} to 4%`,
                payload.message
              );
            }}
            onOpenItemDetail={(row) => setDetailModalItemId(row.item_id)}
            onPromoteDraft={async (itemId) => {
              const res = await fetch("/api/inventory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "promote_draft", itemId }),
              });
              const payload = (await res.json()) as {
                item?: { sku?: string };
                error?: string;
              };
              if (!res.ok) {
                pushToast(
                  "error",
                  "Failed to Move Draft",
                  payload.error || "Unknown error"
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "success",
                `${payload.item?.sku || "Item"} Moved to Active Listed`,
                "Promoted out of Death Pile and listed as Newly Listed (0d) on eBay."
              );
            }}
            onDeleteDraft={async (itemId) => {
              const res = await fetch(
                `/api/inventory?id=${encodeURIComponent(itemId)}`,
                { method: "DELETE" }
              );
              const payload = (await res.json()) as { error?: string };
              if (!res.ok) {
                pushToast(
                  "error",
                  "Failed to Delete Item",
                  payload.error || "Unknown error"
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "info",
                "Removed from Death Pile",
                "Item permanently deleted from your unlisted backlog."
              );
            }}
            />
          </div>
        ) : activeTab === "extension" ? (
          <ExtensionQueuePanel
            jobs={data.extensionJobs}
            recentJobs={data.recentJobs}
            isLive={isLiveMode}
            onUpdateJobStatus={handleUpdateExtensionJob}
            onDeleteJob={async (jobId: string) => {
              const res = await fetch(
                `/api/extension/jobs?id=${encodeURIComponent(jobId)}`,
                { method: "DELETE" }
              );
              if (!res.ok) {
                pushToast(
                  "error",
                  "Failed to Cancel Job",
                  "Could not remove queued job."
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "info",
                "Extension Job Canceled",
                "Removed from queue."
              );
            }}
          />
        ) : activeTab === "sales" ? (
          <SalesLedgerPanel
            activeItems={data.items}
            salesOrders={data.salesOrders}
            onTriggerWebhookSale={handleTriggerWebhookSale}
            onTriggerInboundEmail={handleTriggerInboundEmail}
            onUpdateSalesOrder={async (req: SalesOrderUpdateRequest) => {
              const res = await fetch("/api/sales", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(req),
              });
              const payload = (await res.json()) as {
                restocked?: boolean;
                error?: string;
              };
              if (!res.ok) {
                pushToast(
                  "error",
                  "Order Update Failed",
                  payload.error || "Unknown error"
                );
                return;
              }
              await refreshInventory();
              pushToast(
                "success",
                payload.restocked
                  ? "Return Logged & SKU Restocked"
                  : req.fulfillment_status === "shipped"
                    ? "Order Marked Shipped"
                    : "Order Status Updated",
                payload.restocked
                  ? "SKU returned to Active Inventory and COGS recovered for Schedule C."
                  : req.tracking_number
                    ? `Tracking #${req.tracking_number} saved.`
                    : "Sales ledger & fulfillment queue updated."
              );
            }}
          />
        ) : activeTab === "analytics" ? (
          <AnalyticsTaxPanel
            activeItems={data.items}
            draftItems={data.draftItems}
            salesOrders={data.salesOrders}
            expenses={data.expenses}
            onOpenItemDetail={(row) => setDetailModalItemId(row.item_id)}
            onAddExpense={async (input: {
              expense_date: string;
              category: ExpenseCategoryType;
              description: string;
              vendor: string | null;
              miles: number | null;
              mileage_rate: number | null;
              amount: number;
              payment_method: string | null;
              receipt_ref: string | null;
              notes: string | null;
            }) => {
              const res = await fetch("/api/expenses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(input),
              });
              if (!res.ok) {
                pushToast("error", "Expense Save Failed", "Check your inputs.");
                return;
              }
              await refreshInventory();
              pushToast(
                "success",
                "Deductible Expense Logged",
                `${input.description} (-$${input.amount.toFixed(2)}) added to Schedule C.`
              );
            }}
            onDeleteExpense={async (expenseId: string) => {
              const res = await fetch(
                `/api/expenses?id=${encodeURIComponent(expenseId)}`,
                { method: "DELETE" }
              );
              if (res.ok) {
                await refreshInventory();
                pushToast("info", "Expense Removed", "Schedule C totals updated.");
              }
            }}
          />
        ) : (
          <BuildRoadmapPanel
            envReadiness={data.envReadiness}
            mode={data.mode}
          />
        )}
        </main>
      </div>

      <CrossListDrawer
        row={crossListState?.row ?? null}
        initialTarget={crossListState?.target ?? "etsy"}
        onClose={() => setCrossListState(null)}
        onPublishedEtsy={handleDrawerPublishedEtsy}
        onQueuedExtension={handleDrawerQueuedExtension}
        onUnlinked={async (marketplace) => {
          await refreshInventory();
          pushToast(
            "info",
            `Unlinked from ${marketplace.charAt(0).toUpperCase() + marketplace.slice(1)}`,
            "Listing link removed. You can now queue it fresh."
          );
        }}
      />

      <ItemDetailModal
        row={
          detailModalItemId
            ? (data.items.find((i) => i.item_id === detailModalItemId) ?? null)
            : null
        }
        onClose={() => setDetailModalItemId(null)}
        onSave={async (updates: ItemDetailUpdateRequest) => {
          const res = await fetch("/api/inventory", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          });
          const payload = (await res.json()) as { error?: string };
          if (!res.ok) {
            pushToast(
              "error",
              "Failed to Save Item",
              payload.error || "Unknown error"
            );
            throw new Error(payload.error || "Failed to save item");
          }
          await refreshInventory();
          pushToast(
            "success",
            `Updated ${updates.sku || "Item"}`,
            "Sourcing, COGS, SKU, and tax details saved & profit recalculated."
          );
        }}
      />

      <QuickAddItemModal
        isOpen={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onCreate={async (req: QuickAddItemRequest) => {
          const res = await fetch("/api/inventory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req),
          });
          const payload = (await res.json()) as {
            item?: { sku?: string };
            error?: string;
          };
          if (!res.ok) {
            pushToast(
              "error",
              "Quick-Add Failed",
              payload.error || "Unknown error"
            );
            throw new Error(payload.error || "Quick-Add failed");
          }
          await refreshInventory();
          pushToast(
            "success",
            req.initialStatus === "draft"
              ? `Added ${payload.item?.sku || "Item"} to Death Pile`
              : `Listed ${payload.item?.sku || "Item"} Active on eBay`,
            req.initialStatus === "draft"
              ? "Tracked in Unlisted Backlog & IRS Inventory Valuation."
              : "Now live in Newly Listed (0d) inventory."
          );
        }}
      />

      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm pointer-events-none"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="pointer-events-auto bg-white border border-[#E4E4DD] rounded-xl shadow-lg p-3.5 flex items-start gap-2.5"
            >
              {toast.tone === "success" ? (
                <CheckCircle2 className="w-4 h-4 text-[#0F766E] shrink-0 mt-0.5" />
              ) : toast.tone === "error" ? (
                <AlertCircle className="w-4 h-4 text-[#B91C1C] shrink-0 mt-0.5" />
              ) : (
                <Info className="w-4 h-4 text-[#1D4ED8] shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-[#14151A]">
                  {toast.title}
                </p>
                {toast.detail && (
                  <p className="text-[11px] text-[#5C606B] mt-0.5 leading-snug">
                    {toast.detail}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
                className="text-[#8A8E99] hover:text-[#14151A] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
