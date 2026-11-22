import { NextResponse } from "next/server";
import {
  isEbayConfigured,
  publishEbayFixedPriceListing,
  suggestEbayCategories,
  type StudioConditionChoice,
} from "@/lib/ebay";
import { mapItemForMarketplace } from "@/lib/gemini-mapper";
import {
  MARKETPLACE_LIMITS,
  sanitizeMarketplaceCopy,
} from "@/lib/marketplace-compliance";
import { roundCurrency } from "@/lib/stale-engine";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type {
  InventoryItem,
  MarketplaceAccount,
  MarketplaceType,
} from "@/lib/types";

export const maxDuration = 60;

interface PublishStudioRequest {
  draftItemId?: string | null;
  sku: string;
  binLocation?: string | null;
  sourceLocation?: string | null;
  cogs?: number;
  title: string;
  brand?: string | null;
  categoryId?: string | null;
  categoryPath?: string | null;
  conditionChoice: StudioConditionChoice;
  conditionDescription?: string | null;
  descriptionPlain: string;
  descriptionHtml: string;
  facebookCopy?: string | null;
  itemSpecifics: Array<{ name: string; value: string }>;
  price: number;
  floorPrice?: number | null;
  quantity?: number;
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  freeShipping: boolean;
  imageUrls: string[];
  sellOn: "ebay" | "facebook" | "both";
  crossListTargets?: Array<Exclude<MarketplaceType, "ebay" | "etsy">>;
}

const CONDITION_DISPLAY: Record<StudioConditionChoice, string> = {
  new_sealed: "New",
  new_opened: "Open box",
  pre_owned: "Used",
  for_parts: "For parts or not working",
};

/**
 * POST /api/ebay/publish
 * 1) Publishes live to eBay Production via Trading API `AddFixedPriceItem` (when sellOn includes eBay).
 * 2) Creates (or promotes from Death Pile) the master `inventory_items` + `marketplace_listings` rows in Supabase.
 * 3) Optionally queues Poshmark / Mercari / Facebook jobs straight to Mac Mini Auto-Pilot.
 */
