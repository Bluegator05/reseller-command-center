"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Megaphone,
  Package,
  RefreshCcw,
  Sparkles,
  Stethoscope,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import type { RelistSanityCheckResponse } from "@/app/api/ai/relist-check/route";
import type { StaleRadarRow } from "@/lib/types";

export interface RelistFixPayload {
  newPrice?: number;
  newTitle?: string;
  promoteRatePct?: number;
  weightOz?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  addItemSpecifics?: Array<{ name: string; value: string }>;
}

interface RelistSanityModalProps {
  row: StaleRadarRow;
  isRelisting: boolean;
  onClose: () => void;
  onConfirmRelist: (params: RelistFixPayload) => Promise<void>;
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
  const [promoteEnabled, setPromoteEnabled] = useState(false);
  const [promoteRate, setPromoteRate] = useState<number>(4);

  // Live eBay package baseline vs editable weight/dims
  const [baseWeightOz, setBaseWeightOz] = useState<number | null>(
    row.weight_oz ?? null
  );
  const [baseDims, setBaseDims] = useState<{
    l: number | null;
    w: number | null;
    h: number | null;
  }>({
    l: row.length_in ?? null,
    w: row.width_in ?? null,
    h: row.height_in ?? null,
  });
  const [editLbs, setEditLbs] = useState(
    row.weight_oz ? String(Math.floor(row.weight_oz / 16)) : ""
  );
  const [editOz, setEditOz] = useState(
    row.weight_oz ? String(row.weight_oz % 16) : ""
  );
  const [editLen, setEditLen] = useState(row.length_in ? String(row.length_in) : "");
  const [editWid, setEditWid] = useState(row.width_in ? String(row.width_in) : "");
  const [editHgt, setEditHgt] = useState(row.height_in ? String(row.height_in) : "");

  // Toggleable suggested Item Specifics
  const [selectedSpecIndexes, setSelectedSpecIndexes] = useState<Set<number>>(
    new Set()
  );

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
            itemId: row.item_id,
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
            lengthIn: row.length_in,
            widthIn: row.width_in,
            heightIn: row.height_in,
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
          // Pre-check Promote if the audit recommends it (e.g. 0% promoted on 30+d listing)
          if (data.recommendPromote) {
            setPromoteEnabled(true);
            setPromoteRate(data.recommendedPromoteRate || 4);
          }
          // Pre-fill real live eBay weight & dimensions
          if (data.liveWeightOz) {
            setBaseWeightOz(data.liveWeightOz);
            setEditLbs(String(Math.floor(data.liveWeightOz / 16)));
            setEditOz(String(data.liveWeightOz % 16));
          }
          if (data.liveLengthIn || data.liveWidthIn || data.liveHeightIn) {
            setBaseDims({
              l: data.liveLengthIn,
              w: data.liveWidthIn,
              h: data.liveHeightIn,
            });
            if (data.liveLengthIn) setEditLen(String(data.liveLengthIn));
            if (data.liveWidthIn) setEditWid(String(data.liveWidthIn));
            if (data.liveHeightIn) setEditHgt(String(data.liveHeightIn));
          }
          // Pre-select suggested missing Item Specifics if eBay specifics were sparse (< 8)
          if (
            Array.isArray(data.suggestedSpecifics) &&
            data.suggestedSpecifics.length > 0 &&
            data.specificsCount < 8
          ) {
            setSelectedSpecIndexes(
              new Set(data.suggestedSpecifics.map((_, i) => i))
            );
          }
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

  const totalEditOz =
    (editLbs !== "" || editOz !== "")
      ? Math.max(0, (Number(editLbs) || 0) * 16 + (Number(editOz) || 0))
      : null;
  const parsedLen = editLen ? Number(editLen) : null;
  const parsedWid = editWid ? Number(editWid) : null;
  const parsedHgt = editHgt ? Number(editHgt) : null;

  const weightChanged =
    totalEditOz !== null &&
    totalEditOz > 0 &&
    (baseWeightOz === null || Math.abs(totalEditOz - baseWeightOz) >= 1);
  const dimsChanged =
    Boolean(parsedLen && parsedWid && parsedHgt) &&
    (parsedLen !== baseDims.l ||
      parsedWid !== baseDims.w ||
      parsedHgt !== baseDims.h);

