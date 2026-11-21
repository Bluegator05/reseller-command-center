import { NextResponse, type NextRequest } from "next/server";
import { getEbayBaseUrls } from "@/lib/ebay";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * GET /api/ebay/oauth/callback
 * Exchanges the eBay OAuth authorization code for an 18-month User Refresh Token
 * and displays it cleanly for 1-click copy into Vercel `EBAY_REFRESH_TOKEN`.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const oauthError = url.searchParams.get("error")?.trim();
  const oauthErrorDesc = url.searchParams.get("error_description")?.trim();

  if (oauthError) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:48px auto;padding:20px;">
        <h2>eBay OAuth Declined</h2>
        <p>${escapeHtml(oauthError)}: ${escapeHtml(oauthErrorDesc || "Authorization was canceled.")}</p>
        <p><a href="/api/ebay/oauth">Try Again</a> · <a href="/">Back to Command Center</a></p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const expectedState = request.cookies.get("rcc_ebay_oauth_state")?.value;
  const runame =
    request.cookies.get("rcc_ebay_runame")?.value ||
    process.env.EBAY_RUNAME?.trim() ||
    "";

  if (!code || !runame || (expectedState && state !== expectedState)) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:48px auto;padding:20px;">
        <h2>Invalid or Expired eBay OAuth Session</h2>
        <p>Please restart the connection flow from <a href="/api/ebay/oauth">/api/ebay/oauth</a>.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:600px;margin:48px auto;padding:20px;">
        <h2>Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in Vercel</h2>
        <p>Add both variables in Vercel Settings → Environment Variables, redeploy, and try again.</p>
      </body></html>`,
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const { apiBase, env } = getEbayBaseUrls();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const tokenRes = await fetch(`${apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: runame,
    }).toString(),
    cache: "no-store",
  });

  const rawText = await tokenRes.text();
  if (!tokenRes.ok) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:20px;">
        <h2 style="color:#B91C1C;">eBay Token Exchange Failed (HTTP ${tokenRes.status})</h2>
        <pre style="background:#FEF2F2;border:1px solid #FECACA;padding:12px;border-radius:10px;white-space:pre-wrap;font-size:12px;">${escapeHtml(rawText)}</pre>
        <p><a href="/api/ebay/oauth">← Try Again</a></p>
      </body></html>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  let parsed: {
    refresh_token?: string;
    refresh_token_expires_in?: number;
    access_token?: string;
  };
  try {
    parsed = JSON.parse(rawText) as typeof parsed;
  } catch {
    return new NextResponse("Invalid JSON from eBay token endpoint", {
      status: 502,
    });
  }

  const refreshToken = parsed.refresh_token || "";
  const validDays = parsed.refresh_token_expires_in
    ? Math.round(parsed.refresh_token_expires_in / 86400)
    : 547;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>eBay Connected — Copy Refresh Token</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#F7F9F8; color:#14151A; margin:0; padding:32px 16px; }
    .card { max-width:660px; margin:0 auto; background:#fff; border:1px solid #A7F3D0; border-radius:16px; padding:28px; box-shadow:0 2px 12px rgba(0,0,0,0.04); }
    .badge { display:inline-block; background:#ECFDF5; color:#0F766E; border:1px solid #A7F3D0; padding:4px 10px; border-radius:999px; font-size:12px; font-weight:700; margin-bottom:10px; }
    h1 { font-size:20px; margin:0 0 8px; }
    p, li { font-size:14px; color:#5C606B; line-height:1.55; }
    textarea { width:100%; box-sizing:border-box; min-height:110px; padding:12px; font-family:ui-monospace,monospace; font-size:12px; border:1px solid #CBD5E1; border-radius:10px; background:#FAFBF9; color:#14151A; }
    button { margin-top:12px; background:#0F766E; color:#fff; border:none; border-radius:10px; padding:11px 18px; font-size:14px; font-weight:600; cursor:pointer; }
    button:hover { background:#0B5B55; }
    code { background:#F2F6F4; color:#0F766E; padding:2px 6px; border-radius:6px; font-size:12.5px; }
    a { color:#0F766E; text-decoration:none; font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">✓ eBay ${escapeHtml(env)} OAuth Approved (~${validDays} days)</span>
    <h1>Copy Your EBAY_REFRESH_TOKEN</h1>
    <p>This token is dedicated to Reseller Command Center and does not touch your other eBay apps.</p>
    <textarea id="tok" readonly>${escapeHtml(refreshToken)}</textarea>
    <div>
      <button id="copyBtn" type="button" onclick="navigator.clipboard.writeText(document.getElementById('tok').value).then(()=>{document.getElementById('copyBtn').textContent='✓ Copied to Clipboard!';})">Copy EBAY_REFRESH_TOKEN</button>
    </div>
    <ol style="margin-top:18px;padding-left:18px;">
      <li>Open <strong>Vercel → reseller-command-center → Settings → Environment Variables</strong>.</li>
      <li>Add <code>EBAY_REFRESH_TOKEN</code> and paste the copied token (check <strong>Production</strong>).</li>
      <li>Go to <strong>Deployments → ⋯ → Redeploy</strong> (~45s).</li>
      <li>Open your Command Center and click <strong>Sync eBay</strong> to pull in all your live listings!</li>
    </ol>
    <p style="margin-top:16px;margin-bottom:0;"><a href="/">← Back to Reseller Command Center</a></p>
  </div>
</body>
</html>`;

  const res = new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  res.cookies.delete("rcc_ebay_oauth_state");
  res.cookies.delete("rcc_ebay_runame");
  return res;
}
