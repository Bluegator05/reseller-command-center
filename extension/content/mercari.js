/**
 * Mercari DOM Auto-Filler Content Script (v0.8.0)
 * Targets https://www.mercari.com/sell/
 * Fills up to 12 photos, Title (<=80), Description (<=1000), Category, Brand,
 * Condition, and Price (whole dollars).
 * Supports both Interactive 1-Click Mode (iMac/MacBook Air) and Mac Mini Auto-Pilot Save Draft Mode.
 */
(function initMercariAgent() {
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
        showRccHud({
          title: `${isAutoPilot ? "Auto-Pilot · " : ""}Mercari (${payload.sku || "SKU"})`,
          message: `Uploading ${(payload.imageUrls || []).length} eBay photos & filling category, condition, and details...`,
          tone: "info",
        });

        const fileInput = await waitForSelector(
          ['input[type="file"][multiple]', 'input[type="file"]'],
          4000
        );
        const uploadedCount = await injectImageBlobs(
          fileInput,
          payload.imageUrls || [],
          12
        );

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

        // Auto-select Mercari Category (cascading dropdowns)
        const catLevels = [sc.department, sc.category, sc.subcategory].filter(Boolean);
        let categoryMatched = false;
        if (catLevels.length > 0) {
          categoryMatched = await selectDropdownSequence(
            [
              '[data-testid="CategoryDropdown"]',
              'select[data-testid="CategoryId"]',
              'button[aria-label*="Category"]',
              'div[data-testid="Category"]',
            ],
            catLevels
          );
          await sleep(400);
        }

        // Auto-fill Mercari Brand if present
        const brandInput = await waitForSelector(
          [
            'input[data-testid="Brand"]',
            'input[placeholder*="Brand"]',
            'input[name="brand"]',
          ],
          2000
        );
        if (brandInput && payload.brand) {
          setNativeValue(brandInput, payload.brand);
          await sleep(500);
          await clickMatchingOption(payload.brand, 1500);
        }

        // Auto-select Mercari Condition radio/button ("New", "Like new", "Good", "Fair", "Poor")
        let conditionMatched = false;
        if (sc.conditionLabel) {
          conditionMatched = await clickMatchingOption(sc.conditionLabel, 2000);
          await sleep(250);
        }

        const priceInput = await waitForSelector(
          [
            'input[data-testid="Price"]',
            'input[name="price"]',
            'input[placeholder*="0.00"]',
          ],
          3000
        );
        if (priceInput && payload.suggestedPrice) {
          setNativeValue(priceInput, Math.max(5, Math.round(Number(payload.suggestedPrice))));
        }

        const fieldSummary = [
          `${uploadedCount} photos`,
          categoryMatched ? `Category ✓ (${catLevels.join(" › ")})` : `Category: verify "${catLevels.join(" › ") || "category"}"`,
          conditionMatched ? `Condition ✓ (${sc.conditionLabel})` : `Condition: pick "${sc.conditionLabel || "Good"}"`,
        ].join(" · ");

        if (shouldSaveDraft) {
          showRccHud({
            title: `Auto-Pilot · Saving Mercari Draft (${payload.sku || "SKU"})`,
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
                errorMessage: `Saved Mercari Draft (${fieldSummary}) — open Mercari app → Drafts to verify shipping & tap List!`,
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

        showRccHud({
          title: `Mercari Ready (${payload.sku || "SKU"})`,
          message: `Auto-filled at $${Math.round(Number(payload.suggestedPrice || 0))} · ${fieldSummary}. Confirm shipping weight & click List, then confirm below.`,
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
              title: "Mercari Synced",
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
