import type {
  ComplianceIssue,
  CrossListMarketplace,
  InventoryItem,
  MarketplaceComplianceResult,
  MarketplacePolicyBlock,
  MarketplaceType,
  StructuredCategoryMapping,
} from "./types";

export const MARKETPLACE_LIMITS: Record<
  MarketplaceType,
  {
    maxTitle: number;
    maxDescription: number;
    maxPhotos: number;
    minPrice: number;
    maxPrice: number;
    wholeDollarOnly: boolean;
  }
> = {
  ebay: {
    maxTitle: 80,
    maxDescription: 50000,
    maxPhotos: 24,
    minPrice: 0.99,
    maxPrice: 100000,
    wholeDollarOnly: false,
  },
  etsy: {
    maxTitle: 140,
    maxDescription: 10000,
    maxPhotos: 10,
    minPrice: 0.2,
    maxPrice: 50000,
    wholeDollarOnly: false,
  },
  poshmark: {
    maxTitle: 80,
    maxDescription: 1500,
    maxPhotos: 16,
    minPrice: 3,
    maxPrice: 50000,
    wholeDollarOnly: true,
  },
  mercari: {
    maxTitle: 80,
    maxDescription: 1000,
    maxPhotos: 12,
    minPrice: 5,
    maxPrice: 2000,
    wholeDollarOnly: true,
  },
  facebook: {
    maxTitle: 99,
    maxDescription: 5000,
    maxPhotos: 10,
    minPrice: 1,
    maxPrice: 50000,
    wholeDollarOnly: true,
  },
};

const CRAFT_SUPPLY_RE =
  /\b(stampin|punch|die cut|scrapbook|craft supply|craft supplies|rubber stamp|clear stamp|embossing|cardstock|yarn|crochet|knitting|sewing pattern|fabric yard|beads|ribbon|washi tape|stencil|paint brush|acrylic paint|watercolor|quilting|cross stitch|embroidery|cricut|silhouette|glitter|sticker sheet|wood blank|jewelry findings|buttons lot|zipper lot)\b/i;

const VINTAGE_ERAS = new Set([
  "before_1970",
  "1970s",
  "1980s",
  "1990_1999",
  "2000_2006",
]);

const COUNTERFEIT_RE =
  /\b(replica|knockoff|knock-off|counterfeit|fake designer|1:1 copy|mirror quality|superfake|inspired dupe|unauthentic)\b/i;

const WEAPONS_RE =
  /\b(firearm|handgun|pistol|rifle|shotgun|ammunition|ammo|taser|stun gun|pepper spray|mace spray|brass knuckles|switchblade|butterfly knife|balisong|tactical knife|hunting knife|pocket knife|dagger|machete|crossbow|bb gun|pellet gun|airsoft gun|gun holster)\b/i;

const TOBACCO_DRUGS_RE =
  /\b(vape|e-cig|e-cigarette|juul|nicotine|cigarette|cigar|tobacco|bong|dab rig|cbd oil|thc|cannabis|marijuana|kratom|prescription drug|rx only|alcohol|whiskey bottle full|wine bottle full|beer cans full)\b/i;

const RECALL_HAZARD_RE =
  /\b(recalled|drop-side crib|drop side crib|used car seat|expired car seat)\b/i;

const POSHMARK_FLAMMABLE_LIQUID_RE =
  /\b(perfume|eau de parfum|eau de toilette|cologne|body mist|fragrance spray|nail polish|nail lacquer|acetone|aerosol|hairspray|dry shampoo spray|essential oil|lighter fluid|butane|flammable liquid)\b/i;

// Exclude empty/collectible bottles, cases, bags, holders, and craft supplies
const CONTAINER_OR_ACCESSORY_RE =
  /\b(empty bottle|empty|bottle only|display bottle|factice|makeup bag|cosmetic bag|cosmetic pouch|cosmetic case|toiletry bag|vanity case|organizer|holder|rack|stand|brush set|mirror|punch|stamp|die cut|scrapbook|mug|cup|dish|bowl|jar empty|canister|tin empty|sweater|shirt|dress|pants|jacket|shoes)\b/i;

const COSMETICS_RE =
  /\b(lipstick|lip gloss|lip balm|mascara|concealer|eyeshadow|eye shadow|eyeliner|eye liner|blush palette|cheek blush|liquid blush|bronzer|face serum|facial serum|moisturizer|face cream|body lotion|hand lotion|facial cleanser|face wash|facial toner|skincare|skin care|makeup palette|liquid foundation|makeup foundation|cosmetics lot|makeup lot|shampoo|hair conditioner|deodorant|antiperspirant)\b/i;

const MEDICAL_HEALTHCARE_RE =
  /\b(cpap|bipap|glucometer|blood glucose|insulin pump|blood pressure monitor|pulse oximeter|digital thermometer|forehead thermometer|nebulizer|hearing aid|wheelchair|rolling walker|crutches|orthopedic brace|knee brace|ankle brace|back brace|wrist brace|tens unit|stethoscope|first aid kit|contact lenses|dietary supplement|multivitamin|protein powder|pre-workout|probiotic|melatonin|medical device|fda cleared|otc medicine|ibuprofen|acetaminophen|glucose test strips|surgical mask|n95 mask|kn95 mask)\b/i;

