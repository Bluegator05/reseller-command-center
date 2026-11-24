import { NextResponse } from "next/server";
import { hasEbayAppCredentials, suggestEbayCategories } from "@/lib/ebay";

/**
 * GET /api/ebay/categories?q=...
 * Queries eBay Commerce Taxonomy API (via app-only client_credentials OAuth)
 * so Listing Studio users can search & pick leaf eBay categories on demand.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  const configured = hasEbayAppCredentials();

  if (!q) {
    return NextResponse.json({
      query: "",
      categories: [],
      configured,
    });
  }

  const categories = await suggestEbayCategories(q);
  return NextResponse.json({
    query: q,
    categories,
    configured,
  });
}
