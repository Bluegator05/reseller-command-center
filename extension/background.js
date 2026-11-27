/**
 * Reseller Command Center — Manifest V3 Background Service Worker
 *
 * Polls / subscribes to `channel_jobs` where `execution_mode = 'extension'`
 * via either the Command Center API bridge (`/api/extension/jobs`) or directly
 * via Supabase PostgREST (`rest/v1/channel_jobs`).
 *
 * Also proxies CDN image downloads as base64 data URLs so content scripts can
 * construct `File` objects and inject them via `DataTransfer` without page CORS issues.
 */

const POLL_ALARM_NAME = "rcc_poll_extension_jobs";
const SALE_WATCH_ALARM_NAME = "rcc_sale_watch_poll";
const EBAY_SYNC_ALARM_NAME = "rcc_auto_sync_ebay";
const MARKETPLACE_SYNC_ALARM_NAME = "rcc_auto_sync_marketplaces";
const MARKETPLACE_CREATE_URLS = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  facebook: "https://www.facebook.com/marketplace/create/item",
};

const DEFAULT_CONFIG = {
  mode: "api_bridge", // "api_bridge" | "supabase"
  apiBaseUrl: "https://reseller-command-center-black.vercel.app",
  ownerPasscode: "",
  supabaseUrl: "",
  supabaseAnonKey: "",
  autoPoll: true,
  pollIntervalMinutes: 0.5,
  autoPilot: false, // Turn ON on Mac Mini only; keep OFF on iMac / MacBook Air
  autoPilotSaveDraft: true, // Auto-click Save Draft on Poshmark & Mercari so drafts appear on iPhone
  autoSyncMarketplaces: true, // Auto-sync eBay (1h) + Poshmark & Mercari (3h) while Auto-Pilot is ON (FB stays manual)
  poshmarkClosetUrl: "", // Auto-detected from logged-in Poshmark session on Mac Mini
};

let autoPilotBusy = false;
let saleWatchBusy = false;
let inventorySyncBusy = false;

async function getConfig() {
  const stored = await chrome.storage.local.get(["rccConfig"]);
  return { ...DEFAULT_CONFIG, ...(stored.rccConfig || {}) };
}

async function saveConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ rccConfig: next });
  await configureAlarm(next);
  return next;
}

async function configureAlarm(config) {
  await chrome.alarms.clear(POLL_ALARM_NAME);
  await chrome.alarms.clear(SALE_WATCH_ALARM_NAME);
  await chrome.alarms.clear(EBAY_SYNC_ALARM_NAME);
  await chrome.alarms.clear(MARKETPLACE_SYNC_ALARM_NAME);
  if (config.autoPoll || config.autoPilot) {
    chrome.alarms.create(POLL_ALARM_NAME, {
      periodInMinutes: Math.max(0.5, Number(config.pollIntervalMinutes) || 0.5),
    });
  }
  // When Mac Mini Auto-Pilot is ON:
  // - Check eBay, Poshmark & Mercari for new sales every 10 minutes
  // - Auto-sync active eBay listings every 60 minutes (API) and Poshmark/Mercari every 3 hours (background tabs)
  if (config.autoPilot) {
    chrome.alarms.create(SALE_WATCH_ALARM_NAME, {
      periodInMinutes: 10,
    });
    if (config.autoSyncMarketplaces !== false) {
      chrome.alarms.create(EBAY_SYNC_ALARM_NAME, {
        periodInMinutes: 60,
      });
      chrome.alarms.create(MARKETPLACE_SYNC_ALARM_NAME, {
        periodInMinutes: 180,
      });
    }
  }
}

function buildBridgeHeaders(config, includeJson = false) {
  const headers = {};
  if (includeJson) headers["Content-Type"] = "application/json";
  if (config.ownerPasscode && config.ownerPasscode.trim()) {
    headers["x-owner-passcode"] = config.ownerPasscode.trim();
  }
  return headers;
}

async function fetchExtensionJobs() {
  const config = await getConfig();

  if (config.mode === "supabase" && config.supabaseUrl && config.supabaseAnonKey) {
    const base = config.supabaseUrl.replace(/\/+$/, "");
    const url = `${base}/rest/v1/channel_jobs?execution_mode=eq.extension&status=in.(pending,processing,needs_user_confirm)&order=created_at.asc&select=*,inventory_items(sku,title,brand,condition,image_urls,item_specifics)`;
    const res = await fetch(url, {
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase fetch failed (${res.status})`);
    const rows = await res.json();
    return rows.map((r) => ({
      ...r,
      item_sku: r.inventory_items?.sku || r.payload?.sku,
      item_title: r.inventory_items?.title || r.payload?.mappedTitle,
    }));
  }

  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/extension/jobs`, {
    headers: buildBridgeHeaders(config),
    credentials: "include",
  });
  if (res.status === 401) {
    throw new Error(
      "Owner passcode required — open Connection Settings below and enter your Command Center passcode."
    );
  }
  if (!res.ok) throw new Error(`API bridge fetch failed (${res.status})`);
  const data = await res.json();
  return data.jobs || [];
}

async function updateJobStatus(jobId, status, extra = {}) {
  const config = await getConfig();

  if (config.mode === "supabase" && config.supabaseUrl && config.supabaseAnonKey) {
    const base = config.supabaseUrl.replace(/\/+$/, "");
    const patchBody = {
      status,
      ...(status === "processing" ? { started_at: new Date().toISOString() } : {}),
      ...(status === "completed" || status === "failed"
        ? { completed_at: new Date().toISOString() }
        : {}),
      ...(extra.errorMessage ? { error_message: extra.errorMessage } : {}),
    };
    const res = await fetch(
      `${base}/rest/v1/channel_jobs?id=eq.${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: config.supabaseAnonKey,
          Authorization: `Bearer ${config.supabaseAnonKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(patchBody),
      }
    );
    if (!res.ok) throw new Error(`Supabase job update failed (${res.status})`);
    return res.json();
  }

  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");
  const res = await fetch(`${base}/api/extension/jobs`, {
    method: "PATCH",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
    body: JSON.stringify({ jobId, status, ...extra }),
  });
  if (res.status === 401) {
    throw new Error(
      "Owner passcode required — open Connection Settings below and enter your Command Center passcode."
    );
  }
  if (res.status === 409) {
    const conflict = await res.json().catch(() => ({}));
    return { alreadyClaimed: true, ...conflict };
  }
  if (!res.ok) throw new Error(`API bridge update failed (${res.status})`);
  return res.json();
}

async function updateBadgeCount(jobs, config) {
  const actionable = jobs.filter(
    (j) => j.status === "pending" || j.status === "needs_user_confirm"
  );
  const needsConfirm = jobs.some((j) => j.status === "needs_user_confirm");
  const badgeText =
    actionable.length > 0
      ? String(actionable.length)
      : config?.autoPilot
        ? "AP"
        : "";
  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setBadgeBackgroundColor({
    color: needsConfirm
      ? "#B45309"
      : actionable.length > 0
        ? "#1D4ED8"
        : "#0F766E",
  });
}

async function runAutoPilotCycle(jobs, config) {
  // Never start a second Auto-Pilot job while another tab is still publishing / waiting for URL capture
  if (!config?.autoPilot || autoPilotBusy || watchedPublishTabs.size > 0) return;
  const now = Date.now();

  // Priority 1 (URGENT — 0s delay): Auto-delist jobs run IMMEDIATELY to stop double-sells!
  const urgentDelist = [...(jobs || [])]
    .filter(
      (j) =>
        j.status === "pending" &&
        j.action === "delist" &&
        (j.marketplace === "poshmark" || j.marketplace === "mercari")
    )
    .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))[0];

  // Priority 2: Give a local iMac/MacBook Air interactive browser a 12-second head start on create jobs
  const createCandidate = urgentDelist
    ? null
    : [...(jobs || [])]
        .filter(
          (j) =>
            j.status === "pending" &&
            j.action === "create" &&
            (j.marketplace === "poshmark" || j.marketplace === "mercari") &&
            now - Date.parse(j.created_at || 0) >= 12000
        )
        .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))[0];

  const candidate = urgentDelist || createCandidate;
  if (!candidate) return;

  autoPilotBusy = true;
  try {
    await dispatchJobToTab(candidate, {
      autoPilot: true,
      autoPilotSaveDraft: config.autoPilotSaveDraft !== false,
    });
  } catch (err) {
    console.warn("[RCC Auto-Pilot] Job dispatch warning:", err);
  } finally {
    // Cooldown before picking up the next queued item
    setTimeout(() => {
      autoPilotBusy = false;
    }, 10000);
  }
}

async function refreshJobsCache(allowAutoPilot = false) {
  try {
    const config = await getConfig();
    const jobs = await fetchExtensionJobs();
    await chrome.storage.local.set({
      rccJobs: jobs,
      rccLastPollAt: new Date().toISOString(),
      rccLastError: null,
    });
    await updateBadgeCount(jobs, config);
    if (allowAutoPilot && config.autoPilot) {
      runAutoPilotCycle(jobs, config);
    }
    return { ok: true, jobs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ rccLastError: message });
    return { ok: false, error: message, jobs: [] };
  }
}

const dispatchedJobIds = new Set();

function isSyntheticFallbackUrlOrId(val) {
  const s = String(val || "").trim();
  if (!s) return false;
  return (
    /^(poshmark|mercari|facebook)-(?:draft-)?\d{5,}$/i.test(s) ||
    /\/(?:listing|item)\/(poshmark|mercari|facebook)-(?:draft-)?\d{5,}/i.test(s)
  );
}

function resolveDelistTargetUrl(job) {
  const extUrl = job?.payload?.externalUrl || "";
  const extId = job?.payload?.externalListingId || "";
  const isSynthetic =
    isSyntheticFallbackUrlOrId(extId) || isSyntheticFallbackUrlOrId(extUrl);

  if (job.marketplace === "poshmark") {
    const pmMatch =
      String(extId).match(/([0-9a-f]{24})/i) ||
      String(extUrl).match(/([0-9a-f]{24})/i);
    if (pmMatch) {
      return `https://poshmark.com/edit-listing/${pmMatch[1]}`;
    }
    if (!isSynthetic && extUrl && /poshmark\.com/i.test(extUrl)) {
      return extUrl;
    }
    // No real 24-hex listing ID — open Poshmark feed so poshmark.js can locate the live listing in the user's closet by title!
    return "https://poshmark.com/feed";
  }

  if (job.marketplace === "mercari") {
    if (extUrl && /\/mypage\/listings\/draft/i.test(extUrl)) {
      return "https://www.mercari.com/mypage/listings/draft/ready-to-list/?page=1";
    }
    const mcMatch =
      String(extId).match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i) ||
      String(extUrl).match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
    if (mcMatch) {
      return `https://www.mercari.com/sell/edit/${mcMatch[1]}/`;
    }
    // Items saved to Mercari Drafts (100-active cap) have no m... ID — open Drafts Ready-to-list directly!
    return "https://www.mercari.com/mypage/listings/draft/ready-to-list/?page=1";
  }

  return !isSynthetic && extUrl ? extUrl : null;
}

/**
 * Opens the target marketplace listing page and dispatches the job payload
 * once the content script finishes loading.
 */
