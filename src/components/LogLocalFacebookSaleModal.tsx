"use client";

import { useMemo, useRef, useState } from "react";
import {
  Boxes,
  Camera,
  CheckCircle2,
  DollarSign,
  Loader2,
  MapPin,
  Package,
  Search,
  Upload,
  X,
} from "lucide-react";
import { uploadSalePhotoFile } from "@/lib/client-photo-upload";
import type {
  BulkBuyRecord,
  InventoryItem,
  RecordLocalFacebookSaleRequest,
  StaleRadarRow,
} from "@/lib/types";

interface LogLocalFacebookSaleModalProps {
  activeItems: StaleRadarRow[];
  draftItems: InventoryItem[];
  bulkBuys: BulkBuyRecord[];
  onClose: () => void;
  onSubmit: (req: RecordLocalFacebookSaleRequest) => Promise<void>;
}

const PAYMENT_METHODS = ["Cash", "Venmo", "Zelle", "FB Pay"] as const;

function todayLocalYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function LogLocalFacebookSaleModal({
  activeItems,
  draftItems,
  bulkBuys,
  onClose,
  onSubmit,
}: LogLocalFacebookSaleModalProps) {
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<"unlisted" | "existing">("unlisted");
  const [title, setTitle] = useState("");
  const [skuSearch, setSkuSearch] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [soldDate, setSoldDate] = useState(() => todayLocalYmd());
  const [paymentMethod, setPaymentMethod] = useState<string>("Cash");
  const [bulkBuyId, setBulkBuyId] = useState<string>("");
  const [standaloneCogs, setStandaloneCogs] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [notes, setNotes] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [showFeesRow, setShowFeesRow] = useState(false);
  const [marketplaceFees, setMarketplaceFees] = useState("0");
  const [shippingCost, setShippingCost] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const sortedBulkBuys = useMemo(
    () =>
      [...bulkBuys].sort((a, b) =>
        (b.purchase_date || "").localeCompare(a.purchase_date || "")
      ),
    [bulkBuys]
  );

  const selectableItems = useMemo(() => {
    type Candidate = {
      id: string;
      sku: string;
      title: string;
      price: number;
      cogs: number;
      bulkBuyId: string | null;
      isFbLocal: boolean;
      statusLabel: string;
      otherChannels: string[];
      imageUrl: string | null;
    };

    const list: Candidate[] = [];
    for (const row of activeItems) {
      const other = row.cross_listings
        .filter((c) => c.marketplace !== "facebook" && c.status === "active")
        .map((c) => c.marketplace.toUpperCase());
      if (row.marketplace === "ebay" && !other.includes("EBAY")) {
        other.unshift("EBAY");
      }
      list.push({
        id: row.item_id,
        sku: row.sku,
        title: row.title,
        price: Number(row.listed_price || 0),
        cogs: Number(row.cogs || 0),
        bulkBuyId: row.bulk_buy_id ?? null,
        isFbLocal:
          Boolean(row.fb_local_only) ||
          row.marketplace === "facebook" ||
          row.cross_listings.some((c) => c.marketplace === "facebook"),
        statusLabel: "Active",
        otherChannels: other,
        imageUrl: row.image_urls?.[0] || null,
      });
    }

    for (const d of draftItems) {
      const sp = (d.item_specifics || {}) as Record<string, unknown>;
      list.push({
        id: d.id,
        sku: d.sku,
        title: d.title,
        price: Number(d.target_price || 0),
        cogs: Number(d.cogs || 0),
        bulkBuyId:
          typeof sp.bulk_buy_id === "string" && sp.bulk_buy_id.trim()
            ? sp.bulk_buy_id.trim()
            : null,
        isFbLocal: sp.fb_local_only === "true",
        statusLabel: "Death Pile",
        otherChannels: [],
        imageUrl: d.image_urls?.[0] || null,
      });
    }

    // Float Facebook-tagged items to top for fast picking
    list.sort((a, b) => Number(b.isFbLocal) - Number(a.isFbLocal));

    const q = skuSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (it) =>
        it.sku.toLowerCase().includes(q) || it.title.toLowerCase().includes(q)
    );
  }, [activeItems, draftItems, skuSearch]);

  const selectedExistingItem = useMemo(
    () => selectableItems.find((i) => i.id === selectedItemId) || null,
    [selectableItems, selectedItemId]
  );

  const selectedBulkBuy = useMemo(
    () => sortedBulkBuys.find((b) => b.id === bulkBuyId) || null,
    [sortedBulkBuys, bulkBuyId]
  );

  const handleSelectExistingItem = (id: string) => {
    setSelectedItemId(id);
    const hit = selectableItems.find((i) => i.id === id);
    if (!hit) return;
    if (!salePrice && hit.price > 0) {
      setSalePrice(hit.price.toFixed(2));
    }
    if (hit.bulkBuyId) {
      setBulkBuyId(hit.bulkBuyId);
    }
    if (hit.cogs > 0) {
      setStandaloneCogs(hit.cogs.toFixed(2));
    }
    if (!photoUrl && hit.imageUrl) {
      setPhotoUrl(hit.imageUrl);
    }
  };

  const handlePhotoFileSelected = async (file: File) => {
    setError(null);
    setIsUploadingPhoto(true);
    try {
      const hostedUrl = await uploadSalePhotoFile(file);
      setPhotoUrl(hostedUrl);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not process selected photo"
      );
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedPrice = Number(salePrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setError("Enter a sale price greater than $0.");
      return;
    }
    if (mode === "unlisted" && !title.trim()) {
      setError("Enter a title describing what sold.");
      return;
    }
    if (mode === "existing" && !selectedItemId) {
      setError("Pick an existing SKU from your inventory.");
      return;
    }

    setIsSaving(true);
    try {
      await onSubmit({
        mode,
        itemId: mode === "existing" ? selectedItemId : null,
        title: mode === "unlisted" ? title.trim() : undefined,
        salePrice: parsedPrice,
        soldAt: soldDate || todayLocalYmd(),
        paymentMethod,
        buyerName: buyerName.trim() || null,
        notes: notes.trim() || null,
        bulkBuyId: bulkBuyId || null,
        standaloneCogs: !bulkBuyId ? Number(standaloneCogs) || 0 : 0,
        marketplaceFees: showFeesRow ? Number(marketplaceFees) || 0 : 0,
        shippingCost: showFeesRow ? Number(shippingCost) || 0 : 0,
        imageUrl: photoUrl || null,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not record local FB sale"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const numericPrice = Number(salePrice) || 0;
  const numericFees = showFeesRow ? Number(marketplaceFees) || 0 : 0;
  const numericShip = showFeesRow ? Number(shippingCost) || 0 : 0;
  const estCashNet = Math.max(0, numericPrice - numericFees - numericShip);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose();
      }}
    >
      <div className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#E5ECF6] bg-gradient-to-r from-[#EFF6FF] to-[#F8FAFC] flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#1877F2] text-white flex items-center justify-center shrink-0 shadow-xs">
              <MapPin className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[#14151A]">
                Log Local Facebook Marketplace Sale
              </h3>
              <p className="text-[11px] text-[#5C606B] mt-0.5">
                Single entry automatically syncs to{" "}
                <strong className="text-[#14151A]">Sales</strong>,{" "}
                <strong className="text-[#14151A]">Bulk Buys</strong> (COGS
                re-split), <strong className="text-[#14151A]">Inventory</strong>,
                and <strong className="text-[#14151A]">Schedule C Taxes</strong>.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="p-1 rounded-lg text-[#5C606B] hover:bg-white/80 hover:text-[#14151A] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          className="p-5 space-y-4 overflow-y-auto flex-1"
        >
          {error && (
            <div className="px-3 py-2 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C]">
              {error}
            </div>
          )}

          {/* Mode Toggle */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#F2F4F3] border border-[#E4E4DD]">
            <button
              type="button"
              onClick={() => setMode("unlisted")}
              className={`px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                mode === "unlisted"
                  ? "bg-white text-[#14151A] shadow-xs"
                  : "text-[#5C606B] hover:text-[#14151A]"
              }`}
            >
              Quick Local Item
            </button>
            <button
              type="button"
              onClick={() => setMode("existing")}
              className={`px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                mode === "existing"
                  ? "bg-white text-[#14151A] shadow-xs"
                  : "text-[#5C606B] hover:text-[#14151A]"
              }`}
            >
              Existing Inventory SKU ({activeItems.length + draftItems.length})
            </button>
          </div>

          {/* Item Selection / Title */}
          {mode === "unlisted" ? (
            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                WHAT SOLD? *
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Craftsman Lawn Mower, Solid Wood Dresser, Box of Tools…"
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#1877F2] focus:outline-none"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="block text-[11px] font-semibold text-[#444B52]">
                SELECT EXISTING SKU *
              </label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#8E969D] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={skuSearch}
                  onChange={(e) => setSkuSearch(e.target.value)}
                  placeholder="Filter by SKU or item title…"
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#1877F2] focus:outline-none"
                />
              </div>
              <select
                required
                value={selectedItemId}
                onChange={(e) => handleSelectExistingItem(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-white focus:border-[#1877F2] focus:outline-none cursor-pointer"
              >
                <option value="">
                  Choose SKU ({selectableItems.length} available)…
                </option>
                {selectableItems.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.isFbLocal ? "[FB] " : ""}
                    {it.sku} · {it.title.slice(0, 48)}
                    {it.price > 0 ? ` ($${it.price.toFixed(0)})` : ""} ·{" "}
                    {it.statusLabel}
                  </option>
                ))}
              </select>
              {selectedExistingItem &&
                selectedExistingItem.otherChannels.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[11px] text-[#B45309] bg-[#FFFBEB] border border-[#FDE68A] rounded-lg px-2.5 py-1.5">
                    <Package className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Also listed on{" "}
                      <strong>
                        {selectedExistingItem.otherChannels.join(", ")}
                      </strong>{" "}
                      — will automatically end/queue delist to prevent double-selling.
                    </span>
                  </div>
                )}
            </div>
          )}

          {/* Sale Price + Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                SALE PRICE ($) *
              </label>
              <div className="relative">
                <DollarSign className="w-3.5 h-3.5 text-[#0F766E] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full pl-8 pr-3 py-2 text-sm font-mono font-bold text-[#0F766E] rounded-lg border border-[#DDE2DF] bg-white focus:border-[#1877F2] focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                SALE DATE
              </label>
              <input
                type="date"
                value={soldDate}
                onChange={(e) => setSoldDate(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white focus:border-[#1877F2] focus:outline-none"
              />
            </div>
          </div>

          {/* Payment Method Pills */}
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1.5">
              PAYMENT METHOD
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PAYMENT_METHODS.map((pm) => (
                <button
                  key={pm}
                  type="button"
                  onClick={() => setPaymentMethod(pm)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                    paymentMethod === pm
                      ? "bg-[#EFF6FF] border-[#1877F2] text-[#1877F2]"
                      : "bg-white border-[#DDE2DF] text-[#5C606B] hover:border-[#1877F2]"
                  }`}
                >
                  {pm}
                </button>
              ))}
            </div>
          </div>

          {/* Bulk Buy Link & Automatic COGS Re-Split */}
          <div className="rounded-xl border border-[#DCE4E0] bg-[#FAFBF9] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#14151A]">
                <Boxes className="w-3.5 h-3.5 text-[#0F766E]" />
                APPLY TO BULK BUY (AUTO RE-SPLIT COGS)
              </label>
            </div>
            <select
              aria-label="Bulk Buy lot"
              value={bulkBuyId}
              onChange={(e) => setBulkBuyId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none cursor-pointer"
            >
              <option value="">None — Standalone Item (manual COGS)</option>
              {sortedBulkBuys.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.lot_code ? `${b.lot_code} · ` : ""}
                  {b.name} (${Number(b.total_spent || 0).toFixed(0)} spent ·{" "}
                  {b.purchase_date?.slice(0, 10) || "no date"})
                </option>
              ))}
            </select>

            {selectedBulkBuy ? (
              <div className="flex items-start gap-2 text-[11px] text-[#065F46] bg-[#ECFDF5] border border-[#A7F3D0] rounded-lg px-2.5 py-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#0F766E]" />
                <span>
                  Will credit this sale toward{" "}
                  <strong>{selectedBulkBuy.name}</strong> and automatically{" "}
                  <strong>re-split its COGS</strong> across all unlocked items in
                  the lot (preserving closed prior tax years &amp; locked costs).
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-semibold text-[#5C606B] whitespace-nowrap">
                  Standalone COGS Paid ($):
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={standaloneCogs}
                  onChange={(e) => setStandaloneCogs(e.target.value)}
                  placeholder="0.00"
                  className="w-28 px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Photo (Optional) */}
          <div className="rounded-xl border border-[#E4E4DD] bg-[#FAFBF9] p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-[11px] font-semibold text-[#444B52] inline-flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5 text-[#1877F2]" />
                ITEM PHOTO (OPTIONAL)
              </label>
              {photoUrl && (
                <button
                  type="button"
                  onClick={() => setPhotoUrl(null)}
                  className="text-[11px] font-semibold text-[#B91C1C] hover:underline cursor-pointer"
                >
                  Remove
                </button>
              )}
            </div>

            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handlePhotoFileSelected(f);
                e.target.value = "";
              }}
            />

            {photoUrl ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl}
                  alt="Sale item preview"
                  className="w-16 h-16 rounded-lg object-cover border border-[#DDE2DF] bg-white shrink-0"
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="text-[11px] font-semibold text-[#0F766E]">
                    Photo attached — will appear in Sales &amp; Bulk Buys
                  </div>
                  <button
                    type="button"
                    disabled={isUploadingPhoto}
                    onClick={() => photoInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#444B52] hover:border-[#1877F2] hover:text-[#1877F2] cursor-pointer"
                  >
                    <Upload className="w-3 h-3" />
                    Replace Photo
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={isUploadingPhoto}
                onClick={() => photoInputRef.current?.click()}
                className="w-full py-2.5 px-3 rounded-lg border border-dashed border-[#CBD2CE] bg-white hover:border-[#1877F2] hover:bg-[#F8FBFF] text-xs font-semibold text-[#5C606B] hover:text-[#1877F2] inline-flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-50"
              >
                {isUploadingPhoto ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1877F2]" />
                    <span>Uploading photo…</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 h-3.5" />
                    <span>Choose or Take Photo</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* Buyer & Optional Notes */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                BUYER NAME (OPTIONAL)
              </label>
              <input
                type="text"
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                placeholder="e.g. Sarah M."
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#1877F2] focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                NOTES (OPTIONAL)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Porch pickup, bundled 2 items…"
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#1877F2] focus:outline-none"
              />
            </div>
          </div>

          {/* Optional Fees / Shipping toggle (0 by default for local pickup) */}
          <div>
            <button
              type="button"
              onClick={() => setShowFeesRow((v) => !v)}
              className="text-[11px] font-semibold text-[#1877F2] hover:underline cursor-pointer"
            >
              {showFeesRow
                ? "Hide fee / shipping overrides"
                : "+ Add FB fee or shipping cost (default $0 for local pickup)"}
            </button>
            {showFeesRow && (
              <div className="grid grid-cols-2 gap-2.5 mt-2">
                <div>
                  <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                    FB FEE ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={marketplaceFees}
                    onChange={(e) => setMarketplaceFees(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                    SHIPPING PAID ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={shippingCost}
                    onChange={(e) => setShippingCost(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-[#ECECE6] flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-mono text-[#5C606B]">
              Net Payout:{" "}
              <strong className="text-[#0F766E]">
                ${estCashNet.toFixed(2)}
              </strong>{" "}
              · Completed (skips Pick List)
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isSaving || isUploadingPhoto}
                onClick={onClose}
                className="px-3 py-2 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#5C606B] hover:text-[#14151A] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving || isUploadingPhoto}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1877F2] text-white text-xs font-bold hover:bg-[#1565C0] disabled:opacity-50 transition cursor-pointer shadow-xs"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>{isSaving ? "Saving & Syncing…" : "Save Local FB Sale"}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
