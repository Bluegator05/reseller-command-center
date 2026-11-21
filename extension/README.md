# Reseller Command Center — Chrome / Arc Companion Extension (Phase 3)

Manifest V3 companion extension that subscribes/polls `channel_jobs` where `execution_mode = 'extension'` and auto-fills listings on **Poshmark**, **Mercari**, and **Facebook Marketplace** with CORS-safe CDN photo `Blob` injection.

## Quick Install (Chrome or Arc)
1. Open `chrome://extensions` (or `arc://extensions`).
2. Toggle **Developer mode** ON (top right).
3. Click **Load unpacked** and select this `extension/` directory.
4. Click the extension icon in your toolbar → open **Connection Settings** → choose either:
   - **Command Center API** (`http://localhost:3000` or your deployed Vercel URL), or
   - **Direct Supabase PostgREST** (`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

## Safety Gate (Facebook Marketplace)
Facebook Marketplace jobs automatically pause in **`needs_user_confirm`** after filling title, price, description, and uploading images. Review category/condition, click Facebook's **Publish** button manually, and click **I Clicked Publish — Mark Complete** in the on-page HUD or extension popup to record the active listing in `marketplace_listings`.
