import { NextResponse } from "next/server";
import { fetchEligibleOfferListingIds, isEbayConfigured } from "@/lib/ebay";

export const maxDuration = 30;

/**
 * GET /api/ebay/eligible-offers
 * Returns the exact live set of eBay listing IDs currently eligible for
 * seller-initiated offers (excluding items that already have active offers).
 */
export async function GET() {
  if (!isEbayConfigured()) {
    return NextResponse.json({
      mode: "demo",
      listingIds: null,
    });
  }

  try {
    const listingIds = await fetchEligibleOfferListingIds(1000);
    return NextResponse.json({
      mode: "live",
      count: listingIds.length,
      listingIds,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not check eBay eligible offers";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
