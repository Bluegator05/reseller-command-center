import { NextResponse } from "next/server";
import {
  applyDemoMarketplacePolicyBlock,
  getDemoStore,
  recordDemoJob,
  updateDemoExtensionJob,
} from "@/lib/demo-store";
import { fetchEbayItemDetails } from "@/lib/ebay";
import { mapItemForMarketplace } from "@/lib/gemini-mapper";
import {
  applyPolicyBlockToSpecs,
  clearPolicyBlockInSpecs,
  evaluateMarketplaceCompliance,
  extractPrimaryPolicyBlock,
  MARKETPLACE_LIMITS,
  sanitizeMarketplaceCopy,
} from "@/lib/marketplace-compliance";
import {
  parseCachedPhotoRankOrder,
  selectBestPhotosForChannel,
  serializePhotoRankOrder,
} from "@/lib/photo-selector";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  ChannelJob,
  CrossListDraftPayload,
  CrossListMarketplace,
  InventoryItem,
  JobStatusType,
  MarketplaceAccount,
  MarketplaceType,
} from "@/lib/types";

export const maxDuration = 60;

const EXTENSION_CHANNELS: MarketplaceType[] = [
  "poshmark",
  "mercari",
  "facebook",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-owner-passcode",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET /api/extension/jobs
 * Returns extension-mode channel_jobs for the Chrome/Arc Companion Extension & Command Center UI.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  if (supabase && isSupabaseConfigured()) {
    try {
      const { data, error } = await supabase
        .from("channel_jobs")
        .select("*, inventory_items(sku, title)")
        .eq("execution_mode", "extension")
        .order("created_at", { ascending: false })
        .limit(40);

      if (error) throw error;

      const jobs: ChannelJob[] = (data ?? []).map((row) => {
        const rec = row as ChannelJob & {
          inventory_items?:
            | { sku?: string; title?: string }
            | Array<{ sku?: string; title?: string }>
            | null;
        };
        const inv = Array.isArray(rec.inventory_items)
          ? rec.inventory_items[0]
          : rec.inventory_items;
        return {
          ...rec,
          item_sku: inv?.sku,
          item_title: inv?.title,
        };
      });

      return NextResponse.json(
        { mode: "live", jobs },
        { headers: CORS_HEADERS }
      );
    } catch (err) {
      console.error("[extension/jobs GET] Falling back to demo:", err);
    }
  }

  const store = getDemoStore();
  const jobs = store.jobs.filter((j) => j.execution_mode === "extension");
  return NextResponse.json({ mode: "demo", jobs }, { headers: CORS_HEADERS });
}

interface QueueExtensionBody {
  itemId?: string;
  itemIds?: string[];
  marketplace?: MarketplaceType;
  action?: "create" | "delist";
  draft?: Partial<CrossListDraftPayload>;
  overrideCompliance?: boolean;
}

/**
 * POST /api/extension/jobs
 * Queues 1-click extension jobs for Poshmark, Mercari, or Facebook Marketplace.
 */