async function dispatchJobToTab(job, options = {}) {
  if (job?.id && dispatchedJobIds.has(job.id)) {
    return { ok: true, alreadyDispatched: true };
  }
  const targetUrl =
    job.action === "delist"
      ? resolveDelistTargetUrl(job)
      : MARKETPLACE_CREATE_URLS[job.marketplace];

  if (!targetUrl) {
    throw new Error(`Unsupported or missing URL for ${job.marketplace} ${job.action} job`);
  }

  if (job?.id) dispatchedJobIds.add(job.id);
  const claimResult = await updateJobStatus(job.id, "processing");
  if (claimResult?.alreadyClaimed) {
    console.log(
      `[RCC] Skipping job ${job.id} — already claimed or listed:`,
      claimResult.error || ""
    );
    await refreshJobsCache(false);
    return { ok: true, alreadyClaimed: true };
  }

  const tab = await chrome.tabs.create({ url: targetUrl, active: true });

  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1400);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await chrome.tabs.sendMessage(tab.id, {
    type: "RCC_EXECUTE_JOB",
    job,
    autoPilot: Boolean(options.autoPilot),
    autoPilotSaveDraft: Boolean(options.autoPilotSaveDraft),
  });

  await refreshJobsCache(false);
  return { ok: true, tabId: tab.id };
}

/**
 * Fetches an external CDN image URL inside the service worker and returns
 * a base64 payload so the marketplace tab can build a File/Blob without CORS errors.
 */
async function fetchImageAsBase64(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return {
    base64: btoa(binary),
    mimeType: blob.type || "image/jpeg",
  };
}

/**
 * Injected into the currently open Poshmark Closet, Mercari Selling, or Facebook
 * Marketplace tab. Automatically scrolls down to trigger infinite-scroll lazy
 * loading until every active listing card is rendered, then extracts them all.
 */
async function scrapeActiveListingsFromDom(marketplace) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const linkSelector =
    marketplace === "poshmark"
      ? 'a[href*="/listing/"]'
      : marketplace === "mercari"
        ? 'a[href*="/us/item/m"], a[href*="/item/m"]'
        : 'a[href*="/marketplace/item/"], [role="button"], button';

  // Find scrollable container for Facebook Seller Hub (sometimes scrolls inside an inner pane)
  const scrollContainers = [];
  if (marketplace === "facebook") {
    for (const el of document.querySelectorAll('div[role="main"], div')) {
      const style = window.getComputedStyle(el);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 200 &&
        el.clientHeight > 300
      ) {
        scrollContainers.push(el);
        if (scrollContainers.length >= 3) break;
      }
    }
  }

  // Auto-scroll to load all lazy-loaded items on Poshmark / Mercari / FB
  let lastCount = document.querySelectorAll(linkSelector).length;
  let lastHeight =
    document.body.scrollHeight +
    scrollContainers.reduce((s, el) => s + el.scrollHeight, 0);
  let stablePasses = 0;

  for (let step = 0; step < 40; step++) {
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "instant",
    });
    for (const el of scrollContainers) {
      el.scrollTop = el.scrollHeight;
    }

    // Click Mercari/Poshmark "Load More" button if present
    const loadMoreBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => {
        const txt = (b.textContent || "").trim().toLowerCase();
        return txt === "load more" || txt === "show more" || txt === "see more";
      }
    );
    if (loadMoreBtn && !loadMoreBtn.disabled) {
      loadMoreBtn.click();
    }

    await sleep(850);

    const nextCount = document.querySelectorAll(linkSelector).length;
    const nextHeight =
      document.body.scrollHeight +
      scrollContainers.reduce((s, el) => s + el.scrollHeight, 0);
    if (nextCount === lastCount && nextHeight === lastHeight) {
      stablePasses += 1;
      if (stablePasses >= 2) break;
    } else {
      stablePasses = 0;
      lastCount = nextCount;
      lastHeight = nextHeight;
    }
  }

  window.scrollTo({ top: 0, behavior: "instant" });
  for (const el of scrollContainers) {
    el.scrollTop = 0;
  }

  const seen = new Set();
  const results = [];

  function extractPrice(text) {
    const m = (text || "").match(/\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
    if (!m) return 0;
    return Number(m[1].replace(/,/g, "")) || 0;
  }

  function isSoldOrInactive(containerText) {
    const cleaned = (containerText || "")
      .toLowerCase()
      // Active Facebook Seller Hub listings have a "Mark as sold" button — never treat that button text as sold!
      .replace(/\bmark\s+as\s+sold\b/g, "")
      .replace(/\bmark\s+as\s+pending\b/g, "");
    return (
      /\bsold\b/.test(cleaned) ||
      cleaned.includes("mark as available") ||
      cleaned.includes("out of stock") ||
      cleaned.includes("not for sale") ||
      cleaned.includes("deactivated") ||
      cleaned.includes("inactive")
    );
  }

  if (marketplace === "poshmark") {
    const links = Array.from(document.querySelectorAll('a[href*="/listing/"]'));
    for (const link of links) {
      const href = link.href || "";
      const idMatch = href.match(/([0-9a-f]{24})(?:[/?#]|$)/i);
      const extId = idMatch ? idMatch[1] : href;
      if (!extId || seen.has(extId)) continue;

      const card =
        link.closest('[data-et-name="listing"], .card, .tile, article, li') ||
        link.parentElement?.parentElement ||
        link;
      const cardText = card?.innerText || "";
      if (isSoldOrInactive(cardText)) continue;

      const titleEl = card?.querySelector(
        ".tile__title, [data-et-name='listing_title'], a.tile__title"
      );
      const imgAlt = card?.querySelector("img")?.getAttribute("alt") || "";
      const rawTitle =
        titleEl?.textContent?.trim() ||
        link.getAttribute("title")?.trim() ||
        imgAlt.trim() ||
        link.textContent?.trim() ||
        "";
      const cleanTitle = rawTitle.replace(/\s+/g, " ").trim();
      if (cleanTitle.length < 3) continue;

      seen.add(extId);
      results.push({
        externalListingId: extId,
        externalUrl: href.split("?")[0],
        title: cleanTitle,
        price: extractPrice(cardText),
      });
    }
  } else if (marketplace === "mercari") {
    const extractMercariId = (str) => {
      const m = String(str || "").match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
      return m ? m[1] : null;
    };
    const links = Array.from(
      document.querySelectorAll(
        'a[href*="/us/item/m"], a[href*="/item/m"], a[href*="/sell/edit/m"], a[href*="/mypage/listings/"]'
      )
    );
    for (const link of links) {
      const href = link.href || "";
      const row =
        link.closest('tr, [role="row"], [data-testid*="Item"], [data-testid*="Listing"], li, article') ||
        link.parentElement?.parentElement ||
        link;
      const extId =
        extractMercariId(href) ||
        extractMercariId(row?.querySelector("img")?.getAttribute("src")) ||
        extractMercariId(row?.innerHTML);
      if (!extId || seen.has(extId)) continue;

      const cardText = row?.innerText || link.innerText || "";
      if (isSoldOrInactive(cardText)) continue;

      const imgAlt = row?.querySelector("img")?.getAttribute("alt") || "";
      const linkText = (link.innerText || link.textContent || "").trim();
      const lines = cardText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length >= 3 && !/^\$[\d,.]+$/.test(s) && !/^promote$/i.test(s));
      const cleanTitle = (
        (linkText.length >= 4 ? linkText : "") ||
        imgAlt.trim() ||
        lines[0] ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (cleanTitle.length < 3) continue;

      seen.add(extId);
      results.push({
        externalListingId: extId,
        externalUrl: `https://www.mercari.com/us/item/${extId}/`,
        title: cleanTitle,
        price: extractPrice(cardText),
      });
    }
    // Fallback for Mercari seller table rows that identify items via CDN thumbnail URL (photos/mXXXXXXXXXXX_1.jpg)
    const imgs = Array.from(document.querySelectorAll("img[src]"));
    for (const img of imgs) {
      const extId = extractMercariId(img.getAttribute("src"));
      if (!extId || seen.has(extId)) continue;
      let row =
        img.closest('tr, [role="row"], [data-testid*="Item"], [data-testid*="Listing"], li, article') ||
        img.parentElement;
      for (let up = 0; up < 4 && row && (row.innerText || "").trim().length < 12; up++) {
        row = row.parentElement;
      }
      const cardText = row?.innerText || "";
      if (isSoldOrInactive(cardText)) continue;
      const lines = cardText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length >= 3 && !/^\$[\d,.]+$/.test(s) && !/^promote$/i.test(s));
      const cleanTitle = ((img.getAttribute("alt") || "").trim() || lines[0] || "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleanTitle.length < 3) continue;

      seen.add(extId);
      results.push({
        externalListingId: extId,
        externalUrl: `https://www.mercari.com/us/item/${extId}/`,
        title: cleanTitle,
        price: extractPrice(cardText),
      });
    }
  } else if (marketplace === "facebook") {
    const seenTitleKeys = new Set();

    const makeStableFbId = (titleStr) => {
      const norm = (titleStr || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      let h = 2166136261;
      for (let i = 0; i < norm.length; i++) {
        h ^= norm.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return `fb-${(h >>> 0).toString(36)}`;
    };

    const extractBestCardImage = (root) => {
      if (!root) return null;
      const imgs = Array.from(root.querySelectorAll("img[src]"));
      let best = null;
      let bestArea = 0;
      for (const img of imgs) {
        const src = (img.getAttribute("src") || "").trim();
        if (!src.startsWith("http") || src.includes("/emoji.php")) continue;
        const rect = img.getBoundingClientRect();
        const w = rect.width || img.naturalWidth || img.width || 0;
        const h = rect.height || img.naturalHeight || img.height || 0;
        if (w < 36 || h < 36) continue;
        const area = w * h;
        if (area > bestArea) {
          bestArea = area;
          best = src;
        }
      }
      return best;
    };

    const isFbNoiseLine = (line) => {
      const t = line.trim();
      if (t.length < 3) return true;
      if (/^\$[\d,.]+$/.test(t) || /^free$/i.test(t)) return true;
      if (
        /^(active|in stock|pending|sold|draft|out of stock|renew|expired)\b/i.test(
          t
        )
      ) {
        return true;
      }
      if (
        /^listed\s+on\b/i.test(t) ||
        /\bclicks?\s+on\s+listing\b/i.test(t) ||
        /^\d+\s+(clicks?|views?|saves?)\b/i.test(t)
      ) {
        return true;
      }
      if (
        /^(mark as sold|mark as pending|mark as available|offer shipping|boost listing|share|view listing|delete|edit|drop price|more|manage|send offer|list in more places|see all help topics|learn more|your listings|search your listings|create new listing|create multiple listings)$/i.test(
          t
        )
      ) {
        return true;
      }
      if (
        /^(boost your listings|keep your listings|this is a preview|sponsored|ad\b)/i.test(
          t
        )
      ) {
        return true;
      }
      return false;
    };

    const extractCleanFbTitle = (cardText, imgAlt) => {
      const lines = (cardText || "")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => !isFbNoiseLine(s));
      const candidate = lines[0] || (imgAlt || "").trim();
      return candidate.replace(/\s+/g, " ").trim();
    };

    const pushFbListing = ({ extId, externalUrl, title, price, imageUrl }) => {
      const cleanTitle = (title || "").replace(/\s+/g, " ").trim();
      if (cleanTitle.length < 3) return;
      const titleKey = cleanTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      const finalId = extId || makeStableFbId(cleanTitle);
      if (seen.has(finalId) || seenTitleKeys.has(titleKey)) return;
      seen.add(finalId);
      seenTitleKeys.add(titleKey);
      results.push({
        externalListingId: finalId,
        externalUrl:
          externalUrl || "https://www.facebook.com/marketplace/you/selling",
        title: cleanTitle,
        price: Number(price) || 0,
        imageUrl: imageUrl || null,
      });
    };

    // Pass 1: Facebook Seller Hub "Your listings" cards (/marketplace/you/selling)
    // Each active listing card has a "Mark as sold" button (and/or "Active · Listed on ...")
    const sellerHubAnchors = [];
    const buttons = Array.from(
      document.querySelectorAll('[role="button"], button')
    );
    for (const btn of buttons) {
      const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (txt === "mark as sold") {
        sellerHubAnchors.push(btn);
      }
    }

    const visitedCards = new Set();
    for (const anchor of sellerHubAnchors) {
      let node = anchor.parentElement;
      let card = null;
      for (let up = 0; up < 9 && node && node !== document.body; up++) {
        const markCount = Array.from(
          node.querySelectorAll('[role="button"], button')
        ).filter(
          (b) =>
            (b.innerText || b.textContent || "").trim().toLowerCase() ===
            "mark as sold"
        ).length;
        if (markCount > 1) break;

        const txt = node.innerText || "";
        const hasImg = Boolean(node.querySelector("img[src]"));
        const hasPriceOrFree =
          /\$\s*[0-9,]+/.test(txt) || /\bfree\b/i.test(txt);
        if (hasImg && hasPriceOrFree && txt.length >= 15 && txt.length <= 1600) {
          card = node;
          // Prefer the outermost single-listing card wrapper before hitting the list container
        }
        node = node.parentElement;
      }

      if (!card || visitedCards.has(card)) continue;
      visitedCards.add(card);

      const cardText = card.innerText || "";
      if (
        cardText.includes("Boost your listings to reach more buyers") ||
        cardText.includes("This is a preview of how your ad")
      ) {
        continue;
      }
      if (isSoldOrInactive(cardText)) continue;

      const itemLink = card.querySelector('a[href*="/marketplace/item/"]');
      const href = itemLink?.href || "";
      const idMatch = href.match(/\/marketplace\/item\/(\d+)/i);
      const imageUrl = extractBestCardImage(card);
      const imgAlt = card.querySelector("img[alt]")?.getAttribute("alt") || "";
      const cleanTitle = extractCleanFbTitle(cardText, imgAlt);

      pushFbListing({
        extId: idMatch ? idMatch[1] : null,
        externalUrl: href ? href.split("?")[0] : null,
        title: cleanTitle,
        price: extractPrice(cardText),
        imageUrl,
      });
    }

    // Pass 2: Fallback / profile view using <a href="/marketplace/item/..."> links
    const links = Array.from(
      document.querySelectorAll('a[href*="/marketplace/item/"]')
    );
    for (const link of links) {
      const href = link.href || "";
      const idMatch = href.match(/\/marketplace\/item\/(\d+)/i);
      const extId = idMatch ? idMatch[1] : null;
      if (extId && seen.has(extId)) continue;

      let card = link;
      if ((link.innerText || "").trim().length < 10 && link.parentElement) {
        card = link.parentElement.parentElement || link.parentElement;
      }
      const cardText = card?.innerText || link.innerText || "";
      if (
        cardText.includes("Boost your listings to reach more buyers") ||
        cardText.includes("This is a preview of how your ad")
      ) {
        continue;
      }
      if (isSoldOrInactive(cardText)) continue;

      const imageUrl = extractBestCardImage(card);
      const imgAlt = card?.querySelector("img")?.getAttribute("alt") || "";
      const cleanTitle = extractCleanFbTitle(cardText, imgAlt);

      pushFbListing({
        extId,
        externalUrl: href.split("?")[0],
        title: cleanTitle,
        price: extractPrice(cardText),
        imageUrl,
      });
    }
  }

  return results;
}

async function scanActiveTabAndImport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active browser tab found.");
  }

  let marketplace = null;
  if (tab.url.includes("poshmark.com")) marketplace = "poshmark";
  else if (tab.url.includes("mercari.com")) marketplace = "mercari";
  else if (tab.url.includes("facebook.com/marketplace")) marketplace = "facebook";

  if (!marketplace) {
    throw new Error(
      "Open your Poshmark Closet, Mercari Active Listings, or Facebook Marketplace Selling tab first, then click Scan Current Page."
    );
  }

  if (marketplace === "poshmark") {
    const closetMatch = tab.url.match(/https?:\/\/poshmark\.com\/closet\/([^/?#]+)/i);
    if (closetMatch?.[1]) {
      const normalizedCloset = `https://poshmark.com/closet/${closetMatch[1]}`;
      await saveConfig({ poshmarkClosetUrl: normalizedCloset });
    }
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeActiveListingsFromDom,
    args: [marketplace],
  });

  const listings = injected?.[0]?.result || [];
  if (listings.length === 0) {
    throw new Error(
      `No active ${marketplace} listings detected on this page. Make sure you are on your Closet / Active Listings page and scroll down to load items.`
    );
  }

  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/extension/import-listings`, {
    method: "POST",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
    body: JSON.stringify({ marketplace, listings }),
  });

  if (res.status === 401) {
    throw new Error(
      "Owner passcode required — enter your Command Center passcode in Connection Settings below."
    );
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Import failed (${res.status})`);
  }

  await refreshJobsCache();
  if (data.matchedCount > 0) {
    await broadcastToCommandCenterTabs({
      type: "RCC_JOB_COMPLETED",
      marketplace,
      sku: "",
    });
  }
  return { ok: true, ...data };
}

async function importStandaloneListings(payload) {
  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/extension/import-listings`, {
    method: "POST",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
    body: JSON.stringify({
      marketplace: payload.marketplace || "facebook",
      action: "import_standalone",
      listings: Array.isArray(payload.listings) ? payload.listings : [],
    }),
  });

  if (res.status === 401) {
    throw new Error(
      "Owner passcode required — enter your Command Center passcode in Connection Settings below."
    );
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Standalone import failed (${res.status})`);
  }
  return { ok: true, ...data };
}

