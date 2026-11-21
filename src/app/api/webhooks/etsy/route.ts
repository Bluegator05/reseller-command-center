import { NextResponse } from "next/server";
import { processSaleAndCascadeDelist } from "@/lib/auto-delist";

interface EtsyWebhookPayload {
  // Etsy receipt/order webhook format OR simplified test payload
  receipt_id?: number | string;
  transactions?: Array<{
    listing_id?: number | string;
    sku?: string;
    price?: { amount: number; divisor: number };
  }>;
  itemId?: string;
  sku?: string;
  externalListingId?: string;
  externalOrderId?: string;
  grossSalePrice?: number;
  shippingCost?: number;
}

/**
 * POST /api/webhooks/etsy
 * Receives Etsy sale notifications, marks item sold, logs sales_orders,
 * withdraws eBay listing via API, and queues extension delists for Poshmark/Mercari/FB.
 */
export async function POST(request: Request) {
  const configuredSecret = process.env.ETSY_WEBHOOK_SECRET?.trim();
  if (configuredSecret) {
    const provided = request.headers.get("x-webhook-secret");
    if (provided && provided !== configuredSecret) {
      return NextResponse.json(
        { error: "Invalid Etsy webhook secret" },
        { status: 401 }
      );
    }
  }

  let body: EtsyWebhookPayload;
  try {
    body = (await request.json()) as EtsyWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const firstTx = body.transactions?.[0];
  const sku = body.sku || firstTx?.sku;
  const externalListingId =
    body.externalListingId ||
    (firstTx?.listing_id ? String(firstTx.listing_id) : undefined);
  const externalOrderId =
    body.externalOrderId ||
    (body.receipt_id ? `ETSY-${body.receipt_id}` : undefined);
  const grossSalePrice =
    body.grossSalePrice ??
    (firstTx?.price
      ? firstTx.price.amount / Math.max(1, firstTx.price.divisor)
      : null);

  if (!body.itemId && !sku && !externalListingId) {
    return NextResponse.json(
      { error: "Etsy webhook missing itemId, sku, or externalListingId" },
      { status: 400 }
    );
  }

  try {
    const result = await processSaleAndCascadeDelist({
      itemId: body.itemId,
      sku,
      externalListingId,
      marketplace: "etsy",
      externalOrderId,
      grossSalePrice,
      shippingCost: body.shippingCost ?? 0,
      source: "webhook",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to process Etsy sale";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
