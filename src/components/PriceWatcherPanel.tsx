"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  Heart,
  Loader2,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  Trash2,
  TrendingDown,
} from "lucide-react";
import { PRICE_WATCHER_TIERS } from "@/lib/stale-engine";
import type {
  EbayActionRequest,
  PriceWatcherStage,
  StaleRadarRow,
} from "@/lib/types";

interface PriceWatcherPanelProps {
  items: StaleRadarRow[];
  busyListingIds: Set<string>;
  isBulkBusy: boolean;
  onExecuteAction: (request: EbayActionRequest) => Promise<void>;
  onPriceWatcherAction: (params: {
    itemId: string;
    sku: string;
    mode: "skip_stage" | "keep" | "reopen";
    stage?: 30 | 45 | 60;
  }) => Promise<void>;
  onOpenDispose?: (row: StaleRadarRow, defaultNote?: string) => void;
  onOpenRelist?: (row: StaleRadarRow) => void;
  onOpenItemDetail: (row: StaleRadarRow) => void;
}

type StageFilter = "all" | PriceWatcherStage | "kept";

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function daysAgoLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const days = Math.max(0, Math.floor((nowMs - ms) / (1000 * 60 * 60 * 24)));
  return days === 0 ? "today" : `${days}d ago`;
}

export function PriceWatcherPanel({
  items,
  busyListingIds,
  isBulkBusy,
  onExecuteAction,
  onPriceWatcherAction,
  onOpenDispose,
  onOpenRelist,
  onOpenItemDetail,
}: PriceWatcherPanelProps) {
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(new Set());
  const [bulkStageRunning, setBulkStageRunning] = useState<30 | 45 | 60 | null>(
    null
  );
  const [mountNow] = useState(() => Date.now());

  const buckets = useMemo(() => {
    const byStage: Record<PriceWatcherStage, StaleRadarRow[]> = {
      30: [],
      45: [],
      60: [],
      90: [],
    };
    const kept90: StaleRadarRow[] = [];

    for (const row of items) {
      if (row.stale_radar_exempt) continue;
      if (row.price_watcher_due && row.price_watcher_stage) {
        byStage[row.price_watcher_stage].push(row);
      } else if (row.days_listed >= 90 && row.price_watcher_decision === "keep") {
        kept90.push(row);
      }
    }

    const sortOldest = (list: StaleRadarRow[]) =>
      list.sort((a, b) => b.days_listed - a.days_listed);
    sortOldest(byStage[30]);
    sortOldest(byStage[45]);
    sortOldest(byStage[60]);
    sortOldest(byStage[90]);
    sortOldest(kept90);

    const allDue = [...byStage[90], ...byStage[60], ...byStage[45], ...byStage[30]];

    return { byStage, allDue, kept90 };
  }, [items]);

  const droppableByStage = useMemo(() => {
    const map: Record<30 | 45 | 60, StaleRadarRow[]> = { 30: [], 45: [], 60: [] };
    for (const stage of [30, 45, 60] as const) {
      map[stage] = buckets.byStage[stage].filter(
        (r) => !r.is_at_floor && !r.fb_local_only && r.marketplace === "ebay"
      );
    }
    return map;
  }, [buckets.byStage]);

  const visibleRows = useMemo(() => {
    if (stageFilter === "kept") return buckets.kept90;
    if (stageFilter === "all") return buckets.allDue;
    return buckets.byStage[stageFilter];
  }, [buckets, stageFilter]);

  const locked90Cogs = useMemo(
    () => buckets.byStage[90].reduce((sum, r) => sum + Number(r.cogs || 0), 0),
    [buckets.byStage]
  );

  const runStageAction = async (params: {
    itemId: string;
    sku: string;
    mode: "skip_stage" | "keep" | "reopen";
    stage?: 30 | 45 | 60;
  }) => {
    setBusyItemIds((prev) => {
      const next = new Set(prev);
      next.add(params.itemId);
      return next;
    });
    try {
      await onPriceWatcherAction(params);
    } finally {
      setBusyItemIds((prev) => {
        const next = new Set(prev);
        next.delete(params.itemId);
        return next;
      });
    }
  };

  const runBulkStageDrop = async (stage: 30 | 45 | 60, dropPct: number) => {
    const targets = droppableByStage[stage];
    if (targets.length === 0) return;
    setBulkStageRunning(stage);
    try {
      await onExecuteAction({
        action: "update_price",
        listingIds: targets.map((r) => r.listing_id),
        dropPct,
        priceWatcherStage: stage,
      });
    } finally {
      setBulkStageRunning(null);
    }
  };

  return (
    <section className="bg-white border border-[#DCE4E0] rounded-xl overflow-hidden shadow-[0_1px_3px_rgba(20,21,26,0.04)]">
      {/* Header */}
      <div className="px-4 sm:px-5 py-3.5 border-b border-[#ECECE6] bg-gradient-to-r from-[#FAFBF9] to-[#F3FAF7] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E] flex items-center justify-center shrink-0 mt-0.5">
            <TrendingDown className="w-4 h-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-[#14151A]">
                Price Watcher · 30 / 45 / 60 / 90-Day Cadence
              </h3>
              <span
                className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-bold border ${
                  buckets.allDue.length > 0
                    ? "bg-[#FEF3C7] text-[#B45309] border-[#FDE68A]"
                    : "bg-[#ECFDF5] text-[#0F766E] border-[#A7F3D0]"
                }`}
              >
                {buckets.allDue.length} due now
              </span>
            </div>
            <p className="text-xs text-[#5C606B] mt-0.5">
              Escalating floor-protected markdowns:{" "}
              <strong className="font-mono text-[#171A1D]">30d (-10%)</strong> →{" "}
              <strong className="font-mono text-[#171A1D]">45d (-15%)</strong> →{" "}
              <strong className="font-mono text-[#171A1D]">60d (-20%)</strong> →{" "}
              <strong className="font-mono text-[#B91C1C]">
                90d Delist &amp; Donate vs Keep
              </strong>
              . Never drops below your COGS floor.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStageFilter("all")}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
              stageFilter === "all"
                ? "bg-[#0F766E] text-white"
                : "bg-white border border-[#DDE2DF] text-[#444B52] hover:border-[#0F766E]"
            }`}
          >
            All Due ({buckets.allDue.length})
          </button>
          {buckets.kept90.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setStageFilter((prev) => (prev === "kept" ? "all" : "kept"))
              }
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                stageFilter === "kept"
                  ? "bg-[#171A1D] text-white"
                  : "bg-white border border-[#DDE2DF] text-[#444B52] hover:border-[#171A1D]"
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Kept 90d+ ({buckets.kept90.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* 4 Stage Summary & Bulk-Action Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 p-3.5 border-b border-[#F1F1EC] bg-[#FAFBF9]">
        {PRICE_WATCHER_TIERS.map((tier) => {
          const stageRows = buckets.byStage[tier.stage];
          const isSelected = stageFilter === tier.stage;
          const isDecision = tier.stage === 90;
          const droppableCount =
            tier.stage === 90 ? 0 : droppableByStage[tier.stage].length;
          const atFloorCount =
            tier.stage === 90
              ? 0
              : stageRows.filter((r) => r.is_at_floor).length;
          const isThisBulkRunning = bulkStageRunning === tier.stage;

          const accentStyles =
            tier.stage === 90
              ? isSelected
                ? "border-[#B91C1C] bg-[#FEF2F2] ring-1 ring-[#B91C1C]/20"
                : "border-[#FECACA] bg-white hover:border-[#F87171]"
              : tier.stage === 60
                ? isSelected
                  ? "border-[#EA580C] bg-[#FFF7ED] ring-1 ring-[#EA580C]/20"
                  : "border-[#FED7AA] bg-white hover:border-[#FB923C]"
                : tier.stage === 45
                  ? isSelected
                    ? "border-[#D97706] bg-[#FFFBEB] ring-1 ring-[#D97706]/20"
                    : "border-[#FDE68A] bg-white hover:border-[#FBBF24]"
                  : isSelected
                    ? "border-[#0F766E] bg-[#ECFDF5] ring-1 ring-[#0F766E]/20"
                    : "border-[#DDE2DF] bg-white hover:border-[#0F766E]";

          const badgeColor =
            tier.stage === 90
              ? "text-[#B91C1C] bg-[#FEF2F2] border-[#FECACA]"
              : tier.stage === 60
                ? "text-[#C2410C] bg-[#FFF7ED] border-[#FED7AA]"
                : tier.stage === 45
                  ? "text-[#B45309] bg-[#FFFBEB] border-[#FDE68A]"
                  : "text-[#0F766E] bg-[#ECFDF5] border-[#A7F3D0]";

          return (
            <div
              key={tier.stage}
              onClick={() =>
                setStageFilter((prev) =>
                  prev === tier.stage ? "all" : tier.stage
                )
              }
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setStageFilter((prev) =>
                    prev === tier.stage ? "all" : tier.stage
                  );
                }
              }}
              className={`rounded-xl border p-3 transition cursor-pointer flex flex-col justify-between gap-2.5 ${accentStyles}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold border ${badgeColor}`}
                  >
                    <Clock className="w-2.5 h-2.5" />
                    {tier.shortLabel}
                  </span>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="text-xl font-bold font-mono tabular-nums text-[#14151A]">
                      {stageRows.length}
                    </span>
                    <span className="text-[11px] text-[#5C606B]">
                      {stageRows.length === 1 ? "listing" : "listings"}
                    </span>
                  </div>
                </div>
                {!isDecision && atFloorCount > 0 && (
                  <span className="text-[10px] font-mono text-[#7C858D] bg-[#F2F4F3] px-1.5 py-0.5 rounded">
                    {atFloorCount} at floor
                  </span>
                )}
                {isDecision && stageRows.length > 0 && (
                  <span className="text-[10px] font-mono font-semibold text-[#B91C1C] bg-[#FEF2F2] px-1.5 py-0.5 rounded">
                    {fmtMoney(locked90Cogs)} COGS
                  </span>
                )}
              </div>

              {!isDecision ? (
                <button
                  type="button"
                  disabled={
                    isBulkBusy ||
                    bulkStageRunning !== null ||
                    droppableCount === 0
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    void runBulkStageDrop(tier.stage, tier.dropPct);
                  }}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-40 transition cursor-pointer"
                >
                  {isThisBulkRunning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ArrowDownRight className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {droppableCount > 0
                      ? `Apply -${tier.dropPct}% to All (${droppableCount})`
                      : stageRows.length > 0
                        ? "All at COGS Floor"
                        : "All Caught Up"}
                  </span>
                </button>
              ) : (
                <div className="text-[11px] font-semibold text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-2.5 py-1.5 text-center">
                  {stageRows.length > 0
                    ? "Review Keep vs Delist & Donate below"
                    : "No 90d+ decisions pending"}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Action Queue */}
      {visibleRows.length === 0 ? (
        <div className="px-6 py-8 text-center space-y-1.5">
          <div className="w-9 h-9 rounded-full bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0] flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <p className="text-xs font-bold text-[#14151A]">
            {stageFilter === "kept"
              ? "No 90d+ kept listings"
              : stageFilter === "all"
                ? "Price Watcher is all caught up!"
                : `No listings currently due at the ${stageFilter}d milestone`}
          </p>
          <p className="text-[11px] text-[#5C606B] max-w-md mx-auto">
            {stageFilter === "all"
              ? "Every 30d / 45d / 60d markdown and 90d decision has been handled. Listings will automatically reappear when they hit their next age milestone."
              : "Click All Due above to view items at other age milestones."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[#F1F1EC] max-h-[520px] overflow-y-auto">
          {visibleRows.map((row) => {
            const isRowBusy =
              busyListingIds.has(row.listing_id) ||
              busyItemIds.has(row.item_id) ||
              isBulkBusy ||
              bulkStageRunning !== null;
            const stage = row.price_watcher_stage;
            const isKeptView = stageFilter === "kept";
            const is90Decision = !isKeptView && stage === 90;
            const canDropOnEbay =
              !isKeptView &&
              (stage === 30 || stage === 45 || stage === 60) &&
              !row.is_at_floor &&
              !row.fb_local_only &&
              row.marketplace === "ebay";
            const lastDropAgo = daysAgoLabel(row.last_price_drop_at, mountNow);
            const thumb = row.image_urls?.[0];

            const stagePillClass = isKeptView
              ? "bg-[#F3F4F6] text-[#374151] border-[#D1D5DB]"
              : stage === 90
                ? "bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]"
                : stage === 60
                  ? "bg-[#FFF7ED] text-[#C2410C] border-[#FED7AA]"
                  : stage === 45
                    ? "bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]"
                    : "bg-[#ECFDF5] text-[#0F766E] border-[#A7F3D0]";

            const stagePillText = isKeptView
              ? "Kept 90d+"
              : stage === 90
                ? "90d+ Decision"
                : stage
                  ? `${stage}d · -${row.price_watcher_drop_pct}%`
                  : `${row.days_listed}d`;

            return (
              <div
                key={row.listing_id}
                className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-[#FAFBF9] transition"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpenItemDetail(row)}
                    className="shrink-0 cursor-pointer"
                    title="Inspect item details"
                  >
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb}
                        alt={row.title}
                        className="w-11 h-11 rounded-lg object-cover border border-[#E4E4DD] bg-[#F7F9F8]"
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-lg border border-[#E4E4DD] bg-[#F7F9F8] flex items-center justify-center text-[#8E969D]">
                        <TrendingDown className="w-4 h-4" />
                      </div>
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] font-bold border shrink-0 ${stagePillClass}`}
                      >
                        {stagePillText}
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenItemDetail(row)}
                        className="font-semibold text-[#14151A] hover:text-[#0F766E] truncate text-left cursor-pointer max-w-[420px]"
                      >
                        {row.title}
                      </button>
                      {row.external_url && (
                        <a
                          href={row.external_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open on eBay"
                          className="text-[#8E969D] hover:text-[#0F766E] shrink-0"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>

                    <div className="text-[11px] font-mono text-[#5C606B] mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>{row.sku}</span>
                      {row.bin_location && (
                        <>
                          <span>·</span>
                          <span>Bin {row.bin_location}</span>
                        </>
                      )}
                      <span>·</span>
                      <span className="font-semibold text-[#171A1D]">
                        {row.days_listed}d listed
                      </span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-0.5">
                        <Eye className="w-3 h-3" />
                        {row.views_count}
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <Heart className="w-3 h-3" />
                        {row.watchers_count}
                      </span>
                      {!isKeptView && !is90Decision && stage && (
                        <>
                          <span>·</span>
                          {row.is_at_floor ? (
                            <span className="text-[#B45309] font-semibold">
                              At COGS Floor ({fmtMoney(row.floor_price)})
                            </span>
                          ) : (
                            <span>
                              {fmtMoney(row.listed_price)} →{" "}
                              <strong className="text-[#0F766E]">
                                {fmtMoney(row.price_watcher_target_price)}
                              </strong>
                              {row.price_watcher_would_clamp
                                ? ` (clamped to ${fmtMoney(row.floor_price)} floor)`
                                : ` (floor ${fmtMoney(row.floor_price)})`}
                            </span>
                          )}
                        </>
                      )}
                      {(is90Decision || isKeptView) && (
                        <>
                          <span>·</span>
                          <span>
                            Ask <strong>{fmtMoney(row.listed_price)}</strong> ·
                            COGS {fmtMoney(row.cogs)} · Floor{" "}
                            {fmtMoney(row.floor_price)}
                          </span>
                        </>
                      )}
                      {lastDropAgo && (
                        <>
                          <span>·</span>
                          <span className="text-[#7C858D]">
                            Last drop {lastDropAgo}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Per-item action buttons */}
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  {isKeptView ? (
                    <>
                      <button
                        type="button"
                        disabled={isRowBusy}
                        onClick={() =>
                          void runStageAction({
                            itemId: row.item_id,
                            sku: row.sku,
                            mode: "reopen",
                          })
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#DDE2DF] bg-white text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Re-open</span>
                      </button>
                      {onOpenDispose && (
                        <button
                          type="button"
                          disabled={isRowBusy}
                          onClick={() =>
                            onOpenDispose(row, "90-day Price Watcher review")
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C] hover:bg-[#FEE2E2] disabled:opacity-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delist &amp; Donate</span>
                        </button>
                      )}
                    </>
                  ) : is90Decision ? (
                    <>
                      {onOpenDispose && (
                        <button
                          type="button"
                          disabled={isRowBusy}
                          onClick={() =>
                            onOpenDispose(row, "90-day Price Watcher review")
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#B91C1C] text-white hover:bg-[#991B1B] disabled:opacity-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delist &amp; Donate</span>
                        </button>
                      )}
                      {onOpenRelist &&
                        !row.fb_local_only &&
                        row.marketplace === "ebay" && (
                          <button
                            type="button"
                            disabled={isRowBusy}
                            onClick={() => onOpenRelist(row)}
                            title="End & Sell Similar on eBay to start a fresh 0-day clock"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#DDE2DF] bg-white text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 cursor-pointer"
                          >
                            <RefreshCcw className="w-3.5 h-3.5" />
                            <span>Relist</span>
                          </button>
                        )}
                      <button
                        type="button"
                        disabled={isRowBusy}
                        onClick={() =>
                          void runStageAction({
                            itemId: row.item_id,
                            sku: row.sku,
                            mode: "keep",
                          })
                        }
                        title="Keep listing active and clear from 90-day decision queue"
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#A7F3D0] bg-[#ECFDF5] text-[#0F766E] hover:bg-[#D1FAE5] disabled:opacity-50 cursor-pointer"
                      >
                        {busyItemIds.has(row.item_id) ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="w-3.5 h-3.5" />
                        )}
                        <span>Keep Listing</span>
                      </button>
                    </>
                  ) : (
                    <>
                      {canDropOnEbay && stage ? (
                        <button
                          type="button"
                          disabled={isRowBusy}
                          onClick={() =>
                            void onExecuteAction({
                              action: "update_price",
                              listingIds: [row.listing_id],
                              dropPct: row.price_watcher_drop_pct,
                              priceWatcherStage: stage,
                            })
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer"
                        >
                          {busyListingIds.has(row.listing_id) ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <ArrowDownRight className="w-3.5 h-3.5" />
                          )}
                          <span>
                            Drop -{row.price_watcher_drop_pct}% →{" "}
                            {fmtMoney(row.price_watcher_target_price)}
                          </span>
                        </button>
                      ) : (
                        <>
                          {onOpenRelist &&
                            !row.fb_local_only &&
                            row.marketplace === "ebay" && (
                              <button
                                type="button"
                                disabled={isRowBusy}
                                onClick={() => onOpenRelist(row)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#DDE2DF] bg-white text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 cursor-pointer"
                              >
                                <RefreshCcw className="w-3.5 h-3.5" />
                                <span>Relist</span>
                              </button>
                            )}
                          {onOpenDispose && (
                            <button
                              type="button"
                              disabled={isRowBusy}
                              onClick={() =>
                                onOpenDispose(
                                  row,
                                  `At COGS floor (${row.days_listed}d Price Watcher)`
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C] hover:bg-[#FEE2E2] disabled:opacity-50 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Donate</span>
                            </button>
                          )}
                        </>
                      )}

                      {(stage === 30 || stage === 45 || stage === 60) && (
                        <button
                          type="button"
                          disabled={isRowBusy}
                          onClick={() =>
                            void runStageAction({
                              itemId: row.item_id,
                              sku: row.sku,
                              mode: "skip_stage",
                              stage,
                            })
                          }
                          title={`Skip the ${stage}-day price drop and wait for the next milestone`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-[#E4E4DD] bg-white text-[#5C606B] hover:border-[#171A1D] hover:text-[#171A1D] disabled:opacity-50 cursor-pointer"
                        >
                          {busyItemIds.has(row.item_id) ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <SkipForward className="w-3.5 h-3.5" />
                          )}
                          <span>Skip</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
