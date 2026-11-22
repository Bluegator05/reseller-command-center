"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { computeClampedPriceDrop } from "@/lib/stale-engine";
import type { EbayActionRequest, StaleRadarRow } from "@/lib/types";

interface WatcherOffersPanelProps {
  eligibleRows: StaleRadarRow[];
  passedCount: number;
  isLive: boolean;
  isCheckingEligible: boolean;
  eligibleChecked: boolean;
  isBusy: boolean;
  onRefreshEligible: () => Promise<void>;
  onSendOffer: (req: EbayActionRequest) => Promise<void>;
  onMarkSent: (rows: StaleRadarRow[]) => void;
  onPassOffer: (row: StaleRadarRow) => void;
  onRestorePassedOffers: () => void;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function WatcherOffersPanel({
  eligibleRows,
  passedCount,
  isLive,
  isCheckingEligible,
  eligibleChecked,
  isBusy,
  onRefreshEligible,
  onSendOffer,
  onMarkSent,
  onPassOffer,
  onRestorePassedOffers,
}: WatcherOffersPanelProps) {
  const [offerPct, setOfferPct] = useState<number>(10);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState(
    "Thanks for watching! Here is a private discount — ships fast within 1 business day."
  );
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligibleRows;
    return eligibleRows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.sku.toLowerCase().includes(q) ||
        (r.bin_location || "").toLowerCase().includes(q)
    );
  }, [eligibleRows, search]);

  const hotRows = useMemo(
    () => filteredRows.filter((r) => r.watchers_count >= 5),
    [filteredRows]
  );

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
      onMarkSent(rowsToSend);
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        for (const id of listingIds) next.delete(id);
        return next;
      });
    }
  }

  return (
    <section className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_3px_rgba(20,21,26,0.04)]">
      {/* Header */}
      <div className="px-4 sm:px-5 py-4 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-[#14151A]">
                Send Offers to Watchers (Floor-Protected)
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                {eligibleRows.length} eBay-eligible
                {hotRows.length > 0 ? ` · ${hotRows.length} hot (5+)` : ""}
              </span>
            </div>
            <p className="text-xs text-[#5C606B] mt-0.5">
              {eligibleChecked
                ? "Synced live with eBay Seller Hub eligible buyers — items clear automatically once sent."
                : "Private buyer offers convert 2–3× faster than public markdowns and never drop below your COGS floor."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {passedCount > 0 && (
            <button
              type="button"
              onClick={onRestorePassedOffers}
              title="Bring back offers you previously passed on"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E4E4DD] bg-white text-xs font-medium text-[#5C606B] hover:text-[#14151A] hover:border-[#0F766E] transition cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Restore {passedCount} passed</span>
            </button>
          )}

          {isLive && (
            <button
              type="button"
              disabled={isCheckingEligible}
              onClick={() => void onRefreshEligible()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#5C606B] hover:text-[#14151A] hover:border-[#0F766E] transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isCheckingEligible ? "animate-spin" : ""}`}
              />
              <span>{isCheckingEligible ? "Checking eBay…" : "Refresh Eligible"}</span>
            </button>
          )}

          <div className="inline-flex rounded-lg border border-[#DDE2DF] bg-white p-0.5 text-xs font-semibold">
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

          {filteredRows.length > 0 && (
            <button
              type="button"
              disabled={isBusy || sendingIds.size > 0}
              onClick={() =>
                void fireOffer(
                  hotRows.length > 0 ? hotRows : filteredRows.slice(0, 20)
                )
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer shadow-xs"
            >
              {isBusy || sendingIds.size > 0 ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>
                {hotRows.length > 0
                  ? `Send -${offerPct}% to All ${hotRows.length} Hot`
                  : `Send -${offerPct}% to All ${Math.min(filteredRows.length, 20)} Eligible`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Controls: Offer Note + Quick Search */}
      <div className="px-4 sm:px-5 py-3 border-b border-[#F1F1EC] bg-white flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[260px]">
          <span className="text-xs font-semibold text-[#5C606B] whitespace-nowrap">
            Offer Note:
          </span>
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-[#E4E4DD] focus:border-[#0F766E] focus:outline-none"
          />
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="w-3.5 h-3.5 text-[#8E969D] absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter SKU or title…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#E4E4DD] focus:border-[#0F766E] focus:outline-none"
          />
        </div>
      </div>

      {/* Eligible Offers List or All Caught Up */}
      {filteredRows.length === 0 ? (
        <div className="px-6 py-14 text-center space-y-2">
          <div className="w-11 h-11 rounded-full bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0] flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <p className="text-sm font-semibold text-[#14151A]">
            {search.trim()
              ? "No eligible offers match your search"
              : "All caught up on Watcher Offers!"}
          </p>
          <p className="text-xs text-[#5C606B] max-w-md mx-auto">
            {search.trim()
              ? "Clear the search filter to see all remaining eligible listings."
              : "Every eBay listing with eligible interested buyers has already received an offer. Click Refresh Eligible later to check for new watchers."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[#F1F1EC]">
          {filteredRows.map((row) => {
            const calc = computeClampedPriceDrop(
              row.listed_price,
              row.floor_price,
              offerPct
            );
            const isRowSending = sendingIds.has(row.listing_id);
            const isHot = row.watchers_count >= 5;
            const thumb = row.image_urls?.[0];
            return (
              <div
                key={row.listing_id}
                className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-[#FAFBF9] transition"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt={row.title}
                      className="w-11 h-11 rounded-lg object-cover border border-[#E4E4DD] shrink-0 bg-[#F7F9F8]"
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-lg border border-[#E4E4DD] bg-[#F7F9F8] shrink-0 flex items-center justify-center text-[#8E969D]">
                      <Sparkles className="w-4 h-4" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] font-bold shrink-0 ${
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
                    <div className="text-[11px] font-mono text-[#5C606B] mt-0.5 flex flex-wrap items-center gap-x-2">
                      <span>{row.sku}</span>
                      <span>·</span>
                      <span>
                        Ask {fmtMoney(row.listed_price)} → Offer{" "}
                        <strong className="text-[#0F766E]">
                          {fmtMoney(calc.nextPrice)}
                        </strong>
                      </span>
                      <span>·</span>
                      <span>
                        Floor {fmtMoney(row.floor_price)}
                        {calc.wasClamped ? " (floor-clamped)" : ""}
                      </span>
                      <span>·</span>
                      <span>{row.days_listed}d listed</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isBusy || isRowSending}
                    onClick={() => onPassOffer(row)}
                    title="Pass on sending an offer and remove from this list"
                    className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-semibold transition cursor-pointer bg-white border border-[#E4E4DD] text-[#5C606B] hover:border-[#B91C1C] hover:bg-[#FEF2F2] hover:text-[#B91C1C] disabled:opacity-50"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Pass</span>
                  </button>

                  <button
                    type="button"
                    disabled={isBusy || isRowSending}
                    onClick={() => void fireOffer([row])}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition cursor-pointer bg-white border border-[#DDE2DF] text-[#14151A] hover:border-[#0F766E] hover:bg-[#ECFDF5] hover:text-[#0F766E] disabled:opacity-50"
                  >
                    {isRowSending ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Sending…</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Send {fmtMoney(calc.nextPrice)}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
