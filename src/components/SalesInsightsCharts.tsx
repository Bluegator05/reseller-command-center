"use client";

import { useMemo, useState } from "react";
import { BarChart3, Clock, TrendingUp } from "lucide-react";
import type {
  InventoryItem,
  MarketplaceType,
  SalesOrderRecord,
  StaleRadarRow,
} from "@/lib/types";

interface SalesInsightsChartsProps {
  salesOrders: SalesOrderRecord[];
  activeItems: StaleRadarRow[];
  draftItems: InventoryItem[];
}

type RangeKey = "7d" | "30d" | "90d" | "ytd" | "all";

const MARKETPLACE_COLORS: Record<MarketplaceType, { label: string; color: string }> = {
  ebay: { label: "eBay", color: "#F07855" },
  poshmark: { label: "Poshmark", color: "#9F1239" },
  mercari: { label: "Mercari", color: "#4F46E5" },
  etsy: { label: "Etsy", color: "#EA580C" },
  facebook: { label: "Facebook", color: "#2563EB" },
};

function fmtMoney(n: number, decimals = 2): string {
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function fmtShortDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "< 1 day";
  if (days < 1) return "< 1 day";
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  if (days < 365) {
    const m = Math.round(days / 30);
    return `${m} month${m === 1 ? "" : "s"}`;
  }
  const y = (days / 365).toFixed(1);
  return `${y} yr`;
}

/**
 * Builds a smooth Catmull-Rom cubic SVG spline path through a series of (x, y) points
 * so the charts have the same fluid, organic curve aesthetic as Flipwise.
 */
function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

interface SeriesPoint {
  label: string;
  key: string;
  v1: number;
  v2: number;
}

