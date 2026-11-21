const jobsContainer = document.getElementById("jobs-container");
const jobCountEl = document.getElementById("job-count");
const pollMetaEl = document.getElementById("poll-meta");
const errorBarEl = document.getElementById("error-bar");

const modeEl = document.getElementById("cfg-mode");
const apiUrlEl = document.getElementById("cfg-api-url");
const passcodeEl = document.getElementById("cfg-passcode");
const cfgDetailsEl = document.getElementById("cfg-details");
const sbUrlEl = document.getElementById("cfg-sb-url");
const sbKeyEl = document.getElementById("cfg-sb-key");
const bridgeFieldsEl = document.getElementById("bridge-fields");
const supabaseFieldsEl = document.getElementById("supabase-fields");

function toggleModeFields() {
  const isSb = modeEl.value === "supabase";
  bridgeFieldsEl.style.display = isSb ? "none" : "block";
  supabaseFieldsEl.style.display = isSb ? "block" : "none";
}

modeEl.addEventListener("change", toggleModeFields);

function renderJobs(jobs) {
  const activeJobs = (jobs || []).filter(
    (j) =>
      j.status === "pending" ||
      j.status === "processing" ||
      j.status === "needs_user_confirm"
  );
  jobCountEl.textContent = `${activeJobs.length} queued`;

  if (activeJobs.length === 0) {
    jobsContainer.innerHTML =
      '<div class="empty">No pending extension jobs. Queue a Poshmark, Mercari, or Facebook Marketplace cross-list from the Command Center.</div>';
    return;
  }

  jobsContainer.innerHTML = "";
  for (const job of activeJobs) {
    const row = document.createElement("div");
    row.className = "job-row";

    const pillCls =
      job.status === "needs_user_confirm"
        ? "pill-confirm"
        : job.status === "completed"
          ? "pill-done"
          : "pill-pending";

    const isDelist = job.action === "delist";
    const price = job.payload?.suggestedPrice
      ? `$${Number(job.payload.suggestedPrice).toFixed(2)}`
      : "";

    row.innerHTML = `
      <div class="job-top">
        <span class="sku">${isDelist ? "⚠ DELIST · " : ""}${job.item_sku || job.item_id.slice(0, 8)} · ${job.marketplace.toUpperCase()} ${price}</span>
        <span class="pill ${pillCls}">${isDelist ? "URGENT DELIST" : job.status.replace(/_/g, " ")}</span>
      </div>
      <div class="title">${isDelist ? `Sold on another channel (${job.payload?.reason || "auto-delist"}) — end listing immediately` : job.payload?.mappedTitle || job.item_title || "Cross-list job"}</div>
      <div class="actions"></div>
    `;

    const actionsEl = row.querySelector(".actions");

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.style.color = "#b91c1c";
    cancelBtn.style.borderColor = "#fecaca";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Removing...";
      await chrome.runtime.sendMessage({
        type: "RCC_DELETE_JOB",
        jobId: job.id,
      });
      await loadState();
    });
    actionsEl.appendChild(cancelBtn);

    if (job.status === "needs_user_confirm") {
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "btn btn-confirm";
      confirmBtn.textContent = "Confirm Published";
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        await chrome.runtime.sendMessage({
          type: "RCC_JOB_STATUS_UPDATE",
          jobId: job.id,
          status: "completed",
        });
        await loadState();
      });
      actionsEl.appendChild(confirmBtn);
    } else {
      const runBtn = document.createElement("button");
      runBtn.className = "btn btn-primary";
      runBtn.textContent =
        job.marketplace === "facebook"
          ? "Auto-Fill & Review"
          : `Auto-Fill ${job.marketplace}`;
      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        runBtn.textContent = "Opening tab...";
        await chrome.runtime.sendMessage({ type: "RCC_RUN_JOB", job });
        window.close();
      });
      actionsEl.appendChild(runBtn);
    }

    jobsContainer.appendChild(row);
  }
}

async function loadState() {
  const res = await chrome.runtime.sendMessage({ type: "RCC_GET_STATE" });
  if (!res?.ok) return;

  modeEl.value = res.config.mode || "api_bridge";
  apiUrlEl.value =
    res.config.apiBaseUrl || "https://reseller-command-center-black.vercel.app";
  passcodeEl.value = res.config.ownerPasscode || "";
  sbUrlEl.value = res.config.supabaseUrl || "";
  sbKeyEl.value = res.config.supabaseAnonKey || "";
  toggleModeFields();

  if (
    cfgDetailsEl &&
    modeEl.value === "api_bridge" &&
    (!passcodeEl.value || (res.lastError && res.lastError.includes("passcode")))
  ) {
    cfgDetailsEl.open = true;
  }

  if (res.lastPollAt) {
    pollMetaEl.textContent = `Synced ${new Date(res.lastPollAt).toLocaleTimeString()}`;
  }

  if (res.lastError) {
    errorBarEl.style.display = "block";
    errorBarEl.textContent = res.lastError;
  } else {
    errorBarEl.style.display = "none";
  }

  renderJobs(res.jobs || []);
}

