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
      .replace(/(?<=\d)\.(?=\d)/g, "__dot__")
      .replace(/[^a-z0-9_]+/g, " ")
      .replace(/__dot__/g, ".")
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
      if (b.length <= 4) {
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
      await sleep(300);

      // On last step (e.g. Condition 2-line cards), if label didn't update yet, also click parent/inner item
      if (stepIdx === stepTargets.length - 1) {
        const midLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();
        if (midLabel === beforeLabel) {
          const itemContainer = matchedEl.closest('li, a, button, .dropdown__menu__item, [role="option"]');
          if (itemContainer && itemContainer !== clickableChild) {
            itemContainer.click();
            await sleep(250);
          }
          const innerLink = matchedEl.querySelector("a, button, span, div");
          if (
            (triggerEl.textContent || "").replace(/\s+/g, " ").trim() === beforeLabel &&
            innerLink &&
            innerLink !== clickableChild
          ) {
            innerLink.click();
            await sleep(250);
          }
        }
      }

      clickedSteps += 1;
      await sleep(350);
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

  function buildPoshmarkSizeCandidates(rawSize) {
    const clean = String(rawSize || "").trim();
    if (!clean || /^os$|^one size$/i.test(clean)) {
      return {
        candidates: ["OS", "One Size", "One Size Fits All"],
        preferBigKid: false,
        isBaby: false,
        raw: clean || "OS",
      };
    }

    const candidates = [clean];
    let preferBigKid = false;
    let isBaby = /\b(nb|newborn|0-3|3-6|6-9|9-12|12-18|18-24|0m|3m|6m|9m|12m|18m|24m)\b/i.test(clean);

    // Handle kids/adult numeric shoe sizes like "11C", "10.5C", "5Y", "4T", "10.5M", "10.5 D", "11 (Little Kid)"
    const m = clean.match(/^(\d+(?:\.\d+)?)\s*([cytwmde]|big\s*kid|little\s*kid|toddler|youth|infant|baby)?\b/i);
    if (m) {
      const numStr = m[1];
      const numVal = Number(numStr);
      const suffix = (m[2] || "").toLowerCase();

      if (suffix === "c") {
        // US Kids Child/Toddler (e.g. 11C -> 11, 11 (Little Kid), 11 (Toddler))
        if (numVal <= 3.5) isBaby = true;
        candidates.push(numStr);
        if (numVal >= 10.5) {
          candidates.push(`${numStr} (Little Kid)`, `${numStr} (Toddler)`, `${numStr}c`);
        } else {
          candidates.push(`${numStr} (Toddler)`, `${numStr} (Little Kid)`, `${numStr}c`);
        }
      } else if (suffix === "y" || suffix.includes("youth") || suffix.includes("big")) {
        preferBigKid = true;
        candidates.push(`${numStr} (Big Kid)`, `${numStr} (Youth)`, `${numStr}Y`, numStr);
      } else if (suffix === "t" || suffix.includes("toddler")) {
        candidates.push(`${numStr}T`, `${numStr} (Toddler)`, numStr);
      } else if (suffix === "m" || suffix === "w" || suffix === "d" || suffix === "e") {
        // Width/month suffix (e.g., 10.5M -> 10.5, or 12M -> 12-18M / 12M)
        if (suffix === "m" && Number.isInteger(numVal) && [3, 6, 9, 12, 18, 24].includes(numVal)) {
          isBaby = true;
          candidates.push(`${numStr}M`, `${numStr} Months`);
        }
        candidates.push(numStr);
      } else {
        if (numVal <= 3.5 && numVal >= 0) {
          // Could be infant 0-3.5 or big kid 1-3.5
          candidates.push(numStr);
        } else {
          candidates.push(numStr);
        }
      }
    }

    // Deduplicate while preserving priority order
    const deduped = [];
    const seen = new Set();
    for (const c of candidates) {
      const k = norm(c);
      if (k && !seen.has(k)) {
        seen.add(k);
        deduped.push(c);
      }
    }
    return { candidates: deduped, preferBigKid, isBaby, raw: clean };
  }

  async function selectPoshmarkSize(
    sizeDropdown,
    rawSize,
    titleText,
    department,
    setNativeValue,
    sleep,
    debugOut
  ) {
    if (!sizeDropdown) {
      debugOut.push("Size: dropdown root not found");
      return false;
    }
    const triggerEl = getPoshmarkSelectorTrigger(sizeDropdown);
    if (!triggerEl) {
      debugOut.push("Size: trigger not found");
      return false;
    }

    const beforeLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();
    if (beforeLabel && !/^select size/i.test(beforeLabel)) {
      debugOut.push(`Size: already "${beforeLabel}"`);
      return true;
    }

    const { candidates, preferBigKid, isBaby, raw } = buildPoshmarkSizeCandidates(rawSize);
    const hasCustomFallback = Boolean(raw && !/^os$|^one size$/i.test(raw));

    triggerEl.scrollIntoView({ block: "center" });
    await sleep(150);
    triggerEl.click();
    await sleep(450);

    const getMenuRoot = () =>
      sizeDropdown.querySelector('.dropdown__menu, [class*="dropdown__menu"], ul') ||
      sizeDropdown;

    const getVisibleOptions = () => {
      const menuRoot = getMenuRoot();
      return Array.from(
        menuRoot.querySelectorAll(
          'li, a, button, [role="option"], [role="tab"], .dropdown__menu__item, div[class*="item"], div[data-test], span[role="button"]'
        )
      ).filter((el) => {
        if (el === triggerEl || triggerEl.contains(el)) return false;
        if (!isElementDisplayed(el)) return false;
        const r = el.getBoundingClientRect();
        return r.height >= 18 && r.height <= 120 && r.width >= 20;
      });
    };

    const findTabEl = (tabName) => {
      const want = norm(tabName);
      return getVisibleOptions().find((el) => {
        const line = (el.innerText || el.textContent || "").trim().split(/\r?\n/)[0].trim();
        return norm(line) === want;
      });
    };

    const TAB_HEADERS = new Set(["baby", "girls", "boys", "custom", "standard", "plus", "petite", "maternity", "juniors", "tall", "us", "eu", "uk"]);

    const tryPickSizeInCurrentTab = async () => {
      const opts = getVisibleOptions();
      const matches = [];
      for (const el of opts) {
        const rawTxt = (el.innerText || el.textContent || "").trim().split(/\r?\n/)[0].trim();
        const n = norm(rawTxt);
        if (!n || TAB_HEADERS.has(n)) continue;
        // Prefer leaf clickable elements over huge wrapper divs
        if (el.children.length > 2 && el.tagName === "DIV") continue;
        const s = scoreFirstLine(el, candidates);
        if (s >= 0.9) {
          matches.push({ el, s, text: rawTxt });
        }
      }
      if (matches.length === 0) return false;

      // Sort by score descending; if tied (e.g. two "5" buttons for Toddler vs Big Kid),
      // pick the last one for Youth/Big Kid or first one for Toddler/Child.
      const bestScore = Math.max(...matches.map((m) => m.s));
      const topMatches = matches.filter((m) => m.s >= bestScore - 0.01);
      const chosen = preferBigKid ? topMatches[topMatches.length - 1] : topMatches[0];

      const clickable =
        chosen.el.tagName === "LI"
          ? chosen.el.querySelector("a, button") || chosen.el
          : chosen.el;
      clickable.scrollIntoView({ block: "nearest" });
      clickable.click();
      await sleep(350);

      const afterLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();
      if (afterLabel !== beforeLabel) {
        debugOut.push(`Size: OK ("${beforeLabel}" -> "${afterLabel}")`);
        return true;
      }
      return false;
    };

    // 1. Check if this is a tabbed Kids/Standard Size picker (e.g. Baby | Girls | Boys | Custom)
    const hasKidsTabs = Boolean(findTabEl("Girls") || findTabEl("Boys"));
    if (hasKidsTabs || department === "Kids") {
      const hay = String(titleText || "").toLowerCase();
      const looksGirl = /\b(girl|girls|pink|purple|glitter|sparkle|princess|unicorn|floral|ballerina|mary jane)\b/.test(hay);
      const looksBoy = /\b(boy|boys)\b/.test(hay);

      let tabOrder;
      if (isBaby) {
        tabOrder = looksGirl
          ? ["Baby", "Girls", "Boys"]
          : ["Baby", "Boys", "Girls"];
      } else if (looksGirl) {
        tabOrder = ["Girls", "Boys", "Baby"];
      } else if (looksBoy) {
        tabOrder = ["Boys", "Girls", "Baby"];
      } else {
        tabOrder = ["Boys", "Girls", "Baby"];
      }

      for (const tabName of tabOrder) {
        const tabEl = findTabEl(tabName);
        if (tabEl) {
          tabEl.click();
          await sleep(400);
        }
        if (await tryPickSizeInCurrentTab()) {
          return true;
        }
      }
    } else {
      // Non-Kids (Women/Men/Home/Electronics): try active tab first
      if (await tryPickSizeInCurrentTab()) {
        return true;
      }
      // Also try One Size fallback for non-shoe/accessory items if OS wasn't in candidates
      if (!/shoe|sneaker|boot|sandal|jean|pant/i.test(String(titleText || ""))) {
        const osBtn = getVisibleOptions().find((el) =>
          scoreFirstLine(el, ["OS", "One Size", "One Size Fits All"]) >= 0.9
        );
        if (osBtn) {
          osBtn.click();
          await sleep(350);
          const afterLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();
          if (afterLabel !== beforeLabel) {
            debugOut.push(`Size: OK fallback ("${beforeLabel}" -> "${afterLabel}")`);
            return true;
          }
        }
      }
    }

    // 2. Ultimate Fallback: Click Poshmark's "Custom" size tab, type the exact size (e.g. "11C"), & click Save!
    if (hasCustomFallback) {
      const customTab = findTabEl("Custom");
      if (customTab) {
        customTab.click();
        await sleep(400);
        const menuRoot = getMenuRoot();
        const customInput =
          menuRoot.querySelector('input[type="text"], input:not([type="hidden"]):not([type="checkbox"])') ||
          document.querySelector('.listing-editor__size-container input[type="text"]');
        if (customInput && isElementDisplayed(customInput)) {
          setNativeValue(customInput, raw.slice(0, 20));
          await sleep(250);
          const saveBtn = Array.from(
            menuRoot.querySelectorAll('button, [role="button"]')
          ).find((b) => /^(save|done|apply)$/i.test((b.textContent || "").trim()));
          if (saveBtn) {
            saveBtn.click();
            await sleep(350);
            const afterLabel = (triggerEl.textContent || "").replace(/\s+/g, " ").trim();
            if (afterLabel !== beforeLabel) {
              debugOut.push(`Size: OK via Custom ("${raw}" -> "${afterLabel}")`);
              return true;
            }
          }
        }
      }
    }

    const saw = Array.from(
      new Set(
        getVisibleOptions()
          .map((el) => (el.innerText || el.textContent || "").trim().split(/\r?\n/)[0].trim())
          .filter((t) => t && t.length <= 30)
      )
    ).slice(0, 14);
    debugOut.push(`Size missed ${JSON.stringify(candidates)}; saw: [${saw.join(", ")}]`);
    return false;
  }

  function tokenizeForDupCheck(raw) {
    const stop = new Set([
      "the", "and", "for", "with", "from", "new", "nwt", "nwot", "euc", "guc",
      "size", "mens", "womens", "vintage", "lot", "of", "in", "on", "to", "by",
    ]);
    return norm(raw)
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !stop.has(t));
  }

  function dupSimilarity(a, b) {
    const ta = new Set(tokenizeForDupCheck(a));
    const tb = new Set(tokenizeForDupCheck(b));
    if (ta.size === 0 || tb.size === 0) return 0;
    let inter = 0;
    for (const t of ta) {
      if (tb.has(t)) inter += 1;
    }
    const dice = (2 * inter) / (ta.size + tb.size);
    const contain = inter / Math.min(ta.size, tb.size);
    return dice * 0.65 + contain * 0.35;
  }

  /**
   * Checks the seller's own live Poshmark closet (same-origin) BEFORE creating a
   * listing so we never create a duplicate if it's already live on Poshmark!
   */
  async function findExistingInPoshmarkCloset(targetTitles, options = {}) {
    const minScore = typeof options.minScore === "number" ? options.minScore : 0.78;
    const includeSearch = Boolean(options.includeSearch);
    const cleanTargets = (Array.isArray(targetTitles) ? targetTitles : [targetTitles])
      .map((t) => String(t || "").trim())
      .filter((t) => t.length >= 3);
    if (cleanTargets.length === 0) return null;

    try {
      const pathMatch = window.location.pathname.match(/^\/closet\/([a-z0-9_.-]+)/i);
      const closetLink = Array.from(document.querySelectorAll('a[href*="/closet/"]')).find(
        (a) => /\/closet\/[a-z0-9_.-]+/i.test(a.getAttribute("href") || "")
      );
      const linkMatch = (closetLink?.getAttribute("href") || "").match(
        /\/closet\/([a-z0-9_.-]+)/i
      );
      const username = pathMatch?.[1] || linkMatch?.[1] || null;

      let bestMatch = null;
      let bestScore = 0;

      const scanDocument = (doc) => {
        const links = Array.from(doc.querySelectorAll('a[href*="/listing/"]'));
        const seen = new Set();
        for (const link of links) {
          const href = link.getAttribute("href") || "";
          const idMatch = href.match(/([0-9a-f]{24})(?:[/?#]|$)/i);
          const extId = idMatch ? idMatch[1] : null;
          if (!extId || seen.has(extId)) continue;
          seen.add(extId);

          const card =
            link.closest('[data-et-name="listing"], .card, .tile, article, li') ||
            link.parentElement;
          const cardText = (card?.textContent || "").toLowerCase();
          if (/\bsold\b|not for sale/.test(cardText)) continue;

          const titleEl = card?.querySelector(
            ".tile__title, [data-et-name='listing_title'], a.tile__title"
          );
          const title = (
            titleEl?.textContent ||
            link.getAttribute("title") ||
            link.querySelector("img")?.getAttribute("alt") ||
            link.textContent ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (title.length < 4) continue;

          for (const target of cleanTargets) {
            const score = dupSimilarity(title, target);
            if (score > bestScore) {
              bestScore = score;
              const fullUrl = href.startsWith("http")
                ? href.split("?")[0]
                : `https://poshmark.com${href.split("?")[0]}`;
              bestMatch = { externalListingId: extId, externalUrl: fullUrl, title, score };
            }
          }
        }
      };

      // 1. Scan current DOM immediately if we are already on the user's closet
      if (window.location.pathname.includes("/closet/")) {
        scanDocument(document);
        if (bestScore >= minScore) return bestMatch;
      }

      if (!username) return null;

      // 2. Fetch the user's available closet listings
      const urlsToTry = [
        `/closet/${encodeURIComponent(username)}?availability=available&sort_by=added_desc`,
      ];
      if (includeSearch && cleanTargets[0]) {
        const shortQuery = cleanTargets[0]
          .replace(/[^a-z0-9\s]/gi, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 2)
          .slice(0, 4)
          .join(" ");
        if (shortQuery.length >= 3) {
          urlsToTry.push(
            `/closet/${encodeURIComponent(username)}?availability=available&query=${encodeURIComponent(shortQuery)}`
          );
        }
      }

      for (const fetchUrl of urlsToTry) {
        try {
          const res = await fetch(fetchUrl, { credentials: "include" });
          if (!res.ok) continue;
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          scanDocument(doc);
          if (bestScore >= minScore) return bestMatch;
        } catch {
          // try next URL
        }
      }

      return bestScore >= minScore ? bestMatch : null;
    } catch {
      return null;
    }
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
        // ANTI-DOUBLE-SELL AUTO-DELIST HANDLER (STRICT VERIFICATION — ZERO FALSE POSITIVES)
        if (job.action === "delist") {
          const failToManualConfirm = async (reasonMsg) => {
            try {
              await chrome.runtime.sendMessage({ type: "RCC_CLEAR_DELIST_WATCH" });
            } catch {
              // ignore
            }
            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "needs_user_confirm",
              extra: {
                errorMessage: reasonMsg,
              },
            });
            showRccHud({
              title: `Confirm Poshmark Delist (${payload.sku || "SKU"})`,
              message: `${reasonMsg} Delete it manually, then tap Mark Delisted below.`,
              tone: "confirm",
              actionLabel: "Mark Delisted",
              onAction: async () => {
                await chrome.runtime.sendMessage({
                  type: "RCC_JOB_STATUS_UPDATE",
                  jobId: job.id,
                  status: "completed",
                  extra: { marketplace: "poshmark" },
                });
                showRccHud({
                  title: "Poshmark Delist Synced",
                  message: "Marked ended in Command Center.",
                  tone: "success",
                });
              },
            });
            sendResponse({ ok: true, delisted: false });
          };

          showRccHud({
            title: `${isAutoPilot ? "Auto-Pilot · " : ""}Auto-Delisting Poshmark (${payload.sku || "SKU"})`,
            message: `Sold on another marketplace (${payload.reason || "anti-double-sell"}) — locating & verifying Poshmark listing...`,
            tone: "info",
          });

          // Never mark delisted if Poshmark redirected to login!
          if (/\/login\b|\/signin\b/i.test(window.location.pathname)) {
            await failToManualConfirm("Poshmark requires sign-in before deleting this listing.");
            return;
          }

          const urlIdMatch = window.location.href.match(/([0-9a-f]{24})(?:[/?#]|$)/i);
          const payloadIdMatch =
            String(payload.externalListingId || "").match(/([0-9a-f]{24})/i) ||
            String(payload.externalUrl || "").match(/([0-9a-f]{24})/i);
          const realListingId = urlIdMatch?.[1] || payloadIdMatch?.[1] || null;

          // If we don't have a real 24-hex Poshmark ID (e.g. legacy fallback URL or /feed / /closet/),
          // search the user's live Poshmark closet by title and navigate to /edit-listing/<foundId>!
          if (!urlIdMatch && (!realListingId || !window.location.pathname.includes("/edit-listing"))) {
            await sleep(1400);
            if (realListingId && Number(job._redirectAttempt || 0) < 2) {
              await chrome.runtime.sendMessage({
                type: "RCC_REDIRECT_DELIST_TAB",
                url: `https://poshmark.com/edit-listing/${realListingId}`,
                job,
                autoPilot: isAutoPilot,
              });
              sendResponse({ ok: true, redirected: true });
              return;
            }
            const foundInCloset = await findExistingInPoshmarkCloset(
              [payload.mappedTitle, payload.title, job.item_title],
              { minScore: 0.58, includeSearch: true }
            );
            if (foundInCloset?.externalListingId && /^[0-9a-f]{24}$/i.test(foundInCloset.externalListingId)) {
              await chrome.runtime.sendMessage({
                type: "RCC_REDIRECT_DELIST_TAB",
                url: `https://poshmark.com/edit-listing/${foundInCloset.externalListingId}`,
                job: {
                  ...job,
                  payload: {
                    ...payload,
                    externalListingId: foundInCloset.externalListingId,
                    externalUrl: foundInCloset.externalUrl,
                  },
                },
                autoPilot: isAutoPilot,
              });
              sendResponse({ ok: true, redirected: true });
              return;
            }
            await failToManualConfirm(
              "Could not automatically locate this Poshmark listing ID in your closet."
            );
            return;
          }

          const findVisibleDeleteListingBtn = () => {
            const byData = document.querySelector('[data-et-name="delete_listing"]');
            if (byData && isElementDisplayed(byData) && !byData.closest("#rcc-companion-hud")) {
              return byData;
            }
            return Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) => {
              if (el.closest("#rcc-companion-hud") || el.disabled) return false;
              if (!isElementDisplayed(el)) return false;
              const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
              return /^delete listing$/i.test(txt);
            });
          };

          const hasExplicitPoshmark404 = () => {
            const text = (document.body?.innerText || "").toLowerCase();
            return (
              text.includes("page not found") ||
              text.includes("listing not found") ||
              text.includes("this listing has been deleted") ||
              text.includes("sorry! we couldn't find") ||
              (text.includes("uh oh!") && text.includes("404"))
            );
          };

          const hasExplicitListingSoldBanner = () => {
            if (!window.location.pathname.includes("/listing/")) return false;
            const soldEl = document.querySelector(
              '.listing__sold-tag, [data-et-name="sold_tag"], [data-test="sold-tag"], .sold-tag, .not-for-sale-tag, [data-test="not-for-sale-tag"]'
            );
            return Boolean(soldEl && isElementDisplayed(soldEl));
          };

          // Wait up to 4.5s for Poshmark's Vue SPA to render the edit form, listing page, or genuine 404
          const loadStart = Date.now();
          while (Date.now() - loadStart < 4500) {
            if (/\/login\b|\/signin\b/i.test(window.location.pathname)) {
              await failToManualConfirm("Poshmark redirected to sign-in.");
              return;
            }
            if (
              findVisibleDeleteListingBtn() ||
              document.querySelector('a[href*="/edit-listing/"]') ||
              hasExplicitPoshmark404() ||
              hasExplicitListingSoldBanner()
            ) {
              break;
            }
            await sleep(300);
          }

          // Strict alreadyGone check: ONLY when we navigated to a real 24-hex listing ID
          if (realListingId && (hasExplicitPoshmark404() || hasExplicitListingSoldBanner())) {
            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "completed",
              extra: { marketplace: "poshmark" },
            });
            showRccHud({
              title: `Poshmark Already Ended (${payload.sku || "SKU"})`,
              message: "Verified listing is already deleted or sold — synced back to Command Center.",
              tone: "success",
            });
            if (isAutoPilot) {
              await sleep(1500);
              chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            }
            sendResponse({ ok: true, delisted: true });
            return;
          }

          // If on /listing/<id> view, navigate cleanly to /edit-listing/<id>
          if (!window.location.pathname.includes("/edit-listing")) {
            if (realListingId && Number(job._redirectAttempt || 0) < 2) {
              await chrome.runtime.sendMessage({
                type: "RCC_REDIRECT_DELIST_TAB",
                url: `https://poshmark.com/edit-listing/${realListingId}`,
                job,
                autoPilot: isAutoPilot,
              });
              sendResponse({ ok: true, redirected: true });
              return;
            }
            const editLink = document.querySelector('a[href*="/edit-listing/"]');
            if (editLink) {
              editLink.click();
              await sleep(2500);
            } else {
              await clickButtonByText([/^edit$/i, /^edit listing$/i], 2500);
              await sleep(2500);
            }
          }

          window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          await sleep(800);

          let deleteBtn = findVisibleDeleteListingBtn();
          if (!deleteBtn) {
            const waitDelStart = Date.now();
            while (Date.now() - waitDelStart < 3500 && !deleteBtn) {
              window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
              await sleep(350);
              deleteBtn = findVisibleDeleteListingBtn();
            }
          }

          if (!deleteBtn) {
            await failToManualConfirm("Could not find the Delete Listing button on this Poshmark page.");
            return;
          }

          deleteBtn.scrollIntoView({ block: "center" });
          await sleep(250);
          deleteBtn.click();

          // Wait strictly for Poshmark's confirmation modal & find the confirm button INSIDE the modal ONLY
          // (never re-click the underlying "Delete Listing" button!)
          const findModalConfirmBtn = () => {
            const modalContainers = Array.from(
              document.querySelectorAll(
                '[role="dialog"], [role="alertdialog"], .modal, .modal__container, .modal__content, .popup, .dialog, .confirmation-modal'
              )
            ).filter((m) => !m.closest("#rcc-companion-hud") && isElementDisplayed(m));

            for (const modal of modalContainers) {
              const btns = Array.from(modal.querySelectorAll('button, a, [role="button"]')).filter(
                (b) => !b.disabled && isElementDisplayed(b) && b !== deleteBtn
              );
              const match = btns.find((b) => {
                const txt = (b.textContent || "").replace(/\s+/g, " ").trim();
                if (/^(no|cancel|keep|close|back)$/i.test(txt)) return false;
                return /^(yes|yes,?\s*delete(\s+listing)?|delete|confirm|ok)$/i.test(txt);
              });
              if (match) return match;
            }
            return null;
          };

          let confirmBtn = null;
          const modalWaitStart = Date.now();
          while (Date.now() - modalWaitStart < 4500 && !confirmBtn) {
            await sleep(250);
            confirmBtn = findModalConfirmBtn();
          }

          if (!confirmBtn) {
            await failToManualConfirm(
              "Clicked Delete Listing, but Poshmark's confirmation dialog did not appear."
            );
            return;
          }

          // Register background navigation watcher BEFORE clicking confirm in case Poshmark does a full page redirect
          try {
            await chrome.runtime.sendMessage({
              type: "RCC_WATCH_DELIST_SUCCESS",
              jobId: job.id,
              marketplace: "poshmark",
              listingId: realListingId || "",
              autoPilot: isAutoPilot,
            });
          } catch {
            // ignore
          }

          confirmBtn.click();

          // MANDATORY POST-DELETE VERIFICATION (up to 7.5s) — never mark completed without proof!
          const detectPoshmarkDeleteError = () => {
            const errSelectors =
              '[role="alert"], .alert, .alert--danger, .toast--error, .flash--error, .form__error-message, .modal__body, .popup';
            const nodes = Array.from(document.querySelectorAll(errSelectors)).filter(
              (el) => !el.closest("#rcc-companion-hud") && isElementDisplayed(el)
            );
            for (const el of nodes) {
              const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
              if (
                /active offer|cannot be deleted|cannot delete|unable to delete|could not delete|not allowed to delete|something went wrong|error deleting/i.test(
                  txt
                )
              ) {
                return txt.slice(0, 140);
              }
            }
            return null;
          };

          let verifiedDeleted = false;
          let deleteBlockReason = null;
          const verifyStart = Date.now();
          while (Date.now() - verifyStart < 7500) {
            await sleep(450);

            if (/\/login\b|\/signin\b/i.test(window.location.pathname)) {
              deleteBlockReason = "Poshmark redirected to sign-in after clicking Delete.";
              break;
            }

            const errTxt = detectPoshmarkDeleteError();
            if (errTxt) {
              deleteBlockReason = `Poshmark blocked Delete: "${errTxt}"`;
              break;
            }

            // Proof A: SPA navigated away from /edit-listing/<id>
            if (
              !window.location.pathname.includes("/edit-listing") &&
              (!realListingId || !window.location.pathname.includes(realListingId))
            ) {
              verifiedDeleted = true;
              break;
            }

            // Proof B: Explicit deletion confirmation toast/banner appeared
            const bodyNow = (document.body?.innerText || "").toLowerCase();
            if (
              bodyNow.includes("listing has been deleted") ||
              bodyNow.includes("successfully deleted") ||
              bodyNow.includes("listing deleted") ||
              hasExplicitPoshmark404()
            ) {
              verifiedDeleted = true;
              break;
            }

            // Proof C (after 4s): Delete button disappeared AND direct fetch confirms listing is gone
            if (Date.now() - verifyStart > 4000 && realListingId && !findVisibleDeleteListingBtn()) {
              try {
                const checkRes = await fetch(
                  `https://poshmark.com/listing/${realListingId}`,
                  { credentials: "include" }
                );
                if (checkRes.status === 404 || checkRes.status === 410) {
                  verifiedDeleted = true;
                  break;
                }
                const checkHtml = (await checkRes.text()).toLowerCase();
                if (
                  checkHtml.includes("page not found") ||
                  checkHtml.includes("listing not found") ||
                  checkHtml.includes("this listing has been deleted")
                ) {
                  verifiedDeleted = true;
                  break;
                }
              } catch {
                // keep waiting
              }
            }
          }

          if (verifiedDeleted) {
            await chrome.runtime.sendMessage({
              type: "RCC_JOB_STATUS_UPDATE",
              jobId: job.id,
              status: "completed",
              extra: { marketplace: "poshmark" },
            });
            showRccHud({
              title: `Delisted from Poshmark! (${payload.sku || "SKU"})`,
              message: "Verified removed from Poshmark & synced to Command Center.",
              tone: "success",
            });
            if (isAutoPilot) {
              await sleep(1800);
              chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
            }
            sendResponse({ ok: true, delisted: true });
            return;
          }

          await failToManualConfirm(
            deleteBlockReason ||
              "Could not verify Poshmark deleted this listing (still on edit page — e.g. active offer or prompt)."
          );
          return;
        }

        showRccHud({
          title: `${isAutoPilot ? "Auto-Pilot · " : ""}Poshmark (${payload.sku || "SKU"})`,
          message: `Checking your Poshmark closet for duplicates before listing...`,
          tone: "info",
        });

        // 0. Live Duplicate Protection: check if this item is ALREADY active in your Poshmark closet!
        const existingDup = await findExistingInPoshmarkCloset([
          payload.mappedTitle,
          job.item_title,
        ]);
        if (existingDup) {
          await chrome.runtime.sendMessage({
            type: "RCC_LINK_EXISTING_MATCH",
            payload: {
              itemId: job.item_id,
              marketplace: "poshmark",
              externalUrl: existingDup.externalUrl,
              externalListingId: existingDup.externalListingId,
              listedPrice: Math.max(3, Math.round(Number(payload.suggestedPrice || 0))),
              sku: payload.sku || job.item_sku || "",
            },
          });
          showRccHud({
            title: `Already Listed on Poshmark! (Duplicate Prevented)`,
            message: `Found "${existingDup.title}" already active in your closet. Linked it to your Command Center instead of creating a duplicate!`,
            tone: "success",
          });
          if (isAutoPilot) {
            await sleep(2000);
            chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
          }
          sendResponse({ ok: true, duplicatePrevented: true });
          return;
        }

        // Tell background worker right away to watch this tab for successful publish redirect!
        chrome.runtime.sendMessage({
          type: "RCC_WATCH_PUBLISH_SUCCESS",
          jobId: job.id,
          marketplace: "poshmark",
          sku: payload.sku || job.item_sku || "",
          title: payload.mappedTitle || job.item_title || "",
          listedPrice: Math.max(3, Math.round(Number(payload.suggestedPrice || 0))),
          autoPilot: isAutoPilot,
        });

        showRccHud({
          title: `${isAutoPilot ? "Auto-Pilot · " : ""}Poshmark (${payload.sku || "SKU"})`,
          message: `No duplicate found ✓ Uploading ${(payload.imageUrls || []).length} eBay photos & filling category, size, condition, and details...`,
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
          16,
          { squarePad: true }
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

        // 3. Auto-select Poshmark Category (Department -> Category, with safe fallback to Office/Other)
        const catDropdown = findPoshmarkDropdownByContainerOrText(
          [
            '.listing-editor__category-container [data-test="dropdown"]',
            '.listing-editor__category-container .dropdown',
          ],
          /^select category/i
        );
        const catStep2 = sc.category
          ? /craft|stamp|punch|scrapbook|paper|sew|yarn/i.test(
              `${sc.category} ${sc.subcategory || ""} ${payload.mappedTitle || ""}`
            )
            ? [sc.category, "Office", "Art", "Other"]
            : [sc.category, "Other"]
          : ["Other"];
        const catSteps = sc.department ? [sc.department, catStep2] : [catStep2];
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

        // 3b. Optional Subcategory dropdown (with Poshmark Kids/Adult synonym fallbacks)
        if (categoryMatched && sc.subcategory) {
          const subDropdown = findPoshmarkDropdownByContainerOrText(
            [
              '.listing-editor__subcategory-container [data-test="dropdown"]',
              '.listing-editor__subcategory-container .dropdown',
            ],
            /^select subcategory/i
          );
          if (subDropdown) {
            const subCandidates = /athletic/i.test(sc.subcategory)
              ? [sc.subcategory, "Sneakers"]
              : /sneaker/i.test(sc.subcategory)
                ? [sc.subcategory, "Athletic Shoes"]
                : /sandal/i.test(sc.subcategory)
                  ? [sc.subcategory, "Sandals & Flip Flops", "Sandals"]
                  : [sc.subcategory];
            await selectPoshmarkVueDropdown(
              subDropdown,
              [subCandidates],
              sleep,
              debugLog,
              "Subcategory"
            );
            await sleep(450);
          }
        }

        // 4. Auto-select Poshmark Size (handles Kids Baby/Girls/Boys/Custom tabs + 11C/5Y/4T normalization)
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
            sizeMatched = await selectPoshmarkSize(
              sizeDropdown,
              sc.sizeLabel || "OS",
              payload.mappedTitle || "",
              sc.department || "",
              setNativeValue,
              sleep,
              debugLog
            );
          } else {
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

        // 6. Brand & Whole-Dollar Prices (Original Price = 0 so Poshmark hides strikethrough!)
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
          if (modalOrig) {
            // Setting Original Price to 0 hides the strikethrough price on Poshmark (avoids "$8 ~~$7~~"!)
            setNativeValue(modalOrig, "0");
          }

          const modalPrice =
            document.querySelector('.modal input[data-vv-name="listingPrice"]') ||
            document.querySelector('[role="dialog"] input') ||
            listingPriceInput;
          setNativeValue(modalPrice, Math.max(3, Math.round(Number(payload.suggestedPrice))));

          await sleep(350);
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
          console.log("[RCC Poshmark v0.9.3]", debugLog.join(" | "));
        }

        // 7. Auto-Publish: Next -> List This Item -> optional Fragile Item Detected (Publish Listing -> Publish)!
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
            await sleep(900);
            // Share Listing screen: strictly wait for "List This Item" (never re-click Next!)
            const clickedList = await clickButtonByText(
              [/^list this item$/i, /^list item$/i],
              6000
            );
            if (clickedList) {
              showRccHud({
                title: `Submitting to Poshmark (${payload.sku || "SKU"})`,
                message: `Clicked List This Item — checking for Fragile Item or Policy modals...`,
                tone: "info",
              });

              const hasPoshmarkProhibitedModal = () => {
                const txt = (document.body?.innerText || "").toLowerCase();
                return (
                  txt.includes("flagged your listing as a potential prohibited") ||
                  (txt.includes("prohibited items policy") &&
                    (txt.includes("certify listing") ||
                      txt.includes("delete listing"))) ||
                  (txt.includes("problem detected") &&
                    txt.includes("prohibited item"))
                );
              };

              // Handle Poshmark's 2-step "Fragile Item Detected" modal if it pops up,
              // while continuously checking for Poshmark's "Problem Detected / Prohibited Item" modal
              await sleep(1100);
              let prohibitedDetected = hasPoshmarkProhibitedModal();
              if (!prohibitedDetected) {
                const clickedPublishListing = await clickButtonByText(
                  [/^publish listing$/i],
                  2800
                );
                if (clickedPublishListing) {
                  await sleep(900);
                  await clickButtonByText([/^publish$/i], 3000);
                  await sleep(1100);
                }
                prohibitedDetected = hasPoshmarkProhibitedModal();
              }

              // Wait up to 4.5s for either navigation away from /create-listing or late prohibited modal
              if (!prohibitedDetected) {
                for (let w = 0; w < 9; w++) {
                  if (hasPoshmarkProhibitedModal()) {
                    prohibitedDetected = true;
                    break;
                  }
                  if (!window.location.pathname.includes("/create-listing")) {
                    break;
                  }
                  await sleep(500);
                }
              }

              if (prohibitedDetected) {
                const policyReason =
                  "Poshmark's validation system flagged this listing as a potential prohibited item during publishing.";

                if (isAutoPilot) {
                  // Auto-Pilot (unattended Mac Mini): never auto-certify prohibited items.
                  // Delete the flagged draft, mark Poshmark Policy Blocked (Red X) on Inventory, and close tab.
                  await clickButtonByText([/^delete listing$/i], 3000);
                  await sleep(900);
                  await chrome.runtime.sendMessage({
                    type: "RCC_MARK_POLICY_BLOCKED",
                    jobId: job.id,
                    itemId: job.item_id,
                    marketplace: "poshmark",
                    rule: "Poshmark Validation System Flag",
                    reason: policyReason,
                  });
                  showRccHud({
                    title: `Poshmark Policy Blocked (${payload.sku || "SKU"})`,
                    message:
                      "Poshmark flagged this as prohibited — deleted draft & marked Poshmark with a Red X on Inventory.",
                    tone: "error",
                  });
                  await sleep(1800);
                  chrome.runtime.sendMessage({ type: "RCC_CLOSE_SENDER_TAB" });
                  sendResponse({ ok: false, policyBlocked: true });
                  return;
                }

                // Interactive mode: pause cleanly and let user either mark Policy Blocked (Red X) or click Certify Listing
                await chrome.runtime.sendMessage({
                  type: "RCC_JOB_STATUS_UPDATE",
                  jobId: job.id,
                  status: "needs_user_confirm",
                  extra: {
                    errorMessage:
                      "Poshmark flagged this listing as a potential prohibited item — click Mark Policy Blocked or Certify Listing.",
                  },
                });

                showRccHud({
                  title: `Poshmark Policy Flag (${payload.sku || "SKU"})`,
                  message:
                    'Poshmark flagged this as a potential prohibited item. Click "Mark Blocked (Red X)" below to delete & grey out Poshmark on Inventory — or click "Certify Listing" on Poshmark if it is allowed.',
                  tone: "error",
                  actionLabel: "Mark Blocked (Red X) & Delete",
                  onAction: async () => {
                    await clickButtonByText([/^delete listing$/i], 2500);
                    await chrome.runtime.sendMessage({
                      type: "RCC_MARK_POLICY_BLOCKED",
                      jobId: job.id,
                      itemId: job.item_id,
                      marketplace: "poshmark",
                      rule: "Poshmark Validation System Flag",
                      reason: policyReason,
                    });
                    showRccHud({
                      title: `Marked Policy Blocked (${payload.sku || "SKU"})`,
                      message:
                        "Poshmark cell is now greyed out with a Red X on Command Center Inventory.",
                      tone: "error",
                    });
                  },
                });
                sendResponse({ ok: false, policyBlocked: true });
                return;
              }

              // If still stuck on /create-listing after submit, don't claim green success!
              if (window.location.pathname.includes("/create-listing")) {
                await chrome.runtime.sendMessage({
                  type: "RCC_JOB_STATUS_UPDATE",
                  jobId: job.id,
                  status: "needs_user_confirm",
                  extra: {
                    errorMessage:
                      "Poshmark stayed on /create-listing after clicking List This Item — review any popup or missing field.",
                  },
                });
                showRccHud({
                  title: `Poshmark Needs Review (${payload.sku || "SKU"})`,
                  message:
                    "Poshmark did not finish publishing (check any popup or red field on this page). Once it posts, Command Center will auto-sync.",
                  tone: "confirm",
                  actionLabel: "Mark Blocked (Red X)",
                  onAction: async () => {
                    await chrome.runtime.sendMessage({
                      type: "RCC_MARK_POLICY_BLOCKED",
                      jobId: job.id,
                      itemId: job.item_id,
                      marketplace: "poshmark",
                      rule: "Poshmark Policy / Validation Block",
                      reason: "Marked policy blocked after Poshmark rejected listing.",
                    });
                    showRccHud({
                      title: `Marked Policy Blocked (${payload.sku || "SKU"})`,
                      message:
                        "Poshmark cell is now greyed out with a Red X on Command Center Inventory.",
                      tone: "error",
                    });
                  },
                });
                sendResponse({ ok: false, needsReview: true });
                return;
              }

              showRccHud({
                title: `Listed on Poshmark! (${payload.sku || "SKU"})`,
                message: `Published to Poshmark — automatically syncing live link back to Command Center...`,
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
                const txt = `Poshmark v0.9.3 Debug (${catLabel}):\n${debugLog.join("\n")}`;
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
