"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  MapPin,
  Printer,
  Search,
  Tag,
} from "lucide-react";
import {
  printBinAuditSheet,
  printThermalSkuLabels,
  type ThermalLabelItem,
} from "@/lib/thermal-label";
import type { InventoryItem, StaleRadarRow } from "@/lib/types";

interface BinAuditPanelProps {
  activeItems: StaleRadarRow[];
  draftItems: InventoryItem[];
  onOpenItemDetail: (row: StaleRadarRow) => void;
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
      radarRow?: StaleRadarRow;
    }
  >;
  totalBasis: number;
  totalRetail: number;
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

  const garageBin = cleaned.match(
    /(?:^|[^A-Za-z0-9])G\s*[-#]?([1-9])(?=$|[^A-Za-z0-9])/i
  );
  if (garageBin) return `G${garageBin[1]}`;

  if (/\bcloset\b/i.test(cleaned)) return "Closet";
  if (/\brack\b/i.test(cleaned)) return "Rack";
  if (/^clothes?$/i.test(cleaned)) return "Clothes";

  return cleaned;
}

/**
 * Parses custom reseller SKUs into clean physical locations:
 *  1) Any "Shelf <Letter>" anywhere in SKU -> "Shelf A", "Shelf E", "Shelf F", ...
 *  2) Garage bins G1–G9 anywhere in SKU    -> "G1", "G2", "G3", "G4", "G5", ...
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
        !/^G[1-9]$/i.test(firstToken) &&
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

  // Priority 2: Garage bins G1, G2, G3, G4, G5 (up to G9)
  const garageBinMatch =
    sku.match(/(?:^|[^A-Za-z0-9])G\s*[-#]?([1-9])(?=$|[^A-Za-z0-9])/i) ||
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
  // Strip storage count notes like "(1 Garage / 7 storage)", dates, and punctuation/asterisks
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
  onOpenItemDetail,
}: BinAuditPanelProps) {
  const [search, setSearch] = useState("");
  const [selectedBinFilter, setSelectedBinFilter] = useState<string>("ALL");
  const [expandedBins, setExpandedBins] = useState<Set<string>>(new Set());

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
        bucket = { bin: binKey, items: [], totalBasis: 0, totalRetail: 0 };
        map.set(binKey, bucket);
      }
      bucket.items.push(entry);
      bucket.totalBasis += basis;
      bucket.totalRetail += retail;
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

  const visibleBins = useMemo<BinEntry[]>(() => {
    const q = search.trim().toLowerCase();
    return allBins
      .filter((b) => selectedBinFilter === "ALL" || b.bin === selectedBinFilter)
      .map((b) => {
        if (!q) return b;
        if (b.bin.toLowerCase().includes(q)) return b;
        const matchedItems = b.items.filter(
          (i) =>
            i.sku.toLowerCase().includes(q) ||
            i.title.toLowerCase().includes(q) ||
            (i.parsedSource?.toLowerCase().includes(q) ?? false)
        );
        return {
          ...b,
          items: matchedItems,
          totalBasis: matchedItems.reduce((s, x) => s + (x.cogs || 0), 0),
          totalRetail: matchedItems.reduce((s, x) => s + (x.price || 0), 0),
        };
      })
      .filter((b) => b.items.length > 0);
  }, [allBins, search, selectedBinFilter]);

  const allVisibleLabels = useMemo(
    () => visibleBins.flatMap((b) => b.items),
    [visibleBins]
  );

  const isBinOpen = (binName: string) => {
    // Auto-open when searching or filtered to a single bin
    if (search.trim().length > 0 || selectedBinFilter !== "ALL") return true;
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
                Grouped by <strong>Shelf A–Z</strong>, Garage{" "}
                <strong>G1–G5</strong>, <strong>Closet</strong>,{" "}
                <strong>Rack</strong>, and <strong>Clothes</strong>. Click any
                location to expand everything stored there.
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
                    {b.bin} ({b.items.length}{" "}
                    {b.items.length === 1 ? "item" : "items"})
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
          No items match your current location or search filter.
        </div>
      ) : (
        <div className="space-y-2.5">
          {visibleBins.map((b) => {
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
                className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.02)]"
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
                  className="w-full px-4 py-3 bg-[#FAF9F6] hover:bg-[#F3F5F3] transition flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
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
                    <span className="text-xs text-[#5C606B] font-mono">
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
                    {b.items.map((it) => (
                      <div
                        key={it.id}
                        className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-[#FAFBF9]"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {it.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={it.thumbUrl}
                              alt=""
                              className="w-9 h-9 rounded-lg object-cover border border-[#E5E8E6] shrink-0 bg-[#FAFBF9]"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-lg border border-[#E5E8E6] bg-[#FAFBF9] flex items-center justify-center text-[10px] text-[#8E969D] shrink-0">
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
                                {it.status === "draft" ? "Death Pile" : "Active"}
                              </span>
                              {it.parsedSource && (
                                <span className="text-[10px] font-mono text-[#6B7280]">
                                  Source: {it.parsedSource}
                                </span>
                              )}
                              {it.parsedDate && (
                                <span className="text-[10px] font-mono text-[#6B7280]">
                                  · {it.parsedDate}
                                </span>
                              )}
                            </div>

                            {it.radarRow ? (
                              <button
                                type="button"
                                onClick={() => onOpenItemDetail(it.radarRow!)}
                                className="text-left text-xs text-[#444B52] hover:text-[#0F766E] hover:underline truncate block w-full cursor-pointer mt-0.5"
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

                        <div className="flex items-center gap-2.5 shrink-0">
                          <span className="font-mono font-semibold text-[#14151A]">
                            ${Number(it.price || 0).toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => printThermalSkuLabels([it])}
                            title={`Print 2×1 thermal label for ${it.sku}`}
                            className="px-2 py-1 rounded border border-[#E4E4DD] text-[10px] font-semibold text-[#5C606B] hover:text-[#0F766E] hover:border-[#0F766E] cursor-pointer"
                          >
                            🏷️ Label
                          </button>
                        </div>
                      </div>
                    ))}
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
