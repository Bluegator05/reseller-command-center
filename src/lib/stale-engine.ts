import type {
  CrossChannelListingSummary,
  InventoryItem,
  JobActionType,
  MarketplaceListing,
  PriceWatcherDecision,
  PriceWatcherStage,
  StaleRadarRow,
  StaleSeverity,
} from "./types";

export const DEFAULT_EBAY_FEE_PCT = 13.25;
export const NEWLY_LISTED_DAYS_THRESHOLD = 14;
export const STALE_DAYS_THRESHOLD = 45;
export const CRITICAL_DAYS_THRESHOLD = 75;
export const LOW_VIEWS_THRESHOLD = 25;

export const PRICE_WATCHER_TIERS = [
  {
    stage: 30 as const,
    minDays: 30,
    dropPct: 10,
    shortLabel: "30d · -10%",
    label: "30d+ Drop (-10%)",
    kind: "markdown" as const,
  },
  {
    stage: 45 as const,
    minDays: 45,
    dropPct: 15,
    shortLabel: "45d · -15%",
    label: "45d+ Drop (-15%)",
    kind: "markdown" as const,
  },
  {
    stage: 60 as const,
    minDays: 60,
    dropPct: 20,
    shortLabel: "60d · -20%",
    label: "60d+ Drop (-20%)",
    kind: "markdown" as const,
  },
  {
    stage: 90 as const,
    minDays: 90,
    dropPct: 0,
    shortLabel: "90d+ Decision",
    label: "90d+ Delist / Donate",
    kind: "decision" as const,
  },
] as const;

export function evaluatePriceWatcher(params: {
  daysListed: number;
  listedPrice: number;
  floorPrice: number;
  staleRadarExempt: boolean;
  itemSpecifics: Record<string, unknown>;
}): {
  stage: PriceWatcherStage | null;
  due: boolean;
  dropPct: number;
  targetPrice: number;
  wouldClamp: boolean;
  completedStage: number;
  decision: PriceWatcherDecision | null;
  decisionAt: string | null;
} {
  const {
    daysListed,
    listedPrice,
    floorPrice,
    staleRadarExempt,
    itemSpecifics,
  } = params;

  const rawCompleted = Number(itemSpecifics.price_watcher_stage);
  const completedStage =
    Number.isFinite(rawCompleted) && rawCompleted > 0
      ? Math.floor(rawCompleted)
      : 0;
  const decision: PriceWatcherDecision | null =
    itemSpecifics.price_watcher_decision === "keep" ? "keep" : null;
  const decisionAt =
    typeof itemSpecifics.price_watcher_decision_at === "string" &&
    itemSpecifics.price_watcher_decision_at
      ? itemSpecifics.price_watcher_decision_at
      : null;

  if (staleRadarExempt || daysListed < 30) {
    return {
      stage: null,
      due: false,
      dropPct: 0,
      targetPrice: roundCurrency(listedPrice),
      wouldClamp: false,
      completedStage,
      decision,
      decisionAt,
    };
  }

  let bracket: PriceWatcherStage = 30;
  if (daysListed >= 90) bracket = 90;
  else if (daysListed >= 60) bracket = 60;
  else if (daysListed >= 45) bracket = 45;

  if (bracket === 90) {
    if (decision === "keep") {
      return {
        stage: null,
        due: false,
        dropPct: 0,
        targetPrice: roundCurrency(listedPrice),
        wouldClamp: false,
        completedStage,
        decision,
        decisionAt,
      };
    }
    return {
      stage: 90,
      due: true,
      dropPct: 0,
      targetPrice: roundCurrency(listedPrice),
      wouldClamp: false,
      completedStage,
      decision,
      decisionAt,
    };
  }

  if (completedStage >= bracket) {
    return {
      stage: null,
      due: false,
      dropPct: 0,
      targetPrice: roundCurrency(listedPrice),
      wouldClamp: false,
      completedStage,
      decision,
      decisionAt,
    };
  }

  const dropPct = bracket === 60 ? 20 : bracket === 45 ? 15 : 10;
  const calc = computeClampedPriceDrop(listedPrice, floorPrice, dropPct);

  return {
    stage: bracket,
    due: true,
    dropPct,
    targetPrice: calc.nextPrice,
    wouldClamp: calc.wasClamped,
    completedStage,
    decision,
    decisionAt,
  };
}

