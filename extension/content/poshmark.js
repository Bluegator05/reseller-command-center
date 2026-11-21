/**
 * Poshmark DOM Auto-Filler Content Script (Phase 3)
 * Targets https://poshmark.com/create-listing
 */
(function initPoshmarkAgent() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RCC_EXECUTE_JOB" || message.job?.marketplace !== "poshmark") {
      return;
    }

    (async () => {
      const { waitForSelector, setNativeValue, injectImageBlobs, showRccHud } =
        window.__rccHelpers;
      const job = message.job;
      const payload = job.payload || {};

      try {
        showRccHud({
          title: `Poshmark Auto-Fill (${payload.sku || "SKU"})`,
          message: "Filling title, description, brand, price, and uploading CDN photos...",
          tone: "info",
        });

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

        const fileInput = await waitForSelector('input[type="file"]', 3000);
        const uploadedCount = await injectImageBlobs(fileInput, payload.imageUrls || []);

        showRccHud({
          title: `Poshmark Ready (${payload.sku || "SKU"})`,
          message: `Filled listing at $${Number(payload.suggestedPrice || 0).toFixed(2)} (${uploadedCount} photos injected). Select category/size if prompted, then click Confirm Listed.`,
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
