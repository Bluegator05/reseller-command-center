/**
 * Poshmark DOM Auto-Filler Content Script (v0.8.4)
 * Targets https://poshmark.com/create-listing
 * Surgically targets Poshmark's Vue `[data-test="dropdown"]` components inside
 * `.listing-editor__category-container`, `.listing-editor__size-container`,
 * and `.listing-editor__condition-container`.
 */
(function initPoshmarkAgent() {
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function scoreFirstLine(el, targetLabels) {
    const rawInner = (el.innerText || el.textContent || "").trim();
    if (!rawInner) return 0;
    const firstLine = rawInner.split(/\r?\n/)[0].trim();
    const a = norm(firstLine);
    if (!a) return 0;

    let best = 0;
    const list = Array.isArray(targetLabels) ? targetLabels : [targetLabels];
    for (const rawTarget of list) {
      const b = norm(rawTarget);
      if (!b) continue;
      if (a === b) return 1.0;
      if (b.length <= 3) {
        if (a.split(" ").includes(b)) best = Math.max(best, 0.94);
        continue;
      }
      if (a.startsWith(b) || b.startsWith(a)) {
        best = Math.max(best, 0.9);
      } else {
        const wordRe = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (wordRe.test(a)) best = Math.max(best, 0.85);
      }
    }
    return best;
  }

  function findPoshmarkDropdownByContainerOrText(containerSelectors, textRegex) {
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const allDropdowns = Array.from(
      document.querySelectorAll('[data-test="dropdown"], div.dropdown')
    );
    for (const dd of allDropdowns) {
      const selectorEl =
        dd.querySelector('.dropdown__selector, [data-test="dropdown-selector"], .dropdown__link') ||
        dd.firstElementChild;
      const txt = (selectorEl?.textContent || dd.textContent || "").replace(/\s+/g, " ").trim();
      if (textRegex.test(txt)) return dd;
    }
    return null;
  }

  function getPoshmarkSelectorTrigger(dropdownRoot) {
    if (!dropdownRoot) return null;
    return (
      dropdownRoot.querySelector('.dropdown__selector') ||
      dropdownRoot.querySelector('[data-test="dropdown-selector"]') ||
      dropdownRoot.querySelector('.dropdown__link') ||
      dropdownRoot.querySelector('button') ||
      dropdownRoot.firstElementChild
    );
  }

  function isElementDisplayed(el) {
    if (!el) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  async function selectPoshmarkVueDropdown(dropdownRoot, stepTargets, sleep, debugOut, labelName) {
    if (!dropdownRoot) {
      debugOut.push(`${labelName}: dropdown root not found`);
      return false;
    }
    const triggerEl = getPoshmarkSelectorTrigger(dropdownRoot);
    if (!triggerEl) {
      debugOut.push(`${labelName}: selector trigger not found inside dropdown`);
      return false;
    }

    const beforeLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();

    // Open the Vue dropdown menu
    triggerEl.scrollIntoView({ block: "center" });
    await sleep(150);
    triggerEl.click();
    await sleep(450);

    let clickedSteps = 0;
    for (let stepIdx = 0; stepIdx < stepTargets.length; stepIdx++) {
      const target = stepTargets[stepIdx];
      let matchedEl = null;
      let sampleLines = [];

      const start = Date.now();
      while (Date.now() - start < 2400) {
        // Look inside this specific dropdownRoot's menu first (covers both single-level & 2-column menus)
        const menuRoot =
          dropdownRoot.querySelector('.dropdown__menu, [class*="dropdown__menu"], ul') ||
          dropdownRoot;

        const rawItems = Array.from(
          menuRoot.querySelectorAll('li, a, button, [role="option"], .dropdown__menu__item, div[data-test]')
        ).filter((el) => {
          if (el === triggerEl || triggerEl.contains(el)) return false;
          if (!isElementDisplayed(el)) return false;
          const r = el.getBoundingClientRect();
          return r.height >= 18 && r.height <= 160 && r.width >= 30;
        });

        // Deduplicate & collect sample first-line labels for debug
        const seen = new Set();
        const items = [];
        for (const el of rawItems) {
          const line = (el.innerText || el.textContent || "").trim().split(/\r?\n/)[0].trim();
          if (!line || line.length > 60) continue;
          if (seen.has(line)) continue;
          seen.add(line);
          items.push(el);
        }
        sampleLines = Array.from(seen).slice(0, 12);

        let bestEl = null;
        let bestScore = 0;
        for (const el of items) {
          const score = scoreFirstLine(el, target);
          if (score > bestScore) {
            bestScore = score;
            bestEl = el;
          }
        }

        if (bestEl && bestScore >= 0.8) {
          matchedEl = bestEl;
          break;
        }
        await sleep(200);
      }

      if (!matchedEl) {
        debugOut.push(
          `${labelName} step ${stepIdx + 1} missed ${JSON.stringify(target)}; saw: [${sampleLines.join(", ")}]`
        );
        break;
      }

      // Trigger hover + click (handles Poshmark's 2-column Department -> Category menu cleanly)
      matchedEl.scrollIntoView({ block: "nearest" });
      try {
        matchedEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        matchedEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      } catch {
        // ignore
      }
      // If there's an inner <a> or <button> inside an <li>, click it; otherwise click the element itself
      const clickableChild =
        matchedEl.tagName === "LI" ? matchedEl.querySelector("a, button") || matchedEl : matchedEl;
      clickableChild.click();
      clickedSteps += 1;
      await sleep(500);
    }

    const afterLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();
    const changed = afterLabel !== beforeLabel;
    if (changed) {
      debugOut.push(`${labelName}: OK ("${beforeLabel}" -> "${afterLabel}")`);
    } else if (clickedSteps === stepTargets.length) {
      debugOut.push(`${labelName}: clicked ${clickedSteps} steps but label stayed "${afterLabel}"`);
    }
    return changed;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RCC_EXECUTE_JOB" || message.job?.marketplace !== "poshmark") {
      return;
    }

    (async () => {
      const {
        waitForSelector,
        setNativeValue,
        injectImageBlobs,
        sleep,
        clickButtonByText,
        showRccHud,
      } = window.__rccHelpers;
      const job = message.job;
      const payload = job.payload || {};
      const sc = payload.structuredCategory || {};
      const isAutoPilot = Boolean(message.autoPilot);
      const shouldSaveDraft = Boolean(message.autoPilot && message.autoPilotSaveDraft);

      try {
        showRccHud({
          title: `${isAutoPilot ? "Auto-Pilot · " : ""}Poshmark (${payload.sku || "SKU"})`,
          message: `Uploading ${(payload.imageUrls || []).length} eBay photos & filling category, size, condition, and details...`,
          tone: "info",
        });

        // 1. Inject up to 16 full-res photos into Poshmark's multi-file input
        const fileInput = await waitForSelector(
          [
            'input#img-file-input[type="file"]',
            'input[type="file"][multiple]',
            'input[type="file"]',
          ],
          5000
        );
        const uploadedCount = await injectImageBlobs(
          fileInput,
          payload.imageUrls || [],
          16
        );

        // If Poshmark opens the cover-photo crop modal, auto-click "Apply"
        if (uploadedCount > 0) {
          await sleep(1200);
          await clickButtonByText([/^apply$/i, /^done$/i], 3500);
          await sleep(800);
        }

        // 2. Fill Title (<=80 chars) & Description (<=1500 chars)
        const titleInput = await waitForSelector([
          'input[data-vv-name="title"]',
          'input[placeholder*="What are you selling"]',
          'input[name="title"]',
        ]);
        if (titleInput && payload.mappedTitle) {
          setNativeValue(titleInput, String(payload.mappedTitle).slice(0, 80));
        }

        const descInput = await waitForSelector(
          [
            'textarea[data-vv-name="description"]',
            'textarea[placeholder*="Describe it"]',
            'textarea[name="description"]',
          ],
          4000
        );
        if (descInput && payload.descriptionPlain) {
          setNativeValue(descInput, String(payload.descriptionPlain).slice(0, 1500));
        }

        const debugLog = [];

        // 3. Auto-select Poshmark Category (Department -> Category) inside `.listing-editor__category-container`
        const catDropdown = findPoshmarkDropdownByContainerOrText(
          [
            '.listing-editor__category-container [data-test="dropdown"]',
            '.listing-editor__category-container .dropdown',
          ],
          /^select category/i
        );
        const catSteps = [sc.department, sc.category].filter(Boolean);
        let categoryMatched = false;
        if (catSteps.length > 0) {
          categoryMatched = await selectPoshmarkVueDropdown(
            catDropdown,
            catSteps,
            sleep,
            debugLog,
            "Category"
          );
          await sleep(600);
        }

        // 3b. Optional Subcategory dropdown
        if (categoryMatched && sc.subcategory) {
          const subDropdown = findPoshmarkDropdownByContainerOrText(
            [
              '.listing-editor__subcategory-container [data-test="dropdown"]',
              '.listing-editor__subcategory-container .dropdown',
            ],
            /^select subcategory/i
          );
          if (subDropdown) {
            await selectPoshmarkVueDropdown(
              subDropdown,
              [sc.subcategory],
              sleep,
              debugLog,
              "Subcategory"
            );
            await sleep(450);
          }
        }

        // 4. Auto-select Poshmark Size (unlocks right after Category is selected)
        let sizeMatched = false;
        if (categoryMatched && sc.sizeLabel) {
          const sizeDropdown = findPoshmarkDropdownByContainerOrText(
            [
              '.listing-editor__size-container [data-test="dropdown"]',
              '.listing-editor__size-container .dropdown',
            ],
            /^select size/i
          );
          const sizeTarget =
            sc.sizeLabel.toUpperCase() === "OS"
              ? ["OS", "One Size", "One Size Fits All"]
              : [sc.sizeLabel];
          sizeMatched = await selectPoshmarkVueDropdown(
            sizeDropdown,
            [sizeTarget],
            sleep,
            debugLog,
            "Size"
          );
          await sleep(450);
        }

        // 5. Auto-select Poshmark Condition inside `.listing-editor__condition-container`
        let conditionMatched = false;
        if (sc.conditionLabel) {
          const condDropdown = findPoshmarkDropdownByContainerOrText(
            [
              '.listing-editor__condition-container [data-test="dropdown"]',
              '.listing-editor__condition-container .dropdown',
            ],
            /^select condition/i
          );
          const isNew = /new with tags|nwt|brand new/i.test(sc.conditionLabel);
          const isLikeNew = /like new|nwot|mint|excellent/i.test(sc.conditionLabel);
          const isFair = /fair|acceptable/i.test(sc.conditionLabel);
          const condTarget = isNew
            ? ["New With Tags (NWT)", "New With Tags"]
            : isLikeNew
              ? ["Like New"]
              : isFair
                ? ["Fair"]
                : ["Good"];
          conditionMatched = await selectPoshmarkVueDropdown(
            condDropdown,
            [condTarget],
            sleep,
            debugLog,
            "Condition"
          );
          await sleep(350);
        }

        // 6. Brand & Whole-Dollar Prices
        const brandInput = await waitForSelector(
          ['input[placeholder*="Enter the Brand"]', 'input[name="brand"]'],
          3000
        );
        if (brandInput && payload.brand) {
          setNativeValue(brandInput, payload.brand);
        }

        const listingPriceInput = await waitForSelector(
          ['input[data-vv-name="listingPrice"]', 'input[name="listing_price"]', 'input[placeholder*="Listing Price"]'],
          3000
        );
        if (listingPriceInput && payload.suggestedPrice) {
          listingPriceInput.scrollIntoView({ block: "center" });
          listingPriceInput.click();
          await sleep(500);

          const modalOrig = await waitForSelector(
            ['.modal input[data-vv-name="originalPrice"]', 'input[data-vv-name="originalPrice"]', 'input[name="original_price"]'],
            1200
          );
          if (modalOrig && payload.targetPrice) {
            setNativeValue(modalOrig, Math.max(3, Math.round(Number(payload.targetPrice))));
          }

          const modalPrice =
            document.querySelector('.modal input[data-vv-name="listingPrice"]') ||
            listingPriceInput;
          setNativeValue(modalPrice, Math.max(3, Math.round(Number(payload.suggestedPrice))));

          await sleep(350);
          // Only click Done if Poshmark's Pricing modal is currently open
          const openModal = document.querySelector('.modal__body, .modal--in, [role="dialog"]');
          if (openModal) {
            const doneBtn = Array.from(openModal.querySelectorAll("button, a")).find((b) =>
              /^done$/i.test((b.textContent || "").trim())
            );
            if (doneBtn) doneBtn.click();
            await sleep(300);
          }
        }

        const catLabel = [sc.department, sc.category, sc.subcategory].filter(Boolean).join(" › ");
        const fieldSummary = [
          `${uploadedCount} photos`,
          categoryMatched ? `Category ✓ (${catLabel})` : `Category: pick "${catLabel || "category"}"`,
          sizeMatched ? `Size ✓ (${sc.sizeLabel})` : sc.sizeLabel ? `Size: pick "${sc.sizeLabel}"` : null,
          conditionMatched ? `Condition ✓` : `Condition: pick "${sc.conditionLabel || "Good"}"`,
        ]
          .filter(Boolean)
          .join(" · ");

        const anyMissed = !categoryMatched || !sizeMatched || !conditionMatched;
        if (debugLog.length > 0) {
          console.log("[RCC Poshmark v0.8.4]", debugLog.join(" | "));
        }

        // 7. Mac Mini Auto-Pilot Save Draft flow (never blind-publishes!)
        if (shouldSaveDraft) {
          showRccHud({
            title: `Auto-Pilot · Saving Poshmark Draft (${payload.sku || "SKU"})`,
            message: `${fieldSummary}. Waiting for photo upload, then saving Draft...`,
            tone: "info",
          });

          await sleep(Math.min(7000, Math.max(2500, uploadedCount * 450)));

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
                errorMessage: `Saved Poshmark Draft (${fieldSummary}) — open Poshmark app → Drafts to verify & tap List!`,
              },
            });
            showRccHud({
              title: `Poshmark Draft Saved (${payload.sku || "SKU"})`,
              message: `Ready in your Poshmark Drafts on iPhone & Mac (${fieldSummary}). Closing worker tab...`,
              tone: "success",
            });
            await sleep(2000);
            chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            sendResponse({ ok: true, savedDraft: true });
            return;
          }
        }

        // 8. Interactive Mode HUD (iMac / MacBook Air 1-click flow)
        showRccHud({
          title: `Poshmark Ready (${payload.sku || "SKU"})`,
          message: `Filled at $${Math.round(Number(payload.suggestedPrice || 0))} · ${fieldSummary}. Review & click Next → List This Item, then click below.`,
          tone: "success",
          actionLabel: "Mark Listed in Command Center",
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
              title: "Poshmark Synced",
              message: "Listing recorded in Reseller Command Center.",
              tone: "success",
            });
          },
          secondaryLabel: anyMissed ? "Copy Dropdown Debug Info (to fix any missed field)" : null,
          onSecondaryAction: anyMissed
            ? async () => {
                const txt = `Poshmark v0.8.4 Debug (${catLabel}):\n${debugLog.join("\n")}`;
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
          title: "Poshmark Auto-Fill Error",
          message: errMsg,
          tone: "error",
        });
        sendResponse({ ok: false, error: errMsg });
      }
    })();

    return true;
  });
})();
