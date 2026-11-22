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
        const menuRoot =
          dropdownRoot.querySelector('.dropdown__menu, [class*="dropdown__menu"], ul') ||
          dropdownRoot;

        const rawItems = Array.from(
          menuRoot.querySelectorAll(
            ':scope > div, :scope > li, :scope > a, :scope > button, li, a, button, [role="option"], .dropdown__menu__item, div[class*="item"], div[data-test]'
          )
        ).filter((el) => {
          if (el === triggerEl || triggerEl.contains(el)) return false;
          if (!isElementDisplayed(el)) return false;
          const r = el.getBoundingClientRect();
          return r.height >= 18 && r.height <= 165 && r.width >= 24;
        });

        // Deduplicate & collect sample first-line labels for debug
        const seen = new Set();
        const items = [];
        for (const el of rawItems) {
          const line = (el.innerText || el.textContent || "").trim().split(/\r?\n/)[0].trim();
          if (!line || line.length > 65) continue;
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
        // Tell background worker right away to watch this tab for successful publish redirect!
        chrome.runtime.sendMessage({
          type: "RCC_WATCH_PUBLISH_SUCCESS",
          jobId: job.id,
          marketplace: "poshmark",
          sku: payload.sku || job.item_sku || "",
          listedPrice: Math.max(3, Math.round(Number(payload.suggestedPrice || 0))),
          autoPilot: isAutoPilot,
        });

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

        // 3. Auto-select Poshmark Category (Department -> Category)
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
          await sleep(650);
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
        if (categoryMatched) {
          const sizeDropdown = findPoshmarkDropdownByContainerOrText(
            [
              '.listing-editor__size-container [data-test="dropdown"]',
              '.listing-editor__size-container .dropdown',
              '[data-test="size"] [data-test="dropdown"]',
            ],
            /^select size/i
          );
          if (sizeDropdown) {
            const existingSizeTxt = (
              getPoshmarkSelectorTrigger(sizeDropdown)?.textContent || ""
            ).trim();
            if (existingSizeTxt && !/^select size/i.test(existingSizeTxt)) {
              sizeMatched = true;
              debugLog.push(`Size: already "${existingSizeTxt}"`);
            } else {
              const targetSize = sc.sizeLabel || "OS";
              const sizeTarget =
                targetSize.toUpperCase() === "OS"
                  ? ["OS", "One Size", "One Size Fits All"]
                  : [targetSize, "OS", "One Size"];
              sizeMatched = await selectPoshmarkVueDropdown(
                sizeDropdown,
                [sizeTarget],
                sleep,
                debugLog,
                "Size"
              );
            }
          } else {
            // Some Poshmark categories (e.g., certain Home items) auto-hide Size when not required
            sizeMatched = true;
            debugLog.push("Size: not required for this category");
          }
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

        // 6. Brand & Whole-Dollar Prices (closes Listing Price modal cleanly with Done!)
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
          await sleep(550);

          const modalOrig = await waitForSelector(
            ['.modal input[data-vv-name="originalPrice"]', 'input[data-vv-name="originalPrice"]', 'input[name="original_price"]'],
            1200
          );
          if (modalOrig && payload.targetPrice) {
            setNativeValue(modalOrig, Math.max(3, Math.round(Number(payload.targetPrice))));
          }

          const modalPrice =
            document.querySelector('.modal input[data-vv-name="listingPrice"]') ||
            document.querySelector('[role="dialog"] input') ||
            listingPriceInput;
          setNativeValue(modalPrice, Math.max(3, Math.round(Number(payload.suggestedPrice))));

          await sleep(350);
          // Click the black "Done" button in the Listing Price modal footer
          await clickButtonByText([/^done$/i], 2000);
          await sleep(450);
        }

        const catLabel = [sc.department, sc.category, sc.subcategory].filter(Boolean).join(" › ");
        const fieldSummary = [
          `${uploadedCount} photos`,
          categoryMatched ? `Category ✓ (${catLabel})` : `Category: pick "${catLabel || "category"}"`,
          sizeMatched ? `Size ✓ (${sc.sizeLabel || "OS"})` : `Size: pick "${sc.sizeLabel || "OS"}"`,
          conditionMatched ? `Condition ✓` : `Condition: pick "${sc.conditionLabel || "Good"}"`,
        ]
          .filter(Boolean)
          .join(" · ");

        const anyMissed = !categoryMatched || !sizeMatched || !conditionMatched;
        if (debugLog.length > 0) {
          console.log("[RCC Poshmark v0.9.0]", debugLog.join(" | "));
        }

        // 7. Auto-Publish: If Category & Size are populated, click "Next" -> "List This Item"!
        if (categoryMatched && sizeMatched) {
          showRccHud({
            title: `Publishing to Poshmark (${payload.sku || "SKU"})`,
            message: `${fieldSummary}. Waiting for photos to finish uploading, then clicking Next → List This Item...`,
            tone: "info",
          });

          // Give Poshmark CDN enough time to finish uploading multi-photo batch before clicking Next
          await sleep(Math.min(6000, Math.max(1800, uploadedCount * 350)));

          const clickedNext = await clickButtonByText([/^next$/i], 3500);
          if (clickedNext) {
            await sleep(1400);
            // Final confirmation screen: click "List This Item" (or "List" / "Next")
            const clickedList = await clickButtonByText(
              [/^list this item$/i, /^list item$/i, /^list$/i, /^next$/i],
              4500
            );
            if (clickedList) {
              showRccHud({
                title: `Listed on Poshmark! (${payload.sku || "SKU"})`,
                message: `Submitted to Poshmark — automatically syncing live link back to Command Center...`,
                tone: "success",
              });
              sendResponse({ ok: true, autoPublished: true });
              return;
            }
          }
        }

        // 8. Fallback for Mac Mini Auto-Pilot if a required dropdown was ambiguous: Save Draft safely
        if (shouldSaveDraft) {
          showRccHud({
            title: `Auto-Pilot · Saving Poshmark Draft (${payload.sku || "SKU"})`,
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

        // 9. Interactive Mode fallback HUD (auto-links automatically as soon as user clicks Next -> List This Item!)
        showRccHud({
          title: `Poshmark Almost Ready (${payload.sku || "SKU"})`,
          message: `Filled at $${Math.round(Number(payload.suggestedPrice || 0))} · ${fieldSummary}. Pick any missing field & click Next → List This Item — Command Center will auto-sync as soon as it posts!`,
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
              title: "Poshmark Synced",
              message: "Listing recorded in Reseller Command Center.",
              tone: "success",
            });
          },
          secondaryLabel: anyMissed ? "Copy Dropdown Debug Info (to fix any missed field)" : null,
          onSecondaryAction: anyMissed
            ? async () => {
                const txt = `Poshmark v0.9.0 Debug (${catLabel}):\n${debugLog.join("\n")}`;
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
