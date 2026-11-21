import { NextResponse } from "next/server";
import {
  createDemoInventoryItem,
  deleteDemoInventoryItem,
  promoteDemoDraftToActive,
  updateDemoInventoryItem,
} from "@/lib/demo-store";
import { loadCommandCenterData } from "@/lib/inventory-loader";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type { ItemDetailUpdateRequest, QuickAddItemRequest } from "@/lib/types";

export async function GET() {
  try {
    const payload = await loadCommandCenterData();
    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load inventory";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as
      | (QuickAddItemRequest & { action?: "create" })
      | { action: "promote_draft"; itemId: string };

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (body.action === "promote_draft") {
      if (!body.itemId) {
        return NextResponse.json({ error: "Missing itemId" }, { status: 400 });
      }
      if (supabase && envReadiness.isSupabaseReady) {
        const nowIso = new Date().toISOString();
        const { data: item, error } = await supabase
          .from("inventory_items")
          .update({ status: "active", updated_at: nowIso })
          .eq("id", body.itemId)
          .select("*")
          .single();
        if (error || !item) {
          return NextResponse.json(
            { error: error?.message || "Draft item not found" },
            { status: 400 }
          );
        }
        await supabase.from("marketplace_listings").upsert(
          {
            item_id: item.id,
            marketplace: "ebay",
            listed_price: item.target_price,
            shipping_price: 8.95,
            status: "active",
            listed_at: nowIso,
            last_synced_at: nowIso,
          },
          { onConflict: "item_id,marketplace" }
        );
        return NextResponse.json({ mode: "live", item });
      }

      const promoted = promoteDemoDraftToActive(body.itemId);
      if (!promoted) {
        return NextResponse.json(
          { error: "Draft item not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({ mode: "demo", item: promoted });
    }

    const req = body as QuickAddItemRequest;
    if (!req?.title?.trim()) {
      return NextResponse.json(
        { error: "Item title is required" },
        { status: 400 }
      );
    }

    if (supabase && envReadiness.isSupabaseReady) {
      const nowIso = new Date().toISOString();
      const sku =
        req.sku?.trim() ||
        `SKU-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const { data: created, error } = await supabase
        .from("inventory_items")
        .insert({
          sku,
          title: req.title.trim(),
          condition: req.condition?.trim() || "Pre-owned — Very Good",
          brand: req.brand?.trim() || null,
          category_hint: req.category_hint?.trim() || null,
          cogs: Number(req.cogs) || 0,
          prep_cost: Number(req.prep_cost) || 0,
          target_price: Number(req.target_price) || 0,
          floor_price: Number(req.floor_price) || 0,
          bin_location: req.bin_location?.trim() || null,
          source_location: req.source_location?.trim() || null,
          source_type: req.source_type || "thrift",
          payment_method: req.payment_method || "Business Amex",
          receipt_ref: req.receipt_ref?.trim() || null,
          tax_category: req.tax_category || "inventory_cogs",
          notes: req.notes?.trim() || null,
          weight_oz: req.weight_oz ?? null,
          length_in: req.length_in ?? null,
          width_in: req.width_in ?? null,
          height_in: req.height_in ?? null,
          status: req.initialStatus,
          acquired_at: req.acquired_at || nowIso,
        })
        .select("*")
        .single();

      if (error || !created) {
        return NextResponse.json(
          { error: error?.message || "Failed to create item" },
          { status: 400 }
        );
      }

      if (req.initialStatus === "active") {
        await supabase.from("marketplace_listings").insert({
          item_id: created.id,
          marketplace: "ebay",
          listed_price: created.target_price,
          shipping_price: 8.95,
          status: "active",
          listed_at: nowIso,
          last_synced_at: nowIso,
        });
      }
      return NextResponse.json({ mode: "live", item: created }, { status: 201 });
    }

    const item = createDemoInventoryItem(req);
    return NextResponse.json({ mode: "demo", item }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create inventory item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as ItemDetailUpdateRequest;
    if (!body?.itemId) {
      return NextResponse.json(
        { error: "Missing required itemId" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (supabase && envReadiness.isSupabaseReady) {
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      const allowedFields: Array<keyof ItemDetailUpdateRequest> = [
        "sku",
        "title",
        "condition",
        "brand",
        "category_hint",
        "cogs",
        "prep_cost",
        "target_price",
        "floor_price",
        "bin_location",
        "source_location",
        "source_type",
        "payment_method",
        "receipt_ref",
        "tax_category",
        "notes",
        "acquired_at",
        "weight_oz",
        "length_in",
        "width_in",
        "height_in",
      ];
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
        }
      }

      const { data, error } = await supabase
        .from("inventory_items")
        .update(updates)
        .eq("id", body.itemId)
        .select("*")
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", item: data });
    }

    const updated = updateDemoInventoryItem(body);
    if (!updated) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ mode: "demo", item: updated });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update inventory item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json(
        { error: "Missing required id query parameter" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (supabase && envReadiness.isSupabaseReady) {
      const { error } = await supabase
        .from("inventory_items")
        .delete()
        .eq("id", id);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", deletedId: id });
    }

    const removed = deleteDemoInventoryItem(id);
    if (!removed) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json({ mode: "demo", deletedId: id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete inventory item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
