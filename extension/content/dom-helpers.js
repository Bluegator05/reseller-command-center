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
  async function injectImageBlobs(fileInput, imageUrls, maxPhotos = 16) {
    if (!fileInput || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return 0;
    }

    const dt = new DataTransfer();
    let count = 0;

    for (let i = 0; i < Math.min(imageUrls.length, maxPhotos); i++) {
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
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return count;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Waits for a visible button/link matching any regex or exact text pattern and clicks it.
   */
  async function clickButtonByText(patterns, timeoutMs = 4000) {
    const start = Date.now();
    const list = Array.isArray(patterns) ? patterns : [patterns];
    while (Date.now() - start < timeoutMs) {
      const candidates = Array.from(
        document.querySelectorAll('button, a, [role="button"]')
      );
      for (const el of candidates) {
        if (el.disabled) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        const matched = list.some((p) =>
          p instanceof RegExp ? p.test(txt) : txt.toLowerCase() === String(p).toLowerCase()
        );
        if (matched) {
          el.click();
          return true;
        }
      }
      await sleep(250);
    }
    return false;
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

  function normalizeLabel(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function scoreOptionText(optionText, targetText) {
    const a = normalizeLabel(optionText);
    const b = normalizeLabel(targetText);
    if (!a || !b) return 0;
    if (a === b) return 1.0;
    if (a.startsWith(b) || b.startsWith(a)) return 0.9;
    if (a.includes(b) || b.includes(a)) return 0.82;
    const tokA = new Set(a.split(" ").filter((t) => t.length >= 2));
    const tokB = new Set(b.split(" ").filter((t) => t.length >= 2));
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokB) {
      if (tokA.has(t)) overlap += 1;
    }
    return overlap / Math.max(tokA.size, tokB.size);
  }

  /**
   * Finds and clicks the best visible option matching `targetLabel` inside
   * dropdown menus, listboxes, or native <select> elements.
   */
  async function clickMatchingOption(targetLabel, timeoutMs = 2800, rootEl = document) {
    if (!targetLabel) return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const candidates = Array.from(
        rootEl.querySelectorAll(
          '[role="option"], [role="menuitem"], [role="menuitemradio"], li, button, a, label, span[data-test], div[role="button"]'
        )
      );
      let bestEl = null;
      let bestScore = 0;

      for (const el of candidates) {
        if (el.disabled || el.closest("#rcc-companion-hud")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Skip huge container elements so we click the specific leaf option
        if (rect.height > 90) continue;
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!txt || txt.length > 70) continue;

        const score = scoreOptionText(txt, targetLabel);
        if (score > bestScore) {
          bestScore = score;
          bestEl = el;
        }
      }

      if (bestEl && bestScore >= 0.72) {
        bestEl.scrollIntoView({ block: "nearest" });
        bestEl.click();
        return true;
      }
      await sleep(220);
    }
    return false;
  }

  /**
   * Selects a value on a native <select> element by fuzzy label matching.
   */
  function selectNativeOption(selectEl, targetLabel) {
    if (!selectEl || selectEl.tagName !== "SELECT" || !targetLabel) return false;
    let bestOpt = null;
    let bestScore = 0;
    for (const opt of Array.from(selectEl.options)) {
      const score = scoreOptionText(opt.textContent || opt.label || opt.value, targetLabel);
      if (score > bestScore) {
        bestScore = score;
        bestOpt = opt;
      }
    }
    if (bestOpt && bestScore >= 0.65) {
      selectEl.value = bestOpt.value;
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  /**
   * Opens a custom dropdown/combobox trigger and clicks through 1 or more cascading
   * option labels (e.g., Department -> Category -> Subcategory).
   */
  async function selectDropdownSequence(triggerSelectors, labels) {
    const cleanLabels = (labels || []).filter((l) => Boolean(l && String(l).trim()));
    if (cleanLabels.length === 0) return false;

    const trigger = await waitForSelector(triggerSelectors, 2500);
    if (!trigger) return false;

    if (trigger.tagName === "SELECT") {
      return selectNativeOption(trigger, cleanLabels[cleanLabels.length - 1]);
    }

    trigger.scrollIntoView({ block: "center" });
    trigger.click();
    await sleep(450);

    let matchedAny = false;
    for (const label of cleanLabels) {
      const ok = await clickMatchingOption(label, 2500);
      if (ok) {
        matchedAny = true;
        await sleep(450);
      } else {
        break;
      }
    }
    return matchedAny;
  }

  window.__rccHelpers = {
    waitForSelector,
    setNativeValue,
    injectImageBlobs,
    sleep,
    clickButtonByText,
    clickMatchingOption,
    selectNativeOption,
    selectDropdownSequence,
    showRccHud,
  };
})();
