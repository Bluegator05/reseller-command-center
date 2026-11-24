"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Copy,
  Crop,
  ExternalLink,
  ImagePlus,
  Loader2,
  Plus,
  Printer,
  RotateCw,
  Rocket,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wand2,
  X,
  Zap,
} from "lucide-react";
import type { ListingStudioDraftResponse } from "@/app/api/ai/listing-studio/route";
import type {
  StudioConditionChoice,
  SuggestedEbayCategory,
} from "@/lib/ebay";
import { printThermalSkuLabels } from "@/lib/thermal-label";
import type { InventoryItem, MarketplaceType } from "@/lib/types";
import { generateSubjectCutoutPng } from "@/lib/white-bg-ai";
import {
  PhotoCropModal,
  type NormalizedCropRect,
} from "./PhotoCropModal";

const MAX_STUDIO_PHOTOS = 24;

interface ListingStudioPanelProps {
  draftItems: InventoryItem[];
  isLiveMode?: boolean;
  onPublished: (result: {
    sku: string;
    ebayUrl?: string | null;
    message: string;
  }) => Promise<void>;
}

interface StudioPhoto {
  id: string;
  name: string;
  originalDataUrl: string; // EXIF-stripped resized <= 1600px JPEG
  processedDataUrl: string; // after rotation + crop + enhance + whiteBg
  cutoutDataUrl?: string | null; // cached AI transparent PNG cutout of originalDataUrl
  rotation: number; // 0 | 90 | 180 | 270
  crop: NormalizedCropRect | null;
  enhanced: boolean;
  whiteBg: boolean;
  hostedUrl?: string | null;
}

const TESTED_OPTIONS = [
  "Doesn't apply",
  "Not tested",
  "Powers on only",
  "Tested, works",
  "Tested, has issues",
] as const;

const CONDITION_OPTIONS: Array<{
  key: "decide" | StudioConditionChoice;
  label: string;
}> = [
  { key: "decide", label: "Decide from photos" },
  { key: "new_sealed", label: "New, sealed" },
  { key: "new_opened", label: "New, opened" },
  { key: "pre_owned", label: "Pre-owned" },
  { key: "for_parts", label: "For parts" },
];

type LocationKind = "Shelf" | "Garage" | "Closet" | "Rack" | "Clothes";

const STORAGE_KEY_SKU_PREFS = "rcc_listing_studio_sku_prefs_v1";

function todayShortDate(): string {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

function buildSkuString(parts: {
  source: string;
  dateStr: string;
  locKind: LocationKind;
  locCode: string;
  itemNum: string;
}): string {
  const src = parts.source.trim();
  const dt = parts.dateStr.trim();
  const code = parts.locCode.trim().toUpperCase();
  const num = parts.itemNum.trim();

  let locChunk = "";
  if (parts.locKind === "Shelf") {
    locChunk = code ? `Shelf ${code}` : "Shelf";
  } else if (parts.locKind === "Garage") {
    locChunk = code
      ? code.startsWith("G")
        ? code
        : `G${code}`
      : "G1";
  } else if (parts.locKind === "Closet") {
    locChunk = "Closet";
  } else if (parts.locKind === "Rack") {
    locChunk = "Rack";
  } else {
    locChunk = "";
  }

  const pieces = [src, dt, locChunk].filter(Boolean);
  const base = pieces.join(". ");
  if (num) {
    return base ? `${base} - ${num}` : num;
  }
  return base;
}

function buildBinLabel(locKind: LocationKind, locCode: string): string {
  const code = locCode.trim().toUpperCase();
  if (locKind === "Shelf") return code ? `Shelf ${code}` : "Shelf";
  if (locKind === "Garage") {
    return code ? (code.startsWith("G") ? code : `G${code}`) : "G1";
  }
  return locKind;
}

/**
 * Loads an uploaded File, auto-orients it via browser decoder, resizes to max 1600px,
 * and re-encodes as JPEG 0.90 — which strips 100% of EXIF/GPS metadata automatically.
 */
async function normalizeUploadedPhoto(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read photo file"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not decode image"));
    el.src = dataUrl;
  });

  const maxDim = 1600;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * Applies optional Rotation, Crop, Auto-Enhance (brightness/contrast/saturation boost),
 * and White Studio Background (using the neural AI transparent PNG cutout centered
 * onto a crisp #FFFFFF 1:1 studio canvas) cleanly in the browser without modifying
 * the original photo.
 */
async function renderProcessedPhoto(
  originalDataUrl: string,
  opts: {
    rotation: number;
    crop: NormalizedCropRect | null;
    enhanced: boolean;
    whiteBg: boolean;
    cutoutDataUrl?: string | null;
  }
): Promise<string> {
  if (opts.rotation === 0 && !opts.crop && !opts.enhanced && !opts.whiteBg) {
    return originalDataUrl;
  }

  const useCutout = Boolean(opts.whiteBg && opts.cutoutDataUrl);
  const sourceUrl = useCutout ? opts.cutoutDataUrl! : originalDataUrl;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Image processing failed"));
    el.src = sourceUrl;
  });

  const rad = ((opts.rotation % 360) * Math.PI) / 180;
  const rotated = opts.rotation % 180 !== 0;
  const rotW = rotated ? img.naturalHeight : img.naturalWidth;
  const rotH = rotated ? img.naturalWidth : img.naturalHeight;

  // Step 1: Draw rotated image onto intermediate canvas (transparent when compositing cutout)
  const rotCanvas = document.createElement("canvas");
  rotCanvas.width = rotW;
  rotCanvas.height = rotH;
  const rotCtx = rotCanvas.getContext("2d", { willReadFrequently: true });
  if (!rotCtx) return originalDataUrl;

  if (!useCutout) {
    rotCtx.fillStyle = "#FFFFFF";
    rotCtx.fillRect(0, 0, rotW, rotH);
  }
  rotCtx.save();
  rotCtx.translate(rotW / 2, rotH / 2);
  rotCtx.rotate(rad);
  if (opts.enhanced) {
    rotCtx.filter = useCutout
      ? "brightness(1.06) contrast(1.07) saturate(1.06)"
      : "brightness(1.08) contrast(1.09) saturate(1.07)";
  }
  rotCtx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  rotCtx.restore();

  // Step 2: Apply normalized crop rectangle (if set)
  const cropX = opts.crop ? Math.round(opts.crop.x * rotW) : 0;
  const cropY = opts.crop ? Math.round(opts.crop.y * rotH) : 0;
  const srcW = opts.crop
    ? Math.max(16, Math.round(opts.crop.w * rotW))
    : rotW;
  const srcH = opts.crop
    ? Math.max(16, Math.round(opts.crop.h * rotH))
    : rotH;

  if (useCutout) {
    // Extract cropped transparent subject
    const subCanvas = document.createElement("canvas");
    subCanvas.width = srcW;
    subCanvas.height = srcH;
    const subCtx = subCanvas.getContext("2d", { willReadFrequently: true });
    if (!subCtx) return originalDataUrl;
    subCtx.drawImage(rotCanvas, cropX, cropY, srcW, srcH, 0, 0, srcW, srcH);

    // Auto-trim transparent border around subject when no manual crop was specified
    let trimX = 0;
    let trimY = 0;
    let trimW = srcW;
    let trimH = srcH;

    if (!opts.crop) {
      const alphaData = subCtx.getImageData(0, 0, srcW, srcH).data;
      let minX = srcW;
      let minY = srcH;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < srcH; y++) {
        const rowOffset = y * srcW;
        for (let x = 0; x < srcW; x++) {
          if (alphaData[(rowOffset + x) * 4 + 3] > 20) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX > minX + 16 && maxY > minY + 16) {
        trimX = minX;
        trimY = minY;
        trimW = maxX - minX + 1;
        trimH = maxY - minY + 1;
      }
    }

    // Center subject onto crisp pure #FFFFFF 1:1 studio square with ~6% clean margin
    const side = Math.min(
      1600,
      Math.max(1000, Math.round(Math.max(trimW, trimH) / 0.88))
    );
    const sq = document.createElement("canvas");
    sq.width = side;
    sq.height = side;
    const sctx = sq.getContext("2d");
    if (sctx) {
      sctx.fillStyle = "#FFFFFF";
      sctx.fillRect(0, 0, side, side);
      const scale = Math.min(side / trimW, side / trimH) * 0.88;
      const dw = Math.max(1, Math.round(trimW * scale));
      const dh = Math.max(1, Math.round(trimH * scale));
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(
        subCanvas,
        trimX,
        trimY,
        trimW,
        trimH,
        Math.round((side - dw) / 2),
        Math.round((side - dh) / 2),
        dw,
        dh
      );
      return sq.toDataURL("image/jpeg", 0.92);
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return originalDataUrl;

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, srcW, srcH);
  ctx.drawImage(rotCanvas, cropX, cropY, srcW, srcH, 0, 0, srcW, srcH);

  return canvas.toDataURL("image/jpeg", 0.91);
}

