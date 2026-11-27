export interface ThermalLabelItem {
  sku: string;
  bin: string | null;
  title: string;
  acquiredAt?: string | null;
  cogs?: number;
  price?: number;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[m] ?? m;
  });
}

/**
 * Generates a deterministic Code-39-style visual barcode SVG from the SKU string
 * so 2"×1" thermal stickers look sharp and print cleanly without external fonts.
 */
function buildBarcodeSvg(sku: string): string {
  const clean = (sku || "SKU").toUpperCase();
  const bars: string[] = [];
  let x = 2;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    for (let b = 0; b < 5; b++) {
      const wide = ((code >> b) & 1) === 1;
      const w = wide ? 2.4 : 1.1;
      if (b % 2 === 0) {
        bars.push(`<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="22" fill="#111"/>`);
      }
      x += w + 0.9;
    }
    x += 1.2;
  }
  const totalW = Math.max(80, Math.ceil(x + 2));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} 22" width="100%" height="22" preserveAspectRatio="none">${bars.join("")}</svg>`;
}

/**
 * Opens a dedicated print preview formatted for 2"×1" thermal label printers
 * (Rollo, Munbyn, Dymo 4XL, Brother QL) — one sticker per page.
 */
export function printThermalSkuLabels(items: ThermalLabelItem[]): void {
  if (typeof window === "undefined" || items.length === 0) return;
  const win = window.open("", "_blank", "width=460,height=640");
  if (!win) return;

  const cards = items
    .map((it) => {
      const acq = it.acquiredAt
        ? new Date(it.acquiredAt).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      return `
        <div class="label">
          <div class="top">
            <span class="bin">BIN ${escHtml(it.bin || "UNASSIGNED")}</span>
            <span class="date">${escHtml(acq)}</span>
          </div>
          <div class="sku">${escHtml(it.sku)}</div>
          <div class="bc">${buildBarcodeSvg(it.sku)}</div>
          <div class="title">${escHtml(it.title.slice(0, 46))}</div>
        </div>
      `;
    })
    .join("");

  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>2x1 Thermal SKU Labels (${items.length})</title>
  <style>
    @page { size: 2.25in 1.25in; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f5; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 12px; }
    .toolbar button { padding: 6px 12px; background: #0F766E; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; }
    .label { width: 2.25in; height: 1.25in; background: #fff; border: 1px dashed #cbd5e1; padding: 0.08in 0.1in; margin-bottom: 8px; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; }
    .top { display: flex; justify-content: space-between; align-items: center; }
    .bin { background: #111; color: #fff; font-weight: 800; font-size: 10px; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, monospace; }
    .date { font-size: 8px; font-family: ui-monospace, monospace; color: #555; }
    .sku { font-size: 12px; font-weight: 800; font-family: ui-monospace, monospace; letter-spacing: 0.03em; margin-top: 2px; }
    .bc { margin: 1px 0; }
    .title { font-size: 8px; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none; }
      .label { border: 0; margin: 0; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span><strong>${items.length}</strong> Thermal Sticker${items.length === 1 ? "" : "s"} (2.25" × 1.25")</span>
    <button onclick="window.print()">Print Labels</button>
  </div>
  ${cards}
</body>
</html>`);
  win.document.close();
}

/**
 * Opens a printable Bin Contents / Tote Audit sheet grouped by bin location.
 */
export function printBinAuditSheet(
  binName: string,
  items: ThermalLabelItem[]
): void {
  if (typeof window === "undefined") return;
  const win = window.open("", "_blank", "width=760,height=820");
  if (!win) return;

  const totalCogs = items.reduce((s, i) => s + (i.cogs || 0), 0);
  const rows = items
    .map(
      (it) => `<tr>
        <td style="font-family:monospace;font-weight:700">${escHtml(it.sku)}</td>
        <td>${escHtml(it.title)}</td>
        <td style="font-family:monospace;text-align:right">${it.price != null ? "$" + it.price.toFixed(2) : "—"}</td>
        <td style="text-align:center">☐</td>
      </tr>`
    )
    .join("");

  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Bin ${escHtml(binName)} Audit Sheet</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; color: #161A1D; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    p { margin: 0 0 16px; color: #5F666D; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #DDE2DF; padding: 8px 10px; text-align: left; }
    th { background: #F7F9F8; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div>
      <h1>Bin / Tote Audit: ${escHtml(binName)}</h1>
      <p>${items.length} SKU${items.length === 1 ? "" : "s"} · Total Cost Basis $${totalCogs.toFixed(2)} · Printed ${new Date().toLocaleDateString()}</p>
    </div>
    <button class="no-print" onclick="window.print()" style="padding:8px 14px;background:#0F766E;color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer">Print Sheet</button>
  </div>
  <table>
    <thead><tr><th>SKU</th><th>Item Title</th><th style="text-align:right">Ask</th><th style="text-align:center">Verified</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
  win.document.close();
}

export interface PickListLabelOrder {
  id: string;
  sku: string;
  title: string;
  image_url?: string | null;
  marketplace: string;
  bin_location?: string | null;
  quantity?: number;
  fulfillment_status?: string;
}

function formatMarketplaceShort(marketplace: string): string {
  const m = (marketplace || "").toLowerCase();
  if (m === "ebay") return "EBAY";
  if (m === "poshmark") return "POSH";
  if (m === "mercari") return "MERCARI";
  if (m === "etsy") return "ETSY";
  if (m === "facebook") return "FB";
  return m.toUpperCase() || "SHOP";
}

/**
 * Opens a dedicated print view strictly aligned for 4"×6" thermal shipping label printers
 * (Rollo, Munbyn, Dymo 4XL, Zebra). Paginates cleanly (6 orders per 4×6 label) with
 * checkbox, thumbnail photo, marketplace, bin/shelf, full SKU, short title, and bold QTY.
 */
export function printThermal4x6PickList(orders: PickListLabelOrder[]): void {
  if (typeof window === "undefined" || orders.length === 0) return;
  const win = window.open("", "_blank", "width=480,height=720");
  if (!win) return;

  const ITEMS_PER_LABEL = 6;
  const pages: PickListLabelOrder[][] = [];
  for (let i = 0; i < orders.length; i += ITEMS_PER_LABEL) {
    pages.push(orders.slice(i, i + ITEMS_PER_LABEL));
  }

  const totalUnits = orders.reduce(
    (sum, o) => sum + Math.max(1, Math.floor(Number(o.quantity || 1))),
    0
  );
  const dateLabel = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const pagesHtml = pages
    .map((pageOrders, pageIdx) => {
      const isLast = pageIdx === pages.length - 1;
      const rowsHtml = pageOrders
        .map((order) => {
          const qty = Math.max(1, Math.floor(Number(order.quantity || 1)));
          const mkt = formatMarketplaceShort(order.marketplace);
          const sku = (order.sku || "").trim();
          const binRaw = (order.bin_location || "").trim();
          const showBin =
            Boolean(binRaw) &&
            binRaw.toUpperCase() !== "UNASSIGNED" &&
            !sku.toLowerCase().includes(binRaw.toLowerCase());
          const isPicked = order.fulfillment_status === "picked";
          const imgHtml = order.image_url
            ? `<img class="thumb" src="${escHtml(order.image_url)}" alt="" />`
            : `<div class="thumb thumb-empty">NO<br/>IMG</div>`;

          return `
            <div class="row">
              <div class="chk ${isPicked ? "chk-done" : ""}">${isPicked ? "✓" : ""}</div>
              ${imgHtml}
              <div class="info">
                <div class="meta">
                  <span class="mkt">${escHtml(mkt)}</span>
                  ${showBin ? `<span class="bin">${escHtml(binRaw)}</span>` : ""}
                </div>
                <div class="sku">${escHtml(sku)}</div>
                <div class="title">${escHtml(order.title || "")}</div>
              </div>
              <div class="qty ${qty > 1 ? "qty-multi" : ""}">
                <span class="qty-lbl">QTY</span>
                <span class="qty-val">${qty}</span>
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="sheet ${isLast ? "sheet-last" : ""}">
          <div class="hdr">
            <span class="hdr-title">PICK LIST · ${escHtml(dateLabel)}</span>
            <span class="hdr-meta">${orders.length} ord · ${totalUnits} unit${totalUnits === 1 ? "" : "s"} · Pg ${pageIdx + 1}/${pages.length}</span>
          </div>
          <div class="rows">
            ${rowsHtml}
          </div>
        </div>
      `;
    })
    .join("");

  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>4x6 Pick List (${orders.length} Orders)</title>
  <style>
    @page {
      size: 4in 6in;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    html, body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #000;
      background: #e5e7eb;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #14151a;
      color: #fff;
      font-size: 12px;
    }
    .toolbar button {
      padding: 6px 12px;
      background: #0f766e;
      color: #fff;
      border: 0;
      border-radius: 6px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
    }
    .preview-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 14px;
    }
    .sheet {
      width: 4in;
      height: 6in;
      background: #fff;
      padding: 0.14in 0.16in;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
      page-break-after: always;
      break-after: page;
    }
    .sheet-last {
      page-break-after: auto;
      break-after: auto;
    }
    .hdr {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 2px solid #000;
      padding-bottom: 4px;
      margin-bottom: 4px;
      flex-shrink: 0;
    }
    .hdr-title {
      font-size: 12px;
      font-weight: 900;
      letter-spacing: 0.04em;
    }
    .hdr-meta {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9px;
      font-weight: 700;
    }
    .rows {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .row {
      display: grid;
      grid-template-columns: 16px 46px minmax(0, 1fr) 38px;
      align-items: center;
      gap: 6px;
      padding: 6px 0;
      border-bottom: 1px dashed #666;
      min-height: 0.84in;
      max-height: 0.92in;
      overflow: hidden;
    }
    .row:last-child {
      border-bottom: 0;
    }
    .chk {
      width: 15px;
      height: 15px;
      border: 1.75px solid #000;
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 900;
      line-height: 1;
    }
    .chk-done {
      background: #000;
      color: #fff;
    }
    .thumb {
      width: 46px;
      height: 46px;
      object-fit: cover;
      border: 1px solid #000;
      border-radius: 3px;
      display: block;
      background: #f5f5f5;
      filter: contrast(1.12);
    }
    .thumb-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-size: 7.5px;
      font-weight: 800;
      line-height: 1.1;
      color: #333;
    }
    .info {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
    }
    .mkt {
      display: inline-block;
      padding: 1px 4px;
      border: 1.5px solid #000;
      border-radius: 3px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8.5px;
      font-weight: 900;
      letter-spacing: 0.03em;
      line-height: 1.15;
    }
    .bin {
      display: inline-block;
      padding: 1px 5px;
      background: #000;
      color: #fff;
      border-radius: 3px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 8.5px;
      font-weight: 800;
      line-height: 1.15;
    }
    .sku {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9.5px;
      font-weight: 800;
      line-height: 1.18;
      color: #000;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .title {
      font-size: 8px;
      line-height: 1.15;
      color: #222;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .qty {
      width: 38px;
      height: 44px;
      border: 1.5px solid #000;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .qty-multi {
      background: #000;
      color: #fff;
    }
    .qty-lbl {
      font-size: 7px;
      font-weight: 800;
      letter-spacing: 0.05em;
      margin-bottom: 2px;
    }
    .qty-val {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 15px;
      font-weight: 900;
    }
    @media print {
      html, body {
        background: #fff;
      }
      .toolbar {
        display: none !important;
      }
      .preview-wrap {
        display: block;
        padding: 0;
        gap: 0;
      }
      .sheet {
        box-shadow: none;
        margin: 0;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span><strong>4" × 6" Pick List</strong> · ${orders.length} order${orders.length === 1 ? "" : "s"} (${totalUnits} unit${totalUnits === 1 ? "" : "s"}) · ${pages.length} label${pages.length === 1 ? "" : "s"}</span>
    <button onclick="window.print()">Print 4×6 Labels</button>
  </div>
  <div class="preview-wrap">
    ${pagesHtml}
  </div>
</body>
</html>`);
  win.document.close();
}
