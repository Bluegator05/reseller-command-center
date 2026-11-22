"use client";

import {
  CheckCircle2,
  Clock,
  Layers,
  Puzzle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { MarketplaceAccount, MarketplaceType } from "@/lib/types";

interface ChannelStatusStripProps {
  mode: "live" | "demo";
  accounts: MarketplaceAccount[];
  channelCounts: Record<MarketplaceType, number>;
  extensionPendingCount: number;
  lastSyncedAt: string | null;
  isSyncingEbay: boolean;
  isSyncingEtsy: boolean;
  onSyncEbay: () => void;
  onSyncEtsy: () => void;
  onOpenExtensionQueue: () => void;
}

interface ChannelMeta {
  key: MarketplaceType;
  label: string;
  integrationMode: string;
  defaultFee: number;
  markupPct: number;
  isExtension: boolean;
}

const CHANNEL_ORDER: ChannelMeta[] = [
  {
    key: "ebay",
    label: "eBay",
    integrationMode: "Official API",
    defaultFee: 13.25,
    markupPct: 0,
    isExtension: false,
  },
  {
    key: "poshmark",
    label: "Poshmark",
    integrationMode: "MV3 Extension",
    defaultFee: 20,
    markupPct: 12,
    isExtension: true,
  },
  {
    key: "mercari",
    label: "Mercari",
    integrationMode: "MV3 Extension",
    defaultFee: 10,
    markupPct: 5,
    isExtension: true,
  },
  {
    key: "etsy",
    label: "Etsy",
    integrationMode: "Open API v3",
    defaultFee: 9.5,
    markupPct: 5,
    isExtension: false,
  },
  {
    key: "facebook",
    label: "FB Marketplace",
    integrationMode: "Ext + Confirm",
    defaultFee: 5,
    markupPct: 0,
    isExtension: true,
  },
];

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never synced";
  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs) || diffMs < 0) return "Just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function ChannelStatusStrip({
  mode,
  accounts,
  channelCounts,
  extensionPendingCount,
  lastSyncedAt,
  isSyncingEbay,
  isSyncingEtsy,
  onSyncEbay,
  onSyncEtsy,
  onOpenExtensionQueue,
}: ChannelStatusStripProps) {
  const accountMap = new Map(accounts.map((a) => [a.marketplace, a]));

  return (
    <section
      aria-label="Marketplace Channel Status"
      className="bg-white border border-[#E4E4DD] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden"
    >
      <div className="px-4 py-2.5 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-[#5C606B]">
          <Layers className="w-3.5 h-3.5 text-[#14151A]" />
          <span className="uppercase tracking-[0.06em] text-[11px] font-semibold text-[#14151A]">
            Channel Status Strip
          </span>
          <span className="text-[#C8C8BE]">•</span>
          <span>
            All 5 marketplaces connected (eBay &amp; Etsy APIs + MV3 Extension)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-[#5C606B] font-mono tabular-nums">
            <Clock className="w-3.5 h-3.5 text-[#8A8E99]" />
            {formatRelativeTime(lastSyncedAt)}
          </span>
          {extensionPendingCount > 0 && (
            <button
              type="button"
              onClick={onOpenExtensionQueue}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A] hover:bg-[#FEF3C7] transition cursor-pointer"
            >
              <Puzzle className="w-3.5 h-3.5" />
              {extensionPendingCount} Extension Job
              {extensionPendingCount === 1 ? "" : "s"}
            </button>
          )}
          <button
            id="btn-sync-etsy"
            type="button"
            onClick={onSyncEtsy}
            disabled={isSyncingEtsy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-[#14151A] border border-[#DCDCD5] hover:bg-[#F1F1EC] active:scale-[0.99] transition disabled:opacity-60 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isSyncingEtsy ? "animate-spin" : ""}`}
            />
            {isSyncingEtsy ? "Syncing Etsy..." : "Sync Etsy"}
          </button>
          <button
            id="btn-sync-ebay"
            type="button"
            onClick={onSyncEbay}
            disabled={isSyncingEbay}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#14151A] text-white hover:bg-[#272A34] active:scale-[0.99] transition disabled:opacity-60 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isSyncingEbay ? "animate-spin" : ""}`}
            />
            {isSyncingEbay ? "Syncing eBay..." : "Sync eBay Offers"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-[#ECECE6]">
        {CHANNEL_ORDER.map((channel) => {
          const acct = accountMap.get(channel.key);
          const feePct = acct?.default_fee_pct ?? channel.defaultFee;
          const count = channelCounts[channel.key] || 0;

          return (
            <div
              key={channel.key}
              className="px-4 py-3 flex flex-col justify-between gap-2 bg-white"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      channel.isExtension
                        ? "bg-[#0F766E]"
                        : mode === "live"
                          ? "bg-[#0F766E]"
                          : "bg-[#1D4ED8]"
                    }`}
                  />
                  <span className="text-sm font-semibold text-[#14151A] truncate">
                    {channel.label}
                  </span>
                </div>

                {channel.isExtension ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[#ECFDF5] text-[#0F766E]">
                    <Puzzle className="w-3 h-3" />
                    Ext Ready
                  </span>
                ) : (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${
                      mode === "live"
                        ? "bg-[#ECFDF5] text-[#0F766E]"
                        : "bg-[#EFF6FF] text-[#1D4ED8]"
                    }`}
                  >
                    <CheckCircle2 className="w-3 h-3" />
                    {mode === "live" ? "Live API" : "API Ready"}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between text-xs text-[#5C606B]">
                <span className="inline-flex items-center gap-1">
                  {channel.isExtension ? (
                    <Puzzle className="w-3 h-3 text-[#8A8E99]" />
                  ) : (
                    <ShieldCheck className="w-3 h-3 text-[#8A8E99]" />
                  )}
                  {channel.integrationMode}
                </span>
                <span className="font-mono tabular-nums text-[11px]">
                  <strong className="text-[#14151A] font-semibold">
                    {count} {channel.key === "ebay" ? "SKUs" : "live"}
                  </strong>
                  <span className="text-[#8A8E99]"> · {feePct}%</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
