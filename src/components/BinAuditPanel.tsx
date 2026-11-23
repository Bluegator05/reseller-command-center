"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CalendarCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  History,
  MapPin,
  Printer,
  RotateCcw,
  Search,
  Tag,
} from "lucide-react";
import {
  printBinAuditSheet,
  printThermalSkuLabels,
  type ThermalLabelItem,
} from "@/lib/thermal-label";
import type {
  InventoryAuditRecord,
  InventoryItem,
  StaleRadarRow,
} from "@/lib/types";

type AuditStatus = "verified" | "missing" | null;
type AuditFilterMode = "all" | "unverified" | "verified" | "missing";

interface BinAuditPanelProps {
  activeItems: StaleRadarRow[];
  draftItems: InventoryItem[];
  auditHistory?: InventoryAuditRecord[];
  onOpenItemDetail: (row: StaleRadarRow) => void;
  onSetBinAudit?: (itemIds: string[], auditStatus: AuditStatus) => Promise<void>;
  onCompleteInventoryAudit?: (summary: {
    totalItems: number;
    verifiedCount: number;
    missingCount: number;
    notes?: string | null;
  }) => Promise<void>;
}

interface ParsedSkuMeta {
  bin: string;
  source: string | null;
  dateStr: string | null;
  itemNumber: string | null;
}

interface BinEntry {
  bin: string;
  items: Array<
    ThermalLabelItem & {
      id: string;
      status: "active" | "draft";
      thumbUrl?: string | null;
      parsedSource?: string | null;
      parsedDate?: string | null;
      parsedItemNumber?: string | null;
      auditStatus: AuditStatus;
      auditVerifiedAt: string | null;
      radarRow?: StaleRadarRow;
    }
  >;
  totalBasis: number;
  totalRetail: number;
  verifiedCount: number;
  missingCount: number;
}

function formatShortAuditDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const CLOTHING_HINT_RE =
  /\b(clothing|apparel|shirt|t-shirt|tshirt|tee|polo|blouse|top|sweater|sweatshirt|hoodie|pullover|cardigan|jacket|coat|blazer|vest|parka|windbreaker|fleece|pants|jeans|denim|trousers|slacks|chinos|shorts|leggings|joggers|sweatpants|skirt|dress|romper|jumpsuit|suit|tuxedo|jersey|flannel|henley|tunic|tank|camisole|bodysuit|swimsuit|bikini|trunks|robe|pajama|sleepwear|lingerie|bra|underwear|socks|tie|necktie|scarf|beanie|hat|cap|gloves|belt|womens|women's|mens|men's|boys|girls|youth|kids|size\s*(?:xxs|xs|s|m|l|xl|xxl|2xl|3xl|4xl))\b/i;

