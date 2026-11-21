import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { processSaleAndCascadeDelist } from "@/lib/auto-delist";

/**
 * GET /api/webhooks/ebay
 * Handles eBay Notification API endpoint verification challenge (`challenge_code`).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const challengeCode = searchParams.get("challenge_code");

  if (!challengeCode) {
    return NextResponse.json({ status: "ok", endpoint: "ebay-webhook" });
  }

  const verificationToken =
    process.env.EBAY_WEBHOOK_SECRET?.trim() || "reseller-command-center-token";
  const endpointUrl = request.url.split("?")[0];

  const hash = crypto
    .createHash("sha256")
    .update(challengeCode)
    .update(verificationToken)
    .update(endpointUrl)
    .digest("hex");

  return NextResponse.json({ challengeResponse: hash });
}

interface EbayWebhookPayload {
  // Standard eBay Notification API envelope OR simplified test payload
  metadata?: { topic?: string };
  notification?: {
    data?: {
      orderId?: string;
      lineItems?: Array<{
        sku?: string;
        legacyItemId?: string;
        total?: { value?: string };
      }>;
      pricingSummary?: {
        total?: { value?: string };
        deliveryCost?: { value?: string };
      };
    };
  };
  itemId?: string;
  sku?: string;
  externalListingId?: string;
  externalOrderId?: string;
  grossSalePrice?: number;
  shippingCost?: number;
}

/**
 * POST /api/webhooks/ebay
 * Receives eBay order/sale webhooks, marks item sold in Supabase,
 * records sales_orders, and cascades delist jobs across Etsy, Poshmark, Mercari, and FB.
 */
export async function POST(request: Request) {
  const configuredSecret = process.env.EBAY_WEBHOOK_SECRET?.trim();
  if (configuredSecret) {
    const provided = request.headers.get("x-webhook-secret");
    if (provided && provided !== configuredSecret) {
      return NextResponse.json(
        { error: "Invalid webhook secret" },
        { status: 401 }
      );
    }
  }

  let body: EbayWebhookPayload;
  try {
    body = (await request.json()) as EbayWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const orderData = body.notification?.data;
  const firstLine = orderData?.lineItems?.[0];

  const sku = body.sku || firstLine?.sku;
  const externalListingId = body.externalListingId || firstLine?.legacyItemId;
  const externalOrderId = body.externalOrderId || orderData?.orderId;
  const grossSalePrice =
    body.grossSalePrice ??
    (firstLine?.total?.value
      ? Number(firstLine.total.value)
      : orderData?.pricingSummary?.total?.value
        ? Number(orderData.pricingSummary.total.value)
        : null);
  const shippingCost =
    body.shippingCost ??
    (orderData?.pricingSummary?.deliveryCost?.value
      ? Number(orderData.pricingSummary.deliveryCost.value)
      : 0);

  if (!body.itemId && !sku && !externalListingId) {
    return NextResponse.json(
      { error: "Webhook payload missing itemId, sku, or externalListingId" },
      { status: 400 }
    );
  }

  try {
    const result = await processSaleAndCascadeDelist({
      itemId: body.itemId,
      sku,
      externalListingId,
      marketplace: "ebay",
      externalOrderId,
      grossSalePrice,
      shippingCost,
      source: "webhook",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to process eBay sale";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
