import { NextResponse } from "next/server";
import {
  getDemoStore,
  recordDemoJob,
  upsertDemoEtsyListing,
} from "@/lib/demo-store";
import { createEtsyListing, isEtsyConfigured } from "@/lib/etsy";
import { mapItemForMarketplace } from "@/lib/gemini-mapper";
import {
  evaluateMarketplaceCompliance,
  sanitizeMarketplaceCopy,
} from "@/lib/marketplace-compliance";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  CrossListDraftPayload,
  EtsyCrossListResult,
  InventoryItem,
  MarketplaceAccount,
} from "@/lib/types";

interface CrossListBody {
  itemId?: string;
  itemIds?: string[];
  draft?: Partial<CrossListDraftPayload>;
  publishImmediately?: boolean;
}

/**
 * POST /api/etsy/crosslist
 * 1-click cross-list from eBay master inventory to Etsy Open API v3.
 * Supports single item (with optional user-edited draft from CrossListDrawer)
 * or bulk `itemIds[]` with automatic Gemini/heuristic translation.
 */
export async function POST(request: Request) {
  let body: CrossListBody;
  try {
    body = (await request.json()) as CrossListBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const targetIds = Array.isArray(body.itemIds)
    ? body.itemIds
    : body.itemId
      ? [body.itemId]
      : [];

  if (targetIds.length === 0) {
    return NextResponse.json(
      { error: "Provide itemId or itemIds" },
      { status: 400 }
    );
  }

  const publishImmediately = body.publishImmediately ?? true;
  const supabase = getSupabaseServerClient();
  const canRunLive = Boolean(
    supabase && isSupabaseConfigured() && isEtsyConfigured()
  );

  const results: EtsyCrossListResult[] = [];
  const errors: Array<{ itemId: string; error: string }> = [];

  for (const itemId of targetIds) {
    try {
      let item: InventoryItem | null = null;
      let ebayListedPrice = 0;
      let etsyAccount: MarketplaceAccount | undefined;

      if (supabase && isSupabaseConfigured()) {
        const [itemRes, listingRes, acctRes] = await Promise.all([
          supabase
            .from("inventory_items")
            .select("*")
            .eq("id", itemId)
            .maybeSingle(),
          supabase
            .from("marketplace_listings")
            .select("listed_price")
            .eq("item_id", itemId)
            .eq("marketplace", "ebay")
            .maybeSingle(),
          supabase
            .from("marketplace_accounts")
            .select("*")
            .eq("marketplace", "etsy")
            .maybeSingle(),
        ]);

        if (itemRes.data) {
          item = itemRes.data as InventoryItem;
          ebayListedPrice = Number(
            listingRes.data?.listed_price ?? item.target_price
          );
          etsyAccount = (acctRes.data as MarketplaceAccount | null) ?? undefined;
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
          etsyAccount = store.accounts.find((a) => a.marketplace === "etsy");
        }
      }

      if (!item) {
        errors.push({ itemId, error: "Inventory item not found" });
        continue;
      }

      // Generate base mapped draft and merge any user edits (for single-item drawer)
      const baseDraft = await mapItemForMarketplace({
        item,
        ebayListedPrice,
        targetMarketplace: "etsy",
        targetAccount: etsyAccount,
      });

      const mergedDraft: CrossListDraftPayload =
        targetIds.length === 1 && body.draft
          ? {
              ...baseDraft,
              mappedTitle:
                body.draft.mappedTitle?.trim() || baseDraft.mappedTitle,
              descriptionPlain:
                body.draft.descriptionPlain?.trim() ||
                baseDraft.descriptionPlain,
              categoryPath:
                body.draft.categoryPath?.trim() || baseDraft.categoryPath,
              taxonomyId: body.draft.taxonomyId ?? baseDraft.taxonomyId,
              whenMade: body.draft.whenMade || baseDraft.whenMade,
              isSupply:
                typeof body.draft.isSupply === "boolean"
                  ? body.draft.isSupply
                  : baseDraft.isSupply,
              tags:
                Array.isArray(body.draft.tags) && body.draft.tags.length > 0
                  ? body.draft.tags.slice(0, 13)
                  : baseDraft.tags,
              pricing: {
                ...baseDraft.pricing,
                suggestedPrice: roundCurrency(
                  Math.max(
                    Number(item.floor_price),
                    body.draft.pricing?.suggestedPrice ??
                      baseDraft.pricing.suggestedPrice
                  )
                ),
              },
            }
          : baseDraft;

      const sanitized = sanitizeMarketplaceCopy({
        title: mergedDraft.mappedTitle,
        description: mergedDraft.descriptionPlain,
        targetMarketplace: "etsy",
      });
      mergedDraft.mappedTitle = sanitized.title;
      mergedDraft.descriptionPlain = sanitized.description;

      const etsyCompliance = evaluateMarketplaceCompliance({
        item,
        targetMarketplace: "etsy",
        suggestedPrice: mergedDraft.pricing.suggestedPrice,
        whenMade: mergedDraft.whenMade,
        isSupply: mergedDraft.isSupply,
        whoMade: mergedDraft.whoMade,
        aiPolicyIssues: baseDraft.compliance?.issues?.filter((i) =>
          i.code.startsWith("AI_POLICY_")
        ),
      });

      if (!etsyCompliance.allowed) {
        const blockMsg = etsyCompliance.issues
          .filter((i) => i.severity === "block")
          .map((i) => `${i.rule}: ${i.detail}`)
          .join(" | ");
        errors.push({ itemId, error: `Blocked by Etsy policy — ${blockMsg}` });
        continue;
      }

      const nowIso = new Date().toISOString();

      if (canRunLive && supabase) {
        const { data: jobRow } = await supabase
          .from("channel_jobs")
          .insert({
            item_id: item.id,
            marketplace: "etsy",
            action: "create",
            execution_mode: "api",
            payload: {
              title: mergedDraft.mappedTitle,
              price: mergedDraft.pricing.suggestedPrice,
              taxonomyId: mergedDraft.taxonomyId,
              tagsCount: mergedDraft.tags.length,
              mapperMode: mergedDraft.mapperMode,
            },
            status: "processing",
            attempts: 1,
            started_at: nowIso,
          })
          .select("id")
          .single();

        const jobId = jobRow?.id ?? "etsy-live-job";

        try {
          const created = await createEtsyListing({
            draft: mergedDraft,
            publishImmediately,
          });

          const { data: listingRow, error: upsertError } = await supabase
            .from("marketplace_listings")
            .upsert(
              {
                item_id: item.id,
                marketplace: "etsy",
                external_listing_id: created.externalListingId,
                external_url: created.externalUrl,
                listed_price: mergedDraft.pricing.suggestedPrice,
                shipping_price: 0,
                status: created.status,
                views_count: 0,
                watchers_count: 0,
                impressions_count: 0,
                listed_at: nowIso,
                last_synced_at: nowIso,
              },
              { onConflict: "item_id,marketplace" }
            )
            .select("id")
            .single();

          if (upsertError) throw upsertError;

          await supabase
            .from("channel_jobs")
            .update({
              listing_id: listingRow?.id ?? null,
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          results.push({
            mode: "live",
            itemId: item.id,
            sku: item.sku,
            listingId: listingRow?.id ?? created.externalListingId,
            externalListingId: created.externalListingId,
            externalUrl: created.externalUrl,
            listedPrice: mergedDraft.pricing.suggestedPrice,
            status: created.status,
            jobId,
            mapperMode: mergedDraft.mapperMode,
            message: `Cross-listed to Etsy (#${created.externalListingId}) at $${mergedDraft.pricing.suggestedPrice.toFixed(2)}`,
          });
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Etsy API creation failed";
          await supabase
            .from("channel_jobs")
            .update({
              status: "failed",
              error_message: msg,
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);
          errors.push({ itemId: item.id, error: msg });
        }
      } else {
        // Demo store cross-list execution
        const created = upsertDemoEtsyListing({
          itemId: item.id,
          listedPrice: mergedDraft.pricing.suggestedPrice,
          status: publishImmediately ? "active" : "draft",
        });

        const job = recordDemoJob({
          item_id: item.id,
          listing_id: created.id,
          marketplace: "etsy",
          action: "create",
          execution_mode: "api",
          payload: {
            title: mergedDraft.mappedTitle,
            price: mergedDraft.pricing.suggestedPrice,
            externalListingId: created.external_listing_id,
            tagsCount: mergedDraft.tags.length,
            mapperMode: mergedDraft.mapperMode,
          },
          status: "completed",
          attempts: 1,
          error_message: null,
          created_at: nowIso,
          started_at: nowIso,
          completed_at: nowIso,
          item_sku: item.sku,
          item_title: item.title,
        });

        results.push({
          mode: "demo",
          itemId: item.id,
          sku: item.sku,
          listingId: created.id,
          externalListingId: created.external_listing_id || "",
          externalUrl: created.external_url || "",
          listedPrice: created.listed_price,
          status: created.status,
          jobId: job.id,
          mapperMode: mergedDraft.mapperMode,
          message: `Cross-listed to Etsy (#${created.external_listing_id}) at $${created.listed_price.toFixed(2)} (${mergedDraft.tags.length} SEO tags)`,
        });
      }
    } catch (err) {
      errors.push({
        itemId,
        error: err instanceof Error ? err.message : "Cross-list failed",
      });
    }
  }

  return NextResponse.json({
    mode: canRunLive ? "live" : "demo",
    completedCount: results.length,
    failedCount: errors.length,
    results,
    errors,
  });
}
