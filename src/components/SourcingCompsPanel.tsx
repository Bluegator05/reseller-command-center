"use client";

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calculator,
  Camera,
  CheckCircle2,
  ExternalLink,
  ImagePlus,
  Loader2,
  PackagePlus,
  Search,
  Smartphone,
  Sparkles,
  Truck,
  X,
} from "lucide-react";
import type { ImageCompResponse } from "@/app/api/ai/comp-image/route";
import { estimateShippingRates } from "@/lib/shipping";
import type { MarketplaceType, QuickAddItemRequest } from "@/lib/types";

interface SourcingCompsPanelProps {
  onSaveToInventory: (payload: QuickAddItemRequest) => Promise<void>;
}

const CHANNEL_FEES: Array<{ key: MarketplaceType; label: string; feePct: number }> = [
  { key: "ebay", label: "eBay (13.25%)", feePct: 13.25 },
  { key: "etsy", label: "Etsy (9.5%)", feePct: 9.5 },
  { key: "poshmark", label: "Poshmark (20%)", feePct: 20 },
  { key: "mercari", label: "Mercari (10%)", feePct: 10 },
  { key: "facebook", label: "FB Market (5%)", feePct: 5 },
];

function fmtMoney(n: number): string {
  return `${n < 0 ? "-$" : "$"}${Math.abs(n).toFixed(2)}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compresses an iPhone camera photo (often 8–12 MB) down to <= 1024px JPEG
 * on an offscreen canvas so mobile cellular comp lookups complete in < 1s.
 */
async function compressImageFile(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read photo"));
    reader.readAsDataURL(file);
  });

  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1024;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.78));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function SourcingCompsPanel({
  onSaveToInventory,
}: SourcingCompsPanelProps) {
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = useState("");
  const [buyCost, setBuyCost] = useState("18");
  const [prepCost, setPrepCost] = useState("0");
  const [estSalePrice, setEstSalePrice] = useState("75");
  const [targetChannel, setTargetChannel] = useState<MarketplaceType>("ebay");
  const [buyerPaysShip, setBuyerPaysShip] = useState(false);
  const [weightOz, setWeightOz] = useState("18");
  const [lengthIn, setLengthIn] = useState("10");
  const [widthIn, setWidthIn] = useState("8");
  const [heightIn, setHeightIn] = useState("4");
  const [isMediaEligible, setIsMediaEligible] = useState(false);
  const [sourceLocation, setSourceLocation] = useState(
    "Goodwill — SE Hawthorne"
  );
  const [binLocation, setBinLocation] = useState("TOTE-1");
  const [receiptRef, setReceiptRef] = useState("");
  const [notes, setNotes] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // Visual Photo Comp state
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [isScanningPhoto, setIsScanningPhoto] = useState(false);
  const [visionResult, setVisionResult] = useState<ImageCompResponse | null>(
    null
  );
  const [visionError, setVisionError] = useState<string | null>(null);

  const shipping = useMemo(
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

  const math = useMemo(() => {
    const cogs = Math.max(0, Number(buyCost) || 0);
    const prep = Math.max(0, Number(prepCost) || 0);
    const sale = Math.max(0, Number(estSalePrice) || 0);
    const feePct =
      CHANNEL_FEES.find((c) => c.key === targetChannel)?.feePct ?? 13.25;
    const fees = round2(sale * (feePct / 100));
    const shipCost =
      buyerPaysShip || targetChannel === "poshmark" || targetChannel === "facebook"
        ? 0
        : shipping.cheapest.price;
    const totalBasis = round2(cogs + prep);
    const netProfit = round2(sale - fees - shipCost - totalBasis);
    const roiPct = totalBasis > 0 ? Math.round((netProfit / totalBasis) * 100) : 0;
    const marginPct = sale > 0 ? Math.round((netProfit / sale) * 100) : 0;
    const maxFor100Roi = round2((sale - fees - shipCost) / 2 - prep);
    const maxFor20Net = round2(sale - fees - shipCost - 20 - prep);
    const maxBuyPrice = Math.max(0, Math.min(maxFor100Roi, maxFor20Net));
    const verdict =
      netProfit >= 25 && roiPct >= 100
        ? "BUY"
        : netProfit >= 15 && roiPct >= 50
          ? "MAYBE"
          : "PASS";
    return {
      cogs,
      prep,
      sale,
      fees,
      shipCost,
      totalBasis,
      netProfit,
      roiPct,
      marginPct,
      maxBuyPrice,
      verdict,
    };
  }, [
    buyCost,
    prepCost,
    estSalePrice,
    targetChannel,
    buyerPaysShip,
    shipping.cheapest.price,
  ]);

  const activeCompQuery =
    visionResult?.ebaySearchQuery || query.trim() || "vintage film camera";
  const ebaySoldUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
    activeCompQuery
  )}&LH_Sold=1&LH_Complete=1`;
  const ebayActiveUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(
    activeCompQuery
  )}`;

  async function handlePhotoSelected(file: File | null | undefined) {
    if (!file) return;
    // Only send a hint if the user manually typed something different from a previous photo match
    const manualHint =
      query.trim() && query.trim() !== (visionResult?.itemTitle || "").trim()
        ? query.trim()
        : undefined;

    // Immediately clear previous photo's comp data so stale results never linger
    setVisionError(null);
    setVisionResult(null);
    setSavedNotice(null);
    setIsScanningPhoto(true);
    try {
      const compressed = await compressImageFile(file);
      setPhotoPreviewUrl(compressed);

      const res = await fetch("/api/ai/comp-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: compressed,
          mimeType: "image/jpeg",
          fileName: file.name,
          hint: manualHint,
        }),
      });
      const data = (await res.json()) as ImageCompResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || "Image identification failed");
      }

      setVisionResult(data);
      if (data.mode === "gemini") {
        if (data.itemTitle) setQuery(data.itemTitle);
        if (data.estMedianPrice > 0) setEstSalePrice(String(data.estMedianPrice));
        if (data.estWeightOz > 0) setWeightOz(String(data.estWeightOz));
        if (data.estLengthIn > 0) setLengthIn(String(data.estLengthIn));
        if (data.estWidthIn > 0) setWidthIn(String(data.estWidthIn));
        if (data.estHeightIn > 0) setHeightIn(String(data.estHeightIn));
        setIsMediaEligible(data.isMediaEligible);
      } else if (!manualHint) {
        setQuery("");
      }
    } catch (err) {
      setVisionError(
        err instanceof Error ? err.message : "Could not analyze photo"
      );
    } finally {
      setIsScanningPhoto(false);
      // Reset file inputs so iPhone Safari fires onChange even when camera reuses image.jpg
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  }

  function clearPhoto() {
    setPhotoPreviewUrl(null);
    setVisionResult(null);
    setVisionError(null);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (uploadInputRef.current) uploadInputRef.current.value = "";
  }

  function resetForNextItem() {
    clearPhoto();
    setQuery("");
    setBuyCost("18");
    setPrepCost("0");
    setEstSalePrice("75");
    setWeightOz("18");
    setLengthIn("10");
    setWidthIn("8");
    setHeightIn("4");
    setIsMediaEligible(false);
    setNotes("");
    setSavedNotice(null);
  }

  async function handleQuickCapture(mode: "draft" | "active") {
    const cleanTitle = query.trim();
    if (!cleanTitle) return;
    setIsSaving(true);
    setSavedNotice(null);
    try {
      const floorPrice = Math.max(
        round2(math.totalBasis * 1.35 + math.shipCost),
        round2(math.sale * 0.72)
      );
      await onSaveToInventory({
        title: cleanTitle,
        brand: visionResult?.brand || null,
        category_hint: visionResult?.category || null,
        cogs: math.cogs,
        prep_cost: math.prep,
        target_price: math.sale || 45,
        floor_price: floorPrice,
        bin_location: binLocation.trim() || "TOTE-1",
        source_location: sourceLocation.trim() || "Thrift Store",
        source_type: "thrift",
        receipt_ref: receiptRef.trim() || null,
        payment_method: "Business Debit",
        weight_oz: Number(weightOz) || null,
        length_in: Number(lengthIn) || null,
        width_in: Number(widthIn) || null,
        height_in: Number(heightIn) || null,
        notes:
          notes.trim() ||
          `Sourced via ${photoPreviewUrl ? "iPhone photo comp" : "mobile comps"} (${shipping.cheapest.label} est. ${fmtMoney(shipping.cheapest.price)})`,
        initialStatus: mode,
      });
      setSavedNotice(
        mode === "draft"
          ? `Saved "${cleanTitle}" to Death Pile (${binLocation || "TOTE-1"}).`
          : `Listed "${cleanTitle}" live in Active Inventory!`
      );
      setQuery("");
      setNotes("");
      clearPhoto();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Hidden native inputs: rear iPhone camera + photo library/desktop picker */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void handlePhotoSelected(f);
        }}
        className="hidden"
      />
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void handlePhotoSelected(f);
        }}
        className="hidden"
      />

      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E] flex items-center justify-center shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-[#14151A]">
              iPhone Sourcing &amp; Photo Comps Mode
            </h2>
            <p className="text-xs text-[#5C606B] mt-0.5">
              Snap a photo with your iPhone camera or type the model for instant
              AI identification, eBay Sold Comps, Ground/Media/UPS/FedEx rates,
              and 1-tap Death Pile capture.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isScanningPhoto}
            onClick={() => cameraInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F766E] text-white text-xs font-bold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer shadow-xs"
          >
            {isScanningPhoto ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Camera className="w-3.5 h-3.5" />
            )}
            <span>Snap Photo Comp</span>
          </button>
          <button
            type="button"
            disabled={isScanningPhoto}
            onClick={() => uploadInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] transition cursor-pointer"
          >
            <ImagePlus className="w-3.5 h-3.5" />
            <span>Upload Photo</span>
          </button>
          <a
            href={ebaySoldUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#A7F3D0] bg-[#ECFDF5] text-[#0F766E] text-xs font-semibold hover:bg-[#D1FAE5] transition"
          >
            <Search className="w-3.5 h-3.5" />
            <span>eBay Sold Comps</span>
            <ExternalLink className="w-3 h-3" />
          </a>
          {(photoPreviewUrl || query.trim()) && (
            <button
              type="button"
              onClick={resetForNextItem}
              className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#5C606B] hover:text-[#14151A] transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Next Item</span>
            </button>
          )}
        </div>
      </section>

      {/* AI Photo Comp Result Banner (when a photo is snapped/uploaded) */}
      {(photoPreviewUrl || isScanningPhoto || visionError) && (
        <section className="bg-white border border-[#A7F3D0] rounded-xl p-4 shadow-xs">
          <div className="flex flex-wrap items-start gap-4">
            {photoPreviewUrl && (
              <div className="relative w-24 h-24 rounded-xl border border-[#E4E4DD] bg-[#FAFBF9] overflow-hidden shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoPreviewUrl}
                  alt="Captured sourcing item"
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={clearPhoto}
                  title="Remove photo"
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/65 text-white flex items-center justify-center cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            <div className="flex-1 min-w-[240px] space-y-2">
              {isScanningPhoto ? (
                <div className="flex items-center gap-2 text-xs font-semibold text-[#0F766E] py-3">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>
                    Identifying item, estimating sold comp range &amp; box
                    shipping specs…
                  </span>
                </div>
              ) : visionError ? (
                <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 text-xs text-[#B91C1C]">
                  {visionError}
                </div>
              ) : visionResult ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          visionResult.mode === "gemini"
                            ? "bg-[#ECFDF5] text-[#0F766E] border-[#A7F3D0]"
                            : "bg-[#FFFBEB] text-[#92400E] border-[#FDE68A]"
                        }`}
                      >
                        <Sparkles className="w-3 h-3" />
                        {visionResult.mode === "gemini"
                          ? "Gemini Vision Match"
                          : "Photo Attached — Add GEMINI_API_KEY in Vercel for Auto-ID"}
                      </span>
                      {visionResult.mode === "gemini" && (
                        <span className="text-[11px] font-mono text-[#5C606B]">
                          {visionResult.brand} · {visionResult.category}
                        </span>
                      )}
                    </div>
                    {visionResult.ebaySearchQuery && (
                      <div className="flex items-center gap-2">
                        <a
                          href={visionResult.ebaySoldUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#0F766E] text-white text-[11px] font-semibold hover:bg-[#0B5B55]"
                        >
                          <span>Sold Comps: &quot;{visionResult.ebaySearchQuery}&quot;</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                        <a
                          href={ebayActiveUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#5C606B] hover:text-[#14151A]"
                        >
                          <span>Active ↗</span>
                        </a>
                      </div>
                    )}
                  </div>

                  {visionResult.mode === "gemini" &&
                    visionResult.estMedianPrice > 0 && (
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <span className="font-semibold text-[#14151A]">
                          Est. Sold Range:{" "}
                          <span className="font-mono text-[#0F766E]">
                            {fmtMoney(visionResult.estLowPrice)} –{" "}
                            {fmtMoney(visionResult.estHighPrice)}
                          </span>
                        </span>
                        <span className="font-mono text-[11px] text-[#5C606B]">
                          (Auto-filled median{" "}
                          <strong>{fmtMoney(visionResult.estMedianPrice)}</strong> ·{" "}
                          {visionResult.estWeightOz} oz ·{" "}
                          {visionResult.estLengthIn}×{visionResult.estWidthIn}×
                          {visionResult.estHeightIn} in)
                        </span>
                      </div>
                    )}

                  {visionResult.inspectionTips.length > 0 && (
                    <div className="rounded-lg bg-[#FFFBEB] border border-[#FDE68A] px-3 py-2 text-[11px] text-[#92400E]">
                      <div className="font-bold mb-0.5">
                        In-Store Inspection Checkpoints:
                      </div>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {visionResult.inspectionTips.map((tip, idx) => (
                          <li key={idx}>{tip}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: In-Store Inputs */}
        <section className="lg:col-span-7 bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-[#14151A]">
              <Calculator className="w-4 h-4 text-[#0F766E]" />
              <span>In-Store Quick Check</span>
            </div>
            <span className="text-[11px] text-[#5C606B]">
              Snap a photo above or type manually
            </span>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                Item Name / Model / Search Query *
              </label>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Sony Walkman WM-FX290, Carhartt J97, Le Creuset #24..."
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-[#DDE2DF] focus:border-[#0F766E] focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Buy Cost ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={buyCost}
                  onChange={(e) => setBuyCost(e.target.value)}
                  className="w-full px-2.5 py-2 text-sm font-mono rounded-lg border border-[#DDE2DF] focus:border-[#0F766E] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Prep / Parts ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={prepCost}
                  onChange={(e) => setPrepCost(e.target.value)}
                  className="w-full px-2.5 py-2 text-sm font-mono rounded-lg border border-[#DDE2DF] focus:border-[#0F766E] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Est. Sale ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={estSalePrice}
                  onChange={(e) => setEstSalePrice(e.target.value)}
                  className="w-full px-2.5 py-2 text-sm font-mono font-bold text-[#0F766E] rounded-lg border border-[#A7F3D0] bg-[#F4FAF8] focus:border-[#0F766E] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Channel
                </label>
                <select
                  value={targetChannel}
                  onChange={(e) =>
                    setTargetChannel(e.target.value as MarketplaceType)
                  }
                  className="w-full px-2 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none"
                >
                  {CHANNEL_FEES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Package Weight & Dims */}
            <div className="p-3.5 rounded-xl bg-[#FAFBF9] border border-[#ECEFE9] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-[#14151A] flex items-center gap-1.5">
                  <Truck className="w-3.5 h-3.5 text-[#0F766E]" />
                  <span>
                    Package Weight &amp; Dimensions (Ground / Media / UPS /
                    FedEx)
                  </span>
                </span>
                <div className="flex items-center gap-3 text-[11px]">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer text-[#444B52]">
                    <input
                      type="checkbox"
                      checked={isMediaEligible}
                      onChange={(e) => setIsMediaEligible(e.target.checked)}
                      className="accent-[#0F766E]"
                    />
                    <span>Media Mail Eligible</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer text-[#444B52]">
                    <input
                      type="checkbox"
                      checked={buyerPaysShip}
                      onChange={(e) => setBuyerPaysShip(e.target.checked)}
                      className="accent-[#0F766E]"
                    />
                    <span>Buyer Pays Ship</span>
                  </label>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="block text-[10px] text-[#5C606B] mb-0.5">
                    Weight (oz)
                  </label>
                  <input
                    type="number"
                    value={weightOz}
                    onChange={(e) => setWeightOz(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#5C606B] mb-0.5">
                    Length (in)
                  </label>
                  <input
                    type="number"
                    value={lengthIn}
                    onChange={(e) => setLengthIn(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#5C606B] mb-0.5">
                    Width (in)
                  </label>
                  <input
                    type="number"
                    value={widthIn}
                    onChange={(e) => setWidthIn(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#5C606B] mb-0.5">
                    Height (in)
                  </label>
                  <input
                    type="number"
                    value={heightIn}
                    onChange={(e) => setHeightIn(e.target.value)}
                    className="w-full px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  />
                </div>
              </div>
            </div>

            {/* Capture Metadata */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Sourcing Location
                </label>
                <input
                  type="text"
                  value={sourceLocation}
                  onChange={(e) => setSourceLocation(e.target.value)}
                  className="w-full px-2.5 py-2 text-xs rounded-lg border border-[#DDE2DF]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Tote / Bin
                </label>
                <input
                  type="text"
                  value={binLocation}
                  onChange={(e) => setBinLocation(e.target.value)}
                  className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  Receipt Ref
                </label>
                <input
                  type="text"
                  value={receiptRef}
                  onChange={(e) => setReceiptRef(e.target.value)}
                  placeholder="GW-1121-01"
                  className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF]"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                Quick Notes (Flaws / Testing)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Clean battery contacts, powers on..."
                className="w-full px-2.5 py-2 text-xs rounded-lg border border-[#DDE2DF]"
              />
            </div>

            {savedNotice && (
              <div className="rounded-lg bg-[#ECFDF5] border border-[#A7F3D0] px-3 py-2 text-xs text-[#0F766E] flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{savedNotice}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={isSaving || !query.trim()}
                onClick={() => handleQuickCapture("draft")}
                className="flex-1 min-w-[180px] py-2.5 px-4 rounded-xl bg-[#FFFBEB] border border-[#F59E0B] text-[#92400E] text-xs font-bold hover:bg-[#FEF3C7] disabled:opacity-50 transition flex items-center justify-center gap-2 cursor-pointer"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <PackagePlus className="w-4 h-4" />
                )}
                <span>Bought It → Save to Death Pile</span>
              </button>
              <button
                type="button"
                disabled={isSaving || !query.trim()}
                onClick={() => handleQuickCapture("active")}
                className="py-2.5 px-4 rounded-xl bg-[#0F766E] text-white text-xs font-bold hover:bg-[#0B5B55] disabled:opacity-50 transition cursor-pointer"
              >
                List Active Now →
              </button>
            </div>
          </div>
        </section>

        {/* Right: Verdict + Shipping Rate Breakdown */}
        <section className="lg:col-span-5 space-y-4">
          <div
            className={`rounded-xl border p-5 space-y-3 ${
              math.verdict === "BUY"
                ? "bg-[#F4FAF8] border-[#A7F3D0]"
                : math.verdict === "MAYBE"
                  ? "bg-[#FFFBEB] border-[#FDE68A]"
                  : "bg-[#FEF2F2] border-[#FECACA]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-[#444B52]">
                Buy Decision
              </span>
              <span
                className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                  math.verdict === "BUY"
                    ? "bg-[#0F766E] text-white"
                    : math.verdict === "MAYBE"
                      ? "bg-[#D97706] text-white"
                      : "bg-[#DC2626] text-white"
                }`}
              >
                {math.verdict === "BUY"
                  ? "STRONG BUY"
                  : math.verdict === "MAYBE"
                    ? "BORDERLINE"
                    : "PASS / NEGOTIATE"}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div className="bg-white/90 rounded-lg p-3 border border-black/5">
                <div className="text-[10px] text-[#5C606B]">Est. True Net</div>
                <div
                  className={`text-lg font-mono font-bold mt-0.5 ${
                    math.netProfit >= 0 ? "text-[#0F766E]" : "text-[#DC2626]"
                  }`}
                >
                  {math.netProfit >= 0 ? "+" : ""}
                  {fmtMoney(math.netProfit)}
                </div>
              </div>
              <div className="bg-white/90 rounded-lg p-3 border border-black/5">
                <div className="text-[10px] text-[#5C606B]">ROI</div>
                <div className="text-lg font-mono font-bold mt-0.5 text-[#14151A]">
                  {math.roiPct}%
                </div>
              </div>
              <div className="bg-white/90 rounded-lg p-3 border border-black/5">
                <div className="text-[10px] text-[#5C606B]">Max Buy Price</div>
                <div className="text-lg font-mono font-bold mt-0.5 text-[#1D4ED8]">
                  {fmtMoney(math.maxBuyPrice)}
                </div>
              </div>
            </div>

            <div className="text-[11px] font-mono text-[#444B52] flex flex-wrap gap-x-3 gap-y-1 pt-1">
              <span>Sale {fmtMoney(math.sale)}</span>
              <span>Fees -{fmtMoney(math.fees)}</span>
              <span>Ship -{fmtMoney(math.shipCost)}</span>
              <span>Basis -{fmtMoney(math.totalBasis)}</span>
            </div>
          </div>

          {/* Carrier Rate Table (Strictly Ground Advantage, Media Mail, UPS, FedEx) */}
          <div className="bg-white border border-[#E4E4DD] rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-[#14151A]">
                Carrier Rate Comparison (No Priority)
              </h3>
              <span className="text-[10px] font-mono text-[#5C606B]">
                {shipping.actualLb.toFixed(1)} lb actual · {shipping.dimLb} lb
                DIM
              </span>
            </div>

            {shipping.dimWeightWarning && shipping.dimWarningText && (
              <div className="rounded-lg bg-[#FFFBEB] border border-[#FDE68A] px-3 py-2 text-[11px] text-[#92400E] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{shipping.dimWarningText}</span>
              </div>
            )}

            <div className="space-y-1.5">
              {shipping.quotes.map((q) => (
                <div
                  key={q.carrier}
                  className={`p-2.5 rounded-lg border flex items-center justify-between gap-2 text-xs ${
                    q.cheapest
                      ? "bg-[#F4FAF8] border-[#A7F3D0]"
                      : "bg-[#FAFBF9] border-[#ECEFE9]"
                  }`}
                >
                  <div>
                    <div className="font-semibold text-[#14151A] flex items-center gap-1.5">
                      <span>{q.label}</span>
                      {q.cheapest && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#0F766E] text-white">
                          Cheapest
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[#5C606B]">
                      {q.service} · {q.note}
                    </div>
                  </div>
                  <div className="font-mono font-bold text-sm text-[#14151A] shrink-0">
                    {fmtMoney(q.price)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
