/**
 * Shared DOM helpers for Poshmark, Mercari, and Facebook Marketplace content scripts.
 */
(function attachRccHelpers() {
  if (window.__rccHelpers) return;

  function waitForSelector(selectors, timeoutMs = 10000) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    return new Promise((resolve) => {
      for (const sel of list) {
        const found = document.querySelector(sel);
        if (found) return resolve(found);
      }

      const observer = new MutationObserver(() => {
        for (const sel of list) {
          const found = document.querySelector(sel);
          if (found) {
            observer.disconnect();
            resolve(found);
            return;
          }
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  /**
   * React/Vue controlled-input safe setter.
   * Uses the native prototype value setter so synthetic state updates fire cleanly.
   */
  function setNativeValue(el, value) {
    if (!el) return false;
    el.focus();
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (setter) {
      setter.call(el, String(value));
    } else {
      el.value = String(value);
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  /**
   * Downloads master CDN images through the MV3 background service worker
   * (bypassing page CORS) and injects them into a file input via DataTransfer.
   */
  async function injectImageBlobs(fileInput, imageUrls) {
    if (!fileInput || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return 0;
    }

    const dt = new DataTransfer();
    let count = 0;

    for (let i = 0; i < Math.min(imageUrls.length, 12); i++) {
      const url = imageUrls[i];
      try {
        const res = await chrome.runtime.sendMessage({
          type: "RCC_FETCH_IMAGE_BLOB",
          url,
        });
        if (!res?.ok || !res.base64) continue;

        const binary = atob(res.base64);
        const bytes = new Uint8Array(binary.length);
        for (let b = 0; b < binary.length; b++) {
          bytes[b] = binary.charCodeAt(b);
        }
        const mime = res.mimeType || "image/jpeg";
        const ext = mime.includes("png")
          ? "png"
          : mime.includes("webp")
            ? "webp"
            : "jpg";
        const file = new File([bytes], `rcc-photo-${i + 1}.${ext}`, {
          type: mime,
        });
        dt.items.add(file);
        count += 1;
      } catch {
        continue;
      }
    }

    if (count > 0) {
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return count;
  }

  function showRccHud({ title, message, tone = "info", actionLabel, onAction }) {
    let hud = document.getElementById("rcc-companion-hud");
    if (!hud) {
      hud = document.createElement("div");
      hud.id = "rcc-companion-hud";
      Object.assign(hud.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "2147483647",
        maxWidth: "360px",
        background: "#14151a",
        color: "#ffffff",
        borderRadius: "12px",
        padding: "14px 16px",
        boxShadow: "0 12px 32px rgba(0,0,0,0.28)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "12px",
        lineHeight: "1.45",
      });
      document.body.appendChild(hud);
    }

    const accent =
      tone === "confirm"
        ? "#f59e0b"
        : tone === "success"
          ? "#10b981"
          : tone === "error"
            ? "#ef4444"
            : "#3b82f6";

    hud.style.borderLeft = `4px solid ${accent}`;
    hud.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
        <strong style="font-size:13px;">${title}</strong>
        <button id="rcc-hud-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <div style="color:#d1d5db;">${message}</div>
      ${actionLabel ? `<button id="rcc-hud-action" style="margin-top:10px;width:100%;padding:8px 12px;border:none;border-radius:8px;background:${accent};color:#14151a;font-weight:700;cursor:pointer;font-size:12px;">${actionLabel}</button>` : ""}
    `;

    hud.querySelector("#rcc-hud-close")?.addEventListener("click", () => {
      hud.remove();
    });

    if (actionLabel && typeof onAction === "function") {
      hud.querySelector("#rcc-hud-action")?.addEventListener("click", onAction);
    }
  }

  window.__rccHelpers = {
    waitForSelector,
    setNativeValue,
    injectImageBlobs,
    showRccHud,
  };
})();
