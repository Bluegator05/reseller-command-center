/**
 * Mercari DOM Auto-Filler Content Script (Phase 3)
 * Targets https://www.mercari.com/sell/
 */
(function initMercariAgent() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RCC_EXECUTE_JOB" || message.job?.marketplace !== "mercari") {
      return;
    }

    (async () => {
      const { waitForSelector, setNativeValue, injectImageBlobs, showRccHud } =
        window.__rccHelpers;
      const job = message.job;
      const payload = job.payload || {};

      try {
        showRccHud({
          title: `Mercari Auto-Fill (${payload.sku || "SKU"})`,
          message: "Filling title (<=80 chars), description, price, and injecting photos...",
          tone: "info",
        });

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
          setNativeValue(descInput, payload.descriptionPlain);
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
          setNativeValue(priceInput, Math.round(Number(payload.suggestedPrice)));
        }

        const fileInput = await waitForSelector('input[type="file"]', 3000);
        const uploadedCount = await injectImageBlobs(fileInput, payload.imageUrls || []);

        showRccHud({
          title: `Mercari Ready (${payload.sku || "SKU"})`,
          message: `Auto-filled at $${Number(payload.suggestedPrice || 0).toFixed(2)} (${uploadedCount} photos injected). Confirm shipping weight & click List, then confirm below.`,
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