function normalizeExplicitBin(raw: string): string | null {
  const cleaned = raw
    .replace(/^[\s()[\]{}*.,;:\-–—/\\]+|[\s()[\]{}*.,;:\-–—/\\]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || !/[A-Za-z0-9]/.test(cleaned)) return null;
  if (cleaned.toUpperCase() === "UNASSIGNED") return null;

  const shelfLetter = cleaned.match(
    /\bshelf\s*[-#:]?\s*([A-Za-z])(?=\b|[^A-Za-z]|$)/i
  );
  if (shelfLetter) return `Shelf ${shelfLetter[1].toUpperCase()}`;

  const shelfNum = cleaned.match(/\bshelf\s*[-#:]?\s*(\d{1,2})\b/i);
  if (shelfNum) return `Shelf ${shelfNum[1]}`;

  const garageBin =
    cleaned.match(/(?:^|[^A-Za-z0-9])G\s*[-#]?([1-9])(?=$|[^A-Za-z0-9])/i) ||
    cleaned.match(/(?:^|[^A-Za-z0-9])G([1-9])\d{2,4}(?=$|[^A-Za-z0-9])/i);
  if (garageBin) return `G${garageBin[1]}`;

  if (/\bcloset\b/i.test(cleaned)) return "Closet";
  if (/\brack\b/i.test(cleaned)) return "Rack";
  if (/^clothes?$/i.test(cleaned)) return "Clothes";

  return cleaned;
}

/**
 * Parses custom reseller SKUs into clean physical locations:
 *  1) Any "Shelf <Letter>" anywhere in SKU -> "Shelf A", "Shelf E", "Shelf F", ...
 *  2) Garage bins G1–G9 anywhere in SKU (incl. G4001, G4016) -> "G1"–"G5", ...
 *  3) Any "Closet" anywhere in SKU         -> "Closet" (all floor items in shipping closet)
 *  4) Any "Rack" anywhere in SKU           -> "Rack"   (all items on shipping rack)
 *  5) Other explicit named containers (Tote, Box, Drawer, Tub, Cabinet, Bay)
 *  6) Clothing without a shelf (numeric-only SKUs or apparel items) -> "Clothes"
 *  7) Punctuation/asterisk-only or unlocated items -> "Unassigned"
 */
function parseCustomSkuLocation(
  skuRaw: string | null | undefined,
  explicitBinRaw: string | null | undefined,
  titleRaw?: string | null,
  categoryHintRaw?: string | null
): ParsedSkuMeta {
  const sku = (skuRaw || "").trim();
  const explicit = explicitBinRaw ? normalizeExplicitBin(explicitBinRaw) : null;

  // Extract date & source metadata for display badges
  const dateRe = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;
  const dateMatch = sku.match(dateRe);
  let source: string | null = null;
  let dateStr: string | null = null;

  if (dateMatch && dateMatch.index !== undefined) {
    dateStr = dateMatch[1];
    const before = sku
      .slice(0, dateMatch.index)
      .replace(/^[\s()[\]{}*.,;:\-–—/\\]+|[\s()[\]{}*.,;:\-–—/\\]+$/g, "")
      .trim();
    if (before) {
      const firstToken = before
        .split(/[.,()]+/)
        .map((s) => s.trim())
        .find((s) => /[A-Za-z0-9]/.test(s));
      if (
        firstToken &&
        !/^shelf\b/i.test(firstToken) &&
        !/^G[1-9](?:\d{2,4})?$/i.test(firstToken) &&
        !/^(?:closet|rack)\b/i.test(firstToken) &&
        !/^\d+$/.test(firstToken)
      ) {
        source = firstToken;
      }
    }
  }

  // Respect explicit manually-assigned bin_location if clean
  if (explicit) {
    return { bin: explicit, source, dateStr, itemNumber: null };
  }

  // Priority 1: "Shelf <Letter>" anywhere in SKU (handles ") 2 SHELF A/7 STORAGE", "0001 SHELF F", "Shelf L - 2044")
  const shelfLetterMatch = sku.match(
    /\bshelf\s*[-#:]?\s*([A-Za-z])(?=\b|[^A-Za-z]|$)/i
  );
  if (shelfLetterMatch) {
    return {
      bin: `Shelf ${shelfLetterMatch[1].toUpperCase()}`,
      source,
      dateStr,
      itemNumber: null,
    };
  }
  const shelfNumMatch = sku.match(/\bshelf\s*[-#:]?\s*(\d{1,2})\b/i);
  if (shelfNumMatch) {
    return {
      bin: `Shelf ${shelfNumMatch[1]}`,
      source,
      dateStr,
      itemNumber: null,
    };
  }

  // Priority 2: Garage bins G1–G9 (handles both "G3" and concatenated codes like "G4001", "G4016")
  const garageBinMatch =
    sku.match(/(?:^|[^A-Za-z0-9])G\s*[-#]?([1-9])(?=$|[^A-Za-z0-9])/i) ||
    sku.match(/(?:^|[^A-Za-z0-9])G([1-9])\d{2,4}(?=$|[^A-Za-z0-9])/i) ||
    sku.match(/\bgarage\s*(?:bin\s*)?#?\s*([1-9])\b/i);
  if (garageBinMatch) {
    return {
      bin: `G${garageBinMatch[1]}`,
      source,
      dateStr,
      itemNumber: null,
    };
  }

  // Priority 3: Shipping Closet & Shipping Rack (each grouped into 1 unified bin)
  if (/\bcloset\b/i.test(sku)) {
    return { bin: "Closet", source, dateStr, itemNumber: null };
  }
  if (/\brack\b/i.test(sku)) {
    return { bin: "Rack", source, dateStr, itemNumber: null };
  }

  // Priority 4: Other explicit named containers (ignores "/16 storage" count notes)
  const namedBinMatch = sku.match(
    /\b((?:tote|box|drawer|tub|cabinet|bay)\s*[-#:]?\s*[A-Za-z0-9]+)\b/i
  );
  if (namedBinMatch) {
    const label = namedBinMatch[1]
      .replace(/[-#:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const formatted = label.replace(
      /\b([a-z])([a-z]*)/gi,
      (_, first: string, rest: string) =>
        first.toUpperCase() + rest.toLowerCase()
    );
    return { bin: formatted, source, dateStr, itemNumber: null };
  }

  // Priority 5: Clothing without a Shelf / Garage bin -> "Clothes"
  const cleanedTokensStr = sku
    .replace(/\([^)]*(?:garage|storage)[^)]*\)/gi, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ")
    .replace(/[()[\]{}*.,;:\-–—/\\#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isPureNumericSku = /^\d+(?:\s+\d+)*$/.test(cleanedTokensStr);
  const tokens = cleanedTokensStr.split(" ").filter(Boolean);
  const hasOnlyNumberLocation =
    isPureNumericSku ||
    (tokens.length === 2 &&
      /^[A-Za-z]{1,6}\d{0,4}$/.test(tokens[0]) &&
      /^\d{1,6}$/.test(tokens[1]));

  const clothingText = `${titleRaw || ""} ${categoryHintRaw || ""}`;
  const isClothingByText = CLOTHING_HINT_RE.test(clothingText);

  if (isPureNumericSku || isClothingByText || hasOnlyNumberLocation) {
    return { bin: "Clothes", source, dateStr, itemNumber: null };
  }

  return { bin: "Unassigned", source, dateStr, itemNumber: null };
}

function getBinSortRank(bin: string): number {
  if (/^Shelf\b/i.test(bin)) return 0;
  if (/^G[1-9]\d?$/i.test(bin)) return 1;
  if (bin === "Closet" || bin === "Rack") return 2;
  if (bin === "Clothes") return 3;
  if (bin === "Unassigned") return 5;
  return 4;
}

export function BinAuditPanel({
  activeItems,
  draftItems,
  auditHistory = [],
  onOpenItemDetail,
  onSetBinAudit,
  onCompleteInventoryAudit,
}: BinAuditPanelProps) {
  const [search, setSearch] = useState("");
  const [selectedBinFilter, setSelectedBinFilter] = useState<string>("ALL");
  const [auditFilter, setAuditFilter] = useState<AuditFilterMode>("all");
  const [expandedBins, setExpandedBins] = useState<Set<string>>(new Set());
  const [isCompletingAudit, setIsCompletingAudit] = useState(false);
  const [showAuditHistory, setShowAuditHistory] = useState(false);
  const [mountNowMs] = useState(() => Date.now());

  const allBins = useMemo<BinEntry[]>(() => {
    const map = new Map<string, BinEntry>();
    const add = (
      binKey: string,
      entry: BinEntry["items"][number],
      basis: number,
      retail: number
    ) => {
      let bucket = map.get(binKey);
      if (!bucket) {
        bucket = {
          bin: binKey,
          items: [],
          totalBasis: 0,
          totalRetail: 0,
          verifiedCount: 0,
          missingCount: 0,
        };
        map.set(binKey, bucket);
      }
      bucket.items.push(entry);
      bucket.totalBasis += basis;
      bucket.totalRetail += retail;
      if (entry.auditStatus === "verified") bucket.verifiedCount += 1;
      if (entry.auditStatus === "missing") bucket.missingCount += 1;
    };

    for (const r of activeItems) {
      const parsed = parseCustomSkuLocation(
        r.sku,
        r.bin_location,
        r.title,
        r.category_hint
      );
      add(
        parsed.bin,
        {
          id: r.item_id,
          sku: r.sku,
          bin: parsed.bin,
          title: r.title,
          acquiredAt: r.acquired_at,
          cogs: r.total_cost_basis,
          price: r.listed_price,
          status: "active",
          thumbUrl: r.image_urls?.[0] || null,
          parsedSource: parsed.source,
          parsedDate: parsed.dateStr,
          parsedItemNumber: parsed.itemNumber,
          auditStatus: r.audit_status ?? null,
          auditVerifiedAt: r.audit_verified_at ?? null,
          radarRow: r,
        },
        r.total_cost_basis,
        r.listed_price
      );
    }

    for (const d of draftItems) {
      const basis = (d.cogs || 0) + (d.prep_cost || 0);
      const parsed = parseCustomSkuLocation(
        d.sku,
        d.bin_location,
        d.title,
        d.category_hint
      );
      const dSpecs = (d.item_specifics || {}) as Record<string, unknown>;
      const dAuditStatus: AuditStatus =
        dSpecs.audit_status === "verified" || dSpecs.audit_status === "missing"
          ? dSpecs.audit_status
          : null;
      const dAuditAt =
        typeof dSpecs.audit_verified_at === "string"
          ? dSpecs.audit_verified_at
          : null;
      add(
        parsed.bin,
        {
          id: d.id,
          sku: d.sku,
          bin: parsed.bin,
          title: d.title,
          acquiredAt: d.acquired_at,
          cogs: basis,
          price: d.target_price,
          status: "draft",
          thumbUrl: d.image_urls?.[0] || null,
          parsedSource: parsed.source,
          parsedDate: parsed.dateStr,
          parsedItemNumber: parsed.itemNumber,
          auditStatus: dAuditStatus,
          auditVerifiedAt: dAuditAt,
        },
        basis,
        Number(d.target_price || 0)
      );
    }

    return [...map.values()].sort((a, b) => {
      const rankDiff = getBinSortRank(a.bin) - getBinSortRank(b.bin);
      if (rankDiff !== 0) return rankDiff;
      return a.bin.localeCompare(b.bin, undefined, { numeric: true });
    });
  }, [activeItems, draftItems]);

  const auditStats = useMemo(() => {
    let total = 0;
    let verified = 0;
    let missing = 0;
    const auditedIds: string[] = [];
    for (const b of allBins) {
      for (const it of b.items) {
        total += 1;
        if (it.auditStatus === "verified") {
          verified += 1;
          auditedIds.push(it.id);
        } else if (it.auditStatus === "missing") {
          missing += 1;
          auditedIds.push(it.id);
        }
      }
    }
    const unverified = total - verified - missing;
    const pct = total > 0 ? Math.round((verified / total) * 100) : 0;
    return { total, verified, missing, unverified, pct, auditedIds };
  }, [allBins]);

  const visibleBins = useMemo<BinEntry[]>(() => {
    const q = search.trim().toLowerCase();
    return allBins
      .filter((b) => selectedBinFilter === "ALL" || b.bin === selectedBinFilter)
      .map((b) => {
        const filteredItems = b.items.filter((i) => {
          if (auditFilter === "verified" && i.auditStatus !== "verified") {
            return false;
          }
          if (auditFilter === "missing" && i.auditStatus !== "missing") {
            return false;
          }
          if (auditFilter === "unverified" && i.auditStatus !== null) {
            return false;
          }
          if (!q) return true;
          if (b.bin.toLowerCase().includes(q)) return true;
          return (
            i.sku.toLowerCase().includes(q) ||
            i.title.toLowerCase().includes(q) ||
            (i.parsedSource?.toLowerCase().includes(q) ?? false)
          );
        });
        return {
          ...b,
          items: filteredItems,
          totalBasis: filteredItems.reduce((s, x) => s + (x.cogs || 0), 0),
          totalRetail: filteredItems.reduce((s, x) => s + (x.price || 0), 0),
        };
      })
      .filter((b) => b.items.length > 0);
  }, [allBins, search, selectedBinFilter, auditFilter]);

  const allVisibleLabels = useMemo(
    () => visibleBins.flatMap((b) => b.items),
    [visibleBins]
  );

  const isBinOpen = (binName: string) => {
    // Auto-open when searching, filtered to a single bin, or inspecting missing items
    if (
      search.trim().length > 0 ||
      selectedBinFilter !== "ALL" ||
      auditFilter === "missing"
    ) {
      return true;
    }
    return expandedBins.has(binName);
  };

  const toggleBin = (binName: string) => {
    setExpandedBins((prev) => {
      const next = new Set(prev);
      if (next.has(binName)) next.delete(binName);
      else next.add(binName);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedBins(new Set(visibleBins.map((b) => b.bin)));
  };

  const collapseAll = () => {
    setExpandedBins(new Set());
  };

  const assignedBinCount = allBins.filter(
    (b) => b.bin !== "Unassigned"
  ).length;

  const lastCompletedAudit = auditHistory[0] ?? null;
  const daysSinceLastAudit = lastCompletedAudit
    ? Math.max(
        0,
        Math.floor(
          (mountNowMs - new Date(lastCompletedAudit.completedAt).getTime()) /
            86_400_000
        )
      )
    : null;
  const isQuarterlyDue =
    daysSinceLastAudit !== null && daysSinceLastAudit >= 90;

  return (
    <div className="space-y-4">
      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E] flex items-center justify-center shrink-0">
              <Archive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[#14151A]">
                Bins &amp; Storage Locations ({assignedBinCount} Locations ·{" "}
                {activeItems.length + draftItems.length} SKUs)
              </h2>
              <p className="text-xs text-[#5C606B] mt-0.5">
                Tap <strong>Verify</strong> as you physically confirm each item
                on its shelf — syncs live across your iPhone &amp; Mac.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={allVisibleLabels.length === 0}
            onClick={() => printThermalSkuLabels(allVisibleLabels)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print {allVisibleLabels.length} Labels</span>
          </button>
        </div>

        {/* Live Physical Inventory Audit Progress Strip */}
        <div className="p-3 rounded-xl bg-[#FAFBF9] border border-[#E5E8E6] space-y-2.5">
          {/* Last Completed Inventory Date Banner */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#ECEFE9]">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-semibold ${
                  !lastCompletedAudit
                    ? "bg-white border-[#DDE2DF] text-[#5C606B]"
                    : isQuarterlyDue
                      ? "bg-[#FFFBEB] border-[#FDE68A] text-[#92400E]"
                      : "bg-[#ECFDF5] border-[#A7F3D0] text-[#065F46]"
                }`}
              >
                <CalendarCheck className="w-3.5 h-3.5 shrink-0" />
                {lastCompletedAudit ? (
                  <span>
                    Last Completed Inventory:{" "}
                    <strong>
                      {new Date(
                        lastCompletedAudit.completedAt
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </strong>{" "}
                    (
                    {daysSinceLastAudit === 0
                      ? "Today"
                      : `${daysSinceLastAudit}d ago`}
                    {isQuarterlyDue ? " · Quarterly Audit Due" : ""}
                    )
                  </span>
                ) : (
                  <span>
                    Last Completed Inventory: <strong>Not logged yet</strong>
                  </span>
                )}
              </span>

              {auditHistory.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAuditHistory((v) => !v)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
                >
                  <History className="w-3 h-3" />
                  <span>
                    {showAuditHistory ? "Hide" : "History"} ({auditHistory.length})
                  </span>
                </button>
              )}
            </div>

            {onCompleteInventoryAudit && (
              <button
                type="button"
                disabled={isCompletingAudit}
                onClick={async () => {
                  const defaultNote =
                    auditStats.missing > 0
                      ? `${auditStats.verified}/${auditStats.total} verified, ${auditStats.missing} missing`
                      : `${auditStats.verified}/${auditStats.total} verified`;
                  const noteInput = window.prompt(
                    `Mark this inventory audit as COMPLETED today?\n\nProgress: ${defaultNote}\n\nOptional note (e.g. "Q4 full audit"):`,
                    ""
                  );
                  if (noteInput === null) return;
                  setIsCompletingAudit(true);
                  try {
                    await onCompleteInventoryAudit({
                      totalItems: auditStats.total,
                      verifiedCount: auditStats.verified,
                      missingCount: auditStats.missing,
                      notes: noteInput.trim() || null,
                    });
                  } finally {
                    setIsCompletingAudit(false);
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer disabled:opacity-50 ${
                  auditStats.pct >= 90
                    ? "bg-[#0F766E] text-white hover:bg-[#0B5B55] shadow-xs"
                    : "bg-white border border-[#0F766E] text-[#0F766E] hover:bg-[#ECFDF5]"
                }`}
              >
                <CalendarCheck className="w-3.5 h-3.5" />
                <span>
                  {isCompletingAudit
                    ? "Saving…"
                    : "Mark Inventory Completed"}
                </span>
              </button>
            )}
          </div>

          {showAuditHistory && auditHistory.length > 0 && (
            <div className="p-2.5 rounded-lg bg-white border border-[#E4E4DD] space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-[#5C606B]">
                Completed Inventory Log
              </div>
              {auditHistory.map((rec) => (
                <div
                  key={rec.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-[11px] py-1 border-b border-[#F1F1EC] last:border-b-0"
                >
                  <span className="font-semibold text-[#14151A]">
                    {new Date(rec.completedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    {rec.notes ? (
                      <span className="font-normal text-[#5C606B]">
                        {" "}
                        — {rec.notes}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-mono text-[10px] text-[#0F766E] font-semibold">
                    {rec.verifiedCount}/{rec.totalItems} verified
                    {rec.missingCount > 0 ? (
                      <span className="text-[#B91C1C]">
                        {" "}
                        · {rec.missingCount} missing
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-[#14151A] inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-[#0F766E]" />
                Current Count: {auditStats.verified} / {auditStats.total}{" "}
                Verified ({auditStats.pct}%)
              </span>
              {auditStats.missing > 0 && (
                <button
                  type="button"
                  onClick={() => setAuditFilter("missing")}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FEF2F2] border border-[#FECACA] text-[11px] font-bold text-[#B91C1C] cursor-pointer hover:bg-[#FEE2E2]"
                >
                  <AlertTriangle className="w-3 h-3" />
                  {auditStats.missing} Missing
                </button>
              )}
            </div>

            {onSetBinAudit && auditStats.auditedIds.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Reset audit checkmarks for all ${auditStats.auditedIds.length} checked items to start a fresh inventory count?\n\n(Your Last Completed Inventory history will be preserved.)`
                    )
                  ) {
                    void onSetBinAudit(auditStats.auditedIds, null);
                  }
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#5C606B] hover:border-[#B91C1C] hover:text-[#B91C1C] cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Start Fresh Audit
              </button>
            )}
          </div>

          <div className="h-2 rounded-full bg-[#E5E8E6] overflow-hidden">
            <div
              className="h-full bg-[#0F766E] transition-all duration-300"
              style={{ width: `${auditStats.pct}%` }}
            />
          </div>

          {/* Audit Status Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {(
              [
                { id: "all", label: `All (${auditStats.total})` },
                { id: "unverified", label: `To Check (${auditStats.unverified})` },
                { id: "verified", label: `Verified (${auditStats.verified})` },
                { id: "missing", label: `Missing (${auditStats.missing})` },
              ] as const
            ).map((pill) => {
              const active = auditFilter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setAuditFilter(pill.id)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition cursor-pointer ${
                    active
                      ? pill.id === "missing"
                        ? "bg-[#B91C1C] border-[#B91C1C] text-white"
                        : "bg-[#14151A] border-[#14151A] text-white"
                      : "bg-white border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E] hover:text-[#14151A]"
                  }`}
                >
                  {pill.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Location Jump Dropdown + Search + Expand/Collapse */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2.5 border-t border-[#F1F1EC]">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#DDE2DF] bg-[#FAFBF9]">
              <MapPin className="w-3.5 h-3.5 text-[#0F766E]" />
              <select
                aria-label="Filter by Bin or Location"
                value={selectedBinFilter}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedBinFilter(val);
                  if (val !== "ALL") {
                    setExpandedBins(new Set([val]));
                  }
                }}
                className="text-xs font-semibold text-[#14151A] bg-transparent focus:outline-none cursor-pointer"
              >
                <option value="ALL">
                  All Locations ({allBins.length} groups)
                </option>
                {allBins.map((b) => (
                  <option key={b.bin} value={b.bin}>
                    {b.bin} ({b.verifiedCount}/{b.items.length} verified)
                  </option>
                ))}
              </select>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#8E969D] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search location, SKU, title…"
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#DDE2DF] w-56 bg-white focus:border-[#0F766E] focus:outline-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={expandAll}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
            >
              <ChevronsUpDown className="w-3.5 h-3.5" />
              <span>Expand All</span>
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
            >
              <ChevronsDownUp className="w-3.5 h-3.5" />
              <span>Collapse All</span>
            </button>
          </div>
        </div>
      </section>

      {/* Collapsible Accordion Sections Grouped by Bin / Location */}
      {visibleBins.length === 0 ? (
        <div className="bg-white border border-[#E4E4DD] rounded-xl p-10 text-center text-xs text-[#5C606B]">
          {auditFilter === "unverified" && auditStats.total > 0
            ? "Every item in this view has been audited!"
            : auditFilter === "missing"
              ? "Zero missing items — everything is accounted for!"
              : "No items match your current location or search filter."}
        </div>
      ) : (
        <div className="space-y-2.5">
          {visibleBins.map((b) => {
            const fullBin = allBins.find((x) => x.bin === b.bin) || b;
            const fullCount = fullBin.items.length;
            const binComplete =
              fullCount > 0 && fullBin.verifiedCount === fullCount;
            const binHasAudited =
              fullBin.verifiedCount > 0 || fullBin.missingCount > 0;
            const open = isBinOpen(b.bin);
            const isUnassigned = b.bin === "Unassigned";
            const isGarage = /^G[1-9]\d?$/i.test(b.bin);
            const isClothes = b.bin === "Clothes";
            const isClosetOrRack = b.bin === "Closet" || b.bin === "Rack";
            const badgeClass = isUnassigned
              ? "bg-[#E5E7EB] text-[#4B5563]"
              : isGarage
                ? "bg-[#1D4ED8] text-white"
                : isClosetOrRack
                  ? "bg-[#B45309] text-white"
                  : isClothes
                    ? "bg-[#6D28D9] text-white"
                    : "bg-[#0F766E] text-white";
            return (
              <section
                key={b.bin}
                className={`bg-white border rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.02)] ${
                  binComplete ? "border-[#A7F3D0]" : "border-[#E4E4DD]"
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleBin(b.bin)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleBin(b.bin);
                    }
                  }}
                  className={`w-full px-4 py-3 transition flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none ${
                    binComplete
                      ? "bg-[#ECFDF5]/65 hover:bg-[#ECFDF5]"
                      : "bg-[#FAF9F6] hover:bg-[#F3F5F3]"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {open ? (
                      <ChevronDown className="w-4 h-4 text-[#0F766E] shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[#5C606B] shrink-0" />
                    )}
                    <span
                      className={`px-2.5 py-1 rounded-lg font-mono text-xs font-bold ${badgeClass}`}
                    >
                      {b.bin}
                    </span>
                    {isGarage && (
                      <span className="px-1.5 py-0.5 rounded bg-[#DBEAFE] text-[#1E40AF] text-[10px] font-semibold">
                        Garage
                      </span>
                    )}
                    {isClosetOrRack && (
                      <span className="px-1.5 py-0.5 rounded bg-[#FEF3C7] text-[#92400E] text-[10px] font-semibold">
                        {b.bin === "Closet" ? "Shipping Closet" : "Shipping Rack"}
                      </span>
                    )}
                    <span className="text-xs font-mono font-semibold text-[#14151A]">
                      {b.items.length} item{b.items.length === 1 ? "" : "s"}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-mono text-[10px] font-bold ${
                        binComplete
                          ? "bg-[#0F766E] text-white"
                          : fullBin.verifiedCount > 0
                            ? "bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E]"
                            : "bg-white border border-[#E4E4DD] text-[#5C606B]"
                      }`}
                    >
                      {binComplete
                        ? `✓ ${fullCount}/${fullCount} Audited`
                        : `${fullBin.verifiedCount}/${fullCount} verified`}
                    </span>
                    {fullBin.missingCount > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-[#FEE2E2] text-[#B91C1C] font-mono text-[10px] font-bold">
                        {fullBin.missingCount} missing
                      </span>
                    )}
                    <span className="text-xs text-[#5C606B] font-mono hidden sm:inline">
                      · ${b.totalRetail.toFixed(0)} retail
                      {b.totalBasis > 0
                        ? ` · $${b.totalBasis.toFixed(2)} COGS`
                        : ""}
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {onSetBinAudit && binHasAudited && (
                      <button
                        type="button"
                        onClick={() => {
                          const ids = fullBin.items
                            .filter((x) => x.auditStatus !== null)
                            .map((x) => x.id);
                          if (ids.length > 0) {
                            void onSetBinAudit(ids, null);
                          }
                        }}
                        title={`Reset audit checkmarks for ${b.bin}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#5C606B] hover:border-[#B91C1C] hover:text-[#B91C1C] cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span className="hidden sm:inline">Reset</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => printThermalSkuLabels(b.items)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
                    >
                      <Tag className="w-3 h-3" />
                      <span>2×1 Labels</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => printBinAuditSheet(b.bin, b.items)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
                    >
                      <Printer className="w-3 h-3" />
                      <span>Audit Sheet</span>
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="divide-y divide-[#F1F1EC] border-t border-[#ECECE6]">
                    {b.items.map((it) => {
                      const isVerified = it.auditStatus === "verified";
                      const isMissing = it.auditStatus === "missing";
                      const shortDate = formatShortAuditDate(it.auditVerifiedAt);
                      return (
                        <div
                          key={it.id}
                          className={`px-4 py-2.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 text-xs transition ${
                            isVerified
                              ? "bg-[#ECFDF5]/45"
                              : isMissing
                                ? "bg-[#FEF2F2]/60"
                                : "hover:bg-[#FAFBF9]"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {it.thumbUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={it.thumbUrl}
                                alt=""
                                className="w-10 h-10 rounded-lg object-cover border border-[#E5E8E6] shrink-0 bg-[#FAFBF9]"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-lg border border-[#E5E8E6] bg-[#FAFBF9] flex items-center justify-center text-[10px] text-[#8E969D] shrink-0">
                                SKU
                              </div>
                            )}

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono font-bold text-[#14151A]">
                                  {it.sku}
                                </span>
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                                    it.status === "draft"
                                      ? "bg-[#FEF3C7] text-[#92400E]"
                                      : "bg-[#ECFDF5] text-[#0F766E]"
                                  }`}
                                >
                                  {it.status === "draft"
                                    ? "Death Pile"
                                    : "Active"}
                                </span>
                                {isVerified && shortDate && (
                                  <span className="text-[10px] font-semibold text-[#0F766E]">
                                    ✓ Confirmed {shortDate}
                                  </span>
                                )}
                                {isMissing && (
                                  <span className="text-[10px] font-bold text-[#B91C1C]">
                                    ⚠ Flagged Missing{shortDate ? ` ${shortDate}` : ""}
                                  </span>
                                )}
                                {it.parsedSource && (
                                  <span className="text-[10px] font-mono text-[#6B7280] hidden md:inline">
                                    · {it.parsedSource}
                                  </span>
                                )}
                              </div>

                              {it.radarRow ? (
                                <button
                                  type="button"
                                  onClick={() => onOpenItemDetail(it.radarRow!)}
                                  className={`text-left text-xs hover:text-[#0F766E] hover:underline truncate block w-full cursor-pointer mt-0.5 ${
                                    isVerified
                                      ? "text-[#5C606B]"
                                      : "text-[#14151A] font-medium"
                                  }`}
                                >
                                  {it.title}
                                </button>
                              ) : (
                                <div className="text-xs text-[#444B52] truncate mt-0.5">
                                  {it.title}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                            <span className="font-mono font-semibold text-[#14151A] mr-1">
                              ${Number(it.price || 0).toFixed(2)}
                            </span>

                            {onSetBinAudit && (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void onSetBinAudit(
                                      [it.id],
                                      isVerified ? null : "verified"
                                    )
                                  }
                                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                                    isVerified
                                      ? "bg-[#0F766E] border-[#0F766E] text-white hover:bg-[#0B5B55]"
                                      : "bg-white border-[#CBD5E1] text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E]"
                                  }`}
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  <span>{isVerified ? "Verified" : "Verify"}</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() =>
                                    void onSetBinAudit(
                                      [it.id],
                                      isMissing ? null : "missing"
                                    )
                                  }
                                  title="Flag item as not found in this bin"
                                  className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${
                                    isMissing
                                      ? "bg-[#B91C1C] border-[#B91C1C] text-white hover:bg-[#991B1B]"
                                      : "bg-white border-[#E4E4DD] text-[#6B7280] hover:border-[#FCA5A5] hover:text-[#B91C1C]"
                                  }`}
                                >
                                  <AlertTriangle className="w-3 h-3" />
                                  <span className="hidden sm:inline">
                                    Missing
                                  </span>
                                </button>
                              </>
                            )}

                            <button
                              type="button"
                              onClick={() => printThermalSkuLabels([it])}
                              title={`Print 2×1 thermal label for ${it.sku}`}
                              className="px-2 py-1.5 rounded-lg border border-[#E4E4DD] bg-white text-[10px] font-semibold text-[#5C606B] hover:text-[#0F766E] hover:border-[#0F766E] cursor-pointer"
                            >
                              🏷️
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