async function markMarketplacePolicyBlocked({
  jobId,
  itemId,
  marketplace,
  rule,
  reason,
}) {
  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  if (itemId && marketplace) {
    try {
      await fetch(`${base}/api/inventory`, {
        method: "POST",
        headers: buildBridgeHeaders(config, true),
        credentials: "include",
        body: JSON.stringify({
          action: "set_marketplace_policy_block",
          itemId,
          marketplace,
          blocked: true,
          rule: rule || `${marketplace.toUpperCase()} Policy Block`,
          reason:
            reason ||
            "Flagged as prohibited by marketplace validation during publishing.",
          source: "manual",
        }),
      });
    } catch (err) {
      console.warn("[RCC] Failed to persist policy block:", err);
    }
  }

  if (jobId) {
    try {
      await updateJobStatus(jobId, "failed", {
        errorMessage:
          reason ||
          `${marketplace || "Marketplace"} flagged this listing as a potential prohibited item — marked Policy Blocked on Inventory.`,
      });
    } catch (err) {
      console.warn("[RCC] Failed to mark blocked job failed:", err);
    }
  }

  await refreshJobsCache(false);
  return { ok: true, policyBlocked: true };
}

async function waitForTabLoad(tabId, settleMs = 2200, timeoutMs = 18000) {
  await new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") {
        setTimeout(done, settleMs);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeoutMs);
  });
}

/**
 * Resolves the logged-in user's Poshmark Closet URL automatically (zero manual setup):
 * 1. Uses cached `config.poshmarkClosetUrl` if already learned.
 * 2. Scans open `poshmark.com/closet/<user>` tabs.
 * 3. Inspects any open Poshmark tab (or quietly opens `poshmark.com/feed` in a temp background tab)
 *    to read the logged-in user's own My Closet link / handle.
 */
