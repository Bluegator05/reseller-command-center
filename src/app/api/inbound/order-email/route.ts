import { NextResponse } from "next/server";
import {
  getActiveInventoryForMatching,
  processSaleAndCascadeDelist,
} from "@/lib/auto-delist";
import {
  matchParsedEmailToItem,
  parseInboundOrderEmail,
} from "@/lib/email-order-parser";

interface InboundEmailRequest {
  from?: string;
  From?: string;
  subject?: string;
  Subject?: string;
  text?: string;
  TextBody?: string;
  html?: string;
  HtmlBody?: string;
  dryRun?: boolean;
}

/**
 * POST /api/inbound/order-email
 * Inbound webhook for forwarded Poshmark, Mercari, and Facebook Marketplace order emails
 * (compatible with Postmark, SendGrid Inbound Parse, Mailgun, Cloudflare Email Workers, and UI tester).
 */
export async function POST(request: Request) {
  const configuredSecret = process.env.INBOUND_EMAIL_SECRET?.trim();
  if (configuredSecret) {
    const provided = request.headers.get("x-inbound-secret");
    if (provided && provided !== configuredSecret) {
      return NextResponse.json(
        { error: "Invalid inbound email secret" },
        { status: 401 }
      );
    }
  }

  let body: InboundEmailRequest;
  try {
    body = (await request.json()) as InboundEmailRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = parseInboundOrderEmail({
    from: body.from || body.From || "",
    subject: body.subject || body.Subject || "",
    text: body.text || body.TextBody || "",
    html: body.html || body.HtmlBody || "",
  });

  const activeItems = await getActiveInventoryForMatching();
  const matchedItem = matchParsedEmailToItem(parsed, activeItems);

  if (body.dryRun) {
    return NextResponse.json({
      dryRun: true,
      parsed,
      matchedItem: matchedItem
        ? {
            id: matchedItem.id,
            sku: matchedItem.sku,
            title: matchedItem.title,
            cogs: matchedItem.cogs,
          }
        : null,
    });
  }

  if (!matchedItem) {
    return NextResponse.json(
      {
        error:
          "Parsed order email, but could not match it to any active inventory SKU or title.",
        parsed,
      },
      { status: 422 }
    );
  }

  try {
    const cascade = await processSaleAndCascadeDelist({
      itemId: matchedItem.id,
      sku: matchedItem.sku,
      marketplace: parsed.marketplace,
      externalOrderId: parsed.orderId,
      grossSalePrice: parsed.grossSalePrice,
      shippingCost: parsed.shippingCost,
      source: "inbound_email",
    });

    return NextResponse.json({
      parsed,
      ...cascade,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to process inbound email order";
    return NextResponse.json({ error: message, parsed }, { status: 500 });
  }
}
