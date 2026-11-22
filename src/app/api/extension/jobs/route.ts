import { NextResponse } from "next/server";
import {
  getDemoStore,
  recordDemoJob,
  updateDemoExtensionJob,
} from "@/lib/demo-store";
import { fetchEbayItemDetails } from "@/lib/ebay";
import { mapItemForMarketplace } from "@/lib/gemini-mapper";
import {
  evaluateMarketplaceCompliance,
  MARKETPLACE_LIMITS,
  sanitizeMarketplaceCopy,
} from "@/lib/marketplace-compliance";
import { roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  ChannelJob,
  CrossListDraftPayload,
  InventoryItem,
  JobStatusType,
  MarketplaceAccount,
  MarketplaceType,
} from "@/lib/types";

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
        continue;
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
      imageUrls: (item.image_urls || []).slice(0, limits.maxPhotos),
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

      const { data: listingRow } = await supabase
        .from("marketplace_listings")
        .upsert(
          {
            item_id: job.item_id,
            marketplace: job.marketplace,
            external_listing_id: fallbackExtId,
            external_url: externalUrl || fallbackUrl,
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
        )
        .select("id")
        .single();

      listingId = listingRow?.id ?? listingId;
    }

    const { data: updated, error: updateErr } = await supabase
      .from("channel_jobs")
      .update({
        status,
        listing_id: listingId,
        attempts:
          status === "processing" ? (job.attempts || 0) + 1 : job.attempts,
        started_at:
          status === "processing" ? nowIso : job.started_at,
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
