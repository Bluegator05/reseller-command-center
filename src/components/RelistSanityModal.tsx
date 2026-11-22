"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCcw,
  Sparkles,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";
import type { RelistSanityCheckResponse } from "@/app/api/ai/relist-check/route";
import type { StaleRadarRow } from "@/lib/types";

interface RelistSanityModalProps {
  row: StaleRadarRow;
  isRelisting: boolean;
  onClose: () => void;
  onConfirmRelist: (params: {
    newPrice?: number;
    newTitle?: string;
  }) => Promise<void>;
  onSwitchToDonate?: (row: StaleRadarRow) => void;
}

export function RelistSanityModal({
  row,
  isRelisting,
  onClose,
  onConfirmRelist,
  onSwitchToDonate,
}: RelistSanityModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RelistSanityCheckResponse | null>(null);

  const [editTitle, setEditTitle] = useState(row.title);
  const [editPrice, setEditPrice] = useState(row.listed_price.toFixed(2));

  useEffect(() => {
    let cancelled = false;
    async function runAudit() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/ai/relist-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sku: row.sku,
            title: row.title,
            brand: row.brand,
            condition: row.condition,
            categoryHint: row.category_hint,
            listedPrice: row.listed_price,
            shippingPrice: row.shipping_price,
            floorPrice: row.floor_price,
            cogs: row.total_cost_basis,
            daysListed: row.days_listed,
            viewsCount: row.views_count,
            watchersCount: row.watchers_count,
            promotedAdRatePct: row.promoted_ad_rate_pct,
            relistCount: row.relist_count,
            weightOz: row.weight_oz,
            imageUrls: row.image_urls,
            externalListingId: row.external_listing_id,
          }),
        });
        const data = (await res.json()) as RelistSanityCheckResponse & {
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || "Sanity check failed");
        }
        if (!cancelled) {
          setReport(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not run sanity check"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void runAudit();
    return () => {
      cancelled = true;
    };
  }, [row]);

  const parsedPrice = Number(editPrice);
  const priceChanged =
    Number.isFinite(parsedPrice) &&
    parsedPrice > 0 &&
    Math.abs(parsedPrice - row.listed_price) > 0.005;
  const titleChanged =
    editTitle.trim().length >= 3 && editTitle.trim() !== row.title.trim();

  const verdictConfig =
    report?.verdict === "consider_donate"
      ? {
          bg: "bg-[#FEF2F2] border-[#FECACA]",
          text: "text-[#991B1B]",
          pill: "bg-[#B91C1C] text-white",
          label: "Consider Liquidating or Donating",
        }
      : report?.verdict === "fix_first"
        ? {
            bg: "bg-[#FFFBEB] border-[#FDE68A]",
            text: "text-[#92400E]",
            pill: "bg-[#D97706] text-white",
            label: "Fix Before Relisting",
          }
        : {
            bg: "bg-[#ECFDF5] border-[#A7F3D0]",
            text: "text-[#065F46]",
            pill: "bg-[#0F766E] text-white",
            label: "Looks Solid — Safe to Relist",
          };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-3 sm:p-5"
      onClick={() => {
        if (!isRelisting) onClose();
      }}
    >
      <div
        className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[#ECEFE9] bg-[#FAFBF9] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E] flex items-center justify-center shrink-0">
              <Stethoscope className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-[#14151A]">
                Pre-Relist Sanity Check
              </h3>
              <p className="text-[11px] font-mono text-[#5C606B] truncate">
                {row.sku} · {row.days_listed}d · {row.views_count} views ·{" "}
                {row.watchers_count} watchers · {row.relist_count}× relisted
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isRelisting}
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#5C606B] hover:bg-[#EDF1EE] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {/* Item Snapshot Strip */}
          <div className="flex items-center gap-3 p-3 rounded-xl bg-[#FAF9F6] border border-[#ECECE6]">
            {row.image_urls?.[0] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={row.image_urls[0]}
                alt={row.title}
                className="w-12 h-12 rounded-lg object-cover border border-[#E4E4DD] bg-white shrink-0"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-[#14151A] line-clamp-1">
                {row.title}
              </div>
              <div className="text-[11px] font-mono text-[#5C606B] mt-0.5 flex flex-wrap items-center gap-x-2">
                <span>
                  Ask <strong className="text-[#14151A]">${row.listed_price.toFixed(2)}</strong>
                </span>
                <span>·</span>
                <span>
                  Ship{" "}
                  <strong className="text-[#14151A]">
                    {row.shipping_price > 0
                      ? `$${row.shipping_price.toFixed(2)}`
                      : "Calculated"}
                  </strong>
                </span>
                <span>·</span>
                <span>COGS ${row.total_cost_basis.toFixed(2)}</span>
                <span>·</span>
                <span>Floor ${row.floor_price.toFixed(2)}</span>
              </div>
            </div>
            {row.external_url && (
              <a
                href={row.external_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] shrink-0"
              >
                eBay
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>

          {loading ? (
            <div className="py-10 text-center space-y-2">
              <Loader2 className="w-6 h-6 animate-spin text-[#0F766E] mx-auto" />
              <p className="text-xs font-semibold text-[#14151A]">
                Auditing pricing, title SEO, shipping &amp; traffic signals…
              </p>
              <p className="text-[11px] text-[#5C606B]">
                Checking why this sat for {row.days_listed} days before relisting.
              </p>
            </div>
          ) : error ? (
            <div className="p-3.5 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C]">
              {error} — you can still edit the title/price below or relist as-is.
            </div>
          ) : report ? (
            <>
              {/* Verdict Banner */}
              <div className={`p-3.5 rounded-xl border ${verdictConfig.bg} space-y-2`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ${verdictConfig.pill}`}
                  >
                    {verdictConfig.label}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <a
                      href={report.ebaySoldUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-[#DDE2DF] text-[11px] font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E]"
                    >
                      eBay Sold Comps
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                      href={report.ebayActiveUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-[#DDE2DF] text-[11px] font-semibold text-[#5C606B] hover:border-[#0F766E] hover:text-[#0F766E]"
                    >
                      Active Competing
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
                <p className={`text-xs font-medium leading-relaxed ${verdictConfig.text}`}>
                  {report.primaryDiagnosis}
                </p>
              </div>

              {/* 6-Point Diagnostic Checklist */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {report.checks.map((c, idx) => (
                  <div
                    key={`${c.area}-${idx}`}
                    className={`p-2.5 rounded-xl border text-xs space-y-1 ${
                      c.status === "fix"
                        ? "bg-[#FEF2F2]/60 border-[#FECACA]"
                        : c.status === "warn"
                          ? "bg-[#FFFBEB]/70 border-[#FDE68A]"
                          : "bg-[#FAFBF9] border-[#E4E4DD]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="font-bold text-[#14151A] flex items-center gap-1">
                        {c.status === "ok" ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-[#0F766E]" />
                        ) : (
                          <AlertTriangle
                            className={`w-3.5 h-3.5 ${
                              c.status === "fix"
                                ? "text-[#B91C1C]"
                                : "text-[#D97706]"
                            }`}
                          />
                        )}
                        {c.area}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                          c.status === "fix"
                            ? "bg-[#FEE2E2] text-[#B91C1C]"
                            : c.status === "warn"
                              ? "bg-[#FEF3C7] text-[#92400E]"
                              : "bg-[#ECFDF5] text-[#0F766E]"
                        }`}
                      >
                        {c.status === "fix"
                          ? "Fix"
                          : c.status === "warn"
                            ? "Check"
                            : "Good"}
                      </span>
                    </div>
                    <p className="text-[11px] text-[#374151] leading-snug">
                      {c.finding}
                    </p>
                    <p className="text-[11px] text-[#5C606B] leading-snug">
                      → {c.suggestion}
                    </p>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* Quick Fix Before Relisting Editor */}
          <div className="p-3.5 rounded-xl border border-[#DDE2DF] bg-[#FAFBF9] space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#444B52]">
              Fix Title or Price During Sell Similar (Optional)
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
                <label className="text-[11px] font-semibold text-[#444B52]">
                  Relist Title ({editTitle.length}/80)
                </label>
                {report &&
                  report.suggestedTitle &&
                  report.suggestedTitle.trim() !== editTitle.trim() && (
                    <button
                      type="button"
                      onClick={() => setEditTitle(report.suggestedTitle)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#ECFDF5] border border-[#A7F3D0] text-[10px] font-semibold text-[#0F766E] hover:bg-[#D1FAE5] cursor-pointer"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      Use AI Title
                    </button>
                  )}
              </div>
              <input
                type="text"
                maxLength={80}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32">
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Relist Price ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.99"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs font-mono font-bold rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditPrice(row.listed_price.toFixed(2))}
                  className="px-2 py-1.5 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-mono text-[#5C606B] hover:border-[#0F766E] cursor-pointer"
                >
                  Keep ${row.listed_price.toFixed(2)}
                </button>
                {report && (
                  <button
                    type="button"
                    onClick={() => setEditPrice(report.suggestedPrice.toFixed(2))}
                    className="px-2 py-1.5 rounded-md border border-[#A7F3D0] bg-[#ECFDF5] text-[11px] font-mono font-semibold text-[#0F766E] hover:bg-[#D1FAE5] cursor-pointer"
                  >
                    AI ${report.suggestedPrice.toFixed(2)}
                  </button>
                )}
                {!row.is_at_floor && (
                  <button
                    type="button"
                    onClick={() =>
                      setEditPrice(row.projected_drop_price.toFixed(2))
                    }
                    className="px-2 py-1.5 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-mono text-[#14151A] hover:border-[#0F766E] cursor-pointer"
                  >
                    -10% (${row.projected_drop_price.toFixed(2)})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditPrice(row.floor_price.toFixed(2))}
                  className="px-2 py-1.5 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-mono text-[#5C606B] hover:border-[#0F766E] cursor-pointer"
                >
                  Floor ${row.floor_price.toFixed(2)}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-[#ECEFE9] bg-[#FAFBF9] flex flex-wrap items-center justify-between gap-2">
          <div>
            {onSwitchToDonate && (
              <button
                type="button"
                disabled={isRelisting}
                onClick={() => {
                  onClose();
                  onSwitchToDonate(row);
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#FECACA] bg-[#FEF2F2] text-xs font-semibold text-[#B91C1C] hover:bg-[#FEE2E2] cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Donate / Toss Instead
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isRelisting}
              onClick={() => onConfirmRelist({})}
              className="px-3 py-1.5 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#5C606B] hover:text-[#14151A] hover:border-[#0F766E] cursor-pointer disabled:opacity-50"
            >
              Relist As-Is
            </button>
            <button
              type="button"
              disabled={isRelisting}
              onClick={() =>
                onConfirmRelist({
                  newPrice: priceChanged ? parsedPrice : undefined,
                  newTitle: titleChanged ? editTitle.trim() : undefined,
                })
              }
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-bold hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {isRelisting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCcw className="w-3.5 h-3.5" />
              )}
              <span>
                {isRelisting
                  ? "Relisting on eBay…"
                  : priceChanged || titleChanged
                    ? "Apply Fixes & Sell Similar"
                    : "Confirm & Sell Similar"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
