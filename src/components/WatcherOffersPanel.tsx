"use client";

import { useMemo, useState } from "react";
import { Eye, Loader2, Send, ShieldCheck, Sparkles } from "lucide-react";
import { computeClampedPriceDrop } from "@/lib/stale-engine";
import type { EbayActionRequest, StaleRadarRow } from "@/lib/types";

interface WatcherOffersPanelProps {
  items: StaleRadarRow[];
  isBusy: boolean;
  onSendOffer: (req: EbayActionRequest) => Promise<void>;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function WatcherOffersPanel({
  items,
  isBusy,
  onSendOffer,
}: WatcherOffersPanelProps) {
  const [offerPct, setOfferPct] = useState<number>(10);
  const [message, setMessage] = useState(
    "Thanks for watching! Here is a private discount — ships fast within 1 business day."
  );
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());

  const watchedRows = useMemo(() => {
    return items
      .filter((i) => i.watchers_count > 0 && !i.is_at_floor)
      .sort((a, b) => b.watchers_count - a.watchers_count);
  }, [items]);

  const hotRows = useMemo(
    () => watchedRows.filter((r) => r.watchers_count >= 5),
    [watchedRows]
  );

  if (watchedRows.length === 0) return null;

  async function fireOffer(listingIds: string[]) {
    if (listingIds.length === 0) return;
    await onSendOffer({
      action: "send_offer",
      listingIds,
      offerPct,
      offerMessage: message.trim() || undefined,
    });
    setSentIds((prev) => {
      const next = new Set(prev);
      for (const id of listingIds) next.add(id);
      return next;
    });
  }

  return (
    <section className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
      <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-bold text-[#14151A]">
                Send-Offer-to-Watchers Queue (Floor-Protected)
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                {hotRows.length} hot (5+ watchers) · {watchedRows.length} eligible
              </span>
            </div>
            <p className="text-[11px] text-[#5C606B]">
              Private buyer offers convert 2–3× faster than public markdowns and
              never drop below your COGS floor.
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

          {hotRows.length > 0 && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => fireOffer(hotRows.map((r) => r.listing_id))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer"
            >
              {isBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>
                Send -{offerPct}% to All {hotRows.length} Hot Listings
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

      <div className="divide-y divide-[#F1F1EC] max-h-60 overflow-y-auto">
        {watchedRows.slice(0, 8).map((row) => {
          const calc = computeClampedPriceDrop(
            row.listed_price,
            row.floor_price,
            offerPct
          );
          const alreadySent = sentIds.has(row.listing_id);
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
                disabled={isBusy}
                onClick={() => fireOffer([row.listing_id])}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  alreadySent
                    ? "bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0]"
                    : "bg-white border border-[#DDE2DF] text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E]"
                }`}
              >
                {alreadySent ? (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Offer Sent ✓</span>
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
