"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  Calculator,
  DollarSign,
  ExternalLink,
  FileText,
  Loader2,
  MapPin,
  Package,
  Printer,
  Receipt,
  Save,
  Search,
  Tag,
  Truck,
  X,
} from "lucide-react";
import { estimateShippingRates } from "@/lib/shipping";
import { printThermalSkuLabels } from "@/lib/thermal-label";
import { MarketplaceIcon } from "./MarketplaceIcons";
import type {
  ItemDetailUpdateRequest,
  MarketplaceType,
  StaleRadarRow,
} from "@/lib/types";

interface ItemDetailModalProps {
  row: StaleRadarRow | null;
  onClose: () => void;
  onSave: (updates: ItemDetailUpdateRequest) => Promise<void>;
}

const SOURCE_TYPE_OPTIONS = [
  { value: "thrift", label: "Thrift Store (Goodwill / Savers)" },
  { value: "bins", label: "Goodwill Outlet (Bins)" },
  { value: "estate_sale", label: "Estate Sale" },
  { value: "garage_sale", label: "Garage / Yard Sale" },
  { value: "retail_arbitrage", label: "Retail Arbitrage" },
  { value: "online_arbitrage", label: "Online Arbitrage / FBM Lot" },
  { value: "wholesale", label: "Wholesale / Vintage Picker" },
  { value: "consignment", label: "Consignment" },
  { value: "personal", label: "Personal Closet / Household" },
];

const TAX_CATEGORY_OPTIONS = [
  { value: "inventory_cogs", label: "Schedule C — Inventory COGS" },
  { value: "supplies", label: "Schedule C — Reselling Supplies" },
  { value: "consignment", label: "Consignment (Commission Basis)" },
  { value: "personal_nontaxable", label: "Personal Sale (Sold Below Cost)" },
];

const PAYMENT_METHOD_OPTIONS = [
  "Business Amex",
  "Business Debit",
  "Cash",
  "Venmo",
  "Zelle",
  "PayPal",
  "Check",
];

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fallbackChannelUrl(
  marketplace: MarketplaceType,
  externalId: string | null,
  title: string
): string {
  const q = encodeURIComponent(title);
  switch (marketplace) {
    case "ebay":
      return externalId
        ? `https://www.ebay.com/itm/${externalId}`
        : `https://www.ebay.com/sch/i.html?_nkw=${q}`;
    case "etsy":
      return externalId
        ? `https://www.etsy.com/listing/${externalId}`
        : `https://www.etsy.com/search?q=${q}`;
    case "poshmark":
      return `https://poshmark.com/search?query=${q}`;
    case "mercari":
      return `https://www.mercari.com/search/?keyword=${q}`;
    case "facebook":
      return `https://www.facebook.com/marketplace/search/?query=${q}`;
  }
}