document.getElementById("btn-poll").addEventListener("click", async () => {
  const btn = document.getElementById("btn-poll");
  btn.textContent = "Polling...";
  await chrome.runtime.sendMessage({ type: "RCC_POLL_NOW" });
  await loadState();
  btn.textContent = "Poll Queue";
});

document.getElementById("btn-save-cfg").addEventListener("click", async () => {
  const btn = document.getElementById("btn-save-cfg");
  btn.textContent = "Connecting...";
  await chrome.runtime.sendMessage({
    type: "RCC_SAVE_CONFIG",
    config: {
      mode: modeEl.value,
      apiBaseUrl: apiUrlEl.value.trim(),
      ownerPasscode: passcodeEl.value.trim(),
      supabaseUrl: sbUrlEl.value.trim(),
      supabaseAnonKey: sbKeyEl.value.trim(),
    },
  });
  await chrome.runtime.sendMessage({ type: "RCC_POLL_NOW" });
  await loadState();
  btn.textContent = "Save & Reconnect";
  if (cfgDetailsEl && !errorBarEl.textContent) {
    cfgDetailsEl.open = false;
  }
});

const btnScanEl = document.getElementById("btn-scan-page");
const scanStatusEl = document.getElementById("scan-status");
const scanReviewEl = document.getElementById("scan-review");

if (btnScanEl) {
  btnScanEl.addEventListener("click", async () => {
    btnScanEl.disabled = true;
    btnScanEl.textContent = "Auto-scrolling page & matching all SKUs...";
    errorBarEl.style.display = "none";
    scanStatusEl.style.display = "none";
    scanReviewEl.innerHTML = "";

    const res = await chrome.runtime.sendMessage({
      type: "RCC_SCAN_ACTIVE_TAB",
    });

    btnScanEl.disabled = false;
    btnScanEl.textContent = "Auto-Scroll & Scan All Listings";

    if (!res?.ok) {
      errorBarEl.style.display = "block";
      errorBarEl.textContent = res?.error || "Scan failed";
      if (cfgDetailsEl && errorBarEl.textContent.includes("passcode")) {
        cfgDetailsEl.open = true;
      }
      return;
    }

    await loadState();

    const review = Array.isArray(res.reviewMatches) ? res.reviewMatches : [];
    scanStatusEl.style.display = "block";
    scanStatusEl.innerHTML = `<strong>${String(res.marketplace || "").toUpperCase()} Scan Complete:</strong> Found ${res.scannedCount} active · <strong>${res.matchedCount} auto-linked</strong>${review.length ? ` · ${review.length} need 1-click review` : ""}${res.unmatchedCount ? ` · ${res.unmatchedCount} unmatched` : ""}. Refresh your Command Center to see live badges!`;

    if (review.length > 0) {
      for (const m of review) {
        const row = document.createElement("div");
        row.className = "job-row";
        row.style.padding = "8px 0";
        row.innerHTML = `
          <div class="job-top">
            <span class="sku">${Math.round(m.confidence * 100)}% match · ${m.candidateSku}</span>
            <button type="button" class="btn btn-confirm" style="padding:3px 8px;">Link</button>
          </div>
          <div class="title"><strong>Page:</strong> ${m.scannedTitle} ($${Number(m.scannedPrice || 0).toFixed(0)})</div>
          <div class="title" style="color:#0f766e;"><strong>eBay:</strong> ${m.candidateTitle}</div>
        `;
        const linkBtn = row.querySelector("button");
        linkBtn.addEventListener("click", async () => {
          linkBtn.disabled = true;
          linkBtn.textContent = "Linking...";
          const lr = await chrome.runtime.sendMessage({
            type: "RCC_LINK_EXISTING_MATCH",
            payload: {
              itemId: m.candidateItemId,
              marketplace: res.marketplace,
              externalUrl: m.externalUrl,
              externalListingId: m.externalListingId,
              listedPrice: m.scannedPrice,
            },
          });
          if (lr?.ok) {
            linkBtn.textContent = "Linked ✓";
          } else {
            linkBtn.disabled = false;
            linkBtn.textContent = "Retry";
          }
        });
        scanReviewEl.appendChild(row);
      }
    }
  });
}

loadState();
