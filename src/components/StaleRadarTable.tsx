"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpDown,
  ArrowUpRight,
  Eye,
  Heart,
  LayoutGrid,
  LayoutList,
  Loader2,
  Megaphone,
  Package,
  Plus,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  TrendingDown,
  X,
  Zap,
} from "lucide-react";
import { MarketplaceIcon } from "./MarketplaceIcons";
import type {
  ChannelJob,
  EbayActionRequest,
  InventoryItem,
  JobStatusType,
  MarketplaceType,
  StaleRadarRow,
} from "@/lib/types";

type CrossListTarget = Exclude<MarketplaceType, "ebay">;

interface StaleRadarTableProps {
  items: StaleRadarRow[];
  draftItems: InventoryItem[];
  extensionJobs: ChannelJob[];
  channelCounts: Record<MarketplaceType, number>;
  busyListingIds: Set<string>;
  isBulkBusy: boolean;
  isLive?: boolean;
  onExecuteAction: (request: EbayActionRequest) => Promise<void>;
  onOpenCrossList: (row: StaleRadarRow, target?: CrossListTarget) => void;
  onBulkCrossListEtsy: (itemIds: string[]) => Promise<void>;
  onListEverywhere: (row: StaleRadarRow) => Promise<void>;
  onUpdateExtensionJob: (params: {
    jobId: string;
    status: JobStatusType;
    listedPrice?: number;
  }) => Promise<void>;
  onDeleteExtensionJob?: (jobId: string) => Promise<void>;
  onUnlinkMarketplace?: (
    itemId: string,
    marketplace: CrossListTarget
  ) => Promise<void>;
  onRunAutoPromote: (params?: {
    minDaysListed?: number;
    adRatePct?: number;
    listingIds?: string[];
  }) => Promise<void>;
  onOpenItemDetail: (row: StaleRadarRow) => void;
  onPromoteDraft: (itemId: string) => Promise<void>;
  onDeleteDraft: (itemId: string) => Promise<void>;
  onDisposeItem?: (params: {
    itemId: string;
    disposition: "donated" | "discarded";
    note?: string;
  }) => Promise<void>;
  onSetRelistCount?: (params: {
    itemId: string;
    relistCount: number;
  }) => Promise<void>;
  onToggleStaleExempt?: (params: {
    itemId: string;
    exempt: boolean;
  }) => Promise<void>;
}

type FilterKey =
  | "all"
  | "newly_listed"
  | "stale"
  | "relisted"
  | "donate_toss"
  | "priority"
  | "unpromoted_30d"
  | "missing_etsy"
  | "missing_poshmark"
  | "missing_mercari"
  | "missing_facebook"
  | "at_floor";

type SortKey =
  | "days_desc"
  | "days_asc"
  | "views_asc"
  | "cogs_desc"
  | "price_desc"
  | "watchers_desc";

const NOTES_STORAGE_KEY = "rcc_private_notes_v1";
const STARS_STORAGE_KEY = "rcc_starred_skus_v1";
const DONATE_DAYS_STORAGE_KEY = "rcc_donate_days_threshold_v1";
const STORAGE_EVT = "rcc_matrix_meta_sync";

const DEFAULT_NOTES: Record<string, string> = {
  "CAM-OLY-OM1N":
    "Tested shutter speeds — drop price or End & Sell Similar if no sale by Friday.",
  "SNK-NB-990V5-105":
    "7 watchers on eBay — send 10% offer & cross-list to Mercari.",
  "OUT-PAT-SYNCH-L":
    "At COGS floor ($64). End & Sell Similar for fresh Cassini boost.",
  "KIT-LECR-24DUTCH":
    "FB Marketplace draft ready — confirm publish after weighing box.",
};

const MATRIX_CHANNELS: Array<{
  key: MarketplaceType;
  label: string;
  feePct: number;
  markupPct: number;
}> = [
  { key: "ebay", label: "eBay", feePct: 13.25, markupPct: 0 },
  { key: "poshmark", label: "Poshmark", feePct: 20, markupPct: 12 },
  { key: "mercari", label: "Mercari", feePct: 10, markupPct: 5 },
  { key: "etsy", label: "Etsy", feePct: 9.5, markupPct: 5 },
  { key: "facebook", label: "Facebook", feePct: 5, markupPct: 0 },
];

function subscribeLocal(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(STORAGE_EVT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(STORAGE_EVT, cb);
  };
}

function useStoredMap<T>(key: string, fallback: T): [T, (next: T) => void] {
  const raw = useSyncExternalStore(
    subscribeLocal,
    () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null
  );

  let val = fallback;
  if (raw) {
    try {
      val = JSON.parse(raw) as T;
    } catch {
      val = fallback;
    }
  }

  const setter = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
        window.dispatchEvent(new Event(STORAGE_EVT));
      } catch {
        // ignore quota
      }
    },
    [key]
  );

  return [val, setter];
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function estimateChannelOffer(
  ebayPrice: number,
  cogs: number,
  floorPrice: number,
  feePct: number,
  markupPct: number
) {
  const ratio = (1 - 13.25 / 100) / (1 - feePct / 100);
  const raw = ebayPrice * ratio * (1 + markupPct / 100);
  const clean = raw >= 50 ? Math.ceil(raw) : round2(Math.ceil(raw) - 0.01);
  const price = Math.max(floorPrice, clean);
  const net = round2(price - round2(price * (feePct / 100)) - cogs);
  return { price, net };
}

function resolveMarketplaceUrl(
  marketplace: MarketplaceType,
  externalUrl: string | null | undefined,
  externalId: string | null | undefined,
  title: string
): string {
  if (externalUrl) return externalUrl;
  const q = encodeURIComponent(title);
  switch (marketplace) {
    case "ebay":
      return externalId
        ? `https://www.ebay.com/itm/${externalId}`
        : `https://www.ebay.com/sch/i.html?_nkw=${q}`;
    case "etsy":
      return externalId
        ? `https://www.etsy.com/listing/${externalId}`
        : `https://www.etsy.com/search?q=${q}`;
    case "poshmark":
      return `https://poshmark.com/search?query=${q}`;
    case "mercari":
      return `https://www.mercari.com/search/?keyword=${q}`;
    case "facebook":
      return `https://www.facebook.com/marketplace/search/?query=${q}`;
  }
}

