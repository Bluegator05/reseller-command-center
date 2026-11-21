-- Optional default fee profiles and stale-item rules for Supabase.
-- Run after supabase/schema.sql in Supabase SQL Editor.

INSERT INTO marketplace_accounts (marketplace, is_api_connected, default_fee_pct, price_markup_pct)
VALUES
  ('ebay', true, 13.25, 0.00),
  ('etsy', false, 9.50, 5.00),
  ('poshmark', false, 20.00, 12.00),
  ('mercari', false, 10.00, 5.00),
  ('facebook', false, 5.00, 0.00)
ON CONFLICT (marketplace) DO NOTHING;

INSERT INTO stale_rules (name, marketplace, min_days_listed, max_views, max_watchers, recommended_action, price_drop_pct, auto_execute, is_active)
VALUES
  ('30+ Days Listed — Auto-Promote to 4% Ad Rate', 'ebay', 30, NULL, NULL, 'promote_listing', 4.00, true, true),
  ('45+ Days Aging Inventory — 10% Price Drop', 'ebay', 45, NULL, NULL, 'update_price', 10.00, false, true),
  ('Dead Engagement (60d+, <25 views) — End & Sell Similar', 'ebay', 60, 25, 1, 'end_and_sell_similar', NULL, false, true),
  ('Watched Stale Listings (30d+, >=3 watchers) — Send Offer', 'ebay', 30, NULL, NULL, 'send_offer', 10.00, false, true);
