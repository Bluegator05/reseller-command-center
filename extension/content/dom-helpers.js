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

    // Short labels (e.g., "OS", "S", "M", "L", "XL", "8") MUST NOT substring-match inside longer words like "Poshmark"!
    if (b.length <= 3) {
      const words = a.split(" ");
      if (words.includes(b)) return 0.92;
      return 0;
    }

    if (a.startsWith(b) || b.startsWith(a)) return 0.9;
    // Only allow includes if target appears as whole word(s), not inside unrelated words
    const wordRe = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (wordRe.test(a)) return 0.85;

    const tokA = new Set(a.split(" ").filter((t) => t.length >= 2));
    const tokB = new Set(b.split(" ").filter((t) => t.length >= 2));
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokB) {
      if (tokA.has(t)) overlap += 1;
    }
    return overlap / Math.max(tokA.size, tokB.size);
  }

  function isVisibleElement(el) {
    if (!el || el.disabled) return false;
    if (el.closest("#rcc-companion-hud")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Finds a visible dropdown container/button by its placeholder or current label text
   * (e.g. "Select Category", "Select Subcategory", "Select Size", "Select Condition").
   */
  async function findDropdownTriggerByText(patterns, timeoutMs = 3000) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const candidates = Array.from(
        document.querySelectorAll(
          '[data-test*="dropdown"], .dropdown__selector, [role="combobox"], [role="button"], button, div[tabindex], div[class*="dropdown"], div[class*="select"]'
        )
      );
      let best = null;
      let bestArea = Infinity;

      for (const el of candidates) {
        if (!isVisibleElement(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height > 85 || rect.height < 22 || rect.width < 60) continue;
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!txt || txt.length > 60) continue;
        const matched = list.some((p) =>
          p instanceof RegExp ? p.test(txt) : txt.toLowerCase().includes(String(p).toLowerCase())
        );
        if (matched) {
          const area = rect.width * rect.height;
          if (area < bestArea) {
            bestArea = area;
            best = el;
          }
        }
      }
      if (best) return best;
      await sleep(200);
    }
    return null;
  }

  /**
   * Locates the currently open dropdown menu / popover container so option clicks
   * NEVER stray onto unrelated links (like "Poshmark's Seller fee").
   */
  function findOpenDropdownContainers() {
    const selectors = [
      '.dropdown__menu',
      '[class*="dropdown__menu"]',
      '[class*="dropdown-menu"]',
      '[role="listbox"]',
      '[role="menu"]',
      'ul[class*="menu"]',
      'div[class*="popover"]',
      '.modal__body',
    ];
    const openMenus = [];
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (isVisibleElement(el)) {
          openMenus.push(el);
        }
      }
    }
    return openMenus;
  }

  /**
   * Finds and clicks the best visible option matching `targetLabel` inside
   * currently open dropdown menus/listboxes (never clicking unrelated <a> links!).
   */
  async function clickMatchingOption(targetLabel, timeoutMs = 2800, rootEl = null) {
    if (!targetLabel) return false;
    const labels = Array.isArray(targetLabel) ? targetLabel : [targetLabel];
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const containers = rootEl ? [rootEl] : findOpenDropdownContainers();
      const scopes = containers.length > 0 ? containers : [document];

      let bestEl = null;
      let bestScore = 0;

      for (const scope of scopes) {
        // Only allow <a> tags when scoped strictly inside an open dropdown container
        const itemSelector =
          containers.length > 0 || rootEl
            ? '[role="option"], [role="menuitem"], [role="menuitemradio"], li, button, a, label, div[class*="option"], div[class*="item"], span'
            : '[role="option"], [role="menuitem"], [role="menuitemradio"], li[role], button, label';

        const candidates = Array.from(scope.querySelectorAll(itemSelector));
        for (const el of candidates) {
          if (!isVisibleElement(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.height > 76 || rect.height < 16) continue;

          // Never click help/fee/external links
          const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!txt || txt.length > 60) continue;
          if (/seller fee|learn about|learn more|help center|terms|privacy/i.test(txt)) {
            continue;
          }

          for (const lbl of labels) {
            const score = scoreOptionText(txt, lbl);
            if (score > bestScore) {
              bestScore = score;
              bestEl = el;
            }
          }
        }
      }

      if (bestEl && bestScore >= 0.78) {
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
    const labels = Array.isArray(targetLabel) ? targetLabel : [targetLabel];
    let bestOpt = null;
    let bestScore = 0;
    for (const opt of Array.from(selectEl.options)) {
      for (const lbl of labels) {
        const score = scoreOptionText(opt.textContent || opt.label || opt.value, lbl);
        if (score > bestScore) {
          bestScore = score;
          bestOpt = opt;
        }
      }
    }
    if (bestOpt && bestScore >= 0.72) {
      selectEl.value = bestOpt.value;
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  /**
   * Opens a custom dropdown/combobox trigger (by CSS selector or visible label text)
   * and clicks through 1 or more cascading option labels (e.g., Department -> Category).
   */
  async function selectDropdownSequence(triggerSelectors, labels, triggerTextPatterns = null) {
    const cleanLabels = (labels || []).filter((l) =>
      Array.isArray(l) ? l.length > 0 : Boolean(l && String(l).trim())
    );
    if (cleanLabels.length === 0) return false;

    let trigger = null;
    if (triggerTextPatterns) {
      trigger = await findDropdownTriggerByText(triggerTextPatterns, 2200);
    }
    if (!trigger && triggerSelectors) {
      trigger = await waitForSelector(triggerSelectors, 2200);
    }
    if (!trigger || !isVisibleElement(trigger)) return false;

    const beforeText = (trigger.textContent || "").trim();

    if (trigger.tagName === "SELECT") {
      const last = cleanLabels[cleanLabels.length - 1];
      return selectNativeOption(trigger, last);
    }

    trigger.scrollIntoView({ block: "center" });
    trigger.click();
    await sleep(450);

    let clickedCount = 0;
    for (const label of cleanLabels) {
      const ok = await clickMatchingOption(label, 2200);
      if (ok) {
        clickedCount += 1;
        await sleep(450);
      } else {
        break;
      }
    }

    const afterText = (trigger.textContent || "").trim();
    return clickedCount > 0 && (afterText !== beforeText || clickedCount === cleanLabels.length);
  }

  window.__rccHelpers = {
    waitForSelector,
    setNativeValue,
    injectImageBlobs,
    sleep,
    clickButtonByText,
    findDropdownTriggerByText,
    clickMatchingOption,
    selectNativeOption,
    selectDropdownSequence,
    showRccHud,
  };
})();
