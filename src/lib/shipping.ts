export type ShippingCarrierKey =
  | "usps_ground_advantage"
  | "usps_media_mail"
  | "ups_ground"
  | "fedex_home";

export interface ShippingEstimateInput {
  weightOz: number | null | undefined;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
  isMediaEligible?: boolean;
}

export interface ShippingQuote {
  carrier: ShippingCarrierKey;
  label: string;
  service: string;
  price: number;
  billableLb: number;
  transitDays: string;
  note: string;
  cheapest: boolean;
}

export interface ShippingEstimateResult {
  actualOz: number;
  actualLb: number;
  dimLb: number;
  cubicFt: number;
  hasDims: boolean;
  dimWeightWarning: boolean;
  dimWarningText: string | null;
  quotes: ShippingQuote[];
  cheapest: ShippingQuote;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Estimates commercial/Pirate-Ship-tier rates strictly for the carriers the
 * reseller actually ships with:
 * - USPS Ground Advantage (standard + cubic)
 * - USPS Media Mail (only when `isMediaEligible` is checked: books/vinyl/CDs/DVDs)
 * - UPS Ground / Ground Saver (DIM divisor 166)
 * - FedEx Home Delivery / Ground Economy (DIM divisor 166)
 *
 * USPS Priority Mail is intentionally excluded per reseller workflow.
 */
export function estimateShippingRates(
  input: ShippingEstimateInput
): ShippingEstimateResult {
  const actualOz = Math.max(1, Number(input.weightOz) || 12);
  const actualLb = round2(actualOz / 16);
  const L = Number(input.lengthIn) || 0;
  const W = Number(input.widthIn) || 0;
  const H = Number(input.heightIn) || 0;
  const hasDims = L > 0 && W > 0 && H > 0;
  const volumeCuIn = hasDims ? L * W * H : 0;
  const cubicFt = hasDims ? round2(volumeCuIn / 1728) : 0;
  const dimLb = hasDims ? Math.ceil(volumeCuIn / 166) : Math.ceil(actualLb);
  const billedWeightLb = Math.max(Math.ceil(actualLb), dimLb);

  const quotes: ShippingQuote[] = [];

  // 1. USPS Ground Advantage (Commercial / Pirate Ship Zone 5 blended average)
  const isOversizedUsps = hasDims && (L + 2 * (W + H) > 108 || L > 22);
  let uspsGaPrice = 4.65;
  let uspsGaNote = "Commercial rate · includes $100 insurance";
  if (actualOz <= 4) uspsGaPrice = 4.35;
  else if (actualOz <= 8) uspsGaPrice = 4.85;
  else if (actualOz <= 12) uspsGaPrice = 5.45;
  else if (actualOz <= 15.99) uspsGaPrice = 6.15;
  else {
    // Over 1 lb: check USPS Ground Advantage Cubic eligibility (<= 0.5 cu ft, <= 20 lb, longest side <= 18")
    const cubicEligible =
      hasDims && cubicFt <= 0.5 && actualLb <= 20 && Math.max(L, W, H) <= 18;
    const weightBased = 7.4 + Math.max(0, billedWeightLb - 1) * 0.92;
    if (cubicEligible) {
      const cubicTierPrice =
        cubicFt <= 0.1
          ? 7.25
          : cubicFt <= 0.2
            ? 8.15
            : cubicFt <= 0.3
              ? 8.95
              : cubicFt <= 0.4
                ? 9.85
                : 10.95;
      if (cubicTierPrice < weightBased) {
        uspsGaPrice = cubicTierPrice;
        uspsGaNote = `Ground Advantage Cubic (${cubicFt.toFixed(2)} cu ft) · saves vs. weight`;
      } else {
        uspsGaPrice = weightBased;
      }
    } else {
      uspsGaPrice = weightBased;
    }
  }
  if (isOversizedUsps) {
    uspsGaPrice += 4.5;
    uspsGaNote = "Includes USPS length/girth nonstandard surcharge";
  }

  quotes.push({
    carrier: "usps_ground_advantage",
    label: "USPS Ground Advantage",
    service: actualOz < 16 ? `${Math.round(actualOz)} oz Commercial` : `${billedWeightLb} lb Commercial`,
    price: round2(uspsGaPrice),
    billableLb: actualOz < 16 ? round2(actualOz / 16) : billedWeightLb,
    transitDays: "2–5 business days",
    note: uspsGaNote,
    cheapest: false,
  });

  // 2. USPS Media Mail (books, CDs, DVDs, vinyl, tapes only — NO electronics/video games)
  if (input.isMediaEligible) {
    const mediaLb = Math.max(1, Math.ceil(actualLb));
    const mediaPrice = 4.63 + Math.max(0, mediaLb - 1) * 0.75;
    quotes.push({
      carrier: "usps_media_mail",
      label: "USPS Media Mail",
      service: `${mediaLb} lb Media`,
      price: round2(mediaPrice),
      billableLb: mediaLb,
      transitDays: "2–8 business days",
      note: "Books, vinyl, CDs & DVDs only (no video games/ads)",
      cheapest: false,
    });
  }

  // 3. UPS Ground / Ground Saver (Commercial / Pirate Ship Simple Rate)
  const upsPrice =
    billedWeightLb <= 1
      ? 7.65
      : billedWeightLb <= 3
        ? 8.95
        : billedWeightLb <= 5
          ? 10.25
          : 10.25 + (billedWeightLb - 5) * 0.62;
  quotes.push({
    carrier: "ups_ground",
    label: "UPS Ground / Saver",
    service: `${billedWeightLb} lb billable`,
    price: round2(upsPrice),
    billableLb: billedWeightLb,
    transitDays: "2–5 business days",
    note:
      dimLb > Math.ceil(actualLb)
        ? `Billed at ${dimLb} lb DIM weight (${L}×${W}×${H} ÷ 166)`
        : "Best value for heavy boxes (5+ lb)",
    cheapest: false,
  });

  // 4. FedEx Home Delivery / Ground Economy
  const fedexPrice =
    billedWeightLb <= 1
      ? 7.95
      : billedWeightLb <= 3
        ? 9.25
        : billedWeightLb <= 5
          ? 10.55
          : 10.55 + (billedWeightLb - 5) * 0.59;
  quotes.push({
    carrier: "fedex_home",
    label: "FedEx Home / Ground",
    service: `${billedWeightLb} lb billable`,
    price: round2(fedexPrice),
    billableLb: billedWeightLb,
    transitDays: "2–5 business days",
    note:
      dimLb > Math.ceil(actualLb)
        ? `Billed at ${dimLb} lb DIM weight (${L}×${W}×${H} ÷ 166)`
        : "Strong rate for bulky/heavy shipments",
    cheapest: false,
  });

  quotes.sort((a, b) => a.price - b.price);
  quotes[0].cheapest = true;

  const dimWeightWarning = hasDims && dimLb > Math.ceil(actualLb) + 1;
  const dimWarningText = dimWeightWarning
    ? `Dimensional weight (${dimLb} lb) exceeds actual weight (${actualLb.toFixed(1)} lb) — UPS/FedEx will bill at ${dimLb} lb. Trim box size or use poly mailer if safe.`
    : null;

  return {
    actualOz,
    actualLb,
    dimLb,
    cubicFt,
    hasDims,
    dimWeightWarning,
    dimWarningText,
    quotes,
    cheapest: quotes[0],
  };
}
