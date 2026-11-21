import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { EBAY_OAUTH_SCOPES, getEbayBaseUrls } from "@/lib/ebay";

const EBAY_AUTH_BASE = {
  PRODUCTION: "https://auth.ebay.com/oauth2/authorize",
  SANDBOX: "https://auth.sandbox.ebay.com/oauth2/authorize",
} as const;

/**
 * GET /api/ebay/oauth
 * Interactive 1-click eBay OAuth launcher (protected behind Owner Lock).
 * - If `?runame=...` (or `EBAY_RUNAME` env var) is provided, redirects straight
 *   to eBay's official OAuth consent page to mint an 18-month Refresh Token.
 * - Otherwise renders a simple form to paste your eBay RuName from Developer Portal.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const { env } = getEbayBaseUrls();
  const runame = (
    url.searchParams.get("runame") ||
    process.env.EBAY_RUNAME ||
    ""
  ).trim();

  const callbackUrl = `${url.origin}/api/ebay/oauth/callback`;

  if (!clientId) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:48px auto;padding:20px;color:#14151A;">
        <h2 style="margin-top:0;">Missing EBAY_CLIENT_ID in Vercel</h2>
        <p>Add <code>EBAY_CLIENT_ID</code> and <code>EBAY_CLIENT_SECRET</code> in Vercel Environment Variables and redeploy first.</p>
        <p><a href="/">← Back to Command Center</a></p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  if (!runame) {
    return new NextResponse(
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Connect eBay OAuth — Reseller Command Center</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#F7F9F8; color:#14151A; margin:0; padding:32px 16px; }
    .card { max-width:620px; margin:0 auto; background:#fff; border:1px solid #E4E4DD; border-radius:16px; padding:28px; box-shadow:0 2px 10px rgba(0,0,0,0.04); }
    h1 { font-size:20px; margin:0 0 8px; }
    p, li { font-size:14px; color:#5C606B; line-height:1.55; }
    code { background:#F2F6F4; color:#0F766E; padding:2px 6px; border-radius:6px; font-size:12.5px; word-break:break-all; }
    .box { background:#FAFBF9; border:1px solid #E4E4DD; border-radius:12px; padding:14px 16px; margin:16px 0; }
    label { display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:#14151A; }
    input { width:100%; box-sizing:border-box; padding:10px 12px; font-size:14px; font-family:ui-monospace,monospace; border:1px solid #CBD5E1; border-radius:10px; }
    button { margin-top:14px; background:#0F766E; color:#fff; border:none; border-radius:10px; padding:11px 18px; font-size:14px; font-weight:600; cursor:pointer; width:100%; }
    button:hover { background:#0B5B55; }
    a { color:#0F766E; text-decoration:none; font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect eBay (${env}) — Get 18-Month Refresh Token</h1>
    <p>This creates a dedicated OAuth token for Reseller Command Center without touching any of your other apps.</p>
    <div class="box">
      <ol style="margin:0;padding-left:18px;">
        <li>In eBay Developer Portal → <strong>Production → User Tokens</strong>, click <strong>+ Add eBay Redirect URL</strong>.</li>
        <li>Set <strong>Your auth accepted URL</strong> to:<br/><code>${callbackUrl}</code></li>
        <li>Set <strong>Your auth declined URL</strong> to:<br/><code>${url.origin}/</code></li>
        <li>Check <strong>OAuth Enabled</strong>, click <strong>Save</strong>, and copy the generated <strong>RuName</strong> below.</li>
      </ol>
    </div>
    <form method="GET" action="/api/ebay/oauth">
      <label for="runame">Paste your new eBay RuName</label>
      <input id="runame" name="runame" type="text" required placeholder="Chris_Ballard-ChrisBal-E-PRD-..." autocomplete="off" />
      <button type="submit">Sign In with eBay &amp; Generate Refresh Token →</button>
    </form>
    <p style="margin-top:16px;margin-bottom:0;"><a href="/">← Back to Reseller Command Center</a></p>
  </div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = new URL(
    env === "SANDBOX" ? EBAY_AUTH_BASE.SANDBOX : EBAY_AUTH_BASE.PRODUCTION
  );
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", runame);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", EBAY_OAUTH_SCOPES);
  authUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authUrl.toString());
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  };
  res.cookies.set("rcc_ebay_oauth_state", state, cookieOpts);
  res.cookies.set("rcc_ebay_runame", runame, cookieOpts);
  return res;
}
