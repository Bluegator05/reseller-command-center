import { NextResponse } from "next/server";
import {
  applyDemoEndAndSellSimilar,
  applyDemoListingPrice,
  getDemoStore,
  recordDemoJob,
} from "@/lib/demo-store";
import {
  endAndSellSimilarEbayOffer,
  isEbayConfigured,
  sendEbayOfferToWatchers,
  updateEbayOfferPrice,
} from "@/lib/ebay";
import { computeClampedPriceDrop, roundCurrency } from "@/lib/stale-engine";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  EbayActionItemResult,
  EbayActionRequest,
  EbayActionResponse,
  InventoryItem,
  MarketplaceListing,
} from "@/lib/types";

interface JoinedListing extends MarketplaceListing {
  inventory_items: InventoryItem | InventoryItem[] | null;
}

/**
 * POST /api/ebay/action
 * Executes single or bulk eBay interventions:
 * - `update_price`: Percentage price drop (default 10%), strictly clamped to `inventory_items.floor_price`.
 * - `end_and_sell_similar`: Ends stale offer and re-publishes fresh listing ID.
 * - `send_offer`: Dispatches watcher offers via eBay Negotiation API.
 */
export async function POST(request: Request) {
  let body: EbayActionRequest;
  try {
    body = (await request.json()) as EbayActionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const { action, listingIds, dropPct = 10, offerPct = 10, offerMessage } = body;

  if (
    !action ||
    !["update_price", "end_and_sell_similar", "send_offer"].includes(action)
  ) {
    return NextResponse.json(
      { error: "Unsupported action type" },
      { status: 400 }
    );
  }

  if (!Array.isArray(listingIds) || listingIds.length === 0) {
    return NextResponse.json(
      { error: "Provide at least one listingId" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const isLive = Boolean(
    supabase && isSupabaseConfigured() && isEbayConfigured()
  );

  if (!isLive) {
    return handleDemoAction({
      action,
      listingIds,
      dropPct,
      offerPct,
      offerMessage,
    });
  }

  try {
    const { data: rows, error } = await supabase!
      .from("marketplace_listings")
      .select("*, inventory_items(*)")
      .in("id", listingIds);

    if (error) throw error;

    const listings = (rows ?? []) as JoinedListing[];
    const results: EbayActionItemResult[] = [];

    for (const listing of listings) {
      const inv = Array.isArray(listing.inventory_items)
        ? listing.inventory_items[0]
        : listing.inventory_items;

      if (!inv) continue;

      const currentPrice = Number(listing.listed_price);
      const floorPrice = Number(inv.floor_price);
      const nowIso = new Date().toISOString();

      if (action === "update_price") {
        const calc = computeClampedPriceDrop(currentPrice, floorPrice, dropPct);

        if (calc.isAlreadyAtFloor) {
          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: inv.title,
            action,
            status: "skipped",
            previousPrice: currentPrice,
            newPrice: currentPrice,
            floorPrice,
            wasClampedToFloor: true,
            jobId: "skipped-at-floor",
            message: `Skipped — already at COGS floor ($${floorPrice.toFixed(2)})`,
          });
          continue;
        }

        const { data: jobRow } = await supabase!
          .from("channel_jobs")
          .insert({
            item_id: inv.id,
            listing_id: listing.id,
            marketplace: "ebay",
            action: "update_price",
            execution_mode: "api",
            payload: {
              previousPrice: currentPrice,
              newPrice: calc.nextPrice,
              floorPrice,
              dropPct,
              wasClamped: calc.wasClamped,
            },
            status: "processing",
            attempts: 1,
            started_at: nowIso,
          })
          .select("id")
          .single();

        const jobId = jobRow?.id ?? "live-job";

        try {
          if (!listing.external_listing_id) {
            throw new Error("Missing external eBay offer/listing ID");
          }

          await updateEbayOfferPrice({
            offerId: listing.external_listing_id,
            sku: inv.sku,
            newPrice: calc.nextPrice,
          });

          await supabase!
            .from("marketplace_listings")
            .update({
              listed_price: calc.nextPrice,
              last_price_drop_at: nowIso,
              last_synced_at: nowIso,
            })
            .eq("id", listing.id);

          await supabase!
            .from("channel_jobs")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: inv.title,
            action,
            status: "completed",
            previousPrice: currentPrice,
            newPrice: calc.nextPrice,
            floorPrice,
            wasClampedToFloor: calc.wasClamped,
            jobId,
            message: calc.wasClamped
              ? `Dropped $${currentPrice.toFixed(2)} → $${calc.nextPrice.toFixed(2)} (clamped to COGS floor)`
              : `Dropped $${currentPrice.toFixed(2)} → $${calc.nextPrice.toFixed(2)} (-${dropPct}%)`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Price update failed";
          await supabase!
            .from("channel_jobs")
            .update({
              status: "failed",
              error_message: msg,
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: inv.title,
            action,
            status: "failed",
            previousPrice: currentPrice,
            newPrice: currentPrice,
            floorPrice,
            wasClampedToFloor: false,
            jobId,
            message: msg,
          });
        }
      } else if (action === "end_and_sell_similar") {
        const { data: jobRow } = await supabase!
          .from("channel_jobs")
          .insert({
            item_id: inv.id,
            listing_id: listing.id,
            marketplace: "ebay",
            action: "end_and_sell_similar",
            execution_mode: "api",
            payload: {
              previousExternalListingId: listing.external_listing_id,
              listedPrice: currentPrice,
            },
            status: "processing",
            attempts: 1,
            started_at: nowIso,
          })
          .select("id")
          .single();

        const jobId = jobRow?.id ?? "live-job";

        try {
          if (!listing.external_listing_id) {
            throw new Error("Missing external eBay offer ID");
          }

          const targetRelistPrice =
            typeof body.newPrice === "number" && body.newPrice > 0
              ? roundCurrency(body.newPrice)
              : currentPrice;
          const targetRelistTitle =
            typeof body.newTitle === "string" && body.newTitle.trim().length >= 3
              ? body.newTitle.trim().slice(0, 80)
              : undefined;

          const relisted = await endAndSellSimilarEbayOffer({
            offerId: listing.external_listing_id,
            sku: inv.sku,
            newPrice: targetRelistPrice,
            newTitle: targetRelistTitle,
          });

          const existingSpecs = (inv.item_specifics || {}) as Record<
            string,
            unknown
          >;
          const prevRelistCount = Number.isFinite(
            Number(existingSpecs.relist_count)
          )
            ? Math.max(0, Math.floor(Number(existingSpecs.relist_count)))
            : listing.last_refreshed_at
              ? 1
              : 0;
          const nextRelistCount = prevRelistCount + 1;

          await supabase!
            .from("inventory_items")
            .update({
              ...(targetRelistTitle ? { title: targetRelistTitle } : {}),
              ...(targetRelistPrice !== currentPrice
                ? { target_price: targetRelistPrice }
                : {}),
              item_specifics: {
                ...existingSpecs,
                relist_count: String(nextRelistCount),
                last_relisted_at: nowIso,
              },
              updated_at: nowIso,
            })
            .eq("id", inv.id);

          await supabase!
            .from("marketplace_listings")
            .update({
              external_listing_id: relisted.newListingId,
              external_url: relisted.newExternalUrl,
              listed_price: targetRelistPrice,
              listed_at: nowIso,
              last_refreshed_at: nowIso,
              last_synced_at: nowIso,
              views_count: 0,
              watchers_count: 0,
              impressions_count: 0,
            })
            .eq("id", listing.id);

          await supabase!
            .from("channel_jobs")
            .update({
              status: "completed",
              payload: {
                previousExternalListingId: listing.external_listing_id,
                newListingId: relisted.newListingId,
                newOfferId: relisted.newOfferId,
                relistCount: nextRelistCount,
                updatedPrice: targetRelistPrice,
                updatedTitle: targetRelistTitle ?? null,
              },
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          const tweakNotes: string[] = [];
          if (targetRelistPrice !== currentPrice) {
            tweakNotes.push(
              `$${currentPrice.toFixed(2)} → $${targetRelistPrice.toFixed(2)}`
            );
          }
          if (targetRelistTitle && targetRelistTitle !== inv.title) {
            tweakNotes.push("title upgraded");
          }

          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: targetRelistTitle || inv.title,
            action,
            status: "completed",
            previousPrice: currentPrice,
            newPrice: targetRelistPrice,
            floorPrice,
            wasClampedToFloor: false,
            newExternalListingId: relisted.newListingId,
            jobId,
            message: `Relisted (#${nextRelistCount}) as #${relisted.newListingId}${tweakNotes.length > 0 ? ` (${tweakNotes.join(", ")})` : ""}`,
          });
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "End & Sell Similar failed";
          await supabase!
            .from("channel_jobs")
            .update({
              status: "failed",
              error_message: msg,
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: inv.title,
            action,
            status: "failed",
            previousPrice: currentPrice,
            newPrice: currentPrice,
            floorPrice,
            wasClampedToFloor: false,
            jobId,
            message: msg,
          });
        }
      } else if (action === "send_offer") {
        const calc = computeClampedPriceDrop(currentPrice, floorPrice, offerPct);
        const { data: jobRow } = await supabase!
          .from("channel_jobs")
          .insert({
            item_id: inv.id,
            listing_id: listing.id,
            marketplace: "ebay",
            action: "send_offer",
            execution_mode: "api",
            payload: {
              offerPct,
              offerPrice: calc.nextPrice,
              watchersCount: listing.watchers_count,
            },
            status: "processing",
            attempts: 1,
            started_at: nowIso,
          })
          .select("id")
          .single();

        const jobId = jobRow?.id ?? "live-job";

        try {
          if (!listing.external_listing_id) {
            throw new Error("Missing external eBay listing ID");
          }

          const effectiveDiscountPct =
            currentPrice > 0
              ? Math.max(
                  5,
                  Math.round(
                    ((currentPrice - calc.nextPrice) / currentPrice) * 100
                  )
                )
              : offerPct;

          const sent = await sendEbayOfferToWatchers({
            listingId: listing.external_listing_id,
            discountPct: effectiveDiscountPct,
            message: offerMessage,
          });

          await supabase!
            .from("channel_jobs")
            .update({
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: inv.title,
            action,
            status: "completed",
            previousPrice: currentPrice,
            newPrice: calc.nextPrice,
            floorPrice,
            wasClampedToFloor: calc.wasClamped,
            jobId,
            message: `Sent ${effectiveDiscountPct}% offer to ${sent.offersSent} eligible buyer(s)`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Send offer failed";
          const isAlreadyActive =
            msg.includes("150019") ||
            msg.toLowerCase().includes("seller-initiated negotiation");

          await supabase!
            .from("channel_jobs")
            .update({
              status: isAlreadyActive ? "completed" : "failed",
              error_message: isAlreadyActive ? null : msg,
              payload: {
                offerPct,
                offerPrice: calc.nextPrice,
                watchersCount: listing.watchers_count,
                alreadyActiveOnEbay: isAlreadyActive,
              },
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);

          results.push({
            listingId: listing.id,
            itemId: inv.id,
            sku: inv.sku,
            title: inv.title,
            action,
            status: isAlreadyActive ? "skipped" : "failed",
            previousPrice: currentPrice,
            newPrice: isAlreadyActive ? calc.nextPrice : currentPrice,
            floorPrice,
            wasClampedToFloor: false,
            jobId,
            message: isAlreadyActive
              ? "Active offer already live on eBay — removed from queue"
              : msg,
          });
        }
      }
    }

    const response: EbayActionResponse = {
      mode: "live",
      action,
      processedCount: results.length,
      completedCount: results.filter((r) => r.status === "completed").length,
      skippedCount: results.filter((r) => r.status === "skipped").length,
      failedCount: results.filter((r) => r.status === "failed").length,
      results,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Action execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function handleDemoAction(params: {
  action: EbayActionRequest["action"];
  listingIds: string[];
  dropPct: number;
  offerPct: number;
  offerMessage?: string;
}) {
  const { action, listingIds, dropPct, offerPct } = params;
  const store = getDemoStore();
  const itemMap = new Map(store.items.map((i) => [i.id, i]));
  const results: EbayActionItemResult[] = [];
  const nowIso = new Date().toISOString();

  for (const listingId of listingIds) {
    const listing = store.listings.find((l) => l.id === listingId);
    if (!listing) continue;
    const item = itemMap.get(listing.item_id);
    if (!item) continue;

    const currentPrice = Number(listing.listed_price);
    const floorPrice = Number(item.floor_price);

    if (action === "update_price") {
      const calc = computeClampedPriceDrop(currentPrice, floorPrice, dropPct);

      if (calc.isAlreadyAtFloor) {
        results.push({
          listingId: listing.id,
          itemId: item.id,
          sku: item.sku,
          title: item.title,
          action,
          status: "skipped",
          previousPrice: currentPrice,
          newPrice: currentPrice,
          floorPrice,
          wasClampedToFloor: true,
          jobId: "skipped-floor",
          message: `Protected at COGS floor ($${floorPrice.toFixed(2)}) — no drop applied`,
        });
        continue;
      }

      applyDemoListingPrice(listing.id, calc.nextPrice);

      const job = recordDemoJob({
        item_id: item.id,
        listing_id: listing.id,
        marketplace: "ebay",
        action: "update_price",
        execution_mode: "api",
        payload: {
          previousPrice: currentPrice,
          newPrice: calc.nextPrice,
          floorPrice,
          dropPct,
          wasClamped: calc.wasClamped,
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
        listingId: listing.id,
        itemId: item.id,
        sku: item.sku,
        title: item.title,
        action,
        status: "completed",
        previousPrice: currentPrice,
        newPrice: calc.nextPrice,
        floorPrice,
        wasClampedToFloor: calc.wasClamped,
        jobId: job.id,
        message: calc.wasClamped
          ? `Dropped $${currentPrice.toFixed(2)} → $${calc.nextPrice.toFixed(2)} (clamped at floor $${floorPrice.toFixed(2)})`
          : `Dropped $${currentPrice.toFixed(2)} → $${calc.nextPrice.toFixed(2)} (-${dropPct}%)`,
      });
    } else if (action === "end_and_sell_similar") {
      const prevExternalId = listing.external_listing_id;
      const updated = applyDemoEndAndSellSimilar(listing.id);

      const job = recordDemoJob({
        item_id: item.id,
        listing_id: listing.id,
        marketplace: "ebay",
        action: "end_and_sell_similar",
        execution_mode: "api",
        payload: {
          previousExternalListingId: prevExternalId,
          newExternalListingId: updated?.external_listing_id,
          listedPrice: currentPrice,
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
        listingId: listing.id,
        itemId: item.id,
        sku: item.sku,
        title: item.title,
        action,
        status: "completed",
        previousPrice: currentPrice,
        newPrice: currentPrice,
        floorPrice,
        wasClampedToFloor: false,
        newExternalListingId: updated?.external_listing_id ?? null,
        jobId: job.id,
        message: `Ended #${prevExternalId} & relisted as #${updated?.external_listing_id} (0d fresh listing)`,
      });
    } else if (action === "send_offer") {
      if (listing.watchers_count <= 0) {
        results.push({
          listingId: listing.id,
          itemId: item.id,
          sku: item.sku,
          title: item.title,
          action,
          status: "skipped",
          previousPrice: currentPrice,
          newPrice: currentPrice,
          floorPrice,
          wasClampedToFloor: false,
          jobId: "skipped-no-watchers",
          message: "Skipped — 0 watchers eligible for offer",
        });
        continue;
      }

      const calc = computeClampedPriceDrop(currentPrice, floorPrice, offerPct);

      const job = recordDemoJob({
        item_id: item.id,
        listing_id: listing.id,
        marketplace: "ebay",
        action: "send_offer",
        execution_mode: "api",
        payload: {
          offerPrice: calc.nextPrice,
          watchersCount: listing.watchers_count,
          wasClamped: calc.wasClamped,
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
        listingId: listing.id,
        itemId: item.id,
        sku: item.sku,
        title: item.title,
        action,
        status: "completed",
        previousPrice: currentPrice,
        newPrice: calc.nextPrice,
        floorPrice,
        wasClampedToFloor: calc.wasClamped,
        jobId: job.id,
        message: `Sent $${calc.nextPrice.toFixed(2)} offer to ${listing.watchers_count} watcher${listing.watchers_count === 1 ? "" : "s"}${calc.wasClamped ? " (floor-clamped)" : ""}`,
      });
    }
  }

  const response: EbayActionResponse = {
    mode: "demo",
    action,
    processedCount: results.length,
    completedCount: results.filter((r) => r.status === "completed").length,
    skippedCount: results.filter((r) => r.status === "skipped").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    results,
  };

  return NextResponse.json(response);
}