/** Resize down to <= 800px JPEG 0.74 solely for fast Gemini Vision analysis payload */
async function shrinkForAiVision(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Shrink failed"));
    el.src = dataUrl;
  });
  const maxDim = 800;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.74);
}

/**
 * Samples up to `limit` representative photos across a large gallery (up to 24 photos)
 * so Gemini Vision always inspects the main cover, hero angle, middle angles, AND the
 * last 3 shots where brand/size tags, model plates, bottoms, and flaws usually live.
 */
function selectRepresentativeVisionPhotos<T>(list: T[], limit = 8): T[] {
  if (list.length <= limit) return list;
  const indices = new Set<number>();
  indices.add(0);
  indices.add(1);
  indices.add(list.length - 1);
  indices.add(list.length - 2);
  indices.add(list.length - 3);

  const slotsLeft = limit - indices.size;
  const midStart = 2;
  const midEnd = list.length - 4;
  if (slotsLeft > 0 && midEnd >= midStart) {
    for (let k = 1; k <= slotsLeft; k++) {
      const idx = Math.round(
        midStart + ((midEnd - midStart) * k) / (slotsLeft + 1)
      );
      indices.add(Math.min(midEnd, Math.max(midStart, idx)));
    }
  }

  return Array.from(indices)
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map((i) => list[i]);
}

function buildHtmlFromPlain(plain: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const blocks = plain
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const htmlBlocks = blocks.map((b) => {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => l.startsWith("•") || l.startsWith("-") || /^(Condition|Testing|Included|Not Included|Flaws|Measurements):/i.test(l))) {
      return `<ul style="margin:0 0 12px 0;padding-left:20px;font-size:14px;">${lines
        .map((l) => `<li>${esc(l.replace(/^[•\-]\s*/, ""))}</li>`)
        .join("")}</ul>`;
    }
    return `<p style="margin:0 0 12px 0;font-size:15px;">${lines.map(esc).join("<br/>")}</p>`;
  });
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;line-height:1.55;max-width:720px;">${htmlBlocks.join("")}</div>`;
}

