/**
 * Facebook Marketplace DOM Auto-Filler Content Script (Phase 3)
 * Targets https://www.facebook.com/marketplace/create/item
 *
 * IMPORTANT: Intentionally pauses in `needs_user_confirm` state before final Publish
 * per blueprint spec so the seller reviews & clicks Publish manually.
 */
(function initFacebookAgent() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RCC_EXECUTE_JOB" || message.job?.marketplace !== "facebook") {
      return;
    }

    (async () => {
      const { waitForSelector, setNativeValue, injectImageBlobs, showRccHud } =
        window.__rccHelpers;
      const job = message.job;
      const payload = job.payload || {};

      try {
        showRccHud({
          title: `FB Marketplace Auto-Fill (${payload.sku || "SKU"})`,
          message: "Filling title, price, description, and injecting CDN photos...",
          tone: "info",
        });

        const titleInput = await waitForSelector([
          'label[aria-label="Title"] input',
          'input[aria-label="Title"]',
          'input[placeholder="Title"]',
        ]);
        if (titleInput && payload.mappedTitle) {
          setNativeValue(titleInput, String(payload.mappedTitle).slice(0, 99));
        }

        const priceInput = await waitForSelector(
          [
            'label[aria-label="Price"] input',
            'input[aria-label="Price"]',
            'input[placeholder="Price"]',
          ],
          4000
        );
        if (priceInput && payload.suggestedPrice) {
          setNativeValue(priceInput, Math.round(Number(payload.suggestedPrice)));
        }

        const descInput = await waitForSelector(
          [
            'label[aria-label="Description"] textarea',
            'textarea[aria-label="Description"]',
            'textarea[placeholder="Description"]',
          ],
          4000
        );
        if (descInput && payload.descriptionPlain) {
          setNativeValue(descInput, payload.descriptionPlain);
        }

        const fileInput = await waitForSelector('input[type="file"][accept*="image"]', 3000);
        const uploadedCount = await injectImageBlobs(fileInput, payload.imageUrls || []);

        // Mandatory safety gate: pause in `needs_user_confirm` before clicking Publish
        await chrome.runtime.sendMessage({
          type: "RCC_JOB_STATUS_UPDATE",
          jobId: job.id,
          status: "needs_user_confirm",
        });

        showRccHud({
          title: "Paused — Manual Review Required",
          message: `Filled FB Marketplace at $${Number(payload.suggestedPrice || 0).toFixed(2)} (${uploadedCount} photos). Review category/condition, click Facebook's Publish button manually, then click Confirm below.`,
          tone: "confirm",
          actionLabel: "I Clicked Publish — Mark Complete",
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
              title: "FB Marketplace Synced",
              message: "Listing marked active in Reseller Command Center.",
              tone: "success",
            });
          },
        });

        sendResponse({ ok: true, status: "needs_user_confirm" });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await chrome.runtime.sendMessage({
          type: "RCC_JOB_STATUS_UPDATE",
          jobId: job.id,
          status: "failed",
          extra: { errorMessage: errMsg },
        });
        showRccHud({
          title: "FB Marketplace Auto-Fill Error",
          message: errMsg,
          tone: "error",
        });
        sendResponse({ ok: false, error: errMsg });
      }
    })();

    return true;
  });
})();
