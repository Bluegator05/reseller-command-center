"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Plus,
  Puzzle,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  Truck,
  X,
} from "lucide-react";
import { estimateShippingRates } from "@/lib/shipping";
import type {
  CrossListDraftPayload,
  EtsyCrossListResult,
  MarketplaceType,
  StaleRadarRow,
} from "@/lib/types";

type CrossListTarget = Exclude<MarketplaceType, "ebay">;

interface CrossListDrawerProps {
  row: StaleRadarRow | null;
  initialTarget?: CrossListTarget;
  onClose: () => void;
  onPublishedEtsy: (result: EtsyCrossListResult) => Promise<void>;
  onQueuedExtension: (params: {
    marketplace: CrossListTarget;
    sku: string;
    price: number;
    launchedLocally?: boolean;
  }) => Promise<void>;
  onUnlinked?: (marketplace: CrossListTarget) => Promise<void>;
}

const TARGET_CHANNELS: Array<{
  key: CrossListTarget;
  label: string;
  mode: "API" | "Ext";
  feeNote: string;
}> = [
  { key: "etsy", label: "Etsy", mode: "API", feeNote: "9.5% fee · +5%" },
  {
    key: "poshmark",
    label: "Poshmark",
    mode: "Ext",
    feeNote: "20% fee · +12%",
  },
  { key: "mercari", label: "Mercari", mode: "Ext", feeNote: "10% fee · +5%" },
  {
    key: "facebook",
    label: "FB Marketplace",
    mode: "Ext",
    feeNote: "5% fee · Confirm gate",
  },
];

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function CrossListDrawer({
  row,
  initialTarget = "etsy",
  onClose,
  onPublishedEtsy,
  onQueuedExtension,
  onUnlinked,
}: CrossListDrawerProps) {
  const [overrideTarget, setOverrideTarget] = useState<{
    key: string;
    target: CrossListTarget;
  } | null>(null);

  if (!row) return null;

  const instanceKey = `${row.item_id}:${initialTarget}`;
  const activeTarget =
    overrideTarget && overrideTarget.key === instanceKey
      ? overrideTarget.target
      : initialTarget;

  return (
    <CrossListDrawerInner
      key={`${row.item_id}-${activeTarget}`}
      row={row}
      target={activeTarget}
      onChangeTarget={(next) =>
        setOverrideTarget({ key: instanceKey, target: next })
      }
      onClose={onClose}
      onPublishedEtsy={onPublishedEtsy}
      onQueuedExtension={onQueuedExtension}
      onUnlinked={onUnlinked}
    />
  );
}

