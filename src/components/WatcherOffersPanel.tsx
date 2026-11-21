"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Eye,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import { computeClampedPriceDrop } from "@/lib/stale-engine";
import type {
  ChannelJob,
  EbayActionRequest,
  StaleRadarRow,
} from "@/lib/types";

interface WatcherOffersPanelProps {
  items: StaleRadarRow[];
  recentJobs?: ChannelJob[];
  isLive?: boolean;
  isBusy: boolean;
  onSendOffer: (req: EbayActionRequest) => Promise<void>;
}

const OFFER_COOLDOWN_MS = 96 * 60 * 60 * 1000; // 4-day eBay offer validity window

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function WatcherOffersPanel({
  items,
  recentJobs = [],
  isLive = false,
  isBusy,
  onSendOffer,
}: WatcherOffersPanelProps) {
  const [offerPct, setOfferPct] = useState<number>(10);
  const [message, setMessage] = useState(
    "Thanks for watching! Here is a private discount — ships fast within 1 business day."
  );
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [mountNow] = useState(() => Date.now());
  const [eligibleExternalIds, setEligibleExternalIds] =
    useState<Set<string> | null>(null);
  const [isCheckingEligible, setIsCheckingEligible] = useState(false);
  const [eligibleChecked, setEligibleChecked] = useState(false);

  const checkLiveEligibility = useCallback(async () => {
    if (!isLive) return;
    setIsCheckingEligible(true);
    try {
      const res = await fetch("/api/ebay/eligible-offers", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        mode?: string;
        listingIds?: string[] | null;
      };
      if (data.mode === "live" && Array.isArray(data.listingIds)) {
        setEligibleExternalIds(new Set(data.listingIds));
        setEligibleChecked(true);
      }
    } catch {
      // Fall back quietly to watcher-based queue if network blip occurs
    } finally {
      setIsCheckingEligible(false);
    }
  }, [isLive]);

  useEffect(() => {
    if (!isLive) return;
    let cancelled = false;
    fetch("/api/ebay/eligible-offers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { mode?: string; listingIds?: string[] | null } | null) => {
        if (cancelled || !data) return;
        if (data.mode === "live" && Array.isArray(data.listingIds)) {
          setEligibleExternalIds(new Set(data.listingIds));
          setEligibleChecked(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLive]);

  // Exclude any listing that already had a completed send_offer within the 4-day offer window
  const recentlySentListingIds = useMemo(() => {
    const cutoff = mountNow - OFFER_COOLDOWN_MS;
    const set = new Set<string>(sentIds);
    for (const job of recentJobs) {
      if (job.action !== "send_offer" || job.status !== "completed") continue;
      if (!job.listing_id) continue;
      const ts = Date.parse(job.completed_at || job.created_at || "");
      if (!Number.isNaN(ts) && ts >= cutoff) {
        set.add(job.listing_id);
      }
    }
    return set;
  }, [mountNow, recentJobs, sentIds]);

  const eligibleRows = useMemo(() => {
    return items
      .filter((row) => {
        if (row.is_at_floor) return false;
        if (recentlySentListingIds.has(row.listing_id)) return false;
        // When eBay's live find_eligible_items succeeded, match Seller Hub 1-to-1
        if (eligibleExternalIds !== null) {
          return Boolean(
            row.external_listing_id &&
              eligibleExternalIds.has(row.external_listing_id)
          );
        }
        return row.watchers_count > 0;
      })
      .sort((a, b) => b.watchers_count - a.watchers_count);
  }, [items, recentlySentListingIds, eligibleExternalIds]);

  const hotRows = useMemo(
    () => eligibleRows.filter((r) => r.watchers_count >= 5),
    [eligibleRows]
  );

  // If live check finished and 0 offers remain, show a compact "all caught up" strip with Refresh
  if (eligibleRows.length === 0) {
    if (isLive && (eligibleChecked || sentIds.size > 0)) {
      return (
        <section className="bg-white border border-[#E4E4DD] rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-[#0F766E] font-medium">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>
              All caught up — no eBay listings currently waiting for watcher
              offers.
            </span>
          </div>
          <button
            type="button"
            disabled={isCheckingEligible}
            onClick={() => void checkLiveEligibility()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#DDE2DF] text-[11px] font-semibold text-[#5C606B] hover:text-[#14151A] hover:border-[#0F766E] cursor-pointer disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3 h-3 ${isCheckingEligible ? "animate-spin" : ""}`}
            />
            <span>Re-check eBay</span>
          </button>
        </section>
      );
    }
    return null;
  }

  async function fireOffer(rowsToSend: StaleRadarRow[]) {
    const listingIds = rowsToSend.map((r) => r.listing_id);
    if (listingIds.length === 0) return;

    setSendingIds((prev) => {
      const next = new Set(prev);
      for (const id of listingIds) next.add(id);
      return next;
    });

    try {
      await onSendOffer({
        action: "send_offer",
        listingIds,
        offerPct,
        offerMessage: message.trim() || undefined,
      });

      // Immediately remove sent items from the queue & update local eligible set
      setSentIds((prev) => {
        const next = new Set(prev);
        for (const id of listingIds) next.add(id);
        return next;
      });
      setEligibleExternalIds((prev) => {
        if (!prev) return prev;
        const next = new Set(prev);
        for (const row of rowsToSend) {
          if (row.external_listing_id) next.delete(row.external_listing_id);
        }
        return next;
      });
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        for (const id of listingIds) next.delete(id);
        return next;
      });
    }
  }

  return (
    <section className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
      <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-bold text-[#14151A]">
                Send-Offer-to-Watchers Queue (Floor-Protected)
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                {eligibleRows.length} eBay-eligible
                {hotRows.length > 0 ? ` · ${hotRows.length} hot (5+)` : ""}
              </span>
              {isLive && (
                <button
                  type="button"
                  disabled={isCheckingEligible}
                  onClick={() => void checkLiveEligibility()}
                  title="Refresh live eBay eligible offers"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#5C606B] hover:text-[#0F766E] cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${isCheckingEligible ? "animate-spin" : ""}`}
                  />
                  <span>{isCheckingEligible ? "Checking…" : "Refresh"}</span>
                </button>
              )}
            </div>
            <p className="text-[11px] text-[#5C606B]">
              {eligibleChecked
                ? "Synced live with eBay Seller Hub eligible buyers — items clear automatically once sent."
                : "Private buyer offers convert 2–3× faster than public markdowns and never drop below your COGS floor."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[#DDE2DF] bg-white p-0.5 text-[11px] font-semibold">
            {[5, 10, 15].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => setOfferPct(pct)}
                className={`px-2.5 py-1 rounded-md cursor-pointer transition ${
                  offerPct === pct
                    ? "bg-[#0F766E] text-white"
                    : "text-[#5C606B] hover:text-[#14151A]"
                }`}
              >
                -{pct}%
              </button>
            ))}
          </div>

          {eligibleRows.length > 1 && (
            <button
              type="button"
              disabled={isBusy || sendingIds.size > 0}
              onClick={() =>
                void fireOffer(
                  hotRows.length > 0 ? hotRows : eligibleRows.slice(0, 20)
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer"
            >
              {isBusy || sendingIds.size > 0 ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>
                {hotRows.length > 0
                  ? `Send -${offerPct}% to All ${hotRows.length} Hot`
                  : `Send -${offerPct}% to All ${Math.min(eligibleRows.length, 20)} Eligible`}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-2.5 border-b border-[#F1F1EC] bg-white flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-[#5C606B]">
          Offer Note:
        </span>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="flex-1 min-w-[240px] px-2.5 py-1 text-xs rounded-md border border-[#E4E4DD] focus:border-[#0F766E] focus:outline-none"
        />
      </div>

      <div className="divide-y divide-[#F1F1EC] max-h-64 overflow-y-auto">
        {eligibleRows.map((row) => {
          const calc = computeClampedPriceDrop(
            row.listed_price,
            row.floor_price,
            offerPct
          );
          const isRowSending = sendingIds.has(row.listing_id);
          const isHot = row.watchers_count >= 5;
          return (
            <div
              key={row.listing_id}
              className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs hover:bg-[#FAFBF9]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                      isHot
                        ? "bg-[#FEF3C7] text-[#B45309] border border-[#FDE68A]"
                        : "bg-[#F2F4F3] text-[#444B52]"
                    }`}
                  >
                    <Eye className="w-3 h-3" />
                    {row.watchers_count}
                  </span>
                  <span className="font-semibold text-[#14151A] truncate">
                    {row.title}
                  </span>
                </div>
                <div className="text-[11px] font-mono text-[#5C606B] mt-0.5">
                  {row.sku} · Ask {fmtMoney(row.listed_price)} → Offer{" "}
                  <strong className="text-[#0F766E]">
                    {fmtMoney(calc.nextPrice)}
                  </strong>{" "}
                  (Floor {fmtMoney(row.floor_price)}
                  {calc.wasClamped ? " · floor-clamped" : ""})
                </div>
              </div>

              <button
                type="button"
                disabled={isBusy || isRowSending}
                onClick={() => void fireOffer([row])}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer bg-white border border-[#DDE2DF] text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50"
              >
                {isRowSending ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Sending…</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3 h-3" />
                    <span>Send {fmtMoney(calc.nextPrice)}</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
