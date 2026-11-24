import { generateGeminiJson, getGeminiApiKey } from "./gemini-client";
import type { MarketplaceType } from "./types";

export interface SelectBestPhotosParams {
  imageUrls: string[];
  maxPhotos: number;
  title?: string | null;
  channel?: MarketplaceType;
  cachedRankOrder?: number[] | null;
}

export interface SelectBestPhotosResult {
  selectedUrls: string[];
  /** 0-based indices of `imageUrls` ordered from most valuable (#1) to least valuable (#N). */
  rankOrder: number[];
  /** True when `imageUrls.length > maxPhotos` and photos were reduced. */
  curated: boolean;
  /** True when Gemini Vision actively ranked the photos during this call. */
  usedAi: boolean;
}

/**
 * Reads a previously cached `photo_rank_order` from `inventory_items.item_specifics`
 * and validates that it matches the current photo count exactly.
 */
export function parseCachedPhotoRankOrder(
  specifics: Record<string, unknown> | null | undefined,
  totalPhotos: number
): number[] | null {
  if (!specifics || totalPhotos <= 1) return null;
  const raw = specifics.photo_rank_order;
  let nums: number[] = [];

  if (typeof raw === "string") {
    nums = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));
  } else if (Array.isArray(raw)) {
    nums = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n));
  }

  if (nums.length !== totalPhotos) return null;
  const seen = new Set<number>();
  for (const n of nums) {
    if (n < 0 || n >= totalPhotos || seen.has(n)) return null;
    seen.add(n);
  }
  return nums;
}

export function serializePhotoRankOrder(rankOrder: number[]): string {
  return rankOrder.join(",");
}

/**
 * Deterministic reseller-aware fallback ranking when AI is unavailable or times out.
 * Always keeps:
 *  - #0 (Main cover photo)
 *  - #1 (Primary hero alternate)
 *  - Last 2 photos (resellers typically shoot sewn/care/size tags, model plates, bottoms, and flaws last)
 *  - Evenly distributed indices across the middle angles (avoiding clumping at the start).
 */
export function buildFallbackRankOrder(total: number): number[] {
  if (total <= 0) return [];
  if (total === 1) return [0];

  const order: number[] = [];
  const added = new Set<number>();
  const push = (idx: number) => {
    if (idx >= 0 && idx < total && !added.has(idx)) {
      added.add(idx);
      order.push(idx);
    }
  };

  // 1. Cover photo is ALWAYS #1
  push(0);
  // 2. Second hero shot
  push(1);
  // 3. End shots (tags, labels, serial numbers, battery compartments, flaws)
  push(total - 1);
  push(total - 2);
  if (total >= 10) {
    push(total - 3);
  }

  // 4. Bisect the remaining middle range so angles are spread evenly across the gallery
  const middleStart = 2;
  const middleEnd = total - 1;
  const remaining: number[] = [];
  for (let i = middleStart; i <= middleEnd; i++) {
    if (!added.has(i)) remaining.push(i);
  }

  if (remaining.length > 0) {
    // Recursive midpoint ordering gives even coverage for ANY cutoff maxPhotos
    const queue: Array<[number, number]> = [[0, remaining.length - 1]];
    while (queue.length > 0) {
      const [lo, hi] = queue.shift()!;
      if (lo > hi) continue;
      const mid = Math.floor((lo + hi) / 2);
      push(remaining[mid]);
      if (lo <= mid - 1) queue.push([lo, mid - 1]);
      if (mid + 1 <= hi) queue.push([mid + 1, hi]);
    }
  }

  return order;
}