async function resolvePoshmarkClosetUrl() {
  const config = await getConfig();
  if (
    config.poshmarkClosetUrl &&
    /^https:\/\/poshmark\.com\/closet\/[^/?#]+/i.test(config.poshmarkClosetUrl)
  ) {
    return config.poshmarkClosetUrl.replace(/\?.*$/, "");
  }

  const poshTabs = await chrome.tabs.query({ url: "https://poshmark.com/*" });
  for (const t of poshTabs) {
    const m = (t.url || "").match(/https?:\/\/poshmark\.com\/closet\/([^/?#]+)/i);
    if (m?.[1]) {
      const url = `https://poshmark.com/closet/${m[1]}`;
      await saveConfig({ poshmarkClosetUrl: url });
      return url;
    }
  }

  const extractHandleFromPage = () => {
    // 1. Check navbar "My Closet" link explicitly
    const allClosetLinks = Array.from(document.querySelectorAll('a[href*="/closet/"]'));
    for (const a of allClosetLinks) {
      const txt = (a.textContent || "").trim().toLowerCase();
      const href = a.getAttribute("href") || a.href || "";
      if (
        txt.includes("my closet") ||
        a.getAttribute("data-et-name") === "my_closet" ||
        a.closest("header, nav, .header__account-info, .dropdown__menu")
      ) {
        const m = href.match(/\/closet\/([^/?#]+)/i);
        if (m?.[1] && !/^(all|women|men|kids|home)$/i.test(m[1])) {
          return m[1];
        }
      }
    }
    // 2. Fallback: look for logged-in username in embedded JSON / page state
    try {
      const state = window.__INITIAL_STATE__;
      const u =
        state?.$_user?.user?.username ||
        state?.user?.username ||
        state?.session?.user?.username;
      if (typeof u === "string" && u.trim()) return u.trim();
    } catch {
      // ignore
    }
    // 3. Fallback: scan inline script text for logged-in username
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const txt = s.textContent || "";
      if (txt.includes('"logged_in":true') || txt.includes("$_user")) {
        const m = txt.match(/"username"\s*:\s*"([a-zA-Z0-9_.-]{2,40})"/);
        if (m?.[1]) return m[1];
      }
    }
    return null;
  };

  let tabToInspect = poshTabs.find((t) => t.id);
  let createdTemp = false;
  if (!tabToInspect) {
    tabToInspect = await chrome.tabs.create({
      url: "https://poshmark.com/feed",
      active: false,
    });
    createdTemp = true;
    await waitForTabLoad(tabToInspect.id, 2200, 15000);
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabToInspect.id },
      func: extractHandleFromPage,
    });
    const handle = res?.[0]?.result;
    if (handle) {
      const url = `https://poshmark.com/closet/${handle}`;
      await saveConfig({ poshmarkClosetUrl: url });
      return url;
    }
  } finally {
    if (createdTemp && tabToInspect?.id) {
      chrome.tabs.remove(tabToInspect.id).catch(() => {});
    }
  }

  return null;
}

async function syncEbayActiveListings() {
  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/ebay/sync`, {
    method: "POST",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
  });

  if (res.status === 401) {
    throw new Error("Owner passcode required for eBay sync.");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `eBay sync failed (${res.status})`);
  }
  return {
    ok: true,
    syncedCount: Number(data.syncedCount || 0),
    createdCount: Number(data.createdCount || 0),
    updatedCount: Number(data.updatedCount || 0),
  };
}

/**
 * Quietly opens a background tab to Poshmark Closet or Mercari Active Listings,
 * runs `scrapeActiveListingsFromDom`, syncs to `/api/extension/import-listings`,
 * and closes the temporary background tab when done.
 */
async function syncMarketplaceListingsBackground(marketplace) {
  if (marketplace !== "poshmark" && marketplace !== "mercari") {
    throw new Error(`Background auto-sync not enabled for ${marketplace}`);
  }

  let targetUrl = "https://www.mercari.com/mypage/listings/active/";
  if (marketplace === "poshmark") {
    const closetUrl = await resolvePoshmarkClosetUrl();
    if (!closetUrl) {
      throw new Error(
        "Could not detect Poshmark closet URL — open your Poshmark Closet tab once while signed in."
      );
    }
    targetUrl = `${closetUrl}?availability=available`;
  }

  const created = await chrome.tabs.create({ url: targetUrl, active: false });
  let listings = [];
  try {
    await waitForTabLoad(created.id, 2500, 20000);
    const injected = await chrome.scripting.executeScript({
      target: { tabId: created.id },
      func: scrapeActiveListingsFromDom,
      args: [marketplace],
    });
    listings = injected?.[0]?.result || [];
  } finally {
    if (created?.id) {
      chrome.tabs.remove(created.id).catch(() => {});
    }
  }

  if (listings.length === 0) {
    return {
      ok: true,
      marketplace,
      scannedCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
    };
  }

  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/extension/import-listings`, {
    method: "POST",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
    body: JSON.stringify({ marketplace, listings }),
  });

  if (res.status === 401) {
    throw new Error("Owner passcode required for marketplace sync.");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `${marketplace} import failed (${res.status})`);
  }

  return {
    ok: true,
    marketplace,
    scannedCount: Number(data.scannedCount || listings.length),
    matchedCount: Number(data.matchedCount || 0),
    unmatchedCount: Number(data.unmatchedCount || 0),
  };
}

/**
 * Hands-free active listings sync across eBay (API), Poshmark, and Mercari
 * (Facebook stays manual). Collision-safe: skips background browser scraping
 * while an Auto-Pilot cross-list or 10-min sale check is actively running.
 */
async function runFullMarketplaceSync({
  includeEbay = true,
  includePoshmark = true,
  includeMercari = true,
  manual = false,
} = {}) {
  if (inventorySyncBusy) {
    return { ok: true, skipped: true, message: "Marketplace sync already running." };
  }
  if (
    !manual &&
    (includePoshmark || includeMercari) &&
    (autoPilotBusy || saleWatchBusy || watchedPublishTabs.size > 0)
  ) {
    return {
      ok: true,
      skipped: true,
      message: "Deferred sync — cross-list or sale watcher is currently active.",
    };
  }

  inventorySyncBusy = true;
  const result = {
    at: new Date().toISOString(),
    ebaySynced: null,
    poshScanned: null,
    poshMatched: null,
    mercariScanned: null,
    mercariMatched: null,
    errors: [],
  };

  try {
    if (includeEbay) {
      try {
        const eb = await syncEbayActiveListings();
        result.ebaySynced = eb.syncedCount;
      } catch (err) {
        result.errors.push(`eBay: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (includePoshmark) {
      try {
        const pm = await syncMarketplaceListingsBackground("poshmark");
        result.poshScanned = pm.scannedCount;
        result.poshMatched = pm.matchedCount;
      } catch (err) {
        result.errors.push(
          `Poshmark: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (includeMercari) {
      try {
        const mc = await syncMarketplaceListingsBackground("mercari");
        result.mercariScanned = mc.scannedCount;
        result.mercariMatched = mc.matchedCount;
      } catch (err) {
        result.errors.push(
          `Mercari: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const parts = [];
    if (result.ebaySynced !== null) parts.push(`eBay ${result.ebaySynced}`);
    if (result.poshScanned !== null) {
      parts.push(`Posh ${result.poshScanned} (${result.poshMatched} linked)`);
    }
    if (result.mercariScanned !== null) {
      parts.push(`Mercari ${result.mercariScanned} (${result.mercariMatched} linked)`);
    }

    const summaryText =
      parts.length > 0
        ? parts.join(" · ")
        : result.errors.length > 0
          ? result.errors.join(" | ")
          : "Sync complete";

    const storedPrev = (await chrome.storage.local.get(["rccLastMarketplaceSync"]))
      .rccLastMarketplaceSync || {};
    const mergedRecord = {
      ...storedPrev,
      at: result.at,
      ...(result.ebaySynced !== null ? { ebaySynced: result.ebaySynced, ebayAt: result.at } : {}),
      ...(result.poshScanned !== null
        ? {
            poshScanned: result.poshScanned,
            poshMatched: result.poshMatched,
            poshAt: result.at,
          }
        : {}),
      ...(result.mercariScanned !== null
        ? {
            mercariScanned: result.mercariScanned,
            mercariMatched: result.mercariMatched,
            mercariAt: result.at,
          }
        : {}),
      summary: summaryText,
      errors: result.errors,
    };

    await chrome.storage.local.set({ rccLastMarketplaceSync: mergedRecord });
    await broadcastToCommandCenterTabs({
      type: "RCC_JOB_COMPLETED",
      marketplace: "all",
      sku: summaryText,
    });

    return {
      ok: result.errors.length === 0 || parts.length > 0,
      ...result,
      lastMarketplaceSync: mergedRecord,
      message:
        result.errors.length > 0
          ? `${summaryText} (Note: ${result.errors.join("; ")})`
          : `Synced ${summaryText}`,
    };
  } finally {
    inventorySyncBusy = false;
  }
}

/**
 * Injected into Poshmark My Sales (/order/sales) or Mercari My Listings (Sold -> Complete & In progress).
 * Auto-scrolls to load all historical sales and extracts order ID, title, gross price, fees, date, and status.
 */
async function scrapeSoldOrdersFromDom(marketplace) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const seen = new Set();

  function parseDateFromText(text) {
    const raw = String(text || "");
    const now = new Date();
    // 1. "Oct 14, 2026" or "Oct 14 2026" or "October 14, 2026"
    const mFull = raw.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i
    );
    if (mFull) {
      const ms = Date.parse(`${mFull[1]} ${mFull[2]}, ${mFull[3]}`);
      if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    }
    // 2. "MM/DD/YYYY" or "MM/DD/YY"
    const mSlash = raw.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2}|\d{2})\b/);
    if (mSlash) {
      const yr = mSlash[3].length === 2 ? `20${mSlash[3]}` : mSlash[3];
      const ms = Date.parse(`${yr}-${mSlash[1].padStart(2, "0")}-${mSlash[2].padStart(2, "0")}T12:00:00Z`);
      if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    }
    // 3. "YYYY-MM-DD"
    const mIso = raw.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
    if (mIso) {
      const ms = Date.parse(`${mIso[0]}T12:00:00Z`);
      if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    }
    // 4. "Oct 14" (no year -> infer current or prior year)
    const mShort = raw.match(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})\b/i
    );
    if (mShort) {
      let yr = now.getFullYear();
      let ms = Date.parse(`${mShort[1]} ${mShort[2]}, ${yr}`);
      if (!Number.isNaN(ms)) {
        if (ms > now.getTime() + 2 * 86400000) {
          yr -= 1;
          ms = Date.parse(`${mShort[1]} ${mShort[2]}, ${yr}`);
        }
        if (!Number.isNaN(ms)) return new Date(ms).toISOString();
      }
    }
    return null;
  }

  function extractDollars(text) {
    const matches = Array.from(String(text || "").matchAll(/\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/g));
    return matches
      .map((m) => Number(m[1].replace(/,/g, "")))
      .filter((n) => Number.isFinite(n) && n >= 0);
  }

  function inferStatus(text, fallback = "shipped") {
    const lower = String(text || "").toLowerCase();
    if (/\bcancel(?:ed|led)\b/.test(lower)) return "unpaid";
    if (/\b(return(?:ed)?|refund(?:ed)?)\b/.test(lower)) return "returned";
    if (
      /\b(pending shipment|awaiting shipment|not shipped|ship by|to ship|in progress|print label|waiting for shipment)\b/.test(
        lower
      )
    ) {
      return "to_ship";
    }
    if (/\b(delivered|complete|completed|shipped|in transit|accepted|rated)\b/.test(lower)) {
      return "shipped";
    }
    return fallback;
  }

  async function autoScrollAll(itemSelector) {
    let lastCount = document.querySelectorAll(itemSelector).length;
    let lastHeight = document.body.scrollHeight;
    let stable = 0;

    for (let step = 0; step < 35; step++) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
      const moreBtn = Array.from(document.querySelectorAll("button, a")).find((b) => {
        if (b.disabled) return false;
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = (b.textContent || "").trim().toLowerCase();
        return t === "load more" || t === "show more" || t === "see more" || t === "view more";
      });
      if (moreBtn) moreBtn.click();
      await sleep(800);

      const nextCount = document.querySelectorAll(itemSelector).length;
      const nextHeight = document.body.scrollHeight;
      if (nextCount === lastCount && nextHeight === lastHeight) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
        lastCount = nextCount;
        lastHeight = nextHeight;
      }
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  if (marketplace === "poshmark") {
    await autoScrollAll('a[href*="/order/sales/"], a[href*="/listing/"]');

    // Strategy 1: Poshmark /order/sales rows
    const orderLinks = Array.from(
      document.querySelectorAll('a[href*="/order/sales/"], a[href*="/sales/"]')
    ).filter((a) => /[0-9a-f]{24}/i.test(a.getAttribute("href") || ""));

    for (const link of orderLinks) {
      const href = link.getAttribute("href") || "";
      const idMatch = href.match(/([0-9a-f]{24})/i);
      const orderId = idMatch ? idMatch[1] : "";
      if (!orderId || seen.has(orderId)) continue;

      let card =
        link.closest('.order-item, .card, li, tr, article, [data-et-name*="order"]') ||
        link.parentElement;
      for (let up = 0; up < 4 && card && (card.innerText || "").trim().length < 20; up++) {
        card = card.parentElement;
      }
      const cardText = (card?.innerText || link.innerText || "").trim();
      const listingLink = card?.querySelector('a[href*="/listing/"]');
      const listingMatch = (listingLink?.getAttribute("href") || "").match(/([0-9a-f]{24})/i);
      const listingId = listingMatch ? listingMatch[1] : null;

      const cardImg = card?.querySelector("img");
      const imgAlt = (cardImg?.getAttribute("alt") || "").trim();
      const rawImgSrc =
        cardImg?.currentSrc ||
        cardImg?.getAttribute("src") ||
        cardImg?.getAttribute("data-src") ||
        "";
      const imageUrl = /^https?:\/\//i.test(rawImgSrc) ? rawImgSrc : null;
      const lines = cardText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(
          (s) =>
            s.length >= 4 &&
            !/^\$/.test(s) &&
            !/^@/.test(s) &&
            !/^(order|sold|shipped|delivered|cancelled|canceled|returned|pending|earnings|net|total|buyer|size|qty|view|track)/i.test(
              s
            ) &&
            !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(s) &&
            !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)
        );
      const title = (imgAlt.length >= 4 ? imgAlt : lines[0] || "").replace(/\s+/g, " ").trim();
      if (title.length < 3) continue;

      // Extract sale price & optional exact earnings
      const prices = extractDollars(cardText);
      const gross = prices.find((p) => p > 0) ?? 0;
      const earnMatch = cardText.match(
        /(?:earnings|you earn|net earnings)[^\n$]*\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/i
      );
      let fees = null;
      if (earnMatch && gross > 0) {
        const earnings = Number(earnMatch[1].replace(/,/g, ""));
        if (Number.isFinite(earnings) && earnings >= 0 && earnings <= gross) {
          fees = Math.round((gross - earnings) * 100) / 100;
        }
      }

      seen.add(orderId);
      results.push({
        externalOrderId: orderId,
        externalListingId: listingId,
        title,
        imageUrl,
        grossSalePrice: gross,
        marketplaceFees: fees,
        shippingCost: 0,
        fulfillmentStatus: inferStatus(cardText, "shipped"),
        soldAt: parseDateFromText(cardText),
      });
    }

    // Strategy 2: Fallback if user is on Sold Closet (?availability=sold_out)
    if (results.length === 0) {
      const listingLinks = Array.from(document.querySelectorAll('a[href*="/listing/"]'));
      for (const link of listingLinks) {
        const href = link.getAttribute("href") || "";
        const idMatch = href.match(/([0-9a-f]{24})/i);
        const extId = idMatch ? idMatch[1] : "";
        if (!extId || seen.has(extId)) continue;
        const card =
          link.closest('[data-et-name="listing"], .card, .tile, article, li') ||
          link.parentElement?.parentElement;
        const cardText = (card?.innerText || "").trim();
        if (!/\bsold\b/i.test(cardText) && !window.location.search.includes("sold_out")) {
          continue;
        }
        const titleEl = card?.querySelector(".tile__title, [data-et-name='listing_title']");
        const tileImg = card?.querySelector("img");
        const tileImgSrc =
          tileImg?.currentSrc ||
          tileImg?.getAttribute("src") ||
          tileImg?.getAttribute("data-src") ||
          "";
        const title = (
          titleEl?.textContent ||
          link.getAttribute("title") ||
          tileImg?.getAttribute("alt") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (title.length < 3) continue;
        const prices = extractDollars(cardText);
        const gross = prices.find((p) => p > 0) ?? 0;

        seen.add(extId);
        results.push({
          externalOrderId: extId,
          externalListingId: extId,
          title,
          imageUrl: /^https?:\/\//i.test(tileImgSrc) ? tileImgSrc : null,
          grossSalePrice: gross,
          marketplaceFees: null,
          shippingCost: 0,
          fulfillmentStatus: "shipped",
          soldAt: parseDateFromText(cardText),
        });
      }
    }

    return results;
  }

  if (marketplace === "mercari") {
    const extractMercariId = (str) => {
      const m = String(str || "").match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
      return m ? m[1] : null;
    };

    const clickSoldNavItem = async (labelRegex) => {
      const navCandidates = Array.from(
        document.querySelectorAll('a, button, [role="button"], li, div')
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.left > 340 || r.height > 64) return false;
        const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return labelRegex.test(t) && t.length <= 32;
      });
      // Prefer innermost matching element
      navCandidates.sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height
      );
      const target = navCandidates[0];
      if (!target) return false;
      target.click();
      await sleep(2000);
      return true;
    };

    const scrapeCurrentMercariView = async (defaultStatus) => {
      await autoScrollAll('a[href*="m"], img[src*="mercdn"]');
      const candidates = [];

      // 1. Anchors containing Mercari item/order ID
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") || "";
        const row =
          a.closest('tr, [role="row"], [data-testid*="Item"], [data-testid*="Listing"], [data-testid*="Order"], li, article') ||
          a.parentElement?.parentElement ||
          a;
        const id =
          extractMercariId(href) ||
          extractMercariId(row?.querySelector("img")?.getAttribute("src")) ||
          extractMercariId(row?.innerHTML);
        if (id) candidates.push({ id, row, link: a });
      }

      // 2. Mercari CDN thumbnails (photos/mXXXXXXXXXXX_1.jpg)
      for (const img of Array.from(document.querySelectorAll("img[src]"))) {
        const id = extractMercariId(img.getAttribute("src"));
        if (!id) continue;
        let row =
          img.closest('tr, [role="row"], [data-testid*="Item"], [data-testid*="Listing"], [data-testid*="Order"], li, article') ||
          img.parentElement;
        for (let up = 0; up < 4 && row && (row.innerText || "").trim().length < 12; up++) {
          row = row.parentElement;
        }
        candidates.push({ id, row, link: null, img });
      }

      for (const item of candidates) {
        if (!item.id || seen.has(item.id)) continue;
        const rowText = (item.row?.innerText || "").trim();
        const linkText = (item.link?.innerText || item.link?.textContent || "").trim();
        const rowImg = item.img || item.row?.querySelector("img");
        const imgAlt = (rowImg?.getAttribute("alt") || "").trim();
        const rawImgSrc =
          rowImg?.currentSrc ||
          rowImg?.getAttribute("src") ||
          rowImg?.getAttribute("data-src") ||
          "";
        const imageUrl = /^https?:\/\//i.test(rawImgSrc) ? rawImgSrc : null;

        const lines = rowText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(
            (s) =>
              s.length >= 4 &&
              !/^\$/.test(s) &&
              !/^(promote|relist|delete|view order|order status|completed|complete|in progress|sold|shipped|delivered|cancelled|canceled|n\/a|\d+)$/i.test(
                s
              ) &&
              !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(s) &&
              !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)
          );

        const title = (
          (linkText.length >= 4 && !/^\$/.test(linkText) ? linkText : "") ||
          (imgAlt.length >= 4 && !/^product photo$/i.test(imgAlt) ? imgAlt : "") ||
          lines[0] ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (title.length < 3) continue;

        const prices = extractDollars(rowText);
        let gross = prices.find((p) => p > 0) ?? 0;
        if (gross === 0) {
          const inp = item.row?.querySelector("input");
          if (inp && Number(inp.value) > 0) gross = Number(inp.value);
        }

        const earnMatch = rowText.match(
          /(?:you earn|net proceeds|earnings)[^\n$]*\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/i
        );
        let fees = null;
        if (earnMatch && gross > 0) {
          const earnings = Number(earnMatch[1].replace(/,/g, ""));
          if (Number.isFinite(earnings) && earnings >= 0 && earnings <= gross) {
            fees = Math.round((gross - earnings) * 100) / 100;
          }
        }

        seen.add(item.id);
        results.push({
          externalOrderId: item.id,
          externalListingId: item.id,
          title,
          imageUrl,
          grossSalePrice: gross,
          marketplaceFees: fees,
          shippingCost: 0,
          fulfillmentStatus: inferStatus(rowText, defaultStatus),
          soldAt: parseDateFromText(rowText),
        });
      }
    };

    const currentUrl = window.location.href.toLowerCase();
    const alreadyOnSoldView =
      currentUrl.includes("/completed") ||
      currentUrl.includes("/complete") ||
      currentUrl.includes("/in_progress") ||
      currentUrl.includes("/sold");

    if (alreadyOnSoldView) {
      await scrapeCurrentMercariView(
        currentUrl.includes("in_progress") ? "to_ship" : "shipped"
      );
    } else {
      // Starting on /mypage/listings/active/ -> click "Complete" under Sold, then "In progress"
      const clickedComplete = await clickSoldNavItem(/^complete\b/i);
      if (clickedComplete) {
        await scrapeCurrentMercariView("shipped");
      }
      const clickedInProgress = await clickSoldNavItem(/^in progress\b/i);
      if (clickedInProgress) {
        await scrapeCurrentMercariView("to_ship");
      }
    }

    return results;
  }

  if (marketplace === "etsy") {
    const extractEtsyOrderImage = (root) => {
      if (!root) return null;
      const imgs = Array.from(root.querySelectorAll("img[src]"));
      for (const img of imgs) {
        const src = (img.getAttribute("src") || "").trim();
        if (!src.startsWith("http")) continue;
        if (/avatar|profile|icon|badge|emoji/i.test(src)) continue;
        const r = img.getBoundingClientRect();
        const w = r.width || img.naturalWidth || img.width || 0;
        if (w > 0 && w < 28) continue;
        return src;
      }
      return null;
    };

    const isEtsyNoiseLine = (line) => {
      const t = line.trim();
      if (t.length < 3) return true;
      if (/^\$[\d,.]+$/.test(t) || /^free$/i.test(t)) return true;
      if (/^#\d{7,13}$/.test(t)) return true;
      if (
        /^(ordered|ship by|shipped|delivered|completed|new|open|in transit|pre-transit|tracking|quantity|qty|sku|buyer|ship to|order total|item total|subtotal|shipping|tax|discount|message|print|get shipping labels|mark complete|update progress|private note|receipt|gift|paid|not shipped|overdue|canceled|cancelled|refunded)\b/i.test(
          t
        )
      ) {
        return true;
      }
      return false;
    };

    const scrapeCurrentEtsyOrdersView = (defaultStatus) => {
      // Find individual Etsy order cards by anchoring on order # / receipt_id links or order containers
      const cardCandidates = new Set();

      const receiptAnchors = Array.from(
        document.querySelectorAll(
          'a[href*="receipt_id="], a[href*="/your/orders/sold/"], [data-test-id*="order"], .panel-body-row, [class*="order-card"]'
        )
      );

      for (const el of receiptAnchors) {
        let node = el;
        let bestCard = null;
        for (let up = 0; up < 7 && node && node !== document.body; up++) {
          const txt = node.innerText || "";
          const orderNums = Array.from(
            new Set(
              Array.from(txt.matchAll(/#(\d{8,12})\b/g)).map((m) => m[1])
            )
          );
          if (orderNums.length > 1) break;
          if (
            orderNums.length === 1 &&
            /\$\s*[0-9,]+/.test(txt) &&
            txt.length >= 20 &&
            txt.length <= 4000
          ) {
            bestCard = node;
          }
          node = node.parentElement;
        }
        if (bestCard) cardCandidates.add(bestCard);
      }

      // Fallback: walk from any element containing "#1234567890" order number text
      if (cardCandidates.size === 0) {
        const allEls = Array.from(document.querySelectorAll("a, span, div, h2, h3, p"));
        for (const el of allEls) {
          if (el.children.length > 2) continue;
          const ownTxt = (el.textContent || "").trim();
          if (!/^#?\d{8,12}$/.test(ownTxt) && !/#\d{8,12}\b/.test(ownTxt)) {
            continue;
          }
          let node = el.parentElement;
          let bestCard = null;
          for (let up = 0; up < 8 && node && node !== document.body; up++) {
            const txt = node.innerText || "";
            const orderNums = Array.from(
              new Set(
                Array.from(txt.matchAll(/#(\d{8,12})\b/g)).map((m) => m[1])
              )
            );
            if (orderNums.length > 1) break;
            if (
              orderNums.length === 1 &&
              /\$\s*[0-9,]+/.test(txt) &&
              txt.length >= 20 &&
              txt.length <= 4000
            ) {
              bestCard = node;
            }
            node = node.parentElement;
          }
          if (bestCard) cardCandidates.add(bestCard);
        }
      }

      for (const card of cardCandidates) {
        const cardText = card.innerText || "";
        const receiptLink = card.querySelector(
          'a[href*="receipt_id="], a[href*="/your/orders/sold/"]'
        );
        const receiptHref = receiptLink?.getAttribute("href") || "";
        const receiptIdMatch =
          receiptHref.match(/receipt_id=(\d{7,13})/i) ||
          receiptHref.match(/\/sold\/(\d{7,13})/i) ||
          cardText.match(/#(\d{8,12})\b/);
        const receiptId = receiptIdMatch?.[1];
        if (!receiptId) continue;

        const skuMatch = cardText.match(/\bSKU\s*:?\s*([^\n\r]+)/i);
        const sku = skuMatch ? skuMatch[1].trim().slice(0, 80) : null;

        const orderTotalMatch = cardText.match(
          /(?:order\s+total|item\s+total|total)\s*:?\s*\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/i
        );
        const dollars = extractDollars(cardText);
        const cardPrice = orderTotalMatch
          ? Number(orderTotalMatch[1].replace(/,/g, "")) || 0
          : dollars.length > 0
            ? dollars[0]
            : 0;

        const soldAt = parseDateFromText(cardText);
        const fulfillmentStatus = inferStatus(cardText, defaultStatus);
        const cardImage = extractEtsyOrderImage(card);

        const extractQtyFromText = (txt) => {
          const s = String(txt || "");
          const mLabel = s.match(/\b(?:quantity|qty)\s*:?\s*[\r\n\s]*(\d{1,3})\b/i);
          if (mLabel) {
            const n = Number(mLabel[1]);
            if (Number.isFinite(n) && n >= 1 && n <= 999) return n;
          }
          const mTimesPrice = s.match(/(?:^|\s)(\d{1,3})\s*[×x]\s*\$\s*[0-9]/i);
          if (mTimesPrice) {
            const n = Number(mTimesPrice[1]);
            if (Number.isFinite(n) && n >= 1 && n <= 999) return n;
          }
          return null;
        };

        const cardQuantity = extractQtyFromText(cardText) ?? 1;

        // Extract distinct listing links inside this order card (supports multi-item orders)
        const listingLinks = Array.from(
          card.querySelectorAll('a[href*="/listing/"]')
        );
        const seenListingIds = new Set();
        const itemsInOrder = [];

        for (const a of listingLinks) {
          const href = a.getAttribute("href") || "";
          const lidMatch = href.match(/\/listing\/(\d+)/i);
          const listingId = lidMatch?.[1] || null;
          if (listingId && seenListingIds.has(listingId)) continue;
          const linkTitle = (
            a.getAttribute("title") ||
            a.innerText ||
            a.textContent ||
            a.querySelector("img")?.getAttribute("alt") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (linkTitle.length < 3 || isEtsyNoiseLine(linkTitle)) continue;
          if (listingId) seenListingIds.add(listingId);
          const rowEl = a.closest("div, li, tr") || a;
          const rowQty =
            extractQtyFromText(rowEl?.innerText || "") ??
            extractQtyFromText(rowEl?.parentElement?.innerText || "");
          itemsInOrder.push({
            listingId,
            title: linkTitle,
            imageUrl: extractEtsyOrderImage(rowEl) || cardImage,
            quantity: rowQty,
          });
        }

        if (itemsInOrder.length === 0) {
          const lines = cardText
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => !isEtsyNoiseLine(s));
          const fallbackTitle = (
            card.querySelector("img[alt]")?.getAttribute("alt") ||
            lines[0] ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (fallbackTitle.length >= 3) {
            itemsInOrder.push({
              listingId: null,
              title: fallbackTitle,
              imageUrl: cardImage,
              quantity: cardQuantity,
            });
          }
        }

        if (itemsInOrder.length === 0) continue;

        const perItemPrice =
          itemsInOrder.length > 1 && cardPrice > 0
            ? Math.round((cardPrice / itemsInOrder.length) * 100) / 100
            : cardPrice;

        itemsInOrder.forEach((it, idx) => {
          const extOrderId =
            itemsInOrder.length === 1
              ? `ETSY-${receiptId}`
              : `ETSY-${receiptId}-${idx + 1}`;
          if (seen.has(extOrderId)) return;
          seen.add(extOrderId);
          const resolvedQty =
            it.quantity ?? (itemsInOrder.length === 1 ? cardQuantity : 1);
          results.push({
            externalOrderId: extOrderId,
            externalListingId: it.listingId,
            sku: itemsInOrder.length === 1 ? sku : null,
            title: it.title,
            imageUrl: it.imageUrl,
            quantity: resolvedQty,
            grossSalePrice: perItemPrice,
            marketplaceFees: null,
            shippingCost: 0,
            fulfillmentStatus,
            soldAt,
          });
        });
      }
    };

    // 1. Scrape currently active tab (usually "New" open orders waiting to ship)
    const isCompletedUrl = window.location.pathname.includes("/completed");
    await autoScrollAll('a[href*="/listing/"], a[href*="receipt_id="]');
    scrapeCurrentEtsyOrdersView(isCompletedUrl ? "shipped" : "to_ship");

    // 2. Also click the "Completed" (or "New") sibling tab to capture shipped + open Etsy orders
    const wantTabPrefix = isCompletedUrl ? "new" : "completed";
    const siblingTab = Array.from(
      document.querySelectorAll('button, a, [role="tab"]')
    ).find((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (
        t === wantTabPrefix ||
        t.startsWith(`${wantTabPrefix} `) ||
        t.startsWith(`${wantTabPrefix}(`) ||
        /^completed\s*\d+$/.test(t) ||
        /^new\s*\d+$/.test(t)
      );
    });

    if (siblingTab) {
      siblingTab.click();
      await sleep(2400);
      await autoScrollAll('a[href*="/listing/"], a[href*="receipt_id="]');
      scrapeCurrentEtsyOrdersView(isCompletedUrl ? "to_ship" : "shipped");
    }

    return results;
  }

  return results;
}

async function importMarketplaceSales(marketplace, options = {}) {
  if (
    marketplace !== "poshmark" &&
    marketplace !== "mercari" &&
    marketplace !== "etsy"
  ) {
    throw new Error(`Unsupported sales import marketplace: ${marketplace}`);
  }

  const cascadeDelist = Boolean(options.cascadeDelist);
  const background = Boolean(options.background);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let targetTab = null;
  let createdTempTab = false;

  if (
    !background &&
    marketplace === "poshmark" &&
    activeTab?.id &&
    activeTab.url &&
    activeTab.url.includes("poshmark.com") &&
    (activeTab.url.includes("/order/sales") || activeTab.url.includes("sold_out"))
  ) {
    targetTab = activeTab;
  } else if (
    !background &&
    marketplace === "mercari" &&
    activeTab?.id &&
    activeTab.url &&
    activeTab.url.includes("mercari.com/mypage/")
  ) {
    targetTab = activeTab;
  } else if (
    !background &&
    marketplace === "etsy" &&
    activeTab?.id &&
    activeTab.url &&
    activeTab.url.includes("etsy.com/your/orders")
  ) {
    targetTab = activeTab;
  } else {
    const startUrl =
      marketplace === "poshmark"
        ? "https://poshmark.com/order/sales"
        : marketplace === "mercari"
          ? "https://www.mercari.com/mypage/listings/active/"
          : "https://www.etsy.com/your/orders/sold";
    const created = await chrome.tabs.create({ url: startUrl, active: !background });
    createdTempTab = background;
    await new Promise((resolve) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === created.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2400);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Safety timeout in case tab already completed
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 16000);
    });
    targetTab = created;
  }

  let sales = [];
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: scrapeSoldOrdersFromDom,
      args: [marketplace],
    });
    sales = injected?.[0]?.result || [];
  } finally {
    if (createdTempTab && targetTab?.id) {
      chrome.tabs.remove(targetTab.id).catch(() => {});
    }
  }

  if (sales.length === 0) {
    if (background) {
      return { ok: true, marketplace, scannedCount: 0, importedCount: 0, delistedCount: 0 };
    }
    throw new Error(
      marketplace === "poshmark"
        ? "No Poshmark sold orders detected. Make sure you are signed into Poshmark on the My Sales page and try again."
        : marketplace === "mercari"
          ? "No Mercari sold orders detected. Make sure you are signed into Mercari (My listings → Sold → Complete) and try again."
          : "No Etsy sold orders detected. Make sure you are signed into Etsy Shop Manager (Orders & Shipping) and try again."
    );
  }

  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/extension/import-sales`, {
    method: "POST",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
    body: JSON.stringify({ marketplace, sales, cascadeDelist }),
  });

  if (res.status === 401) {
    throw new Error(
      "Owner passcode required — enter your Command Center passcode in Connection Settings below."
    );
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Sales import failed (${res.status})`);
  }

  if ((data.importedCount || 0) > 0 || (data.delistedCount || 0) > 0) {
    await broadcastToCommandCenterTabs({
      type: "RCC_JOB_COMPLETED",
      marketplace,
      sku: `${data.importedCount || 0} new sales`,
    });
  }

  return { ok: true, scannedCount: sales.length, ...data };
}

/**
 * 24/7 Anti-Double-Sell Sale Watcher:
 * Checks eBay (API), Poshmark, Mercari, and Etsy for brand-new recent sales,
 * immediately ends eBay via API when sold elsewhere, queues urgent delist jobs for
 * Poshmark/Mercari/FB, and immediately dispatches them!
 */
async function runSaleWatchCycle({ background = true } = {}) {
  if (saleWatchBusy) {
    return { ok: true, skipped: true, message: "Sale watch already running." };
  }
  saleWatchBusy = true;
  const summary = {
    ebayNew: 0,
    poshmarkNew: 0,
    mercariNew: 0,
    etsyNew: 0,
    delistsTriggered: 0,
    errors: [],
  };

  try {
    const config = await getConfig();
    const base = (
      config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
    ).replace(/\/+$/, "");

    // 1. Check eBay (fast server API call — past 3 days, cascadeDelist: true)
    try {
      const res = await fetch(`${base}/api/ebay/sync-sales`, {
        method: "POST",
        headers: buildBridgeHeaders(config, true),
        credentials: "include",
        body: JSON.stringify({ daysBack: 3, cascadeDelist: true }),
      });
      if (res.ok) {
        const d = await res.json();
        summary.ebayNew = Number(d.importedCount || 0);
        summary.delistsTriggered += Number(d.delistedCount || 0);
      }
    } catch (e) {
      summary.errors.push(`eBay: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Check Poshmark, Mercari & Etsy quietly in background tabs (auto-closes after scraping)
    for (const mkt of ["poshmark", "mercari", "etsy"]) {
      try {
        const r = await importMarketplaceSales(mkt, {
          cascadeDelist: true,
          background,
        });
        if (mkt === "poshmark") summary.poshmarkNew = Number(r.importedCount || 0);
        if (mkt === "mercari") summary.mercariNew = Number(r.importedCount || 0);
        if (mkt === "etsy") summary.etsyNew = Number(r.importedCount || 0);
        summary.delistsTriggered += Number(r.delistedCount || 0);
      } catch (e) {
        summary.errors.push(`${mkt}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3. Immediately poll queue & run any urgent delist jobs!
    const refreshed = await refreshJobsCache(true);
    if (!config.autoPilot && Array.isArray(refreshed.jobs)) {
      const pendingDelist = refreshed.jobs.find(
        (j) =>
          j.status === "pending" &&
          j.action === "delist" &&
          (j.marketplace === "poshmark" || j.marketplace === "mercari")
      );
      if (pendingDelist) {
        await dispatchJobToTab(pendingDelist, { autoPilot: false });
      }
    }

    const totalNew =
      summary.ebayNew +
      summary.poshmarkNew +
      summary.mercariNew +
      summary.etsyNew;
    return {
      ok: true,
      ...summary,
      message:
        totalNew > 0 || summary.delistsTriggered > 0
          ? `Found ${totalNew} new sale${totalNew === 1 ? "" : "s"} (eBay ${summary.ebayNew}, Posh ${summary.poshmarkNew}, Mercari ${summary.mercariNew}, Etsy ${summary.etsyNew}) · ${summary.delistsTriggered} auto-delist${summary.delistsTriggered === 1 ? "" : "s"} triggered!`
          : `Checked eBay, Poshmark, Mercari & Etsy — no new sales to delist right now.`,
    };
  } finally {
    saleWatchBusy = false;
  }
}

async function linkExistingMatch(payload) {
  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(`${base}/api/extension/import-listings`, {
    method: "POST",
    headers: buildBridgeHeaders(config, true),
    credentials: "include",
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Link failed (${res.status})`);
  }
  await refreshJobsCache();
  return { ok: true, ...data };
}

async function deleteExtensionJob(jobId) {
  const config = await getConfig();
  const base = (
    config.apiBaseUrl || "https://reseller-command-center-black.vercel.app"
  ).replace(/\/+$/, "");

  const res = await fetch(
    `${base}/api/extension/jobs?id=${encodeURIComponent(jobId)}`,
    {
      method: "DELETE",
      headers: buildBridgeHeaders(config),
      credentials: "include",
    }
  );
  if (!res.ok) {
    throw new Error(`Cancel job failed (${res.status})`);
  }
  await refreshJobsCache();
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await configureAlarm(config);
  await refreshJobsCache(false);
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  await configureAlarm(config);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    refreshJobsCache(true);
  } else if (alarm.name === SALE_WATCH_ALARM_NAME) {
    getConfig().then((cfg) => {
      if (cfg.autoPilot) {
        runSaleWatchCycle({ background: true });
      }
    });
  } else if (alarm.name === EBAY_SYNC_ALARM_NAME) {
    getConfig().then((cfg) => {
      if (cfg.autoPilot && cfg.autoSyncMarketplaces !== false) {
        runFullMarketplaceSync({
          includeEbay: true,
          includePoshmark: false,
          includeMercari: false,
          manual: false,
        });
      }
    });
  } else if (alarm.name === MARKETPLACE_SYNC_ALARM_NAME) {
    getConfig().then((cfg) => {
      if (cfg.autoPilot && cfg.autoSyncMarketplaces !== false) {
        runFullMarketplaceSync({
          includeEbay: true,
          includePoshmark: true,
          includeMercari: true,
          manual: false,
        });
      }
    });
  }
});

const watchedPublishTabs = new Map();

async function broadcastToCommandCenterTabs(payload) {
  try {
    const tabs = await chrome.tabs.query({
      url: [
        "https://reseller-command-center-black.vercel.app/*",
        "https://*.vercel.app/*",
        "http://localhost:3000/*",
      ],
    });
    for (const t of tabs) {
      if (t.id) {
        chrome.tabs.sendMessage(t.id, payload).catch(() => {});
      }
    }
  } catch {
    // ignore
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const watch = watchedPublishTabs.get(tabId);
  if (!watch) return;
  const url = changeInfo.url || tab?.url || "";
  if (!url) return;

  const isPoshmarkPublished =
    watch.marketplace === "poshmark" &&
    url.includes("poshmark.com") &&
    !url.includes("/create-listing") &&
    (url.includes("/listing/") || url.includes("/closet/"));

  const isMercariConfirmation = /\/sell\/confirmation\/m\d{8,14}/i.test(url);
  const isMercariPublished =
    watch.marketplace === "mercari" &&
    url.includes("mercari.com") &&
    (isMercariConfirmation ||
      (!url.includes("/sell") &&
        (url.includes("/item/m") || url.includes("/us/item/m") || url.includes("/mypage/"))));

  if (!isPoshmarkPublished && !isMercariPublished) return;

  // Wait for page load completion on closet / mypage so we can grab the exact matching listing URL.
  // Mercari uses SPA navigation (history.pushState), so tab.status can already be "complete" when changeInfo.url fires.
  if (
    (url.includes("/closet/") || url.includes("/mypage/")) &&
    changeInfo.status !== "complete" &&
    tab?.status !== "complete"
  ) {
    return;
  }

  watchedPublishTabs.delete(tabId);

  let finalUrl = url.split("?")[0];
  let finalExternalId = null;

  if (watch.marketplace === "poshmark") {
    const directPm = finalUrl.match(/([0-9a-f]{24})(?:[/?#]|$)/i);
    if (directPm) {
      finalExternalId = directPm[1];
    }
  } else if (watch.marketplace === "mercari") {
    const directId = finalUrl.match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
    if (directId) {
      finalExternalId = directId[1];
      finalUrl = `https://www.mercari.com/us/item/${directId[1]}/`;
    }
  }

  if (watch.marketplace === "poshmark" && url.includes("/closet/")) {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        args: [watch.title || "", watch.watchStartedAtMs || Date.now()],
        func: async (targetTitle, watchStartedAtMs) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const stop = new Set([
            "the", "and", "for", "with", "from", "new", "size", "of", "in", "on", "to", "by",
          ]);
          const tok = (s) =>
            String(s || "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .split(/\s+/)
              .filter((w) => w.length >= 2 && !stop.has(w));
          const targetTokens = new Set(tok(targetTitle));

          // Every Poshmark listing URL ends with a 24-hex MongoDB ObjectId whose first 8 hex
          // digits are its exact Unix creation timestamp in seconds!
          const extractIdAndCreatedMs = (urlStr) => {
            const m = String(urlStr || "").match(/([0-9a-f]{24})(?:[/?#]|$)/i);
            if (!m) return { id: null, createdMs: null };
            const sec = parseInt(m[1].slice(0, 8), 16);
            return {
              id: m[1],
              createdMs: Number.isFinite(sec) ? sec * 1000 : null,
            };
          };

          const scoreCandidate = (textOrSlug) => {
            if (targetTokens.size === 0) return 0;
            const candTokens = new Set(tok(textOrSlug));
            if (candTokens.size === 0) return 0;
            let hit = 0;
            for (const w of targetTokens) {
              if (candTokens.has(w)) hit += 1;
            }
            const dice = (2 * hit) / (targetTokens.size + candTokens.size);
            const contain = hit / Math.min(targetTokens.size, candTokens.size);
            return dice * 0.72 + contain * 0.28;
          };

          // Reject any listing created > 3 minutes before this publish job started!
          // This makes it mathematically impossible to match an older sibling listing
          // (like an earlier Ertl figurine or duplicate brand item).
          const minFreshCreatedMs = Number(watchStartedAtMs || Date.now()) - 180_000;

          const searchDoc = (doc) => {
            const links = Array.from(doc.querySelectorAll('a[href*="/listing/"]'));
            let best = null;
            let bestScore = 0;
            let bestCreatedMs = 0;

            for (const link of links) {
              const href = link.getAttribute("href") || "";
              const full = href.startsWith("http")
                ? href.split("?")[0]
                : `https://poshmark.com${href.split("?")[0]}`;
              const { id, createdMs } = extractIdAndCreatedMs(full);
              if (!id || !createdMs || createdMs < minFreshCreatedMs) {
                continue;
              }

              const card =
                link.closest('[data-et-name="listing"], .card, .tile, article, li') ||
                link.parentElement;
              const titleText =
                card?.querySelector(".tile__title, [data-et-name='listing_title']")?.textContent ||
                link.getAttribute("title") ||
                link.querySelector("img")?.getAttribute("alt") ||
                href.replace(/\/listing\//i, "").replace(/-[0-9a-f]{24}$/i, "");
              const score = Math.max(scoreCandidate(titleText), scoreCandidate(href));

              if (
                score > bestScore ||
                (Math.abs(score - bestScore) < 0.02 && createdMs > bestCreatedMs)
              ) {
                bestScore = score;
                bestCreatedMs = createdMs;
                best = { url: full, id };
              }
            }
            return bestScore >= 0.55 ? best : null;
          };

          // Retry up to 8 times (~12s) because Poshmark's closet feed can lag several seconds after publishing
          for (let attempt = 0; attempt < 8; attempt++) {
            const fromDom = searchDoc(document);
            if (fromDom) return fromDom;

            if (attempt > 0) {
              try {
                const res = await fetch(
                  `${window.location.pathname}?availability=available&sort_by=added_desc&_t=${Date.now()}`,
                  { credentials: "include" }
                );
                if (res.ok) {
                  const html = await res.text();
                  const doc = new DOMParser().parseFromString(html, "text/html");
                  const fromFetch = searchDoc(doc);
                  if (fromFetch) return fromFetch;
                }
              } catch {
                // ignore
              }
            }
            await sleep(1500);
          }
          return null;
        },
      });
      if (injected?.[0]?.result?.url) {
        finalUrl = injected[0].result.url;
        finalExternalId = injected[0].result.id || finalExternalId;
      }
    } catch {
      // fall back to closet URL
    }
  } else if (watch.marketplace === "mercari" && url.includes("/mypage/")) {
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        args: [watch.title || ""],
        func: async (targetTitle) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const stop = new Set([
            "the", "and", "for", "with", "from", "new", "size", "of", "in", "on", "to", "by",
            "promote", "active", "inactive", "views", "likes", "clicks",
          ]);
          const tok = (s) =>
            String(s || "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .split(/\s+/)
              .filter((w) => w.length >= 2 && !stop.has(w));
          const targetTokens = new Set(tok(targetTitle));

          const score = (text) => {
            if (targetTokens.size === 0) return 0;
            const cand = new Set(tok(text));
            if (cand.size === 0) return 0;
            let hit = 0;
            for (const w of targetTokens) {
              if (cand.has(w)) hit += 1;
            }
            const dice = (2 * hit) / (targetTokens.size + cand.size);
            const contain = hit / Math.min(targetTokens.size, cand.size);
            return dice * 0.55 + contain * 0.45;
          };

          const extractMercariId = (str) => {
            const m = String(str || "").match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
            return m ? m[1] : null;
          };

          // Retry up to 8 times (~10s) so Mercari's React /mypage/listings/active/ table finishes fetching
          for (let attempt = 0; attempt < 8; attempt++) {
            // If page redirected to the direct item URL while waiting, use it immediately
            const urlId = extractMercariId(window.location.href);
            if (urlId) {
              return { id: urlId, url: `https://www.mercari.com/us/item/${urlId}/` };
            }

            let bestId = null;
            let bestScore = 0;

            // Strategy 1: Scan all anchors pointing to any Mercari item/edit URL
            const anchors = Array.from(document.querySelectorAll("a[href]"));
            for (const a of anchors) {
              const href = a.getAttribute("href") || "";
              const row =
                a.closest('tr, [role="row"], li, article, [data-testid*="Listing"], [data-testid*="Item"]') ||
                a.parentElement?.parentElement ||
                a;
              const id =
                extractMercariId(href) ||
                extractMercariId(row?.querySelector("img")?.getAttribute("src")) ||
                extractMercariId(row?.innerHTML);
              if (!id) continue;

              const ownText = (
                a.innerText ||
                a.getAttribute("title") ||
                a.querySelector("img")?.getAttribute("alt") ||
                ""
              ).trim();
              const rowText = (row?.innerText || "").trim();
              const s = Math.max(score(ownText), score(rowText));
              if (s > bestScore) {
                bestScore = s;
                bestId = id;
              }
            }

            // Strategy 2: Scan all Mercari CDN thumbnails (photos/mXXXXXXXXXXX_1.jpg) and match their row
            if (bestScore < 0.55) {
              const imgs = Array.from(document.querySelectorAll("img[src]"));
              for (const img of imgs) {
                const id = extractMercariId(img.getAttribute("src"));
                if (!id) continue;
                let row =
                  img.closest('tr, [role="row"], li, article, [data-testid*="Listing"], [data-testid*="Item"]') ||
                  img.parentElement;
                for (let up = 0; up < 4 && row && (row.innerText || "").trim().length < 12; up++) {
                  row = row.parentElement;
                }
                const s = Math.max(
                  score(img.getAttribute("alt") || ""),
                  score(row?.innerText || "")
                );
                if (s > bestScore) {
                  bestScore = s;
                  bestId = id;
                }
              }
            }

            if (bestScore >= 0.50 && bestId) {
              return { id: bestId, url: `https://www.mercari.com/us/item/${bestId}/` };
            }
            await sleep(1200);
          }
          return null;
        },
      });
      if (injected?.[0]?.result?.url) {
        finalUrl = injected[0].result.url;
        finalExternalId = injected[0].result.id || null;
      }
    } catch {
      // fall back to mypage URL
    }
  }

  try {
    await updateJobStatus(watch.jobId, "completed", {
      externalUrl: finalUrl,
      externalListingId: finalExternalId || undefined,
      listedPrice: watch.listedPrice,
    });
    await refreshJobsCache(false);
    await broadcastToCommandCenterTabs({
      type: "RCC_JOB_COMPLETED",
      jobId: watch.jobId,
      marketplace: watch.marketplace,
      sku: watch.sku,
      externalUrl: finalUrl,
      listedPrice: watch.listedPrice,
    });
    if (watch.autoPilot) {
      setTimeout(() => {
        chrome.tabs.remove(tabId).catch(() => {});
      }, 2000);
    }
  } catch (err) {
    console.warn("[RCC] Auto-complete publish sync error:", err);
  }
});

const watchedDelistTabs = new Map();

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const delistWatch = watchedDelistTabs.get(tabId);
  if (!delistWatch) return;
  const url = changeInfo.url || tab?.url || "";
  if (!url) return;

  // Never treat a redirect to login as a successful delist!
  if (/\/login\b|\/signin\b|\/sign-in\b/i.test(url)) {
    watchedDelistTabs.delete(tabId);
    return;
  }

  let confirmedNavigatedAway = false;
  if (delistWatch.marketplace === "poshmark") {
    const leftEditPage =
      url.includes("poshmark.com") &&
      !url.includes("/edit-listing") &&
      (!delistWatch.listingId || !url.includes(delistWatch.listingId)) &&
      (url.includes("/closet/") || url.includes("/feed") || /poshmark\.com\/?(\?|$)/i.test(url));
    confirmedNavigatedAway = leftEditPage;
  } else if (delistWatch.marketplace === "mercari") {
    const leftEditPage =
      url.includes("mercari.com") &&
      !url.includes("/sell/edit") &&
      (url.includes("/mypage/listings") || url.includes("/us/item/"));
    confirmedNavigatedAway = leftEditPage;
  }

  if (!confirmedNavigatedAway) return;
  watchedDelistTabs.delete(tabId);

  try {
    await updateJobStatus(delistWatch.jobId, "completed", {
      marketplace: delistWatch.marketplace,
    });
    await refreshJobsCache(false);
    await broadcastToCommandCenterTabs({
      type: "RCC_JOB_COMPLETED",
      jobId: delistWatch.jobId,
      marketplace: delistWatch.marketplace,
    });
    if (delistWatch.autoPilot) {
      setTimeout(() => {
        chrome.tabs.remove(tabId).catch(() => {});
      }, 1800);
    }
  } catch (err) {
    console.warn("[RCC] Auto-complete delist navigation sync error:", err);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  watchedPublishTabs.delete(tabId);
  watchedDelistTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "RCC_GET_STATE": {
          const config = await getConfig();
          const stored = await chrome.storage.local.get([
            "rccJobs",
            "rccLastPollAt",
            "rccLastError",
            "rccLastMarketplaceSync",
          ]);
          sendResponse({
            ok: true,
            config,
            jobs: stored.rccJobs || [],
            lastPollAt: stored.rccLastPollAt || null,
            lastError: stored.rccLastError || null,
            lastMarketplaceSync: stored.rccLastMarketplaceSync || null,
          });
          break;
        }
        case "RCC_SAVE_CONFIG": {
          const config = await saveConfig(message.config || {});
          const refreshed = await refreshJobsCache(Boolean(config.autoPilot));
          sendResponse({ ok: true, config, ...refreshed });
          break;
        }
        case "RCC_POLL_NOW": {
          const result = await refreshJobsCache(true);
          sendResponse(result);
          break;
        }
        case "RCC_RUN_JOB": {
          const config = await getConfig();
          const result = await dispatchJobToTab(message.job, {
            autoPilot: Boolean(message.autoPilot),
            autoPilotSaveDraft:
              message.autoPilotSaveDraft !== undefined
                ? Boolean(message.autoPilotSaveDraft)
                : config.autoPilotSaveDraft !== false,
          });
          sendResponse(result);
          break;
        }
        case "RCC_WATCH_PUBLISH_SUCCESS": {
          if (sender?.tab?.id && message.jobId) {
            watchedPublishTabs.set(sender.tab.id, {
              jobId: message.jobId,
              marketplace: message.marketplace,
              sku: message.sku || "",
              title: message.title || "",
              listedPrice: message.listedPrice,
              autoPilot: Boolean(message.autoPilot),
              watchStartedAtMs: Date.now(),
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case "RCC_WATCH_DELIST_SUCCESS": {
          if (sender?.tab?.id && message.jobId) {
            watchedDelistTabs.set(sender.tab.id, {
              jobId: message.jobId,
              marketplace: message.marketplace,
              listingId: message.listingId || "",
              autoPilot: Boolean(message.autoPilot),
              watchStartedAtMs: Date.now(),
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case "RCC_CLEAR_DELIST_WATCH": {
          if (sender?.tab?.id) {
            watchedDelistTabs.delete(sender.tab.id);
          }
          sendResponse({ ok: true });
          break;
        }
        case "RCC_REDIRECT_DELIST_TAB": {
          const tabId = sender?.tab?.id;
          const targetUrl = String(message.url || "").trim();
          const nextJob = message.job;
          const attempt = Number(nextJob?._redirectAttempt || 0);
          if (!tabId || !targetUrl || !nextJob || attempt >= 10) {
            sendResponse({ ok: false, error: "Cannot redirect delist tab" });
            break;
          }
          watchedDelistTabs.delete(tabId);
          const updatedJob = {
            ...nextJob,
            _redirectAttempt: attempt + 1,
          };
          await chrome.tabs.update(tabId, { url: targetUrl });
          await new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(resolve, 1400);
            };
            const listener = (id, changeInfo) => {
              if (id === tabId && changeInfo.status === "complete") {
                finish();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(finish, 12000);
          });
          await chrome.tabs.sendMessage(tabId, {
            type: "RCC_EXECUTE_JOB",
            job: updatedJob,
            autoPilot: Boolean(message.autoPilot),
            autoPilotSaveDraft: false,
          });
          sendResponse({ ok: true });
          break;
        }
        case "RCC_CLOSE_SENDER_TAB": {
          if (sender?.tab?.id) {
            await chrome.tabs.remove(sender.tab.id);
          }
          sendResponse({ ok: true });
          break;
        }
        case "RCC_JOB_STATUS_UPDATE": {
          if (sender?.tab?.id) {
            if (message.status === "completed") {
              watchedPublishTabs.delete(sender.tab.id);
            }
            watchedDelistTabs.delete(sender.tab.id);
          }
          await updateJobStatus(message.jobId, message.status, message.extra || {});
          await refreshJobsCache(false);
          if (message.status === "completed") {
            await broadcastToCommandCenterTabs({
              type: "RCC_JOB_COMPLETED",
              jobId: message.jobId,
              marketplace: message.extra?.marketplace || "",
              externalUrl: message.extra?.externalUrl || "",
              listedPrice: message.extra?.listedPrice,
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case "RCC_DELETE_JOB": {
          const delResult = await deleteExtensionJob(message.jobId);
          sendResponse(delResult);
          break;
        }
        case "RCC_FETCH_IMAGE_BLOB": {
          const img = await fetchImageAsBase64(message.url);
          sendResponse({ ok: true, ...img });
          break;
        }
        case "RCC_SCAN_ACTIVE_TAB": {
          const scanResult = await scanActiveTabAndImport();
          sendResponse(scanResult);
          break;
        }
        case "RCC_LINK_EXISTING_MATCH": {
          const linkResult = await linkExistingMatch(message.payload || {});
          await broadcastToCommandCenterTabs({
            type: "RCC_JOB_COMPLETED",
            marketplace: message.payload?.marketplace || "",
            sku: message.payload?.sku || "",
            externalUrl: message.payload?.externalUrl || "",
            listedPrice: message.payload?.listedPrice,
          });
          sendResponse(linkResult);
          break;
        }
        case "RCC_IMPORT_STANDALONE_LISTINGS": {
          const importResult = await importStandaloneListings(
            message.payload || {}
          );
          await broadcastToCommandCenterTabs({
            type: "RCC_JOB_COMPLETED",
            marketplace: message.payload?.marketplace || "facebook",
            sku: "",
          });
          sendResponse(importResult);
          break;
        }
        case "RCC_MARK_POLICY_BLOCKED": {
          const blockResult = await markMarketplacePolicyBlocked({
            jobId: message.jobId,
            itemId: message.itemId,
            marketplace: message.marketplace,
            rule: message.rule,
            reason: message.reason,
          });
          await broadcastToCommandCenterTabs({
            type: "RCC_JOB_COMPLETED",
            marketplace: message.marketplace || "poshmark",
            sku: "",
          });
          sendResponse(blockResult);
          break;
        }
        case "RCC_IMPORT_SALES": {
          const salesRes = await importMarketplaceSales(message.marketplace, {
            cascadeDelist: Boolean(message.cascadeDelist),
            background: false,
          });
          sendResponse(salesRes);
          break;
        }
        case "RCC_CHECK_NEW_SALES": {
          const watchRes = await runSaleWatchCycle({ background: true });
          sendResponse(watchRes);
          break;
        }
        case "RCC_SYNC_ALL_MARKETPLACES": {
          const syncRes = await runFullMarketplaceSync({
            includeEbay: message.includeEbay !== false,
            includePoshmark: message.includePoshmark !== false,
            includeMercari: message.includeMercari !== false,
            manual: true,
          });
          sendResponse(syncRes);
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true;
});
