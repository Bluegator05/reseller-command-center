/**
 * Reseller Command Center — Direct 1-Click Web-to-Extension Bridge (v0.7.0)
 *
 * Runs on the Command Center web app tab so that when the user clicks
 * "Open & Auto-Fill Poshmark / Mercari / FB" on their iMac or MacBook Air,
 * the extension immediately opens the marketplace tab and auto-fills it
 * in 1 click (no toolbar icon click needed!).
 */
(function initCommandCenterBridge() {
  const EXT_VERSION = "0.8.3";

  function announceReady() {
    try {
      document.documentElement.dataset.rccExtensionVersion = EXT_VERSION;
      window.postMessage(
        { type: "RCC_EXTENSION_READY", version: EXT_VERSION },
        window.location.origin
      );
    } catch {
      // ignore cross-origin edge cases
    }
  }

  announceReady();
  setTimeout(announceReady, 800);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "RCC_PING_EXTENSION") {
      announceReady();
      return;
    }

    if (data.type === "RCC_LOCAL_DISPATCH_JOB" && data.job) {
      chrome.runtime.sendMessage(
        {
          type: "RCC_RUN_JOB",
          job: data.job,
          autoPilot: false,
        },
        (res) => {
          const err = chrome.runtime.lastError?.message;
          window.postMessage(
            {
              type: "RCC_LOCAL_DISPATCH_ACK",
              jobId: data.job.id,
              ok: Boolean(res?.ok && !err),
              error: err || res?.error || null,
            },
            window.location.origin
          );
        }
      );
    }
  });
})();
