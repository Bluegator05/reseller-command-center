/**
 * Mercari DOM Auto-Filler Content Script (v0.9.8)
 * Targets https://www.mercari.com/sell/
 * Fills up to 12 photos, Title (<=80), Description (<=1000), Brand (or "No brand / Not sure"),
 * multi-line Condition card (New / Like new / Good / Fair / Poor), Price (whole dollars),
 * disables Mercari Smart pricing (prevents the "$9 floor price" validation error),
 * and auto-clicks the purple "List" button + syncs live URL back to Command Center!
 */
(function initMercariAgent() {
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function mapToMercariCondition(raw) {
    const c = norm(raw);
    if (/\b(new with tags|nwt|brand new|sealed|unopened)\b/.test(c) || c === "new") {
      return "new";
    }
    if (/\b(like new|nwot|new without tags|mint|excellent)\b/.test(c)) {
      return "like new";
    }
    if (/\b(poor|parts|broken|damaged)\b/.test(c)) {
      return "poor";
    }
    if (/\b(fair|acceptable|worn)\b/.test(c)) {
      return "fair";
    }
    return "good";
  }

  /**
   * Selects a Brand on Mercari, or clicks Mercari's "No brand / Not sure" pill
   * (unbranded) whenever no brand is provided or Mercari doesn't recognize the brand.
   */
  async function selectMercariBrand(rawBrand, helpers, debugLog, forceUnbranded = false) {
    const { waitForSelector, setNativeValue, sleep, clickMatchingOption } = helpers;

    const findBrandInput = () =>
      document.querySelector(
        'input[data-testid="Brand"], input[placeholder*="brand" i], input[aria-label*="brand" i], input[name="brand"]'
      );

    const clickBrandPill = async (patterns) => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], [role="option"], li')
      );
      for (const pat of patterns) {
        const hit = candidates.find((el) => {
          if (el.closest("#rcc-companion-hud") || el.disabled) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const txt = (el.textContent || "").trim();
          return pat.test(txt);
        });
        if (hit) {
          hit.scrollIntoView({ block: "center" });
          await sleep(150);
          hit.click();
          await sleep(350);
          return (hit.textContent || "").trim();
        }
      }
      return null;
    };

    const brandInput =
      findBrandInput() ||
      (await waitForSelector(
        [
          'input[data-testid="Brand"]',
          'input[placeholder*="brand" i]',
          'input[aria-label*="brand" i]',
          'input[name="brand"]',
        ],
        1500
      ));

    // Already has a non-empty brand value and we're not forcing unbranded
    if (!forceUnbranded && brandInput && brandInput.value && brandInput.value.trim().length > 0) {
      debugLog.push(`Brand: already filled ("${brandInput.value.trim()}")`);
      return true;
    }

    const cleaned = String(rawBrand || "").trim();
    const isUnbrandedLike =
      forceUnbranded ||
      !cleaned ||
      /^(unbranded|none|n\/a|na|unknown|does not apply|generic|no brand|not sure|other)$/i.test(
        cleaned
      );

    // 1. Try matching real brand first (via Suggested brands pill or autocomplete input)
    if (!isUnbrandedLike && brandInput) {
      const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pillHit = await clickBrandPill([new RegExp(`^${escaped}$`, "i")]);
      if (pillHit) {
        debugLog.push(`Brand: clicked suggested pill "${pillHit}"`);
        return true;
      }

      brandInput.scrollIntoView({ block: "center" });
      brandInput.focus();
      brandInput.click();
      setNativeValue(brandInput, cleaned);
      await sleep(550);
      const picked = await clickMatchingOption(cleaned, 1400);
      await sleep(300);
      if (picked) {
        debugLog.push(`Brand: selected "${cleaned}" from dropdown`);
        return true;
      }
      // Clear unrecognized text so Mercari shows "No brand / Not sure" cleanly
      setNativeValue(brandInput, "");
      await sleep(250);
    }

    // 2. Fall back to Mercari's official "No brand / Not sure" pill (unbranded)
    const noBrandPill = await clickBrandPill([
      /^no brand\s*\/\s*not sure$/i,
      /^no brand$/i,
      /^unbranded$/i,
    ]);
    if (noBrandPill) {
      debugLog.push(`Brand: selected "${noBrandPill}"`);
      return true;
    }

    // 3. If the pill wasn't visible, open the Brand input and pick "No brand / Not sure" or "Unbranded"
    const input2 = findBrandInput();
    if (input2) {
      input2.scrollIntoView({ block: "center" });
      input2.focus();
      input2.click();
      await sleep(350);
      const fromOpen = await clickBrandPill([
        /^no brand\s*\/\s*not sure$/i,
        /^no brand$/i,
        /^unbranded$/i,
      ]);
      if (fromOpen) {
        debugLog.push(`Brand: selected "${fromOpen}" from dropdown`);
        return true;
      }
      setNativeValue(input2, "Unbranded");
      await sleep(450);
      const pickedUnbranded =
        (await clickBrandPill([/^no brand\s*\/\s*not sure$/i, /^unbranded$/i])) ||
        (await clickMatchingOption("Unbranded", 1200));
      if (pickedUnbranded) {
        debugLog.push("Brand: selected Unbranded via search");
        return true;
      }
    }

    debugLog.push("Brand: unable to select brand/unbranded");
    return false;
  }

  /**
   * Turns OFF Mercari's "Smart pricing" ("Adjusts price automatically" -> ON button)
   * so Mercari never throws "The floor price needs to be more than $9." on items <= $12
   * and doesn't silently slash prices out of sync with Command Center.
   */
  async function disableMercariSmartPricing(sleep, debugLog) {
    // 1. Direct testid / input selectors if present
    const directSelectors = [
      'button[data-testid="SmartPricingToggle"]',
      'button[data-testid="SmartPricingButton"]',
      '[data-testid="SmartPricing"] button',
      '[data-testid*="SmartPricing"] button',
      'input[name="smartPricing"]',
      'input[name="autoDrop"]',
    ];
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const txt = (el.textContent || "").trim();
      const isOn =
        (el.tagName === "INPUT" && el.checked) ||
        el.getAttribute("aria-pressed") === "true" ||
        el.getAttribute("aria-checked") === "true" ||
        /^on$/i.test(txt);
      if (isOn) {
        el.scrollIntoView({ block: "center" });
        await sleep(150);
        el.click();
        await sleep(350);
        debugLog.push(`SmartPricing: turned OFF via ${sel}`);
        return true;
      }
      if (/^off$/i.test(txt) || (el.tagName === "INPUT" && !el.checked)) {
        debugLog.push("SmartPricing: already OFF");
        return true;
      }
    }

    // 2. Locate "Adjusts price automatically" row and click its "ON" button
    const anchor = Array.from(
      document.querySelectorAll("div, section, p, span, h3, h4, label")
    ).find((el) => {
      if (el.closest("#rcc-companion-hud")) return false;
      const txt = (el.textContent || "").trim();
      return /^adjusts price automatically$/i.test(txt);
    });

    if (anchor) {
      let container = anchor.parentElement;
      for (let depth = 0; depth < 6 && container; depth++) {
        const toggleBtn = Array.from(
          container.querySelectorAll(
            'button, [role="switch"], [role="button"], input[type="checkbox"]'
          )
        ).find((b) => {
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const t = (b.textContent || "").trim();
          return (
            /^on$/i.test(t) ||
            (b.tagName === "INPUT" && b.checked) ||
            b.getAttribute("aria-checked") === "true" ||
            b.getAttribute("aria-pressed") === "true"
          );
        });
        if (toggleBtn) {
          toggleBtn.scrollIntoView({ block: "center" });
          await sleep(150);
          toggleBtn.click();
          await sleep(350);
          debugLog.push(`SmartPricing: clicked "${(toggleBtn.textContent || "ON").trim()}" -> OFF`);
          return true;
        }
        const offBtn = Array.from(container.querySelectorAll("button")).find((b) =>
          /^off$/i.test((b.textContent || "").trim())
        );
        if (offBtn) {
          debugLog.push("SmartPricing: already OFF");
          return true;
        }
        container = container.parentElement;
      }
    }

    // 3. Fallback: any visible button with exact text "ON" inside a Smart pricing section
    const onBtns = Array.from(document.querySelectorAll("button")).filter((b) => {
      if (b.closest("#rcc-companion-hud")) return false;
      const r = b.getBoundingClientRect();
      return r.width > 20 && r.height > 20 && /^on$/i.test((b.textContent || "").trim());
    });
    for (const btn of onBtns) {
      let p = btn.parentElement;
      for (let d = 0; d < 6 && p; d++) {
        if (/smart pricing|adjusts price automatically/i.test(p.textContent || "")) {
          btn.scrollIntoView({ block: "center" });
          await sleep(150);
          btn.click();
          await sleep(350);
          debugLog.push("SmartPricing: clicked ON via section scan -> OFF");
          return true;
        }
        p = p.parentElement;
      }
    }

    debugLog.push("SmartPricing: toggle not found");
    return false;
  }

  /**
   * Ensures a valid non-Priority Mercari prepaid shipping carrier is selected
   * (Buyer pays · USPS Ground Advantage / UPS Ground Saver / FedEx Ground Economy).
   * Strictly skips USPS Priority Mail.
   */
  async function ensureMercariShippingSelected(payload, helpers, debugLog, forceSelect = false) {
    const { setNativeValue, sleep, clickButtonByText } = helpers;

    const hasCarrierError = () =>
      /please select a shipping carrier|select a shipping/i.test(
        document.body?.innerText || ""
      );

    // 1. Check if Mercari already auto-selected a valid non-Priority carrier
    const pageText = document.body?.innerText || "";
    const alreadyHasCarrier =
      /(?:usps\s*ground\s*advantage|ups\s*(?:ground\s*saver|surepost|ground)|fedex\s*(?:ground\s*economy|home\s*delivery|ground))/i.test(
        pageText
      ) && !hasCarrierError();

    const openTrigger = Array.from(
      document.querySelectorAll('button, [role="button"], a')
    ).find((el) => {
      if (el.disabled || el.closest("#rcc-companion-hud")) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      return /^(?:select|choose)\s+(?:a\s+)?(?:shipping\s+)?(?:carrier|shipping|delivery)$/i.test(t);
    });

    if (!forceSelect && alreadyHasCarrier && !openTrigger) {
      debugLog.push("Shipping: Mercari auto-filled carrier ✓");
      return true;
    }

    // 2. Make sure "Buyer pays" / "Prepaid label" is selected (never Ship on your own)
    const prepaidOption = Array.from(
      document.querySelectorAll('label, button, [role="radio"], div[tabindex], div')
    ).find((el) => {
      if (el.closest("#rcc-companion-hud")) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.width > 700 || r.height < 28 || r.height > 140) return false;
      const t = (el.innerText || "").trim();
      return /^(?:buyer pays|prepaid label)\b/i.test(t) && t.length < 180;
    });
    if (prepaidOption) {
      const radio = prepaidOption.querySelector('input[type="radio"]');
      if (radio && !radio.checked) {
        prepaidOption.scrollIntoView({ block: "center" });
        radio.click();
        prepaidOption.click();
        await sleep(400);
        debugLog.push("Shipping: selected Prepaid / Buyer pays");
      }
    }

    // 3. Click "Select carrier" / "Select shipping" trigger if present
    if (openTrigger) {
      openTrigger.scrollIntoView({ block: "center" });
      await sleep(150);
      openTrigger.click();
      await sleep(600);
      debugLog.push(`Shipping: opened "${(openTrigger.textContent || "").trim()}"`);
    }

    // 4. Fill package weight (lb / oz) if inputs are visible and blank/zero
    const lbInput = document.querySelector(
      'input[data-testid*="Pound"], input[name*="pound" i], input[placeholder*="lb" i], input[aria-label*="pound" i]'
    );
    const ozInput = document.querySelector(
      'input[data-testid*="Ounce"], input[name*="ounce" i], input[placeholder*="oz" i], input[aria-label*="ounce" i]'
    );
    if (lbInput || ozInput) {
      const curLb = Number(lbInput?.value || 0);
      const curOz = Number(ozInput?.value || 0);
      if (curLb === 0 && curOz === 0) {
        const totalOz = Math.max(4, Math.round(Number(payload.weightOz) || 12));
        const lbs = Math.floor(totalOz / 16);
        const oz = lbs > 0 ? totalOz % 16 : totalOz;
        if (lbInput) setNativeValue(lbInput, String(lbs));
        if (ozInput) setNativeValue(ozInput, String(oz));
        await sleep(450);
        debugLog.push(`Shipping: set weight ${lbs}lb ${oz}oz`);
        await clickButtonByText([/^calculate$/i, /^next$/i, /^continue$/i], 1200);
        await sleep(500);
      }
    }

    // 5. Pick the best non-Priority carrier card/radio (strictly NO USPS Priority Mail)
    const carrierPatterns = [
      /usps\s*ground\s*advantage/i,
      /ups\s*(?:ground\s*saver|surepost)/i,
      /fedex\s*ground\s*economy/i,
      /ups\s*ground/i,
      /fedex\s*(?:home|ground)/i,
      /\b(?:usps|ups|fedex)\b.*\$\s*\d/i,
    ];

    const pickCarrier = async () => {
      const nodes = Array.from(
        document.querySelectorAll('label, [role="radio"], [role="option"], button, div[tabindex], div')
      );
      for (const pat of carrierPatterns) {
        let best = null;
        let bestArea = Infinity;
        for (const el of nodes) {
          if (el.closest("#rcc-companion-hud") || el.disabled) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.width > 760 || r.height < 34 || r.height > 180) continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
          const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
          if (!txt || txt.length > 220) continue;
          // Strictly forbid USPS Priority Mail!
          if (/priority\s*mail|\bpriority\b/i.test(txt)) continue;
          if (!pat.test(txt)) continue;
          const area = r.width * r.height;
          if (area < bestArea) {
            bestArea = area;
            best = el;
          }
        }
        if (best) {
          best.scrollIntoView({ block: "center" });
          await sleep(150);
          const radio = best.querySelector('input[type="radio"]');
          if (radio) radio.click();
          best.click();
          const outer = best.closest('label, button, [role="radio"]');
          if (outer && outer !== best) outer.click();
          await sleep(350);
          debugLog.push(`Shipping: selected carrier "${(best.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50)}"`);
          return true;
        }
      }
      return false;
    };

    const picked = await pickCarrier();

    // 6. Save modal if a shipping carrier modal is open
    if (picked) {
      await clickButtonByText([/^save$/i, /^confirm$/i, /^done$/i, /^select$/i], 1500);
      await sleep(350);
      return true;
    }

    debugLog.push("Shipping: carrier card not found");
    return false;
  }

  /**
   * Detects visible red inline validation messages on Mercari /sell/
   */
  function detectMercariValidationError() {
    const knownErrorRe =
      /floor price needs to be|please select|please enter|is required|must be at least|select a condition|add at least one photo|select a category|enter a valid/i;
    const nodes = Array.from(document.querySelectorAll("p, span, div"));
    for (const el of nodes) {
      if (el.closest("#rcc-companion-hud") || el.children.length > 1) continue;
      const txt = (el.textContent || "").trim();
      if (!txt || txt.length > 140) continue;
      if (!knownErrorRe.test(txt)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
        continue;
      }
      return txt;
    }
    return null;
  }

  /**
   * Selects Mercari's multi-line Condition card ("New", "Like new", "Good", "Fair", "Poor").
   * Matches the first line of each card so the subtitle ("New with tags (NWT)...") doesn't break matching.
   */
  async function selectMercariConditionCard(targetCond, sleep, debugLog) {
    const normalizedTarget = mapToMercariCondition(targetCond);
    const start = Date.now();

    while (Date.now() - start < 3500) {
      // 1. Direct data-testid / input[value] check first
      const directMap = {
        new: ['[data-testid="Condition-1"]', 'input[name="itemCondition"][value="1"]'],
        "like new": ['[data-testid="Condition-2"]', 'input[name="itemCondition"][value="2"]'],
        good: ['[data-testid="Condition-3"]', 'input[name="itemCondition"][value="3"]'],
        fair: ['[data-testid="Condition-4"]', 'input[name="itemCondition"][value="4"]'],
        poor: ['[data-testid="Condition-5"]', 'input[name="itemCondition"][value="5"]'],
      };
      for (const sel of directMap[normalizedTarget] || []) {
        const direct = document.querySelector(sel);
        if (direct) {
          direct.scrollIntoView({ block: "center" });
          direct.click();
          const parent = direct.closest("label, button, div[role='button'], div[tabindex]");
          if (parent && parent !== direct) parent.click();
          await sleep(300);
          debugLog.push(`Condition: OK via ${sel} ("${normalizedTarget}")`);
          return true;
        }
      }

      // 2. Scan visible Condition cards by their first-line title ("New", "Like new", "Good", "Fair", "Poor")
      const all = Array.from(
        document.querySelectorAll('label, button, [role="radio"], [role="button"], div[tabindex], div')
      );
      let bestCard = null;
      let bestArea = Infinity;

      for (const el of all) {
        if (el.closest("#rcc-companion-hud")) continue;
        const rect = el.getBoundingClientRect();
        // Condition cards on Mercari are roughly 140-260px wide x 55-150px tall
        if (rect.width < 70 || rect.width > 340 || rect.height < 42 || rect.height > 175) {
          continue;
        }
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
          continue;
        }

        const inner = (el.innerText || "").trim();
        if (!inner) continue;
        const lines = inner
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length < 2) continue; // Mercari condition cards have Title + description lines!

        const firstLine = norm(lines[0]);
        if (firstLine !== normalizedTarget) continue;

        // Confirm the subtitle looks like Mercari's condition copy so we never hit an unrelated card
        const body = inner.toLowerCase();
        const isConditionCopy =
          /nwt|nwot|unopened|unused|signs of wear|gently used|minor flaws|functional|defects|major flaws|for parts/.test(
            body
          );
        if (!isConditionCopy) continue;

        const area = rect.width * rect.height;
        if (area < bestArea) {
          bestArea = area;
          bestCard = el;
        }
      }

      if (bestCard) {
        bestCard.scrollIntoView({ block: "center" });
        await sleep(150);
        const radio = bestCard.querySelector('input[type="radio"]');
        if (radio) radio.click();
        bestCard.click();
        const outerBtn = bestCard.closest('label, button, [role="radio"], [role="button"]');
        if (outerBtn && outerBtn !== bestCard) outerBtn.click();
        await sleep(350);
        debugLog.push(`Condition: OK card ("${normalizedTarget}")`);
        return true;
      }

      await sleep(250);
    }

    debugLog.push(`Condition: missed "${normalizedTarget}"`);
    return false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RCC_EXECUTE_JOB" || message.job?.marketplace !== "mercari") {
      return;
    }

    (async () => {
      const {
        waitForSelector,
        setNativeValue,
        injectImageBlobs,
        sleep,
        clickButtonByText,
        clickMatchingOption,
        selectDropdownSequence,
        showRccHud,
      } = window.__rccHelpers;
      const job = message.job;
      const payload = job.payload || {};
      const sc = payload.structuredCategory || {};
      const isAutoPilot = Boolean(message.autoPilot);
      const shouldSaveDraft = Boolean(message.autoPilot && message.autoPilotSaveDraft);

      try {
        // ANTI-DOUBLE-SELL AUTO-DELIST (DEACTIVATE) HANDLER
        if (job.action === "delist") {
          showRccHud({
            title: `${isAutoPilot ? "Auto-Pilot · " : ""}Auto-Delisting Mercari (${payload.sku || "SKU"})`,
            message: `Sold on another marketplace (${payload.reason || "anti-double-sell"}) — deactivating Mercari listing now...`,
            tone: "info",
          });

          await sleep(1000);
          const bodyLower = (document.body?.innerText || "").toLowerCase();
          const hasActivateBtn = Array.from(document.querySelectorAll("button")).some(
            (b) => !b.closest("#rcc-companion-hud") && /^activate$/i.test((b.textContent || "").trim())
          );
          const alreadyEnded =
            hasActivateBtn ||
            bodyLower.includes("item is no longer available") ||
            bodyLower.includes("page not found") ||
            bodyLower.includes("this item has sold") ||
            bodyLower.includes("listing was deleted");

          if (alreadyEnded) {
            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "completed",
              extra: { marketplace: "mercari" },
            });
            showRccHud({
              title: `Mercari Already Inactive (${payload.sku || "SKU"})`,
              message: "Listing is already deactivated or removed — synced back to Command Center.",
              tone: "success",
            });
            if (isAutoPilot) {
              await sleep(1500);
              chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            }
            sendResponse({ ok: true, delisted: true });
            return;
          }

          // If on public item page (/us/item/m...), click Edit to open /sell/edit/m...
          if (!window.location.pathname.includes("/sell/edit")) {
            const editLink = document.querySelector('a[href*="/sell/edit/"]');
            if (editLink) {
              editLink.click();
              await sleep(2200);
            } else {
              await clickButtonByText([/^edit$/i, /^edit listing$/i], 2500);
              await sleep(2200);
            }
          }

          window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          await sleep(700);

          // Prefer Deactivate (safe reversible hide); fall back to Delete if Deactivate isn't shown
          const deactivateBtn =
            document.querySelector('button[data-testid="DeactivateButton"]') ||
            Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
              if (b.disabled || b.closest("#rcc-companion-hud")) return false;
              const r = b.getBoundingClientRect();
              return r.width > 40 && r.height > 20 && /^deactivate$/i.test((b.textContent || "").trim());
            });

          let clickedEnd = false;
          if (deactivateBtn) {
            deactivateBtn.scrollIntoView({ block: "center" });
            await sleep(200);
            deactivateBtn.click();
            clickedEnd = true;
          } else {
            clickedEnd = await clickButtonByText([/^deactivate$/i, /^delete$/i, /^delete listing$/i], 3500);
          }

          if (clickedEnd) {
            await sleep(750);
            await clickButtonByText([/^deactivate$/i, /^yes$/i, /^confirm$/i, /^delete$/i], 3000);
            await sleep(1500);

            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "completed",
              extra: { marketplace: "mercari" },
            });
            showRccHud({
              title: `Deactivated on Mercari! (${payload.sku || "SKU"})`,
              message: "Anti-double-sell complete — listing hidden from buyers & synced to Command Center.",
              tone: "success",
            });
            if (isAutoPilot) {
              await sleep(1800);
              chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            }
            sendResponse({ ok: true, delisted: true });
            return;
          }

          await chrome.runtime.sendMessage({
            type: "RCC_JOB_STATUS_UPDATE",
            jobId: job.id,
            status: "needs_user_confirm",
            extra: {
              errorMessage: "Could not find Deactivate button — please deactivate manually on this tab.",
            },
          });
          showRccHud({
            title: `Confirm Mercari Delist (${payload.sku || "SKU"})`,
            message: "Click Deactivate on this page, then tap Mark Delisted below.",
            tone: "confirm",
            actionLabel: "Mark Delisted",
            onAction: async () => {
              await chrome.runtime.sendMessage({
                type: "RCC_JOB_STATUS_UPDATE",
                jobId: job.id,
                status: "completed",
                extra: { marketplace: "mercari" },
              });
              showRccHud({
                title: "Mercari Delist Synced",
                message: "Marked ended in Command Center.",
                tone: "success",
              });
            },
          });
          sendResponse({ ok: true, delisted: false });
          return;
        }

        // Tell background worker right away to watch this tab for live publish redirect!
        chrome.runtime.sendMessage({
          type: "RCC_WATCH_PUBLISH_SUCCESS",
          jobId: job.id,
          marketplace: "mercari",
          sku: payload.sku || job.item_sku || "",
          title: payload.mappedTitle || job.item_title || "",
          listedPrice: Math.max(5, Math.round(Number(payload.suggestedPrice || 0))),
          autoPilot: isAutoPilot,
        });

        showRccHud({
          title: `${isAutoPilot ? "Auto-Pilot · " : ""}Mercari (${payload.sku || "SKU"})`,
          message: `Uploading ${(payload.imageUrls || []).length} eBay photos & filling title, description, condition, and price...`,
          tone: "info",
        });

        // 1. Inject up to 12 full-res photos
        const fileInput = await waitForSelector(
          ['input[type="file"][multiple]', 'input[type="file"]'],
          4000
        );
        const uploadedCount = await injectImageBlobs(
          fileInput,
          payload.imageUrls || [],
          12
        );

        // 2. Fill Title (<=80) & Description (<=1000)
        const titleInput = await waitForSelector([
          'input[data-testid="Title"]',
          'input[name="name"]',
          'input[placeholder*="What are you selling"]',
        ]);
        if (titleInput && payload.mappedTitle) {
          setNativeValue(titleInput, String(payload.mappedTitle).slice(0, 80));
        }

        const descInput = await waitForSelector(
          [
            'textarea[data-testid="Description"]',
            'textarea[name="description"]',
            'textarea[placeholder*="Describe your item"]',
          ],
          4000
        );
        if (descInput && payload.descriptionPlain) {
          setNativeValue(descInput, String(payload.descriptionPlain).slice(0, 1000));
        }

        // Wait for Mercari's smart auto-category & shipping recommendation to settle
        await sleep(1800);

        const debugLog = [];

        // Helper: detect if Mercari already auto-populated Category (e.g. "Home > Seasonal decor > ...")
        const getMercariCategoryText = () => {
          const direct = document.querySelector(
            '[data-testid="CategoryDropdown"], select[data-testid="CategoryId"], div[data-testid="Category"], button[aria-label*="Category"]'
          );
          if (direct) {
            const t = (direct.value || direct.textContent || "").replace(/\s+/g, " ").trim();
            if (t && !/^select category$/i.test(t) && !/^category$/i.test(t)) return t;
          }
          // Locate the "Category" label and inspect the dropdown box right next to / below it
          const catLabel = Array.from(
            document.querySelectorAll("label, p, span, div, h3, h4")
          ).find((el) => {
            if (el.closest("#rcc-companion-hud") || el.children.length > 0) return false;
            return /^category$/i.test((el.textContent || "").trim());
          });
          if (catLabel) {
            let box = catLabel.parentElement;
            for (let d = 0; d < 3 && box; d++) {
              const ctrl = Array.from(
                box.querySelectorAll('button, input, [role="button"], [role="combobox"], div')
              ).find((c) => {
                if (c === catLabel || c.contains(catLabel)) return false;
                const r = c.getBoundingClientRect();
                if (r.width < 120 || r.height < 28 || r.height > 76) return false;
                const t = (c.value || c.textContent || "").replace(/\s+/g, " ").trim();
                return t.includes(">") && t.length < 140;
              });
              if (ctrl) {
                return (ctrl.value || ctrl.textContent || "").replace(/\s+/g, " ").trim();
              }
              box = box.parentElement;
            }
          }
          return "";
        };

        // Helper: if Mercari's Category modal was left open mid-tree, click "Other" (or "All ...") to finish & unlock Shipping
        const finishOpenCategoryModal = async () => {
          for (let guard = 0; guard < 3; guard++) {
            const modalHeader = Array.from(
              document.querySelectorAll("h1, h2, h3, h4, div, p, span")
            ).find((el) => {
              if (el.closest("#rcc-companion-hud") || el.children.length > 0) return false;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return false;
              // Modal header "Category" is centered near top of the modal dialog
              return /^category$/i.test((el.textContent || "").trim()) && r.left > 200;
            });
            if (!modalHeader) break;
            let modal = modalHeader.parentElement;
            for (let up = 0; up < 5 && modal && modal.getBoundingClientRect().height < 260; up++) {
              modal = modal.parentElement;
            }
            if (!modal) break;
            const fallbackRow = Array.from(
              modal.querySelectorAll('button, li, [role="option"], [role="button"], div')
            ).find((el) => {
              const r = el.getBoundingClientRect();
              if (r.width < 100 || r.height < 24 || r.height > 72) return false;
              const t = (el.textContent || "").replace(/\s+/g, " ").trim();
              return /^other$/i.test(t) || /^all\s+[a-z]/i.test(t);
            });
            if (fallbackRow) {
              fallbackRow.click();
              debugLog.push(`Category modal: finished via "${(fallbackRow.textContent || "").trim()}"`);
              await sleep(500);
            } else {
              // Close button fallback if nothing selectable
              const closeBtn = modal.querySelector('button[aria-label*="close" i], button');
              if (closeBtn) closeBtn.click();
              await sleep(400);
              break;
            }
          }
        };

        // 3. Category — NEVER clobber Mercari's smart auto-filled category ("A > B > C")!
        const catLevels = [sc.department, sc.category, sc.subcategory].filter(Boolean);
        let autoCatTxt = getMercariCategoryText();
        if (!autoCatTxt) {
          // Give Mercari's smart category one more beat if still loading
          await sleep(800);
          autoCatTxt = getMercariCategoryText();
        }
        if (autoCatTxt) {
          debugLog.push(`Category: Mercari auto-filled ("${autoCatTxt.slice(0, 50)}")`);
        } else if (catLevels.length > 0) {
          await selectDropdownSequence(
            [
              '[data-testid="CategoryDropdown"]',
              'select[data-testid="CategoryId"]',
              'button[aria-label*="Category"]',
              'div[data-testid="Category"]',
            ],
            catLevels,
            [/^select category/i],
            debugLog
          );
          await sleep(400);
          await finishOpenCategoryModal();
          await sleep(600);
        }

        // 4. Brand (select real brand or Mercari's "No brand / Not sure" unbranded pill)
        const mercariHelpers = {
          waitForSelector,
          setNativeValue,
          sleep,
          clickMatchingOption,
          clickButtonByText,
        };
        await selectMercariBrand(payload.brand || "", mercariHelpers, debugLog, false);

        // 5. Condition card ("New", "Like new", "Good", "Fair", "Poor")
        const targetCond = sc.conditionLabel || payload.condition || "Good";
        const conditionMatched = await selectMercariConditionCard(
          targetCond,
          sleep,
          debugLog
        );

        // 5.5 Shipping Carrier (ensure non-Priority Buyer-Pays prepaid carrier is selected)
        await ensureMercariShippingSelected(payload, mercariHelpers, debugLog, false);

        // 6. Whole-dollar Price ($5+) + Disable Mercari Smart Pricing
        const priceInput = await waitForSelector(
          [
            'input[data-testid="Price"]',
            'input[name="price"]',
            'input[placeholder*="0.00"]',
          ],
          3000
        );
        if (priceInput && payload.suggestedPrice) {
          priceInput.scrollIntoView({ block: "center" });
          setNativeValue(priceInput, Math.max(5, Math.round(Number(payload.suggestedPrice))));
          // Wait for Mercari's Smart pricing box to react to the entered price, then turn it OFF
          await sleep(500);
          await disableMercariSmartPricing(sleep, debugLog);
        }

        const fieldSummary = [
          `${uploadedCount} photos`,
          conditionMatched ? `Condition ✓ (${targetCond})` : `Condition: pick "${targetCond}"`,
          `$${Math.max(5, Math.round(Number(payload.suggestedPrice || 0)))}`,
        ].join(" · ");

        if (debugLog.length > 0) {
          console.log("[RCC Mercari v1.1.1]", debugLog.join(" | "));
        }

        // 7. Auto-Publish: If Condition was selected, wait for photos to settle & click the purple "List" button!
        let validationError = null;
        if (conditionMatched) {
          showRccHud({
            title: `Publishing to Mercari (${payload.sku || "SKU"})`,
            message: `${fieldSummary}. Waiting for photos to finish uploading, then clicking List...`,
            tone: "info",
          });

          await sleep(Math.min(6000, Math.max(1800, uploadedCount * 350)));

          // Double-check Brand, Shipping & Smart pricing right before submitting
          const brandCheck = document.querySelector(
            'input[data-testid="Brand"], input[placeholder*="brand" i], input[aria-label*="brand" i], input[name="brand"]'
          );
          if (brandCheck && !brandCheck.value.trim()) {
            await selectMercariBrand("", mercariHelpers, debugLog, true);
          }
          await ensureMercariShippingSelected(payload, mercariHelpers, debugLog, false);
          await disableMercariSmartPricing(sleep, debugLog);

          const findListBtn = () =>
            document.querySelector('button[data-testid="ListButton"]') ||
            Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
              if (b.disabled || b.closest("#rcc-companion-hud")) return false;
              const r = b.getBoundingClientRect();
              return r.width > 80 && r.height > 28 && /^list$/i.test((b.textContent || "").trim());
            });

          const listBtn = findListBtn();
          if (listBtn) {
            listBtn.scrollIntoView({ block: "center" });
            await sleep(250);
            listBtn.click();

            // Handle any optional confirmation modal ("List anyway" / "Confirm" / "List item")
            await sleep(1200);
            await clickButtonByText([/^list anyway$/i, /^confirm$/i, /^list item$/i], 2000);

            // Verify Mercari didn't block submission with an inline validation error (up to 3 auto-fixes)
            for (let retry = 0; retry < 3; retry++) {
              await sleep(900);
              if (!window.location.pathname.includes("/sell")) {
                validationError = null;
                break;
              }
              validationError = detectMercariValidationError();
              if (!validationError) break;

              let fixedSomething = false;
              if (/brand/i.test(validationError)) {
                debugLog.push(`Auto-fix brand after error: ${validationError}`);
                await selectMercariBrand("", mercariHelpers, debugLog, true);
                fixedSomething = true;
              }
              if (/shipping|carrier|delivery/i.test(validationError)) {
                debugLog.push(`Auto-fix shipping after error: ${validationError}`);
                await ensureMercariShippingSelected(payload, mercariHelpers, debugLog, true);
                fixedSomething = true;
              }
              if (/floor price/i.test(validationError)) {
                debugLog.push(`Auto-fix smart pricing after error: ${validationError}`);
                await disableMercariSmartPricing(sleep, debugLog);
                fixedSomething = true;
              }
              if (!fixedSomething) break;

              await sleep(400);
              const retryBtn = findListBtn();
              if (!retryBtn) break;
              retryBtn.scrollIntoView({ block: "center" });
              retryBtn.click();
              await sleep(1200);
              await clickButtonByText([/^list anyway$/i, /^confirm$/i, /^list item$/i], 1500);
            }

            if (window.location.pathname.includes("/sell") && !validationError) {
              validationError = detectMercariValidationError();
            }

            if (!validationError) {
              showRccHud({
                title: `Listed on Mercari! (${payload.sku || "SKU"})`,
                message: `Submitted to Mercari — automatically syncing live link back to Command Center...`,
                tone: "success",
              });
              sendResponse({ ok: true, autoPublished: true });
              return;
            }
          }
        }

        // 8. Mac Mini Auto-Pilot fallback: Save draft if Condition/List couldn't auto-submit
        if (shouldSaveDraft) {
          showRccHud({
            title: `Auto-Pilot · Saving Mercari Draft (${payload.sku || "SKU"})`,
            message: `${fieldSummary}. Saving as Draft for quick review...`,
            tone: "info",
          });

          await sleep(2000);
          const saved = await clickButtonByText(
            [/^save draft$/i, /^save as draft$/i, /save.*draft/i],
            4000
          );

          if (saved) {
            await sleep(2500);
            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "needs_user_confirm",
              extra: {
                listedPrice: payload.suggestedPrice,
                errorMessage: `Saved Mercari Draft (${fieldSummary}) — open Mercari app → Drafts to verify & tap List!`,
              },
            });
            showRccHud({
              title: `Mercari Draft Saved (${payload.sku || "SKU"})`,
              message: `Ready in your Mercari Drafts on iPhone & Mac (${fieldSummary}). Closing worker tab...`,
              tone: "success",
            });
            await sleep(2000);
            chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            sendResponse({ ok: true, savedDraft: true });
            return;
          }
        }

        // 9. Interactive fallback HUD (auto-links as soon as user clicks List!)
        showRccHud({
          title: validationError
            ? `Mercari Needs Quick Fix (${payload.sku || "SKU"})`
            : `Mercari Almost Ready (${payload.sku || "SKU"})`,
          message: validationError
            ? `Mercari flagged: "${validationError}". Fix that field & click List — Command Center will auto-sync once posted!`
            : `Auto-filled · ${fieldSummary}. Pick any missing field & click List — Command Center will auto-sync once posted!`,
          tone: "confirm",
          actionLabel: "Mark Listed Manually",
          onAction: async () => {
            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "completed",
              extra: {
                externalUrl: window.location.href,
                listedPrice: payload.suggestedPrice,
              },
            });
            showRccHud({
              title: "Mercari Synced",
              message: "Listing recorded in Reseller Command Center.",
              tone: "success",
            });
          },
          secondaryLabel:
            !conditionMatched || validationError ? "Copy Mercari Debug Info" : null,
          onSecondaryAction:
            !conditionMatched || validationError
              ? async () => {
                  const txt = `Mercari v1.1.1 Debug (${targetCond}):\n${debugLog.join("\n")}${
                    validationError ? `\nValidation: ${validationError}` : ""
                  }`;
                  try {
                    await navigator.clipboard.writeText(txt);
                    const btn = document.getElementById("rcc-hud-secondary");
                    if (btn) btn.textContent = "Copied! Paste into chat";
                  } catch {
                    alert(txt);
                  }
                }
              : null,
        });

        sendResponse({ ok: true });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await chrome.runtime.sendMessage({
          type: "RCC_JOB_STATUS_UPDATE",
          jobId: job.id,
          status: "failed",
          extra: { errorMessage: errMsg },
        });
        showRccHud({
          title: "Mercari Auto-Fill Error",
          message: errMsg,
          tone: "error",
        });
        sendResponse({ ok: false, error: errMsg });
      }
    })();

    return true;
  });
})();
