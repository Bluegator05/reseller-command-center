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
};

let autoPilotBusy = false;
let saleWatchBusy = false;

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
  if (config.autoPoll || config.autoPilot) {
    chrome.alarms.create(POLL_ALARM_NAME, {
      periodInMinutes: Math.max(0.5, Number(config.pollIntervalMinutes) || 0.5),
    });
  }
  // When Mac Mini Auto-Pilot is ON, automatically check eBay, Poshmark & Mercari for new sales every 10 minutes
  if (config.autoPilot) {
    chrome.alarms.create(SALE_WATCH_ALARM_NAME, {
      periodInMinutes: 10,
    });
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
  if (!config?.autoPilot || autoPilotBusy) return;
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
    }, 6000);
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

function resolveDelistTargetUrl(job) {
  const extUrl = job?.payload?.externalUrl || "";
  const extId = job?.payload?.externalListingId || "";
  if (job.marketplace === "poshmark") {
    const pmMatch =
      String(extId).match(/([0-9a-f]{24})/i) ||
      String(extUrl).match(/([0-9a-f]{24})/i);
    if (pmMatch) {
      return `https://poshmark.com/edit-listing/${pmMatch[1]}`;
    }
    return extUrl || null;
  }
  if (job.marketplace === "mercari") {
    const mcMatch =
      String(extId).match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i) ||
      String(extUrl).match(/(?:^|[^a-z0-9])(m\d{9,13})(?:$|[^a-z0-9])/i);
    if (mcMatch) {
      return `https://www.mercari.com/sell/edit/${mcMatch[1]}/`;
    }
    return extUrl || null;
  }
  return extUrl || null;
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
  await updateJobStatus(job.id, "processing");

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
        : 'a[href*="/marketplace/item/"]';

  // Auto-scroll to load all lazy-loaded items on Poshmark / Mercari / FB
  let lastCount = document.querySelectorAll(linkSelector).length;
  let lastHeight = document.body.scrollHeight;
  let stablePasses = 0;

  for (let step = 0; step < 40; step++) {
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "instant",
    });

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
    const nextHeight = document.body.scrollHeight;
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

  const seen = new Set();
  const results = [];

  function extractPrice(text) {
    const m = (text || "").match(/\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/);
    if (!m) return 0;
    return Number(m[1].replace(/,/g, "")) || 0;
  }

  function isSoldOrInactive(containerText) {
    const lower = (containerText || "").toLowerCase();
    return (
      /\bsold\b/.test(lower) ||
      lower.includes("not for sale") ||
      lower.includes("deactivated") ||
      lower.includes("inactive")
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
    const links = Array.from(
      document.querySelectorAll('a[href*="/marketplace/item/"]')
    );
    for (const link of links) {
      const href = link.href || "";
      const idMatch = href.match(/\/marketplace\/item\/(\d+)/i);
      const extId = idMatch ? idMatch[1] : href;
      if (!extId || seen.has(extId)) continue;

      const cardText = link.innerText || "";
      if (isSoldOrInactive(cardText)) continue;

      const imgAlt = link.querySelector("img")?.getAttribute("alt") || "";
      const lines = cardText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length >= 3 && !/^\$[\d,.]+$/.test(s));
      const cleanTitle = (lines[0] || imgAlt.trim() || "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleanTitle.length < 3) continue;

      seen.add(extId);
      results.push({
        externalListingId: extId,
        externalUrl: href.split("?")[0],
        title: cleanTitle,
        price: extractPrice(cardText),
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
  return { ok: true, ...data };
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

  return results;
}

async function importMarketplaceSales(marketplace, options = {}) {
  if (marketplace !== "poshmark" && marketplace !== "mercari") {
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
  } else {
    const startUrl =
      marketplace === "poshmark"
        ? "https://poshmark.com/order/sales"
        : "https://www.mercari.com/mypage/listings/active/";
    const created = await chrome.tabs.create({ url: startUrl, active: !background });
    createdTempTab = background;
    await new Promise((resolve) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === created.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2200);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Safety timeout in case tab already completed
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
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
        : "No Mercari sold orders detected. Make sure you are signed into Mercari (My listings → Sold → Complete) and try again."
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
 * Checks eBay (API), Poshmark, and Mercari for brand-new recent sales (past 3-7 days),
 * immediately ends eBay via API when sold elsewhere, queues urgent delist jobs for
 * Poshmark/Mercari, and immediately dispatches them!
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

    // 2. Check Poshmark & Mercari quietly in background tabs (auto-closes after scraping)
    for (const mkt of ["poshmark", "mercari"]) {
      try {
        const r = await importMarketplaceSales(mkt, {
          cascadeDelist: true,
          background,
        });
        if (mkt === "poshmark") summary.poshmarkNew = Number(r.importedCount || 0);
        if (mkt === "mercari") summary.mercariNew = Number(r.importedCount || 0);
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

    const totalNew = summary.ebayNew + summary.poshmarkNew + summary.mercariNew;
    return {
      ok: true,
      ...summary,
      message:
        totalNew > 0 || summary.delistsTriggered > 0
          ? `Found ${totalNew} new sale${totalNew === 1 ? "" : "s"} (eBay ${summary.ebayNew}, Posh ${summary.poshmarkNew}, Mercari ${summary.mercariNew}) · ${summary.delistsTriggered} auto-delist${summary.delistsTriggered === 1 ? "" : "s"} triggered!`
          : `Checked eBay, Poshmark & Mercari — no new sales to delist right now.`,
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    refreshJobsCache(true);
  } else if (alarm.name === SALE_WATCH_ALARM_NAME) {
    getConfig().then((cfg) => {
      if (cfg.autoPilot) {
        runSaleWatchCycle({ background: true });
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

  const isMercariPublished =
    watch.marketplace === "mercari" &&
    url.includes("mercari.com") &&
    !url.includes("/sell") &&
    (url.includes("/item/m") || url.includes("/us/item/m") || url.includes("/mypage/"));

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

  if (watch.marketplace === "mercari") {
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
        args: [watch.title || ""],
        func: async (targetTitle) => {
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
            return dice * 0.65 + contain * 0.35;
          };

          const searchDoc = (doc) => {
            const links = Array.from(doc.querySelectorAll('a[href*="/listing/"]'));
            let bestUrl = null;
            let bestScore = 0;
            for (const link of links) {
              const href = link.getAttribute("href") || "";
              const full = href.startsWith("http")
                ? href.split("?")[0]
                : `https://poshmark.com${href.split("?")[0]}`;
              const card =
                link.closest('[data-et-name="listing"], .card, .tile, article, li') ||
                link.parentElement;
              const titleText =
                card?.querySelector(".tile__title, [data-et-name='listing_title']")?.textContent ||
                link.getAttribute("title") ||
                link.querySelector("img")?.getAttribute("alt") ||
                href.replace(/\/listing\//i, "").replace(/-[0-9a-f]{24}$/i, "");
              const score = Math.max(scoreCandidate(titleText), scoreCandidate(href));
              if (score > bestScore) {
                bestScore = score;
                bestUrl = full;
              }
            }
            return bestScore >= 0.65 ? bestUrl : null;
          };

          // Retry up to 4 times (Poshmark closet index can lag 1-3s right after publishing)
          for (let attempt = 0; attempt < 4; attempt++) {
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
      if (injected?.[0]?.result) {
        finalUrl = injected[0].result;
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

chrome.tabs.onRemoved.addListener((tabId) => {
  watchedPublishTabs.delete(tabId);
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
          ]);
          sendResponse({
            ok: true,
            config,
            jobs: stored.rccJobs || [],
            lastPollAt: stored.rccLastPollAt || null,
            lastError: stored.rccLastError || null,
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
            });
          }
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
