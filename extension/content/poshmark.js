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

        // 3. Auto-select Poshmark Category (Department -> Category -> Subcategory)
        const catSequence = [sc.department, sc.category, sc.subcategory].filter(Boolean);
        let categoryMatched = false;
        if (catSequence.length > 0) {
          categoryMatched = await selectDropdownSequence(
            [
              '[data-et-name="select_category"]',
              '[data-vv-name="category"]',
              'div[class*="category"] .dropdown__selector',
              'button[aria-label*="Category"]',
            ],
            catSequence
          );
          await sleep(400);
        }

        // 4. Auto-select Poshmark Size (defaults to OS for Home/Bags/Crafts/Electronics)
        let sizeMatched = false;
        if (sc.sizeLabel) {
          sizeMatched = await selectDropdownSequence(
            [
              '[data-et-name="select_size"]',
              '[data-vv-name="size"]',
              'div[class*="size"] .dropdown__selector',
              'button[aria-label*="Size"]',
            ],
            [sc.sizeLabel === "OS" ? "OS" : sc.sizeLabel, "One Size"]
          );
          await sleep(300);
        }

        // 5. Set NWT ("New With Tags") button if applicable
        if (sc.conditionLabel && /new with tags|nwt/i.test(sc.conditionLabel)) {
          await clickButtonByText([/^yes$/i, /^new with tags$/i], 1200);
        }

        // 6. Brand & Whole-Dollar Prices
        const brandInput = await waitForSelector(
          ['input[placeholder*="Enter the Brand"]', 'input[name="brand"]'],
          3000
        );
        if (brandInput && payload.brand) {
          setNativeValue(brandInput, payload.brand);
        }

        const originalPriceInput = await waitForSelector(
          ['input[data-vv-name="originalPrice"]', 'input[name="original_price"]'],
          2000
        );
        if (originalPriceInput && payload.targetPrice) {
          setNativeValue(originalPriceInput, Math.max(3, Math.round(Number(payload.targetPrice))));
        }

        const listingPriceInput = await waitForSelector(
          ['input[data-vv-name="listingPrice"]', 'input[name="listing_price"]'],
          3000
        );
        if (listingPriceInput && payload.suggestedPrice) {
          setNativeValue(listingPriceInput, Math.max(3, Math.round(Number(payload.suggestedPrice))));
        }

        const fieldSummary = [
          `${uploadedCount} photos`,
          categoryMatched ? `Category ✓ (${catSequence.join(" › ")})` : `Category: pick "${catSequence.join(" › ") || "category"}"`,
          sizeMatched ? `Size ✓ (${sc.sizeLabel})` : sc.sizeLabel ? `Size: pick "${sc.sizeLabel}"` : null,
        ]
          .filter(Boolean)
          .join(" · ");

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