export function StaleRadarTable({
  items,
  draftItems,
  extensionJobs,
  channelCounts,
  busyListingIds,
  isBulkBusy,
  isLive = false,
  onExecuteAction,
  onOpenCrossList,
  onBulkCrossListEtsy,
  onListEverywhere,
  onUpdateExtensionJob,
  onDeleteExtensionJob,
  onUnlinkMarketplace,
  onRunAutoPromote,
  onOpenItemDetail,
  onPromoteDraft,
  onDeleteDraft,
  onDisposeItem,
  onSetRelistCount,
  onToggleStaleExempt,
}: StaleRadarTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [sortBy, setSortBy] = useState<SortKey>("days_desc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [listingAllItemId, setListingAllItemId] = useState<string | null>(null);
  const [density, setDensity] = useState<"gallery" | "compact">("gallery");
  const [autoPromoteEnabled, setAutoPromoteEnabled] = useState(true);
  const [isPromoting, setIsPromoting] = useState(false);
  const [showDeathPile, setShowDeathPile] = useState(
    () => items.length === 0 && draftItems.length > 0
  );
  const [promotingDraftId, setPromotingDraftId] = useState<string | null>(null);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  const [confirmDeleteDraftId, setConfirmDeleteDraftId] = useState<
    string | null
  >(null);
  const [confirmUnlinkKey, setConfirmUnlinkKey] = useState<string | null>(null);
  const [unlinkingKey, setUnlinkingKey] = useState<string | null>(null);
  const [disposeTargetRow, setDisposeTargetRow] =
    useState<StaleRadarRow | null>(null);
  const [disposeNote, setDisposeNote] = useState("");
  const [isDisposing, setIsDisposing] = useState(false);
  const [bumpingRelistItemId, setBumpingRelistItemId] = useState<string | null>(
    null
  );
  const [togglingExemptItemId, setTogglingExemptItemId] = useState<
    string | null
  >(null);
  const [mountNow] = useState(() => Date.now());

  const [notesMap, setNotesMap] = useStoredMap<Record<string, string>>(
    NOTES_STORAGE_KEY,
    DEFAULT_NOTES
  );
  const [starredSkus, setStarredSkus] = useStoredMap<string[]>(
    STARS_STORAGE_KEY,
    ["CAM-OLY-OM1N", "SNK-NB-990V5-105"]
  );
  const [donateDaysThreshold, setDonateDaysThreshold] = useStoredMap<number>(
    DONATE_DAYS_STORAGE_KEY,
    60
  );

  const isDonateCandidate = (row: StaleRadarRow) =>
    !row.stale_radar_exempt &&
    row.relist_count > 0 &&
    (row.days_since_relist ?? row.days_listed) >= donateDaysThreshold;

  const starredSet = useMemo(() => new Set(starredSkus), [starredSkus]);

  const toggleStar = (sku: string) => {
    const next = starredSet.has(sku)
      ? starredSkus.filter((s) => s !== sku)
      : [...starredSkus, sku];
    setStarredSkus(next);
  };

  const updateNote = (sku: string, text: string) => {
    setNotesMap({ ...notesMap, [sku]: text });
  };

  const extJobLookup = useMemo(() => {
    const map = new Map<string, ChannelJob>();
    for (const j of extensionJobs) {
      if (
        j.status === "pending" ||
        j.status === "processing" ||
        j.status === "needs_user_confirm"
      ) {
        map.set(`${j.item_id}:${j.marketplace}`, j);
      }
    }
    return map;
  }, [extensionJobs]);

  const metrics = useMemo(() => {
    const newlyListedItems = items.filter((i) => i.is_newly_listed);
    const staleItems = items.filter((i) => i.is_stale);
    const criticalItems = items.filter((i) => i.stale_severity === "critical");
    const atFloorItems = items.filter((i) => i.is_at_floor);
    const eligible30dUnpromoted = items.filter(
      (i) => i.days_listed >= 30 && i.promoted_ad_rate_pct < 4
    );
    const promotedItems = items.filter((i) => i.promoted_ad_rate_pct > 0);
    const lockedStaleCogs = staleItems.reduce((sum, i) => sum + i.cogs, 0);
    const staleRetailValue = staleItems.reduce(
      (sum, i) => sum + i.listed_price,
      0
    );
    const totalCrossListings = items.reduce(
      (sum, i) =>
        sum + i.cross_listings.filter((c) => c.marketplace !== "ebay").length,
      0
    );

    return {
      totalActive: items.length,
      newlyListedCount: newlyListedItems.length,
      staleCount: staleItems.length,
      criticalCount: criticalItems.length,
      atFloorCount: atFloorItems.length,
      eligible30dCount: eligible30dUnpromoted.length,
      promotedCount: promotedItems.length,
      lockedStaleCogs,
      staleRetailValue,
      totalCrossListings,
      priorityCount: items.filter((i) => starredSet.has(i.sku)).length,
      relistedCount: items.filter((i) => i.relist_count > 0).length,
      donateTossCount: items.filter(
        (i) =>
          i.relist_count > 0 &&
          (i.days_since_relist ?? i.days_listed) >= donateDaysThreshold
      ).length,
    };
  }, [items, starredSet, donateDaysThreshold]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const matched = items.filter((row) => {
      const hasChannel = (ch: MarketplaceType) =>
        ch === "ebay" || row.cross_listings.some((c) => c.marketplace === ch);

      if (activeFilter === "newly_listed" && !row.is_newly_listed) return false;
      if (activeFilter === "stale" && !row.is_stale) return false;
      if (activeFilter === "relisted" && row.relist_count <= 0) return false;
      if (
        activeFilter === "donate_toss" &&
        !(
          row.relist_count > 0 &&
          (row.days_since_relist ?? row.days_listed) >= donateDaysThreshold
        )
      ) {
        return false;
      }
      if (activeFilter === "priority" && !starredSet.has(row.sku)) return false;
      if (activeFilter === "at_floor" && !row.is_at_floor) return false;
      if (
        activeFilter === "unpromoted_30d" &&
        !(row.days_listed >= 30 && row.promoted_ad_rate_pct < 4)
      ) {
        return false;
      }
      if (activeFilter === "missing_etsy" && hasChannel("etsy")) return false;
      if (activeFilter === "missing_poshmark" && hasChannel("poshmark"))
        return false;
      if (activeFilter === "missing_mercari" && hasChannel("mercari"))
        return false;
      if (activeFilter === "missing_facebook" && hasChannel("facebook"))
        return false;

      if (!q) return true;
      const note = notesMap[row.sku] || row.notes || "";
      return (
        row.sku.toLowerCase().includes(q) ||
        row.title.toLowerCase().includes(q) ||
        (row.brand?.toLowerCase().includes(q) ?? false) ||
        (row.bin_location?.toLowerCase().includes(q) ?? false) ||
        (row.source_location?.toLowerCase().includes(q) ?? false) ||
        note.toLowerCase().includes(q)
      );
    });

    return [...matched].sort((a, b) => {
      switch (sortBy) {
        case "days_desc":
          return b.days_listed - a.days_listed;
        case "days_asc":
          return a.days_listed - b.days_listed;
        case "views_asc":
          return a.views_count - b.views_count;
        case "cogs_desc":
          return b.cogs - a.cogs;
        case "price_desc":
          return b.listed_price - a.listed_price;
        case "watchers_desc":
          return b.watchers_count - a.watchers_count;
      }
    });
  }, [
    items,
    searchQuery,
    activeFilter,
    sortBy,
    starredSet,
    notesMap,
    donateDaysThreshold,
  ]);

  const validSelectedIds = useMemo(() => {
    const currentSet = new Set(items.map((i) => i.listing_id));
    return new Set([...selectedIds].filter((id) => currentSet.has(id)));
  }, [items, selectedIds]);

  const selectedRows = useMemo(
    () => items.filter((i) => validSelectedIds.has(i.listing_id)),
    [items, validSelectedIds]
  );

  const bulkPreview = useMemo(() => {
    let droppable = 0;
    let clamped = 0;
    let skippedAtFloor = 0;
    const etsyCandidateItemIds: string[] = [];

    for (const row of selectedRows) {
      if (!row.is_listed_on_etsy) etsyCandidateItemIds.push(row.item_id);
      if (row.is_at_floor) skippedAtFloor += 1;
      else {
        droppable += 1;
        if (row.drop_would_clamp) clamped += 1;
      }
    }
    return { droppable, clamped, skippedAtFloor, etsyCandidateItemIds };
  }, [selectedRows]);

  const allVisibleSelected =
    filteredItems.length > 0 &&
    filteredItems.every((r) => validSelectedIds.has(r.listing_id));

  const toggleSelectAllVisible = () => {
    const next = new Set(validSelectedIds);
    if (allVisibleSelected) {
      for (const r of filteredItems) next.delete(r.listing_id);
    } else {
      for (const r of filteredItems) next.add(r.listing_id);
    }
    setSelectedIds(next);
  };

  const toggleRow = (listingId: string) => {
    const next = new Set(validSelectedIds);
    if (next.has(listingId)) next.delete(listingId);
    else next.add(listingId);
    setSelectedIds(next);
  };

  const runBulkAction = async (action: EbayActionRequest["action"]) => {
    const protectedListingIds =
      action === "end_and_sell_similar"
        ? new Set(
            items
              .filter((i) => i.stale_radar_exempt)
              .map((i) => i.listing_id)
          )
        : null;
    const ids = [...validSelectedIds].filter(
      (id) => !protectedListingIds?.has(id)
    );
    if (ids.length === 0) return;
    await onExecuteAction({ action, listingIds: ids, dropPct: 10, offerPct: 10 });
    setSelectedIds(new Set());
  };

  const handleHeaderFilter = (ch: MarketplaceType) => {
    if (ch === "ebay") {
      setActiveFilter("all");
      return;
    }
    const targetKey = `missing_${ch}` as FilterKey;
    setActiveFilter((prev) => (prev === targetKey ? "all" : targetKey));
  };

  const handleRowListAll = async (row: StaleRadarRow) => {
    setListingAllItemId(row.item_id);
    try {
      await onListEverywhere(row);
    } finally {
      setListingAllItemId(null);
    }
  };

  const handleTriggerAutoPromote = async (listingIds?: string[]) => {
    setIsPromoting(true);
    try {
      await onRunAutoPromote({ minDaysListed: 30, adRatePct: 4, listingIds });
    } finally {
      setIsPromoting(false);
    }
  };

  const filterPills: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "all", label: "All Inventory", count: metrics.totalActive },
    {
      key: "newly_listed",
      label: "Newly Listed (≤14d)",
      count: metrics.newlyListedCount,
    },
    { key: "stale", label: "Needs Action (>45d)", count: metrics.staleCount },
    { key: "relisted", label: "Relisted", count: metrics.relistedCount },
    {
      key: "unpromoted_30d",
      label: "30d+ Eligible (4% Promo)",
      count: metrics.eligible30dCount,
    },
    { key: "priority", label: "★ Priority", count: metrics.priorityCount },
    { key: "at_floor", label: "At COGS Floor", count: metrics.atFloorCount },
  ];

  const isCompact = density === "compact";

  return (
    <div className="space-y-4">
      {/* KPI Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>Active Inventory</span>
            <Package className="w-3.5 h-3.5 text-[#0F766E]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#171A1D]">
              {metrics.totalActive}
            </span>
            <span className="text-xs font-mono text-[#0F766E]">
              +{metrics.totalCrossListings} cross-listed
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>Stale Radar Flagged</span>
            <AlertTriangle className="w-3.5 h-3.5 text-[#B45309]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#B45309]">
              {metrics.staleCount}
            </span>
            <span className="text-xs text-[#5F666D]">
              {metrics.criticalCount} critical (&gt;75d)
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>Capital Locked in Stale</span>
            <TrendingDown className="w-3.5 h-3.5 text-[#B91C1C]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#171A1D]">
              {formatMoney(metrics.lockedStaleCogs)}
            </span>
            <span className="text-xs text-[#5F666D]">
              COGS ({formatMoney(metrics.staleRetailValue)} ask)
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>eBay Promoted (4% Rule)</span>
            <Megaphone className="w-3.5 h-3.5 text-[#0F766E]" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#0F766E]">
              {metrics.promotedCount}
            </span>
            <span className="text-xs text-[#5F666D]">
              active · {metrics.eligible30dCount} ready (30d+)
            </span>
          </div>
        </div>
      </div>

      {/* 30-Day -> 4% Auto-Promote Automation Banner + Filter Toolbar */}
      <div className="bg-white border border-[#E5E8E6] rounded-xl p-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)] space-y-3">
        {/* Automation Rule Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-lg bg-[#F4FAF8] border border-[#CDECE3]">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <button
              type="button"
              role="switch"
              aria-checked={autoPromoteEnabled}
              onClick={() => setAutoPromoteEnabled((v) => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors cursor-pointer ${
                autoPromoteEnabled ? "bg-[#0F766E]" : "bg-[#CBD2CE]"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
                  autoPromoteEnabled ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
            <Megaphone className="w-3.5 h-3.5 text-[#0F766E]" />
            <span className="font-semibold text-[#171A1D]">
              Auto-Promote Rule:
            </span>
            <span className="text-[#444B52]">
              Automatically promote eBay listings aged{" "}
              <strong className="font-mono text-[#171A1D]">30+ days</strong> to{" "}
              <strong className="font-mono text-[#0F766E]">4% ad rate</strong>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-[#0F766E]">
              {metrics.eligible30dCount} eligible now
            </span>
            <button
              id="btn-run-auto-promote"
              type="button"
              disabled={isPromoting || metrics.eligible30dCount === 0}
              onClick={() => handleTriggerAutoPromote()}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-45 transition cursor-pointer"
            >
              {isPromoting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              {metrics.eligible30dCount > 0
                ? `Promote ${metrics.eligible30dCount} Items to 4%`
                : "All 30d+ Promoted"}
            </button>
          </div>
        </div>

        {/* Search, Filter Pills, Sort, Density */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {filterPills.map((pill) => {
              const isActive = activeFilter === pill.key;
              return (
                <button
                  key={pill.key}
                  type="button"
                  onClick={() => setActiveFilter(pill.key)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                    isActive
                      ? "bg-[#0F766E] text-white"
                      : "bg-[#F2F4F3] text-[#444B52] hover:bg-[#E7ECEA]"
                  }`}
                >
                  <span>{pill.label}</span>
                  <span
                    className={`font-mono tabular-nums text-[11px] px-1.5 rounded ${
                      isActive ? "bg-white/20 text-white" : "bg-white text-[#5F666D]"
                    }`}
                  >
                    {pill.count}
                  </span>
                </button>
              );
            })}
            <div className="inline-flex items-center rounded-lg overflow-hidden border border-[#FECACA] bg-[#FEF2F2]">
              <button
                type="button"
                onClick={() =>
                  setActiveFilter((prev) =>
                    prev === "donate_toss" ? "all" : "donate_toss"
                  )
                }
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
                  activeFilter === "donate_toss"
                    ? "bg-[#B91C1C] text-white"
                    : "text-[#B91C1C] hover:bg-[#FEE2E2]"
                }`}
              >
                <Trash2 className="w-3 h-3" />
                <span>Donate / Toss</span>
                <span
                  className={`font-mono tabular-nums text-[11px] px-1.5 rounded ${
                    activeFilter === "donate_toss"
                      ? "bg-white/20 text-white"
                      : "bg-white text-[#B91C1C]"
                  }`}
                >
                  {metrics.donateTossCount}
                </span>
              </button>
              <select
                aria-label="Days unsold after relist before Donate or Toss"
                title="Flag relisted items unsold for this many days to Donate / Toss"
                value={donateDaysThreshold}
                onChange={(e) => setDonateDaysThreshold(Number(e.target.value))}
                className="px-1.5 py-1 text-[11px] font-mono font-semibold text-[#991B1B] bg-[#FEF2F2] border-l border-[#FECACA] focus:outline-none cursor-pointer"
              >
                <option value={30}>30d+</option>
                <option value={45}>45d+</option>
                <option value={60}>60d+</option>
                <option value={90}>90d+</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => setShowDeathPile((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                showDeathPile
                  ? "bg-[#B45309] text-white"
                  : "bg-[#FFFBEB] text-[#92400E] border border-[#FDE68A] hover:bg-[#FEF3C7]"
              }`}
            >
              <span>Death Pile (Unlisted)</span>
              <span
                className={`font-mono tabular-nums text-[11px] px-1.5 rounded ${
                  showDeathPile
                    ? "bg-white/20 text-white"
                    : "bg-white text-[#92400E]"
                }`}
              >
                {draftItems.length}
              </span>
            </button>
            {activeFilter.startsWith("missing_") && (
              <button
                type="button"
                onClick={() => setActiveFilter("all")}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0] cursor-pointer"
              >
                <span>
                  Missing on {activeFilter.replace("missing_", "").toUpperCase()}
                </span>
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="w-3.5 h-3.5 text-[#8A929A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="input-radar-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Press / to search SKU, title, notes..."
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#E5E8E6] bg-[#F8F9F8] text-[#171A1D] placeholder:text-[#8A929A] focus:bg-white focus:outline-none focus:border-[#0F766E] transition"
              />
            </div>

            <div className="relative flex items-center">
              <ArrowUpDown className="w-3.5 h-3.5 text-[#8A929A] absolute left-2.5 pointer-events-none" />
              <select
                id="select-radar-sort"
                aria-label="Sort inventory"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                className="pl-7 pr-3 py-1.5 text-xs rounded-lg border border-[#E5E8E6] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E] cursor-pointer"
              >
                <option value="days_desc">Oldest First</option>
                <option value="days_asc">Newest Listed</option>
                <option value="views_asc">Lowest Views</option>
                <option value="watchers_desc">Most Watchers</option>
                <option value="cogs_desc">Highest COGS</option>
                <option value="price_desc">Highest Price</option>
              </select>
            </div>

            <div
              className="inline-flex items-center rounded-lg border border-[#E5E8E6] bg-[#F8F9F8] p-0.5"
              title="Toggle Gallery vs Compact rows"
            >
              <button
                type="button"
                aria-label="Gallery density"
                onClick={() => setDensity("gallery")}
                className={`p-1.5 rounded-md cursor-pointer ${
                  !isCompact ? "bg-white text-[#0F766E] shadow-2xs" : "text-[#7C858D]"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="Compact density"
                onClick={() => setDensity("compact")}
                className={`p-1.5 rounded-md cursor-pointer ${
                  isCompact ? "bg-white text-[#0F766E] shadow-2xs" : "text-[#7C858D]"
                }`}
              >
                <LayoutList className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Bulk Action Bar */}
        {validSelectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg bg-[#0F766E] text-white">
            <div className="flex flex-wrap items-center gap-2.5 text-xs">
              <span className="font-semibold font-mono tabular-nums">
                {validSelectedIds.size} selected
              </span>
              <span className="text-white/30">|</span>
              <span className="text-white/90">
                -10% drops <strong>{bulkPreview.droppable}</strong>
                {bulkPreview.clamped > 0 && ` (${bulkPreview.clamped} clamped)`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isBulkBusy || bulkPreview.droppable === 0}
                onClick={() => runBulkAction("update_price")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-white text-[#0F766E] hover:bg-[#F2F4F3] disabled:opacity-45 cursor-pointer"
              >
                <ArrowDownRight className="w-3.5 h-3.5" />
                Bulk Drop -10%
              </button>
              <button
                type="button"
                disabled={isPromoting}
                onClick={async () => {
                  await handleTriggerAutoPromote([...validSelectedIds]);
                  setSelectedIds(new Set());
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-white/15 text-white hover:bg-white/25 cursor-pointer"
              >
                <Megaphone className="w-3.5 h-3.5" />
                Promote 4%
              </button>
              <button
                type="button"
                disabled={
                  isBulkBusy || bulkPreview.etsyCandidateItemIds.length === 0
                }
                onClick={async () => {
                  await onBulkCrossListEtsy(bulkPreview.etsyCandidateItemIds);
                  setSelectedIds(new Set());
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[#171A1D] text-white hover:bg-[#2A2F35] disabled:opacity-45 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                → Etsy ({bulkPreview.etsyCandidateItemIds.length})
              </button>
              <button
                type="button"
                disabled={isBulkBusy}
                onClick={() => runBulkAction("end_and_sell_similar")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-white/15 text-white hover:bg-white/25 cursor-pointer"
              >
                <RefreshCcw className="w-3.5 h-3.5" />
                End &amp; Sell Similar
              </button>
              <button
                type="button"
                disabled={isBulkBusy}
                onClick={() => runBulkAction("send_offer")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-white/15 text-white hover:bg-white/25 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Offers
              </button>
              <button
                type="button"
                aria-label="Clear selection"
                onClick={() => setSelectedIds(new Set())}
                className="p-1.5 rounded-md text-white/80 hover:text-white hover:bg-white/15 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Death Pile / Unlisted Backlog Panel */}
      {showDeathPile && (
        <div className="bg-white border border-[#FDE68A] rounded-xl shadow-[0_1px_3px_rgba(20,21,26,0.04)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#FDE68A] bg-[#FFFBEB] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#92400E]">
              <Package className="w-4 h-4" />
              <span>
                Death Pile — Unlisted Inventory Backlog ({draftItems.length}{" "}
                SKUs ·{" "}
                {formatMoney(
                  draftItems.reduce((s, d) => s + d.cogs + (d.prep_cost ?? 0), 0)
                )}{" "}
                COGS waiting to be listed)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowDeathPile(false)}
              className="text-xs text-[#92400E] hover:underline cursor-pointer"
            >
              Hide
            </button>
          </div>
          {draftItems.length === 0 ? (
            <div className="p-6 text-center text-xs text-[#5F666D]">
              Death pile is empty! Click <strong>+ Add Item</strong> in the top
              bar when sourcing to track new finds before listing.
            </div>
          ) : (
            <div className="divide-y divide-[#FEF3C7]">
              {draftItems.map((draft) => {
                const daysWaiting = draft.acquired_at
                  ? Math.max(
                      0,
                      Math.floor(
                        (mountNow - Date.parse(draft.acquired_at)) / 86400000
                      )
                    )
                  : 0;
                const basis = Number(draft.cogs) + Number(draft.prep_cost ?? 0);
                const isBusy =
                  promotingDraftId === draft.id || deletingDraftId === draft.id;
                const isConfirmingDelete = confirmDeleteDraftId === draft.id;
                return (
                  <div
                    key={draft.id}
                    className="p-3.5 flex flex-wrap items-center justify-between gap-3 hover:bg-[#FFFDF5]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                        <span className="px-1.5 py-0.5 rounded bg-[#FEF3C7] text-[#92400E] font-semibold">
                          {daysWaiting}d unlisted
                        </span>
                        {draft.item_specifics?.fb_local_only === "true" && (
                          <span className="px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE] font-sans font-bold text-[10px]">
                            FB Local Only
                          </span>
                        )}
                        <code className="px-1.5 py-0.5 rounded bg-[#F2F4F3] text-[#171A1D]">
                          {draft.sku}
                        </code>
                        {draft.bin_location && (
                          <span className="text-[#5F666D]">
                            Bin {draft.bin_location}
                          </span>
                        )}
                        {draft.source_location && (
                          <span className="text-[#7C858D]">
                            · {draft.source_location}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs font-semibold text-[#171A1D]">
                        {draft.title}
                      </div>
                      <div className="mt-0.5 text-[11px] font-mono text-[#5F666D]">
                        Cost Basis {formatMoney(basis)} · Target Ask{" "}
                        {formatMoney(Number(draft.target_price))}
                        {draft.notes ? ` · ${draft.notes}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {isConfirmingDelete ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={async () => {
                              setDeletingDraftId(draft.id);
                              try {
                                await onDeleteDraft(draft.id);
                              } finally {
                                setDeletingDraftId(null);
                                setConfirmDeleteDraftId(null);
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#B91C1C] text-white hover:bg-[#991B1B] disabled:opacity-50 cursor-pointer"
                          >
                            {deletingDraftId === draft.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                            Confirm Delete
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setConfirmDeleteDraftId(null)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#DDE2DF] bg-white text-[#5F666D] hover:text-[#171A1D] cursor-pointer"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => setConfirmDeleteDraftId(draft.id)}
                            title="Delete from Death Pile"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#FECACA] bg-white text-[#B91C1C] hover:bg-[#FEF2F2] disabled:opacity-50 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={async () => {
                              setPromotingDraftId(draft.id);
                              try {
                                await onPromoteDraft(draft.id);
                              } finally {
                                setPromotingDraftId(null);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer"
                          >
                            {promotingDraftId === draft.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Zap className="w-3.5 h-3.5" />
                            )}
                            Move to Active Listed →
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* FROZEN-HEADER STICKY MARKETPLACE MATRIX */}
      <div className="bg-white border border-[#E5E8E6] rounded-xl shadow-[0_1px_3px_rgba(20,21,26,0.04)] overflow-hidden">
        <div className="max-h-[70vh] overflow-auto relative">
          <div className="min-w-[1180px]">
            {/* FROZEN Sticky Column Header (top-0 inside the scroll viewport!) */}
            <div className="sticky top-0 z-30 grid grid-cols-[minmax(330px,1.55fr)_repeat(5,minmax(155px,1fr))] bg-white border-b border-[#DCE2DF] shadow-[0_2px_8px_rgba(20,21,26,0.05)]">
              <div className="sticky left-0 z-40 bg-white px-4 py-3.5 flex items-center gap-3 border-r border-[#EEF1EF]">
                <input
                  type="checkbox"
                  aria-label="Select all visible items"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAllVisible}
                  className="w-4 h-4 rounded border-[#C9D0CC] accent-[#0F766E] cursor-pointer"
                />
                <span className="text-xs font-semibold text-[#444B52]">
                  Item name
                </span>
                <span className="ml-auto text-[11px] font-mono text-[#8A929A]">
                  {filteredItems.length} SKUs
                </span>
              </div>

              {MATRIX_CHANNELS.map((ch) => {
                const count = channelCounts[ch.key] || 0;
                const isFilteringMissing =
                  activeFilter === (`missing_${ch.key}` as FilterKey);
                return (
                  <button
                    key={ch.key}
                    type="button"
                    onClick={() => handleHeaderFilter(ch.key)}
                    title={
                      ch.key === "ebay"
                        ? "Show all active inventory"
                        : `Click to filter items not yet listed on ${ch.label}`
                    }
                    className={`px-3 py-3.5 flex items-center justify-center gap-2 transition cursor-pointer ${
                      isFilteringMissing
                        ? "bg-[#ECFDF5] text-[#0F766E]"
                        : "bg-white hover:bg-[#F8FAF9]"
                    }`}
                  >
                    <MarketplaceIcon marketplace={ch.key} size={20} />
                    {ch.key !== "ebay" && (
                      <span className="text-xs font-semibold text-[#171A1D]">
                        {ch.label}
                      </span>
                    )}
                    <span className="text-xs font-mono tabular-nums text-[#7C858D]">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Matrix Rows */}
            <div className="divide-y divide-[#EEF1EF]">
              {filteredItems.length === 0 ? (
                <div className="py-16 text-center text-sm text-[#5F666D]">
                  No active listings match this filter.
                </div>
              ) : (
                filteredItems.map((row) => {
                  const isBusy =
                    busyListingIds.has(row.listing_id) ||
                    isBulkBusy ||
                    listingAllItemId === row.item_id;
                  const isSelected = validSelectedIds.has(row.listing_id);
                  const isStarred = starredSet.has(row.sku);
                  const thumb = row.image_urls[0] || "";
                  const activeChannelCount =
                    1 +
                    row.cross_listings.filter((c) => c.marketplace !== "ebay")
                      .length;

                  const missingChannels = (
                    ["poshmark", "mercari", "etsy", "facebook"] as CrossListTarget[]
                  ).filter(
                    (ch) =>
                      !row.cross_listings.some((c) => c.marketplace === ch) &&
                      !extJobLookup.has(`${row.item_id}:${ch}`)
                  );

                  const statusPill =
                    row.stale_severity === "critical"
                      ? {
                          bar: "bg-[#DC2626]",
                          label: `Needs Improvement · ${row.days_listed}d · ${row.views_count} views`,
                        }
                      : row.is_at_floor
                        ? {
                            bar: "bg-[#0F766E]",
                            label: `At COGS Floor (${formatMoney(row.floor_price)}) · ${row.days_listed}d`,
                          }
                        : row.stale_severity === "stale"
                          ? {
                              bar: "bg-[#D97706]",
                              label: `Needs Improvement · ${row.days_listed}d listed`,
                            }
                          : {
                              bar: "bg-[#0F766E]",
                              label: `Healthy · ${row.days_listed}d · ${row.views_count} views`,
                            };

                  return (
                    <div
                      key={row.listing_id}
                      className={`grid grid-cols-[minmax(330px,1.55fr)_repeat(5,minmax(155px,1fr))] transition-colors ${
                        isSelected
                          ? "bg-[#F0FDF9]"
                          : "bg-white hover:bg-[#FAFBF9]"
                      }`}
                    >
                      {/* Sticky Left Column: Item Details, Health Pill, Interventions, Private Notes */}
                      <div
                        className={`sticky left-0 z-10 border-r border-[#EFF2F0] flex flex-col justify-between ${
                          isCompact ? "p-3 gap-1.5" : "p-4 gap-2.5"
                        } ${isSelected ? "bg-[#F0FDF9]" : "bg-white"}`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.sku}`}
                            checked={isSelected}
                            onChange={() => toggleRow(row.listing_id)}
                            className="mt-1 w-4 h-4 rounded border-[#C9D0CC] accent-[#0F766E] cursor-pointer shrink-0"
                          />

                          <div className="flex-1 min-w-0 space-y-1.5">
                            <button
                              type="button"
                              onClick={() => onOpenItemDetail(row)}
                              title="Click to edit item details, sourcing, COGS, SKU, purchase date & tax notes"
                              className="text-left text-[13px] font-semibold text-[#171A1D] hover:text-[#0F766E] hover:underline decoration-[#0F766E]/50 underline-offset-2 leading-snug line-clamp-2 cursor-pointer transition-colors"
                            >
                              {row.title}
                            </button>

                            {/* Status Pill + Channel Coverage */}
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="inline-flex items-center gap-2 rounded-md overflow-hidden pr-2.5 py-0.5 text-[11px] font-medium bg-[#F4F5F5]">
                                <span
                                  className={`w-1 self-stretch ${statusPill.bar}`}
                                />
                                <span className="text-[#444B52]">
                                  {statusPill.label}
                                </span>
                              </div>
                              {row.is_newly_listed && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#EFF6FF] text-[#1D4ED8]">
                                  NEW
                                </span>
                              )}
                              {row.fb_local_only && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#1877F2] text-white">
                                  FB Local Only
                                </span>
                              )}
                              {row.stale_radar_exempt && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0]">
                                  <ShieldCheck className="w-2.5 h-2.5" />
                                  Protected
                                </span>
                              )}
                              {(() => {
                                const donateFlag = isDonateCandidate(row);
                                const daysRelisted =
                                  row.days_since_relist ?? row.days_listed;
                                const isBumping =
                                  bumpingRelistItemId === row.item_id;
                                return (
                                  <button
                                    type="button"
                                    disabled={isBumping || !onSetRelistCount}
                                    title={
                                      row.relist_count > 0
                                        ? `Relisted ${row.relist_count}× (${daysRelisted}d ago). Click to +1 if relisted manually on eBay.`
                                        : "Original listing (never relisted). Click to mark as Relisted 1× if relisted manually on eBay."
                                    }
                                    onClick={async () => {
                                      if (!onSetRelistCount) return;
                                      setBumpingRelistItemId(row.item_id);
                                      try {
                                        await onSetRelistCount({
                                          itemId: row.item_id,
                                          relistCount: row.relist_count + 1,
                                        });
                                      } finally {
                                        setBumpingRelistItemId(null);
                                      }
                                    }}
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border transition cursor-pointer disabled:cursor-default ${
                                      donateFlag
                                        ? "bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA] hover:bg-[#FEE2E2]"
                                        : row.relist_count > 0
                                          ? "bg-[#EEF2FF] text-[#4338CA] border-[#C7D2FE] hover:bg-[#E0E7FF]"
                                          : "bg-[#F7F8F7] text-[#6B7280] border-[#E5E8E6] hover:border-[#0F766E] hover:text-[#0F766E]"
                                    }`}
                                  >
                                    <RefreshCcw className="w-2.5 h-2.5" />
                                    {donateFlag
                                      ? `Donate/Toss · Relisted ${row.relist_count}× (${daysRelisted}d)`
                                      : row.relist_count > 0
                                        ? `Relisted ${row.relist_count}× · ${daysRelisted}d`
                                        : "0× relisted"}
                                  </button>
                                );
                              })()}
                              <span className="text-[10px] font-mono text-[#7C858D]">
                                {activeChannelCount}/5 live
                              </span>
                            </div>

                            {/* SKU, Bin, Source & Profit Telemetry */}
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-[#5F666D]">
                              <span>
                                SKU:{" "}
                                <strong className="font-mono text-[#171A1D]">
                                  {row.sku}
                                </strong>
                              </span>
                              {row.bin_location && (
                                <span className="font-mono">
                                  Bin {row.bin_location}
                                </span>
                              )}
                              <span className="font-mono">
                                COGS {formatMoney(row.total_cost_basis)}
                              </span>
                              <span className="font-mono font-semibold text-[#0F766E]">
                                Net +{formatMoney(row.est_net_profit)}
                              </span>
                              {row.source_location && (
                                <span className="text-[10px] text-[#7C858D] truncate max-w-[165px]">
                                  · {row.source_location}
                                </span>
                              )}
                            </div>

                            {/* Compact Interventions Strip */}
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              <button
                                type="button"
                                disabled={isBusy || row.is_at_floor}
                                onClick={() =>
                                  onExecuteAction({
                                    action: "update_price",
                                    listingIds: [row.listing_id],
                                    dropPct: 10,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-medium border border-[#DDE2DF] bg-white text-[#171A1D] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-40 transition cursor-pointer"
                              >
                                <ArrowDownRight className="w-3 h-3" />
                                {row.is_at_floor
                                  ? "At Floor"
                                  : `-10% (${formatMoney(row.projected_drop_price)})`}
                              </button>

                              <button
                                type="button"
                                disabled={isBusy || Boolean(row.stale_radar_exempt)}
                                title={
                                  row.stale_radar_exempt
                                    ? "Protected evergreen listing — click Protected to unlock before ending & selling similar"
                                    : "Ends stale eBay listing & publishes a fresh item ID (increments Relist Counter)"
                                }
                                onClick={() =>
                                  onExecuteAction({
                                    action: "end_and_sell_similar",
                                    listingIds: [row.listing_id],
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border border-[#DDE2DF] bg-white text-[#171A1D] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-40 transition cursor-pointer"
                              >
                                <RefreshCcw className="w-3 h-3" />
                                Sell Similar
                              </button>

                              {onToggleStaleExempt && (
                                <button
                                  type="button"
                                  disabled={
                                    isBusy ||
                                    togglingExemptItemId === row.item_id
                                  }
                                  title={
                                    row.stale_radar_exempt
                                      ? "Protected from Stale Radar & End/Sell Similar. Click to remove protection."
                                      : "Exclude from Stale Radar Flagged & lock Sell Similar (great for multi-qty listings with high sold history & watchers)"
                                  }
                                  onClick={async () => {
                                    setTogglingExemptItemId(row.item_id);
                                    try {
                                      await onToggleStaleExempt({
                                        itemId: row.item_id,
                                        exempt: !row.stale_radar_exempt,
                                      });
                                    } finally {
                                      setTogglingExemptItemId(null);
                                    }
                                  }}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold border transition cursor-pointer disabled:opacity-40 ${
                                    row.stale_radar_exempt
                                      ? "bg-[#ECFDF5] border-[#A7F3D0] text-[#0F766E] hover:bg-[#D1FAE5]"
                                      : "border-[#DDE2DF] bg-white text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E]"
                                  }`}
                                >
                                  <ShieldCheck className="w-3 h-3" />
                                  {row.stale_radar_exempt
                                    ? "Protected"
                                    : "Protect"}
                                </button>
                              )}

                              {onDisposeItem && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  title="Mark item to Donate or Throw Away & automatically delist across all marketplaces"
                                  onClick={() => {
                                    setDisposeTargetRow(row);
                                    setDisposeNote("");
                                  }}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold border transition cursor-pointer ${
                                    isDonateCandidate(row)
                                      ? "bg-[#B91C1C] border-[#B91C1C] text-white hover:bg-[#991B1B]"
                                      : "border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C] hover:bg-[#FEE2E2]"
                                  }`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                  Donate / Toss
                                </button>
                              )}

                              {row.days_listed >= 30 &&
                                row.promoted_ad_rate_pct < 4 && (
                                  <button
                                    type="button"
                                    disabled={isBusy || isPromoting}
                                    title="Promote on eBay at 4% ad rate (30+ days rule)"
                                    onClick={() =>
                                      handleTriggerAutoPromote([row.listing_id])
                                    }
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border border-[#FDE68A] bg-[#FFFBEB] text-[#92400E] hover:bg-[#FEF3C7] cursor-pointer"
                                  >
                                    <Megaphone className="w-3 h-3" />
                                    Promote 4%
                                  </button>
                                )}

                              {row.watchers_count > 0 && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() =>
                                    onExecuteAction({
                                      action: "send_offer",
                                      listingIds: [row.listing_id],
                                      offerPct: 10,
                                    })
                                  }
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border border-[#A7F3D0] bg-[#ECFDF5] text-[#0F766E] hover:bg-[#D1FAE5] disabled:opacity-40 transition cursor-pointer"
                                >
                                  <Heart className="w-3 h-3" />
                                  Offer ({row.watchers_count})
                                </button>
                              )}

                              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#8A929A] ml-auto">
                                <Eye className="w-3 h-3" />
                                {row.views_count}
                              </span>
                            </div>

                            {!isCompact && (
                              <div className="pt-0.5">
                                <label className="block text-[10px] font-medium text-[#8A929A]">
                                  Private notes
                                </label>
                                <input
                                  type="text"
                                  value={notesMap[row.sku] ?? ""}
                                  onChange={(e) =>
                                    updateNote(row.sku, e.target.value)
                                  }
                                  placeholder="Add private note (auto-saves)..."
                                  className="w-full text-xs text-[#171A1D] placeholder:text-[#B0B7BC] bg-transparent border-b border-[#E5E8E6] focus:border-[#0F766E] py-1 focus:outline-none transition-colors"
                                />
                              </div>
                            )}
                          </div>

                          {/* Priority Star + 1-Click List Everywhere */}
                          <div className="flex flex-col items-center gap-1.5 shrink-0 pt-0.5">
                            <button
                              type="button"
                              aria-label={
                                isStarred
                                  ? "Remove from Priority"
                                  : "Star as High-Priority"
                              }
                              title="Star as High-Priority (filter anytime via ★ Priority pill)"
                              onClick={() => toggleStar(row.sku)}
                              className={`p-1 rounded-md transition cursor-pointer ${
                                isStarred
                                  ? "text-[#D97706] bg-[#FFFBEB]"
                                  : "text-[#8A929A] hover:text-[#171A1D] hover:bg-[#F2F4F3]"
                              }`}
                            >
                              <Star
                                className="w-4 h-4"
                                fill={isStarred ? "currentColor" : "none"}
                              />
                            </button>

                            {missingChannels.length > 0 && (
                              <button
                                type="button"
                                disabled={isBusy}
                                title={`1-Click List Everywhere (${missingChannels.length} remaining channels)`}
                                onClick={() => handleRowListAll(row)}
                                className="p-1 rounded-md text-[#0F766E] hover:bg-[#ECFDF5] transition cursor-pointer disabled:opacity-40"
                              >
                                {listingAllItemId === row.item_id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Zap className="w-4 h-4" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* 5 Marketplace Cells */}
                      {MATRIX_CHANNELS.map((ch) => {
                        const isEbay = ch.key === "ebay";
                        const listing = isEbay
                          ? {
                              listed_price: row.listed_price,
                              external_url: row.external_url,
                              external_listing_id: row.external_listing_id,
                              status: row.status,
                            }
                          : row.cross_listings.find(
                              (c) => c.marketplace === ch.key
                            );

                        const queuedJob = extJobLookup.get(
                          `${row.item_id}:${ch.key}`
                        );

                        if (listing) {
                          const adFee = isEbay ? row.promoted_ad_rate_pct : 0;
                          const cellNet = round2(
                            listing.listed_price -
                              round2(
                                listing.listed_price *
                                  ((ch.feePct + adFee) / 100)
                              ) -
                              row.total_cost_basis
                          );
                          const liveUrl = resolveMarketplaceUrl(
                            ch.key,
                            listing.external_url,
                            listing.external_listing_id,
                            row.title
                          );

                          return (
                            <div
                              key={ch.key}
                              className={`${isCompact ? "p-2.5 gap-1.5" : "p-3.5 gap-2"} flex flex-col items-center justify-between`}
                            >
                              <div className="w-full max-w-[132px] flex items-center justify-between text-xs">
                                <span className="font-mono tabular-nums font-semibold text-[#171A1D]">
                                  {formatMoney(listing.listed_price)}
                                </span>
                                <a
                                  href={liveUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`Open live listing on ${ch.label} (Est. net +${formatMoney(cellNet)})`}
                                  className="text-[#0F766E] hover:text-[#0B5B55] transition"
                                >
                                  <ArrowUpRight className="w-3.5 h-3.5" />
                                </a>
                              </div>

                              <a
                                href={liveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open live listing on ${ch.label} in new window (Est. net +${formatMoney(cellNet)})`}
                                className={`relative ${isCompact ? "w-[74px] h-[74px]" : "w-[112px] h-[112px]"} rounded-xl bg-white border border-[#EEF1EF] overflow-hidden flex items-center justify-center p-1.5 group/img hover:border-[#0F766E] hover:shadow-sm transition cursor-pointer`}
                              >
                                {thumb ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={thumb}
                                    alt={`${row.title} on ${ch.label}`}
                                    className="w-full h-full object-contain group-hover/img:scale-[1.04] transition-transform"
                                  />
                                ) : (
                                  <Package className="w-7 h-7 text-[#C9D0CC]" />
                                )}
                                <span className="pointer-events-none absolute inset-x-1 bottom-1 py-0.5 px-1.5 rounded-md bg-[#171A1D]/80 text-white text-[9px] font-semibold text-center opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center gap-0.5">
                                  <span>{ch.label}</span>
                                  <ArrowUpRight className="w-2.5 h-2.5" />
                                </span>
                              </a>

                              <div className="w-full max-w-[126px] flex items-center justify-center gap-1">
                                <a
                                  href={liveUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex-1 text-center py-1 rounded-md text-[11px] font-semibold bg-[#ECFDF5] text-[#0F766E] hover:bg-[#D1FAE5] transition"
                                >
                                  Listed ↗
                                </a>
                                {isEbay && row.promoted_ad_rate_pct > 0 && (
                                  <span
                                    title={`Promoted Listings Standard active at ${row.promoted_ad_rate_pct}%`}
                                    className="px-1.5 py-1 rounded-md text-[10px] font-mono font-bold bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A]"
                                  >
                                    {row.promoted_ad_rate_pct}%
                                  </span>
                                )}
                                {!isEbay && onUnlinkMarketplace && (() => {
                                  const uKey = `${row.item_id}:${ch.key}`;
                                  const isUnlinking = unlinkingKey === uKey;
                                  const isConfirming = confirmUnlinkKey === uKey;
                                  return isConfirming ? (
                                    <button
                                      type="button"
                                      disabled={isUnlinking}
                                      onClick={async () => {
                                        setUnlinkingKey(uKey);
                                        try {
                                          await onUnlinkMarketplace(
                                            row.item_id,
                                            ch.key as CrossListTarget
                                          );
                                          setConfirmUnlinkKey(null);
                                        } finally {
                                          setUnlinkingKey(null);
                                        }
                                      }}
                                      title={`Confirm unlink from ${ch.label}`}
                                      className="px-1.5 py-1 rounded-md text-[10px] font-semibold bg-[#B91C1C] text-white hover:bg-[#991B1B] transition cursor-pointer disabled:opacity-50"
                                    >
                                      {isUnlinking ? "..." : "Unlink?"}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmUnlinkKey(uKey)}
                                      title={`Unlink ${ch.label} listing (if delisted or not actually live)`}
                                      className="p-1 rounded-md text-[#9CA3AF] hover:text-[#B91C1C] hover:bg-[#FEF2F2] transition cursor-pointer"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  );
                                })()}
                              </div>
                            </div>
                          );
                        }

                        if (queuedJob) {
                          const isConfirm =
                            queuedJob.status === "needs_user_confirm";
                          const queuedPrice = Number(
                            queuedJob.payload?.suggestedPrice ?? row.listed_price
                          );
                          return (
                            <div
                              key={ch.key}
                              className={`${isCompact ? "p-2.5 gap-1.5" : "p-3.5 gap-2"} flex flex-col items-center justify-between`}
                            >
                              <div className="w-full max-w-[132px] flex items-center justify-between text-xs">
                                <span className="font-mono tabular-nums font-semibold text-[#5F666D]">
                                  {formatMoney(queuedPrice)}
                                </span>
                                <span className="text-[10px] font-mono text-[#B45309]">
                                  EXT
                                </span>
                              </div>
                              <div
                                className={`${isCompact ? "w-[74px] h-[74px]" : "w-[112px] h-[112px]"} rounded-xl bg-white border border-[#FDE68A] overflow-hidden flex items-center justify-center p-1.5 opacity-85`}
                              >
                                {thumb ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={thumb}
                                    alt={row.title}
                                    className="w-full h-full object-contain"
                                  />
                                ) : (
                                  <Package className="w-7 h-7 text-[#C9D0CC]" />
                                )}
                              </div>
                              <div className="w-full max-w-[126px] flex items-center justify-center gap-1">
                                {isLive && !isConfirm ? (
                                  <span
                                    title={
                                      queuedJob.status === "processing"
                                        ? "Mac Mini Auto-Pilot is actively filling and publishing this listing now — this card will auto-update to Listed ↗"
                                        : "Queued for Mac Mini Auto-Pilot (picks up every ~30s and auto-updates to Listed ↗)"
                                    }
                                    className={`flex-1 inline-flex items-center justify-center gap-1 text-center py-1 px-1.5 rounded-md text-[10px] font-semibold border ${
                                      queuedJob.status === "processing"
                                        ? "bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]"
                                        : "bg-[#ECFDF5] text-[#0F766E] border-[#A7F3D0]"
                                    }`}
                                  >
                                    {queuedJob.status === "processing" ? (
                                      <>
                                        <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
                                        Posting…
                                      </>
                                    ) : (
                                      "Queued · Auto-Pilot"
                                    )}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onUpdateExtensionJob({
                                        jobId: queuedJob.id,
                                        status:
                                          !isConfirm && ch.key === "facebook"
                                            ? "needs_user_confirm"
                                            : "completed",
                                        listedPrice: queuedPrice,
                                      })
                                    }
                                    className={`flex-1 text-center py-1 rounded-md text-[11px] font-semibold transition cursor-pointer ${
                                      isConfirm
                                        ? "bg-[#FEF3C7] text-[#92400E] border border-[#F59E0B] hover:bg-[#FDE68A]"
                                        : "bg-[#EFF6FF] text-[#1D4ED8] hover:bg-[#DBEAFE]"
                                    }`}
                                  >
                                    {isConfirm ? "Confirm Pub ✓" : "Run Ext ▶"}
                                  </button>
                                )}
                                {onDeleteExtensionJob && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onDeleteExtensionJob(queuedJob.id)
                                    }
                                    title="Cancel queued extension job"
                                    className="p-1 rounded-md text-[#9CA3AF] hover:text-[#B91C1C] hover:bg-[#FEF2F2] transition cursor-pointer"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        }

                        const est = estimateChannelOffer(
                          row.listed_price,
                          row.cogs,
                          row.floor_price,
                          ch.feePct,
                          ch.markupPct
                        );

                        return (
                          <div
                            key={ch.key}
                            className={`${isCompact ? "p-2.5" : "p-3.5"} flex items-center justify-center`}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                onOpenCrossList(row, ch.key as CrossListTarget)
                              }
                              className={`${isCompact ? "w-[116px] h-[108px]" : "w-[126px] h-[148px]"} rounded-xl border border-dashed border-[#D5DCD8] bg-[#FCFDFC] hover:bg-[#F2FBF8] hover:border-[#0F766E] transition-all flex flex-col items-center justify-center gap-1 px-2 text-center group/add cursor-pointer`}
                            >
                              <Plus className="w-4 h-4 text-[#0F766E] group-hover/add:scale-110 transition-transform" />
                              <span className="text-xs font-semibold text-[#0F766E] leading-tight">
                                List on
                                <br />
                                {ch.label}
                              </span>
                              <span className="mt-0.5 text-[10px] font-mono tabular-nums text-[#7C858D] group-hover/add:text-[#0F766E]">
                                {formatMoney(est.price)} · +
                                {formatMoney(est.net)}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Donate / Throw Away & Auto-Delist Confirmation Modal */}
      {disposeTargetRow && onDisposeItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isDisposing) {
              setDisposeTargetRow(null);
            }
          }}
        >
          <div className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#ECEFE9] bg-[#FEF2F2] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#991B1B]">
                  Donate or Throw Away Item
                </h3>
                <p className="text-[11px] font-mono text-[#B91C1C]">
                  {disposeTargetRow.sku}
                  {disposeTargetRow.bin_location
                    ? ` · Bin ${disposeTargetRow.bin_location}`
                    : ""}
                  {disposeTargetRow.relist_count > 0
                    ? ` · Relisted ${disposeTargetRow.relist_count}× (${disposeTargetRow.days_since_relist ?? disposeTargetRow.days_listed}d ago)`
                    : ` · ${disposeTargetRow.days_listed}d listed`}
                </p>
              </div>
              <button
                type="button"
                disabled={isDisposing}
                onClick={() => setDisposeTargetRow(null)}
                className="p-1 rounded-lg text-[#991B1B] hover:bg-[#FEE2E2] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="text-xs text-[#171A1D] font-semibold leading-snug">
                {disposeTargetRow.title}
              </div>

              <div className="rounded-xl bg-[#FAFBF9] border border-[#E5E8E6] p-3 text-xs space-y-1">
                <div className="text-[#5F666D]">
                  This will archive the SKU and{" "}
                  <strong className="text-[#171A1D]">
                    automatically end/delist
                  </strong>{" "}
                  it on all active channels:
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {disposeTargetRow.cross_listings
                    .filter((c) => c.status === "active" || c.status === "draft")
                    .map((c) => (
                      <span
                        key={c.marketplace}
                        className="px-2 py-0.5 rounded bg-white border border-[#DDE2DF] text-[10px] font-mono font-bold uppercase text-[#171A1D]"
                      >
                        {c.marketplace}
                      </span>
                    ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                  Optional Note (e.g. Goodwill drop-off, damaged)
                </label>
                <input
                  type="text"
                  value={disposeNote}
                  onChange={(e) => setDisposeNote(e.target.value)}
                  placeholder="Goodwill donation box / damaged..."
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] focus:border-[#0F766E] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  disabled={isDisposing}
                  onClick={async () => {
                    setIsDisposing(true);
                    try {
                      await onDisposeItem({
                        itemId: disposeTargetRow.item_id,
                        disposition: "donated",
                        note: disposeNote.trim() || undefined,
                      });
                      setDisposeTargetRow(null);
                    } finally {
                      setIsDisposing(false);
                    }
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-bold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer"
                >
                  {isDisposing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Donate &amp; Delist All
                </button>
                <button
                  type="button"
                  disabled={isDisposing}
                  onClick={async () => {
                    setIsDisposing(true);
                    try {
                      await onDisposeItem({
                        itemId: disposeTargetRow.item_id,
                        disposition: "discarded",
                        note: disposeNote.trim() || undefined,
                      });
                      setDisposeTargetRow(null);
                    } finally {
                      setIsDisposing(false);
                    }
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-bold bg-[#B91C1C] text-white hover:bg-[#991B1B] disabled:opacity-50 cursor-pointer"
                >
                  {isDisposing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Throw Away &amp; Delist All
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
