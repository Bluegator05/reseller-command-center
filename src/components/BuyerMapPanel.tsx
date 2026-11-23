"use client";

import { useMemo, useState } from "react";
import {
  Globe,
  Loader2,
  MapPin,
  RefreshCw,
  Truck,
  X,
} from "lucide-react";
import type { SalesOrderRecord } from "@/lib/types";

interface BuyerMapPanelProps {
  salesOrders: SalesOrderRecord[];
  onSyncEbayLocations: () => Promise<void>;
  isSyncingLocations: boolean;
  onSelectOrder?: (order: SalesOrderRecord) => void;
}

// Accurate US State centroids [lat, lon] + display names for Albers-like equirectangular US projection
const US_STATES: Record<string, { name: string; lat: number; lon: number; region: string }> = {
  AL: { name: "Alabama", lat: 32.8, lon: -86.8, region: "South" },
  AK: { name: "Alaska", lat: 64.2, lon: -152.5, region: "Non-Contiguous" },
  AZ: { name: "Arizona", lat: 34.3, lon: -111.7, region: "West" },
  AR: { name: "Arkansas", lat: 34.9, lon: -92.4, region: "South" },
  CA: { name: "California", lat: 36.8, lon: -119.4, region: "West" },
  CO: { name: "Colorado", lat: 39.0, lon: -105.5, region: "Mountain" },
  CT: { name: "Connecticut", lat: 41.6, lon: -72.7, region: "Northeast" },
  DE: { name: "Delaware", lat: 39.0, lon: -75.5, region: "Northeast" },
  DC: { name: "District of Columbia", lat: 38.9, lon: -77.0, region: "Northeast" },
  FL: { name: "Florida", lat: 28.1, lon: -81.6, region: "South" },
  GA: { name: "Georgia", lat: 32.6, lon: -83.4, region: "South" },
  HI: { name: "Hawaii", lat: 20.8, lon: -156.3, region: "Non-Contiguous" },
  ID: { name: "Idaho", lat: 44.1, lon: -114.7, region: "Mountain" },
  IL: { name: "Illinois", lat: 40.0, lon: -89.2, region: "Midwest" },
  IN: { name: "Indiana", lat: 39.9, lon: -86.3, region: "Midwest" },
  IA: { name: "Iowa", lat: 42.0, lon: -93.5, region: "Midwest" },
  KS: { name: "Kansas", lat: 38.5, lon: -98.3, region: "Midwest" },
  KY: { name: "Kentucky", lat: 37.8, lon: -85.7, region: "South" },
  LA: { name: "Louisiana", lat: 31.0, lon: -91.9, region: "South" },
  ME: { name: "Maine", lat: 45.3, lon: -69.2, region: "Northeast" },
  MD: { name: "Maryland", lat: 39.0, lon: -76.7, region: "Northeast" },
  MA: { name: "Massachusetts", lat: 42.3, lon: -71.8, region: "Northeast" },
  MI: { name: "Michigan", lat: 44.3, lon: -85.4, region: "Midwest" },
  MN: { name: "Minnesota", lat: 46.3, lon: -94.3, region: "Midwest" },
  MS: { name: "Mississippi", lat: 32.7, lon: -89.7, region: "South" },
  MO: { name: "Missouri", lat: 38.4, lon: -92.5, region: "Midwest" },
  MT: { name: "Montana", lat: 46.9, lon: -110.4, region: "Mountain" },
  NE: { name: "Nebraska", lat: 41.5, lon: -99.8, region: "Midwest" },
  NV: { name: "Nevada", lat: 39.3, lon: -116.6, region: "West" },
  NH: { name: "New Hampshire", lat: 43.7, lon: -71.6, region: "Northeast" },
  NJ: { name: "New Jersey", lat: 40.1, lon: -74.7, region: "Northeast" },
  NM: { name: "New Mexico", lat: 34.4, lon: -106.1, region: "Mountain" },
  NY: { name: "New York", lat: 42.9, lon: -75.5, region: "Northeast" },
  NC: { name: "North Carolina", lat: 35.5, lon: -79.4, region: "South" },
  ND: { name: "North Dakota", lat: 47.4, lon: -100.5, region: "Midwest" },
  OH: { name: "Ohio", lat: 40.4, lon: -82.8, region: "Midwest" },
  OK: { name: "Oklahoma", lat: 35.6, lon: -97.5, region: "South" },
  OR: { name: "Oregon", lat: 44.0, lon: -120.5, region: "West" },
  PA: { name: "Pennsylvania", lat: 40.9, lon: -77.8, region: "Northeast" },
  PR: { name: "Puerto Rico", lat: 18.2, lon: -66.5, region: "Non-Contiguous" },
  RI: { name: "Rhode Island", lat: 41.7, lon: -71.5, region: "Northeast" },
  SC: { name: "South Carolina", lat: 33.9, lon: -80.9, region: "South" },
  SD: { name: "South Dakota", lat: 44.4, lon: -100.2, region: "Midwest" },
  TN: { name: "Tennessee", lat: 35.8, lon: -86.4, region: "South" },
  TX: { name: "Texas", lat: 31.5, lon: -99.3, region: "South" },
  UT: { name: "Utah", lat: 39.3, lon: -111.7, region: "Mountain" },
  VT: { name: "Vermont", lat: 44.0, lon: -72.7, region: "Northeast" },
  VA: { name: "Virginia", lat: 37.5, lon: -78.8, region: "South" },
  WA: { name: "Washington", lat: 47.4, lon: -120.5, region: "West" },
  WV: { name: "West Virginia", lat: 38.6, lon: -80.6, region: "South" },
  WI: { name: "Wisconsin", lat: 44.6, lon: -89.8, region: "Midwest" },
  WY: { name: "Wyoming", lat: 43.0, lon: -107.5, region: "Mountain" },
};