  const chosenSpecs = (report?.suggestedSpecifics || []).filter((_, idx) =>
    selectedSpecIndexes.has(idx)
  );

  const fixSummaryParts: string[] = [];
  if (titleChanged) fixSummaryParts.push("New Title");
  if (priceChanged) fixSummaryParts.push(`Price $${parsedPrice.toFixed(2)}`);
  if (promoteEnabled) fixSummaryParts.push(`Promote ${promoteRate}%`);
  if (chosenSpecs.length > 0) fixSummaryParts.push(`+${chosenSpecs.length} Specifics`);
  if (weightChanged || dimsChanged) fixSummaryParts.push("Updated Pkg Weight/Dims");

  const fixCount = fixSummaryParts.length;

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
                  Ask{" "}
                  <strong className="text-[#14151A]">
                    ${row.listed_price.toFixed(2)}
                  </strong>
                </span>
                <span>·</span>
                <span>
                  {report?.liveShippingProfileName ||
                    (row.shipping_price > 0
                      ? `Ship $${row.shipping_price.toFixed(2)}`
                      : "Calculated Ship")}
                </span>
                {baseWeightOz && (
                  <>
                    <span>·</span>
                    <span>
                      {baseWeightOz >= 16
                        ? `${Math.floor(baseWeightOz / 16)}lb ${baseWeightOz % 16}oz`
                        : `${baseWeightOz}oz`}
                    </span>
                  </>
                )}
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
                Auditing live eBay weight, pricing, title SEO &amp; traffic signals…
              </p>
              <p className="text-[11px] text-[#5C606B]">
                Checking why this sat for {row.days_listed} days before relisting.
              </p>
            </div>
          ) : error ? (
            <div className="p-3.5 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C]">
              {error} — you can still apply fixes below or relist as-is.
            </div>
          ) : report ? (
            <>
              {/* Verdict Banner */}
              <div
                className={`p-3.5 rounded-xl border ${verdictConfig.bg} space-y-2`}
              >
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
                <p
                  className={`text-xs font-medium leading-relaxed ${verdictConfig.text}`}
                >
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

          {/* 1-Click Fix Workbench (All Agreed Fixes Apply Together on Sell Similar!) */}
          <div className="p-4 rounded-xl border border-[#DDE2DF] bg-[#FAFBF9] space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#444B52]">
                Fixes to Apply When Relisting
              </span>
              {fixCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0] text-[10px] font-semibold">
                  {fixSummaryParts.join(" · ")}
                </span>
              )}
            </div>

            {/* 1. Title Upgrade */}
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

            {/* 2. Price Adjustment */}
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

            {/* 3. Promote Immediately on Relist */}
            <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-white border border-[#E4E4DD]">
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-[#14151A] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={promoteEnabled}
                  onChange={(e) => setPromoteEnabled(e.target.checked)}
                  className="w-4 h-4 accent-[#0F766E]"
                />
                <Megaphone className="w-3.5 h-3.5 text-[#D97706]" />
                <span>Promote new listing immediately on eBay</span>
                {report?.recommendPromote && (
                  <span className="px-1.5 py-0.5 rounded bg-[#FEF3C7] text-[#92400E] text-[9px] font-bold uppercase">
                    Recommended
                  </span>
                )}
              </label>

              {promoteEnabled && (
                <div className="inline-flex items-center gap-1">
                  {[2, 4, 5, 6].map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setPromoteRate(r)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border transition cursor-pointer ${
                        promoteRate === r
                          ? "bg-[#0F766E] border-[#0F766E] text-white"
                          : "bg-[#FAFBF9] border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E]"
                      }`}
                    >
                      {r}%
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 4. Add Missing Item Specifics (Toggleable Chips) */}
            {report && report.suggestedSpecifics.length > 0 && (
              <div className="p-2.5 rounded-lg bg-white border border-[#E4E4DD] space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-[#14151A] inline-flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-[#0F766E]" />
                    Add Missing Item Specifics (merged safely with existing)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        selectedSpecIndexes.size ===
                        report.suggestedSpecifics.length
                      ) {
                        setSelectedSpecIndexes(new Set());
                      } else {
                        setSelectedSpecIndexes(
                          new Set(report.suggestedSpecifics.map((_, i) => i))
                        );
                      }
                    }}
                    className="text-[10px] font-semibold text-[#0F766E] hover:underline cursor-pointer"
                  >
                    {selectedSpecIndexes.size ===
                    report.suggestedSpecifics.length
                      ? "Uncheck all"
                      : "Check all"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {report.suggestedSpecifics.map((spec, idx) => {
                    const checked = selectedSpecIndexes.has(idx);
                    return (
                      <button
                        key={`${spec.name}-${idx}`}
                        type="button"
                        onClick={() =>
                          setSelectedSpecIndexes((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          })
                        }
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border transition cursor-pointer ${
                          checked
                            ? "bg-[#ECFDF5] border-[#0F766E] text-[#065F46] font-semibold"
                            : "bg-[#FAFBF9] border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E]"
                        }`}
                      >
                        <span>{checked ? "☑" : "☐"}</span>
                        <span>
                          <strong>{spec.name}:</strong> {spec.value}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 5. Package Weight & Dimensions (Live from eBay, editable if needed) */}
            <div className="p-2.5 rounded-lg bg-white border border-[#E4E4DD] flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#14151A]">
                <Package className="w-3.5 h-3.5 text-[#5C606B]" />
                <span>Package Weight &amp; Dims</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <div className="inline-flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    value={editLbs}
                    onChange={(e) => setEditLbs(e.target.value)}
                    placeholder="0"
                    className="w-12 px-1.5 py-1 text-xs font-mono rounded border border-[#DDE2DF] text-center"
                  />
                  <span className="text-[#5C606B]">lb</span>
                  <input
                    type="number"
                    min="0"
                    max="15"
                    value={editOz}
                    onChange={(e) => setEditOz(e.target.value)}
                    placeholder="14"
                    className="w-12 px-1.5 py-1 text-xs font-mono rounded border border-[#DDE2DF] text-center"
                  />
                  <span className="text-[#5C606B]">oz</span>
                </div>
                <span className="text-[#CBD5E1]">|</span>
                <div className="inline-flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    value={editLen}
                    onChange={(e) => setEditLen(e.target.value)}
                    placeholder="L"
                    className="w-12 px-1.5 py-1 text-xs font-mono rounded border border-[#DDE2DF] text-center"
                  />
                  <span className="text-[#5C606B]">×</span>
                  <input
                    type="number"
                    min="1"
                    value={editWid}
                    onChange={(e) => setEditWid(e.target.value)}
                    placeholder="W"
                    className="w-12 px-1.5 py-1 text-xs font-mono rounded border border-[#DDE2DF] text-center"
                  />
                  <span className="text-[#5C606B]">×</span>
                  <input
                    type="number"
                    min="1"
                    value={editHgt}
                    onChange={(e) => setEditHgt(e.target.value)}
                    placeholder="H"
                    className="w-12 px-1.5 py-1 text-xs font-mono rounded border border-[#DDE2DF] text-center"
                  />
                  <span className="text-[#5C606B]">in</span>
                </div>
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
                  promoteRatePct: promoteEnabled ? promoteRate : undefined,
                  weightOz:
                    (weightChanged || dimsChanged) && totalEditOz
                      ? totalEditOz
                      : undefined,
                  lengthIn:
                    (weightChanged || dimsChanged) && parsedLen
                      ? parsedLen
                      : undefined,
                  widthIn:
                    (weightChanged || dimsChanged) && parsedWid
                      ? parsedWid
                      : undefined,
                  heightIn:
                    (weightChanged || dimsChanged) && parsedHgt
                      ? parsedHgt
                      : undefined,
                  addItemSpecifics:
                    chosenSpecs.length > 0 ? chosenSpecs : undefined,
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
                  ? "Applying Fixes & Relisting…"
                  : fixCount > 0
                    ? `Apply ${fixCount} Fix${fixCount === 1 ? "" : "es"} & Sell Similar`
                    : "Confirm & Sell Similar"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