export async function POST(request: Request) {
  let body: PublishStudioRequest;
  try {
    body = (await request.json()) as PublishStudioRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const title = (body.title || "").trim().slice(0, 80);
  const sku = (body.sku || "").trim() || `RCC-${Date.now().toString(36).toUpperCase()}`;
  const price = roundCurrency(Math.max(1, Number(body.price) || 0));
  const floorPrice =
    body.floorPrice && Number(body.floorPrice) > 0
      ? roundCurrency(Number(body.floorPrice))
      : roundCurrency(Math.max(1, price * 0.72));
  const cogs = roundCurrency(Math.max(0, Number(body.cogs) || 0));
  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.filter((u) => typeof u === "string" && u.trim().length > 0)
    : [];

  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }

  const shouldPublishEbay = body.sellOn === "ebay" || body.sellOn === "both";
  const isFbLocalOnly = body.sellOn === "facebook";
  const envReadiness = getEnvReadiness();
  const supabase = getSupabaseServerClient();

  let ebayResult: {
    itemId: string;
    listingUrl: string;
    conditionId: number | null;
    conditionName: string;
  } | null = null;

  // 1. Publish directly to eBay Production if requested & configured
  if (shouldPublishEbay && isEbayConfigured()) {
    let categoryId = (body.categoryId || "").trim();
    if (!categoryId) {
      const suggestions = await suggestEbayCategories(title);
      categoryId = suggestions[0]?.categoryId || "";
    }
    if (!categoryId) {
      return NextResponse.json(
        {
          error:
            "Could not auto-detect an eBay Category ID for this title. Try picking a category from the dropdown or refining the title.",
        },
        { status: 400 }
      );
    }

    if (imageUrls.filter((u) => /^https?:\/\//i.test(u)).length === 0) {
      return NextResponse.json(
        {
          error:
            "At least 1 uploaded photo is required before publishing live to eBay.",
        },
        { status: 400 }
      );
    }

    // Grab 1 active eBay ItemID from Supabase to auto-detect seller's real PostalCode & Business Policies
    let sampleEbayId: string | null = null;
    if (supabase && envReadiness.isSupabaseReady) {
      const { data: sampleRow } = await supabase
        .from("marketplace_listings")
        .select("external_listing_id")
        .eq("marketplace", "ebay")
        .eq("status", "active")
        .not("external_listing_id", "is", null)
        .limit(1)
        .maybeSingle();
      sampleEbayId = (sampleRow?.external_listing_id as string | null) ?? null;
    }

    try {
      ebayResult = await publishEbayFixedPriceListing({
        sku,
        title,
        descriptionHtml: body.descriptionHtml || body.descriptionPlain,
        categoryId,
        conditionChoice: body.conditionChoice || "pre_owned",
        conditionDescription: body.conditionDescription || null,
        price,
        floorPrice,
        quantity: Math.max(1, Math.round(Number(body.quantity) || 1)),
        imageUrls,
        itemSpecifics: Array.isArray(body.itemSpecifics) ? body.itemSpecifics : [],
        weightOz: Math.max(2, Math.round(Number(body.weightOz) || 12)),
        lengthIn: Math.max(4, Math.round(Number(body.lengthIn) || 10)),
        widthIn: Math.max(4, Math.round(Number(body.widthIn) || 8)),
        heightIn: Math.max(1, Math.round(Number(body.heightIn) || 4)),
        freeShipping: Boolean(body.freeShipping),
        sampleExistingEbayItemId: sampleEbayId,
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "eBay AddFixedPriceItem failed";
      console.error("[/api/ebay/publish] eBay error:", err);
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } else if (shouldPublishEbay) {
    // Demo fallback
    const demoId = `39${Date.now().toString().slice(-10)}`;
    ebayResult = {
      itemId: demoId,
      listingUrl: `https://www.ebay.com/itm/${demoId}`,
      conditionId: 3000,
      conditionName: CONDITION_DISPLAY[body.conditionChoice || "pre_owned"],
    };
  }

  // 2. Save / Promote into Supabase inventory_items + marketplace_listings
  const nowIso = new Date().toISOString();
  const specsRecord: Record<string, string | string[]> = {};
  for (const s of body.itemSpecifics || []) {
    if (s.name?.trim() && s.value?.trim()) {
      specsRecord[s.name.trim()] = s.value.trim();
    }
  }
  if (isFbLocalOnly) {
    specsRecord.fb_local_only = "true";
  }

  let savedItem: InventoryItem | null = null;
  const queuedCrossLists: string[] = [];

  if (supabase && envReadiness.isSupabaseReady) {
    const itemPayload = {
      sku,
      title,
      description_html: body.descriptionHtml || null,
      description_plain: body.descriptionPlain || null,
      condition:
        ebayResult?.conditionName ||
        CONDITION_DISPLAY[body.conditionChoice || "pre_owned"],
      brand: body.brand?.trim() || null,
      category_hint: body.categoryPath?.trim() || null,
      cogs,
      prep_cost: 0,
      target_price: price,
      floor_price: floorPrice,
      bin_location: body.binLocation?.trim() || null,
      source_location: body.sourceLocation?.trim() || null,
      weight_oz: Math.max(2, Math.round(Number(body.weightOz) || 12)),
      length_in: Math.max(4, Math.round(Number(body.lengthIn) || 10)),
      width_in: Math.max(4, Math.round(Number(body.widthIn) || 8)),
      height_in: Math.max(1, Math.round(Number(body.heightIn) || 4)),
      item_specifics: specsRecord,
      image_urls: imageUrls,
      status: "active",
      acquired_at: nowIso,
      updated_at: nowIso,
    };

    if (body.draftItemId) {
      const { data: updated, error: updErr } = await supabase
        .from("inventory_items")
        .update(itemPayload)
        .eq("id", body.draftItemId)
        .select("*")
        .single();
      if (!updErr && updated) {
        savedItem = updated as InventoryItem;
      }
    }

    if (!savedItem) {
      const { data: created, error: createErr } = await supabase
        .from("inventory_items")
        .insert(itemPayload)
        .select("*")
        .single();
      if (createErr || !created) {
        // Handle duplicate SKU by appending short suffix so eBay-published item is still tracked
        const uniqueSku = `${sku}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
        const { data: retryCreated } = await supabase
          .from("inventory_items")
          .insert({ ...itemPayload, sku: uniqueSku })
          .select("*")
          .single();
        savedItem = (retryCreated as InventoryItem | null) ?? null;
      } else {
        savedItem = created as InventoryItem;
      }
    }

    if (savedItem) {
      if (ebayResult) {
        await supabase.from("marketplace_listings").upsert(
          {
            item_id: savedItem.id,
            marketplace: "ebay",
            external_listing_id: ebayResult.itemId,
            external_url: ebayResult.listingUrl,
            listed_price: price,
            shipping_price: 0,
            status: "active",
            views_count: 0,
            watchers_count: 0,
            impressions_count: 0,
            listed_at: nowIso,
            last_synced_at: nowIso,
          },
          { onConflict: "item_id,marketplace" }
        );
      } else if (isFbLocalOnly) {
        await supabase.from("marketplace_listings").upsert(
          {
            item_id: savedItem.id,
            marketplace: "facebook",
            listed_price: price,
            shipping_price: 0,
            status: "active",
            views_count: 0,
            watchers_count: 0,
            impressions_count: 0,
            listed_at: nowIso,
            last_synced_at: nowIso,
          },
          { onConflict: "item_id,marketplace" }
        );
      }

      // 3. Optionally auto-queue Poshmark / Mercari / Facebook straight to Mac Mini Auto-Pilot!
      const targets = new Set<Exclude<MarketplaceType, "ebay" | "etsy">>(
        body.crossListTargets || []
      );
      if (body.sellOn === "both") {
        targets.add("facebook");
      }

      if (targets.size > 0) {
        const { data: accts } = await supabase
          .from("marketplace_accounts")
          .select("*");
        const accounts = (accts ?? []) as MarketplaceAccount[];

        for (const target of targets) {
          try {
            const targetAcct = accounts.find((a) => a.marketplace === target);
            const draft = await mapItemForMarketplace({
              item: savedItem,
              ebayListedPrice: price,
              targetMarketplace: target,
              targetAccount: targetAcct,
            });
            const limits = MARKETPLACE_LIMITS[target];
            const rawTargetPrice = Math.max(
              floorPrice,
              draft.pricing.suggestedPrice
            );
            const targetPrice = limits.wholeDollarOnly
              ? Math.max(limits.minPrice, Math.ceil(rawTargetPrice))
              : roundCurrency(rawTargetPrice);

            const sanitized = sanitizeMarketplaceCopy({
              title: draft.mappedTitle,
              description:
                target === "facebook" && body.facebookCopy?.trim()
                  ? body.facebookCopy.trim()
                  : draft.descriptionPlain,
              targetMarketplace: target,
            });

            const { error: jobErr } = await supabase.from("channel_jobs").insert({
              item_id: savedItem.id,
              marketplace: target,
              action: "create",
              execution_mode: "extension",
              payload: {
                sku: savedItem.sku,
                mappedTitle: sanitized.title,
                descriptionPlain: sanitized.description,
                brand: savedItem.brand,
                condition:
                  draft.structuredCategory?.conditionLabel ||
                  savedItem.condition,
                categoryPath: draft.categoryPath,
                structuredCategory: draft.structuredCategory,
                targetPrice: Math.ceil(price),
                suggestedPrice: targetPrice,
                weightOz: savedItem.weight_oz ?? null,
                imageUrls: (savedItem.image_urls || []).slice(
                  0,
                  limits.maxPhotos
                ),
                requiresUserConfirm: target === "facebook",
              },
              status: "pending",
              attempts: 0,
            });
            if (!jobErr) {
              queuedCrossLists.push(target);
            }
          } catch (crossErr) {
            console.warn(
              `[/api/ebay/publish] Cross-list queue warning (${target}):`,
              crossErr
            );
          }
        }
      }
    }
  }

  return NextResponse.json({
    mode: isEbayConfigured() ? "live" : "demo",
    itemId: savedItem?.id || null,
    sku: savedItem?.sku || sku,
    ebayListingId: ebayResult?.itemId || null,
    ebayUrl: ebayResult?.listingUrl || null,
    queuedCrossLists,
    message: ebayResult
      ? `Published LIVE to eBay (#${ebayResult.itemId})!${queuedCrossLists.length > 0 ? ` Queued ${queuedCrossLists.map((c) => c.toUpperCase()).join(", ")} for Mac Mini Auto-Pilot.` : ""}`
      : `Saved ${sku} for Facebook Marketplace Local Pickup!`,
  });
}
