"use client";

import { useMemo, useState } from "react";
import {
  Boxes,
  Check,
  Edit3,
  Link2,
  Loader2,
  Lock,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import type {
  BulkBuyRecord,
  DisposedInventoryRecord,
  InventoryItem,
  SalesOrderRecord,
  StaleRadarRow,
} from "@/lib/types";

interface BulkBuysPanelProps {
  bulkBuys: BulkBuyRecord[];
  activeItems: StaleRadarRow[];
  draftItems: InventoryItem[];
  salesOrders: SalesOrderRecord[];
  disposedItems: DisposedInventoryRecord[];
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  onSelectActiveItem?: (row: StaleRadarRow) => void;
}

interface UnifiedLotItem {
  id: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  status: "Active" | "Draft" | "Sold" | "Donated" | "Discarded";
  binLocation: string | null;
  cogs: number;
  listedPrice: number;
  grossSales: number;
  netBeforeCogs: number;
  soldYear: number | null;
  isClosedTaxYear: boolean;
  bulkBuyId: string | null;
  bulkBuyLocked: boolean;
  units: number;
  activeRow?: StaleRadarRow;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  storage_auction: "Storage Auction",
  pallet_liquidation: "Pallet Liquidation",
  estate_sale: "Estate Sale",
  garage_sale: "Garage / Yard Sale",
  wholesale: "Wholesale / Direct Buy",
  thrift: "Thrift Haul",
  bins: "Goodwill Bins",
  online_arbitrage: "Online Lot / FBM",
};

function fmtMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

/**
 * Extracts likely storage-auction / pallet lot prefixes from existing SKUs
 * (e.g., "SA926", "SA730", "PALLET12", "LOT44") so the user can spin up
 * Bulk Buys in 1 click without manually tagging 50+ items.
 */
function extractDetectedLotCode(sku: string): string | null {
  const s = sku.trim().toUpperCase();
  if (!s || s.startsWith("EBAY-") || s.startsWith("__RCC_")) return null;
  const m = s.match(
    /^(SA\d{2,5}|PALLET[-#]?\d+|LOT[-#]?\d+|UNIT[-#]?\d+|LIQ[-#]?\d+|AUCTION[-#]?\d+)(?=\s|$|[-_/])/i
  );
  return m ? m[1].toUpperCase() : null;
}

export function BulkBuysPanel({
  bulkBuys,
  activeItems,
  draftItems,
  salesOrders,
  disposedItems,
  onRefresh,
  onToast,
  onSelectActiveItem,
}: BulkBuysPanelProps) {
  const currentYear = new Date().getFullYear();

  // Build unified catalog of every inventory item across Active, Draft, Sold, and Disposed
  const allUnifiedItems = useMemo<UnifiedLotItem[]>(() => {
    const map = new Map<string, UnifiedLotItem>();

    // 1. Active items
    for (const row of activeItems) {
      map.set(row.item_id, {
        id: row.item_id,
        sku: row.sku,
        title: row.title,
        imageUrl: row.image_urls[0] || null,
        status: "Active",
        binLocation: row.bin_location,
        cogs: Number(row.cogs || 0),
        listedPrice: Number(row.listed_price || 0),
        grossSales: 0,
        netBeforeCogs: 0,
        soldYear: null,
        isClosedTaxYear: false,
        bulkBuyId: row.bulk_buy_id ?? null,
        bulkBuyLocked: Boolean(row.bulk_buy_locked),
        units: Math.max(1, row.quantity_available || 1),
        activeRow: row,
      });
    }

    // 2. Draft items
    for (const d of draftItems) {
      if (map.has(d.id)) continue;
      const sp = (d.item_specifics || {}) as Record<string, unknown>;
      map.set(d.id, {
        id: d.id,
        sku: d.sku,
        title: d.title,
        imageUrl: d.image_urls?.[0] || null,
        status: "Draft",
        binLocation: d.bin_location,
        cogs: Number(d.cogs || 0),
        listedPrice: Number(d.target_price || 0),
        grossSales: 0,
        netBeforeCogs: 0,
        soldYear: null,
        isClosedTaxYear: false,
        bulkBuyId:
          typeof sp.bulk_buy_id === "string" && sp.bulk_buy_id.trim()
            ? sp.bulk_buy_id.trim()
            : null,
        bulkBuyLocked:
          sp.bulk_buy_locked === true || sp.bulk_buy_locked === "true",
        units: 1,
      });
    }

    // 3. Disposed (Donated / Discarded) items
    for (const disp of disposedItems) {
      if (map.has(disp.id)) continue;
      map.set(disp.id, {
        id: disp.id,
        sku: disp.sku,
        title: disp.title,
        imageUrl: disp.image_url,
        status: disp.disposal_status === "donated" ? "Donated" : "Discarded",
        binLocation: disp.bin_location,
        cogs: Number(disp.cogs || 0),
        listedPrice: 0,
        grossSales: 0,
        netBeforeCogs: 0,
        soldYear: null,
        isClosedTaxYear: false,
        bulkBuyId: disp.bulk_buy_id,
        bulkBuyLocked: disp.bulk_buy_locked,
        units: 1,
      });
    }

    // 4. Sold orders (merge sales revenue into active multi-qty items or create Sold entry)
    for (const o of salesOrders) {
      if (o.fulfillment_status === "unpaid") continue;
      const soldYr = new Date(o.sold_at).getFullYear();
      const validYr = Number.isFinite(soldYr) ? soldYr : null;
      const existing = map.get(o.item_id);
      const orderGross = Math.max(
        0,
        Number(o.gross_sale_price || 0) - Number(o.refund_amount || 0)
      );
      const orderNetBeforeCogs = Number(o.net_profit || 0);

      if (existing) {
        existing.grossSales += orderGross;
        existing.netBeforeCogs += orderNetBeforeCogs;
        if (
          validYr !== null &&
          (existing.soldYear === null || validYr < existing.soldYear)
        ) {
          existing.soldYear = validYr;
          existing.isClosedTaxYear = validYr < currentYear;
        }
        if (!existing.bulkBuyId && o.bulk_buy_id) {
          existing.bulkBuyId = o.bulk_buy_id;
          existing.bulkBuyLocked = Boolean(o.bulk_buy_locked);
        }
      } else {
        map.set(o.item_id, {
          id: o.item_id,
          sku: o.sku,
          title: o.title,
          imageUrl: o.image_url ?? null,
          status: "Sold",
          binLocation: o.bin_location ?? "Shipped",
          cogs: Number(o.cogs || 0),
          listedPrice: 0,
          grossSales: orderGross,
          netBeforeCogs: orderNetBeforeCogs,
          soldYear: validYr,
          isClosedTaxYear: validYr !== null && validYr < currentYear,
          bulkBuyId: o.bulk_buy_id ?? null,
          bulkBuyLocked: Boolean(o.bulk_buy_locked),
          units: 1,
        });
      }
    }

    return [...map.values()];
  }, [activeItems, draftItems, disposedItems, salesOrders, currentYear]);

  // Auto-detect unlinked storage auction / pallet lot codes from SKUs (e.g. SA926, SA730)
  const detectedLotSuggestions = useMemo(() => {
    const existingCodes = new Set(
      bulkBuys
        .map((b) => b.lot_code?.trim().toUpperCase())
        .filter((v): v is string => Boolean(v))
    );
    const counts = new Map<string, number>();
    for (const it of allUnifiedItems) {
      if (it.bulkBuyId) continue;
      const code = extractDetectedLotCode(it.sku);
      if (!code || existingCodes.has(code)) continue;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([code, count]) => ({ code, count }));
  }, [allUnifiedItems, bulkBuys]);

  const [selectedId, setSelectedId] = useState<string | null>(
    bulkBuys[0]?.id ?? null
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddItemsModal, setShowAddItemsModal] = useState(false);
  const [statusFilter, setStatusFilter] = useState<
    "All" | "Active" | "Draft" | "Sold" | "Disposed"
  >("All");
  const [itemSearch, setItemSearch] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newLotCode, setNewLotCode] = useState("");
  const [newTotalSpent, setNewTotalSpent] = useState("");
  const [newPurchaseDate, setNewPurchaseDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [newSourceType, setNewSourceType] = useState("storage_auction");
  const [newSourceLocation, setNewSourceLocation] = useState("");
  const [newStorageLocation, setNewStorageLocation] = useState("");
  const [newNotes, setNewNotes] = useState("");

  // Inline bulk buy header edit state
  const [editingHeader, setEditingHeader] = useState(false);
  const [editName, setEditName] = useState("");
  const [editLotCode, setEditLotCode] = useState("");
  const [editTotalSpent, setEditTotalSpent] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editSourceLocation, setEditSourceLocation] = useState("");
  const [editSourceType, setEditSourceType] = useState("storage_auction");
  const [editStorageLocation, setEditStorageLocation] = useState("");
  const [editSplitMode, setEditSplitMode] = useState<"even" | "by_unit">("even");
  const [editNotes, setEditNotes] = useState("");

  // Lock / Unlock item cost modal state (mirrors Flipwise's crisp confirmation modal!)
  const [lockModalItem, setLockModalItem] = useState<{
    item: UnifiedLotItem;
    nextCost: string;
    mode: "lock" | "unlock";
  } | null>(null);

  // Add-items picker state
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());

  const activeBulkBuy = useMemo(
    () =>
      bulkBuys.find((b) => b.id === selectedId) ?? bulkBuys[0] ?? null,
    [bulkBuys, selectedId]
  );

  // Compute live P&L metrics for every Bulk Buy (used for sidebar cards + detail view)
  const metricsByLot = useMemo(() => {
    const out = new Map<
      string,
      {
        items: UnifiedLotItem[];
        totalItems: number;
        soldCount: number;
        activeCount: number;
        draftCount: number;
        disposedCount: number;
        activeListValue: number;
        grossSales: number;
        netProfitAfterFullLot: number;
        realizedNetProfit: number;
        overallRoiPct: number;
        realizedRoiPct: number;
        soldPct: number;
        closedYearHeld: number;
        closedYearCount: number;
        lockedHeld: number;
        lockedCount: number;
        sharedHeld: number;
        sharedCount: number;
      }
    >();

    for (const bb of bulkBuys) {
      const lotItems = allUnifiedItems.filter((it) => it.bulkBuyId === bb.id);
      const soldItems = lotItems.filter(
        (it) => it.status === "Sold" || it.grossSales > 0
      );
      const activeOnly = lotItems.filter((it) => it.status === "Active");
      const draftOnly = lotItems.filter((it) => it.status === "Draft");
      const disposedOnly = lotItems.filter(
        (it) => it.status === "Donated" || it.status === "Discarded"
      );

      const activeListValue = activeOnly.reduce(
        (s, it) => s + it.listedPrice * it.units,
        0
      );
      const grossSales = lotItems.reduce((s, it) => s + it.grossSales, 0);
      const totalNetBeforeCogs = lotItems.reduce(
        (s, it) => s + it.netBeforeCogs,
        0
      );
      const soldCogs = soldItems.reduce((s, it) => s + it.cogs, 0);

      // Net Profit (after full lot cost) vs Realized Net Profit (only COGS of sold items)
      const netProfitAfterFullLot = totalNetBeforeCogs - bb.total_spent;
      const realizedNetProfit = totalNetBeforeCogs - soldCogs;
      const overallRoiPct =
        bb.total_spent > 0 ? (netProfitAfterFullLot / bb.total_spent) * 100 : 0;
      const realizedRoiPct =
        soldCogs > 0 ? (realizedNetProfit / soldCogs) * 100 : 0;

      let closedYearHeld = 0;
      let closedYearCount = 0;
      let lockedHeld = 0;
      let lockedCount = 0;
      let sharedHeld = 0;
      let sharedCount = 0;

      for (const it of lotItems) {
        if (it.isClosedTaxYear) {
          closedYearHeld += it.cogs;
          closedYearCount += 1;
        } else if (it.bulkBuyLocked) {
          lockedHeld += it.cogs;
          lockedCount += 1;
        } else {
          sharedHeld += it.cogs;
          sharedCount += 1;
        }
      }

      out.set(bb.id, {
        items: lotItems,
        totalItems: lotItems.length,
        soldCount: soldItems.length,
        activeCount: activeOnly.length,
        draftCount: draftOnly.length,
        disposedCount: disposedOnly.length,
        activeListValue,
        grossSales,
        netProfitAfterFullLot,
        realizedNetProfit,
        overallRoiPct,
        realizedRoiPct,
        soldPct:
          lotItems.length > 0
            ? Math.round((soldItems.length / lotItems.length) * 100)
            : 0,
        closedYearHeld,
        closedYearCount,
        lockedHeld,
        lockedCount,
        sharedHeld,
        sharedCount,
      });
    }

    return out;
  }, [bulkBuys, allUnifiedItems]);

  const activeMetrics = activeBulkBuy
    ? metricsByLot.get(activeBulkBuy.id) ?? null
    : null;

  const filteredLotItems = useMemo(() => {
    if (!activeMetrics) return [];
    const q = itemSearch.trim().toLowerCase();
    return activeMetrics.items.filter((it) => {
      if (statusFilter === "Active" && it.status !== "Active") return false;
      if (statusFilter === "Draft" && it.status !== "Draft") return false;
      if (statusFilter === "Sold" && it.status !== "Sold" && it.grossSales <= 0)
        return false;
      if (
        statusFilter === "Disposed" &&
        it.status !== "Donated" &&
        it.status !== "Discarded"
      )
        return false;
      if (q) {
        return (
          it.title.toLowerCase().includes(q) ||
          it.sku.toLowerCase().includes(q) ||
          (it.binLocation || "").toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [activeMetrics, statusFilter, itemSearch]);

  const availablePickerItems = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return allUnifiedItems
      .filter((it) => !it.bulkBuyId)
      .filter((it) => {
        if (!q) return true;
        return (
          it.sku.toLowerCase().includes(q) ||
          it.title.toLowerCase().includes(q) ||
          (it.binLocation || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 120);
  }, [allUnifiedItems, pickerSearch]);

  const openCreateForDetectedLot = (code: string) => {
    setNewLotCode(code);
    setNewName(
      code.startsWith("SA")
        ? `Storage Auction ${code}`
        : code.startsWith("PALLET")
          ? `Liquidation ${code}`
          : `Bulk Buy ${code}`
    );
    setNewSourceType(
      code.startsWith("PALLET") || code.startsWith("LIQ")
        ? "pallet_liquidation"
        : "storage_auction"
    );
    setNewSourceLocation(
      code.startsWith("PALLET") || code.startsWith("LIQ")
        ? "Pallet Liquidation"
        : "Storage Auction"
    );
    setNewTotalSpent("");
    setNewStorageLocation("");
    setNewNotes("");
    setShowCreateModal(true);
  };

  const openEditHeader = (bb: BulkBuyRecord) => {
    setEditName(bb.name);
    setEditLotCode(bb.lot_code || "");
    setEditTotalSpent(String(bb.total_spent));
    setEditDate(bb.purchase_date);
    setEditSourceLocation(bb.source_location);
    setEditSourceType(bb.source_type || "storage_auction");
    setEditStorageLocation(bb.storage_location || "");
    setEditSplitMode(bb.split_mode || "even");
    setEditNotes(bb.notes || "");
    setEditingHeader(true);
  };

  const callBulkApi = async (
    payload: Record<string, unknown>,
    busyKey: string
  ): Promise<{ bulkBuy?: BulkBuyRecord; message?: string } | null> => {
    setBusyAction(busyKey);
    try {
      const res = await fetch("/api/bulk-buys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        onToast(data.error || "Bulk buy action failed");
        return null;
      }
      if (data.message) onToast(data.message);
      await onRefresh();
      return data;
    } catch {
      onToast("Network error saving bulk buy");
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await callBulkApi(
      {
        action: "create",
        name: newName,
        lot_code: newLotCode || null,
        total_spent: Number(newTotalSpent) || 0,
        purchase_date: newPurchaseDate,
        source_type: newSourceType,
        source_location: newSourceLocation || SOURCE_TYPE_LABELS[newSourceType] || "Storage Auction",
        storage_location: newStorageLocation || null,
        notes: newNotes || null,
        autoMatchLotCode: Boolean(newLotCode.trim()),
      },
      "create"
    );
    if (res?.bulkBuy) {
      setSelectedId(res.bulkBuy.id);
      setShowCreateModal(false);
      setNewName("");
      setNewLotCode("");
      setNewTotalSpent("");
      setNewSourceLocation("");
      setNewStorageLocation("");
      setNewNotes("");
    }
  };

  const handleSaveHeader = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeBulkBuy) return;
    const res = await callBulkApi(
      {
        action: "update",
        id: activeBulkBuy.id,
        name: editName,
        lot_code: editLotCode || null,
        total_spent: Number(editTotalSpent) || 0,
        purchase_date: editDate,
        source_location: editSourceLocation,
        source_type: editSourceType,
        storage_location: editStorageLocation || null,
        split_mode: editSplitMode,
        notes: editNotes || null,
      },
      "update"
    );
    if (res) setEditingHeader(false);
  };

  const handleConfirmLockOrUnlock = async () => {
    if (!activeBulkBuy || !lockModalItem) return;
    if (lockModalItem.mode === "lock") {
      const parsed = Math.max(0, Number(lockModalItem.nextCost) || 0);
      await callBulkApi(
        {
          action: "lock_item_cost",
          id: activeBulkBuy.id,
          itemId: lockModalItem.item.id,
          cost: parsed,
        },
        `lock-${lockModalItem.item.id}`
      );
    } else {
      await callBulkApi(
        {
          action: "unlock_item_cost",
          id: activeBulkBuy.id,
          itemId: lockModalItem.item.id,
        },
        `unlock-${lockModalItem.item.id}`
      );
    }
    setLockModalItem(null);
  };

  const handleAddPickedItems = async () => {
    if (!activeBulkBuy || pickerSelected.size === 0) return;
    const res = await callBulkApi(
      {
        action: "add_items",
        id: activeBulkBuy.id,
        itemIds: [...pickerSelected],
      },
      "add-items"
    );
    if (res) {
      setPickerSelected(new Set());
      setShowAddItemsModal(false);
    }
  };

  const handleDeleteLot = async (bb: BulkBuyRecord) => {
    if (
      !window.confirm(
        `Delete bulk buy "${bb.name}"? Your items stay in inventory with their current COGS.`
      )
    ) {
      return;
    }
    const res = await callBulkApi({ action: "delete", id: bb.id }, `del-${bb.id}`);
    if (res && selectedId === bb.id) {
      setSelectedId(null);
    }
  };

  // Portfolio-wide bulk buy summary
  const portfolioSummary = useMemo(() => {
    let totalSpent = 0;
    let totalGross = 0;
    let totalNet = 0;
    let totalActiveValue = 0;
    for (const bb of bulkBuys) {
      totalSpent += bb.total_spent;
      const m = metricsByLot.get(bb.id);
      if (m) {
        totalGross += m.grossSales;
        totalNet += m.netProfitAfterFullLot;
        totalActiveValue += m.activeListValue;
      }
    }
    return { totalSpent, totalGross, totalNet, totalActiveValue };
  }, [bulkBuys, metricsByLot]);

  return (
    <div className="space-y-5">
      {/* Header + Portfolio Strip */}
      <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Boxes className="w-5 h-5 text-[#0F766E]" />
              <h2 className="text-base font-bold text-[#14151A]">
                Bulk Buys — Storage Auctions &amp; Pallet Liquidations
              </h2>
            </div>
            <p className="text-xs text-[#5C606B] mt-0.5">
              Track total lot spend, auto-split COGS across linked items, lock individual standout item costs, and protect closed prior tax years.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setNewName("");
              setNewLotCode("");
              setNewTotalSpent("");
              setNewSourceType("storage_auction");
              setNewSourceLocation("Storage Auction");
              setNewStorageLocation("");
              setNewNotes("");
              setShowCreateModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F766E] hover:bg-[#0D665F] text-white text-xs font-semibold shadow-sm transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            New Bulk Buy
          </button>
        </div>

        {/* Auto-detected Storage Auction / Pallet Lot suggestions from existing SKUs */}
        {detectedLotSuggestions.length > 0 && (
          <div className="mt-4 pt-3.5 border-t border-[#ECEFE9]">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0F766E] mb-2">
              <Sparkles className="w-3.5 h-3.5" />
              Detected Unlinked Storage Auction / Lot Codes in Your SKUs — 1-Click Setup:
            </div>
            <div className="flex flex-wrap gap-2">
              {detectedLotSuggestions.map((s) => (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => openCreateForDetectedLot(s.code)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#ECFDF5] hover:bg-[#D1FAE5] border border-[#A7F3D0] text-xs font-semibold text-[#065F46] transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span className="font-mono">{s.code}</span>
                  <span className="text-[10px] font-medium text-[#047857] bg-white/80 px-1.5 py-0.5 rounded-full">
                    {s.count} items
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {bulkBuys.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-4 border-t border-[#ECEFE9]">
            <div className="bg-[#F8FAF9] border border-[#E7ECEA] rounded-lg px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5C606B]">
                Total Lot Spend
              </div>
              <div className="text-lg font-bold font-mono text-[#14151A] mt-0.5">
                {fmtMoney(portfolioSummary.totalSpent)}
              </div>
              <div className="text-[10px] text-[#5C606B]">
                {bulkBuys.length} bulk buy{bulkBuys.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="bg-[#F8FAF9] border border-[#E7ECEA] rounded-lg px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5C606B]">
                Active List Value
              </div>
              <div className="text-lg font-bold font-mono text-[#14151A] mt-0.5">
                {fmtMoney(portfolioSummary.totalActiveValue)}
              </div>
              <div className="text-[10px] text-[#5C606B]">Remaining active stock</div>
            </div>
            <div className="bg-[#F8FAF9] border border-[#E7ECEA] rounded-lg px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5C606B]">
                Gross Lot Sales
              </div>
              <div className="text-lg font-bold font-mono text-[#0B8A5F] mt-0.5">
                {fmtMoney(portfolioSummary.totalGross)}
              </div>
              <div className="text-[10px] text-[#5C606B]">Across all lots</div>
            </div>
            <div className="bg-[#F8FAF9] border border-[#E7ECEA] rounded-lg px-3 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#5C606B]">
                Net Profit (After Lot Spend)
              </div>
              <div
                className={`text-lg font-bold font-mono mt-0.5 ${
                  portfolioSummary.totalNet >= 0
                    ? "text-[#0B8A5F]"
                    : "text-[#B91C1C]"
                }`}
              >
                {fmtMoney(portfolioSummary.totalNet)}
              </div>
              <div className="text-[10px] text-[#5C606B]">
                {portfolioSummary.totalSpent > 0
                  ? `${Math.round((portfolioSummary.totalNet / portfolioSummary.totalSpent) * 100)}% combined ROI`
                  : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main Split: Lot Selector + Active Bulk Buy Detail */}
      {bulkBuys.length === 0 ? (
        <div className="bg-white border border-dashed border-[#CBD5E1] rounded-xl p-10 text-center">
          <Boxes className="w-10 h-10 text-[#94A3B8] mx-auto mb-3" />
          <h3 className="text-sm font-bold text-[#14151A]">
            No Bulk Buys Created Yet
          </h3>
          <p className="text-xs text-[#5C606B] max-w-md mx-auto mt-1">
            Create your first storage auction or pallet liquidation lot above (or click one of the detected SKU lot codes like{" "}
            <span className="font-mono font-semibold">SA926</span>) to automatically split COGS across every item in the buy.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Left column: Bulk Buys List */}
          <div className="lg:col-span-3 space-y-2">
            {bulkBuys.map((bb) => {
              const m = metricsByLot.get(bb.id);
              const isSelected = activeBulkBuy?.id === bb.id;
              return (
                <button
                  key={bb.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(bb.id);
                    setEditingHeader(false);
                  }}
                  className={`w-full text-left rounded-xl border p-3.5 transition cursor-pointer ${
                    isSelected
                      ? "bg-[#F0FDF9] border-[#0F766E] shadow-xs"
                      : "bg-white border-[#E2E5E8] hover:border-[#94A3B8]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-[#14151A] truncate">
                        {bb.name}
                      </div>
                      <div className="text-[11px] text-[#5C606B] mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span>{bb.purchase_date}</span>
                        {bb.lot_code && (
                          <span className="px-1.5 py-0.5 rounded bg-[#E6F4F1] text-[#0F766E] font-mono text-[10px] font-bold">
                            {bb.lot_code}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="font-mono text-xs font-bold text-[#B91C1C] shrink-0">
                      {fmtMoney(bb.total_spent)}
                    </span>
                  </div>
                  {m && (
                    <div className="mt-2.5">
                      <div className="flex items-center justify-between text-[10px] text-[#5C606B] mb-1">
                        <span>
                          {m.soldPct}% sold · {m.soldCount}/{m.totalItems}
                        </span>
                        <span
                          className={`font-mono font-bold ${
                            m.netProfitAfterFullLot >= 0
                              ? "text-[#0B8A5F]"
                              : "text-[#B91C1C]"
                          }`}
                        >
                          {fmtMoney(m.netProfitAfterFullLot)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[#E5E7EB] overflow-hidden">
                        <div
                          className="h-full bg-[#0F766E] rounded-full transition-all"
                          style={{ width: `${Math.min(100, m.soldPct)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right column: Active Bulk Buy Detail (Flipwise-style Lot Dashboard) */}
          {activeBulkBuy && activeMetrics && (
            <div className="lg:col-span-9 space-y-4">
              <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5 space-y-4">
                {/* Title & Actions */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-bold text-[#14151A]">
                        {activeBulkBuy.name}
                      </h3>
                      {activeBulkBuy.lot_code && (
                        <span className="px-2 py-0.5 rounded-full bg-[#E6F4F1] text-[#0F766E] font-mono text-xs font-bold">
                          SKU Code: {activeBulkBuy.lot_code}
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569] text-[11px] font-semibold">
                        {SOURCE_TYPE_LABELS[activeBulkBuy.source_type] ||
                          activeBulkBuy.source_type}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {activeBulkBuy.lot_code && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          callBulkApi(
                            { action: "auto_match_sku", id: activeBulkBuy.id },
                            "auto-match"
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#ECFDF5] hover:bg-[#D1FAE5] border border-[#A7F3D0] text-xs font-semibold text-[#065F46] transition cursor-pointer disabled:opacity-50"
                      >
                        {busyAction === "auto-match" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Link2 className="w-3.5 h-3.5" />
                        )}
                        Auto-Match &ldquo;{activeBulkBuy.lot_code}&rdquo;
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditHeader(activeBulkBuy)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white hover:bg-[#F8FAFC] border border-[#DDE2DF] text-xs font-semibold text-[#334155] transition cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Edit Lot
                    </button>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => handleDeleteLot(activeBulkBuy)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white hover:bg-[#FEF2F2] border border-[#FECACA] text-xs font-semibold text-[#B91C1C] transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline Edit Form or 5 Metadata Cards */}
                {editingHeader ? (
                  <form
                    onSubmit={handleSaveHeader}
                    className="bg-[#F8FAF9] border border-[#DCE5E2] rounded-xl p-4 space-y-3"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Lot Name
                        </label>
                        <input
                          type="text"
                          required
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Total Spent ($)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={editTotalSpent}
                          onChange={(e) => setEditTotalSpent(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          SKU Lot Code (e.g. SA926)
                        </label>
                        <input
                          type="text"
                          value={editLotCode}
                          onChange={(e) => setEditLotCode(e.target.value)}
                          placeholder="SA926"
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Purchase Date
                        </label>
                        <input
                          type="date"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Purchased From
                        </label>
                        <input
                          type="text"
                          value={editSourceLocation}
                          onChange={(e) => setEditSourceLocation(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Buy Type
                        </label>
                        <select
                          value={editSourceType}
                          onChange={(e) => setEditSourceType(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        >
                          {Object.entries(SOURCE_TYPE_LABELS).map(([k, lbl]) => (
                            <option key={k} value={k}>
                              {lbl}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Storage Location
                        </label>
                        <input
                          type="text"
                          value={editStorageLocation}
                          onChange={(e) => setEditStorageLocation(e.target.value)}
                          placeholder="Optional (e.g. Garage Bay 2)"
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Cost Split Mode
                        </label>
                        <select
                          value={editSplitMode}
                          onChange={(e) =>
                            setEditSplitMode(
                              e.target.value === "by_unit" ? "by_unit" : "even"
                            )
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        >
                          <option value="even">By Item (Even Split)</option>
                          <option value="by_unit">By Unit Quantity</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-[#5C606B] mb-1">
                          Notes
                        </label>
                        <input
                          type="text"
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="Unit size, facility, liquidation manifest notes..."
                          className="w-full px-2.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingHeader(false)}
                        className="px-3 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs font-semibold text-[#475569] cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={busyAction === "update"}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {busyAction === "update" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                        Save &amp; Re-Split COGS
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                    <div className="border border-[#E5E8E6] rounded-lg px-3 py-2">
                      <div className="text-[10px] font-bold uppercase text-[#64748B]">
                        Purchase Date
                      </div>
                      <div className="text-xs font-semibold text-[#14151A] mt-0.5">
                        {activeBulkBuy.purchase_date}
                      </div>
                    </div>
                    <div className="border border-[#E5E8E6] rounded-lg px-3 py-2">
                      <div className="text-[10px] font-bold uppercase text-[#64748B]">
                        Purchased From
                      </div>
                      <div className="text-xs font-semibold text-[#14151A] mt-0.5 truncate">
                        {activeBulkBuy.source_location}
                      </div>
                    </div>
                    <div className="border border-[#E5E8E6] rounded-lg px-3 py-2">
                      <div className="text-[10px] font-bold uppercase text-[#64748B]">
                        Storage Location
                      </div>
                      <div className="text-xs font-semibold text-[#14151A] mt-0.5 truncate">
                        {activeBulkBuy.storage_location || "Optional"}
                      </div>
                    </div>
                    <div className="border border-[#E5E8E6] rounded-lg px-3 py-2">
                      <div className="text-[10px] font-bold uppercase text-[#64748B]">
                        Total Spent
                      </div>
                      <div className="text-xs font-bold font-mono text-[#B91C1C] mt-0.5">
                        {fmtMoney(activeBulkBuy.total_spent)}
                      </div>
                    </div>
                    <div className="border border-[#E5E8E6] rounded-lg px-3 py-2">
                      <div className="text-[10px] font-bold uppercase text-[#64748B]">
                        Cost Split
                      </div>
                      <div className="text-xs font-semibold text-[#14151A] mt-0.5">
                        {activeBulkBuy.split_mode === "by_unit"
                          ? "By unit"
                          : "By item"}
                      </div>
                    </div>
                  </div>
                )}

                {/* Flipwise-Style Visual Cost Allocation Bar */}
                <div className="border border-[#E5E8E6] rounded-xl p-3.5 bg-[#FAFBFA]">
                  <div className="text-xs text-[#334155] mb-2">
                    How your{" "}
                    <span className="font-mono font-bold text-[#B91C1C]">
                      {fmtMoney(activeBulkBuy.total_spent)}
                    </span>{" "}
                    total spent breaks down:
                  </div>
                  {(() => {
                    const denom = Math.max(
                      0.01,
                      activeBulkBuy.total_spent,
                      activeMetrics.closedYearHeld +
                        activeMetrics.lockedHeld +
                        activeMetrics.sharedHeld
                    );
                    const closedPct = (activeMetrics.closedYearHeld / denom) * 100;
                    const lockedPct = (activeMetrics.lockedHeld / denom) * 100;
                    const sharedPct = (activeMetrics.sharedHeld / denom) * 100;
                    return (
                      <>
                        <div className="h-3 w-full rounded-full bg-[#E5E7EB] overflow-hidden flex">
                          {closedPct > 0 && (
                            <div
                              className="h-full bg-[#64748B]"
                              style={{ width: `${closedPct}%` }}
                              title="Held for closed prior tax year"
                            />
                          )}
                          {lockedPct > 0 && (
                            <div
                              className="h-full bg-[#D97706]"
                              style={{ width: `${lockedPct}%` }}
                              title="Locked item costs"
                            />
                          )}
                          {sharedPct > 0 && (
                            <div
                              className="h-full bg-[#0F766E]"
                              style={{ width: `${sharedPct}%` }}
                              title="Shared evenly across unlocked items"
                            />
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-4 mt-2 text-[11px] text-[#475569]">
                          {activeMetrics.closedYearCount > 0 && (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-sm bg-[#64748B]" />
                              <strong className="font-mono">
                                {fmtMoney(activeMetrics.closedYearHeld)}
                              </strong>{" "}
                              held for closed tax year ·{" "}
                              {activeMetrics.closedYearCount} item
                              {activeMetrics.closedYearCount === 1 ? "" : "s"}
                            </span>
                          )}
                          {activeMetrics.lockedCount > 0 && (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-sm bg-[#D97706]" />
                              <strong className="font-mono">
                                {fmtMoney(activeMetrics.lockedHeld)}
                              </strong>{" "}
                              locked · {activeMetrics.lockedCount} item
                              {activeMetrics.lockedCount === 1 ? "" : "s"}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-2.5 h-2.5 rounded-sm bg-[#0F766E]" />
                            <strong className="font-mono">
                              {fmtMoney(activeMetrics.sharedHeld)}
                            </strong>{" "}
                            shared evenly · {activeMetrics.sharedCount} item
                            {activeMetrics.sharedCount === 1 ? "" : "s"}
                            {activeMetrics.sharedCount > 0 && (
                              <span className="text-[#0F766E] font-mono font-semibold">
                                (
                                {fmtMoney(
                                  activeMetrics.sharedHeld /
                                    activeMetrics.sharedCount
                                )}
                                /ea)
                              </span>
                            )}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* 6-KPI Lot Scorecard */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                  <div className="border border-[#E5E8E6] rounded-lg px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase text-[#64748B]">
                      Active List Value
                    </div>
                    <div className="text-base font-bold font-mono text-[#14151A] mt-0.5">
                      {fmtMoney(activeMetrics.activeListValue)}
                    </div>
                  </div>
                  <div className="border border-[#E5E8E6] rounded-lg px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase text-[#64748B]">
                      Gross Sales
                    </div>
                    <div className="text-base font-bold font-mono text-[#0B8A5F] mt-0.5">
                      {fmtMoney(activeMetrics.grossSales)}
                    </div>
                  </div>
                  <div className="border border-[#E5E8E6] rounded-lg px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase text-[#64748B]">
                      Net Profit (Lot)
                    </div>
                    <div
                      className={`text-base font-bold font-mono mt-0.5 ${
                        activeMetrics.netProfitAfterFullLot >= 0
                          ? "text-[#0B8A5F]"
                          : "text-[#B91C1C]"
                      }`}
                    >
                      {fmtMoney(activeMetrics.netProfitAfterFullLot)}
                    </div>
                  </div>
                  <div className="border border-[#E5E8E6] rounded-lg px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase text-[#64748B]">
                      Net Profit (Realized)
                    </div>
                    <div
                      className={`text-base font-bold font-mono mt-0.5 ${
                        activeMetrics.realizedNetProfit >= 0
                          ? "text-[#0B8A5F]"
                          : "text-[#B91C1C]"
                      }`}
                    >
                      {fmtMoney(activeMetrics.realizedNetProfit)}
                    </div>
                  </div>
                  <div className="border border-[#E5E8E6] rounded-lg px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase text-[#64748B]">
                      ROI (Lot)
                    </div>
                    <div
                      className={`text-base font-bold font-mono mt-0.5 ${
                        activeMetrics.overallRoiPct >= 0
                          ? "text-[#0B8A5F]"
                          : "text-[#B91C1C]"
                      }`}
                    >
                      {Math.round(activeMetrics.overallRoiPct)}%
                    </div>
                  </div>
                  <div className="border border-[#E5E8E6] rounded-lg px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase text-[#64748B]">
                      ROI (Realized)
                    </div>
                    <div
                      className={`text-base font-bold font-mono mt-0.5 ${
                        activeMetrics.realizedRoiPct >= 0
                          ? "text-[#0B8A5F]"
                          : "text-[#B91C1C]"
                      }`}
                    >
                      {activeMetrics.soldCount > 0
                        ? `${Math.round(activeMetrics.realizedRoiPct)}%`
                        : "—"}
                    </div>
                  </div>
                </div>

                {/* Sell-through progress bar */}
                <div className="border border-[#E5E8E6] rounded-xl px-3.5 py-2.5">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="font-semibold text-[#14151A]">
                      {activeMetrics.soldPct}% sold ·{" "}
                      <span className="font-bold">
                        {activeMetrics.soldCount} of {activeMetrics.totalItems}
                      </span>{" "}
                      items
                    </span>
                    <span className="text-[11px] text-[#5C606B]">
                      {activeMetrics.activeCount} active ·{" "}
                      {activeMetrics.draftCount} draft
                      {activeMetrics.disposedCount > 0
                        ? ` · ${activeMetrics.disposedCount} donated/discarded`
                        : ""}
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-[#E5E7EB] overflow-hidden">
                    <div
                      className="h-full bg-[#0B8A5F] rounded-full transition-all"
                      style={{ width: `${Math.min(100, activeMetrics.soldPct)}%` }}
                    />
                  </div>
                  {activeBulkBuy.notes && (
                    <div className="text-xs text-[#475569] mt-2 pt-2 border-t border-[#F1F5F9]">
                      <span className="font-semibold text-[#64748B] uppercase text-[10px] mr-1.5">
                        Notes:
                      </span>
                      {activeBulkBuy.notes}
                    </div>
                  )}
                </div>

                {/* Lot Items Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {(["All", "Active", "Draft", "Sold", "Disposed"] as const).map(
                      (tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setStatusFilter(tab)}
                          className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition cursor-pointer ${
                            statusFilter === tab
                              ? "bg-[#14151A] text-white border-[#14151A]"
                              : "bg-white text-[#5C606B] border-[#DDE2DF] hover:border-[#0F766E]"
                          }`}
                        >
                          {tab}
                        </button>
                      )
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={itemSearch}
                        onChange={(e) => setItemSearch(e.target.value)}
                        placeholder="Search lot items..."
                        className="pl-8 pr-3 py-1.5 rounded-lg border border-[#DDE2DF] text-xs w-44 sm:w-56"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPickerSearch(activeBulkBuy.lot_code || "");
                        setPickerSelected(new Set());
                        setShowAddItemsModal(true);
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#0B8A5F] hover:bg-[#09734F] text-white text-xs font-semibold transition cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Items
                    </button>
                  </div>
                </div>

                {/* Lot Items Table */}
                <div className="border border-[#E5E8E6] rounded-xl overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[#F8FAF9] border-b border-[#E5E8E6] text-[10px] font-bold uppercase tracking-wider text-[#5C606B]">
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-2.5">Status</th>
                        <th className="py-2.5 px-2.5">SKU / Bin</th>
                        <th className="py-2.5 px-2.5 text-right">
                          Cost (Click to Lock/Edit)
                        </th>
                        <th className="py-2.5 px-2.5 text-right">Sales / List</th>
                        <th className="py-2.5 px-2.5 text-center">Tax Year</th>
                        <th className="py-2.5 px-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#ECEFE9] text-xs">
                      {filteredLotItems.length === 0 ? (
                        <tr>
                          <td
                            colSpan={7}
                            className="py-8 text-center text-[#64748B]"
                          >
                            No items in this view yet. Click{" "}
                            <strong>+ Add Items</strong> or{" "}
                            <strong>Auto-Match</strong> to attach items from this
                            bulk buy.
                          </td>
                        </tr>
                      ) : (
                        filteredLotItems.map((it) => (
                          <tr
                            key={it.id}
                            className="hover:bg-[#F8FAF9] transition"
                          >
                            <td className="py-2.5 px-3 max-w-[280px]">
                              <div className="flex items-center gap-2.5">
                                {it.imageUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={it.imageUrl}
                                    alt={it.title}
                                    className="w-9 h-9 rounded-lg object-cover border border-[#E2E5E8] shrink-0"
                                  />
                                ) : (
                                  <div className="w-9 h-9 rounded-lg bg-[#F1F5F9] border border-[#E2E5E8] flex items-center justify-center text-[10px] font-mono text-[#94A3B8] shrink-0">
                                    IMG
                                  </div>
                                )}
                                <button
                                  type="button"
                                  disabled={!it.activeRow || !onSelectActiveItem}
                                  onClick={() =>
                                    it.activeRow &&
                                    onSelectActiveItem?.(it.activeRow)
                                  }
                                  className={`text-left font-medium text-[#14151A] line-clamp-2 ${
                                    it.activeRow && onSelectActiveItem
                                      ? "hover:text-[#0F766E] cursor-pointer"
                                      : ""
                                  }`}
                                >
                                  {it.title}
                                </button>
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 whitespace-nowrap">
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                  it.status === "Sold"
                                    ? "bg-[#ECFDF5] text-[#047857]"
                                    : it.status === "Active"
                                      ? "bg-[#EFF6FF] text-[#1D4ED8]"
                                      : it.status === "Draft"
                                        ? "bg-[#FEF3C7] text-[#B45309]"
                                        : "bg-[#F1F5F9] text-[#475569]"
                                }`}
                              >
                                {it.status}
                              </span>
                            </td>
                            <td className="py-2.5 px-2.5">
                              <div className="font-mono text-[11px] text-[#334155] truncate max-w-[140px]">
                                {it.sku}
                              </div>
                              <div className="text-[10px] text-[#64748B]">
                                {it.binLocation || "Unassigned"}
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5 justify-end">
                                {it.isClosedTaxYear ? (
                                  <span
                                    title={`Sold in closed tax year ${it.soldYear} — cost frozen`}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#F1F5F9] text-[#475569] font-mono text-xs font-bold"
                                  >
                                    <Lock className="w-3 h-3" />
                                    {fmtMoney(it.cogs)}
                                  </span>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      title={
                                        it.bulkBuyLocked
                                          ? "Locked custom cost — click to unlock & return to shared split"
                                          : "Shared evenly — click to set & lock a custom cost"
                                      }
                                      onClick={() =>
                                        setLockModalItem({
                                          item: it,
                                          nextCost: it.cogs.toFixed(2),
                                          mode: it.bulkBuyLocked
                                            ? "unlock"
                                            : "lock",
                                        })
                                      }
                                      className={`p-1 rounded hover:bg-[#ECEFE9] transition cursor-pointer ${
                                        it.bulkBuyLocked
                                          ? "text-[#D97706]"
                                          : "text-[#94A3B8] hover:text-[#0F766E]"
                                      }`}
                                    >
                                      {it.bulkBuyLocked ? (
                                        <Lock className="w-3.5 h-3.5" />
                                      ) : (
                                        <Unlock className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setLockModalItem({
                                          item: it,
                                          nextCost: it.cogs.toFixed(2),
                                          mode: "lock",
                                        })
                                      }
                                      className="font-mono font-bold text-[#B91C1C] hover:underline cursor-pointer"
                                    >
                                      {fmtMoney(it.cogs)}
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 text-right font-mono whitespace-nowrap">
                              {it.grossSales > 0 ? (
                                <span className="font-bold text-[#0B8A5F]">
                                  {fmtMoney(it.grossSales)}
                                </span>
                              ) : it.listedPrice > 0 ? (
                                <span className="text-[#475569]">
                                  {fmtMoney(it.listedPrice)}
                                </span>
                              ) : (
                                <span className="text-[#94A3B8]">—</span>
                              )}
                            </td>
                            <td className="py-2.5 px-2.5 text-center font-mono text-[11px] text-[#475569]">
                              {it.soldYear ?? "—"}
                            </td>
                            <td className="py-2.5 px-2.5 text-right">
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() =>
                                  callBulkApi(
                                    {
                                      action: "remove_items",
                                      id: activeBulkBuy.id,
                                      itemIds: [it.id],
                                    },
                                    `rem-${it.id}`
                                  )
                                }
                                className="text-[11px] font-semibold text-[#64748B] hover:text-[#B91C1C] cursor-pointer"
                              >
                                Unlink
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Bulk Buy Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E5E8] rounded-2xl w-full max-w-lg shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#ECEFE9] flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#14151A]">
                Create New Bulk Buy / Lot
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-[#64748B] hover:text-[#14151A] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Bulk Buy Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Storage Auction SA926 or Target Pallet #4"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Total Amount Paid ($) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={newTotalSpent}
                    onChange={(e) => setNewTotalSpent(e.target.value)}
                    placeholder="350.00"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    SKU Lot Code (Auto-Link)
                  </label>
                  <input
                    type="text"
                    value={newLotCode}
                    onChange={(e) => setNewLotCode(e.target.value)}
                    placeholder="e.g. SA926"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Buy Type
                  </label>
                  <select
                    value={newSourceType}
                    onChange={(e) => setNewSourceType(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs bg-white"
                  >
                    {Object.entries(SOURCE_TYPE_LABELS).map(([k, lbl]) => (
                      <option key={k} value={k}>
                        {lbl}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Purchase Date
                  </label>
                  <input
                    type="date"
                    value={newPurchaseDate}
                    onChange={(e) => setNewPurchaseDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Purchased From
                  </label>
                  <input
                    type="text"
                    value={newSourceLocation}
                    onChange={(e) => setNewSourceLocation(e.target.value)}
                    placeholder="StorageTreasures / Public Storage / B-Stock"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Storage Location (Optional)
                  </label>
                  <input
                    type="text"
                    value={newStorageLocation}
                    onChange={(e) => setNewStorageLocation(e.target.value)}
                    placeholder="Garage / Shelf H / Storage Unit"
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Notes
                  </label>
                  <input
                    type="text"
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="10x10 unit, buyer's premium included..."
                    className="w-full px-3 py-2 rounded-lg border border-[#CBD5E1] text-xs"
                  />
                </div>
              </div>
              {newLotCode.trim() && (
                <div className="rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] px-3 py-2 text-[11px] text-[#065F46]">
                  All existing active, draft, and sold items with{" "}
                  <strong className="font-mono">{newLotCode.trim().toUpperCase()}</strong>{" "}
                  in their SKU will automatically link and split{" "}
                  <strong>
                    {fmtMoney(Number(newTotalSpent) || 0)}
                  </strong>{" "}
                  evenly!
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-2 rounded-lg border border-[#CBD5E1] text-xs font-semibold text-[#475569] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyAction === "create"}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#0D665F] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  {busyAction === "create" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  Create Bulk Buy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lock / Unlock Item Cost Confirmation Modal (Flipwise-inspired) */}
      {lockModalItem && activeBulkBuy && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E5E8] rounded-2xl w-full max-w-md shadow-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-base font-bold text-[#14151A]">
                {lockModalItem.mode === "lock"
                  ? "Update & lock this item's cost?"
                  : "Unlock this item's cost?"}
              </h3>
              <button
                type="button"
                onClick={() => setLockModalItem(null)}
                className="text-[#64748B] hover:text-[#14151A] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {lockModalItem.mode === "lock" ? (
              <>
                <p className="text-xs text-[#475569] leading-relaxed">
                  <strong>{lockModalItem.item.title}</strong> will keep its
                  locked cost instead of taking an even share of{" "}
                  <strong>{activeBulkBuy.name}</strong>&rsquo;s total. The rest
                  of the lot total automatically re-splits across the other
                  unlocked items.{" "}
                  <strong>No sales from prior closed tax years are impacted.</strong>
                </p>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-[#5C606B] mb-1">
                    Locked Cost ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    autoFocus
                    value={lockModalItem.nextCost}
                    onChange={(e) =>
                      setLockModalItem((prev) =>
                        prev ? { ...prev, nextCost: e.target.value } : null
                      )
                    }
                    className="w-full px-3 py-2 rounded-lg border-2 border-[#0F766E] text-sm font-mono font-bold text-[#14151A]"
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-[#475569] leading-relaxed">
                <strong>{lockModalItem.item.title}</strong> will be unlocked and
                go back to taking an even share of{" "}
                <strong>{activeBulkBuy.name}</strong>&rsquo;s total. The other
                unlocked items&rsquo; shares adjust to match; the total spent
                does not change.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setLockModalItem(null)}
                className="px-3.5 py-2 rounded-lg border border-[#CBD5E1] text-xs font-semibold text-[#475569] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleConfirmLockOrUnlock}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0B8A5F] hover:bg-[#09734F] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                {busyAction ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Items Picker Modal */}
      {showAddItemsModal && activeBulkBuy && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E5E8] rounded-2xl w-full max-w-2xl max-h-[82vh] flex flex-col shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#ECEFE9] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#14151A]">
                  Add Items to {activeBulkBuy.name}
                </h3>
                <p className="text-[11px] text-[#5C606B]">
                  Select unlinked active, draft, or sold items — COGS will automatically re-split.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddItemsModal(false)}
                className="text-[#64748B] hover:text-[#14151A] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3.5 border-b border-[#ECEFE9] flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder="Filter by SKU (e.g. SA926), title, or bin..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-[#CBD5E1] text-xs"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(pickerSelected);
                  for (const it of availablePickerItems) next.add(it.id);
                  setPickerSelected(next);
                }}
                className="px-2.5 py-2 rounded-lg border border-[#CBD5E1] text-xs font-semibold text-[#334155] hover:bg-[#F8FAFC] cursor-pointer"
              >
                Select All Shown ({availablePickerItems.length})
              </button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[#ECEFE9]">
              {availablePickerItems.length === 0 ? (
                <div className="py-10 text-center text-xs text-[#64748B]">
                  No unlinked items match your filter.
                </div>
              ) : (
                availablePickerItems.map((it) => {
                  const checked = pickerSelected.has(it.id);
                  return (
                    <label
                      key={it.id}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-[#F8FAF9] ${
                        checked ? "bg-[#F0FDF9]" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(pickerSelected);
                          if (next.has(it.id)) next.delete(it.id);
                          else next.add(it.id);
                          setPickerSelected(next);
                        }}
                        className="rounded border-[#CBD5E1] text-[#0F766E]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-[#14151A] truncate">
                          {it.title}
                        </div>
                        <div className="text-[11px] text-[#5C606B] flex items-center gap-2">
                          <span className="font-mono">{it.sku}</span>
                          <span>· {it.status}</span>
                          {it.binLocation && <span>· {it.binLocation}</span>}
                        </div>
                      </div>
                      <span className="font-mono text-xs text-[#475569] shrink-0">
                        COGS {fmtMoney(it.cogs)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="px-5 py-3 border-t border-[#ECEFE9] bg-[#F8FAF9] flex items-center justify-between">
              <span className="text-xs font-semibold text-[#334155]">
                {pickerSelected.size} selected
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddItemsModal(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs font-semibold text-[#475569] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pickerSelected.size === 0 || busyAction === "add-items"}
                  onClick={handleAddPickedItems}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  {busyAction === "add-items" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  Add &amp; Split COGS
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