function DualAreaChart({
  data,
  series1Label,
  series2Label,
  series1Color,
  series2Color,
  formatVal,
  gradientIdPrefix,
}: {
  data: SeriesPoint[];
  series1Label: string;
  series2Label: string;
  series1Color: string;
  series2Color: string;
  formatVal: (v: number) => string;
  gradientIdPrefix: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const W = 760;
  const H = 200;
  const padL = 52;
  const padR = 18;
  const padT = 16;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(
    1,
    ...data.map((d) => Math.max(d.v1, d.v2, 0))
  );
  // Nice rounded Y-axis ceiling
  const niceMax =
    maxVal <= 5
      ? Math.ceil(maxVal)
      : maxVal <= 50
        ? Math.ceil(maxVal / 10) * 10
        : maxVal <= 500
          ? Math.ceil(maxVal / 50) * 50
          : Math.ceil(maxVal / 100) * 100;

  const pts1 = data.map((d, i) => ({
    x: padL + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW),
    y: padT + plotH - (Math.max(0, d.v1) / niceMax) * plotH,
  }));
  const pts2 = data.map((d, i) => ({
    x: padL + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW),
    y: padT + plotH - (Math.max(0, d.v2) / niceMax) * plotH,
  }));

  const line1 = buildSmoothPath(pts1);
  const line2 = buildSmoothPath(pts2);
  const baseY = padT + plotH;
  const area1 =
    pts1.length > 0
      ? `${line1} L ${pts1[pts1.length - 1].x.toFixed(1)} ${baseY} L ${pts1[0].x.toFixed(1)} ${baseY} Z`
      : "";
  const area2 =
    pts2.length > 0
      ? `${line2} L ${pts2[pts2.length - 1].x.toFixed(1)} ${baseY} L ${pts2[0].x.toFixed(1)} ${baseY} Z`
      : "";

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    val: niceMax * t,
    y: padT + plotH - t * plotH,
  }));

  const labelStep = Math.max(1, Math.ceil(data.length / 8));
  const hovered = hoverIdx !== null ? data[hoverIdx] : null;
  const hoverX = hoverIdx !== null && pts1[hoverIdx] ? pts1[hoverIdx].x : 0;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[185px] sm:h-[215px] overflow-visible"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient
            id={`${gradientIdPrefix}-g1`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={series1Color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={series1Color} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient
            id={`${gradientIdPrefix}-g2`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor={series2Color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={series2Color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines + Y labels */}
        {yTicks.map((tk, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={tk.y}
              y2={tk.y}
              stroke="#ECEFE9"
              strokeWidth="1"
            />
            <text
              x={padL - 8}
              y={tk.y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="#64748B"
            >
              {formatVal(tk.val)}
            </text>
          </g>
        ))}

        {/* Areas */}
        {area1 && <path d={area1} fill={`url(#${gradientIdPrefix}-g1)`} />}
        {area2 && <path d={area2} fill={`url(#${gradientIdPrefix}-g2)`} />}

        {/* Lines */}
        {line1 && (
          <path
            d={line1}
            fill="none"
            stroke={series1Color}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}
        {line2 && (
          <path
            d={line2}
            fill="none"
            stroke={series2Color}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}

        {/* X axis labels */}
        {data.map((d, i) => {
          if (i % labelStep !== 0 && i !== data.length - 1) return null;
          return (
            <text
              key={d.key}
              x={pts1[i].x}
              y={H - 6}
              textAnchor="middle"
              fontSize="10"
              fill="#64748B"
            >
              {d.label}
            </text>
          );
        })}

        {/* Hover vertical crosshair + dots */}
        {hoverIdx !== null && pts1[hoverIdx] && pts2[hoverIdx] && (
          <g>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={padT}
              y2={baseY}
              stroke="#94A3B8"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <circle
              cx={pts1[hoverIdx].x}
              cy={pts1[hoverIdx].y}
              r="4.5"
              fill={series1Color}
              stroke="#FFFFFF"
              strokeWidth="2"
            />
            <circle
              cx={pts2[hoverIdx].x}
              cy={pts2[hoverIdx].y}
              r="4.5"
              fill={series2Color}
              stroke="#FFFFFF"
              strokeWidth="2"
            />
          </g>
        )}

        {/* Invisible hover hit zones */}
        {data.map((d, i) => {
          const sliceW = data.length > 1 ? plotW / (data.length - 1) : plotW;
          return (
            <rect
              key={`hit-${d.key}`}
              x={Math.max(padL, pts1[i].x - sliceW / 2)}
              y={padT}
              width={sliceW}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
            />
          );
        })}
      </svg>

      {/* Hover Tooltip */}
      {hovered && (
        <div className="absolute top-1 right-2 bg-[#14151A] text-white rounded-lg px-3 py-1.5 text-[11px] shadow-md pointer-events-none">
          <div className="font-bold text-[#E2E8F0] mb-0.5">{hovered.label}</div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: series1Color }}
              />
              {series1Label}: <strong className="font-mono">{formatVal(hovered.v1)}</strong>
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: series2Color }}
              />
              {series2Label}: <strong className="font-mono">{formatVal(hovered.v2)}</strong>
            </span>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center justify-center gap-5 mt-1 text-[11px] text-[#475569]">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: series1Color }}
          />
          {series1Label}
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: series2Color }}
          />
          {series2Label}
        </span>
      </div>
    </div>
  );
}

export function SalesInsightsCharts({
  salesOrders,
  activeItems,
  draftItems,
}: SalesInsightsChartsProps) {
  const [range, setRange] = useState<RangeKey>("30d");

  const {
    filteredOrders,
    grossTotal,
    netTotal,
    avgGross,
    avgNet,
    npmPct,
    avgNpmPerSale,
    roiPct,
    avgRoiPerSale,
    spentNewInventory,
    cogsTotal,
    feesTotal,
    shippingTotal,
    newListingsCount,
    avgTimeToListDays,
    avgTimeToSellDays,
    salesSeries,
    velocitySeries,
    marketplaceProfits,
  } = useMemo(() => {
    const now = new Date();
    const nowMs = now.getTime();
    let startMs = 0;
    if (range === "7d") startMs = nowMs - 6 * 86_400_000;
    else if (range === "30d") startMs = nowMs - 29 * 86_400_000;
    else if (range === "90d") startMs = nowMs - 89 * 86_400_000;
    else if (range === "ytd") startMs = new Date(now.getFullYear(), 0, 1).getTime();
    else {
      // All time: start from earliest sale or 90 days ago
      const earliest = salesOrders.reduce((min, o) => {
        const ms = Date.parse(o.sold_at);
        return !Number.isNaN(ms) && ms < min ? ms : min;
      }, nowMs - 89 * 86_400_000);
      startMs = earliest;
    }

    const startDay = new Date(startMs);
    startDay.setHours(0, 0, 0, 0);
    const effectiveStartMs = startDay.getTime();

    const validOrders = salesOrders.filter((o) => {
      if (o.fulfillment_status === "unpaid") return false;
      const ms = Date.parse(o.sold_at);
      return !Number.isNaN(ms) && ms >= effectiveStartMs;
    });

    let gross = 0;
    let net = 0;
    let cogs = 0;
    let fees = 0;
    let ship = 0;
    let sumNpm = 0;
    let sumRoi = 0;
    let roiCount = 0;
    let sumTtsDays = 0;
    let ttsCount = 0;
    let sumTtlDays = 0;
    let ttlCount = 0;

    const mktNetMap = new Map<MarketplaceType, number>();

    for (const o of validOrders) {
      const orderGross = Math.max(0, o.gross_sale_price - (o.refund_amount || 0));
      const orderNet = o.true_net_after_cogs;
      const orderCogs =
        o.restocked || o.fulfillment_status === "returned"
          ? 0
          : (o.cogs || 0) + (o.prep_cost || 0);
      gross += orderGross;
      net += orderNet;
      cogs += orderCogs;
      fees += o.marketplace_fees || 0;
      ship += o.shipping_cost || 0;

      if (orderGross > 0) sumNpm += (orderNet / orderGross) * 100;
      if (orderCogs > 0) {
        sumRoi += (orderNet / orderCogs) * 100;
        roiCount += 1;
      }

      const soldMs = Date.parse(o.sold_at);
      const listMs = Date.parse(o.listed_at || o.acquired_at || "");
      const acqMs = Date.parse(o.acquired_at || "");
      if (!Number.isNaN(soldMs) && !Number.isNaN(listMs) && soldMs >= listMs) {
        sumTtsDays += (soldMs - listMs) / 86_400_000;
        ttsCount += 1;
      }
      if (!Number.isNaN(listMs) && !Number.isNaN(acqMs) && listMs >= acqMs) {
        sumTtlDays += (listMs - acqMs) / 86_400_000;
        ttlCount += 1;
      }

      mktNetMap.set(o.marketplace, (mktNetMap.get(o.marketplace) || 0) + orderNet);
    }

    // Count newly listed & new inventory spend in the same window
    let newListed = 0;
    let spentNew = 0;
    for (const it of activeItems) {
      const lms = Date.parse(it.listed_at || "");
      if (!Number.isNaN(lms) && lms >= effectiveStartMs) newListed += 1;
      const ams = Date.parse(it.acquired_at || "");
      if (!Number.isNaN(ams) && ams >= effectiveStartMs) {
        spentNew += (it.cogs || 0) + (it.prep_cost || 0);
      }
    }
    for (const d of draftItems) {
      const ams = Date.parse(d.acquired_at || d.created_at || "");
      if (!Number.isNaN(ams) && ams >= effectiveStartMs) {
        spentNew += (d.cogs || 0) + (d.prep_cost || 0);
      }
    }

    // Build time buckets (daily for <= 31 days, weekly for <= 180 days, monthly for > 180 days)
    const spanDays = Math.max(1, Math.ceil((nowMs - effectiveStartMs) / 86_400_000));
    const bucketMode: "day" | "week" | "month" =
      spanDays <= 35 ? "day" : spanDays <= 180 ? "week" : "month";

    const bucketKeyFor = (ms: number): { key: string; label: string } => {
      const d = new Date(ms);
      if (bucketMode === "day") {
        return {
          key: d.toISOString().slice(0, 10),
          label: `${d.getMonth() + 1}/${d.getDate()}`,
        };
      }
      if (bucketMode === "week") {
        const startOfWeek = new Date(d);
        startOfWeek.setDate(d.getDate() - d.getDay());
        return {
          key: startOfWeek.toISOString().slice(0, 10),
          label: `${startOfWeek.getMonth() + 1}/${startOfWeek.getDate()}`,
        };
      }
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleString("en-US", { month: "short", year: "2-digit" });
      return { key, label };
    };

    const buckets = new Map<
      string,
      { label: string; gross: number; net: number; salesCount: number; newListings: number }
    >();

    // Seed contiguous empty buckets so the curve never skips zero days
    const cursor = new Date(effectiveStartMs);
    const stepMs =
      bucketMode === "day"
        ? 86_400_000
        : bucketMode === "week"
          ? 7 * 86_400_000
          : 28 * 86_400_000;
    while (cursor.getTime() <= nowMs + 1000) {
      const { key, label } = bucketKeyFor(cursor.getTime());
      if (!buckets.has(key)) {
        buckets.set(key, {
          label,
          gross: 0,
          net: 0,
          salesCount: 0,
          newListings: 0,
        });
      }
      cursor.setTime(cursor.getTime() + stepMs);
    }

    for (const o of validOrders) {
      const ms = Date.parse(o.sold_at);
      if (Number.isNaN(ms)) continue;
      const { key, label } = bucketKeyFor(ms);
      const b = buckets.get(key) ?? {
        label,
        gross: 0,
        net: 0,
        salesCount: 0,
        newListings: 0,
      };
      b.gross += Math.max(0, o.gross_sale_price - (o.refund_amount || 0));
      b.net += o.true_net_after_cogs;
      b.salesCount += 1;
      buckets.set(key, b);
    }

    for (const it of activeItems) {
      const ms = Date.parse(it.listed_at || "");
      if (Number.isNaN(ms) || ms < effectiveStartMs) continue;
      const { key, label } = bucketKeyFor(ms);
      const b = buckets.get(key) ?? {
        label,
        gross: 0,
        net: 0,
        salesCount: 0,
        newListings: 0,
      };
      b.newListings += 1;
      buckets.set(key, b);
    }

    const sortedKeys = [...buckets.keys()].sort();
    const sSeries: SeriesPoint[] = sortedKeys.map((k) => {
      const b = buckets.get(k)!;
      return { key: k, label: b.label, v1: b.gross, v2: b.net };
    });
    const vSeries: SeriesPoint[] = sortedKeys.map((k) => {
      const b = buckets.get(k)!;
      return { key: k, label: b.label, v1: b.newListings, v2: b.salesCount };
    });

    const mktOrder: MarketplaceType[] = [
      "ebay",
      "poshmark",
      "mercari",
      "etsy",
      "facebook",
    ];
    const mktProfits = mktOrder
      .map((m) => ({
        marketplace: m,
        label: MARKETPLACE_COLORS[m].label,
        color: MARKETPLACE_COLORS[m].color,
        net: mktNetMap.get(m) || 0,
      }))
      .filter((x) => Math.abs(x.net) > 0.01);

    const nSales = validOrders.length;

    return {
      filteredOrders: validOrders,
      grossTotal: gross,
      netTotal: net,
      avgGross: nSales > 0 ? gross / nSales : 0,
      avgNet: nSales > 0 ? net / nSales : 0,
      npmPct: gross > 0 ? (net / gross) * 100 : 0,
      avgNpmPerSale: nSales > 0 ? sumNpm / nSales : 0,
      roiPct: cogs > 0 ? (net / cogs) * 100 : 0,
      avgRoiPerSale: roiCount > 0 ? sumRoi / roiCount : 0,
      spentNewInventory: spentNew,
      cogsTotal: cogs,
      feesTotal: fees,
      shippingTotal: ship,
      newListingsCount: newListed,
      avgTimeToListDays: ttlCount > 0 ? sumTtlDays / ttlCount : 0,
      avgTimeToSellDays: ttsCount > 0 ? sumTtsDays / ttsCount : 0,
      salesSeries: sSeries,
      velocitySeries: vSeries,
      marketplaceProfits: mktProfits,
    };
  }, [salesOrders, activeItems, draftItems, range]);

  const maxMktNet = Math.max(
    1,
    ...marketplaceProfits.map((m) => Math.abs(m.net))
  );

  const rangeLabels: Record<RangeKey, string> = {
    "7d": "Last 7 Days",
    "30d": "Last 30 Days",
    "90d": "Last 90 Days",
    ytd: "Year to Date",
    all: "All Time",
  };

  return (
    <div className="space-y-4">
      {/* Range Selector Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[#0F766E]" />
          <h3 className="text-sm font-bold text-[#14151A]">
            Sales &amp; Inventory Insights
          </h3>
          <span className="text-xs text-[#5C606B]">
            · {filteredOrders.length} paid sale{filteredOrders.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="inline-flex rounded-lg border border-[#DDE2DF] bg-white p-0.5">
          {(["7d", "30d", "90d", "ytd", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                range === r
                  ? "bg-[#14151A] text-white"
                  : "text-[#5C606B] hover:text-[#14151A]"
              }`}
            >
              {rangeLabels[r]}
            </button>
          ))}
        </div>
      </div>

      {/* Chart 1: Gross Sales vs Net Profit */}
      <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div className="flex items-baseline gap-6">
            <div>
              <div className="text-2xl font-bold font-mono text-[#3B82A6]">
                {fmtMoney(grossTotal, 0)}
              </div>
              <div className="text-xs font-medium text-[#5C606B]">
                Gross sales
              </div>
            </div>
            <div>
              <div
                className={`text-2xl font-bold font-mono ${
                  netTotal >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
                }`}
              >
                {fmtMoney(netTotal, 0)}
              </div>
              <div className="text-xs font-medium text-[#5C606B]">
                Net profit
              </div>
            </div>
          </div>
          <span className="text-xs font-medium text-[#64748B]">
            {rangeLabels[range]}
          </span>
        </div>
        <DualAreaChart
          data={salesSeries}
          series1Label="Gross sales"
          series2Label="Net profit"
          series1Color="#5E9CB8"
          series2Color="#4EA885"
          formatVal={(v) => `$${Math.round(v)}`}
          gradientIdPrefix="sales-pnl"
        />
      </div>

      {/* 4-Metric Efficiency Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div className="text-2xl font-bold font-mono text-[#0B8A5F]">
            {fmtMoney(avgGross)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Avg gross per sale</div>
        </div>
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div
            className={`text-2xl font-bold font-mono ${
              avgNet >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
            }`}
          >
            {fmtMoney(avgNet)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Avg net per sale</div>
        </div>
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div
            className={`text-2xl font-bold font-mono ${
              npmPct >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
            }`}
          >
            {Math.round(npmPct)}%
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">
            Net profit margin (NPM)
          </div>
        </div>
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div
            className={`text-2xl font-bold font-mono ${
              avgNpmPerSale >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
            }`}
          >
            {Math.round(avgNpmPerSale)}%
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Avg NPM per sale</div>
        </div>
      </div>

      {/* Net Profit by Marketplace Bar Chart */}
      <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[#EA580C]" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#14151A]">
              Net Profit by Marketplace
            </h4>
          </div>
          <span className="text-xs text-[#64748B]">{rangeLabels[range]}</span>
        </div>
        {marketplaceProfits.length === 0 ? (
          <p className="text-xs text-[#64748B] py-4">
            No paid sales recorded in this date window yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {marketplaceProfits.map((m) => {
              const pct = Math.max(4, (Math.abs(m.net) / maxMktNet) * 100);
              return (
                <div key={m.marketplace} className="flex items-center gap-3">
                  <div className="w-20 text-xs font-semibold text-[#334155] text-right shrink-0">
                    {m.label}
                  </div>
                  <div className="flex-1 h-5 rounded-md bg-[#F1F5F9] overflow-hidden">
                    <div
                      className="h-full rounded-md transition-all"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: m.net >= 0 ? m.color : "#DC2626",
                      }}
                    />
                  </div>
                  <div
                    className={`w-24 text-right font-mono text-xs font-bold shrink-0 ${
                      m.net >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
                    }`}
                  >
                    {fmtMoney(m.net)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4-Column Cost Breakdown Strip (Flipwise Screenshot 4) */}
      <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5 grid grid-cols-2 lg:grid-cols-4 gap-4 text-center">
        <div>
          <div className="text-2xl font-bold font-mono text-[#14151A]">
            {fmtMoney(spentNewInventory)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">
            Spent on new inventory
          </div>
        </div>
        <div>
          <div className="text-2xl font-bold font-mono text-[#991B1B]">
            {fmtMoney(cogsTotal)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Cost of goods sold</div>
        </div>
        <div>
          <div className="text-2xl font-bold font-mono text-[#991B1B]">
            {fmtMoney(feesTotal)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Marketplace fees</div>
        </div>
        <div>
          <div className="text-2xl font-bold font-mono text-[#991B1B]">
            {fmtMoney(shippingTotal)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Shipping labels</div>
        </div>
      </div>

      {/* Chart 2: New Listings vs Sales Velocity */}
      <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div className="flex items-baseline gap-6">
            <div>
              <div className="text-2xl font-bold font-mono text-[#EA580C]">
                {newListingsCount}
              </div>
              <div className="text-xs font-medium text-[#5C606B]">
                New listings
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold font-mono text-[#0B8A5F]">
                {filteredOrders.length}
              </div>
              <div className="text-xs font-medium text-[#5C606B]">Sales</div>
            </div>
          </div>
          <span className="text-xs text-[#5C606B]">
            {newListingsCount >= filteredOrders.length
              ? "Store growing (listing faster than selling)"
              : "Sell-through outpacing new listings — time to list more!"}
          </span>
        </div>
        <DualAreaChart
          data={velocitySeries}
          series1Label="New listings"
          series2Label="Sales"
          series1Color="#EA580C"
          series2Color="#4EA885"
          formatVal={(v) => String(Math.round(v))}
          gradientIdPrefix="velocity"
        />
      </div>

      {/* Bottom Efficiency & ROI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div className="text-xl font-bold font-mono text-[#3B82A6] inline-flex items-center gap-1">
            <Clock className="w-4 h-4" />
            {fmtShortDays(avgTimeToListDays)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Avg time to list</div>
        </div>
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div className="text-xl font-bold font-mono text-[#3B82A6]">
            {fmtShortDays(avgTimeToSellDays)}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Avg time to sell</div>
        </div>
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div
            className={`text-xl font-bold font-mono ${
              roiPct >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
            }`}
          >
            {cogsTotal > 0 ? `${Math.round(roiPct)}%` : "—"}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">
            Return on investment (ROI)
          </div>
        </div>
        <div className="bg-white border border-[#E2E5E8] rounded-xl px-4 py-3.5 text-center">
          <div
            className={`text-xl font-bold font-mono ${
              avgRoiPerSale >= 0 ? "text-[#0B8A5F]" : "text-[#B91C1C]"
            }`}
          >
            {avgRoiPerSale > 0 ? `${Math.round(avgRoiPerSale)}%` : "—"}
          </div>
          <div className="text-xs text-[#5C606B] mt-0.5">Avg ROI per sale</div>
        </div>
      </div>
    </div>
  );
}
