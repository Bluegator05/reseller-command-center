import { NextResponse } from "next/server";
import { updateDemoSalesOrder } from "@/lib/demo-store";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type { SalesOrderUpdateRequest } from "@/lib/types";

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as SalesOrderUpdateRequest;
    if (!body?.orderId) {
      return NextResponse.json(
        { error: "Missing required orderId" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();

    if (supabase && envReadiness.isSupabaseReady) {
      const updates: Record<string, unknown> = {};
      if (body.fulfillment_status) {
        updates.fulfillment_status = body.fulfillment_status;
        if (body.fulfillment_status === "shipped") {
          updates.shipped_at = new Date().toISOString();
        }
      }
      if (body.tracking_number !== undefined) {
        updates.tracking_number = body.tracking_number;
      }
      if (body.refund_amount !== undefined) {
        updates.refund_amount = body.refund_amount;
      }
      if (body.return_reason !== undefined) {
        updates.return_reason = body.return_reason;
      }
      if (body.restockAndRelist) {
        updates.restocked = true;
      }

      const { data: order, error } = await supabase
        .from("sales_orders")
        .update(updates)
        .eq("id", body.orderId)
        .select("*")
        .single();

      if (error || !order) {
        return NextResponse.json(
          { error: error?.message || "Order not found" },
          { status: 400 }
        );
      }

      if (body.restockAndRelist && order.item_id) {
        const nowIso = new Date().toISOString();
        await supabase
          .from("inventory_items")
          .update({ status: "active", updated_at: nowIso })
          .eq("id", order.item_id);
        await supabase
          .from("marketplace_listings")
          .update({
            status: "active",
            listed_at: nowIso,
            views_count: 0,
            watchers_count: 0,
          })
          .eq("item_id", order.item_id)
          .eq("marketplace", "ebay");
      }

      return NextResponse.json({
        mode: "live",
        order,
        restocked: Boolean(body.restockAndRelist),
      });
    }

    const result = updateDemoSalesOrder(body);
    if (!result) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    return NextResponse.json({ mode: "demo", ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update sales order",
      },
      { status: 500 }
    );
  }
}
