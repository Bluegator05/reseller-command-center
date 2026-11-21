/**
 * Poshmark DOM Auto-Filler Content Script (v0.7.0)
 * Targets https://poshmark.com/create-listing
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
        showRccHud,
      } = window.__rccHelpers;
      const job = message.job;
      const payload = job.payload || {};
      const isAutoPilot = Boolean(message.autoPilot);
      const shouldSaveDraft = Boolean(message.autoPilot && message.autoPilotSaveDraft);

      try {
        showRccHud({
          title: `${isAutoPilot ? "Auto-Pilot · " : ""}Poshmark (${payload.sku || "SKU"})`,
          message: `Uploading ${(payload.imageUrls || []).length} eBay photos & filling listing details...`,
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

        // 2. Fill Title, Description, Brand, Original Price, Listing Price
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
          setNativeValue(descInput, payload.descriptionPlain);
        }

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
          setNativeValue(originalPriceInput, Math.round(Number(payload.targetPrice)));
        }

        const listingPriceInput = await waitForSelector(
          ['input[data-vv-name="listingPrice"]', 'input[name="listing_price"]'],
          3000
        );
        if (listingPriceInput && payload.suggestedPrice) {
          setNativeValue(listingPriceInput, Math.round(Number(payload.suggestedPrice)));
        }

        // 3. Mac Mini Auto-Pilot Save Draft flow (pops straight into Poshmark iPhone app Drafts!)
        if (shouldSaveDraft) {
          showRccHud({
            title: `Auto-Pilot · Saving Poshmark Draft (${payload.sku || "SKU"})`,
            message: `Uploaded ${uploadedCount} photos. Waiting for photo upload to finish, then clicking Save Draft...`,
            tone: "info",
          });

          // Give Poshmark CDN time to finish uploading multi-photo batch
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
                errorMessage: `Saved as Poshmark Draft (${uploadedCount} photos) — open Poshmark app on iPhone/Mac → Drafts, pick Category/Size & tap List!`,
              },
            });
            showRccHud({
              title: `Poshmark Draft Saved (${payload.sku || "SKU"})`,
              message: `Ready in your Poshmark Drafts on iPhone & Mac (${uploadedCount} photos). Closing worker tab...`,
              tone: "success",
            });
            await sleep(2000);
            chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            sendResponse({ ok: true, savedDraft: true });
            return;
          }
        }

        // 4. Interactive Mode HUD (iMac / MacBook Air 1-click flow)
        showRccHud({
          title: `Poshmark Ready (${payload.sku || "SKU"})`,
          message: `Filled listing at $${Number(payload.suggestedPrice || 0).toFixed(2)} (${uploadedCount} photos injected). Pick Category & Size, click Next → List This Item, then click below.`,
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