const FOOD_CONSUMABLE_RE =
  /\b(baby formula|infant formula|candy bag|chocolate bar|snack pack|coffee beans|ground coffee|tea bags|spice jar full|pet food|dog treats|cat treats|edible|perishable food)\b/i;

const POSHMARK_UNSUPPORTED_BULKY_RE =
  /\b(microwave oven|refrigerator|washing machine|clothes dryer|dishwasher|window air conditioner|space heater|lawn mower|chainsaw|table saw|miter saw|cordless power drill|impact driver|flat screen tv|sectional sofa|mattress|dining table|bookcase)\b/i;

const POSHMARK_AUTO_PARTS_RE =
  /\b(tail light|taillight|headlight|head lamp|headlamp|fog light|brake pad|brake rotor|brake caliper|alternator|starter motor|fuel filter|oil filter|diesel filter|cabin air filter|spark plug|radiator|catalytic converter|muffler|exhaust manifold|bumper cover|car bumper|fender flare|front grille|shock absorber|strut assembly|control arm|wheel hub|cv axle|transmission mount|engine mount|carburetor|ignition coil|oxygen sensor|o2 sensor|mass air flow|maf sensor|fuel pump|water pump|timing belt|serpentine belt|gasket set|head gasket|side mirror|wing mirror|wiper motor|window regulator|tow hitch|trailer hitch|hubcap|wheel bearing|auto part|car part|truck part)\b/i;

const POSHMARK_AUTO_PARTS_EXCLUDE_RE =
  /\b(shirt|t-shirt|tee|hoodie|sweatshirt|jacket|hat|cap|beanie|poster|tin sign|sign|diecast|hot wheels|matchbox|model kit|toy|lego|book|manual|magazine|sticker|decal|keychain|patch|mug|tumbler)\b/i;

const DIGITAL_GOODS_RE =
  /\b(digital download|pdf download|ebook download|gift card|egift card|redeem code|activation key|steam key|xbox code|psn code)\b/i;

const ADULT_EXPLICIT_RE =
  /\b(sex toy|vibrator|dildo|erotica|pornography|xxx adult|adult novelty|bondage gear)\b/i;

const NEW_CONDITION_RE =
  /\b(new|nwt|nib|nip|nwot|sealed|unopened|brand new|mint in box)\b/i;

const USED_OPENED_RE =
  /\b(used|pre-owned|preowned|opened|swatched|tested once|partially used|half full|gently used|fair|poor)\b/i;

/**
 * Strips cross-platform marketplace names, URLs, emails, and phone numbers
 * so descriptions comply with every marketplace's off-platform policy.
 */
