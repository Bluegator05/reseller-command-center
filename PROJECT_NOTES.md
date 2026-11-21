# Reseller Command Center — Project Notes & Live Production Context

## Live Deployment
- **GitHub Repo:** `https://github.com/Bluegator05/reseller-command-center` (`main` branch)
- **Production URL:** `https://reseller-command-center-black.vercel.app` (Vercel auto-deploys from `main`)
- **Devices:** iMac, MacBook Air, Mac Mini (Chrome/Arc extension host), iPhone (Safari Home Screen PWA)

## Connected Production Services
1. **Owner Passcode Lock:** Enabled via `COMMAND_CENTER_PASSCODE` in Vercel (`src/proxy.ts` + signed HttpOnly cookie).
2. **Gemini AI (`GEMINI_API_KEY`):**
   - Sourcing Photo Vision (`/api/ai/comp-image`): `gemini-4-hydrogen` (`thinkingLevel: "LOW"`, auto-fallback → `gemini-3.8-flash` → `gemini-3.5-flash-lite`)
   - Cross-List Field Mapper (`/api/ai/map`): `gemini-3.5-flash-lite` (`thinkingLevel: "MINIMAL"`, auto-fallback → `gemini-4-hydrogen`)
3. **Supabase PostgreSQL:** Live with Row Level Security (RLS) enabled on all tables; server routes authenticate via `SUPABASE_SERVICE_ROLE_KEY`.
4. **eBay Production API:** Connected via dedicated OAuth `RuName` + 18-month `EBAY_REFRESH_TOKEN` sharing the owner's existing Production keyset safely (**never rotate Cert ID or edit other apps' Redirect URLs / Notifications**). Supports up to 2,000 active Seller Hub + Inventory API listings with real Watchers, Views, Days Listed, Send Offer to Watchers (`allowCounterOffer: false`), Price Drops, and End & Sell Similar.

## Permanent Owner Preferences
- **Shipping:** Strictly **NO USPS Priority Mail** anywhere — only USPS Ground Advantage (standard + cubic), USPS Media Mail (opt-in toggle), UPS Ground/Saver, and FedEx Home/Ground (`DIM = ceil(L*W*H/166)`).
- **UI/Theme:** Daylight light mode + left-side icon navigation rail only (no duplicate top tab bar).

## Remaining Integrations (Step 5)
- Connect Etsy Open API v3 (`ETSY_API_KEY`, `ETSY_SHOP_ID`, OAuth token) for 1-click AI cross-listing from eBay → Etsy.
- Load and configure `chrome-extension/` on the Mac Mini for Poshmark, Mercari, and Facebook Marketplace cross-listing and auto-delist.
