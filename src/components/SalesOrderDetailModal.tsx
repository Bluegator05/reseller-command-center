"use client";

import { useMemo, useState } from "react";
import {
  Boxes,
  Check,
  Clock,
  DollarSign,
  Loader2,
  MapPin,
  Package,
  RefreshCw,
  RotateCcw,
  Tag,
  Truck,
  X,
} from "lucide-react";
import type {
  BulkBuyRecord,
  ChannelJob,
  ItemActivityEvent,
  SalesOrderRecord,
} from "@/lib/types";

interface SalesOrderDetailModalProps {
  order: SalesOrderRecord | null;
  bulkBuys: BulkBuyRecord[];
  jobs: ChannelJob[];
  onClose: () => void;
  onSaveCosts?: (params: {
    orderId: string;
    cogs?: number;
    shipping_cost?: number;
  }) => Promise<void>;
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDurationHuman(
  startIso?: string | null,
  endIso?: string | null
): string {
  if (!startIso || !endIso) return "—";
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "—";
  const hours = Math.round((b - a) / (1000 * 60 * 60));
  if (hours < 1) return "less than 1 hour";
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  if (months < 12) return `about ${months} month${months === 1 ? "" : "s"}`;
  const years = (days / 365).toFixed(1);
  return `${years} years`;
}

export function SalesOrderDetailModal({
  order,
  bulkBuys,
  jobs,
  onClose,
  onSaveCosts,
}: SalesOrderDetailModalProps) {
  if (!order) return null;
  return (
    <SalesOrderDetailModalInner
      key={order.id}
      order={order}
      bulkBuys={bulkBuys}
      jobs={jobs}
      onClose={onClose}
      onSaveCosts={onSaveCosts}
    />
  );
}

function SalesOrderDetailModalInner({
  order,
  bulkBuys,
  jobs,
  onClose,
  onSaveCosts,
}: {
  order: SalesOrderRecord;
  bulkBuys: BulkBuyRecord[];
  jobs: ChannelJob[];
  onClose: () => void;
  onSaveCosts?: (params: {
    orderId: string;
    cogs?: number;
    shipping_cost?: number;
  }) => Promise<void>;
}) {
  const [editCogs, setEditCogs] = useState(String(order.cogs ?? 0));
  const [editShip, setEditShip] = useState(String(order.shipping_cost ?? 0));
  const [saving, setSaving] = useState(false);

  const linkedBulkBuy = useMemo(
    () => bulkBuys.find((b) => b.id === order.bulk_buy_id) ?? null,
    [bulkBuys, order.bulk_buy_id]
  );

  // Flipwise-style exact P&L breakdown
  const pnl = useMemo(() => {
    const gross = Number(order.gross_sale_price || 0);
    const refund = Number(order.refund_amount || 0);
    const shipCost = Math.max(0, Number(editShip) || 0);
    const cogsVal = Math.max(0, Number(editCogs) || 0);
    const prepVal = Number(order.prep_cost || 0);
    const totalFees = Number(order.marketplace_fees || 0);
    const adFee = Number(order.ad_fee || 0);

    // Separate eBay fixed per-order FVF ($0.40 for orders > $10, $0.30 otherwise) from variable FVF
    const fixedFvf =
      order.marketplace === "ebay" && totalFees > 0.4
        ? gross > 10
          ? 0.4
          : 0.3
        : 0;
    const variableFvf = Math.max(0, totalFees - fixedFvf - adFee);
    const totalCosts = cogsVal + prepVal + totalFees + shipCost + refund;
    const netProfit = gross - totalCosts;
    const basis = cogsVal + prepVal;
    const roiPct = basis > 0 ? (netProfit / basis) * 100 : null;
    const marginPct = gross > 0 ? (netProfit / gross) * 100 : 0;

    return {
      gross,
      refund,
      shipCost,
      cogsVal,
      prepVal,
      fixedFvf,
      variableFvf,
      adFee,
      totalFees,
      totalCosts,
      netProfit,
      roiPct,
      marginPct,
      dirty:
        Math.abs(cogsVal - (order.cogs || 0)) > 0.005 ||
        Math.abs(shipCost - (order.shipping_cost || 0)) > 0.005,
    };
  }, [order, editCogs, editShip]);

  // Build unified chronological activity timeline from order timestamps + item activity_log + channel_jobs
  const timeline = useMemo<ItemActivityEvent[]>(() => {
    const events: ItemActivityEvent[] = [];

    if (order.shipped_at || order.fulfillment_status === "shipped") {
      events.push({
        id: `ship-${order.id}`,
        type: "shipped",
        timestamp: order.shipped_at || order.sold_at,
        title: "Shipped",
        detail: [
          `Shipped to ${order.marketplace.toUpperCase()} buyer`,
          order.buyer_city || order.buyer_state
            ? `in ${[order.buyer_city, order.buyer_state].filter(Boolean).join(", ")}`
            : null,
          order.tracking_number ? `Tracking #${order.tracking_number}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }

    if (
      order.fulfillment_status === "returned" ||
      order.fulfillment_status === "partial_refund" ||
      (order.refund_amount ?? 0) > 0
    ) {
      events.push({
        id: `ret-${order.id}`,
        type: "returned",
        timestamp: order.sold_at,
        title:
          order.fulfillment_status === "returned"
            ? "Return / Full Refund"
            : "Partial Refund",
        detail: `${fmtMoney(order.refund_amount || 0)} refunded${order.return_reason ? ` — ${order.return_reason}` : ""}`,
      });
    }

    events.push({
      id: `sold-${order.id}`,
      type: "sold",
      timestamp: order.sold_at,
      title: `Sold on ${order.marketplace.toUpperCase()}`,
      detail: `Sold for ${fmtMoney(order.gross_sale_price)} · Net ${fmtMoney(pnl.netProfit)} (${Math.round(pnl.marginPct)}% margin)`,
    });

    // Include persisted activity_log events (relists, price drops, bulk buy links, etc.)
    for (const evt of order.activity_log || []) {
      events.push(evt);
    }

    // Include channel_jobs for this item (delist cascades, relists, price drops)
    for (const j of jobs) {
      if (j.item_id !== order.item_id) continue;
      if (j.action === "delist") {
        events.push({
          id: `job-${j.id}`,
          type: "note",
          timestamp: j.completed_at || j.created_at,
          title: `Auto-Delist (${j.marketplace.toUpperCase()})`,
          detail: `Status: ${j.status}${j.error_message ? ` — ${j.error_message}` : ""}`,
        });
      }
    }

    if (order.acquired_at) {
      events.push({
        id: `acq-${order.id}`,
        type: "acquired",
        timestamp: order.acquired_at,
        title: "Purchased / Acquired",
        detail: `${order.source_location || "Inventory"}${linkedBulkBuy ? ` (${linkedBulkBuy.name})` : ""} · COGS ${fmtMoney(pnl.cogsVal)}`,
      });
    }

    // Sort newest first
    return events.sort(
      (a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || "")
    );
  }, [order, jobs, linkedBulkBuy, pnl.cogsVal, pnl.marginPct, pnl.netProfit]);

  const handleSave = async () => {
    if (!onSaveCosts || !pnl.dirty) return;
    setSaving(true);
    try {
      await onSaveCosts({
        orderId: order.id,
        cogs: pnl.cogsVal,
        shipping_cost: pnl.shipCost,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-black/45 flex items-center justify-center p-3 sm:p-5">
      <div className="bg-white border border-[#E2E5E8] rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Top bar */}
        <div className="px-5 py-3.5 border-b border-[#ECEFE9] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#5C606B] flex items-center gap-1.5">
              <span>Sold</span>
              <span>›</span>
              <span className="font-mono text-[#0F766E]">{order.sku}</span>
              <span>·</span>
              <span className="uppercase">{order.marketplace}</span>
            </div>
            <h3 className="text-base font-bold text-[#14151A] mt-0.5 line-clamp-2">
              {order.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#64748B] hover:text-[#14151A] hover:bg-[#F1F5F9] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Flipwise 2-Column Body: Left = Photo + Product Details, Right = Order P&L + Activity Timeline */}
        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-12 gap-5">
          {/* Left Column */}
          <div className="md:col-span-4 space-y-4">
            <div className="rounded-xl border border-[#E2E5E8] bg-[#F8FAF9] overflow-hidden aspect-square flex items-center justify-center">
              {order.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={order.image_url}
                  alt={order.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <Package className="w-12 h-12 text-[#CBD5E1]" />
              )}
            </div>

            <div className="border border-[#E5E8E6] rounded-xl overflow-hidden">
              <div className="px-3.5 py-2 bg-[#F8FAF9] border-b border-[#E5E8E6] text-[10px] font-bold uppercase tracking-wider text-[#5C606B]">
                Product Details
              </div>
              <div className="divide-y divide-[#ECEFE9] text-xs">
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Status</span>
                  <span className="font-semibold text-[#0B8A5F] capitalize">
                    {(order.fulfillment_status || "sold").replace("_", " ")}
                  </span>
                </div>
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Purchase Date</span>
                  <span className="font-medium text-[#14151A]">
                    {order.acquired_at ? order.acquired_at.slice(0, 10) : "—"}
                  </span>
                </div>
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Time to List</span>
                  <span className="font-medium text-[#14151A]">
                    {formatDurationHuman(order.acquired_at, order.listed_at)}
                  </span>
                </div>
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Time to Sell</span>
                  <span className="font-medium text-[#14151A]">
                    {formatDurationHuman(
                      order.listed_at || order.acquired_at,
                      order.sold_at
                    )}
                  </span>
                </div>
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Purchased From</span>
                  <span className="font-medium text-[#14151A] text-right">
                    {linkedBulkBuy ? (
                      <span className="inline-flex items-center gap-1 text-[#0F766E] font-semibold">
                        <Boxes className="w-3 h-3" />
                        {linkedBulkBuy.name}
                      </span>
                    ) : (
                      order.source_location || "—"
                    )}
                  </span>
                </div>
                {(order.buyer_city || order.buyer_state) && (
                  <div className="px-3.5 py-2 flex justify-between gap-2">
                    <span className="text-[#5C606B]">Buyer Location</span>
                    <span className="font-medium text-[#14151A] inline-flex items-center gap-1">
                      <MapPin className="w-3 h-3 text-[#EA580C]" />
                      {[order.buyer_city, order.buyer_state]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </div>
                )}
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Gross Sales</span>
                  <span className="font-mono font-bold text-[#0B8A5F]">
                    {fmtMoney(pnl.gross)}
                  </span>
                </div>
                <div className="px-3.5 py-2 flex justify-between gap-2">
                  <span className="text-[#5C606B]">Total Costs</span>
                  <span className="font-mono font-bold text-[#B91C1C]">
                    {fmtMoney(pnl.totalCosts)}
                  </span>
                </div>
                <div className="px-3.5 py-2 flex justify-between gap-2 bg-[#F8FAF9]">
                  <span className="font-semibold text-[#14151A]">Net Profit</span>
                  <span
                    className={`font-mono font-bold ${
                      pnl.netProfit >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
                    }`}
                  >
                    {fmtMoney(pnl.netProfit)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Line-by-Line P&L + Chronological Activity Timeline */}
          <div className="md:col-span-8 space-y-5">
            {/* Exact Flipwise-style Sold Order P&L Card */}
            <div className="border border-[#E2E5E8] rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-[#F0FDF9] border-b border-[#CCFBF1] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-[#0B8A5F] text-white flex items-center justify-center">
                    <DollarSign className="w-3.5 h-3.5" />
                  </span>
                  <div>
                    <div className="text-xs font-bold text-[#14151A]">
                      Sold on {order.marketplace.toUpperCase()} for{" "}
                      <span className="font-mono text-[#0B8A5F]">
                        {fmtMoney(pnl.gross)}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#5C606B]">
                      {fmtDateTime(order.sold_at)}
                    </div>
                  </div>
                </div>
                {pnl.dirty && onSaveCosts && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleSave}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#0F766E] hover:bg-[#0D665F] text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    Save Updated Costs
                  </button>
                )}
              </div>

              <div className="divide-y divide-[#ECEFE9] text-xs">
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-[#5C606B]">Time to sell</span>
                  <span className="font-medium text-[#14151A]">
                    {formatDurationHuman(
                      order.listed_at || order.acquired_at,
                      order.sold_at
                    )}
                  </span>
                </div>
                <div className="px-4 py-2 flex items-center justify-between gap-3">
                  <span className="text-[#5C606B]">
                    Purchase price (COGS)
                    {order.bulk_buy_locked && (
                      <span className="ml-1.5 text-[10px] text-[#D97706] font-semibold">
                        (Locked)
                      </span>
                    )}
                  </span>
                  {onSaveCosts ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[#B91C1C] font-mono">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editCogs}
                        onChange={(e) => setEditCogs(e.target.value)}
                        className="w-24 px-2 py-1 rounded border border-[#DDE2DF] text-right font-mono font-semibold text-[#B91C1C]"
                      />
                    </div>
                  ) : (
                    <span className="font-mono font-semibold text-[#B91C1C]">
                      {fmtMoney(pnl.cogsVal)}
                    </span>
                  )}
                </div>
                {pnl.fixedFvf > 0 && (
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-[#5C606B]">Fixed final value fee</span>
                    <span className="font-mono font-semibold text-[#B91C1C]">
                      {fmtMoney(pnl.fixedFvf)}
                    </span>
                  </div>
                )}
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-[#5C606B]">Final value / marketplace fee</span>
                  <span className="font-mono font-semibold text-[#B91C1C]">
                    {fmtMoney(pnl.variableFvf)}
                  </span>
                </div>
                {pnl.adFee > 0 && (
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-[#5C606B]">Promoted Ad fee</span>
                    <span className="font-mono font-semibold text-[#B91C1C]">
                      {fmtMoney(pnl.adFee)}
                    </span>
                  </div>
                )}
                <div className="px-4 py-2 flex items-center justify-between gap-3">
                  <span className="text-[#5C606B]">Cost to ship</span>
                  {onSaveCosts ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[#B91C1C] font-mono">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editShip}
                        onChange={(e) => setEditShip(e.target.value)}
                        className="w-24 px-2 py-1 rounded border border-[#DDE2DF] text-right font-mono font-semibold text-[#B91C1C]"
                      />
                    </div>
                  ) : (
                    <span className="font-mono font-semibold text-[#B91C1C]">
                      {fmtMoney(pnl.shipCost)}
                    </span>
                  )}
                </div>
                {pnl.refund > 0 && (
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-[#5C606B]">Refund issued</span>
                    <span className="font-mono font-semibold text-[#B91C1C]">
                      {fmtMoney(pnl.refund)}
                    </span>
                  </div>
                )}
                <div className="px-4 py-2.5 flex items-center justify-between bg-[#FAFBFA]">
                  <span className="font-bold text-[#14151A]">Net profit</span>
                  <span
                    className={`font-mono text-sm font-bold ${
                      pnl.netProfit >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
                    }`}
                  >
                    {fmtMoney(pnl.netProfit)}
                  </span>
                </div>
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-[#5C606B]">ROI</span>
                  <span
                    className={`font-mono font-bold ${
                      pnl.netProfit >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
                    }`}
                  >
                    {pnl.roiPct === null
                      ? pnl.netProfit >= 0
                        ? "∞"
                        : "—"
                      : `${Math.round(pnl.roiPct)}%`}
                  </span>
                </div>
                <div className="px-4 py-2 flex items-center justify-between">
                  <span className="text-[#5C606B]">Net profit margin</span>
                  <span
                    className={`font-mono font-bold ${
                      pnl.marginPct >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
                    }`}
                  >
                    {Math.round(pnl.marginPct)}%
                  </span>
                </div>
                {order.external_order_id && (
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-[#5C606B]">Order ID</span>
                    <span className="font-mono text-[#0F766E] font-semibold">
                      {order.external_order_id}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Vertical Activity Timeline */}
            <div className="border border-[#E2E5E8] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-[#0F766E]" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-[#14151A]">
                  Item Activity Timeline
                </h4>
              </div>
              <div className="space-y-3 relative before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-[#E2E5E8]">
                {timeline.map((evt) => {
                  const iconBg =
                    evt.type === "shipped" || evt.type === "sold"
                      ? "bg-[#0B8A5F] text-white"
                      : evt.type === "relisted" || evt.type === "price_changed"
                        ? "bg-[#0284C7] text-white"
                        : evt.type === "returned"
                          ? "bg-[#B91C1C] text-white"
                          : evt.type === "bulk_buy_added" ||
                              evt.type === "bulk_buy_cost_locked"
                            ? "bg-[#EA580C] text-white"
                            : "bg-[#64748B] text-white";
                  return (
                    <div key={evt.id} className="relative pl-8">
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center absolute left-0 top-0.5 ${iconBg}`}
                      >
                        {evt.type === "shipped" ? (
                          <Truck className="w-3 h-3" />
                        ) : evt.type === "sold" ? (
                          <DollarSign className="w-3 h-3" />
                        ) : evt.type === "relisted" ? (
                          <RefreshCw className="w-3 h-3" />
                        ) : evt.type === "returned" ? (
                          <RotateCcw className="w-3 h-3" />
                        ) : evt.type === "bulk_buy_added" ? (
                          <Boxes className="w-3 h-3" />
                        ) : (
                          <Tag className="w-3 h-3" />
                        )}
                      </span>
                      <div className="text-xs font-bold text-[#14151A]">
                        {evt.title}
                      </div>
                      <div className="text-[10px] text-[#64748B]">
                        {fmtDateTime(evt.timestamp)}
                      </div>
                      {evt.detail && (
                        <div className="text-xs text-[#334155] mt-0.5">
                          {evt.detail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