export async function POST(request: Request) {
  let body: QueueExtensionBody;
  try {
    body = (await request.json()) as QueueExtensionBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const marketplace = body.marketplace;
  if (!marketplace || !EXTENSION_CHANNELS.includes(marketplace)) {
    return NextResponse.json(
      { error: "marketplace must be poshmark, mercari, or facebook" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const targetIds = Array.isArray(body.itemIds)
    ? body.itemIds
    : body.itemId
      ? [body.itemId]
      : [];

  if (targetIds.length === 0) {
    return NextResponse.json(
      { error: "Provide itemId or itemIds" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const action = body.action || "create";
  const supabase = getSupabaseServerClient();
  const useLive = Boolean(supabase && isSupabaseConfigured());
  const queuedJobs: ChannelJob[] = [];
  let skippedAlreadyListed = 0;
  let skippedAlreadyQueued = 0;
  let skippedPolicyBlocked = 0;

  for (const itemId of targetIds) {
    let item: InventoryItem | null = null;
    let ebayPrice = 0;
    let targetAccount: MarketplaceAccount | undefined;

    if (useLive && supabase) {
      const [itemRes, listingRes, acctRes] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("*")
          .eq("id", itemId)
          .maybeSingle(),
        supabase
          .from("marketplace_listings")
          .select("listed_price, external_listing_id")
          .eq("item_id", itemId)
          .eq("marketplace", "ebay")
          .maybeSingle(),
        supabase
          .from("marketplace_accounts")
          .select("*")
          .eq("marketplace", marketplace)
          .maybeSingle(),
      ]);

      if (itemRes.data) {
        item = itemRes.data as InventoryItem;
        ebayPrice = Number(listingRes.data?.listed_price ?? item.target_price);
        targetAccount = (acctRes.data as MarketplaceAccount | null) ?? undefined;

        const ebayExtId =
          (listingRes.data?.external_listing_id as string | null) ?? null;
        if (
          action === "create" &&
          ebayExtId &&
          ((item.image_urls?.length ?? 0) <= 1 ||
            !item.description_plain?.trim() ||
            !item.brand)
        ) {
          const details = await fetchEbayItemDetails(ebayExtId);
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
        ebayPrice = Number(ebayListing?.listed_price ?? item.target_price);
        targetAccount = store.accounts.find(
          (a) => a.marketplace === marketplace
        );
      }
    }

    if (!item) continue;

    const baseDraft = await mapItemForMarketplace({
      item,
      ebayListedPrice: ebayPrice,
      targetMarketplace: marketplace,
      targetAccount,
    });

    const override = targetIds.length === 1 ? body.draft : undefined;
    const limits = MARKETPLACE_LIMITS[marketplace];
    const rawPrice = Math.max(
      Number(item.floor_price),
      override?.pricing?.suggestedPrice ?? baseDraft.pricing.suggestedPrice
    );
    const suggestedPrice = limits.wholeDollarOnly
      ? Math.max(limits.minPrice, Math.ceil(rawPrice))
      : roundCurrency(rawPrice);

    const structuredCategory =
      override?.structuredCategory ?? baseDraft.structuredCategory;

    const sanitized = sanitizeMarketplaceCopy({
      title: override?.mappedTitle?.trim() || baseDraft.mappedTitle,
      description:
        override?.descriptionPlain?.trim() || baseDraft.descriptionPlain,
      targetMarketplace: marketplace,
    });

    if (action === "create" && useLive && supabase) {
      const [existingListingRes, existingJobRes] = await Promise.all([
        supabase
          .from("marketplace_listings")
          .select("id, external_url, status")
          .eq("item_id", item.id)
          .eq("marketplace", marketplace)
          .eq("status", "active")
          .maybeSingle(),
        supabase
          .from("channel_jobs")
          .select("id, status")
          .eq("item_id", item.id)
          .eq("marketplace", marketplace)
          .eq("action", "create")
          .in("status", ["pending", "processing", "needs_user_confirm"])
          .maybeSingle(),
      ]);

      if (existingListingRes.data) {
        if (targetIds.length === 1) {
          return NextResponse.json(
            {
              error: `Already listed on ${marketplace.toUpperCase()} — unlink it first if you intend to relist.`,
              alreadyListed: true,
            },
            { status: 409, headers: CORS_HEADERS }
          );
        }
        skippedAlreadyListed += 1;
        continue;
      }

      if (existingJobRes.data) {
        if (targetIds.length === 1) {
          return NextResponse.json(
            {
              error: `This item is already queued / in progress for ${marketplace.toUpperCase()}.`,
              alreadyQueued: true,
            },
            { status: 409, headers: CORS_HEADERS }
          );
        }
        skippedAlreadyQueued += 1;
        continue;
      }
    }

    if (action === "create" && !body.overrideCompliance) {
      const compliance = evaluateMarketplaceCompliance({
        item,
        targetMarketplace: marketplace,
        suggestedPrice,
        whenMade: override?.whenMade ?? baseDraft.whenMade,
        isSupply: override?.isSupply ?? baseDraft.isSupply,
        aiPolicyIssues: baseDraft.compliance?.issues?.filter((i) =>
          i.code.startsWith("AI_POLICY_")
        ),
      });

      if (!compliance.allowed) {
        if (marketplace !== "ebay") {
          const ch = marketplace as CrossListMarketplace;
          const primary = extractPrimaryPolicyBlock(compliance);
          if (primary) {
            const nextSpecs = applyPolicyBlockToSpecs(
              (item.item_specifics || {}) as Record<string, unknown>,
              ch,
              primary
            );
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
          }
        }

        const blockReasons = compliance.issues
          .filter((i) => i.severity === "block")
          .map((i) => `${i.rule}: ${i.detail}`)
          .join(" | ");
        if (targetIds.length === 1) {
          return NextResponse.json(
            {
              error: `Blocked by ${marketplace.toUpperCase()} policy — ${blockReasons}`,
              compliance,
            },
            { status: 422, headers: CORS_HEADERS }
          );
        }
        skippedPolicyBlocked += 1;
        continue;
      }
    } else if (action === "create" && body.overrideCompliance && marketplace !== "ebay") {
      const ch = marketplace as CrossListMarketplace;
      const nextSpecs = clearPolicyBlockInSpecs(
        (item.item_specifics || {}) as Record<string, unknown>,
        ch,
        true
      );
      item = {
        ...item,
        item_specifics: nextSpecs as Record<string, string | string[]>,
      };
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
          blocked: false,
          addOverride: true,
        });
      }
    }

    const allItemPhotos = item.image_urls || [];
    let selectedImageUrls = allItemPhotos.slice(0, limits.maxPhotos);

    if (action === "create" && allItemPhotos.length > limits.maxPhotos) {
      const cachedRank = parseCachedPhotoRankOrder(
        item.item_specifics,
        allItemPhotos.length
      );
      const selection = await selectBestPhotosForChannel({
        imageUrls: allItemPhotos,
        maxPhotos: limits.maxPhotos,
        title: item.title,
        channel: marketplace,
        cachedRankOrder: cachedRank,
      });
      selectedImageUrls = selection.selectedUrls;

      if (!cachedRank && useLive && supabase) {
        const nextSpecifics = {
          ...(item.item_specifics || {}),
          photo_rank_order: serializePhotoRankOrder(selection.rankOrder),
        };
        await supabase
          .from("inventory_items")
          .update({
            item_specifics: nextSpecifics,
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);
      }
    }

    const jobPayload = {
      sku: item.sku,
      mappedTitle: sanitized.title,
      descriptionPlain: sanitized.description,
      brand: item.brand,
      condition: structuredCategory?.conditionLabel || item.condition,
      categoryPath: override?.categoryPath || baseDraft.categoryPath,
      structuredCategory,
      targetPrice: Math.ceil(Number(item.target_price)),
      suggestedPrice,
      weightOz: item.weight_oz ?? null,
      imageUrls: selectedImageUrls,
      requiresUserConfirm: marketplace === "facebook",
    };

    const nowIso = new Date().toISOString();

    if (useLive && supabase) {
      const { data, error } = await supabase
        .from("channel_jobs")
        .insert({
          item_id: item.id,
          marketplace,
          action,
          execution_mode: "extension",
          payload: jobPayload,
          status: "pending",
          attempts: 0,
        })
        .select("*")
        .single();

      if (!error && data) {
        queuedJobs.push({
          ...(data as ChannelJob),
          item_sku: item.sku,
          item_title: item.title,
        });
      }
    } else {
      const job = recordDemoJob({
        item_id: item.id,
        listing_id: null,
        marketplace,
        action,
        execution_mode: "extension",
        payload: jobPayload,
        status: "pending",
        attempts: 0,
        error_message: null,
        created_at: nowIso,
        started_at: null,
        completed_at: null,
        item_sku: item.sku,
        item_title: item.title,
      });
      queuedJobs.push(job);
    }
  }

  return NextResponse.json(
    {
      mode: useLive ? "live" : "demo",
      queuedCount: queuedJobs.length,
      skippedAlreadyListed,
      skippedAlreadyQueued,
      skippedPolicyBlocked,
      jobs: queuedJobs,
      message: `Queued ${queuedJobs.length} ${marketplace} job${queuedJobs.length === 1 ? "" : "s"} for the Chrome/Arc Companion Extension.`,
    },
    { headers: CORS_HEADERS }
  );
}

/**
 * PATCH /api/extension/jobs
 * Advances an extension job's status (`processing`, `needs_user_confirm`, `completed`, `failed`).
 * When marked `completed` for `action = 'create'`, records the active `marketplace_listings` row.
 */
export async function PATCH(request: Request) {
  let body: {
    jobId?: string;
    status?: JobStatusType;
    externalUrl?: string;
    externalListingId?: string;
    listedPrice?: number;
    errorMessage?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const { jobId, status, externalUrl, listedPrice, errorMessage } = body;
  if (!jobId || !status) {
    return NextResponse.json(
      { error: "jobId and status are required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const supabase = getSupabaseServerClient();
  const useLive = Boolean(supabase && isSupabaseConfigured());
  const nowIso = new Date().toISOString();

  if (useLive && supabase) {
    const { data: existingJob, error: fetchErr } = await supabase
      .from("channel_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();

    if (fetchErr || !existingJob) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const job = existingJob as ChannelJob;
    let listingId = job.listing_id;

    // 1. Atomic claim guard when a worker starts `processing` so two devices/alarms can NEVER double-post
    if (status === "processing") {
      if (job.action === "create") {
        const { data: activeExisting } = await supabase
          .from("marketplace_listings")
          .select("id")
          .eq("item_id", job.item_id)
          .eq("marketplace", job.marketplace)
          .eq("status", "active")
          .maybeSingle();

        if (activeExisting) {
          await supabase
            .from("channel_jobs")
            .update({
              status: "failed",
              completed_at: nowIso,
              error_message: `Already listed on ${job.marketplace.toUpperCase()} — prevented duplicate post.`,
            })
            .eq("id", jobId)
            .in("status", ["pending", "needs_user_confirm"]);

          return NextResponse.json(
            {
              error: `Already listed on ${job.marketplace.toUpperCase()} — prevented duplicate post.`,
              alreadyClaimed: true,
              alreadyListed: true,
            },
            { status: 409, headers: CORS_HEADERS }
          );
        }
      }

      const { data: claimed, error: claimErr } = await supabase
        .from("channel_jobs")
        .update({
          status: "processing",
          attempts: (job.attempts || 0) + 1,
          started_at: nowIso,
          error_message: null,
        })
        .eq("id", jobId)
        .in("status", ["pending", "needs_user_confirm"])
        .select("*")
        .maybeSingle();

      if (claimErr) {
        return NextResponse.json(
          { error: claimErr.message },
          { status: 500, headers: CORS_HEADERS }
        );
      }

      if (!claimed) {
        return NextResponse.json(
          {
            error: "Job already claimed or completed by another worker.",
            alreadyClaimed: true,
          },
          { status: 409, headers: CORS_HEADERS }
        );
      }

      return NextResponse.json(
        { mode: "live", job: claimed },
        { headers: CORS_HEADERS }
      );
    }

    if (status === "completed" && job.action === "create") {
      const price = roundCurrency(
        Number(listedPrice ?? job.payload?.suggestedPrice ?? 0)
      );
      const fallbackExtId = `${job.marketplace}-${Date.now().toString().slice(-7)}`;
      const fallbackUrl =
        job.marketplace === "poshmark"
          ? `https://poshmark.com/listing/${fallbackExtId}`
          : job.marketplace === "mercari"
            ? `https://www.mercari.com/us/item/${fallbackExtId}/`
            : `https://www.facebook.com/marketplace/item/${fallbackExtId}/`;

      const cleanUrl = (externalUrl || "").trim();
      let resolvedExtId =
        (typeof body.externalListingId === "string" &&
          body.externalListingId.trim()) ||
        "";
      if (!resolvedExtId && cleanUrl) {
        if (job.marketplace === "poshmark") {
          const m = cleanUrl.match(/([0-9a-f]{24})(?:[/?#]|$)/i);
          if (m) resolvedExtId = m[1];
        } else if (job.marketplace === "mercari") {
          const m = cleanUrl.match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
          if (m) resolvedExtId = m[1];
        } else if (job.marketplace === "facebook") {
          const m = cleanUrl.match(/\/item\/(\d{6,})/);
          if (m) resolvedExtId = m[1];
        }
      }

      let safeUrl = cleanUrl || fallbackUrl;
      let safeExtId = resolvedExtId || fallbackExtId;

      // Cross-item URL/ID collision guard: never link this item to a Poshmark/Mercari listing owned by a different item
      if (resolvedExtId || cleanUrl) {
        const filters: string[] = [];
        if (resolvedExtId) filters.push(`external_listing_id.eq.${resolvedExtId}`);
        if (cleanUrl && /\/(?:listing|item)\//i.test(cleanUrl)) {
          filters.push(`external_url.eq.${cleanUrl}`);
        }
        if (filters.length > 0) {
          const { data: collision } = await supabase
            .from("marketplace_listings")
            .select("id, item_id")
            .eq("marketplace", job.marketplace)
            .neq("item_id", job.item_id)
            .or(filters.join(","))
            .limit(1)
            .maybeSingle();

          if (collision) {
            console.warn(
              `[extension/jobs PATCH] Blocked colliding ${job.marketplace} URL (${safeUrl}) already linked to item ${collision.item_id}`
            );
            safeUrl = fallbackUrl;
            safeExtId = fallbackExtId;
          }
        }
      }

      const isMercariDraftUrl =
        job.marketplace === "mercari" && /\/draft\b/i.test(safeUrl);

      const { data: listingRow } = await supabase
        .from("marketplace_listings")
        .upsert(
          {
            item_id: job.item_id,
            marketplace: job.marketplace,
            external_listing_id: safeExtId,
            external_url: safeUrl,
            listed_price: price,
            shipping_price: 0,
            status: isMercariDraftUrl ? "draft" : "active",
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

      listingId = listingRow?.id ?? listingId;
    } else if (
      status === "needs_user_confirm" &&
      job.action === "create" &&
      job.marketplace === "mercari" &&
      ((typeof errorMessage === "string" && /saved mercari draft/i.test(errorMessage)) ||
        (typeof externalUrl === "string" && /\/draft\b/i.test(externalUrl)))
    ) {
      // Mercari accounts capped at 100 active listings save cross-listed items to Drafts —
      // record a "draft" marketplace_listings row so anti-double-sell auto-delist deletes them when sold!
      const draftPrice = roundCurrency(
        Number(listedPrice ?? job.payload?.suggestedPrice ?? 0)
      );
      const draftUrl =
        typeof externalUrl === "string" && /mercari\.com/i.test(externalUrl.trim())
          ? externalUrl.trim()
          : "https://www.mercari.com/mypage/listings/draft/ready-to-list/?page=1";
      const { data: existingMc } = await supabase
        .from("marketplace_listings")
        .select("id, status")
        .eq("item_id", job.item_id)
        .eq("marketplace", "mercari")
        .maybeSingle();

      if (!existingMc || existingMc.status !== "active") {
        const { data: draftRow } = await supabase
          .from("marketplace_listings")
          .upsert(
            {
              item_id: job.item_id,
              marketplace: "mercari",
              external_listing_id: `mercari-draft-${Date.now().toString().slice(-7)}`,
              external_url: draftUrl,
              listed_price: draftPrice,
              shipping_price: 0,
              status: "draft",
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
        listingId = draftRow?.id ?? listingId;
      }
    } else if (status === "completed" && job.action === "delist") {
      await supabase
        .from("marketplace_listings")
        .update({ status: "ended", last_synced_at: nowIso })
        .eq("item_id", job.item_id)
        .eq("marketplace", job.marketplace);
    }

    const { data: updated, error: updateErr } = await supabase
      .from("channel_jobs")
      .update({
        status,
        listing_id: listingId,
        completed_at:
          status === "completed" || status === "failed" ? nowIso : null,
        error_message: errorMessage ?? null,
      })
      .eq("id", jobId)
      .select("*")
      .single();

    if (updateErr) {
      return NextResponse.json(
        { error: updateErr.message },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    return NextResponse.json(
      { mode: "live", job: updated },
      { headers: CORS_HEADERS }
    );
  }

  const updated = updateDemoExtensionJob({
    jobId,
    status,
    externalUrl,
    listedPrice,
    errorMessage,
  });

  if (!updated) {
    return NextResponse.json(
      { error: "Extension job not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  return NextResponse.json(
    { mode: "demo", job: updated },
    { headers: CORS_HEADERS }
  );
}

/**
 * DELETE /api/extension/jobs?id=<jobId>
 * Cancels and removes a queued extension job (e.g., if the item was already listed).
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("id")?.trim();
  if (!jobId) {
    return NextResponse.json(
      { error: "Missing required id query parameter" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const supabase = getSupabaseServerClient();
  const useLive = Boolean(supabase && isSupabaseConfigured());

  if (useLive && supabase) {
    const { error } = await supabase
      .from("channel_jobs")
      .delete()
      .eq("id", jobId);
    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(
      { mode: "live", deletedId: jobId },
      { headers: CORS_HEADERS }
    );
  }

  const store = getDemoStore();
  store.jobs = store.jobs.filter((j) => j.id !== jobId);
  return NextResponse.json(
    { mode: "demo", deletedId: jobId },
    { headers: CORS_HEADERS }
  );
}
