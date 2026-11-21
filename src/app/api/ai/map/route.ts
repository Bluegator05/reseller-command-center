import { NextResponse } from "next/server";
import { getDemoStore } from "@/lib/demo-store";
import { mapItemForMarketplace } from "@/lib/gemini-mapper";
import { getSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
import type {
  InventoryItem,
  MarketplaceAccount,
  MarketplaceType,
} from "@/lib/types";

/**
 * POST /api/ai/map
 * Generates an AI-translated cross-listing payload (title, stripped plain text description,
 * Etsy taxonomy, SEO tags, and fee-adjusted pricing) for an inventory item.
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
  let targetAccount: MarketplaceAccount | undefined;

  if (supabase && isSupabaseConfigured()) {
    const [itemRes, listingRes, acctRes] = await Promise.all([
      supabase.from("inventory_items").select("*").eq("id", itemId).maybeSingle(),
      supabase
        .from("marketplace_listings")
        .select("listed_price")
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
      targetAccount = (acctRes.data as MarketplaceAccount | null) ?? undefined;
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
    return NextResponse.json(draft);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to map listing payload";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
