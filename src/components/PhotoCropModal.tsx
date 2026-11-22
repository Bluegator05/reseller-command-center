"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Crop, RotateCcw, X } from "lucide-react";

export interface NormalizedCropRect {
  /** Normalized 0..1 coordinates relative to the rotated image */
  x: number;
  y: number;
  w: number;
  h: number;
}

type AspectPreset = "free" | "1:1" | "4:3" | "3:4";
type DragMode = "move" | "nw" | "ne" | "sw" | "se" | null;

interface PhotoCropModalProps {
  imageSrc: string;
  initialCrop: NormalizedCropRect | null;
  onCancel: () => void;
  onApply: (crop: NormalizedCropRect | null) => void;
}

const MIN_SIZE = 0.08;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function PhotoCropModal({
  imageSrc,
  initialCrop,
  onCancel,
  onApply,
}: PhotoCropModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [imgAspect, setImgAspect] = useState<number>(1);
  const [aspect, setAspect] = useState<AspectPreset>("free");
  const [rect, setRect] = useState<NormalizedCropRect>(
    () => initialCrop ?? { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }
  );

  const dragStateRef = useRef<{
    mode: DragMode;
    startClientX: number;
    startClientY: number;
    startRect: NormalizedCropRect;
    boxW: number;
    boxH: number;
  } | null>(null);

  const aspectValue = (preset: AspectPreset): number | null => {
    if (preset === "1:1") return 1;
    if (preset === "4:3") return 4 / 3;
    if (preset === "3:4") return 3 / 4;
    return null;
  };

  // Snap current crop rect to a chosen aspect ratio centered inside the image
  const applyAspectPreset = (nextPreset: AspectPreset) => {
    setAspect(nextPreset);
    const targetRatio = aspectValue(nextPreset);
    if (!targetRatio) return;

    // In normalized coords: (w * imgW) / (h * imgH) = targetRatio => w / h = targetRatio / imgAspect
    const normRatio = targetRatio / imgAspect;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;

    let w = rect.w;
    let h = w / normRatio;
    if (h > 0.94) {
      h = 0.94;
      w = h * normRatio;
    }
    if (w > 0.94) {
      w = 0.94;
      h = w / normRatio;
    }
    w = clamp(w, MIN_SIZE, 1);
    h = clamp(h, MIN_SIZE, 1);
    const x = clamp(cx - w / 2, 0, 1 - w);
    const y = clamp(cy - h / 2, 0, 1 - h);
    setRect({ x, y, w, h });
  };

  const startDrag = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStateRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRect: { ...rect },
      boxW: box.width,
      boxH: box.height,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragStateRef.current;
    if (!st || !st.mode) return;
    e.preventDefault();

    const dx = (e.clientX - st.startClientX) / st.boxW;
    const dy = (e.clientY - st.startClientY) / st.boxH;
    const s = st.startRect;
    const targetRatio = aspectValue(aspect);
    const normRatio = targetRatio ? targetRatio / imgAspect : null;

    if (st.mode === "move") {
      setRect({
        x: clamp(s.x + dx, 0, 1 - s.w),
        y: clamp(s.y + dy, 0, 1 - s.h),
        w: s.w,
        h: s.h,
      });
      return;
    }

    let left = s.x;
    let right = s.x + s.w;
    let top = s.y;
    let bottom = s.y + s.h;

    if (st.mode.includes("w")) {
      left = clamp(s.x + dx, 0, right - MIN_SIZE);
    }
    if (st.mode.includes("e")) {
      right = clamp(s.x + s.w + dx, left + MIN_SIZE, 1);
    }
    if (st.mode.includes("n")) {
      top = clamp(s.y + dy, 0, bottom - MIN_SIZE);
    }
    if (st.mode.includes("s")) {
      bottom = clamp(s.y + s.h + dy, top + MIN_SIZE, 1);
    }

    let w = right - left;
    let h = bottom - top;

    if (normRatio) {
      // Lock aspect ratio anchored to the opposite corner
      const desiredH = w / normRatio;
      if (st.mode === "se") {
        h = clamp(desiredH, MIN_SIZE, 1 - top);
        w = h * normRatio;
        right = left + w;
        bottom = top + h;
      } else if (st.mode === "sw") {
        h = clamp(desiredH, MIN_SIZE, 1 - top);
        w = h * normRatio;
        left = right - w;
        bottom = top + h;
      } else if (st.mode === "ne") {
        h = clamp(desiredH, MIN_SIZE, bottom);
        w = h * normRatio;
        right = left + w;
        top = bottom - h;
      } else if (st.mode === "nw") {
        h = clamp(desiredH, MIN_SIZE, bottom);
        w = h * normRatio;
        left = right - w;
        top = bottom - h;
      }
      if (left < 0) {
        w += left;
        left = 0;
        h = w / normRatio;
        if (st.mode.includes("n")) top = bottom - h;
        else bottom = top + h;
      }
      if (right > 1) {
        w -= right - 1;
        right = 1;
        h = w / normRatio;
        if (st.mode.includes("n")) top = bottom - h;
        else bottom = top + h;
      }
    }

    setRect({
      x: clamp(left, 0, 1 - MIN_SIZE),
      y: clamp(top, 0, 1 - MIN_SIZE),
      w: clamp(w, MIN_SIZE, 1),
      h: clamp(h, MIN_SIZE, 1),
    });
  };

  const endDrag = () => {
    dragStateRef.current = null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isFullFrame =
    rect.x <= 0.005 && rect.y <= 0.005 && rect.w >= 0.99 && rect.h >= 0.99;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-[2px] p-3 sm:p-5"
      onClick={onCancel}
    >
      <div
        className="bg-white border border-[#DCE2DF] rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#ECEFE9] bg-[#FAFBF9] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Crop className="w-4 h-4 text-[#0F766E]" />
            <h3 className="text-sm font-bold text-[#14151A]">Crop Photo</h3>
          </div>

          <div className="flex items-center gap-1">
            {(
              [
                { k: "free", l: "Free" },
                { k: "1:1", l: "1:1 Square" },
                { k: "4:3", l: "4:3" },
                { k: "3:4", l: "3:4" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.k}
                type="button"
                onClick={() => applyAspectPreset(opt.k)}
                className={`px-2 py-1 rounded-md text-[11px] font-semibold border transition cursor-pointer ${
                  aspect === opt.k
                    ? "bg-[#ECFDF5] border-[#0F766E] text-[#0F766E]"
                    : "bg-white border-[#DDE2DF] text-[#5C606B] hover:border-[#0F766E]"
                }`}
              >
                {opt.l}
              </button>
            ))}
            <button
              type="button"
              onClick={onCancel}
              className="ml-1 p-1 rounded-lg text-[#5C606B] hover:bg-[#EDF1EE] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Interactive Crop Canvas */}
        <div className="p-4 bg-[#171A1D] flex-1 flex items-center justify-center overflow-hidden select-none">
          <div
            ref={containerRef}
            className="relative inline-block max-w-full max-h-[60vh] touch-none"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt="Crop preview"
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                  setImgAspect(el.naturalWidth / el.naturalHeight);
                }
              }}
              className="block max-w-full max-h-[60vh] w-auto h-auto object-contain pointer-events-none select-none"
            />

            {/* Darkened outside masks */}
            <div
              className="absolute left-0 right-0 top-0 bg-black/55 pointer-events-none"
              style={{ height: `${rect.y * 100}%` }}
            />
            <div
              className="absolute left-0 right-0 bottom-0 bg-black/55 pointer-events-none"
              style={{ height: `${(1 - rect.y - rect.h) * 100}%` }}
            />
            <div
              className="absolute left-0 bg-black/55 pointer-events-none"
              style={{
                top: `${rect.y * 100}%`,
                height: `${rect.h * 100}%`,
                width: `${rect.x * 100}%`,
              }}
            />
            <div
              className="absolute right-0 bg-black/55 pointer-events-none"
              style={{
                top: `${rect.y * 100}%`,
                height: `${rect.h * 100}%`,
                width: `${(1 - rect.x - rect.w) * 100}%`,
              }}
            />

            {/* Draggable Crop Box */}
            <div
              onPointerDown={(e) => startDrag("move", e)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
              className="absolute border-2 border-white shadow-[0_0_0_1px_rgba(15,118,110,0.85)] cursor-move"
            >
              {/* Rule of thirds guide lines */}
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/40 pointer-events-none" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/40 pointer-events-none" />
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/40 pointer-events-none" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/40 pointer-events-none" />

              {/* Corner Resize Handles */}
              {(
                [
                  { mode: "nw", cls: "-top-2 -left-2 cursor-nwse-resize" },
                  { mode: "ne", cls: "-top-2 -right-2 cursor-nesw-resize" },
                  { mode: "sw", cls: "-bottom-2 -left-2 cursor-nesw-resize" },
                  { mode: "se", cls: "-bottom-2 -right-2 cursor-nwse-resize" },
                ] as const
              ).map((h) => (
                <div
                  key={h.mode}
                  onPointerDown={(e) => startDrag(h.mode, e)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`absolute w-4 h-4 rounded-full bg-[#0F766E] border-2 border-white shadow-md ${h.cls}`}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[#ECEFE9] bg-[#FAFBF9] flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setAspect("free");
              setRect({ x: 0, y: 0, w: 1, h: 1 });
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#DDE2DF] bg-white text-xs font-semibold text-[#5C606B] hover:text-[#14151A] cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Full Frame
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-[#5C606B] hover:bg-[#EDF1EE] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onApply(isFullFrame ? null : rect)}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#0F766E] text-white text-xs font-bold hover:bg-[#0B5B55] cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Apply Crop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
