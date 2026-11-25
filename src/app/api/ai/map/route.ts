import { NextResponse } from "next/server";
import {
  applyDemoMarketplacePolicyBlock,
  getDemoStore,
} from "@/lib/demo-store";
import { fetchEbayItemDetails } from "@/lib/ebay";
import { mapItemForMarketplace } from "@/lib/gemini-mapper";
import {
  applyPolicyBlockToSpecs,
  extractPrimaryPolicyBlock,
  parsePolicyBlockedMap,
  parsePolicyOverrideList,
} from "@/lib/marketplace-compliance";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  CrossListMarketplace,
  InventoryItem,
  MarketplaceAccount,
  MarketplaceType,
} from "@/lib/types";

/**
 * POST /api/ai/map
 * Generates an AI-translated cross-listing payload (title, stripped plain text description,
 * Etsy taxonomy, SEO tags, and fee-adjusted pricing) for an inventory item.
 * Automatically enriches full high-res photos & description from eBay `GetItem` if only
 * a single thumbnail was synced from `GetMyeBaySelling`.
 */
export async function POST(request: Request) {
  let body: { itemId?: string; targetMarketplace?: MarketplaceType };
  try {
    body = (await request.json()) as {
      itemId?: string;
      targetMarketplace?: MarketplaceType;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const { itemId, targetMarketplace = "etsy" } = body;
  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  let item: InventoryItem | null = null;
  let ebayListedPrice = 0;
  let ebayExternalListingId: string | null = null;
  let targetAccount: MarketplaceAccount | undefined;

  if (supabase && isSupabaseConfigured()) {
    const [itemRes, listingRes, acctRes] = await Promise.all([
      supabase.from("inventory_items").select("*").eq("id", itemId).maybeSingle(),
      supabase
        .from("marketplace_listings")
        .select("listed_price, external_listing_id")
        .eq("item_id", itemId)
        .eq("marketplace", "ebay")
        .maybeSingle(),
      supabase
        .from("marketplace_accounts")
        .select("*")
        .eq("marketplace", targetMarketplace)
        .maybeSingle(),
    ]);

    if (itemRes.data) {
      item = itemRes.data as InventoryItem;
      ebayListedPrice = Number(
        listingRes.data?.listed_price ?? item.target_price
      );
      ebayExternalListingId =
        (listingRes.data?.external_listing_id as string | null) ?? null;
      targetAccount = (acctRes.data as MarketplaceAccount | null) ?? undefined;

      // Auto-enrich full photo gallery + description + brand from eBay GetItem on demand
      const needsEnrich =
        ebayExternalListingId &&
        ((item.image_urls?.length ?? 0) <= 1 ||
          !item.description_plain?.trim() ||
          !item.brand);

      if (needsEnrich && ebayExternalListingId) {
        const details = await fetchEbayItemDetails(ebayExternalListingId);
        if (details) {
          const mergedImages =
            details.imageUrls.length >= (item.image_urls?.length ?? 0) &&
            details.imageUrls.length > 0
              ? details.imageUrls
              : item.image_urls;
          const mergedDescPlain =
            item.description_plain?.trim() || details.descriptionPlain || null;
          const mergedDescHtml =
            item.description_html?.trim() || details.descriptionHtml || null;
          const mergedBrand = item.brand || details.brand || null;
          const mergedSpecifics =
            Object.keys(details.itemSpecifics).length > 0
              ? { ...(item.item_specifics || {}), ...details.itemSpecifics }
              : item.item_specifics;

          item = {
            ...item,
            image_urls: mergedImages,
            description_plain: mergedDescPlain,
            description_html: mergedDescHtml,
            brand: mergedBrand,
            item_specifics: mergedSpecifics,
          };

          await supabase
            .from("inventory_items")
            .update({
              image_urls: mergedImages,
              description_plain: mergedDescPlain,
              description_html: mergedDescHtml,
              brand: mergedBrand,
              item_specifics: mergedSpecifics,
              updated_at: new Date().toISOString(),
            })
            .eq("id", item.id);
        }
      }
    }
  }

  if (!item) {
    const store = getDemoStore();
    item = store.items.find((i) => i.id === itemId) ?? null;
    if (item) {
      const ebayListing = store.listings.find(
        (l) => l.item_id === item!.id && l.marketplace === "ebay"
      );
      ebayListedPrice = Number(
        ebayListing?.listed_price ?? item.target_price
      );
      targetAccount = store.accounts.find(
        (a) => a.marketplace === targetMarketplace
      );
    }
  }

  if (!item) {
    return NextResponse.json(
      { error: `Inventory item ${itemId} not found` },
      { status: 404 }
    );
  }

  try {
    const draft = await mapItemForMarketplace({
      item,
      ebayListedPrice,
      targetMarketplace,
      targetAccount,
    });

    let policyBlockRecorded = false;
    if (targetMarketplace !== "ebay" && draft.compliance?.status === "blocked") {
      const ch = targetMarketplace as CrossListMarketplace;
      const specs = (item.item_specifics || {}) as Record<string, unknown>;
      const overrides = parsePolicyOverrideList(specs);
      if (!overrides.includes(ch)) {
        const primary = extractPrimaryPolicyBlock(draft.compliance);
        if (primary) {
          const existingMap = parsePolicyBlockedMap(specs);
          const prev = existingMap[ch];
          const needsWrite =
            !prev || prev.rule !== primary.rule || prev.reason !== primary.reason;
          if (needsWrite) {
            const nextSpecs = applyPolicyBlockToSpecs(specs, ch, primary);
            if (supabase && isSupabaseConfigured()) {
              await supabase
                .from("inventory_items")
                .update({
                  item_specifics: nextSpecs,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", item.id);
            } else {
              applyDemoMarketplacePolicyBlock({
                itemId: item.id,
                marketplace: ch,
                blocked: true,
                block: primary,
              });
            }
            policyBlockRecorded = true;
          }
        }
      }
    }

    return NextResponse.json({
      ...draft,
      imageUrls: item.image_urls || [],
      policyBlockRecorded,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to map listing payload";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
