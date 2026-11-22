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

  function showRccHud({
    title,
    message,
    tone = "info",
    actionLabel,
    onAction,
    secondaryLabel,
    onSecondaryAction,
  }) {
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
      ${secondaryLabel ? `<button id="rcc-hud-secondary" style="margin-top:6px;width:100%;padding:6px 10px;border:1px solid #374151;border-radius:8px;background:transparent;color:#d1d5db;font-weight:600;cursor:pointer;font-size:11px;">${secondaryLabel}</button>` : ""}
    `;

    hud.querySelector("#rcc-hud-close")?.addEventListener("click", () => {
      hud.remove();
    });

    if (actionLabel && typeof onAction === "function") {
      hud.querySelector("#rcc-hud-action")?.addEventListener("click", onAction);
    }
    if (secondaryLabel && typeof onSecondaryAction === "function") {
      hud.querySelector("#rcc-hud-secondary")?.addEventListener("click", onSecondaryAction);
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

  function simulateFullClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch {
      el.click();
    }
  }

  function simulateHoverAndClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try {
      el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
      el.dispatchEvent(new MouseEvent("mouseover", opts));
    } catch {
      // ignore
    }
    simulateFullClick(el);
  }

  /**
   * Class-agnostic visible trigger finder: locates ANY visible box whose text
   * or input placeholder matches `patterns` (e.g. "Select Category", "Select Size",
   * "Select Condition") regardless of Poshmark/Mercari/FB CSS class names.
   */
  async function findDropdownTriggerByText(patterns, timeoutMs = 3000) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const matchesPattern = (txt) =>
      list.some((p) =>
        p instanceof RegExp
          ? p.test(txt)
          : txt.toLowerCase().includes(String(p).toLowerCase())
      );

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let best = null;
      let bestArea = Infinity;

      const all = Array.from(
        document.querySelectorAll("div, button, span, p, label, input, select")
      );
      for (const el of all) {
        if (!isVisibleElement(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height > 80 || rect.height < 14 || rect.width < 40) continue;

        const txt =
          el.tagName === "INPUT"
            ? String(el.placeholder || el.value || "").trim()
            : (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!txt || txt.length > 55) continue;

        if (matchesPattern(txt)) {
          // Walk up at most 2 levels if we hit an inner <span> inside the bordered dropdown box
          let target = el;
          let p = el.parentElement;
          for (let depth = 0; depth < 2 && p; depth++) {
            const pr = p.getBoundingClientRect();
            const pt = (p.textContent || "").replace(/\s+/g, " ").trim();
            if (
              pr.height >= 28 &&
              pr.height <= 72 &&
              pr.width >= 90 &&
              pr.width <= 600 &&
              pt.length <= 65 &&
              matchesPattern(pt)
            ) {
              target = p;
            }
            p = p.parentElement;
          }
          const tr = target.getBoundingClientRect();
          const area = tr.width * tr.height;
          if (area < bestArea) {
            bestArea = area;
            best = target;
          }
        }
      }
      if (best) return best;
      await sleep(200);
    }
    return null;
  }

  function snapshotVisibleElements() {
    const set = new Set();
    const els = document.querySelectorAll("li, a, button, div, span, label, p");
    for (const el of els) {
      if (isVisibleElement(el)) set.add(el);
    }
    return set;
  }

  /**
   * Locates the currently open dropdown menu / popover container.
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

  function findBestMatchingElement(candidates, targetLabel) {
    const labels = Array.isArray(targetLabel) ? targetLabel : [targetLabel];
    let bestEl = null;
    let bestScore = 0;
    let bestArea = Infinity;

    for (const el of candidates) {
      if (!isVisibleElement(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height > 72 || rect.height < 16 || rect.width < 20) continue;

      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || txt.length > 55) continue;
      if (/seller fee|learn about|learn more|help center|terms|privacy/i.test(txt)) {
        continue;
      }

      for (const lbl of labels) {
        const score = scoreOptionText(txt, lbl);
        const area = rect.width * rect.height;
        if (score > bestScore || (score === bestScore && score > 0 && area < bestArea)) {
          bestScore = score;
          bestEl = el;
          bestArea = area;
        }
      }
    }
    return { bestEl, bestScore };
  }

  /**
   * Finds and clicks the best visible option matching `targetLabel` inside
   * newly-opened DOM elements (DOM-diff) or open dropdown menus.
   */
  async function clickMatchingOption(targetLabel, timeoutMs = 2400, beforeSnapshot = null) {
    if (!targetLabel) return { ok: false, sampleOptions: [] };
    const start = Date.now();
    let lastSample = [];

    while (Date.now() - start < timeoutMs) {
      let candidates = [];

      if (beforeSnapshot) {
        const allNow = Array.from(
          document.querySelectorAll("li, a, button, div, span, label, p")
        );
        candidates = allNow.filter((el) => !beforeSnapshot.has(el) && isVisibleElement(el));
      }

      if (candidates.length === 0) {
        const containers = findOpenDropdownContainers();
        for (const c of containers) {
          candidates.push(
            ...Array.from(
              c.querySelectorAll(
                '[role="option"], [role="menuitem"], [role="menuitemradio"], li, button, a, label, div, span'
              )
            )
          );
        }
      }

      if (candidates.length > 0) {
        const uniqTexts = [];
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.height > 72 || r.height < 16) continue;
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length <= 45 && !uniqTexts.includes(t)) {
            uniqTexts.push(t);
            if (uniqTexts.length >= 12) break;
          }
        }
        lastSample = uniqTexts;

        const { bestEl, bestScore } = findBestMatchingElement(candidates, targetLabel);
        if (bestEl && bestScore >= 0.78) {
          bestEl.scrollIntoView({ block: "nearest" });
          simulateHoverAndClick(bestEl);
          return { ok: true, matchedText: (bestEl.textContent || "").trim(), sampleOptions: lastSample };
        }
      }

      await sleep(220);
    }
    return { ok: false, sampleOptions: lastSample };
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
   * Opens a custom dropdown/combobox trigger using DOM-diff detection so it works
   * across any Vue/React custom dropdown regardless of CSS classes.
   */
  async function selectDropdownSequence(triggerSelectors, labels, triggerTextPatterns = null, debugOut = null) {
    const cleanLabels = (labels || []).filter((l) =>
      Array.isArray(l) ? l.length > 0 : Boolean(l && String(l).trim())
    );
    if (cleanLabels.length === 0) return false;

    let trigger = null;
    if (triggerTextPatterns) {
      trigger = await findDropdownTriggerByText(triggerTextPatterns, 2200);
    }
    if (!trigger && triggerSelectors) {
      trigger = await waitForSelector(triggerSelectors, 1800);
    }
    if (!trigger || !isVisibleElement(trigger)) {
      if (debugOut) debugOut.push(`Trigger not found for ${JSON.stringify(cleanLabels)}`);
      return false;
    }

    const beforeText = (trigger.textContent || "").replace(/\s+/g, " ").trim();

    if (trigger.tagName === "SELECT") {
      const ok = selectNativeOption(trigger, cleanLabels[cleanLabels.length - 1]);
      if (debugOut) debugOut.push(`Native <select> "${beforeText}" -> ${ok}`);
      return ok;
    }

    const beforeSnapshot = snapshotVisibleElements();
    trigger.scrollIntoView({ block: "center" });
    await sleep(150);
    simulateFullClick(trigger);
    await sleep(550);

    let clickedCount = 0;
    let lastSamples = [];
    for (const label of cleanLabels) {
      const stepRes = await clickMatchingOption(label, 2200, beforeSnapshot);
      lastSamples = stepRes.sampleOptions || [];
      if (stepRes.ok) {
        clickedCount += 1;
        await sleep(500);
      } else {
        if (debugOut) {
          debugOut.push(
            `Trigger <${trigger.tagName}.${String(trigger.className || "").slice(0, 40)}> ("${beforeText}") missed ${JSON.stringify(label)}; saw: [${lastSamples.slice(0, 8).join(", ")}]`
          );
        }
        break;
      }
    }

    const afterText = (trigger.textContent || "").replace(/\s+/g, " ").trim();
    const changed = afterText !== beforeText;
    if (debugOut && clickedCount === cleanLabels.length) {
      debugOut.push(`OK "${beforeText}" -> "${afterText}"`);
    }
    return clickedCount > 0 && (changed || clickedCount === cleanLabels.length);
  }

  window.__rccHelpers = {
    waitForSelector,
    setNativeValue,
    injectImageBlobs,
    sleep,
    clickButtonByText,
    simulateFullClick,
    simulateHoverAndClick,
    findDropdownTriggerByText,
    clickMatchingOption,
    selectNativeOption,
    selectDropdownSequence,
    showRccHud,
  };
})();