function sanitizeRankOrder(rawIndices: unknown, total: number): number[] {
  const fallback = buildFallbackRankOrder(total);
  if (!Array.isArray(rawIndices)) return fallback;

  const result: number[] = [0];
  const seen = new Set<number>([0]);

  for (const val of rawIndices) {
    const n = typeof val === "number" ? Math.round(val) : Number(val);
    if (Number.isInteger(n) && n >= 0 && n < total && !seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }

  // Fill in any omitted indices using deterministic reseller priority
  for (const idx of fallback) {
    if (!seen.has(idx)) {
      seen.add(idx);
      result.push(idx);
    }
  }

  return result;
}

/**
 * Fetches a lightweight thumbnail version of a photo URL for fast Gemini Vision ranking.
 * For eBay CDN URLs (`s-l1600.*`), attempts `s-l500.*` first to save bandwidth & latency.
 */
async function fetchImageThumbnailInline(
  url: string
): Promise<{ mime_type: string; data: string } | null> {
  const candidates: string[] = [];
  if (/\/s-l1600\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) {
    candidates.push(url.replace(/\/s-l1600\./i, "/s-l500."));
  }
  candidates.push(url);

  for (const candidateUrl of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(candidateUrl, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) continue;
      const contentType =
        (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      if (!contentType.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > 4_000_000) continue;
      return {
        mime_type: contentType,
        data: buf.toString("base64"),
      };
    } catch {
      // try next candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Selects the best `maxPhotos` images from a listing's full photo gallery when
 * cross-listing to a marketplace with a lower photo limit than eBay (24):
 *  - Poshmark: 16
 *  - Mercari: 12
 *  - Etsy / Facebook: 10
 *
 * Uses Gemini Vision to rank photos by buyer value (keeping cover photo #0,
 * distinct angles, brand/size/care tags, serial plates, flaws, and measurements,
 * while dropping redundant near-duplicate angles).
 *
 * Selected photos are returned in their natural gallery order (cover photo #0 first).
 */
export async function selectBestPhotosForChannel(
  params: SelectBestPhotosParams
): Promise<SelectBestPhotosResult> {
  const urls = (params.imageUrls || [])
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter(Boolean);
  const maxPhotos = Math.max(1, Math.floor(params.maxPhotos || 12));

  if (urls.length <= maxPhotos) {
    return {
      selectedUrls: urls,
      rankOrder: urls.map((_, idx) => idx),
      curated: false,
      usedAi: false,
    };
  }

  // 1. Reuse cached rank order if valid for this exact gallery length
  if (
    Array.isArray(params.cachedRankOrder) &&
    params.cachedRankOrder.length === urls.length
  ) {
    const validRank = sanitizeRankOrder(params.cachedRankOrder, urls.length);
    const chosenIndices = validRank.slice(0, maxPhotos).sort((a, b) => a - b);
    return {
      selectedUrls: chosenIndices.map((i) => urls[i]),
      rankOrder: validRank,
      curated: true,
      usedAi: false,
    };
  }

  // 2. Try Gemini Vision ranking (bounded to 12s so publishing never stalls)
  const apiKey = getGeminiApiKey();
  if (apiKey) {
    try {
      const fetched = await Promise.all(
        urls.map(async (url, idx) => ({
          idx,
          inline: await fetchImageThumbnailInline(url),
        }))
      );
      const validImages = fetched.filter(
        (f): f is { idx: number; inline: { mime_type: string; data: string } } =>
          f.inline !== null
      );

      if (validImages.length >= Math.min(4, urls.length)) {
        const parts: Array<{
          text?: string;
          inline_data?: { mime_type: string; data: string };
        }> = [
          {
            text: `You are curating product photos for a reseller listing${params.title ? ` ("${params.title}")` : ""} that has ${urls.length} photos (indexed 0 to ${urls.length - 1}), so it can be cross-listed to marketplaces with tighter photo limits (e.g. Poshmark 16, Mercari 12, Facebook/Etsy 10).

Rank ALL ${urls.length} photo indices from MOST valuable (#1) to LEAST valuable (#${urls.length}) for a buyer deciding to purchase:
1. Index 0 (Main Cover) MUST ALWAYS be first in rankedIndices.
2. HIGHEST PRIORITY: Clear hero front/angle views, brand/size/care/material tags, model/serial number plates, hallmarks/stamps, battery compartments, original box/packaging, measurements, and any close-ups showing flaws or wear.
3. HIGH PRIORITY: Distinct sides that show new information (back, bottom, top, inside/interior, accessories).
4. LOWEST PRIORITY (put at the END so they get dropped first): Near-duplicate angles of the same side, slightly blurry/out-of-focus duplicates, redundant close-ups that don't add new facts.

Return ONLY valid JSON:
{ "rankedIndices": [0, ...all ${urls.length} unique integers 0..${urls.length - 1}] }`,
          },
        ];

        for (const img of validImages) {
          parts.push({
            text:
              img.idx === 0
                ? "Photo #0 (MAIN COVER):"
                : `Photo #${img.idx}:`,
          });
          parts.push({ inline_data: img.inline });
        }

        const aiPromise = generateGeminiJson<{ rankedIndices?: number[] }>({
          task: "mapper",
          apiKey,
          parts,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Photo ranking timed out")), 12_000)
        );

        const res = await Promise.race([aiPromise, timeoutPromise]);
        if (
          Array.isArray(res.data?.rankedIndices) &&
          res.data.rankedIndices.length >= Math.min(3, urls.length)
        ) {
          const rankOrder = sanitizeRankOrder(
            res.data.rankedIndices,
            urls.length
          );
          const chosenIndices = rankOrder
            .slice(0, maxPhotos)
            .sort((a, b) => a - b);
          return {
            selectedUrls: chosenIndices.map((i) => urls[i]),
            rankOrder,
            curated: true,
            usedAi: true,
          };
        }
      }
    } catch (err) {
      console.warn(
        "[photo-selector] Gemini Vision ranking fallback:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // 3. Smart deterministic fallback (keeps cover + hero + end tag/flaw shots + even middle angles)
  const fallbackRank = buildFallbackRankOrder(urls.length);
  const chosenIndices = fallbackRank.slice(0, maxPhotos).sort((a, b) => a - b);
  return {
    selectedUrls: chosenIndices.map((i) => urls[i]),
    rankOrder: fallbackRank,
    curated: true,
    usedAi: false,
  };
}