export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates a percentage price drop while strictly enforcing the item's floor_price
 * so bulk interventions never erode below COGS + minimum profit threshold.
 */
export function computeClampedPriceDrop(
  currentPrice: number,
  floorPrice: number,
  dropPct = 10
): {
  rawNextPrice: number;
  nextPrice: number;
  wasClamped: boolean;
  isAlreadyAtFloor: boolean;
  delta: number;
} {
  const safeCurrent = Math.max(0, roundCurrency(currentPrice));
  const safeFloor = Math.max(0, roundCurrency(floorPrice));
  const isAlreadyAtFloor = safeCurrent <= safeFloor + 0.005;

  if (isAlreadyAtFloor) {
    return {
      rawNextPrice: safeCurrent,
      nextPrice: safeCurrent,
      wasClamped: true,
      isAlreadyAtFloor: true,
      delta: 0,
    };
  }

  const rawNextPrice = roundCurrency(safeCurrent * (1 - dropPct / 100));
  const wasClamped = rawNextPrice < safeFloor;
  const nextPrice = wasClamped ? safeFloor : rawNextPrice;
  const delta = roundCurrency(nextPrice - safeCurrent);

  return {
    rawNextPrice,
    nextPrice,
    wasClamped,
    isAlreadyAtFloor: false,
    delta,
  };
}

export function calculateDaysListed(
  listedAt: string | null,
  nowMs = Date.now()
): number {
  if (!listedAt) return 0;
  const parsed = Date.parse(listedAt);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / (1000 * 60 * 60 * 24)));
}

