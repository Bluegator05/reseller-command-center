-- Reseller Command Center — PostgreSQL Schema (Supabase)
-- Run this script in the Supabase SQL Editor.

-- 1. ENUMS
CREATE TYPE marketplace_type AS ENUM ('ebay', 'etsy', 'poshmark', 'mercari', 'facebook');
CREATE TYPE master_item_status AS ENUM ('draft', 'active', 'sold', 'archived');
CREATE TYPE listing_status AS ENUM ('draft', 'active', 'ended', 'sold', 'error');
CREATE TYPE job_action_type AS ENUM ('create', 'update_price', 'delist', 'end_and_sell_similar', 'send_offer', 'promote_listing');
CREATE TYPE job_status_type AS ENUM ('pending', 'processing', 'needs_user_confirm', 'completed', 'failed');

-- 2. MASTER INVENTORY
CREATE TABLE inventory_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku               TEXT UNIQUE NOT NULL,
  title             TEXT NOT NULL,
  description_html  TEXT,
  description_plain TEXT,
  condition         TEXT NOT NULL,
  brand             TEXT,
  category_hint     TEXT,
  cogs              NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  prep_cost         NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  target_price      NUMERIC(10, 2) NOT NULL,
  floor_price       NUMERIC(10, 2) NOT NULL,
  bin_location      TEXT,
  source_location   TEXT,
  source_type       TEXT DEFAULT 'thrift',
  payment_method    TEXT,
  receipt_ref       TEXT,
  tax_category      TEXT NOT NULL DEFAULT 'inventory_cogs',
  notes             TEXT,
  weight_oz         NUMERIC(8, 2),
  length_in         NUMERIC(6, 2),
  width_in          NUMERIC(6, 2),
  height_in         NUMERIC(6, 2),
  item_specifics    JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_urls        TEXT[] NOT NULL DEFAULT '{}',
  status            master_item_status NOT NULL DEFAULT 'draft',
  acquired_at       TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inventory_status ON inventory_items(status);
CREATE INDEX idx_inventory_sku ON inventory_items(sku);

-- 3. MARKETPLACE ACCOUNTS & FEE PROFILES
CREATE TABLE marketplace_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace       marketplace_type UNIQUE NOT NULL,
  is_api_connected  BOOLEAN NOT NULL DEFAULT false,
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  token_expires_at  TIMESTAMPTZ,
  default_fee_pct   NUMERIC(5, 2) NOT NULL,
  price_markup_pct  NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. MARKETPLACE LISTINGS
CREATE TABLE marketplace_listings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  marketplace         marketplace_type NOT NULL,
  external_listing_id TEXT,
  external_url        TEXT,
  listed_price        NUMERIC(10, 2) NOT NULL,
  shipping_price      NUMERIC(10, 2) DEFAULT 0.00,
  status              listing_status NOT NULL DEFAULT 'draft',
  views_count         INTEGER NOT NULL DEFAULT 0,
  watchers_count      INTEGER NOT NULL DEFAULT 0,
  impressions_count   INTEGER NOT NULL DEFAULT 0,
  promoted_ad_rate_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  listed_at           TIMESTAMPTZ,
  last_refreshed_at   TIMESTAMPTZ,
  last_price_drop_at  TIMESTAMPTZ,
  last_synced_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (item_id, marketplace)
);

CREATE INDEX idx_listings_stale_scan
  ON marketplace_listings(marketplace, status, listed_at, views_count, watchers_count);

-- 5. CROSS-LIST & ACTION JOB QUEUE
CREATE TABLE channel_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  listing_id          UUID REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  marketplace         marketplace_type NOT NULL,
  action              job_action_type NOT NULL,
  execution_mode      TEXT NOT NULL CHECK (execution_mode IN ('api', 'extension')),
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              job_status_type NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_jobs_extension_queue
  ON channel_jobs(execution_mode, status, created_at)
  WHERE status IN ('pending', 'needs_user_confirm');

-- 6. STALE-ITEM RULES
CREATE TABLE stale_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  marketplace           marketplace_type NOT NULL DEFAULT 'ebay',
  min_days_listed       INTEGER NOT NULL,
  max_views             INTEGER,
  max_watchers          INTEGER,
  recommended_action    job_action_type NOT NULL,
  price_drop_pct        NUMERIC(5, 2),
  auto_execute          BOOLEAN NOT NULL DEFAULT false,
  is_active             BOOLEAN NOT NULL DEFAULT true
);

-- 7. SALES LEDGER (with Pick-List Fulfillment & Returns/Refunds)
CREATE TABLE sales_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES inventory_items(id),
  marketplace         marketplace_type NOT NULL,
  external_order_id   TEXT,
  gross_sale_price    NUMERIC(10, 2) NOT NULL,
  marketplace_fees    NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  shipping_cost       NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  refund_amount       NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  net_profit          NUMERIC(10, 2) GENERATED ALWAYS AS (
                        gross_sale_price - marketplace_fees - shipping_cost - refund_amount
                      ) STORED,
  fulfillment_status  TEXT NOT NULL DEFAULT 'to_ship' CHECK (
                        fulfillment_status IN ('to_ship', 'picked', 'shipped', 'returned', 'partial_refund', 'unpaid')
                      ),
  tracking_number     TEXT,
  shipped_at          TIMESTAMPTZ,
  return_reason       TEXT,
  restocked           BOOLEAN NOT NULL DEFAULT false,
  sold_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. SCHEDULE C BUSINESS EXPENSES & SOURCING MILEAGE
CREATE TABLE business_expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  category        TEXT NOT NULL CHECK (
                    category IN ('supplies', 'shipping_materials', 'mileage', 'storage', 'software', 'equipment', 'other')
                  ),
  description     TEXT NOT NULL,
  vendor          TEXT,
  miles           NUMERIC(8, 2),
  mileage_rate    NUMERIC(5, 3) DEFAULT 0.700,
  amount          NUMERIC(10, 2) NOT NULL,
  payment_method  TEXT,
  receipt_ref     TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_date ON business_expenses(expense_date DESC);
