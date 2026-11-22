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

/**
 * Parses custom reseller SKUs formatted as:
 *   "Where bought, Date, Bin/Location, SKU #"
 * Examples:
 *   "SA828. 9/16/25 Shelf L - 2044"           -> bin: "SHELF L", source: "SA828", date: "9/16/25", item#: "2044"
 *   "SA828 9/16/25. Shelf M - 7042"           -> bin: "SHELF M", source: "SA828", date: "9/16/25", item#: "7042"
 *   "SA898. 9/16/25 G3 (1 Garage / 7 storage)"-> bin: "G3",      source: "SA898", date: "9/16/25"
 *   "Mom3. 44. 9/8/25"                        -> bin: "BIN 44",  source: "Mom3",  date: "9/8/25"
 */
function parseCustomSkuLocation(
  skuRaw: string | null | undefined,
  explicitBinRaw: string | null | undefined
): ParsedSkuMeta {
  const explicitBin = (explicitBinRaw || "").trim();
  const sku = (skuRaw || "").trim();

  // Extract date token like 9/16/25, 09/16/2025, 9-16-25
  const dateRe = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;
  const dateMatch = sku.match(dateRe);

  let source: string | null = null;
  let dateStr: string | null = null;
  let itemNumber: string | null = null;
  let extractedBin = "";

  if (dateMatch && dateMatch.index !== undefined) {
    dateStr = dateMatch[1];
    const before = sku
      .slice(0, dateMatch.index)
      .replace(/[.,;:\-–—]+$/g, "")
      .trim();
    const after = sku
      .slice(dateMatch.index + dateMatch[0].length)
      .replace(/^[.,;:\-–—\s]+/g, "")
      .trim();

    if (before) {
      // Check if "before" has "Source. Location" (e.g. "Mom3. 44")
      const beforeParts = before
        .split(/[.,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      source = beforeParts[0] || before;
      if (!after && beforeParts.length >= 2) {
        const preLoc = beforeParts.slice(1).join(" ").trim();
        if (preLoc) {
          extractedBin = /^\d+$/.test(preLoc) ? `BIN ${preLoc}` : preLoc;
        }
      }
    }

    if (after) {
      // Remove parenthetical notes like "(1 Garage / 7 storage)" from the grouping key
      let locPart = after.replace(/\([^)]*\)/g, " ").trim();

      // Strip trailing SKU # after dash, hash, comma, or period (e.g. "- 2044", "#2044", ", 2044", ". 2044")
      const dashMatch = locPart.match(/^(.*?)\s*(?:[-–—#,.])\s*(\d{2,6}[A-Za-z]?)\s*$/);
      if (dashMatch && dashMatch[1].trim()) {
        locPart = dashMatch[1].trim();
        itemNumber = dashMatch[2].trim();
      } else {
        // Also handle space-separated trailing 3-6 digit SKU number (e.g. "Shelf L 2044")
        const trailNum = locPart.match(/^(.+?)\s+(\d{3,6})\s*$/);
        if (trailNum && trailNum[1].trim()) {
          locPart = trailNum[1].trim();
          itemNumber = trailNum[2].trim();
        }
      }

      locPart = locPart
        .replace(/^[.,;:\-–—\s]+|[.,;:\-–—\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (locPart) {
        extractedBin = /^\d{1,3}$/.test(locPart) ? `BIN ${locPart}` : locPart;
      }
    }
  } else if (sku) {
    // Fallback when no date appears in SKU: look for explicit Shelf/Bin/Tote/Rack/Garage/Box keywords
    const kwMatch = sku.match(
      /\b((?:shelf|bin|tote|rack|box|tub|drawer|closet|garage|storage|row|aisle|cabinet|bay)\s*[A-Za-z0-9-]+)\b/i
    );
    if (kwMatch) {
      extractedBin = kwMatch[1].replace(/\s+/g, " ").trim();
    }
  }

  const chosen =
    explicitBin && explicitBin.toUpperCase() !== "UNASSIGNED"
      ? explicitBin
      : extractedBin || "UNASSIGNED";

  return {
    bin: chosen.replace(/\s+/g, " ").trim().toUpperCase(),
    source,
    dateStr,
    itemNumber,
  };
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
      const parsed = parseCustomSkuLocation(r.sku, r.bin_location);
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
      const parsed = parseCustomSkuLocation(d.sku, d.bin_location);
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
      if (a.bin === "UNASSIGNED") return 1;
      if (b.bin === "UNASSIGNED") return -1;
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

  const assignedBinCount = allBins.filter((b) => b.bin !== "UNASSIGNED").length;

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
                Automatically grouped by the Bin / Shelf location inside your
                custom SKU (Source · Date · <strong>Location</strong> · SKU #).
                Click any location below to expand everything stored there.
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
            const isUnassigned = b.bin === "UNASSIGNED";
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
                      className={`px-2.5 py-1 rounded-lg font-mono text-xs font-bold ${
                        isUnassigned
                          ? "bg-[#E5E7EB] text-[#4B5563]"
                          : "bg-[#0F766E] text-white"
                      }`}
                    >
                      {b.bin}
                    </span>
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
