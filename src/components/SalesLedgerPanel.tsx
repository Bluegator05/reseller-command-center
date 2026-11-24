"use client";

import { useMemo, useState } from "react";
import {
  Box,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  DollarSign,
  Download,
  Image as ImageIcon,
  Loader2,
  Mail,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  TrendingUp,
  Truck,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import type {
  AutoDelistCascadeResult,
  ChannelJob,
  MarketplaceType,
  OrderFulfillmentStatus,
  SalesOrderRecord,
  SalesOrderUpdateRequest,
  StaleRadarRow,
} from "@/lib/types";

type TimeRangePreset = "all" | "7d" | "30d" | "90d" | "365d" | "custom";

interface SalesLedgerPanelProps {
  activeItems: StaleRadarRow[];
  salesOrders: SalesOrderRecord[];
  recentJobs?: ChannelJob[];
  isLiveMode?: boolean;
  isSyncingEbaySales?: boolean;
  onSyncEbaySales?: (daysBack: number) => Promise<void>;
  onTriggerWebhookSale: (params: {
    itemId: string;
    marketplace: "ebay" | "etsy";
    grossSalePrice: number;
  }) => Promise<AutoDelistCascadeResult | null>;
  onTriggerInboundEmail: (email: {
    from: string;
    subject: string;
    text: string;
  }) => Promise<AutoDelistCascadeResult | null>;
  onUpdateSalesOrder: (req: SalesOrderUpdateRequest) => Promise<void>;
  onSelectOrder?: (order: SalesOrderRecord) => void;
}

const SAMPLE_EMAILS = [
  {
    id: "poshmark",
    label: "Poshmark Sale Email",
    from: "orders@poshmark.com",
    subject: "Congrats! You made a sale on Poshmark — Order #PM-904812",
    text: `Congrats! Your listing has sold on Poshmark.\nOrder #PM-904812\nItem: New Balance 990v5 Made in USA Grey Suede Mens Size 10.5 D\nSold for $136.00\nShipping: $0.00 (Buyer Paid)\nInventory Ref: SNK-NB-990V5-105`,
  },
  {
    id: "mercari",
    label: "Mercari Sale Email",
    from: "no-reply@mercari.com",
    subject: "You sold an item on Mercari! Order ID: MC-7721904",
    text: `You sold Nintendo 64 Atomic Purple Controller OEM Tight Stick Authentic Cleaned\nOrder ID: MC-7721904\nSale Price: $52.00\nShipping: $5.95\nSKU: GAM-N64-ATOMPURP`,
  },
  {
    id: "facebook",
    label: "Facebook Marketplace Email",
    from: "notification@facebookmail.com",
    subject: "Marketplace order confirmed #FB-4410982",
    text: `A buyer purchased your Facebook Marketplace listing.\nOrder #FB-4410982\nItem: Le Creuset #24 4.5 Qt Flame Orange Enameled Cast Iron Dutch Oven France\nBuyer Paid: $173.00\nInventory Ref: KIT-LECR-24DUTCH`,
  },
];

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function defaultRangeDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export function SalesLedgerPanel({
  activeItems,
  salesOrders,
  recentJobs = [],
  isLiveMode = false,
  isSyncingEbaySales = false,
  onSyncEbaySales,
  onTriggerWebhookSale,
  onTriggerInboundEmail,
  onUpdateSalesOrder,
  onSelectOrder,
}: SalesLedgerPanelProps) {
  const [subView, setSubView] = useState<"ledger" | "picklist">("ledger");
  const [ingestMode, setIngestMode] = useState<"webhook" | "email">("email");
  const [showIngestWorkbench, setShowIngestWorkbench] = useState(!isLiveMode);
  const [showDelistLog, setShowDelistLog] = useState(false);
  const [ebayImportDays, setEbayImportDays] = useState<number>(365);
  const [timeRange, setTimeRange] = useState<TimeRangePreset>("all");
  const [customStart, setCustomStart] = useState<string>(() =>
    defaultRangeDate(90)
  );
  const [customEnd, setCustomEnd] = useState<string>(() => defaultRangeDate(0));
  const [mountNow] = useState(() => Date.now());
  const [channelFilter, setChannelFilter] = useState<"all" | MarketplaceType>(
    "all"
  );
  const [missingDataOnly, setMissingDataOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const delistJobs = useMemo(
    () => recentJobs.filter((j) => j.action === "delist"),
    [recentJobs]
  );

  // Pick-list tracking numbers map & Return/Refund modal state
  const [trackingInputs, setTrackingInputs] = useState<Record<string, string>>(
    {}
  );
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [returnModalOrder, setReturnModalOrder] =
    useState<SalesOrderRecord | null>(null);
  const [returnType, setReturnType] =
    useState<OrderFulfillmentStatus>("returned");
  const [refundAmountInput, setRefundAmountInput] = useState("");
  const [returnReasonInput, setReturnReasonInput] = useState("");
  const [restockChecked, setRestockChecked] = useState(true);
  const [previewPhoto, setPreviewPhoto] = useState<{
    url: string;
    title: string;
    sku: string;
  } | null>(null);

  const pickListOrders = useMemo(() => {
    return salesOrders
      .filter(
        (o) =>
          o.fulfillment_status === "to_ship" ||
          o.fulfillment_status === "picked"
      )
      .sort((a, b) =>
        (a.bin_location || "ZZZ").localeCompare(b.bin_location || "ZZZ")
      );
  }, [salesOrders]);

  const openReturnModal = (order: SalesOrderRecord) => {
    setReturnModalOrder(order);
    setReturnType("returned");
    setRefundAmountInput(order.gross_sale_price.toFixed(2));
    setReturnReasonInput(order.return_reason || "");
    setRestockChecked(!order.restocked);
  };

  const handleSubmitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnModalOrder) return;
    setBusyOrderId(returnModalOrder.id);
    try {
      await onUpdateSalesOrder({
        orderId: returnModalOrder.id,
        fulfillment_status: returnType,
        refund_amount:
          returnType === "partial_refund"
            ? Math.max(0, Number(refundAmountInput) || 0)
            : returnModalOrder.gross_sale_price,
        return_reason: returnReasonInput.trim() || null,
        restockAndRelist:
          returnType !== "partial_refund" ? restockChecked : false,
      });
      setReturnModalOrder(null);
    } finally {
      setBusyOrderId(null);
    }
  };

  const handlePickStatus = async (
    order: SalesOrderRecord,
    nextStatus: "to_ship" | "picked" | "shipped"
  ) => {
    setBusyOrderId(order.id);
    try {
      await onUpdateSalesOrder({
        orderId: order.id,
        fulfillment_status: nextStatus,
        tracking_number:
          nextStatus === "shipped"
            ? trackingInputs[order.id]?.trim() ||
              `940011189922${Date.now().toString().slice(-10)}`
            : order.tracking_number,
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  // Webhook simulator state
  const [selectedItemId, setSelectedItemId] = useState<string>(
    activeItems[0]?.item_id || ""
  );
  const [webhookChannel, setWebhookChannel] = useState<"ebay" | "etsy">("ebay");
  const [isFiringWebhook, setIsFiringWebhook] = useState(false);

  // Inbound email tester state
  const [emailFrom, setEmailFrom] = useState(SAMPLE_EMAILS[0].from);
  const [emailSubject, setEmailSubject] = useState(SAMPLE_EMAILS[0].subject);
  const [emailBody, setEmailBody] = useState(SAMPLE_EMAILS[0].text);
  const [isParsingEmail, setIsParsingEmail] = useState(false);

  const [lastCascade, setLastCascade] =
    useState<AutoDelistCascadeResult | null>(null);

  const effectiveItemId = activeItems.some((i) => i.item_id === selectedItemId)
    ? selectedItemId
    : activeItems[0]?.item_id || "";

  const selectedItem = activeItems.find((i) => i.item_id === effectiveItemId);

  const isOrderMissingData = (o: SalesOrderRecord) =>
    o.fulfillment_status !== "unpaid" &&
    (Number(o.cogs || 0) <= 0 || Number(o.shipping_cost || 0) <= 0);

  const missingDataCount = useMemo(
    () => salesOrders.filter(isOrderMissingData).length,
    [salesOrders]
  );

  const filteredOrders = useMemo(() => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startMs =
      timeRange === "7d"
        ? mountNow - 7 * dayMs
        : timeRange === "30d"
          ? mountNow - 30 * dayMs
          : timeRange === "90d"
            ? mountNow - 90 * dayMs
            : timeRange === "365d"
              ? mountNow - 365 * dayMs
              : timeRange === "custom" && customStart
                ? Date.parse(`${customStart}T00:00:00`)
                : null;
    const endMs =
      timeRange === "custom" && customEnd
        ? Date.parse(`${customEnd}T23:59:59.999`)
        : null;

    const searchTokens = searchQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return salesOrders.filter((o) => {
      if (channelFilter !== "all" && o.marketplace !== channelFilter) {
        return false;
      }
      if (missingDataOnly && !isOrderMissingData(o)) {
        return false;
      }
      if (searchTokens.length > 0) {
        const haystack = [
          o.title,
          o.sku,
          o.external_order_id,
          o.tracking_number,
          o.buyer_city,
          o.buyer_state,
          o.buyer_postal,
          o.bin_location,
          o.source_location,
          o.marketplace,
          o.sold_at.slice(0, 10),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!searchTokens.every((t) => haystack.includes(t))) {
          return false;
        }
      }
      const soldMs = Date.parse(o.sold_at);
      if (Number.isNaN(soldMs)) return true;
      if (startMs !== null && !Number.isNaN(startMs) && soldMs < startMs) {
        return false;
      }
      if (endMs !== null && !Number.isNaN(endMs) && soldMs > endMs) {
        return false;
      }
      return true;
    });
  }, [
    salesOrders,
    timeRange,
    customStart,
    customEnd,
    channelFilter,
    missingDataOnly,
    searchQuery,
    mountNow,
  ]);

  const metrics = useMemo(() => {
    const gross = filteredOrders.reduce((s, o) => s + o.gross_sale_price, 0);
    const fees = filteredOrders.reduce((s, o) => s + o.marketplace_fees, 0);
    const shipping = filteredOrders.reduce((s, o) => s + o.shipping_cost, 0);
    const cogs = filteredOrders.reduce(
      (s, o) => s + o.cogs + (o.prep_cost ?? 0),
      0
    );
    const trueNet = filteredOrders.reduce(
      (s, o) => s + o.true_net_after_cogs,
      0
    );
    const delistCount = filteredOrders.reduce(
      (s, o) => s + o.delisted_channels.length,
      0
    );
    const roiPct = cogs > 0 ? (trueNet / cogs) * 100 : 0;
    const avgSale = filteredOrders.length > 0 ? gross / filteredOrders.length : 0;
    return { gross, fees, shipping, cogs, trueNet, delistCount, roiPct, avgSale };
  }, [filteredOrders]);

  const handleExportCsv = () => {
    const header = [
      "Sold Date",
      "SKU",
      "Title",
      "Marketplace",
      "Order ID",
      "Source Location",
      "Date Purchased",
      "Gross Sale",
      "Platform Fees",
      "Shipping Cost",
      "COGS",
      "Prep Cost",
      "Net Profit (Taxable)",
    ];
    const escapeCell = (val: string | number | null | undefined) =>
      `"${String(val ?? "").replace(/"/g, '""')}"`;
    const lines = [
      header.map(escapeCell).join(","),
      ...filteredOrders.map((o) =>
        [
          o.sold_at.slice(0, 10),
          o.sku,
          o.title,
          o.marketplace.toUpperCase(),
          o.external_order_id ?? "",
          o.source_location ?? "",
          o.acquired_at ? o.acquired_at.slice(0, 10) : "",
          o.gross_sale_price.toFixed(2),
          o.marketplace_fees.toFixed(2),
          o.shipping_cost.toFixed(2),
          o.cogs.toFixed(2),
          (o.prep_cost ?? 0).toFixed(2),
          o.true_net_after_cogs.toFixed(2),
        ]
          .map(escapeCell)
          .join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reseller-sales-tax-${timeRange}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFireWebhook = async () => {
    if (!selectedItem) return;
    setIsFiringWebhook(true);
    try {
      const etsyPrice = selectedItem.cross_listings.find(
        (c) => c.marketplace === "etsy"
      )?.listed_price;
      const salePrice =
        webhookChannel === "etsy" && etsyPrice
          ? etsyPrice
          : selectedItem.listed_price;
      const result = await onTriggerWebhookSale({
        itemId: selectedItem.item_id,
        marketplace: webhookChannel,
        grossSalePrice: salePrice,
      });
      if (result) setLastCascade(result);
    } finally {
      setIsFiringWebhook(false);
    }
  };

  const handleParseInboundEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailBody.trim()) return;
    setIsParsingEmail(true);
    try {
      const result = await onTriggerInboundEmail({
        from: emailFrom,
        subject: emailSubject,
        text: emailBody,
      });
      if (result) setLastCascade(result);
    } finally {
      setIsParsingEmail(false);
    }
  };

  const loadSampleEmail = (sampleId: string) => {
    const found = SAMPLE_EMAILS.find((s) => s.id === sampleId);
    if (!found) return;
    setEmailFrom(found.from);
    setEmailSubject(found.subject);
    setEmailBody(found.text);
  };

  const channelPill = (m: MarketplaceType) => {
    const label = m === "facebook" ? "FB" : m.toUpperCase();
    return (
      <span
        key={m}
        className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#F1F1EC] text-[#14151A] font-mono"
      >
        {label}
      </span>
    );
  };

  const rangeButtons: Array<{ key: TimeRangePreset; label: string }> = [
    { key: "7d", label: "Past Week (7d)" },
    { key: "30d", label: "Past Month (30d)" },
    { key: "90d", label: "Quarter (90d)" },
    { key: "365d", label: "Past Year" },
    { key: "all", label: "All Time" },
    { key: "custom", label: "Custom Range" },
  ];

  const statusBadge = (status?: OrderFulfillmentStatus) => {
    switch (status) {
      case "to_ship":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A]">
            To Ship
          </span>
        );
      case "picked":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
            Pulled
          </span>
        );
      case "returned":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]">
            Returned
          </span>
        );
      case "partial_refund":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#FFF7ED] text-[#C2410C] border border-[#FED7AA]">
            Partial Refund
          </span>
        );
      case "unpaid":
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#F3F4F6] text-[#4B5563]">
            Unpaid / Cancelled
          </span>
        );
      default:
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#ECFDF5] text-[#0F766E]">
            Shipped ✓
          </span>
        );
    }
  };

  return (
    <div className="space-y-5">
      {/* Sub-View Mode Switcher: Sales & Returns Ledger vs Pick & Pack List */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 bg-white border border-[#E4E4DD] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <button
            type="button"
            onClick={() => setSubView("ledger")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
              subView === "ledger"
                ? "bg-[#0F766E] text-white"
                : "text-[#5C606B] hover:text-[#14151A]"
            }`}
          >
            <DollarSign className="w-3.5 h-3.5" />
            Sales &amp; Returns Ledger
          </button>
          <button
            type="button"
            onClick={() => setSubView("picklist")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
              subView === "picklist"
                ? "bg-[#0F766E] text-white"
                : "text-[#5C606B] hover:text-[#14151A]"
            }`}
          >
            <ClipboardCheck className="w-3.5 h-3.5" />
            Pick &amp; Pack List (To Ship)
            <span
              className={`font-mono text-[11px] px-1.5 rounded ${
                subView === "picklist"
                  ? "bg-white/20 text-white"
                  : pickListOrders.length > 0
                    ? "bg-[#FFFBEB] text-[#B45309]"
                    : "bg-[#F2F4F3] text-[#5C606B]"
              }`}
            >
              {pickListOrders.length}
            </span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onSyncEbaySales && (
            <div className="inline-flex items-center gap-1.5 bg-white border border-[#DCE1DE] rounded-xl p-1 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
              <select
                value={ebayImportDays}
                onChange={(e) => setEbayImportDays(Number(e.target.value))}
                disabled={isSyncingEbaySales}
                aria-label="eBay sales import range"
                className="px-2 py-1 text-xs font-medium text-[#14151A] bg-transparent focus:outline-none cursor-pointer"
              >
                <option value={90}>Last 90 Days</option>
                <option value={365}>Past Year (365d)</option>
                <option value={730}>All Available (2 Years)</option>
              </select>
              <button
                id="btn-sync-ebay-sales"
                type="button"
                disabled={isSyncingEbaySales}
                onClick={async () => {
                  await onSyncEbaySales(ebayImportDays);
                  setTimeRange("all");
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-55 transition cursor-pointer"
              >
                {isSyncingEbaySales ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {isSyncingEbaySales ? "Importing eBay Sales..." : "Import eBay Sales"}
              </button>
            </div>
          )}

          {subView === "picklist" && (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[#E4E4DD] text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Pick List
            </button>
          )}
        </div>
      </div>

      {subView === "picklist" ? (
        /* Feature #5: Daily Bin-Sorted "To Ship" Pick & Pack List */
        <div className="bg-white border border-[#E4E4DD] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Box className="w-4 h-4 text-[#0F766E]" />
              <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#14151A]">
                Daily Pick &amp; Pack Queue — Sorted by Storage Bin
              </h2>
            </div>
            <span className="text-xs font-mono text-[#5C606B]">
              {pickListOrders.length} order
              {pickListOrders.length === 1 ? "" : "s"} awaiting shipment
            </span>
          </div>

          {pickListOrders.length === 0 ? (
            <div className="py-12 text-center text-xs text-[#5C606B]">
              All sold orders have been packed &amp; shipped! 🎉
            </div>
          ) : (
            <div className="divide-y divide-[#F1F1EC]">
              {pickListOrders.map((order) => {
                const isPicked = order.fulfillment_status === "picked";
                const isBusy = busyOrderId === order.id;
                return (
                  <div
                    key={order.id}
                    className={`p-4 flex flex-wrap items-center justify-between gap-4 transition ${
                      isPicked ? "bg-[#F4FAF8]" : "bg-white hover:bg-[#FAF9F6]"
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          handlePickStatus(
                            order,
                            isPicked ? "to_ship" : "picked"
                          )
                        }
                        title={
                          isPicked
                            ? "Mark as not yet pulled"
                            : "Mark pulled from bin"
                        }
                        className={`mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center shrink-0 cursor-pointer transition ${
                          isPicked
                            ? "bg-[#0F766E] border-[#0F766E] text-white"
                            : "border-[#C9D0CC] bg-white hover:border-[#0F766E]"
                        }`}
                      >
                        {isPicked && <CheckCircle2 className="w-3.5 h-3.5" />}
                      </button>

                      {order.image_url ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewPhoto({
                              url: order.image_url!,
                              title: order.title,
                              sku: order.sku,
                            })
                          }
                          title="View larger photo"
                          className="w-11 h-11 rounded-lg overflow-hidden border border-[#E4E4DD] bg-[#FAF9F6] shrink-0 hover:ring-2 hover:ring-[#0F766E]/40 transition cursor-pointer"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={order.image_url}
                            alt={order.title}
                            loading="lazy"
                            className="w-full h-full object-cover"
                          />
                        </button>
                      ) : (
                        <div className="w-11 h-11 rounded-lg border border-[#E4E4DD] bg-[#FAF9F6] flex items-center justify-center text-[#9CA3AF] shrink-0">
                          <ImageIcon className="w-4 h-4" />
                        </div>
                      )}

                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="px-2 py-0.5 rounded-md text-xs font-mono font-bold bg-[#14151A] text-white">
                            BIN {order.bin_location || "UNASSIGNED"}
                          </span>
                          <code className="px-1.5 py-0.5 rounded bg-[#F1F1EC] text-[11px] font-mono text-[#14151A]">
                            {order.sku}
                          </code>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-[#EFF6FF] text-[#1D4ED8]">
                            {order.marketplace}
                          </span>
                          {statusBadge(order.fulfillment_status)}
                          {order.delisted_channels.map((ch) => (
                            <span
                              key={`pick-delist-${order.id}-${ch}`}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E]"
                            >
                              ✓ Delisted {ch.toUpperCase()}
                            </span>
                          ))}
                        </div>
                        <div className="mt-1 text-sm font-semibold text-[#14151A]">
                          {order.title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs font-mono text-[#5C606B]">
                          <span>
                            Weight:{" "}
                            <strong className="text-[#14151A]">
                              {order.weight_oz ? `${order.weight_oz} oz` : "TBD"}
                            </strong>
                          </span>
                          <span>
                            Box:{" "}
                            <strong className="text-[#14151A]">
                              {order.pkg_dimensions || "Standard Poly/Box"}
                            </strong>
                          </span>
                          <span>Sold {fmtDate(order.sold_at)}</span>
                          <span className="text-[#0F766E] font-semibold">
                            Sale {fmtMoney(order.gross_sale_price)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={trackingInputs[order.id] ?? ""}
                        onChange={(e) =>
                          setTrackingInputs((prev) => ({
                            ...prev,
                            [order.id]: e.target.value,
                          }))
                        }
                        placeholder="Scan / paste tracking #..."
                        className="w-48 px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white focus:outline-none focus:border-[#0F766E]"
                      />
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handlePickStatus(order, "shipped")}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Truck className="w-3.5 h-3.5" />
                        )}
                        Mark Shipped
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <>
      {/* Sales Date & Marketplace Filter Toolbar */}
      <div className="bg-white border border-[#E4E4DD] rounded-xl p-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#5C606B] mr-1">
              <Calendar className="w-3.5 h-3.5 text-[#0F766E]" />
              Period:
            </span>
            {rangeButtons.map((btn) => (
              <button
                key={btn.key}
                type="button"
                onClick={() => setTimeRange(btn.key)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                  timeRange === btn.key
                    ? "bg-[#0F766E] text-white"
                    : "bg-[#F2F4F3] text-[#444B52] hover:bg-[#E7ECEA]"
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredOrders.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#0F766E]/30 bg-[#F4FAF8] text-[#0F766E] hover:bg-[#E3F5EE] disabled:opacity-40 transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export Schedule C CSV ({filteredOrders.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#F1F1EC]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-[#5C606B] mr-1">
              Marketplace:
            </span>
            {(
              ["all", "ebay", "poshmark", "mercari", "etsy", "facebook"] as const
            ).map((ch) => (
              <button
                key={ch}
                type="button"
                onClick={() => setChannelFilter(ch)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium capitalize transition cursor-pointer ${
                  channelFilter === ch
                    ? "bg-[#171A1D] text-white"
                    : "bg-[#F7F9F8] text-[#5C606B] hover:bg-[#ECEFE9]"
                }`}
              >
                {ch === "all" ? "All Channels" : ch === "ebay" ? "eBay" : ch}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMissingDataOnly((v) => !v)}
              title="Show sold orders missing COGS ($0) or shipping cost ($0)"
              className={`ml-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer border ${
                missingDataOnly
                  ? "bg-[#B45309] text-white border-[#B45309]"
                  : "bg-[#FFFBEB] text-[#B45309] border-[#FDE68A] hover:bg-[#FEF3C7]"
              }`}
            >
              Missing Data ({missingDataCount})
            </button>
          </div>

          <div className="relative w-full sm:w-80">
            <Search className="w-3.5 h-3.5 text-[#8A929A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="input-sales-search"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search solds by title, SKU, order #, city, bin..."
              className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-[#DCE1DE] bg-[#F8FAF9] text-[#171A1D] placeholder:text-[#8A929A] focus:bg-white focus:outline-none focus:border-[#0F766E] transition"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear sales search"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-[#8A929A] hover:text-[#171A1D] hover:bg-[#ECEFE9] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {timeRange === "custom" && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="text-[#5C606B] font-medium">From</label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="px-2.5 py-1 rounded-lg border border-[#DCE1DE] font-mono text-xs bg-white text-[#171A1D]"
              />
              <label className="text-[#5C606B] font-medium">To</label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="px-2.5 py-1 rounded-lg border border-[#DCE1DE] font-mono text-xs bg-white text-[#171A1D]"
              />
            </div>
          )}
        </div>
      </div>

      {/* Sales & Protection KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-[#E4E4DD] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5C606B]">
            <span>Gross Sales Volume</span>
            <DollarSign className="w-3.5 h-3.5 text-[#8A8E99]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#14151A]">
              {fmtMoney(metrics.gross)}
            </span>
            <span className="text-xs text-[#5C606B]">
              {filteredOrders.length} orders · avg {fmtMoney(metrics.avgSale)}
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E4E4DD] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5C606B]">
            <span>Realized Net Profit</span>
            <TrendingUp className="w-3.5 h-3.5 text-[#0F766E]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#0F766E]">
              +{fmtMoney(metrics.trueNet)}
            </span>
            <span className="text-xs font-mono text-[#0F766E]">
              {metrics.roiPct.toFixed(0)}% ROI
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E4E4DD] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5C606B]">
            <span>Deductions (COGS + Fees + Ship)</span>
            <Zap className="w-3.5 h-3.5 text-[#8A8E99]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-semibold font-mono tabular-nums text-[#14151A]">
              {fmtMoney(metrics.fees + metrics.cogs + metrics.shipping)}
            </span>
            <span className="text-xs font-mono text-[#5C606B]">
              {fmtMoney(metrics.cogs)} COGS
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowDelistLog((v) => !v)}
          className="text-left bg-white border border-[#E4E4DD] hover:border-[#1D4ED8] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)] transition cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-[#5C606B]">
            <span>Auto-Delists Triggered</span>
            <ShieldCheck className="w-3.5 h-3.5 text-[#1D4ED8]" />
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold font-mono tabular-nums text-[#1D4ED8]">
                {Math.max(metrics.delistCount, delistJobs.length)}
              </span>
              <span className="text-xs text-[#5C606B]">
                double-sells blocked
              </span>
            </div>
            <span className="text-[11px] font-semibold text-[#1D4ED8]">
              {showDelistLog ? "Hide log ▴" : "View log ▾"}
            </span>
          </div>
        </button>
      </div>

      {/* Expandable Auto-Delist Verification Log (eBay API + Poshmark/Mercari Extension) */}
      {showDelistLog && (
        <div className="bg-white border border-[#BFDBFE] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#DBEAFE] bg-[#EFF6FF] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-[#1E40AF]">
              <ShieldCheck className="w-4 h-4" />
              <span>
                Auto-Delist Verification Log ({delistJobs.length} recent)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowDelistLog(false)}
              className="text-[11px] font-semibold text-[#1D4ED8] hover:underline cursor-pointer"
            >
              Close
            </button>
          </div>
          {delistJobs.length === 0 ? (
            <div className="p-4 text-xs text-[#5C606B]">
              No auto-delist jobs logged yet. Whenever an item sells on one
              marketplace and is linked on another, the eBay API / Mac Mini
              delist confirmation appears here automatically.
            </div>
          ) : (
            <div className="divide-y divide-[#F1F1EC]">
              {delistJobs.slice(0, 25).map((job) => {
                const isDone = job.status === "completed";
                const isFailed = job.status === "failed";
                return (
                  <div
                    key={job.id}
                    className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            isDone
                              ? "bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E]"
                              : isFailed
                                ? "bg-[#FEF2F2] border border-[#FECACA] text-[#B91C1C]"
                                : "bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E]"
                          }`}
                        >
                          {isDone
                            ? `✓ Delisted ${job.marketplace}`
                            : isFailed
                              ? `⚠ Failed (${job.marketplace})`
                              : `Queued (${job.marketplace})`}
                        </span>
                        <span className="font-mono text-[11px] font-semibold text-[#14151A]">
                          {job.item_sku || job.item_id.slice(0, 8)}
                        </span>
                        <span className="text-[10px] font-mono text-[#6B7280] uppercase">
                          via {job.execution_mode === "api" ? "API" : "Mac Mini"}
                        </span>
                      </div>
                      <div className="text-xs text-[#444B52] truncate mt-0.5">
                        {job.item_title || "Sold item"}
                        {job.error_message ? (
                          <span className="text-[#B91C1C] ml-1.5">
                            — {job.error_message}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-[#5C606B] shrink-0">
                      {fmtDate(job.completed_at || job.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Anti-Double-Sell Ingestion Workbench (Webhooks + Inbound Email Parser) */}
      <div className="bg-white border border-[#E4E4DD] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setShowIngestWorkbench((v) => !v)}
            className="flex items-center gap-2 text-left cursor-pointer"
          >
            <ShieldCheck className="w-4 h-4 text-[#0F766E]" />
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#14151A]">
              Order-Email Parser &amp; Auto-Delist Tools
            </h2>
            <span className="text-[11px] font-medium text-[#5C606B]">
              {showIngestWorkbench ? "Hide ▴" : "Expand ▾"}
            </span>
          </button>

          {showIngestWorkbench && (
            <div className="flex items-center gap-1 bg-[#F1F1EC] p-0.5 rounded-lg">
              <button
                type="button"
                onClick={() => setIngestMode("email")}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer ${
                  ingestMode === "email"
                    ? "bg-white text-[#14151A] shadow-xs"
                    : "text-[#5C606B]"
                }`}
              >
                <Mail className="w-3.5 h-3.5" />
                Inbound Order-Email Parser
              </button>
              <button
                type="button"
                onClick={() => setIngestMode("webhook")}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer ${
                  ingestMode === "webhook"
                    ? "bg-white text-[#14151A] shadow-xs"
                    : "text-[#5C606B]"
                }`}
              >
                <Webhook className="w-3.5 h-3.5" />
                eBay / Etsy Webhooks
              </button>
            </div>
          )}
        </div>

        {showIngestWorkbench && (
        <div className="p-5">
          {ingestMode === "webhook" ? (
            <div className="space-y-4">
              <p className="text-xs text-[#5C606B]">
                Live webhook endpoints:{" "}
                <code className="font-mono text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                  POST /api/webhooks/ebay
                </code>{" "}
                and{" "}
                <code className="font-mono text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                  POST /api/webhooks/etsy
                </code>
                . Test a sale event below to mark the SKU sold, record{" "}
                <code className="font-mono">sales_orders</code>, and cascade
                delist jobs across all other active channels:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-6">
                  <label className="block text-xs font-semibold text-[#14151A] mb-1">
                    Active SKU to Mark Sold
                  </label>
                  <select
                    value={effectiveItemId}
                    onChange={(e) => setSelectedItemId(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                  >
                    {activeItems.length === 0 ? (
                      <option value="">No active SKUs remaining</option>
                    ) : (
                      activeItems.map((item) => {
                        const otherChannels = item.cross_listings
                          .map((c) => c.marketplace)
                          .join(", ");
                        return (
                          <option key={item.item_id} value={item.item_id}>
                            {item.sku} — {item.title.slice(0, 48)} ($
                            {item.listed_price.toFixed(2)}) [{otherChannels}]
                          </option>
                        );
                      })
                    )}
                  </select>
                </div>

                <div className="md:col-span-3">
                  <label className="block text-xs font-semibold text-[#14151A] mb-1">
                    Selling Webhook Source
                  </label>
                  <select
                    value={webhookChannel}
                    onChange={(e) =>
                      setWebhookChannel(e.target.value as "ebay" | "etsy")
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCDCD5] bg-white text-[#14151A]"
                  >
                    <option value="ebay">eBay Sale Webhook</option>
                    <option value="etsy">Etsy Sale Webhook</option>
                  </select>
                </div>

                <div className="md:col-span-3">
                  <button
                    id="btn-fire-sale-webhook"
                    type="button"
                    disabled={!selectedItem || isFiringWebhook}
                    onClick={handleFireWebhook}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#14151A] text-white hover:bg-[#272A34] disabled:opacity-45 transition cursor-pointer"
                  >
                    {isFiringWebhook ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    Simulate Sale &amp; Delist
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleParseInboundEmail} className="space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-[#5C606B]">
                  Forward Poshmark, Mercari, or Facebook Marketplace order
                  emails to{" "}
                  <code className="font-mono text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                    POST /api/inbound/order-email
                  </code>
                  . Load a sample below to test parsing &amp; auto-delist:
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {SAMPLE_EMAILS.map((sample) => (
                    <button
                      key={sample.id}
                      type="button"
                      onClick={() => loadSampleEmail(sample.id)}
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-[#FAF9F6] border border-[#DCDCD5] hover:bg-[#F1F1EC] text-[#14151A] cursor-pointer"
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={emailFrom}
                  onChange={(e) => setEmailFrom(e.target.value)}
                  placeholder="From address"
                  className="px-3 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white font-mono"
                />
                <input
                  type="text"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  placeholder="Email subject"
                  className="px-3 py-1.5 text-xs rounded-lg border border-[#DCDCD5] bg-white"
                />
              </div>

              <textarea
                rows={4}
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCDCD5] bg-white"
              />

              <button
                id="btn-parse-inbound-email"
                type="submit"
                disabled={isParsingEmail || !emailBody.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#14151A] text-white hover:bg-[#272A34] disabled:opacity-45 cursor-pointer"
              >
                {isParsingEmail ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Mail className="w-3.5 h-3.5" />
                )}
                Parse Order Email &amp; Cascade Delists
              </button>
            </form>
          )}

          {/* Last Cascade Feedback Box */}
          {lastCascade && (
            <div className="mt-4 p-3.5 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-xs space-y-1.5">
              <div className="flex items-center gap-2 font-semibold text-[#0F766E]">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{lastCascade.message}</span>
              </div>
              {lastCascade.cascadedDelists.length > 0 && (
                <ul className="pl-6 list-disc text-[#065F46] space-y-0.5">
                  {lastCascade.cascadedDelists.map((d) => (
                    <li key={d.jobId}>
                      <strong>{d.marketplace.toUpperCase()}</strong> (
                      {d.executionMode}): {d.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Sales Orders Ledger Table */}
      <div className="bg-white border border-[#E4E4DD] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#14151A]">
            Sales Ledger (sales_orders)
          </h2>
          <span className="font-mono text-xs text-[#5C606B]">
            Showing {filteredOrders.length} of {salesOrders.length} sales
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#ECECE6] bg-[#FAF9F6] text-[11px] font-semibold uppercase tracking-[0.05em] text-[#5C606B]">
                <th className="py-2.5 pl-4 pr-3">Item / Order</th>
                <th className="py-2.5 px-3">Sold On</th>
                <th className="py-2.5 px-3">Gross Sale</th>
                <th className="py-2.5 px-3">Fees / Ship / COGS</th>
                <th className="py-2.5 px-3">True Net Profit</th>
                <th className="py-2.5 pl-3 pr-4 text-right">
                  Auto-Delisted Channels
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F1EC] text-sm">
              {filteredOrders.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-10 text-center text-xs text-[#5C606B]"
                  >
                    No sales match the selected date range and channel filter.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-[#FAF9F6]">
                    <td className="py-3 pl-4 pr-3">
                      <div className="flex items-start gap-3">
                        {order.image_url ? (
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewPhoto({
                                url: order.image_url!,
                                title: order.title,
                                sku: order.sku,
                              })
                            }
                            title="View larger photo"
                            className="w-10 h-10 rounded-lg overflow-hidden border border-[#E4E4DD] bg-[#FAF9F6] shrink-0 mt-0.5 hover:ring-2 hover:ring-[#0F766E]/40 transition cursor-pointer"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={order.image_url}
                              alt={order.title}
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                          </button>
                        ) : (
                          <div className="w-10 h-10 rounded-lg border border-[#E4E4DD] bg-[#FAF9F6] flex items-center justify-center text-[#9CA3AF] shrink-0 mt-0.5">
                            <ImageIcon className="w-4 h-4" />
                          </div>
                        )}

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {onSelectOrder ? (
                              <button
                                type="button"
                                onClick={() => onSelectOrder(order)}
                                className="text-left font-medium text-[#14151A] hover:text-[#0F766E] hover:underline line-clamp-1 cursor-pointer"
                              >
                                {order.title}
                              </button>
                            ) : (
                              <span className="font-medium text-[#14151A] line-clamp-1">
                                {order.title}
                              </span>
                            )}
                            {statusBadge(order.fulfillment_status)}
                            {onSelectOrder && (
                              <button
                                type="button"
                                onClick={() => onSelectOrder(order)}
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#F0FDF9] text-[#0F766E] border border-[#CCFBF1] hover:bg-[#CCFBF1] transition cursor-pointer"
                              >
                                P&amp;L · Timeline
                              </button>
                            )}
                            {order.restocked && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#ECFDF5] text-[#0F766E]">
                                Restocked ↻
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-mono text-[#5C606B]">
                            <code className="bg-[#F1F1EC] text-[#14151A] px-1.5 py-0.5 rounded">
                              {order.sku}
                            </code>
                            {order.external_order_id && (
                              <span>#{order.external_order_id}</span>
                            )}
                            <span>· {fmtDate(order.sold_at)}</span>
                            {order.source_location && (
                              <span className="text-[#8A8E99]">
                                · {order.source_location}
                              </span>
                            )}
                          </div>
                          {order.return_reason && (
                            <div className="mt-0.5 text-[11px] text-[#B91C1C]">
                              Note: {order.return_reason}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap">
                      <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase bg-[#EFF6FF] text-[#1D4ED8]">
                        {order.marketplace}
                      </span>
                      <div className="text-[10px] text-[#8A8E99] mt-0.5 font-mono">
                        {order.source}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono tabular-nums font-semibold text-[#14151A] whitespace-nowrap">
                      <div>{fmtMoney(order.gross_sale_price)}</div>
                      {(order.refund_amount ?? 0) > 0 && (
                        <div className="text-[10px] text-[#B91C1C]">
                          Refund -{fmtMoney(order.refund_amount ?? 0)}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 font-mono tabular-nums text-xs text-[#5C606B] whitespace-nowrap">
                      <div>Fee -{fmtMoney(order.marketplace_fees)}</div>
                      <div>
                        COGS -{fmtMoney(order.cogs)}
                        {order.shipping_cost > 0
                          ? ` · Ship -${fmtMoney(order.shipping_cost)}`
                          : ""}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono tabular-nums font-semibold whitespace-nowrap">
                      <span
                        className={
                          order.true_net_after_cogs >= 0
                            ? "text-[#0F766E]"
                            : "text-[#B91C1C]"
                        }
                      >
                        {order.true_net_after_cogs >= 0 ? "+" : ""}
                        {fmtMoney(order.true_net_after_cogs)}
                      </span>
                    </td>
                    <td className="py-3 pl-3 pr-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {order.delisted_channels.map((ch) => channelPill(ch))}
                        <button
                          type="button"
                          onClick={() => openReturnModal(order)}
                          title="Log Return, Partial Refund, Unpaid Cancellation, or Restock SKU"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-[#DDE2DF] bg-white text-[#5C606B] hover:border-[#B91C1C] hover:text-[#B91C1C] transition cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Return
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}

      {/* Feature #3: Return / Partial Refund / Unpaid & 1-Click Restock Modal */}
      {returnModalOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setReturnModalOrder(null);
          }}
        >
          <div className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#ECEFE9] bg-[#FAFBF9] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#171A1D]">
                  Return, Refund or Unpaid Item
                </h3>
                <p className="text-[11px] font-mono text-[#5F666D]">
                  {returnModalOrder.sku} ·{" "}
                  {fmtMoney(returnModalOrder.gross_sale_price)} gross
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReturnModalOrder(null)}
                className="p-1 rounded-lg text-[#5F666D] hover:bg-[#EDF1EE] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitReturn} className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { k: "returned", l: "Full Return" },
                    { k: "partial_refund", l: "Partial Refund" },
                    { k: "unpaid", l: "Unpaid / Cancel" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.k}
                    type="button"
                    onClick={() => {
                      setReturnType(opt.k);
                      if (opt.k === "partial_refund") {
                        setRefundAmountInput("15.00");
                      } else {
                        setRefundAmountInput(
                          returnModalOrder.gross_sale_price.toFixed(2)
                        );
                      }
                    }}
                    className={`px-2.5 py-2 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                      returnType === opt.k
                        ? "bg-[#FEF2F2] border-[#DC2626] text-[#B91C1C]"
                        : "bg-white border-[#E4E4DD] text-[#5C606B] hover:bg-[#FAF9F6]"
                    }`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>

              {returnType === "partial_refund" && (
                <div>
                  <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                    Partial Refund Amount ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max={returnModalOrder.gross_sale_price}
                    value={refundAmountInput}
                    onChange={(e) => setRefundAmountInput(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE]"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] font-medium text-[#5C606B] mb-1">
                  Reason / Audit Note (for Tax &amp; Return Analytics)
                </label>
                <input
                  type="text"
                  value={returnReasonInput}
                  onChange={(e) => setReturnReasonInput(e.target.value)}
                  placeholder="e.g. Doesn't fit, INAD, buyer cancelled before ship"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE]"
                />
              </div>

              {returnType !== "partial_refund" && (
                <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#F4FAF8] border border-[#CDECE3] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={restockChecked}
                    onChange={(e) => setRestockChecked(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-[#0F766E]"
                  />
                  <span className="text-xs text-[#171A1D]">
                    <strong>1-Click Restock &amp; Relist SKU</strong>
                    <span className="block text-[11px] text-[#5F666D] mt-0.5">
                      Returns {returnModalOrder.sku} back to active inventory
                      and recovers COGS ({fmtMoney(returnModalOrder.cogs)}) so
                      your Schedule C math stays exact.
                    </span>
                  </span>
                </label>
              )}

              <div className="pt-2 border-t border-[#ECEFE9] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReturnModalOrder(null)}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-[#5F666D] hover:bg-[#F2F4F3] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyOrderId === returnModalOrder.id}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#B91C1C] text-white hover:bg-[#991B1B] disabled:opacity-50 cursor-pointer"
                >
                  Save Return Update
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Click-to-Enlarge Sold Item Photo Lightbox */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px] p-4"
          onClick={() => setPreviewPhoto(null)}
        >
          <div
            className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-[#ECEFE9] bg-[#FAFBF9] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-bold text-[#171A1D] truncate">
                  {previewPhoto.title}
                </div>
                <div className="text-[11px] font-mono text-[#5F666D]">
                  {previewPhoto.sku}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewPhoto(null)}
                className="p-1 rounded-lg text-[#5F666D] hover:bg-[#EDF1EE] cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 bg-[#FAF9F6] flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewPhoto.url}
                alt={previewPhoto.title}
                className="max-h-[65vh] w-auto rounded-xl object-contain border border-[#E4E4DD] bg-white"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