export function enrichStaleRadarRow(
  listing: MarketplaceListing,
  item: InventoryItem,
  feePct = DEFAULT_EBAY_FEE_PCT,
  crossListings: CrossChannelListingSummary[] = [],
  nowMs = Date.now()
): StaleRadarRow {
  const listedAt = listing.listed_at || item.created_at;
  const daysListed = calculateDaysListed(listedAt, nowMs);
  const daysSinceAcquired = calculateDaysListed(
    item.acquired_at || listedAt,
    nowMs
  );
  const isNewlyListed = daysListed <= NEWLY_LISTED_DAYS_THRESHOLD;
  const listedPrice = Number(listing.listed_price);
  const shippingPrice = Number(listing.shipping_price || 0);
  const cogs = Number(item.cogs);
  const prepCost = Number(item.prep_cost ?? 0);
  const totalCostBasis = roundCurrency(cogs + prepCost);
  const targetPrice = Number(item.target_price);
  const floorPrice = Number(item.floor_price);

  const isStaleByAge = daysListed >= STALE_DAYS_THRESHOLD;
  const isLowViews =
    daysListed >= 21 && listing.views_count < LOW_VIEWS_THRESHOLD;
  const isStale = isStaleByAge || isLowViews;

  const dropCalc = computeClampedPriceDrop(listedPrice, floorPrice, 10);

  let staleSeverity: StaleSeverity = "healthy";
  if (
    daysListed >= CRITICAL_DAYS_THRESHOLD ||
    (daysListed >= 60 && listing.views_count < 15)
  ) {
    staleSeverity = "critical";
  } else if (isStaleByAge || isLowViews) {
    staleSeverity = "stale";
  } else if (daysListed >= 30) {
    staleSeverity = "watch";
  }

  let recommendedAction: Exclude<JobActionType, "create" | "delist"> | null =
    null;
  let staleReason = isNewlyListed ? "Freshly listed" : "Healthy velocity";

  if (daysListed >= 60 && listing.views_count < LOW_VIEWS_THRESHOLD) {
    recommendedAction = "end_and_sell_similar";
    staleReason = `${daysListed}d old with only ${listing.views_count} views — refresh item ID`;
  } else if (listing.watchers_count >= 3 && daysListed >= 30) {
    recommendedAction = "send_offer";
    staleReason = `${listing.watchers_count} watchers stalled at ${daysListed}d — nudge buyers`;
  } else if (isStaleByAge && !dropCalc.isAlreadyAtFloor) {
    recommendedAction = "update_price";
    staleReason = dropCalc.wasClamped
      ? `${daysListed}d listed — drop clamped to floor ($${floorPrice.toFixed(2)})`
      : `${daysListed}d listed — eligible for 10% price drop`;
  } else if (isStaleByAge && dropCalc.isAlreadyAtFloor) {
    recommendedAction = "end_and_sell_similar";
    staleReason = `At COGS floor ($${floorPrice.toFixed(2)}) — relist for fresh Cassini boost`;
  } else if (isLowViews) {
    recommendedAction = "end_and_sell_similar";
    staleReason = `Low traffic (${listing.views_count} views in ${daysListed}d)`;
  } else if (daysListed >= 30) {
    recommendedAction = listing.watchers_count > 0 ? "send_offer" : null;
    staleReason =
      listing.watchers_count > 0
        ? `Approaching 45d threshold (${listing.watchers_count} watcher${listing.watchers_count === 1 ? "" : "s"})`
        : `Approaching 45d stale threshold`;
  }

  const promotedRate = Number(listing.promoted_ad_rate_pct ?? 0);
  const grossRevenue = listedPrice + shippingPrice;
  const estFeeAmount = roundCurrency(
    grossRevenue * ((feePct + promotedRate) / 100)
  );
  const estNetProfit = roundCurrency(
    listedPrice - estFeeAmount - totalCostBasis
  );
  const estMarginPct =
    listedPrice > 0 ? roundCurrency((estNetProfit / listedPrice) * 100) : 0;
  const estRoiPct =
    totalCostBasis > 0
      ? roundCurrency((estNetProfit / totalCostBasis) * 100)
      : 0;

  const isListedOnEtsy = crossListings.some(
    (c) =>
      c.marketplace === "etsy" &&
      (c.status === "active" || c.status === "draft")
  );

  const specs = (item.item_specifics || {}) as Record<string, unknown>;
  const staleRadarExempt = specs.stale_radar_exempt === "true";

  const priceWatcher = evaluatePriceWatcher({
    daysListed,
    listedPrice,
    floorPrice,
    staleRadarExempt,
    itemSpecifics: specs,
  });

  const finalIsStale = staleRadarExempt ? false : isStale;
  const finalSeverity: StaleSeverity = staleRadarExempt
    ? "healthy"
    : staleSeverity;
  const finalRecommendedAction = staleRadarExempt ? null : recommendedAction;
  const finalStaleReason = staleRadarExempt
    ? "Protected evergreen listing (excluded from Stale Radar)"
    : staleReason;

  const rawRelistCount = Number(specs.relist_count);
  const relistCount =
    Number.isFinite(rawRelistCount) && rawRelistCount >= 0
      ? Math.floor(rawRelistCount)
      : listing.last_refreshed_at
        ? 1
        : 0;
  const lastRelistedAt =
    (typeof specs.last_relisted_at === "string" && specs.last_relisted_at) ||
    listing.last_refreshed_at ||
    null;
  const daysSinceRelist =
    relistCount > 0 && lastRelistedAt
      ? calculateDaysListed(lastRelistedAt, nowMs)
      : relistCount > 0
        ? daysListed
        : null;

  return {
    listing_id: listing.id,
    item_id: item.id,
    sku: item.sku,
    title: item.title,
    condition: item.condition,
    brand: item.brand,
    category_hint: item.category_hint,
    bin_location: item.bin_location,
    source_location: item.source_location ?? null,
    source_type: item.source_type ?? "thrift",
    payment_method: item.payment_method ?? null,
    receipt_ref: item.receipt_ref ?? null,
    tax_category: item.tax_category ?? "inventory_cogs",
    notes: item.notes ?? item.description_plain ?? null,
    acquired_at: item.acquired_at,
    weight_oz: item.weight_oz,
    length_in: item.length_in,
    width_in: item.width_in,
    height_in: item.height_in,
    image_urls: item.image_urls ?? [],
    marketplace: listing.marketplace,
    external_listing_id: listing.external_listing_id,
    external_url: listing.external_url,
    status: listing.status,
    listed_price: listedPrice,
    shipping_price: shippingPrice,
    cogs,
    prep_cost: prepCost,
    total_cost_basis: totalCostBasis,
    target_price: targetPrice,
    floor_price: floorPrice,
    views_count: listing.views_count,
    watchers_count: listing.watchers_count,
    impressions_count: listing.impressions_count,
    promoted_ad_rate_pct: promotedRate,
    listed_at: listedAt,
    last_refreshed_at: listing.last_refreshed_at,
    last_price_drop_at: listing.last_price_drop_at,
    last_synced_at: listing.last_synced_at,
    days_listed: daysListed,
    days_since_acquired: daysSinceAcquired,
    is_newly_listed: isNewlyListed,
    is_stale: finalIsStale,
    is_low_views: staleRadarExempt ? false : isLowViews,
    fb_local_only: item.item_specifics?.fb_local_only === "true",
    stale_radar_exempt: staleRadarExempt,
    audit_status:
      specs.audit_status === "verified" || specs.audit_status === "missing"
        ? specs.audit_status
        : null,
    audit_verified_at:
      typeof specs.audit_verified_at === "string"
        ? specs.audit_verified_at
        : null,
    quantity_available:
      Number.isFinite(Number(specs.quantity_available)) &&
      Number(specs.quantity_available) >= 1
        ? Math.floor(Number(specs.quantity_available))
        : 1,
    quantity_purchased: Math.max(
      1,
      Number.isFinite(Number(specs.quantity_purchased))
        ? Math.floor(Number(specs.quantity_purchased))
        : 0,
      Number.isFinite(Number(specs.quantity_total))
        ? Math.floor(Number(specs.quantity_total))
        : 0,
      Number.isFinite(Number(specs.quantity_available))
        ? Math.floor(Number(specs.quantity_available))
        : 0
    ),
    bulk_buy_id:
      typeof specs.bulk_buy_id === "string" && specs.bulk_buy_id.trim()
        ? specs.bulk_buy_id.trim()
        : null,
    bulk_buy_locked:
      specs.bulk_buy_locked === true || specs.bulk_buy_locked === "true",
    disposal_status:
      specs.disposal_status === "donated" || specs.disposal_status === "discarded"
        ? specs.disposal_status
        : null,
    disposal_date:
      typeof specs.disposal_date === "string" ? specs.disposal_date : null,
    activity_log: Array.isArray(specs.activity_log)
      ? (specs.activity_log as StaleRadarRow["activity_log"])
      : [],
    relist_count: relistCount,
    last_relisted_at: lastRelistedAt,
    days_since_relist: daysSinceRelist,
    is_at_floor: dropCalc.isAlreadyAtFloor,
    stale_severity: finalSeverity,
    recommended_action: finalRecommendedAction,
    stale_reason: finalStaleReason,
    projected_drop_price: dropCalc.nextPrice,
    drop_would_clamp: dropCalc.wasClamped,
    price_watcher_stage: priceWatcher.stage,
    price_watcher_due: priceWatcher.due,
    price_watcher_drop_pct: priceWatcher.dropPct,
    price_watcher_target_price: priceWatcher.targetPrice,
    price_watcher_would_clamp: priceWatcher.wouldClamp,
    price_watcher_completed_stage: priceWatcher.completedStage,
    price_watcher_decision: priceWatcher.decision,
    price_watcher_decision_at: priceWatcher.decisionAt,
    est_fee_amount: estFeeAmount,
    est_net_profit: estNetProfit,
    est_margin_pct: estMarginPct,
    est_roi_pct: estRoiPct,
    cross_listings: crossListings,
    is_listed_on_etsy: isListedOnEtsy,
  };
}
