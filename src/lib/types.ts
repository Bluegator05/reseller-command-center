export type MarketplaceType =
  | "ebay"
  | "etsy"
  | "poshmark"
  | "mercari"
  | "facebook";

export type MasterItemStatus = "draft" | "active" | "sold" | "archived";

export type ListingStatus = "draft" | "active" | "ended" | "sold" | "error";

export type JobActionType =
  | "create"
  | "update_price"
  | "delist"
  | "end_and_sell_similar"
  | "send_offer"
  | "promote_listing";

export type JobStatusType =
  | "pending"
  | "processing"
  | "needs_user_confirm"
  | "completed"
  | "failed";

export type SourcingChannelType =
  | "storage_auction"
  | "pallet_liquidation"
  | "thrift"
  | "bins"
  | "estate_sale"
  | "garage_sale"
  | "retail_arbitrage"
  | "online_arbitrage"
  | "wholesale"
  | "consignment"
  | "personal";

export type DisposalStatus = "donated" | "discarded";

export interface ItemActivityEvent {
  id: string;
  type:
    | "acquired"
    | "listed"
    | "relisted"
    | "price_changed"
    | "promoted"
    | "bulk_buy_added"
    | "bulk_buy_cost_locked"
    | "sold"
    | "shipped"
    | "returned"
    | "donated"
    | "discarded"
    | "restored"
    | "audit_verified"
    | "note";
  timestamp: string;
  title: string;
  detail?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface BulkBuyRecord {
  id: string;
  name: string;
  lot_code?: string | null;
  purchase_date: string;
  source_location: string;
  source_type: SourcingChannelType | string;
  storage_location?: string | null;
  total_spent: number;
  split_mode: "even" | "by_unit";
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DisposedInventoryRecord {
  id: string;
  sku: string;
  title: string;
  image_url: string | null;
  cogs: number;
  prep_cost: number;
  bin_location: string | null;
  source_location: string | null;
  source_type: string | null;
  acquired_at: string | null;
  disposal_status: DisposalStatus;
  disposal_date: string;
  disposal_notes: string | null;
  bulk_buy_id: string | null;
  bulk_buy_locked: boolean;
}

export type TaxCategoryType =
  | "inventory_cogs"
  | "supplies"
  | "consignment"
  | "personal_nontaxable";

export interface InventoryItem {
  id: string;
  sku: string;
  title: string;
  description_html: string | null;
  description_plain: string | null;
  condition: string;
  brand: string | null;
  category_hint: string | null;
  cogs: number;
  prep_cost?: number;
  target_price: number;
  floor_price: number;
  bin_location: string | null;
  source_location?: string | null;
  source_type?: SourcingChannelType | string | null;
  payment_method?: string | null;
  receipt_ref?: string | null;
  tax_category?: TaxCategoryType | string | null;
  notes?: string | null;
  weight_oz: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  item_specifics: Record<string, string | string[]>;
  image_urls: string[];
  status: MasterItemStatus;
  acquired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemDetailUpdateRequest {
  itemId: string;
  sku?: string;
  title?: string;
  condition?: string;
  brand?: string | null;
  category_hint?: string | null;
  cogs?: number;
  prep_cost?: number;
  target_price?: number;
  floor_price?: number;
  bin_location?: string | null;
  source_location?: string | null;
  source_type?: string | null;
  payment_method?: string | null;
  receipt_ref?: string | null;
  tax_category?: string | null;
  notes?: string | null;
  acquired_at?: string | null;
  weight_oz?: number | null;
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
}

export interface MarketplaceAccount {
  id: string;
  marketplace: MarketplaceType;
  is_api_connected: boolean;
  default_fee_pct: number;
  price_markup_pct: number;
  updated_at: string;
}

export interface MarketplaceListing {
  id: string;
  item_id: string;
  marketplace: MarketplaceType;
  external_listing_id: string | null;
  external_url: string | null;
  listed_price: number;
  shipping_price: number;
  status: ListingStatus;
  views_count: number;
  watchers_count: number;
  impressions_count: number;
  promoted_ad_rate_pct?: number;
  listed_at: string | null;
  last_refreshed_at: string | null;
  last_price_drop_at: string | null;
  last_synced_at: string | null;
}

export interface ChannelJob {
  id: string;
  item_id: string;
  listing_id: string | null;
  marketplace: MarketplaceType;
  action: JobActionType;
  execution_mode: "api" | "extension";
  payload: Record<string, unknown>;
  status: JobStatusType;
  attempts: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  item_sku?: string;
  item_title?: string;
}

export type StaleSeverity = "healthy" | "watch" | "stale" | "critical";

export type PriceWatcherStage = 30 | 45 | 60 | 90;
export type PriceWatcherDecision = "keep";

export interface CrossChannelListingSummary {
  listing_id: string;
  marketplace: MarketplaceType;
  external_listing_id: string | null;
  external_url: string | null;
  listed_price: number;
  status: ListingStatus;
  views_count: number;
  watchers_count: number;
}

export interface StaleRadarRow {
  listing_id: string;
  item_id: string;
  sku: string;
  title: string;
  condition: string;
  brand: string | null;
  category_hint: string | null;
  bin_location: string | null;
  source_location: string | null;
  source_type: string | null;
  payment_method: string | null;
  receipt_ref: string | null;
  tax_category: string;
  notes: string | null;
  acquired_at: string | null;
  weight_oz: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  image_urls: string[];
  marketplace: MarketplaceType;
  external_listing_id: string | null;
  external_url: string | null;
  status: ListingStatus;
  listed_price: number;
  shipping_price: number;
  cogs: number;
  prep_cost: number;
  total_cost_basis: number;
  target_price: number;
  floor_price: number;
  views_count: number;
  watchers_count: number;
  impressions_count: number;
  promoted_ad_rate_pct: number;
  listed_at: string;
  last_refreshed_at: string | null;
  last_price_drop_at: string | null;
  last_synced_at: string | null;
  // Computed analytics fields
  days_listed: number;
  days_since_acquired: number;
  is_newly_listed: boolean;
  is_stale: boolean;
  is_low_views: boolean;
  fb_local_only?: boolean;
  stale_radar_exempt?: boolean;
  audit_status?: "verified" | "missing" | null;
  audit_verified_at?: string | null;
  quantity_available?: number;
  quantity_purchased?: number;
  bulk_buy_id?: string | null;
  bulk_buy_locked?: boolean;
  not_bulk_buy?: boolean;
  disposal_status?: DisposalStatus | null;
  disposal_date?: string | null;
  activity_log?: ItemActivityEvent[];
  relist_count: number;
  last_relisted_at: string | null;
  days_since_relist: number | null;
  is_at_floor: boolean;
  stale_severity: StaleSeverity;
  recommended_action: Exclude<JobActionType, "create" | "delist"> | null;
  stale_reason: string;
  projected_drop_price: number;
  drop_would_clamp: boolean;
  // Price Watcher (30d -10%, 45d -15%, 60d -20%, 90d Keep vs Delist/Donate)
  price_watcher_stage: PriceWatcherStage | null;
  price_watcher_due: boolean;
  price_watcher_drop_pct: number;
  price_watcher_target_price: number;
  price_watcher_would_clamp: boolean;
  price_watcher_completed_stage: number;
  price_watcher_decision: PriceWatcherDecision | null;
  price_watcher_decision_at: string | null;
  est_fee_amount: number;
  est_net_profit: number;
  est_margin_pct: number;
  est_roi_pct: number;
  // Phase 2: Multi-channel presence
  cross_listings: CrossChannelListingSummary[];
  is_listed_on_etsy: boolean;
  // Marketplace policy blocks (deterministic, AI-detected, or manually flagged)
  policy_blocked_marketplaces?: Partial<
    Record<CrossListMarketplace, MarketplacePolicyBlock>
  >;
  policy_override_marketplaces?: CrossListMarketplace[];
  // Reconciliation safety net: active single-qty items that already have a paid/shipped sale
  sold_conflict_orders?: Array<{
    id: string;
    marketplace: MarketplaceType;
    external_order_id: string | null;
    sold_at: string;
    gross_sale_price: number;
  }>;
}

export interface EnvReadiness {
  supabaseUrl: boolean;
  supabaseAnonKey: boolean;
  supabaseServiceKey: boolean;
  ebayClientId: boolean;
  ebayClientSecret: boolean;
  ebayRefreshToken: boolean;
  ebayEnv: string;
  geminiApiKey: boolean;
  etsyApiKey: boolean;
  etsyShopId: boolean;
  etsyAuthToken: boolean;
  isSupabaseReady: boolean;
  isEbayReady: boolean;
  isGeminiReady: boolean;
  isEtsyReady: boolean;
}

export type OrderFulfillmentStatus =
  | "to_ship"
  | "picked"
  | "shipped"
  | "returned"
  | "partial_refund"
  | "unpaid";

export type ExpenseCategoryType =
  | "supplies"
  | "shipping_materials"
  | "mileage"
  | "storage"
  | "software"
  | "equipment"
  | "other";

export interface BusinessExpense {
  id: string;
  expense_date: string;
  category: ExpenseCategoryType;
  description: string;
  vendor: string | null;
  miles: number | null;
  mileage_rate: number | null;
  amount: number;
  payment_method: string | null;
  receipt_ref: string | null;
  notes: string | null;
  created_at: string;
}

export interface SalesOrderRecord {
  id: string;
  item_id: string;
  sku: string;
  title: string;
  image_url?: string | null;
  marketplace: MarketplaceType;
  external_order_id: string | null;
  quantity?: number;
  quantity_verified?: boolean;
  gross_sale_price: number;
  marketplace_fees: number;
  ad_fee?: number;
  shipping_cost: number;
  refund_amount?: number;
  cogs: number;
  prep_cost?: number;
  source_location?: string | null;
  source_type?: string | null;
  acquired_at?: string | null;
  listed_at?: string | null;
  bin_location?: string | null;
  bulk_buy_id?: string | null;
  bulk_buy_locked?: boolean;
  weight_oz?: number | null;
  pkg_dimensions?: string | null;
  fulfillment_status?: OrderFulfillmentStatus;
  tracking_number?: string | null;
  shipped_at?: string | null;
  return_reason?: string | null;
  restocked?: boolean;
  buyer_city?: string | null;
  buyer_state?: string | null;
  buyer_postal?: string | null;
  buyer_country?: string | null;
  buyer_lat?: number | null;
  buyer_lon?: number | null;
  activity_log?: ItemActivityEvent[];
  net_profit: number;
  true_net_after_cogs: number;
  sold_at: string;
  delisted_channels: MarketplaceType[];
  source: "webhook" | "inbound_email" | "manual";
}

export interface QuickAddItemRequest {
  title: string;
  sku?: string;
  condition?: string;
  brand?: string | null;
  category_hint?: string | null;
  cogs: number;
  prep_cost?: number;
  target_price: number;
  floor_price: number;
  bin_location?: string | null;
  source_location?: string | null;
  source_type?: string | null;
  payment_method?: string | null;
  receipt_ref?: string | null;
  tax_category?: string | null;
  acquired_at?: string | null;
  weight_oz?: number | null;
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
  notes?: string | null;
  fbLocalOnly?: boolean;
  initialStatus: "draft" | "active";
}

export interface SalesOrderUpdateRequest {
  orderId: string;
  fulfillment_status?: OrderFulfillmentStatus;
  tracking_number?: string | null;
  refund_amount?: number;
  return_reason?: string | null;
  restockAndRelist?: boolean;
  shipping_cost?: number;
  cogs?: number;
  image_url?: string | null;
  quantity?: number;
}

export interface AutoDelistCascadeItem {
  marketplace: MarketplaceType;
  executionMode: "api" | "extension";
  status: "delisted" | "queued_extension" | "failed";
  jobId: string;
  message: string;
}

export interface AutoDelistCascadeResult {
  mode: "live" | "demo";
  order: SalesOrderRecord;
  cascadedDelists: AutoDelistCascadeItem[];
  message: string;
}

export interface ParsedOrderEmail {
  marketplace: MarketplaceType;
  orderId: string | null;
  grossSalePrice: number | null;
  shippingCost: number;
  extractedSku: string | null;
  extractedTitle: string | null;
  confidence: "high" | "medium" | "low";
}

export interface InventoryAuditRecord {
  id: string;
  completedAt: string;
  totalItems: number;
  verifiedCount: number;
  missingCount: number;
  notes?: string | null;
}

export interface CommandCenterPayload {
  mode: "live" | "demo";
  envReadiness: EnvReadiness;
  items: StaleRadarRow[];
  draftItems: InventoryItem[];
  disposedItems?: DisposedInventoryRecord[];
  bulkBuys?: BulkBuyRecord[];
  accounts: MarketplaceAccount[];
  recentJobs: ChannelJob[];
  extensionJobs: ChannelJob[];
  salesOrders: SalesOrderRecord[];
  expenses: BusinessExpense[];
  lastSyncedAt: string | null;
  etsyActiveCount: number;
  etsyLastSyncedAt: string | null;
  channelCounts: Record<MarketplaceType, number>;
  auditHistory?: InventoryAuditRecord[];
}

export interface EbayActionRequest {
  action: "update_price" | "end_and_sell_similar" | "send_offer";
  listingIds: string[];
  dropPct?: number;
  priceWatcherStage?: 30 | 45 | 60;
  offerPct?: number;
  offerMessage?: string;
  newPrice?: number;
  newTitle?: string;
  promoteRatePct?: number;
  weightOz?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  addItemSpecifics?: Array<{ name: string; value: string }>;
  /** Set a new eBay Best Offer auto-accept price, or pass `null` to clear it. */
  bestOfferAutoAcceptPrice?: number | null;
  /** Set a new eBay minimum Best Offer (auto-decline) price, or pass `null` to clear it. */
  minimumBestOfferPrice?: number | null;
}

export interface EbayActionItemResult {
  listingId: string;
  itemId: string;
  sku: string;
  title: string;
  action: "update_price" | "end_and_sell_similar" | "send_offer";
  status: "completed" | "skipped" | "failed";
  previousPrice: number;
  newPrice: number;
  floorPrice: number;
  wasClampedToFloor: boolean;
  newExternalListingId?: string | null;
  jobId: string;
  message: string;
}

export interface EbayActionResponse {
  mode: "live" | "demo";
  action: EbayActionRequest["action"];
  processedCount: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
  results: EbayActionItemResult[];
}

export interface EbaySyncResponse {
  mode: "live" | "demo";
  syncedCount: number;
  createdCount: number;
  updatedCount: number;
  reconciledSoldCount?: number;
  reconciledEndedCount?: number;
  crossListedSoldWarnings?: Array<{
    itemId: string;
    sku: string;
    title: string;
    marketplaces: MarketplaceType[];
  }>;
  syncedAt: string;
  message: string;
}

export interface CrossListPriceBreakdown {
  ebayListedPrice: number;
  ebayFeePct: number;
  ebayNetProfit: number;
  targetFeePct: number;
  targetMarkupPct: number;
  suggestedPrice: number;
  targetFeeAmount: number;
  targetNetProfit: number;
  netProfitDelta: number;
  floorPrice: number;
  respectedFloor: boolean;
}

export type CrossListMarketplace = Exclude<MarketplaceType, "ebay">;

export type ComplianceStatus = "allowed" | "warning" | "blocked";

export interface MarketplacePolicyBlock {
  rule: string;
  reason: string;
  source: "deterministic" | "ai" | "manual";
  detected_at?: string;
}

export interface ComplianceIssue {
  code: string;
  severity: "block" | "warning";
  rule: string;
  detail: string;
}

export interface MarketplaceComplianceResult {
  status: ComplianceStatus;
  allowed: boolean;
  issues: ComplianceIssue[];
  sanitizedAdjustments: string[];
}

export interface StructuredCategoryMapping {
  department: string | null;
  category: string;
  subcategory: string | null;
  conditionLabel: string;
  sizeLabel: string | null;
}

export interface CrossListDraftPayload {
  itemId: string;
  sku: string;
  targetMarketplace: MarketplaceType;
  mapperMode: "gemini" | "heuristic";
  modelUsed: string;
  sourceTitle: string;
  mappedTitle: string;
  maxTitleLength: number;
  maxDescriptionLength: number;
  descriptionPlain: string;
  taxonomyId: number;
  categoryPath: string;
  structuredCategory: StructuredCategoryMapping;
  whoMade: "i_did" | "collective" | "someone_else";
  whenMade: string;
  isSupply: boolean;
  tags: string[];
  pricing: CrossListPriceBreakdown;
  compliance: MarketplaceComplianceResult;
  translationNotes: string[];
  imageUrls?: string[];
  policyBlockRecorded?: boolean;
}

export interface EtsyCrossListRequest {
  itemId: string;
  draft?: Partial<CrossListDraftPayload>;
  publishImmediately?: boolean;
}

export interface EtsyCrossListResult {
  mode: "live" | "demo";
  itemId: string;
  sku: string;
  listingId: string;
  externalListingId: string;
  externalUrl: string;
  listedPrice: number;
  status: ListingStatus;
  jobId: string;
  mapperMode: "gemini" | "heuristic";
  message: string;
}

export interface EtsySyncResponse {
  mode: "live" | "demo";
  syncedCount: number;
  matchedCount: number;
  syncedAt: string;
  message: string;
}

export interface RoadmapTask {
  id: string;
  label: string;
  done: boolean;
  tag?: string;
}

export interface RoadmapPhase {
  phase: number;
  title: string;
  status: "active" | "next" | "planned";
  summary: string;
  tasks: RoadmapTask[];
}

export interface AdjustmentLogEntry {
  id: string;
  date: string;
  phase: number;
  category: "architecture" | "pricing" | "api" | "workflow";
  title: string;
  note: string;
}

export interface RecordLocalFacebookSaleRequest {
  mode: "unlisted" | "existing";
  itemId?: string | null;
  title?: string;
  sku?: string | null;
  salePrice: number;
  soldAt?: string | null;
  paymentMethod?: string;
  buyerName?: string | null;
  notes?: string | null;
  bulkBuyId?: string | null;
  standaloneCogs?: number;
  marketplaceFees?: number;
  shippingCost?: number;
  imageUrl?: string | null;
}

export interface RecordLocalFacebookSaleResponse {
  mode: "live" | "demo";
  orderId: string;
  itemId: string;
  sku: string;
  title: string;
  grossSalePrice: number;
  cogsApplied: number;
  bulkBuyName?: string | null;
  rebalancedCount?: number;
  perShareCost?: number;
  delistedChannels: MarketplaceType[];
  message: string;
}
