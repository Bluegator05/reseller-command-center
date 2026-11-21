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
  apiBaseUrl: "http://localhost:3000",
  supabaseUrl: "",
  supabaseAnonKey: "",
  autoPoll: true,
  pollIntervalMinutes: 0.5,
};

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
  if (config.autoPoll) {
    chrome.alarms.create(POLL_ALARM_NAME, {
      periodInMinutes: Math.max(0.5, Number(config.pollIntervalMinutes) || 0.5),
    });
  }
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

  const base = (config.apiBaseUrl || "http://localhost:3000").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/extension/jobs`);
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

  const base = (config.apiBaseUrl || "http://localhost:3000").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/extension/jobs`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, status, ...extra }),
  });
  if (!res.ok) throw new Error(`API bridge update failed (${res.status})`);
  return res.json();
}

async function updateBadgeCount(jobs) {
  const actionable = jobs.filter(
    (j) => j.status === "pending" || j.status === "needs_user_confirm"
  );
  const needsConfirm = jobs.some((j) => j.status === "needs_user_confirm");
  await chrome.action.setBadgeText({
    text: actionable.length > 0 ? String(actionable.length) : "",
  });
  await chrome.action.setBadgeBackgroundColor({
    color: needsConfirm ? "#B45309" : "#1D4ED8",
  });
}

async function refreshJobsCache() {
  try {
    const jobs = await fetchExtensionJobs();
    await chrome.storage.local.set({
      rccJobs: jobs,
      rccLastPollAt: new Date().toISOString(),
      rccLastError: null,
    });
    await updateBadgeCount(jobs);
    return { ok: true, jobs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ rccLastError: message });
    return { ok: false, error: message, jobs: [] };
  }
}

/**
 * Opens the target marketplace listing page and dispatches the job payload
 * once the content script finishes loading.
 */
async function dispatchJobToTab(job) {
  const targetUrl =
    job.action === "delist" && job.payload?.externalUrl
      ? job.payload.externalUrl
      : MARKETPLACE_CREATE_URLS[job.marketplace];

  if (!targetUrl) {
    throw new Error(`Unsupported extension marketplace: ${job.marketplace}`);
  }

  await updateJobStatus(job.id, "processing");

  const tab = await chrome.tabs.create({ url: targetUrl, active: true });

  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await chrome.tabs.sendMessage(tab.id, {
    type: "RCC_EXECUTE_JOB",
    job,
  });

  await refreshJobsCache();
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

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await configureAlarm(config);
  await refreshJobsCache();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) {
    refreshJobsCache();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
          const refreshed = await refreshJobsCache();
          sendResponse({ ok: true, config, ...refreshed });
          break;
        }
        case "RCC_POLL_NOW": {
          const result = await refreshJobsCache();
          sendResponse(result);
          break;
        }
        case "RCC_RUN_JOB": {
          const result = await dispatchJobToTab(message.job);
          sendResponse(result);
          break;
        }
        case "RCC_JOB_STATUS_UPDATE": {
          await updateJobStatus(message.jobId, message.status, message.extra || {});
          await refreshJobsCache();
          sendResponse({ ok: true });
          break;
        }
        case "RCC_FETCH_IMAGE_BLOB": {
          const img = await fetchImageAsBase64(message.url);
          sendResponse({ ok: true, ...img });
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