export function ListingStudioPanel({
  draftItems,
  isLiveMode = false,
  onPublished,
}: ListingStudioPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const draftSectionRef = useRef<HTMLDivElement | null>(null);

  // Photos
  const [photos, setPhotos] = useState<StudioPhoto[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [dragPhotoIdx, setDragPhotoIdx] = useState<number | null>(null);
  const [processingPhotoId, setProcessingPhotoId] = useState<string | null>(null);
  const [processingPhotoLabel, setProcessingPhotoLabel] = useState<string | null>(
    null
  );

  const loadSavedSkuPrefs = (): {
    source?: string;
    locKind?: LocationKind;
    locCode?: string;
    itemNum?: string;
  } => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY_SKU_PREFS);
      return raw
        ? (JSON.parse(raw) as {
            source?: string;
            locKind?: LocationKind;
            locCode?: string;
            itemNum?: string;
          })
        : {};
    } catch {
      return {};
    }
  };

  // SKU Builder & Basics
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  const [skuSource, setSkuSource] = useState(
    () => loadSavedSkuPrefs().source ?? "SA730"
  );
  const [skuDate, setSkuDate] = useState(() => todayShortDate());
  const [locKind, setLocKind] = useState<LocationKind>(
    () => loadSavedSkuPrefs().locKind ?? "Shelf"
  );
  const [locCode, setLocCode] = useState(
    () => loadSavedSkuPrefs().locCode ?? "N"
  );
  const [itemNum, setItemNum] = useState(
    () => loadSavedSkuPrefs().itemNum ?? ""
  );
  const [customSkuOverride, setCustomSkuOverride] = useState<string | null>(null);
  const [cogsInput, setCogsInput] = useState("");
  const [whatIsIt, setWhatIsIt] = useState("");
  const [sellOn, setSellOn] = useState<"ebay" | "facebook" | "both">("ebay");
  const [crossListPoshmark, setCrossListPoshmark] = useState(true);
  const [crossListMercari, setCrossListMercari] = useState(true);
  const [freeShipping, setFreeShipping] = useState(false); // Default: Buyer Pays Calculated Shipping!
  const [instantPublish, setInstantPublish] = useState(false);

  // What You Know
  const [testedStatus, setTestedStatus] =
    useState<(typeof TESTED_OPTIONS)[number]>("Doesn't apply");
  const [conditionInput, setConditionInput] = useState<
    "decide" | StudioConditionChoice
  >("decide");
  const [included, setIncluded] = useState("");
  const [missing, setMissing] = useState("");
  const [flaws, setFlaws] = useState("");
  const [measurementsWeight, setMeasurementsWeight] = useState("");
  const [notes, setNotes] = useState("");
  const [lowestPrice, setLowestPrice] = useState("");

  // AI Draft State
  const [isGenerating, setIsGenerating] = useState(false);
  const [draft, setDraft] = useState<ListingStudioDraftResponse | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBrand, setEditBrand] = useState("");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editCategoryPath, setEditCategoryPath] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<
    SuggestedEbayCategory[]
  >([]);
  const [categorySearchQuery, setCategorySearchQuery] = useState("");
  const [isSearchingCategories, setIsSearchingCategories] = useState(false);
  const [categorySearchNote, setCategorySearchNote] = useState<string | null>(
    null
  );
  const [editCondition, setEditCondition] =
    useState<StudioConditionChoice>("pre_owned");
  const [editCondDesc, setEditCondDesc] = useState("");
  const [editDescPlain, setEditDescPlain] = useState("");
  const [editFbCopy, setEditFbCopy] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editFloorPrice, setEditFloorPrice] = useState("");
  const [editQty, setEditQty] = useState("1");
  const [editWeightLbs, setEditWeightLbs] = useState("0");
  const [editWeightOz, setEditWeightOz] = useState("14");
  const [editLen, setEditLen] = useState("10");
  const [editWid, setEditWid] = useState("8");
  const [editHgt, setEditHgt] = useState("4");
  const [editSpecs, setEditSpecs] = useState<Array<{ name: string; value: string }>>(
    []
  );

  // Publish & Result State
  const [isPublishing, setIsPublishing] = useState(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [copiedFb, setCopiedFb] = useState(false);
  const [publishedResult, setPublishedResult] = useState<{
    sku: string;
    title: string;
    price: number;
    bin: string;
    ebayListingId: string | null;
    ebayUrl: string | null;
    queuedCrossLists: string[];
    facebookCopy: string;
  } | null>(null);
  const [cropModal, setCropModal] = useState<{
    photoId: string;
    previewUrl: string;
    initialCrop: NormalizedCropRect | null;
  } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY_SKU_PREFS,
        JSON.stringify({ source: skuSource, locKind, locCode, itemNum })
      );
    } catch {
      // ignore
    }
  }, [skuSource, locKind, locCode, itemNum]);

  const computedSku = useMemo(
    () =>
      buildSkuString({
        source: skuSource,
        dateStr: skuDate,
        locKind,
        locCode,
        itemNum,
      }),
    [skuSource, skuDate, locKind, locCode, itemNum]
  );

  const finalSku = customSkuOverride !== null ? customSkuOverride : computedSku;
  const finalBin = useMemo(
    () => buildBinLabel(locKind, locCode),
    [locKind, locCode]
  );

  const handleFilesSelected = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    setErrorBanner(null);

    const added: StudioPhoto[] = [];
    for (const file of list) {
      try {
        const normalized = await normalizeUploadedPhoto(file);
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name || "photo.jpg",
          originalDataUrl: normalized,
          processedDataUrl: normalized,
          cutoutDataUrl: null,
          rotation: 0,
          crop: null,
          enhanced: false,
          whiteBg: false,
          hostedUrl: null,
        });
      } catch (err) {
        console.warn("Skipping unreadable image:", err);
      }
    }

    setPhotos((prev) => {
      const combined = [...prev, ...added];
      if (combined.length > MAX_STUDIO_PHOTOS) {
        setErrorBanner(
          `Kept the first ${MAX_STUDIO_PHOTOS} photos (eBay's maximum). Extra photos were skipped.`
        );
      }
      return combined.slice(0, MAX_STUDIO_PHOTOS);
    });
  }, []);

  const updatePhotoTransform = async (
    photoId: string,
    patch: Partial<
      Pick<StudioPhoto, "rotation" | "crop" | "enhanced" | "whiteBg">
    >
  ) => {
    const target = photos.find((p) => p.id === photoId);
    if (!target) return;
    const nextRotation =
      patch.rotation !== undefined ? patch.rotation : target.rotation;
    const nextCrop =
      patch.crop !== undefined
        ? patch.crop
        : patch.rotation !== undefined && patch.rotation !== target.rotation
          ? null
          : target.crop;
    const nextOpts = {
      rotation: nextRotation,
      crop: nextCrop,
      enhanced: patch.enhanced !== undefined ? patch.enhanced : target.enhanced,
      whiteBg: patch.whiteBg !== undefined ? patch.whiteBg : target.whiteBg,
    };
    setErrorBanner(null);
    setProcessingPhotoId(photoId);
    setProcessingPhotoLabel(
      nextOpts.whiteBg && !target.cutoutDataUrl ? "Loading AI cutout…" : null
    );
    try {
      let cutoutDataUrl = target.cutoutDataUrl ?? null;
      if (nextOpts.whiteBg && !cutoutDataUrl) {
        cutoutDataUrl = await generateSubjectCutoutPng(
          target.originalDataUrl,
          (label) => setProcessingPhotoLabel(label)
        );
      }
      const processed = await renderProcessedPhoto(target.originalDataUrl, {
        ...nextOpts,
        cutoutDataUrl,
      });
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? {
                ...p,
                ...nextOpts,
                cutoutDataUrl,
                processedDataUrl: processed,
                hostedUrl: null, // Re-upload since pixels changed
              }
            : p
        )
      );
    } catch (err) {
      console.error("[ListingStudio] Photo edit failed:", err);
      setErrorBanner(
        err instanceof Error
          ? `White BG AI cutout failed: ${err.message}`
          : "White BG AI cutout failed. Please try again."
      );
    } finally {
      setProcessingPhotoId(null);
      setProcessingPhotoLabel(null);
    }
  };

  const openCropForPhoto = async (photo: StudioPhoto) => {
    const previewUrl =
      photo.rotation === 0
        ? photo.originalDataUrl
        : await renderProcessedPhoto(photo.originalDataUrl, {
            rotation: photo.rotation,
            crop: null,
            enhanced: false,
            whiteBg: false,
          });
    setCropModal({
      photoId: photo.id,
      previewUrl,
      initialCrop: photo.crop,
    });
  };

  const movePhoto = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= photos.length || fromIdx === toIdx) return;
    setPhotos((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const removePhoto = (photoId: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== photoId));
  };

  const loadFromDeathPile = (draftId: string) => {
    if (!draftId) {
      setLoadedDraftId(null);
      return;
    }
    const found = draftItems.find((d) => d.id === draftId);
    if (!found) return;
    setLoadedDraftId(found.id);
    setWhatIsIt(found.title || "");
    if (found.sku) setCustomSkuOverride(found.sku);
    if (found.cogs > 0) setCogsInput(String(found.cogs));
    if (found.floor_price > 0) setLowestPrice(String(found.floor_price));
    if (found.source_location) setSkuSource(found.source_location);
    if (found.notes) setNotes(found.notes);
    if (found.item_specifics?.fb_local_only === "true") {
      setSellOn("facebook");
    }
    setPublishedResult(null);
    setDraft(null);
    setErrorBanner(null);
  };

  const applyDraftToForm = (d: ListingStudioDraftResponse) => {
    setDraft(d);
    setEditTitle(d.title);
    setEditBrand(d.brand);
    setEditCategoryId(d.selectedCategoryId);
    setEditCategoryPath(d.selectedCategoryPath);
    setCategoryOptions(d.suggestedCategories || []);
    setCategorySearchQuery(d.categorySearchQuery || d.title || "");
    setCategorySearchNote(
      d.suggestedCategories.length === 0
        ? "No eBay category auto-matched yet — search keywords below or enter a numeric Category ID."
        : null
    );
    setEditCondition(d.conditionChoice);
    setEditCondDesc(d.conditionDescription);
    setEditDescPlain(d.descriptionPlain);
    setEditFbCopy(d.facebookCopy);
    setEditPrice(d.suggestedPrice.toFixed(2));
    setEditFloorPrice(d.floorPrice.toFixed(2));
    setEditQty("1");
    setEditWeightLbs(String(Math.floor(d.weightOz / 16)));
    setEditWeightOz(String(d.weightOz % 16));
    setEditLen(String(d.lengthIn));
    setEditWid(String(d.widthIn));
    setEditHgt(String(d.heightIn));
    setEditSpecs(d.itemSpecifics);
    if (d.isLocalPickupRecommended && sellOn === "ebay") {
      setSellOn("facebook");
    }
  };

  const handleSearchCategories = async (queryOverride?: string) => {
    const q = (queryOverride ?? categorySearchQuery).trim() || editTitle.trim();
    if (!q) {
      setCategorySearchNote(
        "Enter 2–4 keywords (e.g. Men T-Shirt) or type a numeric eBay Category ID."
      );
      return;
    }

    setIsSearchingCategories(true);
    setCategorySearchNote(null);
    try {
      const res = await fetch(
        `/api/ebay/categories?q=${encodeURIComponent(q)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as {
        categories?: SuggestedEbayCategory[];
        configured?: boolean;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Category lookup failed");
      }
      const next = Array.isArray(data.categories) ? data.categories : [];
      if (next.length > 0) {
        setCategoryOptions(next);
        setEditCategoryId(next[0].categoryId);
        setEditCategoryPath(next[0].categoryPath);
        setCategorySearchNote(null);
      } else {
        setCategorySearchNote(
          data.configured === false
            ? "eBay API credentials not configured — enter a numeric Category ID manually."
            : `No eBay categories matched "${q}". Try 2–3 broader words or enter a numeric Category ID.`
        );
      }
    } catch (err) {
      setCategorySearchNote(
        err instanceof Error
          ? err.message
          : "Category lookup failed — enter a numeric Category ID manually."
      );
    } finally {
      setIsSearchingCategories(false);
    }
  };

  const executePublish = async (overrideDraft?: ListingStudioDraftResponse) => {
    const activeTitle = (overrideDraft?.title ?? editTitle).trim();
    const activePrice = Number(overrideDraft?.suggestedPrice ?? editPrice) || 0;
    const activeFloor = Number(overrideDraft?.floorPrice ?? editFloorPrice) || 0;
    const activeCatId = (overrideDraft?.selectedCategoryId ?? editCategoryId)
      .replace(/^#/, "")
      .trim();
    const activeCatPath = (overrideDraft?.selectedCategoryPath ?? editCategoryPath).trim();
    const activeCatQuery = (
      overrideDraft?.categorySearchQuery ??
      categorySearchQuery ??
      draft?.categorySearchQuery ??
      ""
    ).trim();
    const activeCond = overrideDraft?.conditionChoice ?? editCondition;
    const activeCondDesc = overrideDraft?.conditionDescription ?? editCondDesc;
    const activeDescPlain = overrideDraft?.descriptionPlain ?? editDescPlain;
    const activeDescHtml =
      overrideDraft?.descriptionHtml || buildHtmlFromPlain(activeDescPlain);
    const activeFbCopy = overrideDraft?.facebookCopy ?? editFbCopy;
    const activeBrand = overrideDraft?.brand ?? editBrand;
    const activeSpecs = overrideDraft?.itemSpecifics ?? editSpecs;
    const activeWeightOz = overrideDraft
      ? overrideDraft.weightOz
      : Math.max(
          2,
          (Number(editWeightLbs) || 0) * 16 + (Number(editWeightOz) || 0)
        );
    const activeLen = overrideDraft ? overrideDraft.lengthIn : Number(editLen) || 10;
    const activeWid = overrideDraft ? overrideDraft.widthIn : Number(editWid) || 8;
    const activeHgt = overrideDraft ? overrideDraft.heightIn : Number(editHgt) || 4;

    if (!activeTitle) {
      setErrorBanner("Enter a listing title before publishing.");
      return;
    }
    if (photos.length === 0 && (sellOn === "ebay" || sellOn === "both")) {
      setErrorBanner("Add at least 1 photo before publishing to eBay.");
      return;
    }

    setIsPublishing(true);
    setErrorBanner(null);

    try {
      // 1. Upload photos to eBay Commerce Media in 3-at-a-time batches (fast for up to 24 photos, preserves order)
      const updatedPhotos = [...photos];
      const uploadedUrls: string[] = new Array(updatedPhotos.length).fill("");
      let completedCount = 0;

      const uploadOne = async (idx: number) => {
        const p = updatedPhotos[idx];
        if (p.hostedUrl && /^https?:\/\//i.test(p.hostedUrl)) {
          uploadedUrls[idx] = p.hostedUrl;
          completedCount += 1;
          return;
        }
        const upRes = await fetch("/api/ebay/upload-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: p.processedDataUrl,
            fileName: p.name,
          }),
        });
        const upData = (await upRes.json()) as { url?: string; error?: string };
        if (!upRes.ok || !upData.url) {
          throw new Error(
            upData.error || `Failed uploading photo #${idx + 1} to eBay`
          );
        }
        uploadedUrls[idx] = upData.url;
        updatedPhotos[idx] = { ...p, hostedUrl: upData.url };
        completedCount += 1;
        setStatusBanner(
          `Uploading photos to eBay (${completedCount}/${updatedPhotos.length})…`
        );
      };

      const pendingCount = updatedPhotos.filter(
        (p) => !(p.hostedUrl && /^https?:\/\//i.test(p.hostedUrl))
      ).length;
      if (pendingCount > 0) {
        setStatusBanner(
          `Uploading ${pendingCount} photo${pendingCount === 1 ? "" : "s"} to eBay…`
        );
      }

      const BATCH_SIZE = 3;
      for (let start = 0; start < updatedPhotos.length; start += BATCH_SIZE) {
        const batchIndices: number[] = [];
        for (
          let idx = start;
          idx < Math.min(start + BATCH_SIZE, updatedPhotos.length);
          idx++
        ) {
          batchIndices.push(idx);
        }
        await Promise.all(batchIndices.map((idx) => uploadOne(idx)));
      }
      setPhotos(updatedPhotos);

      // 2. Publish live to eBay + save into Command Center + optionally queue Mac Mini Auto-Pilot
      const crossListTargets: Array<Exclude<MarketplaceType, "ebay" | "etsy">> =
        [];
      if (sellOn === "ebay" || sellOn === "both") {
        if (crossListPoshmark) crossListTargets.push("poshmark");
        if (crossListMercari) crossListTargets.push("mercari");
      }

      setStatusBanner(
        sellOn === "facebook"
          ? "Saving Facebook Local-Only item to Command Center…"
          : crossListTargets.length > 0 && uploadedUrls.length > 12
            ? "Publishing to eBay & curating best photos for Poshmark/Mercari…"
            : "Publishing live to eBay & syncing Command Center…"
      );

      const pubRes = await fetch("/api/ebay/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftItemId: loadedDraftId,
          sku: finalSku,
          binLocation: finalBin,
          sourceLocation: skuSource.trim() || null,
          cogs: Number(cogsInput) || 0,
          title: activeTitle,
          brand: activeBrand,
          categoryId: activeCatId,
          categoryPath: activeCatPath,
          categorySearchQuery: activeCatQuery || null,
          conditionChoice: activeCond,
          conditionDescription: activeCondDesc,
          descriptionPlain: activeDescPlain,
          descriptionHtml: activeDescHtml,
          facebookCopy: activeFbCopy,
          itemSpecifics: activeSpecs,
          price: activePrice,
          floorPrice: activeFloor,
          quantity: Math.max(1, Number(editQty) || 1),
          weightOz: activeWeightOz,
          lengthIn: activeLen,
          widthIn: activeWid,
          heightIn: activeHgt,
          freeShipping,
          imageUrls: uploadedUrls,
          sellOn,
          crossListTargets,
        }),
      });

      const pubData = (await pubRes.json()) as {
        sku?: string;
        ebayListingId?: string | null;
        ebayUrl?: string | null;
        queuedCrossLists?: string[];
        message?: string;
        error?: string;
      };

      if (!pubRes.ok) {
        throw new Error(pubData.error || "Publishing failed");
      }

      const finalResultSku = pubData.sku || finalSku;
      setPublishedResult({
        sku: finalResultSku,
        title: activeTitle,
        price: activePrice,
        bin: finalBin,
        ebayListingId: pubData.ebayListingId || null,
        ebayUrl: pubData.ebayUrl || null,
        queuedCrossLists: pubData.queuedCrossLists || [],
        facebookCopy: activeFbCopy,
      });

      await onPublished({
        sku: finalResultSku,
        ebayUrl: pubData.ebayUrl,
        message: pubData.message || "Listing published!",
      });
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : "Could not publish listing"
      );
    } finally {
      setIsPublishing(false);
      setStatusBanner(null);
    }
  };

  const handleGenerate = async () => {
    if (photos.length === 0 && !whatIsIt.trim()) {
      setErrorBanner("Drop at least 1 photo or tell us what the item is.");
      return;
    }

    setIsGenerating(true);
    setErrorBanner(null);
    setPublishedResult(null);
    setStatusBanner("Analyzing photos & looking up live eBay category…");

    try {
      const sampledPhotos = selectRepresentativeVisionPhotos(photos, 8);
      const visionImages = await Promise.all(
        sampledPhotos.map(async (p) => ({
          base64: await shrinkForAiVision(p.processedDataUrl),
          mimeType: "image/jpeg",
        }))
      );

      const res = await fetch("/api/ai/listing-studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: visionImages,
          sku: finalSku,
          whatIsIt,
          testedStatus,
          conditionInput,
          included,
          missing,
          flaws,
          measurementsWeight,
          notes,
          lowestPrice: Number(lowestPrice) || null,
          cogs: Number(cogsInput) || null,
        }),
      });

      const data = (await res.json()) as ListingStudioDraftResponse & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "AI listing generation failed");
      }

      applyDraftToForm(data);

      if (instantPublish) {
        await executePublish(data);
      } else {
        setTimeout(() => {
          draftSectionRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }, 120);
      }
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : "Failed to generate listing"
      );
    } finally {
      setIsGenerating(false);
      setStatusBanner(null);
    }
  };

  const resetForNextItem = () => {
    setPhotos([]);
    setLoadedDraftId(null);
    setCustomSkuOverride(null);
    // Auto-increment numeric item # for fast batch listing!
    if (/^\d+$/.test(itemNum.trim())) {
      const len = itemNum.trim().length;
      const next = String(Number(itemNum.trim()) + 1).padStart(len, "0");
      setItemNum(next);
    }
    setCogsInput("");
    setWhatIsIt("");
    setTestedStatus("Doesn't apply");
    setConditionInput("decide");
    setIncluded("");
    setMissing("");
    setFlaws("");
    setMeasurementsWeight("");
    setNotes("");
    setLowestPrice("");
    setFreeShipping(false);
    setDraft(null);
    setEditCategoryId("");
    setEditCategoryPath("");
    setCategoryOptions([]);
    setCategorySearchQuery("");
    setCategorySearchNote(null);
    setPublishedResult(null);
    setErrorBanner(null);
    setStatusBanner(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const estNetProfit = useMemo(() => {
    const p = Number(editPrice) || 0;
    const c = Number(cogsInput) || 0;
    if (p <= 0) return 0;
    const fee = sellOn === "facebook" ? 0 : p * 0.1325 + 0.3;
    const ship = freeShipping && sellOn !== "facebook" ? 6.5 : 0;
    return p - fee - ship - c;
  }, [editPrice, cogsInput, sellOn, freeShipping]);

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Header + Death Pile Loader + Instant Mode Toggle */}
      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-[#0F766E] flex items-center justify-center shrink-0">
            <Wand2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[#14151A]">
                Listing Studio
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0]">
                {isLiveMode ? "LIVE EBAY PUBLISH" : "DEMO MODE"}
              </span>
            </div>
            <p className="text-xs text-[#5C606B] mt-0.5">
              Drop photos &amp; quick notes in → AI builds your SEO title, eBay
              category, specifics &amp; FB copy → publishes live to eBay &amp;
              queues Mac Mini Auto-Pilot.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {draftItems.length > 0 && (
            <select
              aria-label="Load from Death Pile"
              value={loadedDraftId || ""}
              onChange={(e) => loadFromDeathPile(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] text-xs font-medium text-[#14151A] max-w-[230px] cursor-pointer"
            >
              <option value="">
                Pull from Death Pile ({draftItems.length})…
              </option>
              {draftItems.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.sku} · {d.title.slice(0, 32)}
                </option>
              ))}
            </select>
          )}

          <label
            title="Skip review and immediately upload photos & publish live to eBay after AI analyzes"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] text-xs font-medium text-[#14151A] cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={instantPublish}
              onChange={(e) => setInstantPublish(e.target.checked)}
              className="accent-[#0F766E] rounded"
            />
            <Zap className="w-3.5 h-3.5 text-[#D97706]" />
            <span>1-Click Auto-Publish</span>
          </label>
        </div>
      </section>

      {/* Success Banner after Live Publish */}
      {publishedResult && (
        <section className="bg-[#ECFDF5] border-2 border-[#10B981] rounded-xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-6 h-6 text-[#0F766E] shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-[#065F46]">
                  {publishedResult.ebayUrl
                    ? `Published LIVE on eBay! (#${publishedResult.ebayListingId})`
                    : "Saved for Facebook Marketplace Local Pickup!"}
                </h3>
                <p className="text-xs text-[#047857] mt-0.5">
                  <strong className="font-mono">{publishedResult.sku}</strong> ·{" "}
                  {publishedResult.title} ·{" "}
                  <strong className="font-mono">
                    ${publishedResult.price.toFixed(2)}
                  </strong>
                  {publishedResult.queuedCrossLists.length > 0 && (
                    <>
                      {" "}
                      · Queued to Mac Mini Auto-Pilot:{" "}
                      <strong>
                        {publishedResult.queuedCrossLists
                          .map((c) => c.toUpperCase())
                          .join(", ")}
                      </strong>
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {publishedResult.ebayUrl && (
                <a
                  href={publishedResult.ebayUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View on eBay
                </a>
              )}
              <button
                type="button"
                onClick={() =>
                  printThermalSkuLabels([
                    {
                      sku: publishedResult.sku,
                      bin: publishedResult.bin,
                      title: publishedResult.title,
                      price: publishedResult.price,
                      cogs: Number(cogsInput) || 0,
                      acquiredAt: new Date().toISOString(),
                    },
                  ])
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-[#A7F3D0] text-[#065F46] text-xs font-semibold hover:bg-[#D1FAE5] cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" />
                Print 2×1 Label
              </button>
              <button
                type="button"
                onClick={resetForNextItem}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#14151A] text-white text-xs font-semibold hover:bg-[#2A2C34] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                List Next Item
              </button>
            </div>
          </div>
        </section>
      )}

      {errorBanner && (
        <div className="bg-[#FEF2F2] border border-[#FECACA] text-[#B91C1C] rounded-xl px-4 py-3 text-xs flex items-center justify-between gap-2">
          <span>{errorBanner}</span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="p-1 hover:bg-[#FEE2E2] rounded cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* SECTION 1: PHOTOS */}
      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-[#5C606B]">
              1. Photos ({photos.length}/{MAX_STUDIO_PHOTOS})
            </span>
            {photos.length > 12 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]">
                {photos.length > 16
                  ? `eBay gets all ${photos.length} · AI picks best 16 for Poshmark & 12 for Mercari`
                  : `eBay & Poshmark get all ${photos.length} · AI picks best 12 for Mercari`}
              </span>
            )}
          </div>
          <span className="text-[11px] text-[#7C858D]">
            Drag to arrange · First photo is the main photo · Auto-resized &amp;
            GPS stripped
          </span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFilesSelected(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFilesSelected(e.target.files);
            e.target.value = "";
          }}
        />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingFiles(true);
          }}
          onDragLeave={() => setIsDraggingFiles(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingFiles(false);
            if (e.dataTransfer.files?.length) {
              handleFilesSelected(e.dataTransfer.files);
            }
          }}
          className={`rounded-xl border-2 border-dashed p-5 text-center transition ${
            isDraggingFiles
              ? "border-[#0F766E] bg-[#ECFDF5]"
              : "border-[#D6DCD9] bg-[#FAFBF9] hover:border-[#0F766E]/60"
          }`}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] transition cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Choose Photos
            </button>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white border border-[#DDE2DF] text-[#14151A] text-xs font-semibold hover:border-[#0F766E] hover:text-[#0F766E] transition cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5" />
              Take Photo
            </button>
          </div>
          <p className="text-[11px] text-[#6B7280] mt-2">
            or drag &amp; drop up to {MAX_STUDIO_PHOTOS} photos (eBay max). Click{" "}
            <strong>Enhance</strong> or AI <strong>White</strong> on any photo
            for a clean studio cutout.
          </p>
        </div>

        {photos.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 pt-1">
            {photos.map((p, idx) => {
              const busy = processingPhotoId === p.id;
              return (
                <div
                  key={p.id}
                  draggable
                  onDragStart={() => setDragPhotoIdx(idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragPhotoIdx !== null) {
                      movePhoto(dragPhotoIdx, idx);
                    }
                    setDragPhotoIdx(null);
                  }}
                  className={`rounded-xl border overflow-hidden bg-white transition ${
                    idx === 0
                      ? "border-[#0F766E] ring-2 ring-[#0F766E]/15"
                      : "border-[#E4E4DD]"
                  }`}
                >
                  <div className="relative aspect-square bg-[#F7F9F8] flex items-center justify-center overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.processedDataUrl}
                      alt={p.name}
                      className="w-full h-full object-contain"
                    />
                    {busy && (
                      <div className="absolute inset-0 bg-white/85 flex flex-col items-center justify-center gap-1.5 px-2 text-center">
                        <Loader2 className="w-5 h-5 animate-spin text-[#0F766E]" />
                        {processingPhotoLabel && (
                          <span className="text-[10px] font-semibold text-[#0F766E]">
                            {processingPhotoLabel}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                          idx === 0
                            ? "bg-[#0F766E] text-white"
                            : "bg-black/65 text-white"
                        }`}
                      >
                        {idx === 0 ? "MAIN" : `#${idx + 1}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removePhoto(p.id)}
                      title="Remove photo"
                      className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/65 text-white flex items-center justify-center hover:bg-[#B91C1C] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Per-photo controls */}
                  <div className="p-1.5 bg-[#FAFBF9] border-t border-[#ECECE6] space-y-1">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          updatePhotoTransform(p.id, {
                            rotation: (p.rotation + 90) % 360,
                          })
                        }
                        title="Rotate 90°"
                        className="p-1 rounded border border-[#DDE2DF] bg-white text-[#444B52] hover:border-[#0F766E] hover:text-[#0F766E] cursor-pointer"
                      >
                        <RotateCw className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => openCropForPhoto(p)}
                        title={p.crop ? "Edit or reset crop" : "Crop photo"}
                        className={`inline-flex items-center justify-center gap-0.5 px-1.5 py-1 rounded text-[10px] font-semibold border transition cursor-pointer ${
                          p.crop
                            ? "bg-[#ECFDF5] border-[#0F766E] text-[#0F766E]"
                            : "bg-white border-[#DDE2DF] text-[#444B52] hover:border-[#0F766E]"
                        }`}
                      >
                        <Crop className="w-2.5 h-2.5" />
                        Crop
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          updatePhotoTransform(p.id, { enhanced: !p.enhanced })
                        }
                        className={`flex-1 inline-flex items-center justify-center gap-0.5 px-1 py-1 rounded text-[10px] font-semibold border transition cursor-pointer ${
                          p.enhanced
                            ? "bg-[#ECFDF5] border-[#0F766E] text-[#0F766E]"
                            : "bg-white border-[#DDE2DF] text-[#444B52] hover:border-[#0F766E]"
                        }`}
                      >
                        <Sparkles className="w-2.5 h-2.5" />
                        Enhance
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          updatePhotoTransform(p.id, { whiteBg: !p.whiteBg })
                        }
                        className={`flex-1 inline-flex items-center justify-center gap-0.5 px-1 py-1 rounded text-[10px] font-semibold border transition cursor-pointer ${
                          p.whiteBg
                            ? "bg-[#EFF6FF] border-[#1D4ED8] text-[#1D4ED8]"
                            : "bg-white border-[#DDE2DF] text-[#444B52] hover:border-[#1D4ED8]"
                        }`}
                      >
                        <Square className="w-2.5 h-2.5" />
                        White
                      </button>
                    </div>
                    {photos.length > 1 && (
                      <div className="flex items-center justify-between gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => movePhoto(idx, idx - 1)}
                          className="p-0.5 rounded text-[#5C606B] hover:text-[#14151A] disabled:opacity-30 cursor-pointer"
                          title="Move left"
                        >
                          <ArrowLeft className="w-3 h-3" />
                        </button>
                        {idx > 0 ? (
                          <button
                            type="button"
                            onClick={() => movePhoto(idx, 0)}
                            className="text-[10px] font-medium text-[#0F766E] hover:underline cursor-pointer"
                          >
                            Make Main
                          </button>
                        ) : (
                          <span className="text-[10px] text-[#7C858D]">
                            Cover Photo
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={idx === photos.length - 1}
                          onClick={() => movePhoto(idx, idx + 1)}
                          className="p-0.5 rounded text-[#5C606B] hover:text-[#14151A] disabled:opacity-30 cursor-pointer"
                          title="Move right"
                        >
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* SECTION 2: BASICS (Custom SKU Builder + COGS + Sell On) */}
      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.07em] text-[#5C606B]">
          2. Basics &amp; Custom SKU
        </div>

        <div className="space-y-2">
          <label className="block text-[11px] font-semibold text-[#444B52]">
            CUSTOM LABEL (SKU) *
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-12 gap-2">
            <input
              type="text"
              value={skuSource}
              onChange={(e) => {
                setSkuSource(e.target.value);
                setCustomSkuOverride(null);
              }}
              placeholder="Source (e.g. SA730)"
              className="sm:col-span-3 px-3 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
            <input
              type="text"
              value={skuDate}
              onChange={(e) => {
                setSkuDate(e.target.value);
                setCustomSkuOverride(null);
              }}
              placeholder="Date (e.g. 11/22/26)"
              className="sm:col-span-2 px-3 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
            <select
              aria-label="Location type"
              value={locKind}
              onChange={(e) => {
                const next = e.target.value as LocationKind;
                setLocKind(next);
                if (next === "Garage" && !/^G?[1-9]$/.test(locCode)) {
                  setLocCode("G1");
                } else if (next === "Shelf" && /^G\d/.test(locCode)) {
                  setLocCode("A");
                }
                setCustomSkuOverride(null);
              }}
              className="sm:col-span-2 px-2.5 py-2 text-xs font-semibold rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none cursor-pointer"
            >
              <option value="Shelf">Shelf</option>
              <option value="Garage">Garage (G1–G5)</option>
              <option value="Closet">Closet</option>
              <option value="Rack">Rack</option>
              <option value="Clothes">Clothes</option>
            </select>
            {(locKind === "Shelf" || locKind === "Garage") && (
              <input
                type="text"
                value={locCode}
                onChange={(e) => {
                  setLocCode(e.target.value);
                  setCustomSkuOverride(null);
                }}
                placeholder={locKind === "Garage" ? "G4" : "N"}
                className="sm:col-span-2 px-3 py-2 text-xs font-mono uppercase rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
              />
            )}
            <div
              className={`${
                locKind === "Shelf" || locKind === "Garage"
                  ? "sm:col-span-3"
                  : "sm:col-span-5"
              } flex items-center gap-1`}
            >
              <input
                type="text"
                value={itemNum}
                onChange={(e) => {
                  setItemNum(e.target.value);
                  setCustomSkuOverride(null);
                }}
                placeholder="Item # (e.g. 2044)"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
              />
              <button
                type="button"
                title="Increment item number +1"
                onClick={() => {
                  const n = /^\d+$/.test(itemNum.trim())
                    ? String(Number(itemNum.trim()) + 1).padStart(
                        itemNum.trim().length,
                        "0"
                      )
                    : "1001";
                  setItemNum(n);
                  setCustomSkuOverride(null);
                }}
                className="px-2 py-2 rounded-lg border border-[#DDE2DF] bg-white text-[11px] font-mono font-bold text-[#0F766E] hover:border-[#0F766E] shrink-0 cursor-pointer"
              >
                +1
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-[#6B7280]">Final SKU:</span>
            <input
              type="text"
              value={finalSku}
              onChange={(e) => setCustomSkuOverride(e.target.value)}
              className="flex-1 min-w-[200px] px-2.5 py-1 text-xs font-mono font-semibold text-[#14151A] bg-[#F4F6F5] border border-transparent focus:border-[#0F766E] focus:bg-white rounded-md focus:outline-none"
            />
            <span className="px-2 py-0.5 rounded bg-[#ECFDF5] text-[#0F766E] text-[10px] font-mono font-bold">
              Bin: {finalBin}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-5">
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              WHAT IS IT? (IF YOU KNOW)
            </label>
            <input
              type="text"
              value={whatIsIt}
              onChange={(e) => setWhatIsIt(e.target.value)}
              placeholder="e.g. Bebe mini backpack, Sony Walkman, Alo shirt…"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              COGS / PAID ($)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={cogsInput}
              onChange={(e) => setCogsInput(e.target.value)}
              placeholder="e.g. 5.00"
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>

          <div className="md:col-span-5">
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              SELL ON
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { k: "ebay", l: "eBay" },
                  { k: "facebook", l: "Facebook Only" },
                  { k: "both", l: "Both (eBay + FB)" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.k}
                  type="button"
                  onClick={() => setSellOn(opt.k)}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                    sellOn === opt.k
                      ? opt.k === "facebook"
                        ? "bg-[#EFF6FF] border-[#1877F2] text-[#1877F2]"
                        : "bg-[#ECFDF5] border-[#0F766E] text-[#0F766E]"
                      : "bg-white border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E]"
                  }`}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {(sellOn === "ebay" || sellOn === "both") && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-[#F1F1EC]">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="text-[11px] font-semibold text-[#5C606B]">
                Also auto-queue to Mac Mini Auto-Pilot:
              </span>
              <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium text-[#14151A]">
                <input
                  type="checkbox"
                  checked={crossListPoshmark}
                  onChange={(e) => setCrossListPoshmark(e.target.checked)}
                  className="accent-[#0F766E]"
                />
                Poshmark
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium text-[#14151A]">
                <input
                  type="checkbox"
                  checked={crossListMercari}
                  onChange={(e) => setCrossListMercari(e.target.checked)}
                  className="accent-[#0F766E]"
                />
                Mercari
              </label>
            </div>

            <label className="inline-flex items-center gap-1.5 text-xs text-[#444B52] cursor-pointer">
              <input
                type="checkbox"
                checked={freeShipping}
                onChange={(e) => setFreeShipping(e.target.checked)}
                className="accent-[#0F766E]"
              />
              <span>
                Offer Free Shipping{" "}
                <span className="text-[#7C858D]">
                  (default: Buyer Pays Calculated — Ground Advantage / UPS)
                </span>
              </span>
            </label>
          </div>
        )}
      </section>

      {/* SECTION 3: WHAT YOU KNOW */}
      <section className="bg-white border border-[#E4E4DD] rounded-xl p-4 sm:p-5 space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.07em] text-[#5C606B]">
          3. What You Know
        </div>

        {/* Tested? Pills */}
        <div>
          <label className="block text-[11px] font-semibold text-[#444B52] mb-1.5">
            TESTED?
          </label>
          <div className="flex flex-wrap gap-1.5">
            {TESTED_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setTestedStatus(opt)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                  testedStatus === opt
                    ? "bg-[#ECFDF5] border-[#0F766E] text-[#0F766E]"
                    : "bg-white border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E]"
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* Condition Pills */}
        <div>
          <label className="block text-[11px] font-semibold text-[#444B52] mb-1.5">
            CONDITION
          </label>
          <div className="flex flex-wrap gap-1.5">
            {CONDITION_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setConditionInput(opt.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                  conditionInput === opt.key
                    ? "bg-[#ECFDF5] border-[#0F766E] text-[#0F766E]"
                    : "bg-white border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 2-Column Text Areas matching user's muscle memory */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              INCLUDED
            </label>
            <textarea
              rows={2}
              value={included}
              onChange={(e) => setIncluded(e.target.value)}
              placeholder="Box, manual, charger, straps…"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              MISSING / NOT INCLUDED
            </label>
            <textarea
              rows={2}
              value={missing}
              onChange={(e) => setMissing(e.target.value)}
              placeholder="Shoulder straps, remote, batteries…"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              FLAWS YOU NOTICED
            </label>
            <textarea
              rows={2}
              value={flaws}
              onChange={(e) => setFlaws(e.target.value)}
              placeholder="Scuff on left side, small tear in box corner…"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              MEASUREMENTS / WEIGHT
            </label>
            <textarea
              rows={2}
              value={measurementsWeight}
              onChange={(e) => setMeasurementsWeight(e.target.value)}
              placeholder="Use your units, e.g. 9 x 9 in, 624 g on the scale"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              NOTES
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else: size tag, model number, era…"
              className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
              LOWEST PRICE YOU&apos;D TAKE ($)
            </label>
            <input
              type="number"
              step="0.5"
              min="0"
              value={lowestPrice}
              onChange={(e) => setLowestPrice(e.target.value)}
              placeholder="optional, e.g. 30 (sets Best Offer min & COGS floor)"
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
            />
          </div>
        </div>

        {/* Generate CTA Footer */}
        <div className="pt-2 border-t border-[#F1F1EC] flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-[#5C606B]">
            {statusBanner ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#0F766E]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {statusBanner}
              </span>
            ) : (
              <span>
                {photos.length} photo{photos.length === 1 ? "" : "s"} ready ·{" "}
                {freeShipping
                  ? "Free Shipping (Seller Pays)"
                  : "Buyer Pays Calculated Shipping"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isGenerating || isPublishing}
              onClick={resetForNextItem}
              className="px-3.5 py-2 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#5C606B] hover:text-[#14151A] cursor-pointer disabled:opacity-50"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={isGenerating || isPublishing}
              onClick={handleGenerate}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#0F766E] text-white text-xs font-bold hover:bg-[#0B5B55] disabled:opacity-50 shadow-xs transition cursor-pointer"
            >
              {isGenerating || isPublishing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : instantPublish ? (
                <Rocket className="w-4 h-4" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              <span>
                {isGenerating
                  ? "Building AI Listing…"
                  : isPublishing
                    ? "Publishing…"
                    : instantPublish
                      ? "Generate & Publish Live"
                      : "Create AI Listing"}
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* SECTION 4: AI DRAFT REVIEW & LIVE PUBLISH */}
      {draft && (
        <section
          ref={draftSectionRef}
          className="bg-white border-2 border-[#0F766E]/35 rounded-xl p-4 sm:p-5 space-y-4 shadow-[0_2px_10px_rgba(15,118,110,0.06)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#ECECE6]">
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-md bg-[#ECFDF5] text-[#0F766E] text-[10px] font-bold uppercase">
                  AI Draft Ready · {draft.modelUsed}
                </span>
                {draft.isLocalPickupRecommended && (
                  <span className="px-2 py-0.5 rounded-md bg-[#EFF6FF] text-[#1877F2] text-[10px] font-bold">
                    Oversized / Local Pickup Recommended
                  </span>
                )}
              </div>
              <h3 className="text-sm font-bold text-[#14151A] mt-1">
                Review &amp; Publish Live
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <a
                href={draft.ebaySoldUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#DDE2DF] bg-[#FAFBF9] text-[11px] font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E]"
              >
                eBay Sold Comps
                <ExternalLink className="w-3 h-3" />
              </a>
              <a
                href={draft.facebookSoldUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[#BFDBFE] bg-[#EFF6FF] text-[11px] font-semibold text-[#1877F2] hover:bg-[#DBEAFE]"
              >
                FB Sold Comps
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>

          {/* Title + Char Count */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-[#444B52]">
                EBAY TITLE
              </label>
              <span
                className={`text-[11px] font-mono font-semibold ${
                  editTitle.length > 80 ? "text-[#B91C1C]" : "text-[#0F766E]"
                }`}
              >
                {editTitle.length} / 80 chars
              </span>
            </div>
            <input
              type="text"
              maxLength={80}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm font-semibold text-[#14151A] rounded-lg border border-[#DDE2DF] focus:border-[#0F766E] focus:outline-none"
            />
          </div>

          {/* Category + Condition + Brand Row */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
            <div className="md:col-span-6 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="block text-[11px] font-semibold text-[#444B52]">
                  EBAY LEAF CATEGORY
                </label>
                {editCategoryId && /^\d+$/.test(editCategoryId.replace(/^#/, "").trim()) ? (
                  <span className="px-1.5 py-0.5 rounded bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0] text-[10px] font-mono font-semibold">
                    #{editCategoryId.replace(/^#/, "").trim()}
                  </span>
                ) : sellOn !== "facebook" ? (
                  <span className="px-1.5 py-0.5 rounded bg-[#FFFBEB] text-[#B45309] border border-[#FDE68A] text-[10px] font-semibold">
                    Pick or enter ID
                  </span>
                ) : null}
              </div>

              {categoryOptions.length > 0 && (
                <select
                  aria-label="Suggested eBay leaf categories"
                  value={editCategoryId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setEditCategoryId(id);
                    const hit = categoryOptions.find(
                      (c) => c.categoryId === id
                    );
                    setEditCategoryPath(hit ? hit.categoryPath : "");
                    setCategorySearchNote(null);
                  }}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none cursor-pointer"
                >
                  {!editCategoryId && (
                    <option value="">Select a suggested eBay category…</option>
                  )}
                  {editCategoryId &&
                    !categoryOptions.some(
                      (c) => c.categoryId === editCategoryId
                    ) && (
                      <option value={editCategoryId}>
                        Custom eBay Category (#{editCategoryId.replace(/^#/, "")})
                      </option>
                    )}
                  {categoryOptions.map((c) => (
                    <option key={c.categoryId} value={c.categoryId}>
                      {c.categoryPath} (#{c.categoryId}
                      {c.percentItemFound > 0 ? ` · ${c.percentItemFound}%` : ""})
                    </option>
                  ))}
                </select>
              )}

              <div className="flex items-center gap-1.5">
                <div className="flex-1 flex items-center gap-1">
                  <input
                    type="text"
                    value={categorySearchQuery}
                    onChange={(e) => setCategorySearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSearchCategories();
                      }
                    }}
                    placeholder="Search eBay categories (e.g. Men T-Shirt)…"
                    aria-label="Search eBay categories"
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={isSearchingCategories}
                    onClick={() => handleSearchCategories()}
                    title="Search eBay leaf categories"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#DDE2DF] bg-white text-[11px] font-semibold text-[#14151A] hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 shrink-0 cursor-pointer"
                  >
                    {isSearchingCategories ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0F766E]" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>Find</span>
                  </button>
                </div>

                <input
                  type="text"
                  inputMode="numeric"
                  value={editCategoryId}
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^0-9]/g, "");
                    setEditCategoryId(cleaned);
                    const hit = categoryOptions.find(
                      (c) => c.categoryId === cleaned
                    );
                    setEditCategoryPath(hit ? hit.categoryPath : "");
                    if (cleaned) setCategorySearchNote(null);
                  }}
                  placeholder="ID #"
                  aria-label="eBay Category ID"
                  title="Enter or paste a numeric eBay Category ID directly"
                  className="w-[96px] px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white focus:border-[#0F766E] focus:outline-none shrink-0"
                />
              </div>

              {categorySearchNote ? (
                <p className="text-[11px] text-[#B45309] leading-snug">
                  {categorySearchNote}
                </p>
              ) : editCategoryId &&
                !categoryOptions.some((c) => c.categoryId === editCategoryId) ? (
                <p className="text-[11px] text-[#5C606B] leading-snug">
                  Using manual eBay Category ID{" "}
                  <span className="font-mono font-semibold">
                    #{editCategoryId}
                  </span>
                </p>
              ) : null}
            </div>

            <div className="md:col-span-3">
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                CONDITION
              </label>
              <select
                value={editCondition}
                onChange={(e) =>
                  setEditCondition(e.target.value as StudioConditionChoice)
                }
                className="w-full px-3 py-2 text-xs font-semibold rounded-lg border border-[#DDE2DF] bg-white cursor-pointer"
              >
                <option value="new_sealed">New, sealed</option>
                <option value="new_opened">New, open box</option>
                <option value="pre_owned">Pre-owned</option>
                <option value="for_parts">For parts / not working</option>
              </select>
            </div>

            <div className="md:col-span-3">
              <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                BRAND
              </label>
              <input
                type="text"
                value={editBrand}
                onChange={(e) => setEditBrand(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF]"
              />
            </div>
          </div>

          {/* Pricing + Profit + Package Weight/Dims */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 p-3 rounded-xl bg-[#FAFBF9] border border-[#ECECE6]">
            <div>
              <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                LIST PRICE ($)
              </label>
              <input
                type="number"
                step="0.01"
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm font-mono font-bold text-[#0F766E] rounded-lg border border-[#DDE2DF] bg-white"
              />
              <div className="text-[10px] font-mono text-[#7C858D] mt-0.5">
                Comps ${draft.lowCompPrice.toFixed(0)}–$
                {draft.highCompPrice.toFixed(0)}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                FLOOR / MIN ($)
              </label>
              <input
                type="number"
                step="0.01"
                value={editFloorPrice}
                onChange={(e) => setEditFloorPrice(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm font-mono rounded-lg border border-[#DDE2DF] bg-white"
              />
              <div className="text-[10px] font-mono text-[#0F766E] mt-0.5">
                Est Net {estNetProfit >= 0 ? "+" : ""}${estNetProfit.toFixed(2)}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                QTY
              </label>
              <input
                type="number"
                min="1"
                value={editQty}
                onChange={(e) => setEditQty(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm font-mono rounded-lg border border-[#DDE2DF] bg-white"
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                WEIGHT (LB / OZ)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="0"
                  value={editWeightLbs}
                  onChange={(e) => setEditWeightLbs(e.target.value)}
                  className="w-1/2 px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  title="Pounds"
                />
                <input
                  type="number"
                  min="0"
                  max="15"
                  value={editWeightOz}
                  onChange={(e) => setEditWeightOz(e.target.value)}
                  className="w-1/2 px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                  title="Ounces"
                />
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-[10px] font-semibold text-[#5C606B] mb-1">
                BOX DIMS (L × W × H IN)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="1"
                  value={editLen}
                  onChange={(e) => setEditLen(e.target.value)}
                  className="w-1/3 px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                />
                <input
                  type="number"
                  min="1"
                  value={editWid}
                  onChange={(e) => setEditWid(e.target.value)}
                  className="w-1/3 px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                />
                <input
                  type="number"
                  min="1"
                  value={editHgt}
                  onChange={(e) => setEditHgt(e.target.value)}
                  className="w-1/3 px-2 py-1.5 text-xs font-mono rounded-lg border border-[#DDE2DF] bg-white"
                />
              </div>
            </div>
          </div>

          {/* Item Specifics */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold text-[#444B52]">
                EBAY ITEM SPECIFICS ({editSpecs.length})
              </label>
              <button
                type="button"
                onClick={() =>
                  setEditSpecs((prev) => [...prev, { name: "", value: "" }])
                }
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0F766E] hover:underline cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                Add Specific
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {editSpecs.map((spec, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-1 bg-[#FAFBF9] border border-[#E4E4DD] rounded-lg p-1.5"
                >
                  <input
                    type="text"
                    value={spec.name}
                    onChange={(e) =>
                      setEditSpecs((prev) =>
                        prev.map((s, i) =>
                          i === idx ? { ...s, name: e.target.value } : s
                        )
                      )
                    }
                    placeholder="Field"
                    className="w-[42%] px-1.5 py-1 text-[11px] font-semibold text-[#444B52] bg-white border border-[#E4E4DD] rounded"
                  />
                  <input
                    type="text"
                    value={spec.value}
                    onChange={(e) =>
                      setEditSpecs((prev) =>
                        prev.map((s, i) =>
                          i === idx ? { ...s, value: e.target.value } : s
                        )
                      )
                    }
                    placeholder="Value"
                    className="flex-1 px-1.5 py-1 text-[11px] text-[#14151A] bg-white border border-[#E4E4DD] rounded"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setEditSpecs((prev) => prev.filter((_, i) => i !== idx))
                    }
                    className="p-1 text-[#9CA3AF] hover:text-[#B91C1C] cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Condition Notes & Description */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  CONDITION NOTES (SHOWN PROMINENTLY ON EBAY)
                </label>
                <input
                  type="text"
                  value={editCondDesc}
                  onChange={(e) => setEditCondDesc(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[#444B52] mb-1">
                  EBAY DESCRIPTION
                </label>
                <textarea
                  rows={7}
                  value={editDescPlain}
                  onChange={(e) => setEditDescPlain(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-[#DDE2DF] leading-relaxed"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold text-[#1877F2]">
                  FACEBOOK MARKETPLACE COPY
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(editFbCopy);
                    setCopiedFb(true);
                    setTimeout(() => setCopiedFb(false), 1800);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#EFF6FF] text-[#1877F2] text-[11px] font-semibold hover:bg-[#DBEAFE] cursor-pointer"
                >
                  {copiedFb ? (
                    <>
                      <Check className="w-3 h-3" /> Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy FB Post
                    </>
                  )}
                </button>
              </div>
              <textarea
                rows={9}
                value={editFbCopy}
                onChange={(e) => setEditFbCopy(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-[#BFDBFE] bg-[#F8FBFF] leading-relaxed"
              />
            </div>
          </div>

          {/* Publish Action Bar */}
          <div className="pt-3 border-t border-[#ECECE6] flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#5C606B] flex items-center gap-2">
              <ImagePlus className="w-4 h-4 text-[#0F766E]" />
              <span>
                {statusBanner ||
                  `${photos.length} photo${photos.length === 1 ? "" : "s"} · SKU ${finalSku} · ${
                    sellOn === "facebook"
                      ? "Facebook Local Pickup"
                      : freeShipping
                        ? "eBay Free Shipping"
                        : "eBay Buyer Pays Calculated (Ground Advantage / UPS)"
                  }`}
              </span>
            </div>

            <button
              type="button"
              disabled={isPublishing}
              onClick={() => executePublish()}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-[#0F766E] text-white text-sm font-bold hover:bg-[#0B5B55] disabled:opacity-50 shadow-sm transition cursor-pointer"
            >
              {isPublishing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Rocket className="w-4 h-4" />
              )}
              <span>
                {isPublishing
                  ? statusBanner || "Publishing…"
                  : sellOn === "facebook"
                    ? "Save Facebook Local Listing"
                    : "Publish Live to eBay"}
              </span>
            </button>
          </div>
        </section>
      )}
      {cropModal && (
        <PhotoCropModal
          imageSrc={cropModal.previewUrl}
          initialCrop={cropModal.initialCrop}
          onCancel={() => setCropModal(null)}
          onApply={async (nextCrop) => {
            const targetId = cropModal.photoId;
            setCropModal(null);
            await updatePhotoTransform(targetId, { crop: nextCrop });
          }}
        />
      )}
    </div>
  );
}