export function sanitizeMarketplaceCopy(params: {
  title: string;
  description: string;
  targetMarketplace: MarketplaceType;
}): {
  title: string;
  description: string;
  adjustments: string[];
} {
  const { targetMarketplace } = params;
  const limits = MARKETPLACE_LIMITS[targetMarketplace];
  const adjustments: string[] = [];

  const otherChannels: Array<{ key: MarketplaceType; pattern: RegExp; name: string }> = [
    { key: "ebay", pattern: /\b(ebay|e-bay)\b/gi, name: "eBay" },
    { key: "poshmark", pattern: /\b(poshmark|posh closet)\b/gi, name: "Poshmark" },
    { key: "mercari", pattern: /\bmercari\b/gi, name: "Mercari" },
    { key: "etsy", pattern: /\betsy\b/gi, name: "Etsy" },
    {
      key: "facebook",
      pattern: /\b(facebook marketplace|fb marketplace|fbmp)\b/gi,
      name: "Facebook Marketplace",
    },
  ];

  let title = params.title.replace(/\s+/g, " ").trim();
  let description = params.description.trim();

  // Strip other marketplace mentions (violates off-platform rules)
  for (const ch of otherChannels) {
    if (ch.key === targetMarketplace) continue;
    if (ch.pattern.test(title)) {
      title = title.replace(ch.pattern, "").replace(/\s{2,}/g, " ").trim();
      adjustments.push(`Removed "${ch.name}" reference from title`);
    }
    ch.pattern.lastIndex = 0;
    if (ch.pattern.test(description)) {
      description = description
        .replace(ch.pattern, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      adjustments.push(`Removed "${ch.name}" reference from description`);
    }
  }

  // Strip external URLs, emails, and phone numbers (strictly banned on Poshmark/Mercari/FB)
  const urlRe = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
  const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const phoneRe = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

  if (urlRe.test(description)) {
    description = description.replace(urlRe, "[link removed]");
    adjustments.push("Removed external URL (off-platform links prohibited)");
  }
  if (emailRe.test(description)) {
    description = description.replace(emailRe, "[contact removed]");
    adjustments.push("Removed email address (off-platform contact prohibited)");
  }
  if (phoneRe.test(description)) {
    description = description.replace(phoneRe, "[contact removed]");
    adjustments.push("Removed phone number (off-platform contact prohibited)");
  }

  // Enforce marketplace character caps
  if (title.length > limits.maxTitle) {
    title = title.slice(0, limits.maxTitle).trim();
    adjustments.push(`Trimmed title to ${limits.maxTitle}-char ${targetMarketplace} limit`);
  }
  if (description.length > limits.maxDescription) {
    description = `${description.slice(0, limits.maxDescription - 3).trim()}...`;
    adjustments.push(
      `Trimmed description to ${limits.maxDescription}-char ${targetMarketplace} limit`
    );
  }

  return { title, description, adjustments };
}

/**
 * Evaluates an inventory item against each marketplace's real seller rules &
 * prohibited-item policies. Returns `blocked`, `warning`, or `allowed`.
 */
export function evaluateMarketplaceCompliance(params: {
  item: InventoryItem;
  targetMarketplace: MarketplaceType;
  suggestedPrice: number;
  whenMade?: string;
  isSupply?: boolean;
  whoMade?: "i_did" | "collective" | "someone_else";
  aiPolicyIssues?: ComplianceIssue[];
}): MarketplaceComplianceResult {
  const {
    item,
    targetMarketplace,
    suggestedPrice,
    whenMade = "2020_2026",
    isSupply,
    whoMade = "someone_else",
    aiPolicyIssues = [],
  } = params;

  const issues: ComplianceIssue[] = [];
  // Product identity (title + category + brand) avoids false positives from eBay description boilerplate like "minor cosmetic wear"
  const productIdentity = [
    item.title,
    item.brand ?? "",
    item.category_hint ?? "",
  ].join(" ");
  const fullText = [
    productIdentity,
    item.description_plain ?? "",
    item.condition ?? "",
  ].join(" ");

  const conditionText = `${item.condition || ""} ${item.title}`;
  const looksNew = NEW_CONDITION_RE.test(conditionText);
  const looksUsed = USED_OPENED_RE.test(conditionText) && !looksNew;
  const looksCraftSupply =
    isSupply === true || CRAFT_SUPPLY_RE.test(productIdentity);
  const isContainerOrAccessory =
    looksCraftSupply || CONTAINER_OR_ACCESSORY_RE.test(productIdentity);
  const weightOz = item.weight_oz ? Number(item.weight_oz) : null;
  const weightLb = weightOz ? weightOz / 16 : null;
  const limits = MARKETPLACE_LIMITS[targetMarketplace];

  // 1. Universal Prohibited Items
  if (COUNTERFEIT_RE.test(fullText)) {
    issues.push({
      code: "COUNTERFEIT_WORDING",
      severity: "block",
      rule: "Counterfeit / Replica Policy",
      detail:
        "Listing contains counterfeit/replica terminology, which is strictly prohibited and triggers immediate account suspension across all marketplaces.",
    });
  }

  if (WEAPONS_RE.test(productIdentity)) {
    issues.push({
      code: "PROHIBITED_WEAPON",
      severity: "block",
      rule: "Weapons & Tactical Gear Ban",
      detail:
        "Weapons, knives, firearms, pepper spray, and tactical self-defense items are prohibited on Poshmark, Mercari, Facebook Marketplace, and Etsy.",
    });
  }

  if (TOBACCO_DRUGS_RE.test(productIdentity)) {
    issues.push({
      code: "PROHIBITED_CONTROLLED",
      severity: "block",
      rule: "Alcohol, Tobacco, Vape & Controlled Substances Ban",
      detail:
        "Tobacco, vapes, alcohol, CBD/THC, and prescription items are prohibited across all marketplaces.",
    });
  }

  if (RECALL_HAZARD_RE.test(fullText)) {
    issues.push({
      code: "PROHIBITED_RECALL",
      severity: "block",
      rule: "Recalled / Safety-Restricted Item",
      detail:
        "Recalled goods and used child car seats / drop-side cribs cannot be sold on any marketplace.",
    });
  }

  if (ADULT_EXPLICIT_RE.test(productIdentity)) {
    issues.push({
      code: "PROHIBITED_ADULT",
      severity: "block",
      rule: "Adult / Explicit Content Policy",
      detail: `Explicit adult items are prohibited on ${targetMarketplace}.`,
    });
  }

  // 2. Price bounds
  if (suggestedPrice > 0 && suggestedPrice < limits.minPrice) {
    issues.push({
      code: "BELOW_MIN_PRICE",
      severity: "block",
      rule: `Minimum Price ($${limits.minPrice})`,
      detail: `${targetMarketplace} requires a minimum listing price of $${limits.minPrice.toFixed(2)}.`,
    });
  }
  if (suggestedPrice > limits.maxPrice) {
    issues.push({
      code: "ABOVE_MAX_PRICE",
      severity: "block",
      rule: `Maximum Price ($${limits.maxPrice.toLocaleString()})`,
      detail: `${targetMarketplace} caps standard listings at $${limits.maxPrice.toLocaleString()}.`,
    });
  }

  // 3. Poshmark-Specific Rules
  if (targetMarketplace === "poshmark") {
    if (!isContainerOrAccessory && POSHMARK_FLAMMABLE_LIQUID_RE.test(productIdentity)) {
      issues.push({
        code: "POSHMARK_HAZMAT",
        severity: "block",
        rule: "Poshmark USPS Air-Mail Hazmat Ban",
        detail:
          "Perfumes, colognes, nail polish, aerosols, and flammable liquids are prohibited on Poshmark (USPS Priority air-transport restriction).",
      });
    }

    if (!isContainerOrAccessory && COSMETICS_RE.test(productIdentity)) {
      if (looksUsed) {
        issues.push({
          code: "POSHMARK_USED_COSMETICS",
          severity: "block",
          rule: "Poshmark Cosmetics Policy",
          detail:
            "Poshmark strictly prohibits used, opened, or swatched makeup, skincare, and personal care items (brand-new sealed only).",
        });
      } else {
        issues.push({
          code: "POSHMARK_NEW_COSMETICS_CHECK",
          severity: "warning",
          rule: "Poshmark Sealed Cosmetics Requirement",
          detail:
            "Confirm this beauty/personal care item is 100% brand new, unused, and factory sealed before listing on Poshmark.",
        });
      }
    }

    if (!looksCraftSupply && MEDICAL_HEALTHCARE_RE.test(productIdentity)) {
      issues.push({
        code: "POSHMARK_MEDICAL",
        severity: "block",
        rule: "Poshmark Medical & Wellness Ban",
        detail:
          "Medical devices, braces, thermometers, OTC medicines, and dietary supplements are prohibited on Poshmark.",
      });
    }

    if (!isContainerOrAccessory && FOOD_CONSUMABLE_RE.test(productIdentity)) {
      issues.push({
        code: "POSHMARK_FOOD",
        severity: "block",
        rule: "Poshmark Food & Consumables Ban",
        detail:
          "Food, beverages, pet food, and consumables are prohibited on Poshmark.",
      });
    }

    if (POSHMARK_UNSUPPORTED_BULKY_RE.test(productIdentity)) {
      issues.push({
        code: "POSHMARK_UNSUPPORTED_CATEGORY",
        severity: "block",
        rule: "Poshmark Unsupported Bulky / Appliance Category",
        detail:
          "Heavy appliances, power tools, TVs, and furniture are not supported on Poshmark.",
      });
    }

    if (
      !POSHMARK_AUTO_PARTS_EXCLUDE_RE.test(productIdentity) &&
      POSHMARK_AUTO_PARTS_RE.test(productIdentity)
    ) {
      issues.push({
        code: "POSHMARK_AUTO_PARTS",
        severity: "block",
        rule: "Poshmark Automotive Parts Policy",
        detail:
          "Automotive hard parts and vehicle components (lights, filters, brakes, engine/body parts) are not supported on Poshmark.",
      });
    }

    if (DIGITAL_GOODS_RE.test(productIdentity)) {
      issues.push({
        code: "POSHMARK_DIGITAL",
        severity: "block",
        rule: "Poshmark Physical Goods Only",
        detail: "Digital downloads and gift cards are prohibited on Poshmark.",
      });
    }

    if (weightLb !== null && weightLb > 10) {
      issues.push({
        code: "POSHMARK_OVER_10LB",
        severity: "block",
        rule: "Poshmark 10 lb Maximum Weight Limit",
        detail: `Item weighs ${weightLb.toFixed(1)} lb, which exceeds Poshmark's absolute 10 lb shipping cap.`,
      });
    } else if (weightLb !== null && weightLb > 5) {
      issues.push({
        code: "POSHMARK_OVER_5LB",
        severity: "warning",
        rule: "Poshmark 5 lb Standard Label Warning",
        detail: `Item weighs ${weightLb.toFixed(1)} lb. Poshmark's standard label covers up to 5 lbs — you will need to purchase an upgraded Poshmark label after sale.`,
      });
    }
  }

  // 4. Mercari-Specific Rules
  if (targetMarketplace === "mercari") {
    if (!looksCraftSupply && MEDICAL_HEALTHCARE_RE.test(productIdentity)) {
      issues.push({
        code: "MERCARI_MEDICAL",
        severity: "block",
        rule: "Mercari Medical & Supplement Policy",
        detail:
          "Medical devices, prescription items, and dietary supplements are prohibited on Mercari.",
      });
    }
    if (!isContainerOrAccessory && FOOD_CONSUMABLE_RE.test(productIdentity)) {
      issues.push({
        code: "MERCARI_FOOD",
        severity: "block",
        rule: "Mercari Consumables Ban",
        detail:
          "Food, baby formula, and perishable consumables are prohibited on Mercari.",
      });
    }
    if (DIGITAL_GOODS_RE.test(productIdentity)) {
      issues.push({
        code: "MERCARI_DIGITAL",
        severity: "block",
        rule: "Mercari Physical Goods Only",
        detail:
          "Digital downloads, redeem codes, and gift cards are prohibited on Mercari.",
      });
    }
    if (!isContainerOrAccessory && POSHMARK_FLAMMABLE_LIQUID_RE.test(productIdentity)) {
      issues.push({
        code: "MERCARI_HAZMAT_GROUND",
        severity: "warning",
        rule: "Mercari Hazmat Ground Shipping Required",
        detail:
          "Fragrances, nail polish, and aerosols must ship via USPS Ground Advantage / UPS Ground (never Priority Air) and be marked Hazmat on Mercari.",
      });
    }
  }

  // 5. Facebook Marketplace-Specific Rules
  if (targetMarketplace === "facebook") {
    if (!looksCraftSupply && MEDICAL_HEALTHCARE_RE.test(productIdentity)) {
      issues.push({
        code: "FB_MEDICAL_AUTOBAN",
        severity: "block",
        rule: "Facebook Commerce Policy — Medical & Healthcare Ban",
        detail:
          "Facebook's automated enforcement strictly prohibits medical/healthcare items (braces, monitors, thermometers, supplements) and frequently suspends Marketplace access.",
      });
    }
    if (DIGITAL_GOODS_RE.test(productIdentity)) {
      issues.push({
        code: "FB_DIGITAL",
        severity: "block",
        rule: "Facebook Commerce Policy — No Digital Goods",
        detail: "Digital downloads and gift cards are prohibited on Facebook Marketplace.",
      });
    }
  }

  // 6. Etsy Eligibility Rules (Handmade / Vintage 20+ yrs / Craft Supplies ONLY)
  if (targetMarketplace === "etsy") {
    const isVintage = VINTAGE_ERAS.has(whenMade);
    const isHandmade = whoMade === "i_did";

    if (!isVintage && !looksCraftSupply && !isHandmade) {
      issues.push({
        code: "ETSY_RESALE_PROHIBITED",
        severity: "block",
        rule: "Etsy Creativity Standards (Handmade / Vintage 20+ yrs / Craft Supplies Only)",
        detail:
          "This appears to be a modern mass-produced resale item (<20 years old and not a craft supply). Etsy prohibits reselling modern non-craft items and suspends shops that violate this rule.",
      });
    } else if (looksCraftSupply && !isVintage) {
      issues.push({
        code: "ETSY_CRAFT_SUPPLY_VERIFIED",
        severity: "warning",
        rule: "Etsy Craft Supply Classification",
        detail:
          "Eligible on Etsy as a Craft Supply (`is_supply = true`). Confirm the item is used to make/create crafts before publishing.",
      });
    }
  }

  // Merge any AI-detected policy issues (deduping by code)
  const seenCodes = new Set(issues.map((i) => i.code));
  for (const aiIssue of aiPolicyIssues) {
    if (!seenCodes.has(aiIssue.code)) {
      seenCodes.add(aiIssue.code);
      issues.push(aiIssue);
    }
  }

  const hasBlock = issues.some((i) => i.severity === "block");
  const hasWarning = issues.some((i) => i.severity === "warning");

  return {
    status: hasBlock ? "blocked" : hasWarning ? "warning" : "allowed",
    allowed: !hasBlock,
    issues,
    sanitizedAdjustments: [],
  };
}

/**
 * Normalizes an eBay condition string into each marketplace's exact dropdown label.
 */
export function mapConditionForMarketplace(
  ebayCondition: string | null | undefined,
  targetMarketplace: MarketplaceType
): string {
  const c = (ebayCondition || "").toLowerCase();
  const isNewWithTags =
    /\b(new with tags|nwt|brand new|new with box|nib|sealed|new other)\b/.test(c) ||
    c.trim() === "new";
  const isLikeNew =
    /\b(like new|mint|open box|nwot|new without tags|excellent|near mint)\b/.test(c);
  const isFair = /\b(fair|acceptable|worn|flaw)\b/.test(c);
  const isPoor = /\b(poor|parts|not working|damaged|broken)\b/.test(c);

  if (targetMarketplace === "poshmark") {
    return isNewWithTags ? "New With Tags" : "Pre-owned";
  }
  if (targetMarketplace === "mercari") {
    if (isNewWithTags) return "New";
    if (isLikeNew) return "Like new";
    if (isPoor) return "Poor";
    if (isFair) return "Fair";
    return "Good";
  }
  if (targetMarketplace === "facebook") {
    if (isNewWithTags) return "New";
    if (isLikeNew) return "Used - Like New";
    if (isFair || isPoor) return "Used - Fair";
    return "Used - Good";
  }
  return ebayCondition || "Pre-owned";
}

/**
 * Deterministic marketplace-specific category, condition, and size mapper
 * (used as instant baseline and fallback when Gemini is unavailable).
 */
export function inferStructuredCategory(
  item: InventoryItem,
  targetMarketplace: MarketplaceType
): StructuredCategoryMapping {
  const hay = `${item.title} ${item.category_hint ?? ""} ${item.brand ?? ""} ${Object.values(item.item_specifics || {}).flat().join(" ")}`.toLowerCase();
  const conditionLabel = mapConditionForMarketplace(item.condition, targetMarketplace);

  // Extract size from item_specifics or title
  const rawSize =
    item.item_specifics?.Size?.[0] ||
    item.item_specifics?.["US Shoe Size"]?.[0] ||
    item.item_specifics?.["Size Type"]?.[0] ||
    null;

  const isCraft = CRAFT_SUPPLY_RE.test(hay);
  const isWomens = /\b(women|womens|woman|ladies|dress|blouse|skirt|handbag|purse|tote|crossbody)\b/.test(hay);
  const isMens = /\b(men|mens|man|male)\b/.test(hay) && !isWomens;
  const isKids = /\b(kids|youth|toddler|baby|boys|girls|infant)\b/.test(hay);

  if (targetMarketplace === "poshmark") {
    if (isCraft) {
      return {
        department: "Home",
        category: "Office",
        subcategory: "Arts & Crafts",
        conditionLabel,
        sizeLabel: "OS",
      };
    }
    if (/\b(camera|lens|walkman|cassette|radio|audio|nintendo|playstation|xbox|gameboy|video game|controller|calculator|electronics|speaker|headphone)\b/.test(hay)) {
      return {
        department: "Electronics",
        category: /\b(camera|lens|35mm)\b/.test(hay)
          ? "Cameras, Photo & Video"
          : /\b(nintendo|playstation|xbox|game|controller)\b/.test(hay)
            ? "Video Games & Consoles"
            : "Media",
        subcategory: null,
        conditionLabel,
        sizeLabel: "OS",
      };
    }
    if (/\b(dutch oven|cookware|mug|plate|bowl|kitchen|cast iron|pyrex|corning|glassware|vase|decor|candle|pillow|blanket|towel)\b/.test(hay)) {
      return {
        department: "Home",
        category: /\b(dutch oven|cookware|kitchen|cast iron|pyrex|mug|plate|bowl)\b/.test(hay)
          ? "Kitchen"
          : "Accent",
        subcategory: null,
        conditionLabel,
        sizeLabel: "OS",
      };
    }
    if (/\b(handbag|purse|crossbody|tote|clutch|wallet|backpack|bag)\b/.test(hay)) {
      return {
        department: isMens ? "Men" : "Women",
        category: "Bags",
        subcategory: /\bcrossbody\b/.test(hay)
          ? "Crossbody Bags"
          : /\btote\b/.test(hay)
            ? "Totes"
            : /\bbackpack\b/.test(hay)
              ? "Backpacks"
              : "Shoulder Bags",
        conditionLabel,
        sizeLabel: "OS",
      };
    }
    if (/\b(shoe|sneaker|boot|sandal|loafer|heel|flat|cleat)\b/.test(hay)) {
      return {
        department: isKids ? "Kids" : isMens ? "Men" : "Women",
        category: "Shoes",
        subcategory: /\bboot\b/.test(hay)
          ? "Boots"
          : /\bsandal\b/.test(hay)
            ? isKids
              ? "Sandals & Flip Flops"
              : "Sandals"
            : isKids || /\bsneaker\b/.test(hay)
              ? "Sneakers"
              : "Athletic Shoes",
        conditionLabel,
        sizeLabel: rawSize || null,
      };
    }
    if (/\b(jacket|coat|fleece|pullover|hoodie|sweater|vest|parka|blazer)\b/.test(hay)) {
      return {
        department: isKids ? "Kids" : isMens ? "Men" : "Women",
        category: "Jackets & Coats",
        subcategory: /\bfleece\b/.test(hay) ? "Fleece" : "Jackets",
        conditionLabel,
        sizeLabel: rawSize || null,
      };
    }
    if (/\b(jeans|denim|pants|trousers|shorts|leggings)\b/.test(hay)) {
      return {
        department: isKids ? "Kids" : isMens ? "Men" : "Women",
        category: /\b(jeans|denim)\b/.test(hay) ? "Jeans" : "Pants",
        subcategory: null,
        conditionLabel,
        sizeLabel: rawSize || null,
      };
    }
    if (/\b(shirt|tee|t-shirt|top|blouse|polo|jersey|dress)\b/.test(hay)) {
      return {
        department: isKids ? "Kids" : isMens ? "Men" : "Women",
        category: /\bdress\b/.test(hay) ? "Dresses" : isMens ? "Shirts" : "Tops",
        subcategory: null,
        conditionLabel,
        sizeLabel: rawSize || null,
      };
    }
    return {
      department: "Home",
      category: "Other",
      subcategory: null,
      conditionLabel,
      sizeLabel: "OS",
    };
  }

  if (targetMarketplace === "mercari") {
    if (isCraft) {
      return {
        department: "Arts & crafts",
        category: "Stamping & embossing",
        subcategory: /\bpunch\b/.test(hay) ? "Paper punches" : "Stamps",
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(camera|lens|walkman|cassette|audio|nintendo|video game|controller|calculator|electronics)\b/.test(hay)) {
      return {
        department: "Electronics",
        category: /\b(camera|lens)\b/.test(hay)
          ? "Cameras & photography"
          : /\b(nintendo|game|controller)\b/.test(hay)
            ? "Video games & consoles"
            : "TV, audio & surveillance",
        subcategory: null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(dutch oven|cookware|kitchen|mug|pyrex|home|decor)\b/.test(hay)) {
      return {
        department: "Home",
        category: "Kitchen & dining",
        subcategory: /\b(dutch oven|cookware|cast iron)\b/.test(hay) ? "Cookware" : null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(jacket|coat|fleece|jeans|pants|shorts|leggings|shirt|top|blouse|hoodie|sweater|shoe|sneaker|boot|sandal|cleat|heel|flat|loafer|jordan|handbag|purse|dress)\b/.test(hay)) {
      return {
        department: isKids ? "Kids" : isMens ? "Men" : "Women",
        category: /\b(shoe|sneaker|boot|sandal|cleat|heel|flat|loafer|jordan)\b/.test(hay)
          ? "Shoes"
          : /\b(handbag|purse|bag|tote)\b/.test(hay)
            ? "Women's handbags"
            : /\b(jacket|coat|fleece)\b/.test(hay)
              ? "Coats & jackets"
              : /\bjeans\b/.test(hay)
                ? "Jeans"
                : "Tops & blouses",
        subcategory: null,
        conditionLabel,
        sizeLabel: rawSize || null,
      };
    }
    return {
      department: "Vintage & collectibles",
      category: "Collectibles",
      subcategory: null,
      conditionLabel,
      sizeLabel: null,
    };
  }

  if (targetMarketplace === "facebook") {
    if (isCraft) {
      return {
        department: null,
        category: "Arts & Crafts",
        subcategory: null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(camera|lens|walkman|audio|nintendo|video game|controller|calculator|electronics)\b/.test(hay)) {
      return {
        department: null,
        category: "Electronics",
        subcategory: null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(dutch oven|cookware|kitchen|mug|pyrex|home|decor|vase)\b/.test(hay)) {
      return {
        department: null,
        category: "Home Goods",
        subcategory: null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(handbag|purse|bag|tote|backpack|luggage)\b/.test(hay)) {
      return {
        department: null,
        category: "Bags & Luggage",
        subcategory: null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    if (/\b(jacket|coat|fleece|jeans|shirt|shoe|sneaker|boot|dress)\b/.test(hay)) {
      return {
        department: null,
        category: "Clothing & Accessories",
        subcategory: null,
        conditionLabel,
        sizeLabel: rawSize || null,
      };
    }
    if (/\b(toy|lego|doll|action figure|board game|plush)\b/.test(hay)) {
      return {
        department: null,
        category: "Toys & Games",
        subcategory: null,
        conditionLabel,
        sizeLabel: null,
      };
    }
    return {
      department: null,
      category: "Antiques & Collectibles",
      subcategory: null,
      conditionLabel,
      sizeLabel: null,
    };
  }

  // Etsy default
  return {
    department: isCraft ? "Craft Supplies & Tools" : "Vintage & Collectibles",
    category: isCraft ? "Paper, Party & Kids" : "Collectibles",
    subcategory: isCraft ? "Paper Punches & Stamps" : null,
    conditionLabel,
    sizeLabel: rawSize || null,
  };
}

export const CROSS_LIST_MARKETPLACES: CrossListMarketplace[] = [
  "poshmark",
  "mercari",
  "etsy",
  "facebook",
];

const CROSS_LIST_SET = new Set<string>(CROSS_LIST_MARKETPLACES);

function isCrossListMarketplace(value: unknown): value is CrossListMarketplace {
  return typeof value === "string" && CROSS_LIST_SET.has(value);
}

/**
 * Safely parses `item_specifics.policy_blocked_marketplaces` (supports both JSONB object and legacy JSON string).
 */
export function parsePolicyBlockedMap(
  specs: Record<string, unknown> | null | undefined
): Partial<Record<CrossListMarketplace, MarketplacePolicyBlock>> {
  const raw = specs?.policy_blocked_marketplaces;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {};
  }
  const result: Partial<Record<CrossListMarketplace, MarketplacePolicyBlock>> =
    {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!isCrossListMarketplace(k) || !v || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    const rule =
      typeof rec.rule === "string" && rec.rule.trim()
        ? rec.rule.trim()
        : `${k.toUpperCase()} Policy Block`;
    const reason =
      typeof rec.reason === "string" && rec.reason.trim()
        ? rec.reason.trim()
        : "Prohibited by marketplace seller policy";
    const source =
      rec.source === "ai" ||
      rec.source === "deterministic" ||
      rec.source === "manual"
        ? rec.source
        : "ai";
    result[k] = {
      rule,
      reason,
      source,
      detected_at:
        typeof rec.detected_at === "string" ? rec.detected_at : undefined,
    };
  }
  return result;
}

/**
 * Safely parses `item_specifics.policy_override_marketplaces` (channels the user explicitly marked allowed).
 */
export function parsePolicyOverrideList(
  specs: Record<string, unknown> | null | undefined
): CrossListMarketplace[] {
  const raw = specs?.policy_override_marketplaces;
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const unique = new Set<CrossListMarketplace>();
  for (const entry of list) {
    if (isCrossListMarketplace(entry)) {
      unique.add(entry);
    }
  }
  return Array.from(unique);
}

/**
 * Returns a cloned `item_specifics` object with a marketplace recorded as policy-blocked
 * (and removed from any previous override list).
 */
export function applyPolicyBlockToSpecs(
  specs: Record<string, unknown> | null | undefined,
  marketplace: CrossListMarketplace,
  block: MarketplacePolicyBlock
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(specs || {}) };
  const map = parsePolicyBlockedMap(next);
  map[marketplace] = {
    rule: block.rule,
    reason: block.reason,
    source: block.source,
    detected_at: block.detected_at || new Date().toISOString(),
  };
  next.policy_blocked_marketplaces = map;

  const overrides = parsePolicyOverrideList(next).filter(
    (ch) => ch !== marketplace
  );
  if (overrides.length > 0) {
    next.policy_override_marketplaces = overrides;
  } else {
    delete next.policy_override_marketplaces;
  }
  return next;
}

/**
 * Returns a cloned `item_specifics` object with a marketplace's policy block cleared.
 * When `addOverride` is true, records the channel in `policy_override_marketplaces`
 * so deterministic rules won't re-block an item the user verified as allowed.
 */
export function clearPolicyBlockInSpecs(
  specs: Record<string, unknown> | null | undefined,
  marketplace: CrossListMarketplace,
  addOverride = true
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(specs || {}) };
  const map = parsePolicyBlockedMap(next);
  delete map[marketplace];
  if (Object.keys(map).length > 0) {
    next.policy_blocked_marketplaces = map;
  } else {
    delete next.policy_blocked_marketplaces;
  }

  const overrides = new Set(parsePolicyOverrideList(next));
  if (addOverride) {
    overrides.add(marketplace);
  } else {
    overrides.delete(marketplace);
  }
  if (overrides.size > 0) {
    next.policy_override_marketplaces = Array.from(overrides);
  } else {
    delete next.policy_override_marketplaces;
  }
  return next;
}

/**
 * Extracts the primary blocking MarketplacePolicyBlock from a MarketplaceComplianceResult.
 */
export function extractPrimaryPolicyBlock(
  compliance: MarketplaceComplianceResult | null | undefined,
  detectedAt?: string
): MarketplacePolicyBlock | null {
  if (!compliance || compliance.status !== "blocked") return null;
  const blockIssues = compliance.issues.filter((i) => i.severity === "block");
  if (blockIssues.length === 0) return null;
  // Prefer AI block if present when explaining nuanced blocks, otherwise first deterministic block
  const primary = blockIssues[0];
  const isAi = blockIssues.some((i) => i.code.startsWith("AI_POLICY_"));
  return {
    rule: primary.rule,
    reason: primary.detail,
    source: isAi ? "ai" : "deterministic",
    detected_at: detectedAt || new Date().toISOString(),
  };
}

const VINTAGE_HINT_RE =
  /\b(vintage|vtg|retro|antique|19[5-9]\d|200[0-6]|70s|80s|90s|y2k)\b/i;

/**
 * Evaluates all 4 cross-list marketplaces for an inventory item by combining:
 * 1. Persisted AI / manual policy blocks (`item_specifics.policy_blocked_marketplaces`)
 * 2. Fast deterministic rules (`evaluateMarketplaceCompliance`)
 * while respecting user overrides (`item_specifics.policy_override_marketplaces`).
 */
export function getEffectiveMarketplacePolicyBlocks(
  item: InventoryItem,
  listedPrice: number
): {
  blocks: Partial<Record<CrossListMarketplace, MarketplacePolicyBlock>>;
  overrides: CrossListMarketplace[];
} {
  const specs = (item.item_specifics || {}) as Record<string, unknown>;
  const persistedBlocks = parsePolicyBlockedMap(specs);
  const overrides = parsePolicyOverrideList(specs);
  const overrideSet = new Set<CrossListMarketplace>(overrides);

  const haystack = `${item.title} ${item.category_hint ?? ""} ${item.brand ?? ""}`;
  const isCraftSupply = CRAFT_SUPPLY_RE.test(haystack);
  const looksVintage = VINTAGE_HINT_RE.test(haystack);
  const inferredEtsyWhenMade = looksVintage ? "1990_1999" : "2020_2026";

  const blocks: Partial<Record<CrossListMarketplace, MarketplacePolicyBlock>> =
    {};

  for (const ch of CROSS_LIST_MARKETPLACES) {
    const persisted = persistedBlocks[ch];
    if (persisted) {
      // Manual or AI persisted block takes precedence (until user clears it)
      blocks[ch] = persisted;
      continue;
    }

    if (overrideSet.has(ch)) {
      continue;
    }

    const res = evaluateMarketplaceCompliance({
      item,
      targetMarketplace: ch,
      suggestedPrice: listedPrice > 0 ? listedPrice : Number(item.target_price || 0),
      whenMade: ch === "etsy" ? inferredEtsyWhenMade : "2020_2026",
      isSupply: ch === "etsy" ? isCraftSupply : false,
      whoMade: "someone_else",
    });

    if (res.status === "blocked") {
      const primary = extractPrimaryPolicyBlock(res);
      if (primary) {
        blocks[ch] = { ...primary, source: "deterministic" };
      }
    }
  }

  return { blocks, overrides };
}
