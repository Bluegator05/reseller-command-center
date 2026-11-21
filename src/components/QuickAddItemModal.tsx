"use client";

import { useMemo, useState } from "react";
import {
  Calendar,
  DollarSign,
  Loader2,
  MapPin,
  PackagePlus,
  Plus,
  X,
} from "lucide-react";
import type { QuickAddItemRequest } from "@/lib/types";

interface QuickAddItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (req: QuickAddItemRequest) => Promise<void>;
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

const PAYMENT_OPTIONS = [
  "Business Amex",
  "Business Debit",
  "Cash",
  "Venmo",
  "Zelle",
  "PayPal",
];

function QuickAddInner({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (req: QuickAddItemRequest) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [sku, setSku] = useState("");
  const [brand, setBrand] = useState("");
  const [condition, setCondition] = useState("Pre-owned — Very Good");
  const [binLocation, setBinLocation] = useState("TOTE-1");
  const [sourceLocation, setSourceLocation] = useState("");
  const [sourceType, setSourceType] = useState("thrift");
  const [acquiredDate, setAcquiredDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [cogs, setCogs] = useState("");
  const [prepCost, setPrepCost] = useState("0");
  const [targetPrice, setTargetPrice] = useState("");
  const [floorPrice, setFloorPrice] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Business Amex");
  const [receiptRef, setReceiptRef] = useState("");
  const [weightOz, setWeightOz] = useState("");
  const [notes, setNotes] = useState("");
  const [initialStatus, setInitialStatus] = useState<"draft" | "active">(
    "draft"
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const preview = useMemo(() => {
    const c = Math.max(0, Number(cogs) || 0);
    const p = Math.max(0, Number(prepCost) || 0);
    const t = Math.max(0, Number(targetPrice) || 0);
    const basis = c + p;
    const estFee = t * 0.1325;
    const net = t - estFee - basis;
    const roi = basis > 0 ? (net / basis) * 100 : 0;
    return { basis, net, roi };
  }, [cogs, prepCost, targetPrice]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setIsSubmitting(true);
    try {
      const parsedCogs = Math.max(0, Number(cogs) || 0);
      const parsedPrep = Math.max(0, Number(prepCost) || 0);
      const parsedTarget = Math.max(
        parsedCogs * 2 || 25,
        Number(targetPrice) || 0
      );
      const parsedFloor =
        Number(floorPrice) > 0
          ? Number(floorPrice)
          : Math.round((parsedCogs + parsedPrep) * 1.4 * 100) / 100;

      await onCreate({
        title: title.trim(),
        sku: sku.trim() || undefined,
        brand: brand.trim() || null,
        condition: condition.trim() || "Pre-owned — Very Good",
        bin_location: binLocation.trim() || null,
        source_location: sourceLocation.trim() || null,
        source_type: sourceType,
        acquired_at: acquiredDate ? `${acquiredDate}T12:00:00.000Z` : null,
        cogs: parsedCogs,
        prep_cost: parsedPrep,
        target_price: parsedTarget,
        floor_price: parsedFloor,
        payment_method: paymentMethod,
        receipt_ref: receiptRef.trim() || null,
        tax_category: "inventory_cogs",
        weight_oz: weightOz.trim() ? Number(weightOz) : null,
        notes: notes.trim() || null,
        initialStatus,
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#ECEFE9] bg-[#FAFBF9] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#ECFDF5] text-[#0F766E] flex items-center justify-center">
              <PackagePlus className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[#171A1D]">
                Quick-Add Sourcing Intake
              </h2>
              <p className="text-[11px] text-[#5F666D]">
                Log a fresh find right when you buy it — track COGS, Death Pile
                age &amp; Schedule C receipts from day one.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close quick-add modal"
            className="p-1.5 rounded-lg text-[#5F666D] hover:bg-[#EDF1EE] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto p-5 space-y-4"
        >
          {/* Intake Mode Switcher */}
          <div className="grid grid-cols-2 gap-2.5 p-1 bg-[#F2F4F3] rounded-xl">
            <button
              type="button"
              onClick={() => setInitialStatus("draft")}
              className={`px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                initialStatus === "draft"
                  ? "bg-white text-[#171A1D] shadow-xs"
                  : "text-[#5F666D] hover:text-[#171A1D]"
              }`}
            >
              📦 Death Pile (Unlisted Backlog)
            </button>
            <button
              type="button"
              onClick={() => setInitialStatus("active")}
              className={`px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                initialStatus === "active"
                  ? "bg-[#0F766E] text-white shadow-xs"
                  : "text-[#5F666D] hover:text-[#171A1D]"
              }`}
            >
              ⚡ List Active on eBay Now
            </button>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#5F666D] mb-1">
              Item Title *
            </label>
            <input
              type="text"
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Canon Sure Shot Telemax 35mm Point & Shoot Film Camera Tested"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Custom SKU (optional)
              </label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Auto-generated if blank"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
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
                placeholder="e.g. Canon, Patagonia"
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Storage Bin / Tote
              </label>
              <input
                type="text"
                value={binLocation}
                onChange={(e) => setBinLocation(e.target.value)}
                placeholder="e.g. TOTE-1 or A-06"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1 text-[11px] font-medium text-[#5F666D] mb-1">
                <MapPin className="w-3 h-3" />
                Where Purchased
              </label>
              <input
                type="text"
                value={sourceLocation}
                onChange={(e) => setSourceLocation(e.target.value)}
                placeholder="e.g. Goodwill SE Hawthorne, Estate Sale"
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Sourcing Channel
              </label>
              <select
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white focus:outline-none focus:border-[#0F766E]"
              >
                {SOURCE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="flex items-center gap-1 text-[11px] font-semibold text-[#5F666D] mb-1">
                <DollarSign className="w-3 h-3" />
                COGS ($) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={cogs}
                onChange={(e) => setCogs(e.target.value)}
                placeholder="12.50"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Prep / Parts ($)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={prepCost}
                onChange={(e) => setPrepCost(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[#5F666D] mb-1">
                Target Ask ($) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                placeholder="89.00"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Floor Price ($)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={floorPrice}
                onChange={(e) => setFloorPrice(e.target.value)}
                placeholder="Auto 1.4× cost"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE] focus:outline-none focus:border-[#0F766E]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="flex items-center gap-1 text-[11px] font-medium text-[#5F666D] mb-1">
                <Calendar className="w-3 h-3" />
                Date Bought
              </label>
              <input
                type="date"
                value={acquiredDate}
                onChange={(e) => setAcquiredDate(e.target.value)}
                className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Payment Method
              </label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full px-2.5 py-2 text-xs rounded-lg border border-[#DCE1DE] bg-white"
              >
                {PAYMENT_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Receipt Ref #
              </label>
              <input
                type="text"
                value={receiptRef}
                onChange={(e) => setReceiptRef(e.target.value)}
                placeholder="e.g. GW-1120"
                className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Weight (oz)
              </label>
              <input
                type="number"
                step="0.5"
                value={weightOz}
                onChange={(e) => setWeightOz(e.target.value)}
                placeholder="16"
                className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-[#DCE1DE]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Condition
              </label>
              <input
                type="text"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#5F666D] mb-1">
                Sourcing Notes / Flaws
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Needs battery & quick wipe-down"
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DCE1DE]"
              />
            </div>
          </div>

          {/* Live Profit Preview Bar */}
          <div className="rounded-xl bg-[#F4FAF8] border border-[#CDECE3] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-[#444B52]">
              Total Cost Basis:{" "}
              <strong className="font-mono text-[#171A1D]">
                ${preview.basis.toFixed(2)}
              </strong>
            </span>
            <span className="text-[#444B52]">
              Est. Net (after 13.25% fee):{" "}
              <strong
                className={`font-mono ${preview.net >= 0 ? "text-[#0F766E]" : "text-[#B91C1C]"}`}
              >
                {preview.net >= 0 ? "+" : ""}${preview.net.toFixed(2)}
              </strong>
            </span>
            <span className="font-mono font-bold text-[#0F766E]">
              {preview.roi.toFixed(0)}% Est. ROI
            </span>
          </div>

          <div className="pt-2 border-t border-[#ECEFE9] flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium text-[#5F666D] hover:bg-[#F2F4F3] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !title.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              {initialStatus === "draft"
                ? "Add to Death Pile"
                : "Create & List Active"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function QuickAddItemModal({
  isOpen,
  onClose,
  onCreate,
}: QuickAddItemModalProps) {
  if (!isOpen) return null;
  return <QuickAddInner onClose={onClose} onCreate={onCreate} />;
}