const STATE_NAME_TO_CODE = new Map<string, string>(
  Object.entries(US_STATES).map(([code, info]) => [info.name.toLowerCase(), code])
);

function normalizeUsStateCode(raw?: string | null): string | null {
  if (!raw) return null;
  const clean = raw.trim();
  const upper = clean.toUpperCase();
  if (US_STATES[upper]) return upper;
  const byName = STATE_NAME_TO_CODE.get(clean.toLowerCase());
  return byName ?? null;
}

// Project US lat/lon into 800x440 SVG viewBox
function projectUsCoord(
  stateCode: string,
  lat: number,
  lon: number
): { x: number; y: number } {
  if (stateCode === "AK") return { x: 112, y: 378 };
  if (stateCode === "HI") return { x: 222, y: 392 };
  if (stateCode === "PR") return { x: 678, y: 402 };
  // Contiguous US bounding box: lon -125..-66, lat 24.5..49.5
  const x = 68 + ((lon + 125) / 59) * 676;
  const y = 38 + ((49.5 - lat) / 25) * 324;
  return {
    x: Math.max(55, Math.min(760, x)),
    y: Math.max(30, Math.min(395, y)),
  };
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Clean contiguous US silhouette path for crisp cartographic backdrop
const US_OUTLINE_PATH =
  "M 76 62 L 138 56 L 235 55 L 350 56 L 445 64 L 495 85 L 542 104 L 590 95 L 650 85 L 702 68 L 732 62 L 748 92 L 722 128 L 700 148 L 690 182 L 664 218 L 642 252 L 612 292 L 626 346 L 608 366 L 590 342 L 580 308 L 540 296 L 496 306 L 456 308 L 418 320 L 386 364 L 358 358 L 328 318 L 280 298 L 230 282 L 166 276 L 122 256 L 94 214 L 74 152 L 68 100 Z";

export function BuyerMapPanel({
  salesOrders,
  onSyncEbayLocations,
  isSyncingLocations,
  onSelectOrder,
}: BuyerMapPanelProps) {
  const [rangeDays, setRangeDays] = useState<number>(365);
  const [selectedPinKey, setSelectedPinKey] = useState<string | null>(null);
  const [mountNow] = useState(() => Date.now());

  const validOrders = useMemo(() => {
    const cutoff =
      rangeDays >= 9999 ? 0 : mountNow - rangeDays * 24 * 60 * 60 * 1000;
    return salesOrders.filter((o) => {
      if (o.fulfillment_status === "unpaid") return false;
      const ms = Date.parse(o.sold_at);
      if (cutoff > 0 && !Number.isNaN(ms) && ms < cutoff) return false;
      return true;
    });
  }, [salesOrders, rangeDays, mountNow]);

  const {
    usClusters,
    intlClusters,
    stateStats,
    locatedCount,
    unlocatedCount,
    uniqueStatesCount,
    uniqueCountries,
    avgShippingAll,
    highestCostStates,
  } = useMemo(() => {
    const usMap = new Map<
      string,
      {
        key: string;
        stateCode: string;
        label: string;
        region: string;
        x: number;
        y: number;
        orders: SalesOrderRecord[];
        totalRevenue: number;
        totalShipping: number;
      }
    >();
    const intlMap = new Map<
      string,
      {
        country: string;
        orders: SalesOrderRecord[];
        totalRevenue: number;
        totalShipping: number;
      }
    >();
    const countries = new Set<string>();
    let located = 0;
    let unlocated = 0;

    for (const o of validOrders) {
      const country = (o.buyer_country || "").trim().toUpperCase();
      const stateCode = normalizeUsStateCode(o.buyer_state);
      const isUs = !country || country === "US" || country === "USA";

      if (isUs && stateCode && US_STATES[stateCode]) {
        located += 1;
        countries.add("US");
        const st = US_STATES[stateCode];
        const coords = projectUsCoord(stateCode, st.lat, st.lon);
        const existing = usMap.get(stateCode);
        if (existing) {
          existing.orders.push(o);
          existing.totalRevenue += o.gross_sale_price;
          existing.totalShipping += o.shipping_cost;
        } else {
          usMap.set(stateCode, {
            key: stateCode,
            stateCode,
            label: st.name,
            region: st.region,
            x: coords.x,
            y: coords.y,
            orders: [o],
            totalRevenue: o.gross_sale_price,
            totalShipping: o.shipping_cost,
          });
        }
      } else if (country && country !== "US" && country !== "USA") {
        located += 1;
        countries.add(country);
        const existing = intlMap.get(country);
        if (existing) {
          existing.orders.push(o);
          existing.totalRevenue += o.gross_sale_price;
          existing.totalShipping += o.shipping_cost;
        } else {
          intlMap.set(country, {
            country,
            orders: [o],
            totalRevenue: o.gross_sale_price,
            totalShipping: o.shipping_cost,
          });
        }
      } else {
        unlocated += 1;
      }
    }

    const clusters = [...usMap.values()].sort(
      (a, b) => b.orders.length - a.orders.length
    );
    const intl = [...intlMap.values()].sort(
      (a, b) => b.orders.length - a.orders.length
    );

    const totalShip = clusters.reduce((s, c) => s + c.totalShipping, 0);
    const totalUsOrders = clusters.reduce((s, c) => s + c.orders.length, 0);
    const avgShip = totalUsOrders > 0 ? totalShip / totalUsOrders : 0;

    const highCost = [...clusters]
      .filter((c) => c.totalShipping > 0)
      .sort(
        (a, b) =>
          b.totalShipping / b.orders.length - a.totalShipping / a.orders.length
      )
      .slice(0, 5);

    return {
      usClusters: clusters,
      intlClusters: intl,
      stateStats: clusters.slice(0, 12),
      locatedCount: located,
      unlocatedCount: unlocated,
      uniqueStatesCount: clusters.length,
      uniqueCountries: [...countries],
      avgShippingAll: avgShip,
      highestCostStates: highCost,
    };
  }, [validOrders]);

  const selectedCluster = useMemo(
    () => usClusters.find((c) => c.key === selectedPinKey) ?? null,
    [usClusters, selectedPinKey]
  );

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E2E5E8] rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#EA580C]" />
              <h3 className="text-sm font-bold text-[#14151A]">
                Where Your Buyers Are
              </h3>
            </div>
            <p className="text-xs text-[#5C606B] mt-0.5">
              {locatedCount > 0 ? (
                <>
                  Mapped <strong>{locatedCount}</strong> orders across{" "}
                  <strong>{uniqueStatesCount}</strong> US state
                  {uniqueStatesCount === 1 ? "" : "s"}
                  {intlClusters.length > 0
                    ? ` and ${intlClusters.length} international destination${intlClusters.length === 1 ? "" : "s"}`
                    : ""}
                  . Click any pin to inspect orders.
                </>
              ) : (
                "Click Sync Buyer Locations from eBay to pull buyer cities & states for your past orders."
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-[#DDE2DF] bg-[#F8FAF9] p-0.5">
              {[
                { label: "30d", days: 30 },
                { label: "90d", days: 90 },
                { label: "1 Yr", days: 365 },
                { label: "All", days: 9999 },
              ].map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => setRangeDays(opt.days)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition cursor-pointer ${
                    rangeDays === opt.days
                      ? "bg-white text-[#14151A] shadow-xs"
                      : "text-[#5C606B] hover:text-[#14151A]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={isSyncingLocations}
              onClick={onSyncEbayLocations}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F766E] hover:bg-[#0D665F] text-white text-xs font-semibold transition cursor-pointer disabled:opacity-50"
            >
              {isSyncingLocations ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Sync Buyer Locations from eBay
            </button>
          </div>
        </div>

        {/* Interactive Vector US Pin Map */}
        <div className="relative rounded-xl border border-[#DCE6EC] bg-[#DCEEF5] overflow-hidden">
          <svg
            viewBox="0 0 820 430"
            className="w-full h-[290px] sm:h-[360px] select-none"
          >
            {/* Subtle ocean grid */}
            <defs>
              <pattern
                id="mapGrid"
                width="40"
                height="40"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  stroke="#CDE3EE"
                  strokeWidth="0.6"
                />
              </pattern>
            </defs>
            <rect width="820" height="430" fill="url(#mapGrid)" />

            {/* US Contiguous landmass silhouette */}
            <path
              d={US_OUTLINE_PATH}
              fill="#F7F8F6"
              stroke="#CBD5E1"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {/* Alaska / Hawaii / PR inset boxes */}
            <g>
              <rect
                x="62"
                y="346"
                width="102"
                height="64"
                rx="8"
                fill="#F7F8F6"
                stroke="#CBD5E1"
                strokeWidth="1.2"
              />
              <text
                x="72"
                y="362"
                fontSize="9"
                fill="#94A3B8"
                fontWeight="700"
              >
                AK
              </text>
              <rect
                x="176"
                y="362"
                width="90"
                height="48"
                rx="8"
                fill="#F7F8F6"
                stroke="#CBD5E1"
                strokeWidth="1.2"
              />
              <text
                x="186"
                y="378"
                fontSize="9"
                fill="#94A3B8"
                fontWeight="700"
              >
                HI
              </text>
              <rect
                x="640"
                y="374"
                width="76"
                height="40"
                rx="8"
                fill="#F7F8F6"
                stroke="#CBD5E1"
                strokeWidth="1.2"
              />
              <text
                x="650"
                y="390"
                fontSize="9"
                fill="#94A3B8"
                fontWeight="700"
              >
                PR
              </text>
            </g>

            {/* Subtle faint state labels for geographic orientation */}
            {Object.entries(US_STATES).map(([code, st]) => {
              if (code === "DC" || code === "RI" || code === "DE") return null;
              const { x, y } = projectUsCoord(code, st.lat, st.lon);
              return (
                <text
                  key={code}
                  x={x}
                  y={y + 3}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#94A3B8"
                  fontWeight="600"
                >
                  {code}
                </text>
              );
            })}

            {/* Buyer cluster pins (Flipwise coral/orange circles!) */}
            {usClusters.map((c) => {
              const count = c.orders.length;
              const r = Math.min(22, Math.max(10, 8 + Math.sqrt(count) * 4));
              const isSelected = selectedPinKey === c.key;
              return (
                <g
                  key={c.key}
                  transform={`translate(${c.x}, ${c.y})`}
                  onClick={() =>
                    setSelectedPinKey(isSelected ? null : c.key)
                  }
                  className="cursor-pointer"
                >
                  {isSelected && (
                    <circle
                      r={r + 6}
                      fill="#EA580C"
                      fillOpacity="0.22"
                    />
                  )}
                  <circle
                    r={r}
                    fill={isSelected ? "#C2410C" : "#F07855"}
                    stroke="#FFFFFF"
                    strokeWidth="2"
                  />
                  <text
                    y={3.5}
                    textAnchor="middle"
                    fill="#FFFFFF"
                    fontSize={count >= 10 ? "10" : "11"}
                    fontWeight="800"
                  >
                    {count}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Clickable Pin Order Popup Card */}
          {selectedCluster && (
            <div className="absolute top-3 right-3 w-72 sm:w-80 bg-white border border-[#E2E5E8] rounded-xl shadow-lg overflow-hidden z-10">
              <div className="px-3.5 py-2.5 bg-[#FFF7ED] border-b border-[#FED7AA] flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-[#EA580C]" />
                  <span className="text-xs font-bold text-[#9A3412]">
                    {selectedCluster.label} ({selectedCluster.orders.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPinKey(null)}
                  className="text-[#9A3412] hover:text-[#14151A] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="max-h-56 overflow-y-auto divide-y divide-[#F1F5F9]">
                {selectedCluster.orders.slice(0, 12).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onSelectOrder?.(o)}
                    className="w-full text-left px-3.5 py-2 hover:bg-[#F8FAF9] flex items-center gap-2.5 cursor-pointer"
                  >
                    {o.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={o.image_url}
                        alt={o.title}
                        className="w-8 h-8 rounded object-cover border border-[#E2E5E8] shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded bg-[#F1F5F9] shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-[#14151A] truncate">
                        {o.title}
                      </div>
                      <div className="text-[10px] text-[#5C606B] flex items-center gap-1.5">
                        <span className="font-mono font-bold text-[#0B8A5F]">
                          {fmtMoney(o.gross_sale_price)}
                        </span>
                        <span>· {o.buyer_city || selectedCluster.stateCode}</span>
                        <span>· {o.sold_at.slice(0, 10)}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {locatedCount === 0 && (
            <div className="absolute inset-0 bg-white/75 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center">
              <Globe className="w-8 h-8 text-[#0F766E] mb-2" />
              <div className="text-sm font-bold text-[#14151A]">
                No Buyer Cities Synced Yet
              </div>
              <p className="text-xs text-[#475569] max-w-sm mt-1">
                Click <strong>Sync Buyer Locations from eBay</strong> above to pull real buyer cities &amp; states for all your past eBay orders.
              </p>
            </div>
          )}
        </div>

        {/* Summary footer line */}
        <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs text-[#475569]">
          <div>
            Sold <strong>{validOrders.length}</strong> orders in selected window
            {uniqueCountries.length > 0 && (
              <>
                {" "}
                across{" "}
                <strong>
                  {uniqueCountries.slice(0, 4).join(", ")}
                  {uniqueCountries.length > 4
                    ? ` +${uniqueCountries.length - 4} more`
                    : ""}
                </strong>
              </>
            )}
            .
          </div>
          {unlocatedCount > 0 && (
            <span className="text-[11px] text-[#64748B]">
              {unlocatedCount} order{unlocatedCount === 1 ? "" : "s"} without
              saved state (sync eBay or non-eBay orders)
            </span>
          )}
        </div>
      </div>

      {/* Shipping Zone & Top Buyer States Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-[#E2E5E8] rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#14151A]">
              Top Buyer States
            </h4>
            <span className="text-[11px] text-[#5C606B]">
              Avg label/shipping: <strong className="font-mono">{fmtMoney(avgShippingAll)}</strong>
            </span>
          </div>
          {stateStats.length === 0 ? (
            <p className="text-xs text-[#64748B] py-4">
              Sync buyer locations from eBay to see your top states.
            </p>
          ) : (
            <div className="space-y-2">
              {stateStats.slice(0, 8).map((st) => {
                const maxOrders = stateStats[0]?.orders.length || 1;
                const pct = Math.max(8, (st.orders.length / maxOrders) * 100);
                return (
                  <button
                    key={st.key}
                    type="button"
                    onClick={() => setSelectedPinKey(st.key)}
                    className="w-full text-left group cursor-pointer"
                  >
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="font-semibold text-[#14151A] group-hover:text-[#0F766E]">
                        {st.label}{" "}
                        <span className="text-[10px] text-[#64748B] font-normal">
                          ({st.region})
                        </span>
                      </span>
                      <span className="font-mono text-[11px] text-[#334155]">
                        <strong>{st.orders.length}</strong> orders ·{" "}
                        {fmtMoney(st.totalRevenue)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[#F1F5F9] overflow-hidden">
                      <div
                        className="h-full bg-[#F07855] rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white border border-[#E2E5E8] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Truck className="w-4 h-4 text-[#D97706]" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#14151A]">
              Highest Shipping Cost States (Zone Alert)
            </h4>
          </div>
          <p className="text-[11px] text-[#5C606B] mb-3">
            States with the highest average shipping cost — great check to make sure buyer-paid calculated shipping covers far USPS Ground Advantage / UPS Ground zones.
          </p>
          {highestCostStates.length === 0 ? (
            <p className="text-xs text-[#64748B] py-4">
              No state shipping data available yet.
            </p>
          ) : (
            <div className="divide-y divide-[#ECEFE9]">
              {highestCostStates.map((st) => {
                const avg = st.totalShipping / Math.max(1, st.orders.length);
                return (
                  <div
                    key={st.key}
                    className="py-2 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="font-semibold text-[#14151A]">
                        {st.label}
                      </span>
                      <span className="text-[11px] text-[#64748B] ml-1.5">
                        ({st.orders.length} order{st.orders.length === 1 ? "" : "s"})
                      </span>
                    </div>
                    <div className="font-mono text-right">
                      <span className="font-bold text-[#B91C1C]">
                        {fmtMoney(avg)}/order
                      </span>
                      <span className="text-[10px] text-[#64748B] ml-1.5">
                        ({fmtMoney(st.totalShipping)} total)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {intlClusters.length > 0 && (
            <div className="mt-3 pt-3 border-t border-[#ECEFE9]">
              <div className="text-[10px] font-bold uppercase text-[#64748B] mb-1.5">
                International Destinations
              </div>
              <div className="flex flex-wrap gap-1.5">
                {intlClusters.map((ic) => (
                  <span
                    key={ic.country}
                    className="px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D4ED8] text-[11px] font-semibold"
                  >
                    {ic.country} ({ic.orders.length})
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
