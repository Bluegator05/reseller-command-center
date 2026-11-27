import type {
  AutoDelistCascadeItem,
  AutoDelistCascadeResult,
  BusinessExpense,
  ChannelJob,
  CrossListMarketplace,
  InventoryItem,
  ItemDetailUpdateRequest,
  JobStatusType,
  MarketplaceAccount,
  MarketplaceListing,
  MarketplacePolicyBlock,
  MarketplaceType,
  QuickAddItemRequest,
  SalesOrderRecord,
  SalesOrderUpdateRequest,
} from "./types";
import {
  applyPolicyBlockToSpecs,
  clearPolicyBlockInSpecs,
} from "./marketplace-compliance";
import { roundCurrency } from "./stale-engine";

export interface DemoStoreState {
  items: InventoryItem[];
  listings: MarketplaceListing[];
  accounts: MarketplaceAccount[];
  jobs: ChannelJob[];
  salesOrders: SalesOrderRecord[];
  expenses: BusinessExpense[];
  lastSyncedAt: string;
  etsyLastSyncedAt: string;
  syncCount: number;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function createInitialDemoState(): DemoStoreState {
  const nowIso = new Date().toISOString();

  const accounts: MarketplaceAccount[] = [
    {
      id: "acct-ebay",
      marketplace: "ebay",
      is_api_connected: true,
      default_fee_pct: 13.25,
      price_markup_pct: 0,
      updated_at: nowIso,
    },
    {
      id: "acct-etsy",
      marketplace: "etsy",
      is_api_connected: true,
      default_fee_pct: 9.5,
      price_markup_pct: 5,
      updated_at: nowIso,
    },
    {
      id: "acct-poshmark",
      marketplace: "poshmark",
      is_api_connected: false,
      default_fee_pct: 20,
      price_markup_pct: 12,
      updated_at: nowIso,
    },
    {
      id: "acct-mercari",
      marketplace: "mercari",
      is_api_connected: false,
      default_fee_pct: 10,
      price_markup_pct: 5,
      updated_at: nowIso,
    },
    {
      id: "acct-facebook",
      marketplace: "facebook",
      is_api_connected: false,
      default_fee_pct: 5,
      price_markup_pct: 0,
      updated_at: nowIso,
    },
  ];

  const seedRows: Array<{
    item: Omit<InventoryItem, "created_at" | "updated_at">;
    listing: Omit<MarketplaceListing, "last_synced_at">;
  }> = [
    {
      item: {
        id: "item-101",
        sku: "CAM-OLY-OM1N",
        title: "Vintage Olympus OM-1n 35mm SLR Film Camera w/ 50mm f/1.8 Zuiko Lens",
        description_html:
          "<p>Tested shutter speeds, clean viewfinder, minor brassing on baseplate.</p>",
        description_plain:
          "Tested shutter speeds, clean viewfinder, minor brassing on baseplate.",
        condition: "Pre-owned — Very Good",
        brand: "Olympus",
        category_hint: "Film Cameras",
        cogs: 72.0,
        target_price: 215.0,
        floor_price: 135.0,
        bin_location: "A-04",
        weight_oz: 28,
        length_in: 9,
        width_in: 7,
        height_in: 6,
        item_specifics: { Format: "35 mm", Focus: "Manual" },
        image_urls: ["/items/olympus.jpg"],
        status: "active",
        acquired_at: daysAgoIso(92),
      },
      listing: {
        id: "lst-101",
        item_id: "item-101",
        marketplace: "ebay",
        external_listing_id: "296481920144",
        external_url: "https://www.ebay.com/itm/296481920144",
        listed_price: 194.99,
        shipping_price: 12.5,
        status: "active",
        views_count: 14,
        watchers_count: 1,
        impressions_count: 420,
        listed_at: daysAgoIso(86),
        last_refreshed_at: null,
        last_price_drop_at: daysAgoIso(32),
      },
    },
    {
      item: {
        id: "item-102",
        sku: "SNK-NB-990V5-105",
        title: "New Balance 990v5 Made in USA Grey Suede Mens Size 10.5 D",
        description_html: "<p>Light sole wear, clean insoles, original laces.</p>",
        description_plain: "Light sole wear, clean insoles, original laces.",
        condition: "Pre-owned — Excellent",
        brand: "New Balance",
        category_hint: "Athletic Shoes",
        cogs: 44.0,
        target_price: 118.0,
        floor_price: 78.0,
        bin_location: "B-12",
        weight_oz: 34,
        length_in: 14,
        width_in: 9,
        height_in: 5,
        item_specifics: { Size: "10.5", Width: "D", Color: "Grey" },
        image_urls: ["/items/nb990.jpg"],
        status: "active",
        acquired_at: daysAgoIso(67),
      },
      listing: {
        id: "lst-102",
        item_id: "item-102",
        marketplace: "ebay",
        external_listing_id: "296512004881",
        external_url: "https://www.ebay.com/itm/296512004881",
        listed_price: 112.0,
        shipping_price: 9.95,
        status: "active",
        views_count: 64,
        watchers_count: 7,
        impressions_count: 1840,
        listed_at: daysAgoIso(62),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
    {
      item: {
        id: "item-103",
        sku: "AUD-SONY-WMF41",
        title: "Sony Walkman WM-F41 Cassette Player AM/FM Radio Tested New Belt",
        description_html: "<p>Fresh drive belt installed, crisp playback on tape & FM.</p>",
        description_plain: "Fresh drive belt installed, crisp playback on tape & FM.",
        condition: "Seller Refurbished",
        brand: "Sony",
        category_hint: "Portable Audio",
        cogs: 28.5,
        target_price: 95.0,
        floor_price: 68.0,
        bin_location: "C-02",
        weight_oz: 14,
        length_in: 8,
        width_in: 6,
        height_in: 4,
        item_specifics: { Model: "WM-F41", Band: "AM/FM" },
        image_urls: ["/items/walkman.jpg"],
        status: "active",
        acquired_at: daysAgoIso(58),
      },
      listing: {
        id: "lst-103",
        item_id: "item-103",
        marketplace: "ebay",
        external_listing_id: "296533109220",
        external_url: "https://www.ebay.com/itm/296533109220",
        listed_price: 72.5,
        shipping_price: 6.95,
        status: "active",
        views_count: 31,
        watchers_count: 2,
        impressions_count: 910,
        listed_at: daysAgoIso(54),
        last_refreshed_at: null,
        last_price_drop_at: daysAgoIso(18),
      },
    },
    {
      item: {
        id: "item-104",
        sku: "OUT-PAT-SYNCH-L",
        title: "Patagonia Synchilla Snap-T Fleece Pullover Oatmeal Heather Mens L",
        description_html: "<p>No holes or pilling, crisp snaps, freshly laundered.</p>",
        description_plain: "No holes or pilling, crisp snaps, freshly laundered.",
        condition: "Pre-owned — Excellent",
        brand: "Patagonia",
        category_hint: "Men's Outerwear",
        cogs: 31.0,
        target_price: 89.0,
        floor_price: 64.0,
        bin_location: "D-08",
        weight_oz: 19,
        length_in: 12,
        width_in: 10,
        height_in: 4,
        item_specifics: { Size: "L", Material: "Polyester Fleece" },
        image_urls: ["/items/patagonia.jpg"],
        status: "active",
        acquired_at: daysAgoIso(84),
      },
      listing: {
        id: "lst-104",
        item_id: "item-104",
        marketplace: "ebay",
        external_listing_id: "296470221009",
        external_url: "https://www.ebay.com/itm/296470221009",
        listed_price: 64.0,
        shipping_price: 8.5,
        status: "active",
        views_count: 19,
        watchers_count: 1,
        impressions_count: 680,
        listed_at: daysAgoIso(79),
        last_refreshed_at: null,
        last_price_drop_at: daysAgoIso(24),
      },
    },
    {
      item: {
        id: "item-105",
        sku: "GAM-N64-ATOMPURP",
        title: "Nintendo 64 Atomic Purple Controller OEM Tight Stick Authentic Cleaned",
        description_html: "<p>Original OEM joystick rated 8.5/10 tightness, all buttons tested.</p>",
        description_plain: "Original OEM joystick rated 8.5/10 tightness, all buttons tested.",
        condition: "Pre-owned — Good",
        brand: "Nintendo",
        category_hint: "Video Game Accessories",
        cogs: 14.0,
        target_price: 49.99,
        floor_price: 32.0,
        bin_location: "E-01",
        weight_oz: 11,
        length_in: 8,
        width_in: 7,
        height_in: 4,
        item_specifics: { Platform: "Nintendo 64", Color: "Atomic Purple" },
        image_urls: ["/items/n64.jpg"],
        status: "active",
        acquired_at: daysAgoIso(52),
      },
      listing: {
        id: "lst-105",
        item_id: "item-105",
        marketplace: "ebay",
        external_listing_id: "296548190332",
        external_url: "https://www.ebay.com/itm/296548190332",
        listed_price: 47.99,
        shipping_price: 5.95,
        status: "active",
        views_count: 42,
        watchers_count: 5,
        impressions_count: 1320,
        listed_at: daysAgoIso(49),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
    {
      item: {
        id: "item-106",
        sku: "DEN-LEV-501USA-32",
        title: "Vintage 1990s Levi's 501 Button Fly Jeans Made in USA 32x30 Light Wash",
        description_html: "<p>Classic 90s fade, red tab intact, 100% cotton non-stretch.</p>",
        description_plain: "Classic 90s fade, red tab intact, 100% cotton non-stretch.",
        condition: "Pre-owned — Vintage Good",
        brand: "Levi's",
        category_hint: "Vintage Denim",
        cogs: 22.0,
        target_price: 78.0,
        floor_price: 48.0,
        bin_location: "D-14",
        weight_oz: 24,
        length_in: 12,
        width_in: 10,
        height_in: 3,
        item_specifics: { Waist: "32", Inseam: "30", Origin: "USA" },
        image_urls: ["/items/levis.jpg"],
        status: "active",
        acquired_at: daysAgoIso(69),
      },
      listing: {
        id: "lst-106",
        item_id: "item-106",
        marketplace: "ebay",
        external_listing_id: "296499883115",
        external_url: "https://www.ebay.com/itm/296499883115",
        listed_price: 74.0,
        shipping_price: 8.95,
        status: "active",
        views_count: 11,
        watchers_count: 0,
        impressions_count: 340,
        listed_at: daysAgoIso(66),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
    {
      item: {
        id: "item-107",
        sku: "BAG-COACH-9951",
        title: "Vintage Coach Patricia Legacy 9951 Black Glovetanned Leather Crossbody",
        description_html: "<p>Creed intact, brass hardware polished, conditioned leather.</p>",
        description_plain: "Creed intact, brass hardware polished, conditioned leather.",
        condition: "Pre-owned — Very Good",
        brand: "Coach",
        category_hint: "Women's Handbags",
        cogs: 55.0,
        target_price: 165.0,
        floor_price: 110.0,
        bin_location: "F-03",
        weight_oz: 26,
        length_in: 12,
        width_in: 10,
        height_in: 5,
        item_specifics: { Style: "9951", Material: "Leather", Color: "Black" },
        image_urls: ["/items/coach.jpg"],
        status: "active",
        acquired_at: daysAgoIso(51),
      },
      listing: {
        id: "lst-107",
        item_id: "item-107",
        marketplace: "ebay",
        external_listing_id: "296550114872",
        external_url: "https://www.ebay.com/itm/296550114872",
        listed_price: 158.0,
        shipping_price: 0,
        status: "active",
        views_count: 58,
        watchers_count: 2,
        impressions_count: 1610,
        listed_at: daysAgoIso(47),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
    {
      item: {
        id: "item-108",
        sku: "KIT-LECR-24DUTCH",
        title: "Le Creuset #24 4.5 Qt Flame Orange Enameled Cast Iron Dutch Oven France",
        description_html: "<p>Glossy exterior enamel, light interior utensil marks, lid fits flush.</p>",
        description_plain: "Glossy exterior enamel, light interior utensil marks, lid fits flush.",
        condition: "Pre-owned — Good",
        brand: "Le Creuset",
        category_hint: "Cookware",
        cogs: 68.0,
        target_price: 189.0,
        floor_price: 125.0,
        bin_location: "G-02",
        weight_oz: 168,
        length_in: 14,
        width_in: 14,
        height_in: 9,
        item_specifics: { Capacity: "4.5 qt", Color: "Flame Orange" },
        image_urls: ["/items/lecreuset.jpg"],
        status: "active",
        acquired_at: daysAgoIso(41),
      },
      listing: {
        id: "lst-108",
        item_id: "item-108",
        marketplace: "ebay",
        external_listing_id: "296574002918",
        external_url: "https://www.ebay.com/itm/296574002918",
        listed_price: 179.0,
        shipping_price: 22.0,
        status: "active",
        views_count: 18,
        watchers_count: 1,
        impressions_count: 510,
        listed_at: daysAgoIso(37),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
    {
      item: {
        id: "item-109",
        sku: "WRK-CAR-J97MOS-XL",
        title: "Carhartt J97 MOS Moss Green Detroit Blanket Lined Work Jacket Mens XL",
        description_html: "<p>Authentic workwear patina, YKK brass zipper works smoothly.</p>",
        description_plain: "Authentic workwear patina, YKK brass zipper works smoothly.",
        condition: "Pre-owned — Distressed",
        brand: "Carhartt",
        category_hint: "Men's Jackets",
        cogs: 75.0,
        target_price: 245.0,
        floor_price: 160.0,
        bin_location: "D-03",
        weight_oz: 46,
        length_in: 15,
        width_in: 12,
        height_in: 5,
        item_specifics: { Model: "J97 MOS", Size: "XL" },
        image_urls: ["/items/carhartt.jpg"],
        status: "active",
        acquired_at: daysAgoIso(18),
      },
      listing: {
        id: "lst-109",
        item_id: "item-109",
        marketplace: "ebay",
        external_listing_id: "296619920114",
        external_url: "https://www.ebay.com/itm/296619920114",
        listed_price: 239.0,
        shipping_price: 14.0,
        status: "active",
        views_count: 142,
        watchers_count: 14,
        impressions_count: 4820,
        listed_at: daysAgoIso(14),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
    {
      item: {
        id: "item-110",
        sku: "ELC-TI-84PCE-BLK",
        title: "Texas Instruments TI-84 Plus CE Color Graphing Calculator w/ Cover & Cable",
        description_html: "<p>Holds full charge, crisp screen, includes slide case & USB cable.</p>",
        description_plain: "Holds full charge, crisp screen, includes slide case & USB cable.",
        condition: "Pre-owned — Very Good",
        brand: "Texas Instruments",
        category_hint: "Office Electronics",
        cogs: 24.0,
        target_price: 74.99,
        floor_price: 52.0,
        bin_location: "C-11",
        weight_oz: 12,
        length_in: 9,
        width_in: 5,
        height_in: 2,
        item_specifics: { Model: "TI-84 Plus CE", Color: "Black" },
        image_urls: ["/items/ti84.jpg"],
        status: "active",
        acquired_at: daysAgoIso(9),
      },
      listing: {
        id: "lst-110",
        item_id: "item-110",
        marketplace: "ebay",
        external_listing_id: "296634109822",
        external_url: "https://www.ebay.com/itm/296634109822",
        listed_price: 69.99,
        shipping_price: 0,
        status: "active",
        views_count: 51,
        watchers_count: 4,
        impressions_count: 1920,
        listed_at: daysAgoIso(7),
        last_refreshed_at: null,
        last_price_drop_at: null,
      },
    },
  ];

  const sourcingDefaults: Record<
    string,
    {
      source_location: string;
      source_type: string;
      prep_cost: number;
      payment_method: string;
      receipt_ref: string;
      tax_category: string;
      notes: string;
    }
  > = {
    "item-101": {
      source_location: "Estate Sale — Lake Oswego",
      source_type: "estate_sale",
      prep_cost: 6.5,
      payment_method: "Cash",
      receipt_ref: "EST-2026-0814",
      tax_category: "inventory_cogs",
      notes: "Replaced light seals & installed fresh SR44 battery. Shutter fires crisply at all speeds.",
    },
    "item-102": {
      source_location: "Goodwill — SE Hawthorne",
      source_type: "thrift",
      prep_cost: 2.0,
      payment_method: "Business Amex",
      receipt_ref: "GW-90218",
      tax_category: "inventory_cogs",
      notes: "Cleaned suede with Jason Markk brush. 7 watchers on eBay — strong candidate for 10% offer.",
    },
    "item-103": {
      source_location: "Garage Sale — Beaverton",
      source_type: "garage_sale",
      prep_cost: 4.5,
      payment_method: "Cash",
      receipt_ref: "GS-0924-B",
      tax_category: "inventory_cogs",
      notes: "Installed new 0.7mm rubber belt + cleaned pinch roller with isopropyl. Speed calibrated.",
    },
    "item-104": {
      source_location: "Goodwill Outlet (Bins)",
      source_type: "bins",
      prep_cost: 1.25,
      payment_method: "Business Debit",
      receipt_ref: "BINS-0829",
      tax_category: "inventory_cogs",
      notes: "At COGS floor ($64). End & Sell Similar to reset Cassini visibility for Q4 fleece season.",
    },
    "item-105": {
      source_location: "Facebook Marketplace Lot",
      source_type: "online_arbitrage",
      prep_cost: 0,
      payment_method: "Venmo",
      receipt_ref: "FBM-LOT-19",
      tax_category: "inventory_cogs",
      notes: "Part of 4-controller bundle ($56 total / 4 = $14 COGS). Joystick lubed and tested 8.5/10.",
    },
    "item-106": {
      source_location: "Red White & Blue Thrift",
      source_type: "thrift",
      prep_cost: 0,
      payment_method: "Business Amex",
      receipt_ref: "RWB-4412",
      tax_category: "inventory_cogs",
      notes: "1994 San Benito TX factory stamp (552). Measure flat waist 15.75\" before answering buyer Qs.",
    },
    "item-107": {
      source_location: "Estate Sale — West Hills",
      source_type: "estate_sale",
      prep_cost: 3.5,
      payment_method: "Business Amex",
      receipt_ref: "EST-2026-1001",
      tax_category: "inventory_cogs",
      notes: "Conditioned with Leather CPR, polished brass turnlock. Creed #J8C-9951 (1998 Costa Rica).",
    },
    "item-108": {
      source_location: "Savers Thrift — Tigard",
      source_type: "thrift",
      prep_cost: 5.0,
      payment_method: "Business Amex",
      receipt_ref: "SAV-77310",
      tax_category: "inventory_cogs",
      notes: "Heavy double-box shipment (~10.5 lbs). Bubble-wrapped lid inverted to prevent chipping.",
    },
    "item-109": {
      source_location: "Local Vintage Wholesale Picker",
      source_type: "wholesale",
      prep_cost: 0,
      payment_method: "Zelle",
      receipt_ref: "INV-PICK-304",
      tax_category: "inventory_cogs",
      notes: "High-demand Moss Green J97 Detroit. Already 14 watchers in 14d — hold firm near $239.",
    },
    "item-110": {
      source_location: "Goodwill — Gresham",
      source_type: "thrift",
      prep_cost: 3.0,
      payment_method: "Business Amex",
      receipt_ref: "GW-11142",
      tax_category: "inventory_cogs",
      notes: "Added replacement mini-USB charging cable ($3 prep). Holds 100% charge, tested OS 5.8.",
    },
  };

  const items: InventoryItem[] = [
    ...seedRows.map((r) => {
      const meta = sourcingDefaults[r.item.id];
      return {
        ...r.item,
        prep_cost: meta?.prep_cost ?? 0,
        source_location: meta?.source_location ?? "Local Thrift Store",
        source_type: meta?.source_type ?? "thrift",
        payment_method: meta?.payment_method ?? "Business Amex",
        receipt_ref: meta?.receipt_ref ?? null,
        tax_category: meta?.tax_category ?? "inventory_cogs",
        notes: meta?.notes ?? r.item.description_plain,
        created_at: r.item.acquired_at || nowIso,
        updated_at: nowIso,
      };
    }),
    {
      id: "item-draft-201",
      sku: "CAM-NIK-FM2N",
      title: "Nikon FM2n Chrome 35mm Film SLR Camera Body w/ 50mm f/1.4 AI-S Lens",
      description_html: null,
      description_plain: "Needs light seal check & studio photos before listing.",
      condition: "Pre-owned — Very Good",
      brand: "Nikon",
      category_hint: "Film Cameras",
      cogs: 95.0,
      prep_cost: 8.0,
      target_price: 345.0,
      floor_price: 240.0,
      bin_location: "TOTE-1",
      source_location: "Estate Sale — Lake Oswego",
      source_type: "estate_sale",
      payment_method: "Cash",
      receipt_ref: "EST-2026-1114",
      tax_category: "inventory_cogs",
      notes: "Bought in camera lot — test meter & photograph this weekend.",
      weight_oz: 31,
      length_in: 9,
      width_in: 7,
      height_in: 6,
      item_specifics: {},
      image_urls: [],
      status: "draft",
      acquired_at: daysAgoIso(12),
      created_at: daysAgoIso(12),
      updated_at: nowIso,
    },
    {
      id: "item-draft-202",
      sku: "OUT-TNF-NUPTSE-M",
      title: "The North Face 700-Fill Nuptse Puffer Jacket Black Mens Medium",
      description_html: null,
      description_plain: "Freshly washed with Nikwax Down Wash — ready to steam & shoot.",
      condition: "Pre-owned — Excellent",
      brand: "The North Face",
      category_hint: "Men's Outerwear",
      cogs: 36.0,
      prep_cost: 2.5,
      target_price: 165.0,
      floor_price: 110.0,
      bin_location: "TOTE-2",
      source_location: "Goodwill Outlet (Bins)",
      source_type: "bins",
      payment_method: "Business Debit",
      receipt_ref: "BINS-1116",
      tax_category: "inventory_cogs",
      notes: "Paid by the pound (~$1.79/lb) + $2.50 down wash. High Q4 demand!",
      weight_oz: 28,
      length_in: 14,
      width_in: 11,
      height_in: 5,
      item_specifics: {},
      image_urls: [],
      status: "draft",
      acquired_at: daysAgoIso(5),
      created_at: daysAgoIso(5),
      updated_at: nowIso,
    },
    {
      id: "item-draft-203",
      sku: "GAM-PS2-SLIM-79K",
      title: "Sony PlayStation 2 Slim SCPH-79001 Console w/ 2 OEM DualShock Controllers",
      description_html: null,
      description_plain: "Reads silver & blue discs cleanly — needs composite AV cable.",
      condition: "Pre-owned — Good",
      brand: "Sony",
      category_hint: "Video Game Consoles",
      cogs: 26.0,
      prep_cost: 5.5,
      target_price: 98.0,
      floor_price: 68.0,
      bin_location: "TOTE-3",
      source_location: "Garage Sale — Beaverton",
      source_type: "garage_sale",
      payment_method: "Cash",
      receipt_ref: "GS-1102-A",
      tax_category: "inventory_cogs",
      notes: "Ordered replacement AV cable ($5.50 prep cost) — list once cable arrives.",
      weight_oz: 52,
      length_in: 12,
      width_in: 10,
      height_in: 6,
      item_specifics: {},
      image_urls: [],
      status: "draft",
      acquired_at: daysAgoIso(19),
      created_at: daysAgoIso(19),
      updated_at: nowIso,
    },
  ];

  const listings: MarketplaceListing[] = [
    ...seedRows.map((r) => ({
      ...r.listing,
      last_synced_at: hoursAgoIso(2),
    })),
    // Pre-seeded Phase 2 Etsy cross-listings so multi-channel presence is visible immediately
    {
      id: "lst-etsy-101",
      item_id: "item-101",
      marketplace: "etsy",
      external_listing_id: "1842901124",
      external_url: "https://www.etsy.com/listing/1842901124",
      listed_price: 197.0,
      shipping_price: 0,
      status: "active",
      views_count: 38,
      watchers_count: 6,
      impressions_count: 540,
      listed_at: daysAgoIso(12),
      last_refreshed_at: null,
      last_price_drop_at: null,
      last_synced_at: hoursAgoIso(1),
    },
    {
      id: "lst-etsy-107",
      item_id: "item-107",
      marketplace: "etsy",
      external_listing_id: "1843118902",
      external_url: "https://www.etsy.com/listing/1843118902",
      listed_price: 160.0,
      shipping_price: 0,
      status: "active",
      views_count: 49,
      watchers_count: 9,
      impressions_count: 790,
      listed_at: daysAgoIso(9),
      last_refreshed_at: null,
      last_price_drop_at: null,
      last_synced_at: hoursAgoIso(1),
    },
  ];

  const jobs: ChannelJob[] = [
    {
      id: "job-seed-ext-fb",
      item_id: "item-108",
      listing_id: null,
      marketplace: "facebook",
      action: "create",
      execution_mode: "extension",
      payload: {
        sku: "KIT-LECR-24DUTCH",
        mappedTitle: "Le Creuset #24 4.5 Qt Flame Orange Enameled Cast Iron Dutch Oven",
        suggestedPrice: 173.0,
        brand: "Le Creuset",
        condition: "Pre-owned — Good",
        requiresUserConfirm: true,
      },
      status: "needs_user_confirm",
      attempts: 1,
      error_message: null,
      created_at: hoursAgoIso(1),
      started_at: hoursAgoIso(1),
      completed_at: null,
      item_sku: "KIT-LECR-24DUTCH",
      item_title:
        "Le Creuset #24 4.5 Qt Flame Orange Enameled Cast Iron Dutch Oven France",
    },
    {
      id: "job-seed-ext-posh",
      item_id: "item-102",
      listing_id: null,
      marketplace: "poshmark",
      action: "create",
      execution_mode: "extension",
      payload: {
        sku: "SNK-NB-990V5-105",
        mappedTitle: "New Balance 990v5 Made in USA Grey Suede Mens Size 10.5 D",
        suggestedPrice: 136.0,
        brand: "New Balance",
        condition: "Pre-owned — Excellent",
      },
      status: "pending",
      attempts: 0,
      error_message: null,
      created_at: hoursAgoIso(2),
      started_at: null,
      completed_at: null,
      item_sku: "SNK-NB-990V5-105",
      item_title:
        "New Balance 990v5 Made in USA Grey Suede Mens Size 10.5 D",
    },
    {
      id: "job-seed-etsy-1",
      item_id: "item-107",
      listing_id: "lst-etsy-107",
      marketplace: "etsy",
      action: "create",
      execution_mode: "api",
      payload: {
        price: 160,
        externalListingId: "1843118902",
        tagsCount: 11,
        mapperMode: "heuristic",
      },
      status: "completed",
      attempts: 1,
      error_message: null,
      created_at: daysAgoIso(9),
      started_at: daysAgoIso(9),
      completed_at: daysAgoIso(9),
      item_sku: "BAG-COACH-9951",
      item_title:
        "Vintage Coach Patricia Legacy 9951 Black Glovetanned Leather Crossbody",
    },
    {
      id: "job-seed-1",
      item_id: "item-103",
      listing_id: "lst-103",
      marketplace: "ebay",
      action: "update_price",
      execution_mode: "api",
      payload: {
        previousPrice: 80.55,
        newPrice: 72.5,
        dropPct: 10,
        wasClamped: false,
      },
      status: "completed",
      attempts: 1,
      error_message: null,
      created_at: daysAgoIso(18),
      started_at: daysAgoIso(18),
      completed_at: daysAgoIso(18),
      item_sku: "AUD-SONY-WMF41",
      item_title:
        "Sony Walkman WM-F41 Cassette Player AM/FM Radio Tested New Belt",
    },
    {
      id: "job-seed-2",
      item_id: "item-104",
      listing_id: "lst-104",
      marketplace: "ebay",
      action: "update_price",
      execution_mode: "api",
      payload: {
        previousPrice: 69.0,
        newPrice: 64.0,
        dropPct: 10,
        wasClamped: true,
      },
      status: "completed",
      attempts: 1,
      error_message: null,
      created_at: daysAgoIso(24),
      started_at: daysAgoIso(24),
      completed_at: daysAgoIso(24),
      item_sku: "OUT-PAT-SYNCH-L",
      item_title:
        "Patagonia Synchilla Snap-T Fleece Pullover Oatmeal Heather Mens L",
    },
  ];

  const salesOrders: SalesOrderRecord[] = [
    {
      id: "ord-seed-0",
      item_id: "item-hist-0",
      sku: "AUD-BOSE-QC45",
      title: "Bose QuietComfort 45 Wireless Noise Cancelling Headphones White Smoke",
      marketplace: "ebay",
      external_order_id: "EBAY-26-11984-042",
      gross_sale_price: 168.0,
      marketplace_fees: 22.26,
      shipping_cost: 7.45,
      refund_amount: 0,
      cogs: 55.0,
      prep_cost: 0,
      source_location: "Goodwill — SE Hawthorne",
      source_type: "thrift",
      acquired_at: daysAgoIso(24),
      bin_location: "C-04",
      weight_oz: 18,
      pkg_dimensions: "9×8×4 in",
      fulfillment_status: "to_ship",
      tracking_number: null,
      shipped_at: null,
      return_reason: null,
      restocked: false,
      net_profit: 138.29,
      true_net_after_cogs: 83.29,
      sold_at: daysAgoIso(1),
      delisted_channels: ["mercari", "facebook"],
      source: "webhook",
    },
    {
      id: "ord-seed-1",
      item_id: "item-hist-1",
      sku: "CAM-CAN-AE1P",
      title: "Canon AE-1 Program 35mm Film SLR Camera w/ 50mm f/1.8 FD Lens",
      marketplace: "etsy",
      external_order_id: "ETSY-349182041",
      gross_sale_price: 224.0,
      marketplace_fees: 21.28,
      shipping_cost: 11.4,
      refund_amount: 0,
      cogs: 78.0,
      prep_cost: 4.0,
      source_location: "Estate Sale — Lake Oswego",
      source_type: "estate_sale",
      acquired_at: daysAgoIso(48),
      bin_location: "A-02",
      weight_oz: 32,
      pkg_dimensions: "10×8×6 in",
      fulfillment_status: "to_ship",
      tracking_number: null,
      shipped_at: null,
      return_reason: null,
      restocked: false,
      net_profit: 191.32,
      true_net_after_cogs: 109.32,
      sold_at: daysAgoIso(2),
      delisted_channels: ["ebay"],
      source: "webhook",
    },
    {
      id: "ord-seed-2",
      item_id: "item-hist-2",
      sku: "OUT-ARC-BETA-M",
      title: "Arc'teryx Beta LT Gore-Tex Shell Jacket Black Mens Medium",
      marketplace: "poshmark",
      external_order_id: "PM-882014",
      gross_sale_price: 295.0,
      marketplace_fees: 59.0,
      shipping_cost: 0,
      refund_amount: 0,
      cogs: 120.0,
      prep_cost: 2.5,
      source_location: "Local Vintage Wholesale Picker",
      source_type: "wholesale",
      acquired_at: daysAgoIso(39),
      bin_location: "D-01",
      weight_oz: 21,
      pkg_dimensions: "13×10×3 in (Poly)",
      fulfillment_status: "picked",
      tracking_number: null,
      shipped_at: null,
      return_reason: null,
      restocked: false,
      net_profit: 236.0,
      true_net_after_cogs: 113.5,
      sold_at: daysAgoIso(4),
      delisted_channels: ["ebay", "mercari"],
      source: "inbound_email",
    },
    {
      id: "ord-seed-3",
      item_id: "item-hist-3",
      sku: "GAM-GBASP-101",
      title: "Nintendo Game Boy Advance SP AGS-101 Pearl Blue Backlit Console + Charger",
      marketplace: "mercari",
      external_order_id: "MC-6619042",
      gross_sale_price: 134.0,
      marketplace_fees: 13.4,
      shipping_cost: 5.99,
      refund_amount: 0,
      cogs: 42.0,
      prep_cost: 6.0,
      source_location: "Garage Sale — Beaverton",
      source_type: "garage_sale",
      acquired_at: daysAgoIso(52),
      bin_location: "E-04",
      weight_oz: 10,
      pkg_dimensions: "7×5×3 in",
      fulfillment_status: "shipped",
      tracking_number: "9400111899223819204112",
      shipped_at: daysAgoIso(21),
      return_reason: null,
      restocked: false,
      net_profit: 114.61,
      true_net_after_cogs: 66.61,
      sold_at: daysAgoIso(22),
      delisted_channels: ["ebay"],
      source: "inbound_email",
    },
    {
      id: "ord-seed-4",
      item_id: "item-hist-4",
      sku: "KIT-VIT-5200",
      title: "Vitamix 5200 Professional-Grade Blender 64oz Container Black Tested",
      marketplace: "ebay",
      external_order_id: "EBAY-26-09821-118",
      gross_sale_price: 249.0,
      marketplace_fees: 32.99,
      shipping_cost: 18.6,
      refund_amount: 0,
      cogs: 65.0,
      prep_cost: 3.5,
      source_location: "Savers Thrift — Tigard",
      source_type: "thrift",
      acquired_at: daysAgoIso(89),
      bin_location: "G-01",
      weight_oz: 176,
      pkg_dimensions: "16×12×12 in",
      fulfillment_status: "shipped",
      tracking_number: "1Z999AA10123456784",
      shipped_at: daysAgoIso(55),
      return_reason: null,
      restocked: false,
      net_profit: 197.41,
      true_net_after_cogs: 128.91,
      sold_at: daysAgoIso(56),
      delisted_channels: ["facebook", "mercari"],
      source: "webhook",
    },
    {
      id: "ord-seed-5",
      item_id: "item-hist-5",
      sku: "FUR-HERM-AERON",
      title: "Herman Miller Aeron Classic Size B Ergonomic Office Chair Graphite",
      marketplace: "facebook",
      external_order_id: "FB-3109448",
      gross_sale_price: 380.0,
      marketplace_fees: 0,
      shipping_cost: 0,
      refund_amount: 0,
      cogs: 140.0,
      prep_cost: 12.0,
      source_location: "Office Liquidation Auction",
      source_type: "wholesale",
      acquired_at: daysAgoIso(150),
      bin_location: "FLOOR-A",
      weight_oz: 640,
      pkg_dimensions: "Local Pickup",
      fulfillment_status: "shipped",
      tracking_number: "LOCAL-PICKUP",
      shipped_at: daysAgoIso(128),
      return_reason: null,
      restocked: false,
      net_profit: 380.0,
      true_net_after_cogs: 228.0,
      sold_at: daysAgoIso(128),
      delisted_channels: ["ebay"],
      source: "inbound_email",
    },
    {
      id: "ord-seed-6",
      item_id: "item-hist-6",
      sku: "DEN-POLO-RL-1992",
      title: "Vintage 1990s Polo Ralph Lauren Spellout Fleece Half-Zip Pullover L",
      marketplace: "ebay",
      external_order_id: "EBAY-26-03112-907",
      gross_sale_price: 185.0,
      marketplace_fees: 24.51,
      shipping_cost: 8.2,
      refund_amount: 15.0,
      cogs: 28.0,
      prep_cost: 0,
      source_location: "Goodwill Outlet (Bins)",
      source_type: "bins",
      acquired_at: daysAgoIso(310),
      bin_location: "D-09",
      weight_oz: 24,
      pkg_dimensions: "12×10×4 in",
      fulfillment_status: "partial_refund",
      tracking_number: "9400111899223001928371",
      shipped_at: daysAgoIso(283),
      return_reason: "Minor pinhole near cuff — buyer kept w/ $15 courtesy refund",
      restocked: false,
      net_profit: 137.29,
      true_net_after_cogs: 109.29,
      sold_at: daysAgoIso(284),
      delisted_channels: ["poshmark", "etsy"],
      source: "webhook",
    },
  ];

  const expenses: BusinessExpense[] = [
    {
      id: "exp-1",
      expense_date: daysAgoIso(3).slice(0, 10),
      category: "mileage",
      description: "Saturday Estate Sale + Goodwill Bins Sourcing Loop (Lake Oswego → Milwaukie)",
      vendor: "IRS Standard Mileage",
      miles: 48.5,
      mileage_rate: 0.7,
      amount: 33.95,
      payment_method: "Mileage Log",
      receipt_ref: "MILE-1117",
      notes: "Odometer 64,210 → 64,258.5",
      created_at: daysAgoIso(3),
    },
    {
      id: "exp-2",
      expense_date: daysAgoIso(9).slice(0, 10),
      category: "shipping_materials",
      description: "100x 10×13 Poly Mailers + 500x 4×6 Direct Thermal Shipping Labels",
      vendor: "Amazon Business",
      miles: null,
      mileage_rate: null,
      amount: 34.8,
      payment_method: "Business Amex",
      receipt_ref: "AMZ-114-99210",
      notes: "Rollo thermal labels + teal poly mailers",
      created_at: daysAgoIso(9),
    },
    {
      id: "exp-3",
      expense_date: daysAgoIso(18).slice(0, 10),
      category: "supplies",
      description: "Heavy-Duty Packing Tape (12-pack) + 175ft Small Bubble Wrap Roll",
      vendor: "Uline",
      miles: null,
      mileage_rate: null,
      amount: 49.6,
      payment_method: "Business Amex",
      receipt_ref: "UL-774102",
      notes: "Fragile camera & cast-iron packing supplies",
      created_at: daysAgoIso(18),
    },
    {
      id: "exp-4",
      expense_date: daysAgoIso(25).slice(0, 10),
      category: "storage",
      description: "5×10 Climate-Controlled Inventory Storage Unit (Monthly)",
      vendor: "Public Storage",
      miles: null,
      mileage_rate: null,
      amount: 89.0,
      payment_method: "Business Debit",
      receipt_ref: "PS-OCT-2026",
      notes: "100% business inventory shelving",
      created_at: daysAgoIso(25),
    },
    {
      id: "exp-5",
      expense_date: daysAgoIso(41).slice(0, 10),
      category: "mileage",
      description: "Beaverton Garage Sales + Savers Tigard Sourcing Run",
      vendor: "IRS Standard Mileage",
      miles: 32.0,
      mileage_rate: 0.7,
      amount: 22.4,
      payment_method: "Mileage Log",
      receipt_ref: "MILE-1010",
      notes: "Picked up Sony Walkman & Le Creuset",
      created_at: daysAgoIso(41),
    },
    {
      id: "exp-6",
      expense_date: daysAgoIso(60).slice(0, 10),
      category: "software",
      description: "eBay Basic Store Subscription (Monthly)",
      vendor: "eBay Inc.",
      miles: null,
      mileage_rate: null,
      amount: 21.95,
      payment_method: "Business Amex",
      receipt_ref: "EBAY-SUB-09",
      notes: "Recurring store fee",
      created_at: daysAgoIso(60),
    },
  ];

  return {
    items,
    listings,
    accounts,
    jobs,
    salesOrders,
    expenses,
    lastSyncedAt: hoursAgoIso(2),
    etsyLastSyncedAt: hoursAgoIso(1),
    syncCount: 0,
  };
}

const globalForDemo = globalThis as unknown as {
  __resellerDemoStore?: DemoStoreState;
};

export function getDemoStore(): DemoStoreState {
  if (!globalForDemo.__resellerDemoStore) {
    globalForDemo.__resellerDemoStore = createInitialDemoState();
  }
  return globalForDemo.__resellerDemoStore;
}

export function simulateDemoEbaySync(): {
  syncedCount: number;
  createdCount: number;
  updatedCount: number;
  syncedAt: string;
} {
  const store = getDemoStore();
  const nowIso = new Date().toISOString();
  store.syncCount += 1;

  for (const listing of store.listings) {
    if (listing.marketplace === "ebay" && listing.status === "active") {
      listing.views_count += Math.floor(Math.random() * 4);
      listing.impressions_count += 15 + Math.floor(Math.random() * 45);
      listing.last_synced_at = nowIso;
    }
  }

  let createdCount = 0;

  if (
    store.syncCount === 1 &&
    !store.items.some((i) => i.sku === "SHO-REDW-875-95")
  ) {
    const newItem: InventoryItem = {
      id: "item-111",
      sku: "SHO-REDW-875-95",
      title: "Red Wing Heritage 875 Classic Moc Toe Boots Oro Legacy Mens 9.5 D",
      description_html:
        "<p>Goodyear welt intact, Traction Tred soles have 80% life left.</p>",
      description_plain:
        "Goodyear welt intact, Traction Tred soles have 80% life left.",
      condition: "Pre-owned — Good",
      brand: "Red Wing",
      category_hint: "Men's Boots",
      cogs: 78.0,
      target_price: 210.0,
      floor_price: 145.0,
      bin_location: "B-03",
      weight_oz: 64,
      length_in: 14,
      width_in: 11,
      height_in: 6,
      item_specifics: { Size: "9.5", Leather: "Oro Legacy" },
      image_urls: [],
      status: "active",
      acquired_at: daysAgoIso(57),
      created_at: daysAgoIso(57),
      updated_at: nowIso,
    };

    const newListing: MarketplaceListing = {
      id: "lst-111",
      item_id: "item-111",
      marketplace: "ebay",
      external_listing_id: "296519442008",
      external_url: "https://www.ebay.com/itm/296519442008",
      listed_price: 188.0,
      shipping_price: 15.0,
      status: "active",
      views_count: 21,
      watchers_count: 3,
      impressions_count: 740,
      listed_at: daysAgoIso(53),
      last_refreshed_at: null,
      last_price_drop_at: null,
      last_synced_at: nowIso,
    };

    store.items.unshift(newItem);
    store.listings.unshift(newListing);
    createdCount = 1;
  }

  store.lastSyncedAt = nowIso;

  const activeEbayCount = store.listings.filter(
    (l) => l.marketplace === "ebay" && l.status === "active"
  ).length;

  return {
    syncedCount: activeEbayCount,
    createdCount,
    updatedCount: activeEbayCount - createdCount,
    syncedAt: nowIso,
  };
}

export function upsertDemoEtsyListing(params: {
  itemId: string;
  listedPrice: number;
  status: "active" | "draft";
}): MarketplaceListing {
  const store = getDemoStore();
  const nowIso = new Date().toISOString();
  const existing = store.listings.find(
    (l) => l.item_id === params.itemId && l.marketplace === "etsy"
  );

  if (existing) {
    existing.listed_price = roundCurrency(params.listedPrice);
    existing.status = params.status;
    existing.last_synced_at = nowIso;
    store.etsyLastSyncedAt = nowIso;
    return existing;
  }

  const externalId = String(1845000000 + Math.floor(Math.random() * 8999999));
  const created: MarketplaceListing = {
    id: `lst-etsy-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    item_id: params.itemId,
    marketplace: "etsy",
    external_listing_id: externalId,
    external_url: `https://www.etsy.com/listing/${externalId}`,
    listed_price: roundCurrency(params.listedPrice),
    shipping_price: 0,
    status: params.status,
    views_count: 0,
    watchers_count: 0,
    impressions_count: 0,
    listed_at: nowIso,
    last_refreshed_at: null,
    last_price_drop_at: null,
    last_synced_at: nowIso,
  };

  store.listings.push(created);
  store.etsyLastSyncedAt = nowIso;
  return created;
}

export function simulateDemoEtsySync(): {
  syncedCount: number;
  syncedAt: string;
} {
  const store = getDemoStore();
  const nowIso = new Date().toISOString();
  let syncedCount = 0;

  for (const listing of store.listings) {
    if (
      listing.marketplace === "etsy" &&
      (listing.status === "active" || listing.status === "draft")
    ) {
      listing.views_count += 2 + Math.floor(Math.random() * 6);
      listing.watchers_count += Math.random() > 0.55 ? 1 : 0;
      listing.impressions_count += 25 + Math.floor(Math.random() * 60);
      listing.last_synced_at = nowIso;
      syncedCount += 1;
    }
  }

  store.etsyLastSyncedAt = nowIso;
  return { syncedCount, syncedAt: nowIso };
}

export function recordDemoJob(job: Omit<ChannelJob, "id">): ChannelJob {
  const store = getDemoStore();
  const created: ChannelJob = {
    ...job,
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
  store.jobs.unshift(created);
  if (store.jobs.length > 40) {
    store.jobs.length = 40;
  }
  return created;
}

export function applyDemoListingPrice(
  listingId: string,
  newPrice: number,
  priceWatcherStage?: 30 | 45 | 60
) {
  const store = getDemoStore();
  const listing = store.listings.find((l) => l.id === listingId);
  if (!listing) return null;
  const nowIso = new Date().toISOString();
  listing.listed_price = roundCurrency(newPrice);
  listing.last_price_drop_at = nowIso;
  listing.last_synced_at = nowIso;
  if (priceWatcherStage) {
    const item = store.items.find((i) => i.id === listing.item_id);
    if (item) {
      item.item_specifics = {
        ...(item.item_specifics || {}),
        price_watcher_stage: String(priceWatcherStage),
        price_watcher_last_action_at: nowIso,
      };
      item.updated_at = nowIso;
    }
  }
  return listing;
}

export function applyDemoPriceWatcherAction(params: {
  itemId: string;
  mode: "skip_stage" | "keep" | "reopen";
  stage?: 30 | 45 | 60;
}) {
  const store = getDemoStore();
  const item = store.items.find((i) => i.id === params.itemId);
  if (!item) return null;
  const nowIso = new Date().toISOString();
  const nextSpecs: Record<string, string | string[]> = {
    ...(item.item_specifics || {}),
  };
  if (params.mode === "skip_stage" && params.stage) {
    nextSpecs.price_watcher_stage = String(params.stage);
    nextSpecs.price_watcher_last_action_at = nowIso;
  } else if (params.mode === "keep") {
    nextSpecs.price_watcher_stage = "90";
    nextSpecs.price_watcher_decision = "keep";
    nextSpecs.price_watcher_decision_at = nowIso;
  } else if (params.mode === "reopen") {
    delete nextSpecs.price_watcher_decision;
    delete nextSpecs.price_watcher_decision_at;
    if (nextSpecs.price_watcher_stage === "90") {
      nextSpecs.price_watcher_stage = "60";
    }
  }
  item.item_specifics = nextSpecs;
  item.updated_at = nowIso;
  return item;
}

export function applyDemoNotBulkBuy(params: {
  itemIds: string[];
  notBulkBuy: boolean;
}) {
  const store = getDemoStore();
  const idSet = new Set(params.itemIds);
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const item of store.items) {
    if (!idSet.has(item.id)) continue;
    const nextSpecs: Record<string, string | string[]> = {
      ...(item.item_specifics || {}),
    };
    if (params.notBulkBuy) {
      nextSpecs.not_bulk_buy = "true";
    } else {
      delete nextSpecs.not_bulk_buy;
    }
    item.item_specifics = nextSpecs;
    item.updated_at = nowIso;
    updated += 1;
  }
  return updated;
}

export function applyDemoMarketplacePolicyBlock(params: {
  itemId: string;
  marketplace: CrossListMarketplace;
  blocked: boolean;
  block?: MarketplacePolicyBlock;
  addOverride?: boolean;
}) {
  const store = getDemoStore();
  const item = store.items.find((i) => i.id === params.itemId);
  if (!item) return null;
  const nowIso = new Date().toISOString();
  const specs = (item.item_specifics || {}) as Record<string, unknown>;
  const nextSpecs = params.blocked
    ? applyPolicyBlockToSpecs(specs, params.marketplace, {
        rule:
          params.block?.rule ||
          `${params.marketplace.toUpperCase()} Policy Block`,
        reason:
          params.block?.reason ||
          "Marked as prohibited on this marketplace.",
        source: params.block?.source || "manual",
        detected_at: params.block?.detected_at || nowIso,
      })
    : clearPolicyBlockInSpecs(
        specs,
        params.marketplace,
        params.addOverride ?? true
      );
  item.item_specifics = nextSpecs as Record<string, string | string[]>;
  item.updated_at = nowIso;
  return item;
}

export function applyDemoEndAndSellSimilar(listingId: string) {
  const store = getDemoStore();
  const listing = store.listings.find((l) => l.id === listingId);
  if (!listing) return null;
  const nowIso = new Date().toISOString();
  const newExternalId = String(297000000000 + Math.floor(Math.random() * 89999999));
  listing.external_listing_id = newExternalId;
  listing.external_url = `https://www.ebay.com/itm/${newExternalId}`;
  listing.listed_at = nowIso;
  listing.last_refreshed_at = nowIso;
  listing.last_synced_at = nowIso;
  listing.views_count = 0;
  listing.watchers_count = 0;
  listing.impressions_count = 0;
  listing.promoted_ad_rate_pct = 0;
  const item = store.items.find((i) => i.id === listing.item_id);
  if (item?.item_specifics) {
    const nextSpecs = { ...item.item_specifics };
    delete nextSpecs.price_watcher_stage;
    delete nextSpecs.price_watcher_decision;
    delete nextSpecs.price_watcher_decision_at;
    delete nextSpecs.price_watcher_last_action_at;
    item.item_specifics = nextSpecs;
  }
  return listing;
}

export function applyDemoPromoteListing(listingId: string, adRatePct: number) {
  const store = getDemoStore();
  const listing = store.listings.find((l) => l.id === listingId);
  if (!listing) return null;
  listing.promoted_ad_rate_pct = roundCurrency(adRatePct);
  listing.last_synced_at = new Date().toISOString();
  return listing;
}

export function updateDemoExtensionJob(params: {
  jobId: string;
  status: JobStatusType;
  externalUrl?: string;
  listedPrice?: number;
  errorMessage?: string;
}): ChannelJob | null {
  const store = getDemoStore();
  const job = store.jobs.find((j) => j.id === params.jobId);
  if (!job) return null;

  const nowIso = new Date().toISOString();
  job.status = params.status;
  if (params.status === "processing") {
    job.attempts += 1;
    job.started_at = nowIso;
  }
  if (params.status === "completed" || params.status === "failed") {
    job.completed_at = nowIso;
  }
  if (params.errorMessage) {
    job.error_message = params.errorMessage;
  }

  if (params.status === "completed" && job.action === "create") {
    const price = roundCurrency(
      Number(params.listedPrice ?? job.payload?.suggestedPrice ?? 0)
    );
    const existing = store.listings.find(
      (l) => l.item_id === job.item_id && l.marketplace === job.marketplace
    );
    if (existing) {
      existing.listed_price = price;
      existing.status = "active";
      existing.last_synced_at = nowIso;
      job.listing_id = existing.id;
    } else {
      const extId = `${job.marketplace}-${Date.now().toString().slice(-7)}`;
      const defaultUrl =
        job.marketplace === "poshmark"
          ? `https://poshmark.com/listing/${extId}`
          : job.marketplace === "mercari"
            ? `https://www.mercari.com/us/item/${extId}/`
            : `https://www.facebook.com/marketplace/item/${extId}/`;

      const created: MarketplaceListing = {
        id: `lst-${job.marketplace}-${Date.now()}`,
        item_id: job.item_id,
        marketplace: job.marketplace,
        external_listing_id: extId,
        external_url: params.externalUrl || defaultUrl,
        listed_price: price,
        shipping_price: 0,
        status: "active",
        views_count: 0,
        watchers_count: 0,
        impressions_count: 0,
        listed_at: nowIso,
        last_refreshed_at: null,
        last_price_drop_at: null,
        last_synced_at: nowIso,
      };
      store.listings.push(created);
      job.listing_id = created.id;
    }
  }

  return job;
}

const DEMO_CHANNEL_FEES: Record<MarketplaceType, number> = {
  ebay: 13.25,
  etsy: 9.5,
  poshmark: 20.0,
  mercari: 10.0,
  facebook: 5.0,
};

export function recordDemoSaleAndDelist(params: {
  itemId?: string;
  sku?: string;
  externalListingId?: string;
  marketplace: MarketplaceType;
  externalOrderId?: string | null;
  grossSalePrice?: number | null;
  shippingCost?: number;
  source: "webhook" | "inbound_email" | "manual";
}): AutoDelistCascadeResult {
  const store = getDemoStore();
  let item: InventoryItem | undefined;

  if (params.itemId) {
    item = store.items.find((i) => i.id === params.itemId);
  }
  if (!item && params.sku) {
    item = store.items.find(
      (i) => i.sku.toUpperCase() === params.sku!.toUpperCase()
    );
  }
  if (!item && params.externalListingId) {
    const lst = store.listings.find(
      (l) => l.external_listing_id === params.externalListingId
    );
    if (lst) {
      item = store.items.find((i) => i.id === lst.item_id);
    }
  }

  if (!item) {
    throw new Error(
      `No active inventory item matched (sku=${params.sku ?? "none"}, itemId=${params.itemId ?? "none"})`
    );
  }

  const nowIso = new Date().toISOString();
  const itemListings = store.listings.filter((l) => l.item_id === item!.id);
  const soldListing = itemListings.find(
    (l) => l.marketplace === params.marketplace
  );

  const grossPrice = roundCurrency(
    Number(
      params.grossSalePrice ?? soldListing?.listed_price ?? item.target_price
    )
  );
  const feePct =
    store.accounts.find((a) => a.marketplace === params.marketplace)
      ?.default_fee_pct ?? DEMO_CHANNEL_FEES[params.marketplace];
  const marketplaceFees = roundCurrency(grossPrice * (feePct / 100));
  const shippingCost = roundCurrency(Number(params.shippingCost ?? 0));
  const netProfit = roundCurrency(grossPrice - marketplaceFees - shippingCost);
  const cogs = Number(item.cogs);
  const externalOrderId =
    params.externalOrderId ||
    `${params.marketplace.toUpperCase().slice(0, 3)}-${Date.now().toString().slice(-6)}`;

  // 1. Mark item sold & selling listing sold
  item.status = "sold";
  item.updated_at = nowIso;
  if (soldListing) {
    soldListing.status = "sold";
    soldListing.last_synced_at = nowIso;
  }

  // 2. Cascade delist across all OTHER active/draft listings
  const otherListings = itemListings.filter(
    (l) =>
      l.marketplace !== params.marketplace &&
      (l.status === "active" || l.status === "draft")
  );

  const cascadedDelists: AutoDelistCascadeItem[] = [];

  for (const other of otherListings) {
    const isApi = other.marketplace === "ebay" || other.marketplace === "etsy";
    const executionMode = isApi ? "api" : "extension";

    if (isApi) {
      other.status = "ended";
      other.last_synced_at = nowIso;
    }

    const job = recordDemoJob({
      item_id: item.id,
      listing_id: other.id,
      marketplace: other.marketplace,
      action: "delist",
      execution_mode: executionMode,
      payload: {
        sku: item.sku,
        mappedTitle: item.title,
        externalListingId: other.external_listing_id,
        externalUrl: other.external_url,
        reason: `SOLD_ON_${params.marketplace.toUpperCase()}`,
        soldOrderId: externalOrderId,
      },
      status: isApi ? "completed" : "pending",
      attempts: isApi ? 1 : 0,
      error_message: null,
      created_at: nowIso,
      started_at: isApi ? nowIso : null,
      completed_at: isApi ? nowIso : null,
      item_sku: item.sku,
      item_title: item.title,
    });

    cascadedDelists.push({
      marketplace: other.marketplace,
      executionMode,
      status: isApi ? "delisted" : "queued_extension",
      jobId: job.id,
      message: isApi
        ? `Ended ${other.marketplace.toUpperCase()} listing #${other.external_listing_id} immediately via API`
        : `Queued urgent DELIST job for ${other.marketplace.toUpperCase()} Extension`,
    });
  }

  const pkgDims =
    item.length_in && item.width_in && item.height_in
      ? `${item.length_in}×${item.width_in}×${item.height_in} in`
      : null;

  const order: SalesOrderRecord = {
    id: `ord-${Date.now()}`,
    item_id: item.id,
    sku: item.sku,
    title: item.title,
    marketplace: params.marketplace,
    external_order_id: externalOrderId,
    gross_sale_price: grossPrice,
    marketplace_fees: marketplaceFees,
    shipping_cost: shippingCost,
    refund_amount: 0,
    cogs,
    prep_cost: item.prep_cost ?? 0,
    source_location: item.source_location ?? null,
    source_type: item.source_type ?? null,
    acquired_at: item.acquired_at ?? null,
    bin_location: item.bin_location ?? null,
    weight_oz: item.weight_oz ?? null,
    pkg_dimensions: pkgDims,
    fulfillment_status: "to_ship",
    tracking_number: null,
    shipped_at: null,
    return_reason: null,
    restocked: false,
    net_profit: netProfit,
    true_net_after_cogs: roundCurrency(netProfit - cogs - (item.prep_cost ?? 0)),
    sold_at: nowIso,
    delisted_channels: cascadedDelists.map((c) => c.marketplace),
    source: params.source,
  };

  store.salesOrders.unshift(order);

  return {
    mode: "demo",
    order,
    cascadedDelists,
    message:
      cascadedDelists.length > 0
        ? `Sold ${item.sku} on ${params.marketplace.toUpperCase()} ($${grossPrice.toFixed(2)}) — cascaded ${cascadedDelists.length} anti-double-sell delist${cascadedDelists.length === 1 ? "" : "s"}.`
        : `Sold ${item.sku} on ${params.marketplace.toUpperCase()} ($${grossPrice.toFixed(2)}) — recorded in sales ledger.`,
  };
}

export function updateDemoInventoryItem(
  req: ItemDetailUpdateRequest
): InventoryItem | null {
  const store = getDemoStore();
  const item = store.items.find((i) => i.id === req.itemId);
  if (!item) return null;

  if (typeof req.sku === "string" && req.sku.trim()) {
    item.sku = req.sku.trim();
  }
  if (typeof req.title === "string" && req.title.trim()) {
    item.title = req.title.trim();
  }
  if (typeof req.condition === "string" && req.condition.trim()) {
    item.condition = req.condition.trim();
  }
  if (req.brand !== undefined) item.brand = req.brand;
  if (req.category_hint !== undefined) item.category_hint = req.category_hint;
  if (typeof req.cogs === "number" && Number.isFinite(req.cogs)) {
    item.cogs = Math.max(0, roundCurrency(req.cogs));
  }
  if (typeof req.prep_cost === "number" && Number.isFinite(req.prep_cost)) {
    item.prep_cost = Math.max(0, roundCurrency(req.prep_cost));
  }
  if (
    typeof req.target_price === "number" &&
    Number.isFinite(req.target_price)
  ) {
    item.target_price = Math.max(0, roundCurrency(req.target_price));
  }
  if (
    typeof req.floor_price === "number" &&
    Number.isFinite(req.floor_price)
  ) {
    item.floor_price = Math.max(0, roundCurrency(req.floor_price));
  }
  if (req.bin_location !== undefined) item.bin_location = req.bin_location;
  if (req.source_location !== undefined) {
    item.source_location = req.source_location;
  }
  if (req.source_type !== undefined) item.source_type = req.source_type;
  if (req.payment_method !== undefined) {
    item.payment_method = req.payment_method;
  }
  if (req.receipt_ref !== undefined) item.receipt_ref = req.receipt_ref;
  if (req.tax_category !== undefined) item.tax_category = req.tax_category;
  if (req.notes !== undefined) item.notes = req.notes;
  if (req.acquired_at !== undefined) item.acquired_at = req.acquired_at;
  if (req.weight_oz !== undefined) item.weight_oz = req.weight_oz;
  if (req.length_in !== undefined) item.length_in = req.length_in;
  if (req.width_in !== undefined) item.width_in = req.width_in;
  if (req.height_in !== undefined) item.height_in = req.height_in;

  item.updated_at = new Date().toISOString();
  return item;
}

export function createDemoInventoryItem(
  req: QuickAddItemRequest
): InventoryItem {
  const store = getDemoStore();
  const nowIso = new Date().toISOString();
  const itemId = `item-${Date.now()}`;
  const cleanSku =
    req.sku?.trim() ||
    `SKU-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  const item: InventoryItem = {
    id: itemId,
    sku: cleanSku,
    title: req.title.trim(),
    description_html: req.notes ? `<p>${req.notes}</p>` : null,
    description_plain: req.notes ?? null,
    condition: req.condition?.trim() || "Pre-owned — Very Good",
    brand: req.brand?.trim() || null,
    category_hint: req.category_hint?.trim() || null,
    cogs: Math.max(0, roundCurrency(req.cogs)),
    prep_cost: Math.max(0, roundCurrency(req.prep_cost ?? 0)),
    target_price: Math.max(0, roundCurrency(req.target_price)),
    floor_price: Math.max(0, roundCurrency(req.floor_price)),
    bin_location: req.bin_location?.trim() || null,
    source_location: req.source_location?.trim() || null,
    source_type: req.source_type || "thrift",
    payment_method: req.payment_method || "Business Amex",
    receipt_ref: req.receipt_ref?.trim() || null,
    tax_category: req.tax_category || "inventory_cogs",
    notes: req.notes?.trim() || null,
    weight_oz: req.weight_oz ?? null,
    length_in: req.length_in ?? null,
    width_in: req.width_in ?? null,
    height_in: req.height_in ?? null,
    item_specifics: {},
    image_urls: [],
    status: req.initialStatus,
    acquired_at: req.acquired_at || nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  };

  store.items.unshift(item);

  if (req.initialStatus === "active") {
    const extId = String(296700000000 + Math.floor(Math.random() * 89999999));
    store.listings.unshift({
      id: `lst-${Date.now()}`,
      item_id: itemId,
      marketplace: "ebay",
      external_listing_id: extId,
      external_url: `https://www.ebay.com/itm/${extId}`,
      listed_price: item.target_price,
      shipping_price: 8.95,
      status: "active",
      views_count: 0,
      watchers_count: 0,
      impressions_count: 0,
      promoted_ad_rate_pct: 0,
      listed_at: nowIso,
      last_refreshed_at: null,
      last_price_drop_at: null,
      last_synced_at: nowIso,
    });
  }

  return item;
}

export function promoteDemoDraftToActive(itemId: string): InventoryItem | null {
  const store = getDemoStore();
  const item = store.items.find((i) => i.id === itemId);
  if (!item) return null;
  const nowIso = new Date().toISOString();
  item.status = "active";
  item.updated_at = nowIso;

  const existing = store.listings.find(
    (l) => l.item_id === itemId && l.marketplace === "ebay"
  );
  if (existing) {
    existing.status = "active";
    existing.listed_at = nowIso;
    existing.last_synced_at = nowIso;
  } else {
    const extId = String(296700000000 + Math.floor(Math.random() * 89999999));
    store.listings.unshift({
      id: `lst-${Date.now()}`,
      item_id: itemId,
      marketplace: "ebay",
      external_listing_id: extId,
      external_url: `https://www.ebay.com/itm/${extId}`,
      listed_price: item.target_price,
      shipping_price: 8.95,
      status: "active",
      views_count: 0,
      watchers_count: 0,
      impressions_count: 0,
      promoted_ad_rate_pct: 0,
      listed_at: nowIso,
      last_refreshed_at: null,
      last_price_drop_at: null,
      last_synced_at: nowIso,
    });
  }

  recordDemoJob({
    item_id: item.id,
    listing_id: null,
    marketplace: "ebay",
    action: "create",
    execution_mode: "api",
    payload: { price: item.target_price, fromDeathPile: true },
    status: "completed",
    attempts: 1,
    error_message: null,
    created_at: nowIso,
    started_at: nowIso,
    completed_at: nowIso,
    item_sku: item.sku,
    item_title: item.title,
  });

  return item;
}

export function deleteDemoInventoryItem(itemId: string): boolean {
  const store = getDemoStore();
  const before = store.items.length;
  store.items = store.items.filter((i) => i.id !== itemId);
  store.listings = store.listings.filter((l) => l.item_id !== itemId);
  return store.items.length < before;
}

export function addDemoExpense(
  input: Omit<BusinessExpense, "id" | "created_at">
): BusinessExpense {
  const store = getDemoStore();
  const exp: BusinessExpense = {
    ...input,
    id: `exp-${Date.now()}`,
    amount: roundCurrency(Math.max(0, input.amount)),
    created_at: new Date().toISOString(),
  };
  store.expenses.unshift(exp);
  return exp;
}

export function deleteDemoExpense(expenseId: string): boolean {
  const store = getDemoStore();
  const before = store.expenses.length;
  store.expenses = store.expenses.filter((e) => e.id !== expenseId);
  return store.expenses.length < before;
}

export function updateDemoSalesOrder(
  req: SalesOrderUpdateRequest
): { order: SalesOrderRecord; restocked: boolean } | null {
  const store = getDemoStore();
  const order = store.salesOrders.find((o) => o.id === req.orderId);
  if (!order) return null;

  const nowIso = new Date().toISOString();
  if (req.fulfillment_status) {
    order.fulfillment_status = req.fulfillment_status;
    if (req.fulfillment_status === "shipped" && !order.shipped_at) {
      order.shipped_at = nowIso;
    }
  }
  if (req.tracking_number !== undefined) {
    order.tracking_number = req.tracking_number;
  }
  if (req.return_reason !== undefined) {
    order.return_reason = req.return_reason;
  }
  if (
    typeof req.quantity === "number" &&
    Number.isFinite(req.quantity) &&
    req.quantity >= 1
  ) {
    order.quantity = Math.min(999, Math.max(1, Math.floor(req.quantity)));
    order.quantity_verified = true;
  }
  if (
    typeof req.refund_amount === "number" &&
    Number.isFinite(req.refund_amount)
  ) {
    order.refund_amount = Math.max(0, roundCurrency(req.refund_amount));
  } else if (
    req.fulfillment_status === "returned" ||
    req.fulfillment_status === "unpaid"
  ) {
    order.refund_amount = order.gross_sale_price;
  }

  const refund = order.refund_amount ?? 0;
  order.net_profit = roundCurrency(
    order.gross_sale_price -
      order.marketplace_fees -
      order.shipping_cost -
      refund
  );
  // If item is returned & restocked or unpaid, COGS is recovered back into inventory!
  const cogsDeducted =
    req.restockAndRelist ||
    order.restocked ||
    order.fulfillment_status === "unpaid"
      ? 0
      : order.cogs + (order.prep_cost ?? 0);
  order.true_net_after_cogs = roundCurrency(order.net_profit - cogsDeducted);

  let didRestock = false;
  if (req.restockAndRelist && !order.restocked) {
    order.restocked = true;
    didRestock = true;
    const existingItem = store.items.find(
      (i) => i.id === order.item_id || i.sku === order.sku
    );
    if (existingItem) {
      existingItem.status = "active";
      existingItem.updated_at = nowIso;
      const ebayLst = store.listings.find(
        (l) => l.item_id === existingItem.id && l.marketplace === "ebay"
      );
      if (ebayLst) {
        ebayLst.status = "active";
        ebayLst.listed_at = nowIso;
        ebayLst.views_count = 0;
        ebayLst.watchers_count = 0;
      } else {
        promoteDemoDraftToActive(existingItem.id);
      }
    } else {
      createDemoInventoryItem({
        title: order.title,
        sku: order.sku,
        cogs: order.cogs,
        prep_cost: order.prep_cost ?? 0,
        target_price: order.gross_sale_price,
        floor_price: roundCurrency(
          Math.max(order.cogs * 1.25, order.gross_sale_price * 0.7)
        ),
        bin_location: order.bin_location ?? "RET-01",
        source_location: order.source_location ?? "Returned Inventory",
        source_type: order.source_type ?? "thrift",
        acquired_at: order.acquired_at ?? nowIso,
        weight_oz: order.weight_oz ?? 16,
        notes: `Restocked from ${order.marketplace.toUpperCase()} order #${order.external_order_id || order.id}${order.return_reason ? ` — ${order.return_reason}` : ""}`,
        initialStatus: "active",
      });
    }
  }

  if (req.image_url !== undefined) {
    const cleanImg = req.image_url ? req.image_url.trim() : null;
    order.image_url = cleanImg;
    const linkedItem = store.items.find(
      (i) => i.id === order.item_id || i.sku === order.sku
    );
    if (linkedItem) {
      linkedItem.image_urls = cleanImg
        ? [cleanImg, ...(linkedItem.image_urls || []).filter((u) => u !== cleanImg)]
        : [];
      linkedItem.updated_at = nowIso;
    }
  }

  return { order, restocked: didRestock };
}

export function recordDemoLocalFacebookSale(input: {
  mode: "unlisted" | "existing";
  itemId?: string | null;
  title?: string;
  sku?: string | null;
  salePrice: number;
  soldAtIso: string;
  paymentMethod: string;
  buyerName?: string | null;
  notes?: string | null;
  bulkBuyId?: string | null;
  standaloneCogs: number;
  marketplaceFees: number;
  shippingCost: number;
  imageUrl?: string | null;
}): {
  orderId: string;
  itemId: string;
  sku: string;
  title: string;
  grossSalePrice: number;
  cogsApplied: number;
  delistedChannels: MarketplaceType[];
} {
  const store = getDemoStore();
  const nowIso = new Date().toISOString();
  const shortTag = Date.now().toString(36).slice(-5).toUpperCase();
  const delistedChannels: MarketplaceType[] = [];
  const cleanImage = input.imageUrl?.trim() || null;

  let item =
    input.mode === "existing" && input.itemId
      ? store.items.find((i) => i.id === input.itemId) || null
      : null;

  if (item) {
    item.status = "sold";
    item.payment_method = input.paymentMethod;
    item.updated_at = nowIso;
    if (cleanImage) {
      item.image_urls = [
        cleanImage,
        ...(item.image_urls || []).filter((u) => u !== cleanImage),
      ];
    }
    if (input.bulkBuyId) {
      item.item_specifics = {
        ...(item.item_specifics || {}),
        bulk_buy_id: input.bulkBuyId,
      };
    }
    for (const lst of store.listings) {
      if (lst.item_id !== item.id) continue;
      if (lst.marketplace === "facebook") {
        lst.status = "sold";
      } else if (lst.status === "active" || lst.status === "draft") {
        lst.status = "ended";
        delistedChannels.push(lst.marketplace);
      }
    }
  } else {
    const newItemId = `demo-fb-${Date.now()}-${shortTag}`;
    const sku = (input.sku || "").trim() || `FB-LOCAL-${shortTag}`;
    const title = (input.title || "Facebook Marketplace Local Sale").trim();
    item = {
      id: newItemId,
      sku,
      title,
      description_html: null,
      description_plain: input.notes || null,
      condition: "Used",
      brand: null,
      category_hint: "Facebook Local Pickup",
      cogs: roundCurrency(input.standaloneCogs),
      prep_cost: 0,
      target_price: roundCurrency(input.salePrice),
      floor_price: roundCurrency(input.salePrice),
      bin_location: "Local Pickup",
      source_location: "Facebook Local",
      source_type: "thrift",
      payment_method: input.paymentMethod,
      receipt_ref: null,
      tax_category: "inventory_cogs",
      notes: input.notes || null,
      weight_oz: null,
      length_in: null,
      width_in: null,
      height_in: null,
      item_specifics: {
        fb_local_only: "true",
        ...(input.bulkBuyId ? { bulk_buy_id: input.bulkBuyId } : {}),
      },
      image_urls: cleanImage ? [cleanImage] : [],
      status: "sold",
      acquired_at: input.soldAtIso,
      created_at: nowIso,
      updated_at: nowIso,
    };
    store.items.unshift(item);
  }

  const gross = roundCurrency(input.salePrice);
  const fees = roundCurrency(input.marketplaceFees);
  const ship = roundCurrency(input.shippingCost);
  const netProfit = roundCurrency(gross - fees - ship);
  const cogsApplied = roundCurrency(item.cogs || 0);
  const orderId = `ord-fb-local-${Date.now()}`;

  store.salesOrders.unshift({
    id: orderId,
    item_id: item.id,
    sku: item.sku,
    title: item.title,
    image_url: item.image_urls?.[0] || null,
    marketplace: "facebook",
    external_order_id: `FB-LOCAL-${shortTag}`,
    gross_sale_price: gross,
    marketplace_fees: fees,
    shipping_cost: ship,
    refund_amount: 0,
    cogs: cogsApplied,
    prep_cost: item.prep_cost ?? 0,
    source_location: item.source_location ?? "Facebook Local",
    source_type: item.source_type ?? "thrift",
    acquired_at: item.acquired_at,
    listed_at: item.created_at,
    bin_location: item.bin_location ?? "Local Pickup",
    bulk_buy_id: input.bulkBuyId ?? null,
    fulfillment_status: "shipped",
    tracking_number: `Local Pickup (${input.paymentMethod}${input.buyerName ? ` · ${input.buyerName}` : ""})`,
    shipped_at: input.soldAtIso,
    net_profit: netProfit,
    true_net_after_cogs: roundCurrency(netProfit - cogsApplied),
    sold_at: input.soldAtIso,
    delisted_channels: delistedChannels,
    source: "manual",
  });

  return {
    orderId,
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    grossSalePrice: gross,
    cogsApplied,
    delistedChannels,
  };
}