function CrossListDrawerInner({
  row,
  target,
  onChangeTarget,
  onClose,
  onPublishedEtsy,
  onQueuedExtension,
  onUnlinked,
}: {
  row: StaleRadarRow;
  target: CrossListTarget;
  onChangeTarget: (next: CrossListTarget) => void;
  onClose: () => void;
  onPublishedEtsy: (result: EtsyCrossListResult) => Promise<void>;
  onQueuedExtension: (params: {
    marketplace: CrossListTarget;
    sku: string;
    price: number;
    launchedLocally?: boolean;
  }) => Promise<void>;
  onUnlinked?: (marketplace: CrossListTarget) => Promise<void>;
}) {
  const [isLoadingMap, setIsLoadingMap] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CrossListDraftPayload | null>(null);
  const [localExtensionReady, setLocalExtensionReady] = useState(
    () =>
      typeof document !== "undefined" &&
      Boolean(document.documentElement.dataset.rccExtensionVersion)
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [whenMade, setWhenMade] = useState("1990_1999");
  const [isSupply, setIsSupply] = useState(false);
  const [department, setDepartment] = useState("");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [conditionLabel, setConditionLabel] = useState("");
  const [sizeLabel, setSizeLabel] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState("");
  const [publishImmediately, setPublishImmediately] = useState(true);
  const [overrideCompliance, setOverrideCompliance] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleMsg = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.type === "RCC_EXTENSION_READY") {
        setLocalExtensionReady(true);
      }
    };
    window.addEventListener("message", handleMsg);
    window.postMessage({ type: "RCC_PING_EXTENSION" }, window.location.origin);
    return () => window.removeEventListener("message", handleMsg);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadMap() {
      try {
        const res = await fetch("/api/ai/map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: row.item_id,
            targetMarketplace: target,
          }),
        });
        const data = (await res.json()) as CrossListDraftPayload & {
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || `Failed to map listing for ${target}`);
        }
        if (cancelled) return;
        setDraft(data);
        setTitle(data.mappedTitle);
        setDescription(data.descriptionPlain);
        setPriceStr(data.pricing.suggestedPrice.toFixed(2));
        setWhenMade(data.whenMade);
        setIsSupply(Boolean(data.isSupply));
        setDepartment(data.structuredCategory?.department || "");
        setCategory(data.structuredCategory?.category || "");
        setSubcategory(data.structuredCategory?.subcategory || "");
        setConditionLabel(data.structuredCategory?.conditionLabel || "");
        setSizeLabel(data.structuredCategory?.sizeLabel || "");
        setTags(data.tags);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Mapping failed");
        }
      } finally {
        if (!cancelled) setIsLoadingMap(false);
      }
    }

    loadMap();
    return () => {
      cancelled = true;
    };
  }, [row.item_id, target]);

  const isEtsy = target === "etsy";
  const maxTitleLen = draft?.maxTitleLength ?? (isEtsy ? 140 : 80);
  const maxDescLen =
    draft?.maxDescriptionLength ??
    (target === "mercari" ? 1000 : target === "poshmark" ? 1500 : 5000);
  const parsedPrice = Number(priceStr) || 0;
  const isBelowFloor = parsedPrice < row.floor_price - 0.005;
  const targetFeePct = draft?.pricing.targetFeePct ?? 9.5;
  const estTargetFee = round2(parsedPrice * (targetFeePct / 100));
  const estTargetNet = round2(parsedPrice - estTargetFee - row.cogs);
  const netDelta = round2(estTargetNet - row.est_net_profit);

  // Re-evaluate Etsy eligibility live if user toggles Craft Supply or Vintage era
  const isEtsyVintageOrSupply =
    isSupply ||
    ["before_1970", "1970s", "1980s", "1990_1999", "2000_2006"].includes(
      whenMade
    );
  const complianceIssues = (draft?.compliance?.issues ?? []).filter((issue) => {
    if (
      isEtsy &&
      isEtsyVintageOrSupply &&
      issue.code === "ETSY_RESALE_PROHIBITED"
    ) {
      return false;
    }
    return true;
  });
  const isComplianceBlocked = complianceIssues.some(
    (i) => i.severity === "block"
  );
  const existingListingOnTarget = row.cross_listings.find(
    (c) => c.marketplace === target
  );
  const isAlreadyLiveOnTarget = Boolean(existingListingOnTarget);
  const effectiveBlocked = isComplianceBlocked && !overrideCompliance;
  const hasComplianceWarning =
    !isComplianceBlocked &&
    complianceIssues.some((i) => i.severity === "warning");

  const handleAddTag = () => {
    const cleaned = newTagInput
      .replace(/[^a-zA-Z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
    if (!cleaned || tags.length >= 13) return;
    if (tags.some((t) => t.toLowerCase() === cleaned.toLowerCase())) return;
    setTags([...tags, cleaned]);
    setNewTagInput("");
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t !== tagToRemove));
  };

  const handleSubmit = async () => {
    if (!draft || isBelowFloor || effectiveBlocked || isAlreadyLiveOnTarget) return;
    setIsSubmitting(true);
    setError(null);

    const updatedStructuredCategory = {
      department: department.trim() || null,
      category: category.trim() || draft.structuredCategory?.category || "Other",
      subcategory: subcategory.trim() || null,
      conditionLabel:
        conditionLabel.trim() ||
        draft.structuredCategory?.conditionLabel ||
        row.condition,
      sizeLabel: sizeLabel.trim() || null,
    };
    const updatedBreadcrumb = [
      updatedStructuredCategory.department,
      updatedStructuredCategory.category,
      updatedStructuredCategory.subcategory,
    ]
      .filter(Boolean)
      .join(" > ");

    try {
      if (isEtsy) {
        const res = await fetch("/api/etsy/crosslist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: row.item_id,
            publishImmediately,
            overrideCompliance,
            draft: {
              ...draft,
              mappedTitle: title.trim(),
              descriptionPlain: description.trim(),
              whenMade,
              isSupply,
              tags,
              structuredCategory: updatedStructuredCategory,
              pricing: {
                ...draft.pricing,
                suggestedPrice: round2(parsedPrice),
              },
            },
          }),
        });

        const payload = (await res.json()) as {
          results?: EtsyCrossListResult[];
          errors?: Array<{ error: string }>;
          error?: string;
        };

        if (!res.ok) {
          throw new Error(payload.error || "Cross-list publish failed");
        }

        const firstResult = payload.results?.[0];
        if (!firstResult) {
          throw new Error(
            payload.errors?.[0]?.error || "Etsy did not return a listing"
          );
        }

        await onPublishedEtsy(firstResult);
        onClose();
      } else {
        const res = await fetch("/api/extension/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: row.item_id,
            marketplace: target,
            action: "create",
            overrideCompliance,
            draft: {
              ...draft,
              mappedTitle: title.trim(),
              descriptionPlain: description.trim(),
              categoryPath: updatedBreadcrumb || draft.categoryPath,
              structuredCategory: updatedStructuredCategory,
              pricing: {
                ...draft.pricing,
                suggestedPrice: round2(parsedPrice),
              },
            },
          }),
        });

        const payload = (await res.json()) as {
          jobs?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(payload.error || "Failed to queue extension job");
        }

        const createdJob = payload.jobs?.[0];
        const canLaunchLocally = Boolean(
          localExtensionReady &&
            createdJob &&
            typeof window !== "undefined"
        );

        if (canLaunchLocally && createdJob) {
          window.postMessage(
            { type: "RCC_LOCAL_DISPATCH_JOB", job: createdJob },
            window.location.origin
          );
        }

        await onQueuedExtension({
          marketplace: target,
          sku: row.sku,
          price: round2(parsedPrice),
          launchedLocally: canLaunchLocally,
        });
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cross-list failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Cross-List Listing"
    >
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl border-l border-[#E4E4DD] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#ECECE6] bg-[#FAF9F6] space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                {isEtsy ? (
                  <Sparkles className="w-4 h-4 text-[#1D4ED8]" />
                ) : (
                  <Puzzle className="w-4 h-4 text-[#0F766E]" />
                )}
                <h2 className="text-sm font-semibold text-[#14151A]">
                  AI Cross-List: eBay →{" "}
                  {TARGET_CHANNELS.find((c) => c.key === target)?.label}
                </h2>
                {draft && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-[#EFF6FF] text-[#1D4ED8]">
                    {draft.mapperMode === "gemini"
                      ? `Gemini (${draft.modelUsed})`
                      : "Heuristic Mapper"}
                  </span>
                )}
              </div>
              <p className="text-xs text-[#5C606B] mt-0.5 font-mono">
                SKU {row.sku} · eBay Ask ${row.listed_price.toFixed(2)} · COGS $
                {row.cogs.toFixed(2)} · Floor ${row.floor_price.toFixed(2)}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close drawer"
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#5C606B] hover:text-[#14151A] hover:bg-[#ECECE6] transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Target Channel Selector */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {TARGET_CHANNELS.map((ch) => {
              const active = target === ch.key;
              const alreadyListed = row.cross_listings.some(
                (c) => c.marketplace === ch.key
              );
              return (
                <button
                  key={ch.key}
                  type="button"
                  onClick={() => onChangeTarget(ch.key)}
                  className={`px-2.5 py-2 rounded-lg border text-left transition cursor-pointer ${
                    active
                      ? "bg-[#14151A] text-white border-[#14151A]"
                      : "bg-white text-[#14151A] border-[#DCDCD5] hover:bg-[#F1F1EC]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 text-xs font-semibold">
                    <span className="truncate">{ch.label}</span>
                    <span
                      className={`text-[10px] px-1 rounded ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-[#F1F1EC] text-[#5C606B]"
                      }`}
                    >
                      {alreadyListed ? "Live" : ch.mode}
                    </span>
                  </div>
                  <div
                    className={`text-[10px] mt-0.5 ${
                      active ? "text-white/75" : "text-[#5C606B]"
                    }`}
                  >
                    {ch.feeNote}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {isLoadingMap ? (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-xs text-[#5C606B]">
              <Loader2 className="w-5 h-5 animate-spin text-[#1D4ED8]" />
              <span>
                Translating title, stripping HTML &amp; calculating fee-adjusted
                price for {target}...
              </span>
            </div>
          ) : error && !draft ? (
            <div className="p-4 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C]">
              {error}
            </div>
          ) : draft ? (
            <>
              {error && (
                <div className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C]">
                  {error}
                </div>
              )}

              {(() => {
                const existing = row.cross_listings.find(
                  (c) => c.marketplace === target
                );
                if (!existing) return null;
                return (
                  <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-xs text-[#065F46]">
                    <span>
                      Already marked <strong>Live</strong> on{" "}
                      <span className="capitalize">{target}</span> ($
                      {existing.listed_price.toFixed(2)}). If this wasn&apos;t
                      actually posted or was delisted, unlink it here.
                    </span>
                    <button
                      type="button"
                      disabled={isUnlinking}
                      onClick={async () => {
                        setIsUnlinking(true);
                        setError(null);
                        try {
                          const res = await fetch(
                            `/api/extension/import-listings?itemId=${encodeURIComponent(row.item_id)}&marketplace=${encodeURIComponent(target)}`,
                            { method: "DELETE" }
                          );
                          const data = (await res.json()) as { error?: string };
                          if (!res.ok) {
                            throw new Error(data.error || "Failed to unlink");
                          }
                          await onUnlinked?.(target);
                          onClose();
                        } catch (err) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : "Failed to unlink listing"
                          );
                        } finally {
                          setIsUnlinking(false);
                        }
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-white border border-[#FECACA] text-[#B91C1C] hover:bg-[#FEF2F2] disabled:opacity-50 transition cursor-pointer shrink-0"
                    >
                      {isUnlinking ? "Unlinking..." : "Unlink Listing"}
                    </button>
                  </div>
                );
              })()}

              {/* Marketplace Policy & Compliance Shield */}
              <div
                className={`rounded-xl border p-3.5 text-xs space-y-2 ${
                  isComplianceBlocked
                    ? "bg-[#FEF2F2] border-[#FCA5A5] text-[#991B1B]"
                    : hasComplianceWarning
                      ? "bg-[#FFFBEB] border-[#FDE68A] text-[#92400E]"
                      : "bg-[#ECFDF5] border-[#A7F3D0] text-[#065F46]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-semibold">
                    {isComplianceBlocked ? (
                      <ShieldAlert className="w-4 h-4 text-[#B91C1C] shrink-0" />
                    ) : hasComplianceWarning ? (
                      <AlertTriangle className="w-4 h-4 text-[#B45309] shrink-0" />
                    ) : (
                      <ShieldCheck className="w-4 h-4 text-[#0F766E] shrink-0" />
                    )}
                    <span className="capitalize">
                      {isComplianceBlocked
                        ? `Blocked by ${target} Marketplace Policy`
                        : hasComplianceWarning
                          ? `${target} Policy Check — Review Warning`
                          : `${target} Rules & Regulations Verified`}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-white/75">
                    {isComplianceBlocked
                      ? "BLOCKED"
                      : hasComplianceWarning
                        ? "WARNING"
                        : "COMPLIANT"}
                  </span>
                </div>

                {complianceIssues.length > 0 && (
                  <ul className="space-y-1 pl-1">
                    {complianceIssues.map((issue) => (
                      <li key={issue.code} className="leading-snug">
                        <strong>{issue.rule}:</strong> {issue.detail}
                      </li>
                    ))}
                  </ul>
                )}

                {(draft.compliance?.sanitizedAdjustments?.length ?? 0) > 0 && (
                  <div className="pt-1 border-t border-black/10 text-[11px] opacity-90">
                    <strong>Auto-sanitized:</strong>{" "}
                    {draft.compliance.sanitizedAdjustments.join(" · ")}
                  </div>
                )}

                {isComplianceBlocked && (
                  <label className="pt-1.5 border-t border-[#FCA5A5] flex items-center gap-2 text-[11px] font-medium text-[#7F1D1D] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={overrideCompliance}
                      onChange={(e) => setOverrideCompliance(e.target.checked)}
                      className="rounded border-[#FCA5A5] accent-[#B91C1C]"
                    />
                    <span>
                      False positive — I verified this item is allowed on{" "}
                      <span className="capitalize">{target}</span> (override
                      block)
                    </span>
                  </label>
                )}
              </div>

              {target === "facebook" && (
                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-[#FFFBEB] border border-[#FDE68A] text-xs text-[#92400E]">
                  <ShieldAlert className="w-4 h-4 text-[#B45309] shrink-0 mt-0.5" />
                  <span>
                    <strong>Safety Confirm Gate:</strong> The Chrome/Arc
                    extension will auto-fill Title, Price, Description, and CDN
                    photos, then pause in{" "}
                    <code className="font-mono">needs_user_confirm</code> so you
                    click Facebook&apos;s final Publish button manually.
                  </span>
                </div>
              )}

              {/* Fee-Adjusted Pricing Comparison */}
              <div className="border border-[#E4E4DD] rounded-xl p-4 bg-[#FAF9F6] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#14151A]">
                    Fee-Adjusted Cross-List Pricing
                  </span>
                  <span className="text-[11px] font-mono text-[#5C606B]">
                    eBay {draft.pricing.ebayFeePct}% vs {target}{" "}
                    {targetFeePct}% (+{draft.pricing.targetMarkupPct}% markup)
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                  <div className="bg-white border border-[#ECECE6] rounded-lg p-3">
                    <div className="text-[11px] text-[#5C606B]">eBay Ask</div>
                    <div className="text-base font-semibold font-mono tabular-nums text-[#14151A] mt-0.5">
                      ${row.listed_price.toFixed(2)}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-[#5C606B] mt-0.5">
                      Est. net ${row.est_net_profit.toFixed(2)}
                    </div>
                  </div>

                  <div className="bg-white border border-[#1D4ED8]/30 rounded-lg p-3">
                    <label
                      htmlFor="target-price-input"
                      className="block text-[11px] font-medium text-[#1D4ED8] capitalize"
                    >
                      {target} List Price ($)
                    </label>
                    <input
                      id="target-price-input"
                      type="number"
                      step="0.01"
                      value={priceStr}
                      onChange={(e) => setPriceStr(e.target.value)}
                      className="mt-0.5 w-full font-mono tabular-nums text-base font-semibold text-[#14151A] focus:outline-none"
                    />
                    <div
                      className={`text-[11px] font-mono mt-0.5 ${
                        isBelowFloor
                          ? "text-[#B91C1C] font-semibold"
                          : "text-[#5C606B]"
                      }`}
                    >
                      {isBelowFloor
                        ? `Below floor ($${row.floor_price.toFixed(2)})`
                        : `Floor $${row.floor_price.toFixed(2)} protected`}
                    </div>
                  </div>

                  <div className="bg-white border border-[#ECECE6] rounded-lg p-3">
                    <div className="text-[11px] text-[#5C606B] capitalize">
                      Projected {target} Net
                    </div>
                    <div className="text-base font-semibold font-mono tabular-nums text-[#0F766E] mt-0.5">
                      +${estTargetNet.toFixed(2)}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-[#0F766E] mt-0.5">
                      {netDelta >= 0 ? "+" : ""}${netDelta.toFixed(2)} vs eBay
                    </div>
                  </div>
                </div>

                {(() => {
                  const ship = estimateShippingRates({
                    weightOz: row.weight_oz,
                    lengthIn: row.length_in,
                    widthIn: row.width_in,
                    heightIn: row.height_in,
                    isMediaEligible: false,
                  });
                  return (
                    <div className="rounded-lg bg-white border border-[#ECECE6] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-center gap-1.5 text-[#444B52]">
                        <Truck className="w-3.5 h-3.5 text-[#0F766E] shrink-0" />
                        <span>
                          Est. Ship ({ship.actualLb.toFixed(1)} lb / {ship.dimLb} lb DIM):{" "}
                          <strong className="text-[#14151A]">
                            {ship.cheapest.label} (${ship.cheapest.price.toFixed(2)})
                          </strong>
                        </span>
                      </div>
                      {ship.dimWeightWarning && (
                        <span className="inline-flex items-center gap-1 text-[#B45309] font-semibold">
                          <AlertTriangle className="w-3 h-3" />
                          DIM weight exceeds actual
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Synced eBay Photos Preview */}
              {(() => {
                const photos =
                  draft.imageUrls && draft.imageUrls.length > 0
                    ? draft.imageUrls
                    : row.image_urls || [];
                if (photos.length === 0) return null;
                return (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#14151A]">
                        Photos Ready to Transfer ({photos.length})
                      </span>
                      <span className="text-[11px] font-mono text-[#0F766E]">
                        Full-res eBay gallery
                      </span>
                    </div>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {photos.slice(0, 16).map((url, idx) => (
                        <div
                          key={`${url}-${idx}`}
                          className="relative w-14 h-14 rounded-lg border border-[#E4E4DD] bg-white overflow-hidden shrink-0 flex items-center justify-center p-0.5"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={`Photo ${idx + 1}`}
                            className="w-full h-full object-contain"
                          />
                          <span className="absolute bottom-0.5 right-0.5 px-1 rounded bg-[#14151A]/75 text-white text-[9px] font-mono">
                            {idx + 1}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Mapped Title */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="target-title-input"
                    className="text-xs font-semibold text-[#14151A] capitalize"
                  >
                    {target} Optimized Title
                  </label>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      title.length > maxTitleLen
                        ? "text-[#B91C1C] font-semibold"
                        : "text-[#5C606B]"
                    }`}
                  >
                    {title.length} / {maxTitleLen} chars
                  </span>
                </div>
                <input
                  id="target-title-input"
                  type="text"
                  maxLength={maxTitleLen}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A] focus:outline-none focus:border-[#14151A]"
                />
              </div>

              {/* Auto-Mapped Category, Condition & Size (Poshmark / Mercari / Facebook) */}
              {!isEtsy && (
                <div className="rounded-xl border border-[#E4E4DD] bg-[#FAF9F6] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#14151A] capitalize">
                      Auto-Mapped {target} Category, Condition &amp; Size
                    </span>
                    <span className="text-[10px] font-mono text-[#0F766E]">
                      Auto-selected by extension
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {target !== "facebook" && (
                      <div>
                        <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                          Department
                        </label>
                        <input
                          type="text"
                          value={department}
                          onChange={(e) => setDepartment(e.target.value)}
                          placeholder="e.g. Home / Women / Men"
                          className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                        />
                      </div>
                    )}
                    <div className={target === "facebook" ? "sm:col-span-2" : ""}>
                      <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                        Category
                      </label>
                      <input
                        type="text"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        placeholder="Category"
                        className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                      />
                    </div>
                    {target !== "facebook" && (
                      <div>
                        <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                          Subcategory
                        </label>
                        <input
                          type="text"
                          value={subcategory}
                          onChange={(e) => setSubcategory(e.target.value)}
                          placeholder="Optional subcategory"
                          className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                        Condition
                      </label>
                      <input
                        type="text"
                        value={conditionLabel}
                        onChange={(e) => setConditionLabel(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                      />
                    </div>
                    {target !== "facebook" && (
                      <div>
                        <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                          Size
                        </label>
                        <input
                          type="text"
                          value={sizeLabel}
                          onChange={(e) => setSizeLabel(e.target.value)}
                          placeholder="OS or garment size"
                          className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Etsy-only Taxonomy + Era + Craft Supply + SEO Tags */}
              {isEtsy && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-[#14151A] mb-1.5">
                        Mapped Etsy Taxonomy (#{draft.taxonomyId})
                      </label>
                      <div className="px-3 py-2 text-xs rounded-lg border border-[#E4E4DD] bg-[#FAF9F6] text-[#14151A]">
                        {draft.categoryPath}
                      </div>
                    </div>
                    <div>
                      <label
                        htmlFor="etsy-when-made"
                        className="block text-xs font-semibold text-[#14151A] mb-1.5"
                      >
                        Era (when_made)
                      </label>
                      <select
                        id="etsy-when-made"
                        value={whenMade}
                        onChange={(e) => setWhenMade(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A] focus:outline-none focus:border-[#14151A]"
                      >
                        <option value="2020_2026">2020–2026</option>
                        <option value="2010_2019">2010–2019</option>
                        <option value="2000_2006">2000–2006 (Vintage)</option>
                        <option value="1990_1999">1990s (Vintage)</option>
                        <option value="1980s">1980s (Vintage)</option>
                        <option value="1970s">1970s (Vintage)</option>
                        <option value="before_1970">Before 1970</option>
                      </select>
                    </div>
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs text-[#444854] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSupply}
                      onChange={(e) => setIsSupply(e.target.checked)}
                      className="rounded border-[#C8C8BE] accent-[#0F766E]"
                    />
                    <span>
                      This item is a <strong>Craft Supply / Tool</strong>{" "}
                      (eligible on Etsy regardless of age)
                    </span>
                  </label>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#14151A]">
                        <Tag className="w-3.5 h-3.5" />
                        Etsy SEO Tags (max 20 chars each)
                      </span>
                      <span className="font-mono text-[11px] text-[#5C606B]">
                        {tags.length} / 13 tags
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-1.5 p-3 rounded-lg border border-[#E4E4DD] bg-[#FAF9F6]">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-white border border-[#DCDCD5] text-[#14151A]"
                        >
                          <span>{tag}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${tag}`}
                            onClick={() => handleRemoveTag(tag)}
                            className="text-[#8A8E99] hover:text-[#B91C1C] cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                      {tags.length < 13 && (
                        <div className="inline-flex items-center gap-1">
                          <input
                            type="text"
                            maxLength={20}
                            placeholder="Add tag..."
                            value={newTagInput}
                            onChange={(e) => setNewTagInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleAddTag();
                              }
                            }}
                            className="w-28 px-2 py-1 text-xs rounded-md border border-[#DCDCD5] bg-white text-[#14151A] focus:outline-none focus:border-[#14151A]"
                          />
                          <button
                            type="button"
                            onClick={handleAddTag}
                            className="p-1 rounded-md bg-[#14151A] text-white hover:bg-[#272A34] cursor-pointer"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* HTML-Stripped Plain Description */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="target-desc-input"
                    className="text-xs font-semibold text-[#14151A]"
                  >
                    Plain-Text Description (Sanitized · Zero HTML)
                  </label>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      description.length > maxDescLen
                        ? "text-[#B91C1C] font-semibold"
                        : "text-[#0F766E]"
                    }`}
                  >
                    {description.length} / {maxDescLen} chars
                  </span>
                </div>
                <textarea
                  id="target-desc-input"
                  rows={6}
                  maxLength={maxDescLen}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono leading-relaxed rounded-lg border border-[#DCDCD5] bg-white text-[#14151A] focus:outline-none focus:border-[#14151A]"
                />
              </div>

              {/* Field Mapper Notes */}
              <div className="rounded-xl border border-[#ECECE6] bg-[#FCFCFA] p-3.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#5C606B] mb-2">
                  Field Mapper Audit Notes
                </div>
                <ul className="space-y-1 text-xs text-[#444854]">
                  {draft.translationNotes.map((note, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-[#0F766E] shrink-0 mt-0.5" />
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-3">
          {isEtsy ? (
            <label className="inline-flex items-center gap-2 text-xs text-[#444854] cursor-pointer">
              <input
                type="checkbox"
                checked={publishImmediately}
                onChange={(e) => setPublishImmediately(e.target.checked)}
                className="rounded border-[#C8C8BE] accent-[#14151A]"
              />
              <span>Publish immediately as Active</span>
            </label>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-[#5C606B]">
              <Puzzle className="w-3.5 h-3.5 text-[#0F766E]" />
              <span>
                {localExtensionReady
                  ? "Extension active on this Mac — opens & fills in 1 click"
                  : "Sends to Mac Mini Auto-Pilot (saves Poshmark/Mercari Draft)"}
              </span>
            </span>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#DCDCD5] bg-white text-[#14151A] hover:bg-[#F1F1EC] cursor-pointer"
            >
              Cancel
            </button>
            <button
              id="btn-submit-crosslist"
              type="button"
              disabled={
                !draft ||
                isSubmitting ||
                isBelowFloor ||
                effectiveBlocked ||
                isAlreadyLiveOnTarget
              }
              onClick={handleSubmit}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-45 transition cursor-pointer ${
                effectiveBlocked
                  ? "bg-[#B91C1C]"
                  : isAlreadyLiveOnTarget
                    ? "bg-[#0F766E]"
                    : "bg-[#14151A] hover:bg-[#272A34]"
              }`}
            >
              {isSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : effectiveBlocked ? (
                <ShieldAlert className="w-3.5 h-3.5" />
              ) : isAlreadyLiveOnTarget ? (
                <CheckCircle2 className="w-3.5 h-3.5" />
              ) : (
                <ArrowRight className="w-3.5 h-3.5" />
              )}
              {isAlreadyLiveOnTarget
                ? `Already Listed on ${TARGET_CHANNELS.find((c) => c.key === target)?.label}`
                : effectiveBlocked
                  ? `Blocked on ${TARGET_CHANNELS.find((c) => c.key === target)?.label}`
                  : isSubmitting
                    ? isEtsy
                      ? "Publishing to Etsy..."
                      : localExtensionReady
                        ? "Opening & Auto-Filling..."
                        : "Sending to Auto-Pilot..."
                    : isEtsy
                      ? `Publish to Etsy ($${parsedPrice.toFixed(2)})`
                      : localExtensionReady
                        ? `Open & Auto-Fill ${TARGET_CHANNELS.find((c) => c.key === target)?.label} ($${parsedPrice.toFixed(2)})`
                        : `Queue for ${TARGET_CHANNELS.find((c) => c.key === target)?.label} Auto-Pilot ($${parsedPrice.toFixed(2)})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
