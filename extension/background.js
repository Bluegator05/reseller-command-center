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
  if (config.autoPoll || config.autoPilot) {
    chrome.alarms.create(POLL_ALARM_NAME, {
      periodInMinutes: Math.max(0.5, Number(config.pollIntervalMinutes) || 0.5),
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
  // Give a local iMac/MacBook Air interactive browser a 12-second head start to claim jobs first
  const candidate = [...(jobs || [])]
    .filter(
      (j) =>
        j.status === "pending" &&
        j.action === "create" &&
        (j.marketplace === "poshmark" || j.marketplace === "mercari") &&
        now - Date.parse(j.created_at || 0) >= 12000
    )
    .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))[0];

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

/**
 * Opens the target marketplace listing page and dispatches the job payload
 * once the content script finishes loading.
 */
async function dispatchJobToTab(job, options = {}) {
  if (job?.id && dispatchedJobIds.has(job.id)) {
    return { ok: true, alreadyDispatched: true };
  }
  const targetUrl =
    job.action === "delist" && job.payload?.externalUrl
      ? job.payload.externalUrl
      : MARKETPLACE_CREATE_URLS[job.marketplace];

  if (!targetUrl) {
    throw new Error(`Unsupported extension marketplace: ${job.marketplace}`);
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
    const links = Array.from(
      document.querySelectorAll('a[href*="/us/item/m"], a[href*="/item/m"]')
    );
    for (const link of links) {
      const href = link.href || "";
      const idMatch = href.match(/\/item\/(m\d+)/i);
      const extId = idMatch ? idMatch[1] : href;
      if (!extId || seen.has(extId)) continue;

      const card =
        link.closest('[data-testid*="Item"], [data-testid*="Listing"], li, article') ||
        link;
      const cardText = card?.innerText || link.innerText || "";
      if (isSoldOrInactive(cardText)) continue;

      const imgAlt = card?.querySelector("img")?.getAttribute("alt") || "";
      const lines = cardText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length >= 3 && !/^\$[\d,.]+$/.test(s));
      const cleanTitle = (imgAlt.trim() || lines[0] || "")
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

  // Wait for page load completion on closet / mypage so we can grab the exact matching listing URL
  if ((url.includes("/closet/") || url.includes("/mypage/")) && changeInfo.status !== "complete") {
    return;
  }

  watchedPublishTabs.delete(tabId);

  let finalUrl = url.split("?")[0];
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
            return dice * 0.65 + contain * 0.35;
          };
          for (let attempt = 0; attempt < 4; attempt++) {
            const links = Array.from(
              document.querySelectorAll('a[href*="/us/item/m"], a[href*="/item/m"]')
            );
            let bestUrl = null;
            let bestScore = 0;
            for (const link of links) {
              const href = link.getAttribute("href") || "";
              const full = href.startsWith("http")
                ? href.split("?")[0]
                : `https://www.mercari.com${href.split("?")[0]}`;
              const cardText =
                link.getAttribute("title") ||
                link.querySelector("img")?.getAttribute("alt") ||
                link.textContent ||
                "";
              const s = score(cardText);
              if (s > bestScore) {
                bestScore = s;
                bestUrl = full;
              }
            }
            if (bestScore >= 0.65 && bestUrl) return bestUrl;
            await sleep(1400);
          }
          return null;
        },
      });
      if (injected?.[0]?.result) {
        finalUrl = injected[0].result;
      }
    } catch {
      // fall back to mypage URL
    }
  }

  try {
    await updateJobStatus(watch.jobId, "completed", {
      externalUrl: finalUrl,
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
