"use client";

import { useMemo, useState } from "react";
import { Archive, Printer, Search, Tag } from "lucide-react";
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

interface BinEntry {
  bin: string;
  items: Array<
    ThermalLabelItem & {
      id: string;
      status: "active" | "draft";
      radarRow?: StaleRadarRow;
    }
  >;
  totalBasis: number;
}

export function BinAuditPanel({
  activeItems,
  draftItems,
  onOpenItemDetail,
}: BinAuditPanelProps) {
  const [search, setSearch] = useState("");

  const bins = useMemo<BinEntry[]>(() => {
    const map = new Map<string, BinEntry>();
    const add = (
      binRaw: string | null | undefined,
      entry: BinEntry["items"][number],
      basis: number
    ) => {
      const bin = (binRaw || "UNASSIGNED").trim().toUpperCase();
      let bucket = map.get(bin);
      if (!bucket) {
        bucket = { bin, items: [], totalBasis: 0 };
        map.set(bin, bucket);
      }
      bucket.items.push(entry);
      bucket.totalBasis += basis;
    };

    for (const r of activeItems) {
      add(
        r.bin_location,
        {
          id: r.item_id,
          sku: r.sku,
          bin: r.bin_location,
          title: r.title,
          acquiredAt: r.acquired_at,
          cogs: r.total_cost_basis,
          price: r.listed_price,
          status: "active",
          radarRow: r,
        },
        r.total_cost_basis
      );
    }

    for (const d of draftItems) {
      const basis = (d.cogs || 0) + (d.prep_cost || 0);
      add(
        d.bin_location,
        {
          id: d.id,
          sku: d.sku,
          bin: d.bin_location,
          title: d.title,
          acquiredAt: d.acquired_at,
          cogs: basis,
          price: d.target_price,
          status: "draft",
        },
        basis
      );
    }

    const q = search.trim().toLowerCase();
    return [...map.values()]
      .filter((b) => {
        if (!q) return true;
        return (
          b.bin.toLowerCase().includes(q) ||
          b.items.some(
            (i) =>
              i.sku.toLowerCase().includes(q) ||
              i.title.toLowerCase().includes(q)
          )
        );
      })
      .sort((a, b) => a.bin.localeCompare(b.bin));
  }, [activeItems, draftItems, search]);

  const allVisibleLabels = useMemo(
    () => bins.flatMap((b) => b.items),
    [bins]
  );

  return (
    <div className="space-y-4">
      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E] flex items-center justify-center shrink-0">
            <Archive className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-[#14151A]">
              Bin / Tote Lookup &amp; 2×1 Thermal SKU Label Printer
            </h2>
            <p className="text-xs text-[#5C606B] mt-0.5">
              Audit any storage shelf or tote in one second, print 2.25&quot;×1.25&quot;
              thermal poly-bag stickers (Rollo / Dymo / Munbyn), or print a
              tote verification sheet.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#8E969D] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter bin, SKU, title…"
              className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#DDE2DF] w-52 focus:border-[#0F766E] focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={allVisibleLabels.length === 0}
            onClick={() => printThermalSkuLabels(allVisibleLabels)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print All {allVisibleLabels.length} Labels</span>
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {bins.map((b) => (
          <section
            key={b.bin}
            className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden flex flex-col"
          >
            <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="px-2.5 py-1 rounded-lg bg-[#0F766E] text-white font-mono text-xs font-bold">
                  BIN {b.bin}
                </span>
                <span className="text-xs text-[#5C606B] font-mono">
                  {b.items.length} SKU{b.items.length === 1 ? "" : "s"} · $
                  {b.totalBasis.toFixed(2)} basis
                </span>
              </div>
              <div className="flex items-center gap-1.5">
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

            <div className="divide-y divide-[#F1F1EC]">
              {b.items.map((it) => (
                <div
                  key={it.id}
                  className="px-4 py-2.5 flex items-center justify-between gap-2 text-xs hover:bg-[#FAFBF9]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
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
                    </div>
                    {it.radarRow ? (
                      <button
                        type="button"
                        onClick={() => onOpenItemDetail(it.radarRow!)}
                        className="text-left text-[11px] text-[#5C606B] hover:text-[#0F766E] hover:underline truncate block w-full cursor-pointer"
                      >
                        {it.title}
                      </button>
                    ) : (
                      <div className="text-[11px] text-[#5C606B] truncate">
                        {it.title}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => printThermalSkuLabels([it])}
                    title={`Print 2×1 thermal label for ${it.sku}`}
                    className="px-2 py-1 rounded border border-[#E4E4DD] text-[10px] font-semibold text-[#5C606B] hover:text-[#0F766E] hover:border-[#0F766E] cursor-pointer shrink-0"
                  >
                    🏷️ Label
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