function ItemDetailModalInner({
  row,
  onClose,
  onSave,
}: {
  row: StaleRadarRow;
  onClose: () => void;
  onSave: (updates: ItemDetailUpdateRequest) => Promise<void>;
}) {
  const [title, setTitle] = useState(row.title);
  const [sku, setSku] = useState(row.sku);
  const [condition, setCondition] = useState(row.condition);
  const [brand, setBrand] = useState(row.brand ?? "");
  const [binLocation, setBinLocation] = useState(row.bin_location ?? "");
  const [sourceLocation, setSourceLocation] = useState(
    row.source_location ?? ""
  );
  const [sourceType, setSourceType] = useState(row.source_type ?? "thrift");
  const [acquiredDate, setAcquiredDate] = useState(
    toDateInputValue(row.acquired_at)
  );
  const [cogs, setCogs] = useState(String(row.cogs));
  const [prepCost, setPrepCost] = useState(String(row.prep_cost ?? 0));
  const [floorPrice, setFloorPrice] = useState(String(row.floor_price));
  const [targetPrice, setTargetPrice] = useState(String(row.target_price));
  const [paymentMethod, setPaymentMethod] = useState(
    row.payment_method ?? "Business Amex"
  );
  const [receiptRef, setReceiptRef] = useState(row.receipt_ref ?? "");
  const [taxCategory, setTaxCategory] = useState(
    row.tax_category ?? "inventory_cogs"
  );
  const [weightOz, setWeightOz] = useState(
    row.weight_oz != null ? String(row.weight_oz) : ""
  );
  const [lengthIn, setLengthIn] = useState(
    row.length_in != null ? String(row.length_in) : ""
  );
  const [widthIn, setWidthIn] = useState(
    row.width_in != null ? String(row.width_in) : ""
  );
  const [heightIn, setHeightIn] = useState(
    row.height_in != null ? String(row.height_in) : ""
  );
  const [notes, setNotes] = useState(row.notes ?? "");
  const [isMediaEligible, setIsMediaEligible] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [mountNow] = useState(() => Date.now());

  const shippingEstimate = useMemo(
    () =>
      estimateShippingRates({
        weightOz: Number(weightOz) || 12,
        lengthIn: Number(lengthIn) || 0,
        widthIn: Number(widthIn) || 0,
        heightIn: Number(heightIn) || 0,
        isMediaEligible,
      }),
    [weightOz, lengthIn, widthIn, heightIn, isMediaEligible]
  );

  const liveCalc = useMemo(() => {
    const parsedCogs = Math.max(0, Number(cogs) || 0);
    const parsedPrep = Math.max(0, Number(prepCost) || 0);
    const totalBasis = parsedCogs + parsedPrep;
    const feeRate = 13.25 + (row.promoted_ad_rate_pct || 0);
    const estFees =
      Math.round(
        ((row.listed_price + row.shipping_price) * (feeRate / 100) +
          Number.EPSILON) *
          100
      ) / 100;
    const estNet =
      Math.round((row.listed_price - estFees - totalBasis + Number.EPSILON) * 100) /
      100;
    const roiPct = totalBasis > 0 ? (estNet / totalBasis) * 100 : 0;
    const marginPct =
      row.listed_price > 0 ? (estNet / row.listed_price) * 100 : 0;

    let daysHeld = row.days_since_acquired;
    if (acquiredDate) {
      const ms = Date.parse(`${acquiredDate}T12:00:00Z`);
      if (!Number.isNaN(ms)) {
        daysHeld = Math.max(
          0,
          Math.floor((mountNow - ms) / (1000 * 60 * 60 * 24))
        );
      }
    }
    const deathPileLag = Math.max(0, daysHeld - row.days_listed);

    return {
      totalBasis,
      feeRate,
      estFees,
      estNet,
      roiPct,
      marginPct,
      daysHeld,
      deathPileLag,
    };
  }, [
    acquiredDate,
    cogs,
    mountNow,
    prepCost,
    row.days_listed,
    row.days_since_acquired,
    row.listed_price,
    row.promoted_ad_rate_pct,
    row.shipping_price,
  ]);

  const liveChannels = useMemo(() => {
    const list: Array<{
      marketplace: MarketplaceType;
      price: number;
      url: string;
    }> = [
      {
        marketplace: "ebay",
        price: row.listed_price,
        url:
          row.external_url ||
          fallbackChannelUrl("ebay", row.external_listing_id, row.title),
      },
    ];
    for (const c of row.cross_listings) {
      if (c.marketplace === "ebay") continue;
      list.push({
        marketplace: c.marketplace,
        price: c.listed_price,
        url:
          c.external_url ||
          fallbackChannelUrl(c.marketplace, c.external_listing_id, row.title),
      });
    }
    return list;
  }, [row]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave({
        itemId: row.item_id,
        title: title.trim() || row.title,
        sku: sku.trim() || row.sku,
        condition: condition.trim() || row.condition,
        brand: brand.trim() || null,
        bin_location: binLocation.trim() || null,
        source_location: sourceLocation.trim() || null,
        source_type: sourceType,
        acquired_at: acquiredDate ? `${acquiredDate}T12:00:00.000Z` : null,
        cogs: Math.max(0, Number(cogs) || 0),
        prep_cost: Math.max(0, Number(prepCost) || 0),
        floor_price: Math.max(0, Number(floorPrice) || 0),
        target_price: Math.max(0, Number(targetPrice) || 0),
        payment_method: paymentMethod || null,
        receipt_ref: receiptRef.trim() || null,
        tax_category: taxCategory,
        weight_oz: weightOz.trim() ? Number(weightOz) : null,
        length_in: lengthIn.trim() ? Number(lengthIn) : null,
        width_in: widthIn.trim() ? Number(widthIn) : null,
        height_in: heightIn.trim() ? Number(heightIn) : null,
        notes: notes.trim() || null,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const thumb = row.image_urls[0];
  const ebaySoldCompsUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
    title
  )}&LH_Sold=1&LH_Complete=1`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-[#E5E8E6] rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#ECEFE9] bg-[#FAFBF9] flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-[#5F666D]">
              <span className="px-2 py-0.5 rounded bg-[#ECFDF5] text-[#0F766E] font-semibold">
                {sku || row.sku}
              </span>
              {row.is_newly_listed && (
                <span className="px-2 py-0.5 rounded bg-[#EFF6FF] text-[#1D4ED8] font-semibold">
                  Newly Listed ({row.days_listed}d)
                </span>
              )}
              <span>Listed {row.days_listed}d on eBay</span>
              <span>·</span>
              <span>{row.views_count} views</span>
              <span>·</span>
              <span>{row.watchers_count} watchers</span>
            </div>
            <h2 className="mt-1 text-base font-bold text-[#171A1D] leading-snug">
              Item Details, Sourcing &amp; Tax Ledger
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close item detail modal"
            className="p-1.5 rounded-lg text-[#5F666D] hover:bg-[#EDF1EE] hover:text-[#171A1D] transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-[290px_1fr] divide-y lg:divide-y-0 lg:divide-x divide-[#ECEFE9]"
        >
          {/* Left Column: Photo, Live Channel Links, Real-Time Profit & Tax Calculator */}
          <div className="p-5 bg-[#FAFBF9] space-y-4">
            <div className="w-full aspect-square max-h-[210px] rounded-xl bg-white border border-[#E5E8E6] p-3 flex items-center justify-center overflow-hidden">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumb}
                  alt={row.title}
                  className="w-full h-full object-contain"
                />
              ) : (
                <Package className="w-12 h-12 text-[#C9D0CC]" />
              )}
            </div>

            {/* Live Marketplace Links */}
            <div className="bg-white border border-[#E5E8E6] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[#5F666D]">
                <span>Live Marketplace Links</span>
                <span className="font-mono text-[#0F766E]">
                  {liveChannels.length}/5
                </span>
              </div>
              <div className="space-y-1.5">
                {liveChannels.map((ch) => (
                  <a
                    key={ch.marketplace}
                    href={ch.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-2.5 py-1.5 rounded-lg border border-[#ECEFE9] hover:border-[#0F766E] hover:bg-[#F4FAF8] transition text-xs"
                  >
                    <span className="inline-flex items-center gap-2 font-medium text-[#171A1D] capitalize">
                      <MarketplaceIcon marketplace={ch.marketplace} size={18} />
                      {ch.marketplace === "ebay" ? "eBay" : ch.marketplace}
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono font-semibold text-[#0F766E]">
                      {fmtMoney(ch.price)}
                      <ExternalLink className="w-3 h-3" />
                    </span>
                  </a>
                ))}
              </div>
              <a
                href={ebaySoldCompsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-[#F2F4F3] text-[#171A1D] hover:bg-[#E5ECE8] transition"
              >
                <Search className="w-3.5 h-3.5 text-[#0F766E]" />
                Check eBay Sold Comps
                <ArrowUpRight className="w-3 h-3 text-[#5F666D]" />
              </a>
            </div>

            {/* Live Profit, ROI & Holding Analytics */}
            <div className="bg-white border border-[#E5E8E6] rounded-xl p-3.5 space-y-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#5F666D]">
                <Calculator className="w-3.5 h-3.5 text-[#0F766E]" />
                <span>Live Profit &amp; Tax Basis</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-[#5F666D]">eBay Ask Price</span>
                  <span className="font-mono font-semibold text-[#171A1D]">
                    {fmtMoney(row.listed_price)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5F666D]">
                    Est. Fees ({liveCalc.feeRate.toFixed(2)}%)
                  </span>
                  <span className="font-mono text-[#B91C1C]">
                    -{fmtMoney(liveCalc.estFees)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5F666D]">
                    Total Cost Basis (COGS+Prep)
                  </span>
                  <span className="font-mono text-[#B91C1C]">
                    -{fmtMoney(liveCalc.totalBasis)}
                  </span>
                </div>
                <div className="pt-2 border-t border-[#ECEFE9] flex justify-between items-baseline">
                  <span className="font-semibold text-[#171A1D]">
                    Est. Net Profit
                  </span>
                  <span
                    className={`font-mono text-sm font-bold ${
                      liveCalc.estNet >= 0 ? "text-[#0F766E]" : "text-[#B91C1C]"
                    }`}
                  >
                    {liveCalc.estNet >= 0 ? "+" : ""}
                    {fmtMoney(liveCalc.estNet)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1.5">
                  <div className="rounded-lg bg-[#F4FAF8] border border-[#D4EDE5] px-2.5 py-1.5">
                    <div className="text-[10px] text-[#5F666D]">Est. ROI</div>
                    <div className="font-mono font-bold text-xs text-[#0F766E]">
                      {liveCalc.roiPct.toFixed(0)}%
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#F7F9F8] border border-[#E5E8E6] px-2.5 py-1.5">
                    <div className="text-[10px] text-[#5F666D]">Net Margin</div>
                    <div className="font-mono font-bold text-xs text-[#171A1D]">
                      {liveCalc.marginPct.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="pt-1 text-[11px] text-[#5F666D] flex items-center justify-between">
                  <span>Held since purchase:</span>
                  <span className="font-mono font-semibold text-[#171A1D]">
                    {liveCalc.daysHeld}d ({liveCalc.deathPileLag}d pre-list)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Editable Fields */}
          <div className="p-5 space-y-5">
            {/* Section 1: Core Item Identity */}
            <div className="space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#0F766E]">
                <Tag className="w-3.5 h-3.5" />
                <span>Item Identity &amp; Warehouse</span>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                  Listing Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-medium rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Custom SKU
                  </label>
                  <input
                    type="text"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="e.g. CAM-OLY-01"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Storage Bin / Shelf
                  </label>
                  <input
                    type="text"
                    value={binLocation}
                    onChange={(e) => setBinLocation(e.target.value)}
                    placeholder="e.g. Bin A-04"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Brand
                  </label>
                  <input
                    type="text"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Brand"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
              </div>
            </div>

            {/* Section 2: Sourcing, COGS & Tax Accounting */}
            <div className="space-y-3 pt-3 border-t border-[#ECEFE9]">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#0F766E]">
                <Receipt className="w-3.5 h-3.5" />
                <span>Sourcing, Cost Basis &amp; Schedule C Tax Details</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-1 text-[11px] font-medium text-[#5F666D] mb-1">
                    <MapPin className="w-3 h-3" />
                    Where Purchased (Store / Seller / City)
                  </label>
                  <input
                    type="text"
                    value={sourceLocation}
                    onChange={(e) => setSourceLocation(e.target.value)}
                    placeholder="e.g. Goodwill SE Hawthorne, Estate Sale"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Sourcing Channel (for ROI Analytics)
                  </label>
                  <select
                    value={sourceType}
                    onChange={(e) => setSourceType(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  >
                    {SOURCE_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="flex items-center gap-1 text-[11px] font-medium text-[#5F666D] mb-1">
                    <DollarSign className="w-3 h-3" />
                    Cost of Goods
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={cogs}
                    onChange={(e) => setCogs(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Prep / Repair Cost
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={prepCost}
                    onChange={(e) => setPrepCost(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    COGS Floor ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={floorPrice}
                    onChange={(e) => setFloorPrice(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Target Ask ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="flex items-center gap-1 text-[11px] font-medium text-[#5F666D] mb-1">
                    <Calendar className="w-3 h-3" />
                    Date Purchased
                  </label>
                  <input
                    type="date"
                    value={acquiredDate}
                    onChange={(e) => setAcquiredDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Payment Method
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  >
                    {PAYMENT_METHOD_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Receipt / Lot Ref #
                  </label>
                  <input
                    type="text"
                    value={receiptRef}
                    onChange={(e) => setReceiptRef(e.target.value)}
                    placeholder="e.g. GW-90218"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Tax Category (Schedule C)
                  </label>
                  <select
                    value={taxCategory}
                    onChange={(e) => setTaxCategory(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  >
                    {TAX_CATEGORY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Condition
                  </label>
                  <input
                    type="text"
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                  />
                </div>
              </div>
            </div>

            {/* Section 3: Shipping Dimensions & Notes */}
            <div className="space-y-3 pt-3 border-t border-[#ECEFE9]">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#0F766E]">
                <FileText className="w-3.5 h-3.5" />
                <span>Shipping Specs &amp; Reseller Notes</span>
              </div>

              <div className="grid grid-cols-4 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Weight (oz)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={weightOz}
                    onChange={(e) => setWeightOz(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Length (in)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    value={lengthIn}
                    onChange={(e) => setLengthIn(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Width (in)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    value={widthIn}
                    onChange={(e) => setWidthIn(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE]"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                    Height (in)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    value={heightIn}
                    onChange={(e) => setHeightIn(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE]"
                  />
                </div>
              </div>

              <div className="rounded-xl bg-[#FAFBF9] border border-[#ECEFE9] p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-[#171A1D] flex items-center gap-1.5">
                    <Truck className="w-3.5 h-3.5 text-[#0F766E]" />
                    <span>
                      Shipping Estimate ({shippingEstimate.actualLb.toFixed(1)} lb actual ·{" "}
                      {shippingEstimate.dimLb} lb DIM)
                    </span>
                  </span>
                  <label className="inline-flex items-center gap-1.5 text-[#5F666D] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isMediaEligible}
                      onChange={(e) => setIsMediaEligible(e.target.checked)}
                      className="accent-[#0F766E]"
                    />
                    <span>Media Mail Eligible</span>
                  </label>
                </div>

                {shippingEstimate.dimWeightWarning &&
                  shippingEstimate.dimWarningText && (
                    <div className="rounded-lg bg-[#FFFBEB] border border-[#FDE68A] px-2.5 py-1.5 text-[11px] text-[#92400E] flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{shippingEstimate.dimWarningText}</span>
                    </div>
                  )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {shippingEstimate.quotes.map((q) => (
                    <div
                      key={q.carrier}
                      className={`rounded-lg border px-2.5 py-2 text-[11px] ${
                        q.cheapest
                          ? "bg-[#F4FAF8] border-[#A7F3D0]"
                          : "bg-white border-[#ECEFE9]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-[#171A1D] truncate">
                          {q.label}
                        </span>
                        <span className="font-mono font-bold text-[#0F766E]">
                          ${q.price.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-[10px] text-[#5F666D] truncate mt-0.5">
                        {q.service}
                        {q.cheapest ? " · Cheapest" : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                  Detailed Notes (Flaws, Measurements, Comps, Serial #s, Tax Audit Trail)
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add sourcing notes, measurements, authentication details, bundle split math..."
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white text-[#171A1D] focus:outline-none focus:border-[#0F766E]"
                />
              </div>
            </div>

            {/* Action Footer */}
            <div className="pt-3 border-t border-[#ECEFE9] flex flex-wrap items-center justify-between gap-2.5">
              <button
                type="button"
                onClick={() =>
                  printThermalSkuLabels([
                    {
                      sku: sku.trim() || row.sku,
                      bin: binLocation.trim() || row.bin_location,
                      title: title.trim() || row.title,
                      acquiredAt: acquiredDate || row.acquired_at,
                      cogs: Number(cogs) || row.cogs,
                      price: row.listed_price,
                    },
                  ])
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#DCE1DE] bg-white text-xs font-semibold text-[#171A1D] hover:border-[#0F766E] hover:text-[#0F766E] transition cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print 2×1 SKU Label</span>
              </button>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg text-xs font-medium text-[#5F666D] hover:bg-[#F2F4F3] transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer shadow-sm"
                >
                  {isSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  Save Item &amp; Tax Details
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ItemDetailModal({
  row,
  onClose,
  onSave,
}: ItemDetailModalProps) {
  if (!row) return null;
  return (
    <ItemDetailModalInner
      key={row.item_id}
      row={row}
      onClose={onClose}
      onSave={onSave}
    />
  );
}
