/**
 * Poshmark DOM Auto-Filler Content Script (v0.8.0)
 * Targets https://poshmark.com/create-listing
 * Fills up to 16 photos, Title (<=80), Description (<=1500), Category/Subcategory,
 * Size, NWT Condition, Brand, Original Price, and Listing Price (whole dollars).
 * Supports both Interactive 1-Click Mode (iMac/MacBook Air) and Mac Mini Auto-Pilot Save Draft Mode.
 */
(function initPoshmarkAgent() {
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
        selectDropdownSequence,
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

        // 3. Auto-select Poshmark Category ("Select Category" -> Department -> Category)
        const mainCatSteps = [sc.department, sc.category].filter(Boolean);
        let categoryMatched = false;
        if (mainCatSteps.length > 0) {
          categoryMatched = await selectDropdownSequence(
            [
              '[data-et-name="select_category"]',
              '[data-vv-name="category"]',
              'div[class*="category"] .dropdown__selector',
            ],
            mainCatSteps,
            [/^select category$/i],
            debugLog
          );
          await sleep(600);
        }

        // 3b. Optional Subcategory ("Select Subcategory")
        if (categoryMatched && sc.subcategory) {
          await selectDropdownSequence(
            ['[data-et-name="select_subcategory"]', 'div[class*="subcategory"] .dropdown__selector'],
            [sc.subcategory],
            [/^select subcategory/i],
            debugLog
          );
          await sleep(450);
        }

        // 4. Auto-select Poshmark Size ("Select Size" — only enabled after Category is chosen)
        let sizeMatched = false;
        if (categoryMatched && sc.sizeLabel) {
          const sizeTargets =
            sc.sizeLabel.toUpperCase() === "OS"
              ? [["OS", "One Size", "One Size Fits All"]]
              : [[sc.sizeLabel]];
          sizeMatched = await selectDropdownSequence(
            [
              '[data-et-name="select_size"]',
              '[data-vv-name="size"]',
              'div[class*="size"] .dropdown__selector',
            ],
            sizeTargets,
            [/^select size$/i],
            debugLog
          );
          await sleep(450);
        }

        // 5. Auto-select Poshmark 2026 Condition dropdown ("Select Condition")
        let conditionMatched = false;
        if (sc.conditionLabel) {
          const isNew = /new with tags|nwt|brand new/i.test(sc.conditionLabel);
          const condTargets = isNew
            ? [["New With Tags", "NWT", "Brand New", "New"]]
            : [["Good", "Gently Used", "Pre-owned", "Like New", "Fair"]];
          conditionMatched = await selectDropdownSequence(
            [
              '[data-et-name="select_condition"]',
              '[data-vv-name="condition"]',
              'div[class*="condition"] .dropdown__selector',
            ],
            condTargets,
            [/^select condition$/i],
            debugLog
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
          await clickButtonByText([/^done$/i], 1400);
          await sleep(300);
        }

        const catLabel = [sc.department, sc.category, sc.subcategory].filter(Boolean).join(" › ");
        const fieldSummary = [
          `${uploadedCount} photos`,
          categoryMatched ? `Category ✓ (${catLabel})` : `Category: pick "${catLabel || "category"}"`,
          sizeMatched ? `Size ✓ (${sc.sizeLabel})` : sc.sizeLabel ? `Size: pick "${sc.sizeLabel}"` : null,
          conditionMatched ? `Condition ✓` : `Condition: pick "${sc.conditionLabel || "Pre-owned"}"`,
        ]
          .filter(Boolean)
          .join(" · ");

        const anyMissed = !categoryMatched || !sizeMatched || !conditionMatched;
        if (debugLog.length > 0) {
          console.log("[RCC Poshmark v0.8.2]", debugLog.join(" | "));
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
                const txt = `Poshmark v0.8.2 Debug (${catLabel}):\n${debugLog.join("\n")}`;
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
