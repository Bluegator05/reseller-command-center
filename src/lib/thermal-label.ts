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
