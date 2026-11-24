"use client";

import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Compass,
  Globe,
  Loader2,
  MapPin,
  Minus,
  Plus,
  RefreshCw,
  Truck,
  X,
  ZoomIn,
} from "lucide-react";
import type L from "leaflet";
import type { SalesOrderRecord } from "@/lib/types";

interface BuyerMapPanelProps {
  salesOrders: SalesOrderRecord[];
  onSyncEbayLocations: () => Promise<void>;
  isSyncingLocations: boolean;
  onSelectOrder?: (order: SalesOrderRecord) => void;
}

const US_STATES: Record<
  string,
  { name: string; lat: number; lon: number; region: string; zoom: number }
> = {
  AL: { name: "Alabama", lat: 32.81, lon: -86.79, region: "South", zoom: 7 },
  AK: { name: "Alaska", lat: 63.5, lon: -152.0, region: "Non-Contiguous", zoom: 4 },
  AZ: { name: "Arizona", lat: 34.2, lon: -111.6, region: "West", zoom: 6 },
  AR: { name: "Arkansas", lat: 34.97, lon: -92.37, region: "South", zoom: 7 },
  CA: { name: "California", lat: 36.7, lon: -119.5, region: "West", zoom: 6 },
  CO: { name: "Colorado", lat: 39.06, lon: -105.31, region: "Mountain", zoom: 7 },
  CT: { name: "Connecticut", lat: 41.6, lon: -72.75, region: "Northeast", zoom: 8 },
  DE: { name: "Delaware", lat: 39.15, lon: -75.51, region: "Northeast", zoom: 8 },
  DC: { name: "District of Columbia", lat: 38.91, lon: -77.04, region: "Northeast", zoom: 11 },
  FL: { name: "Florida", lat: 28.0, lon: -81.7, region: "South", zoom: 6 },
  GA: { name: "Georgia", lat: 32.7, lon: -83.4, region: "South", zoom: 7 },
  HI: { name: "Hawaii", lat: 20.8, lon: -156.5, region: "Non-Contiguous", zoom: 7 },
  ID: { name: "Idaho", lat: 44.24, lon: -114.48, region: "Mountain", zoom: 6 },
  IL: { name: "Illinois", lat: 40.35, lon: -88.99, region: "Midwest", zoom: 6 },
  IN: { name: "Indiana", lat: 39.85, lon: -86.26, region: "Midwest", zoom: 7 },
  IA: { name: "Iowa", lat: 42.01, lon: -93.21, region: "Midwest", zoom: 7 },
  KS: { name: "Kansas", lat: 38.53, lon: -98.2, region: "Midwest", zoom: 7 },
  KY: { name: "Kentucky", lat: 37.67, lon: -84.67, region: "South", zoom: 7 },
  LA: { name: "Louisiana", lat: 31.17, lon: -91.87, region: "South", zoom: 7 },
  ME: { name: "Maine", lat: 45.25, lon: -69.38, region: "Northeast", zoom: 7 },
  MD: { name: "Maryland", lat: 39.06, lon: -76.8, region: "Northeast", zoom: 8 },
  MA: { name: "Massachusetts", lat: 42.23, lon: -71.53, region: "Northeast", zoom: 8 },
  MI: { name: "Michigan", lat: 44.3, lon: -85.4, region: "Midwest", zoom: 6 },
  MN: { name: "Minnesota", lat: 46.2, lon: -94.3, region: "Midwest", zoom: 6 },
  MS: { name: "Mississippi", lat: 32.74, lon: -89.68, region: "South", zoom: 7 },
  MO: { name: "Missouri", lat: 38.46, lon: -92.29, region: "Midwest", zoom: 7 },
  MT: { name: "Montana", lat: 46.92, lon: -110.45, region: "Mountain", zoom: 6 },
  NE: { name: "Nebraska", lat: 41.5, lon: -99.8, region: "Midwest", zoom: 7 },
  NV: { name: "Nevada", lat: 38.8, lon: -116.8, region: "West", zoom: 6 },
  NH: { name: "New Hampshire", lat: 43.45, lon: -71.56, region: "Northeast", zoom: 8 },
  NJ: { name: "New Jersey", lat: 40.2, lon: -74.52, region: "Northeast", zoom: 8 },
  NM: { name: "New Mexico", lat: 34.5, lon: -106.1, region: "Mountain", zoom: 6 },
  NY: { name: "New York", lat: 42.6, lon: -75.5, region: "Northeast", zoom: 6 },
  NC: { name: "North Carolina", lat: 35.63, lon: -79.4, region: "South", zoom: 7 },
  ND: { name: "North Dakota", lat: 47.53, lon: -100.3, region: "Midwest", zoom: 7 },
  OH: { name: "Ohio", lat: 40.39, lon: -82.76, region: "Midwest", zoom: 7 },
  OK: { name: "Oklahoma", lat: 35.57, lon: -97.5, region: "South", zoom: 7 },
  OR: { name: "Oregon", lat: 44.0, lon: -120.5, region: "West", zoom: 7 },
  PA: { name: "Pennsylvania", lat: 40.8, lon: -77.6, region: "Northeast", zoom: 7 },
  PR: { name: "Puerto Rico", lat: 18.22, lon: -66.59, region: "Non-Contiguous", zoom: 8 },
  RI: { name: "Rhode Island", lat: 41.68, lon: -71.51, region: "Northeast", zoom: 9 },
  SC: { name: "South Carolina", lat: 33.86, lon: -80.95, region: "South", zoom: 7 },
  SD: { name: "South Dakota", lat: 44.3, lon: -100.2, region: "Midwest", zoom: 7 },
  TN: { name: "Tennessee", lat: 35.8, lon: -86.4, region: "South", zoom: 7 },
  TX: { name: "Texas", lat: 31.3, lon: -99.1, region: "South", zoom: 6 },
  UT: { name: "Utah", lat: 39.4, lon: -111.7, region: "Mountain", zoom: 7 },
  VT: { name: "Vermont", lat: 44.05, lon: -72.71, region: "Northeast", zoom: 8 },
  VA: { name: "Virginia", lat: 37.6, lon: -78.5, region: "South", zoom: 7 },
  WA: { name: "Washington", lat: 47.4, lon: -120.5, region: "West", zoom: 7 },
  WV: { name: "West Virginia", lat: 38.6, lon: -80.6, region: "South", zoom: 7 },
  WI: { name: "Wisconsin", lat: 44.5, lon: -89.8, region: "Midwest", zoom: 7 },
  WY: { name: "Wyoming", lat: 43.0, lon: -107.5, region: "Mountain", zoom: 6 },
};

const STATE_NAME_TO_CODE = new Map<string, string>(
  Object.entries(US_STATES).map(([code, info]) => [info.name.toLowerCase(), code])
);

function normalizeUsStateCode(raw?: string | null): string | null {
  if (!raw) return null;
  const clean = raw.trim();
  const upper = clean.toUpperCase();
  if (US_STATES[upper]) return upper;
  return STATE_NAME_TO_CODE.get(clean.toLowerCase()) ?? null;
}

function titleCaseCity(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface GeocodedOrderPoint {
  order: SalesOrderRecord;
  lat: number;
  lon: number;
  cityLabel: string;
  stateCode: string | null;
  countryCode: string;
}

interface DynamicCluster {
  id: string;
  lat: number;
  lon: number;
  orders: SalesOrderRecord[];
  cityNames: string[];
  label: string;
  isSingleCity: boolean;
}

/**
 * Zoom-aware spatial clustering:
 * - Zoomed out (z <= 4): regional clusters (~2.8° radius)
 * - Regional zoom (z = 5–6): metro clusters (~0.85° radius)
 * - City zoom (z >= 7): exact city pins!
 */
function buildDynamicClusters(
  points: GeocodedOrderPoint[],
  zoom: number
): DynamicCluster[] {
  if (points.length === 0) return [];

  // Group by exact city+state+rounded coords first so identical cities stay merged
  const cityBuckets = new Map<
    string,
    {
      latSum: number;
      lonSum: number;
      cityLabel: string;
      orders: SalesOrderRecord[];
    }
  >();

  for (const p of points) {
    const key = `${p.cityLabel.toLowerCase()}|${Math.round(p.lat * 20)}|${Math.round(p.lon * 20)}`;
    const existing = cityBuckets.get(key);
    if (existing) {
      existing.latSum += p.lat;
      existing.lonSum += p.lon;
      existing.orders.push(p.order);
    } else {
      cityBuckets.set(key, {
        latSum: p.lat,
        lonSum: p.lon,
        cityLabel: p.cityLabel,
        orders: [p.order],
      });
    }
  }

  const cityNodes = [...cityBuckets.values()]
    .map((b) => ({
      lat: b.latSum / b.orders.length,
      lon: b.lonSum / b.orders.length,
      cityLabel: b.cityLabel,
      orders: b.orders,
    }))
    .sort((a, b) => b.orders.length - a.orders.length);

  // At zoom >= 8, show every individual city pin directly!
  const radiusDeg =
    zoom >= 8
      ? 0.04
      : zoom === 7
        ? 0.25
        : zoom === 6
          ? 0.65
          : zoom === 5
            ? 1.4
            : zoom === 4
              ? 2.8
              : 5.0;

  const clusters: Array<{
    latSum: number;
    lonSum: number;
    weight: number;
    orders: SalesOrderRecord[];
    cityCounts: Map<string, number>;
  }> = [];

  for (const node of cityNodes) {
    let bestCluster: (typeof clusters)[number] | null = null;
    let bestDist = Infinity;

    for (const c of clusters) {
      const cLat = c.latSum / c.weight;
      const cLon = c.lonSum / c.weight;
      const dLat = node.lat - cLat;
      const dLon = (node.lon - cLon) * Math.cos((cLat * Math.PI) / 180);
      const dist = Math.hypot(dLat, dLon);
      if (dist <= radiusDeg && dist < bestDist) {
        bestDist = dist;
        bestCluster = c;
      }
    }

    if (bestCluster) {
      const w = node.orders.length;
      bestCluster.latSum += node.lat * w;
      bestCluster.lonSum += node.lon * w;
      bestCluster.weight += w;
      bestCluster.orders.push(...node.orders);
      bestCluster.cityCounts.set(
        node.cityLabel,
        (bestCluster.cityCounts.get(node.cityLabel) || 0) + w
      );
    } else {
      const w = node.orders.length;
      const cc = new Map<string, number>();
      cc.set(node.cityLabel, w);
      clusters.push({
        latSum: node.lat * w,
        lonSum: node.lon * w,
        weight: w,
        orders: [...node.orders],
        cityCounts: cc,
      });
    }
  }

  return clusters.map((c, idx) => {
    const lat = c.latSum / c.weight;
    const lon = c.lonSum / c.weight;
    const sortedCities = [...c.cityCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const isSingleCity = sortedCities.length === 1;
    const label = isSingleCity
      ? sortedCities[0]
      : `${sortedCities[0]} + ${sortedCities.length - 1} nearby cit${sortedCities.length - 1 === 1 ? "y" : "ies"}`;
    return {
      id: `cl-${idx}-${Math.round(lat * 100)}-${Math.round(lon * 100)}`,
      lat,
      lon,
      orders: c.orders.sort(
        (a, b) => Date.parse(b.sold_at || "") - Date.parse(a.sold_at || "")
      ),
      cityNames: sortedCities,
      label,
      isSingleCity,
    };
  });
}

export function BuyerMapPanel({
  salesOrders,
  onSyncEbayLocations,
  isSyncingLocations,
  onSelectOrder,
}: BuyerMapPanelProps) {
  const [rangeDays, setRangeDays] = useState<number>(365);
  const [mountNow] = useState(() => Date.now());
  const [zoomLevel, setZoomLevel] = useState<number>(4);
  const [selectedCluster, setSelectedCluster] = useState<DynamicCluster | null>(
    null
  );

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

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
    geocodedPoints,
    stateStats,
    intlClusters,
    locatedCount,
    unlocatedCount,
    uniqueStatesCount,
    uniqueCitiesCount,
    uniqueCountries,
    avgShippingAll,
    highestCostStates,
  } = useMemo(() => {
    const pts: GeocodedOrderPoint[] = [];
    const usStateMap = new Map<
      string,
      {
        stateCode: string;
        label: string;
        region: string;
        lat: number;
        lon: number;
        zoom: number;
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
    const citySet = new Set<string>();
    let located = 0;
    let unlocated = 0;

    for (const o of validOrders) {
      const country = (o.buyer_country || "").trim().toUpperCase();
      const stateCode = normalizeUsStateCode(o.buyer_state);
      const isUs = !country || country === "US" || country === "USA" || country === "PR";
      const cleanCity = titleCaseCity(o.buyer_city);

      let lat = typeof o.buyer_lat === "number" && Number.isFinite(o.buyer_lat) ? o.buyer_lat : null;
      let lon = typeof o.buyer_lon === "number" && Number.isFinite(o.buyer_lon) ? o.buyer_lon : null;

      if ((lat === null || lon === null) && isUs && stateCode && US_STATES[stateCode]) {
        lat = US_STATES[stateCode].lat;
        lon = US_STATES[stateCode].lon;
      }

      if (lat !== null && lon !== null) {
        located += 1;
        const countryCode = isUs ? "US" : country || "INTL";
        countries.add(countryCode);
        const stateFullName =
          stateCode && US_STATES[stateCode] ? US_STATES[stateCode].name : o.buyer_state || "";
        const cityLabel = cleanCity
          ? stateFullName
            ? `${cleanCity}, ${stateFullName}`
            : countryCode !== "US"
              ? `${cleanCity}, ${countryCode}`
              : cleanCity
          : stateFullName || countryCode;

        if (cleanCity) citySet.add(cityLabel.toLowerCase());
        pts.push({
          order: o,
          lat,
          lon,
          cityLabel,
          stateCode,
          countryCode,
        });
      } else {
        unlocated += 1;
      }

      if (isUs && stateCode && US_STATES[stateCode]) {
        const st = US_STATES[stateCode];
        const existing = usStateMap.get(stateCode);
        if (existing) {
          existing.orders.push(o);
          existing.totalRevenue += o.gross_sale_price;
          existing.totalShipping += o.shipping_cost;
        } else {
          usStateMap.set(stateCode, {
            stateCode,
            label: st.name,
            region: st.region,
            lat: st.lat,
            lon: st.lon,
            zoom: st.zoom,
            orders: [o],
            totalRevenue: o.gross_sale_price,
            totalShipping: o.shipping_cost,
          });
        }
      } else if (country && country !== "US" && country !== "USA") {
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
      }
    }

    const sortedStates = [...usStateMap.values()].sort(
      (a, b) => b.orders.length - a.orders.length
    );
    const intl = [...intlMap.values()].sort(
      (a, b) => b.orders.length - a.orders.length
    );
    const totalShip = sortedStates.reduce((s, c) => s + c.totalShipping, 0);
    const totalUsOrders = sortedStates.reduce((s, c) => s + c.orders.length, 0);
    const avgShip = totalUsOrders > 0 ? totalShip / totalUsOrders : 0;

    const highCost = [...sortedStates]
      .filter((c) => c.totalShipping > 0)
      .sort(
        (a, b) =>
          b.totalShipping / b.orders.length - a.totalShipping / a.orders.length
      )
      .slice(0, 5);

    return {
      geocodedPoints: pts,
      stateStats: sortedStates,
      intlClusters: intl,
      locatedCount: located,
      unlocatedCount: unlocated,
      uniqueStatesCount: sortedStates.length,
      uniqueCitiesCount: citySet.size,
      uniqueCountries: [...countries],
      avgShippingAll: avgShip,
      highestCostStates: highCost,
    };
  }, [validOrders]);

  const clusters = useMemo(
    () => buildDynamicClusters(geocodedPoints, zoomLevel),
    [geocodedPoints, zoomLevel]
  );

  // Initialize Leaflet interactive map once on client mount
  useEffect(() => {
    let cancelled = false;
    async function initMap() {
      if (!mapContainerRef.current || mapInstanceRef.current) return;
      const Lmod = (await import("leaflet")).default;
      if (cancelled || !mapContainerRef.current) return;
      leafletRef.current = Lmod;

      const map = Lmod.map(mapContainerRef.current, {
        center: [38.8, -96.5],
        zoom: 4,
        minZoom: 2,
        maxZoom: 14,
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: true,
      });

      // Free, zero-API-key Esri Light Gray Canvas + City/State Reference Labels
      // (soft blue oceans, crisp US state borders, sharp city names — lets coral buyer pins pop!)
      Lmod.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 16,
          attribution: "Tiles &copy; Esri",
        }
      ).addTo(map);

      Lmod.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 16,
          zIndex: 2,
          opacity: 0.95,
        }
      ).addTo(map);

      const layer = Lmod.layerGroup().addTo(map);
      mapInstanceRef.current = map;
      markersLayerRef.current = layer;

      map.on("zoomend", () => {
        setZoomLevel(map.getZoom());
      });
      map.on("click", () => {
        setSelectedCluster(null);
      });
    }

    initMap();
    return () => {
      cancelled = true;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markersLayerRef.current = null;
      }
    };
  }, []);

  // Re-render dynamic zoom-aware cluster pins whenever clusters or selection change
  useEffect(() => {
    const Lmod = leafletRef.current;
    const layer = markersLayerRef.current;
    const map = mapInstanceRef.current;
    if (!Lmod || !layer || !map) return;

    layer.clearLayers();

    for (const c of clusters) {
      const count = c.orders.length;
      const size = Math.min(44, Math.max(24, Math.round(20 + Math.sqrt(count) * 4.2)));
      const isSelected = selectedCluster?.id === c.id;
      const bg = isSelected ? "#C2410C" : "#F07855";
      const ring = isSelected ? "box-shadow:0 0 0 5px rgba(234,88,12,0.28),0 2px 6px rgba(0,0,0,0.25);" : "box-shadow:0 2px 6px rgba(0,0,0,0.22);";
      const labelHtml =
        count > 1
          ? `<span>${count}</span>`
          : `<span style="width:7px;height:7px;border-radius:9999px;background:#fff;display:block;"></span>`;

      const icon = Lmod.divIcon({
        className: "rcc-buyer-pin",
        html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${bg};border:2.5px solid #ffffff;color:#ffffff;font-weight:800;font-size:${count >= 100 ? 11 : 12}px;display:flex;align-items:center;justify-content:center;cursor:pointer;${ring}transition:transform 0.15s ease;">${labelHtml}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = Lmod.marker([c.lat, c.lon], { icon });
      marker.bindTooltip(
        `<div style="font-size:11px;font-weight:700;color:#14151A;">${c.label}</div><div style="font-size:10px;color:#5C606B;">${count} order${count === 1 ? "" : "s"} · Click to inspect</div>`,
        { direction: "top", offset: [0, -size / 2] }
      );
      marker.on("click", (e) => {
        Lmod.DomEvent.stopPropagation(e);
        setSelectedCluster(c);
      });
      marker.addTo(layer);
    }
  }, [clusters, selectedCluster]);

  const handleZoomIn = useCallback(() => {
    mapInstanceRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    mapInstanceRef.current?.zoomOut();
  }, []);

  const handleResetUs = useCallback(() => {
    setSelectedCluster(null);
    mapInstanceRef.current?.flyTo([38.8, -96.5], 4, { duration: 0.6 });
  }, []);

  const flyToLocation = useCallback((lat: number, lon: number, zoom: number) => {
    setSelectedCluster(null);
    mapInstanceRef.current?.flyTo([lat, lon], zoom, { duration: 0.7 });
  }, []);

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
              <span className="px-2 py-0.5 rounded-full bg-[#FFF7ED] border border-[#FED7AA] text-[10px] font-bold text-[#C2410C]">
                Zoom in to see individual cities
              </span>
            </div>
            <p className="text-xs text-[#5C606B] mt-0.5">
              {locatedCount > 0 ? (
                <>
                  Mapped <strong>{locatedCount}</strong> orders across{" "}
                  <strong>{uniqueCitiesCount}</strong> cities in{" "}
                  <strong>{uniqueStatesCount}</strong> US state
                  {uniqueStatesCount === 1 ? "" : "s"}
                  {intlClusters.length > 0
                    ? ` + ${intlClusters.length} international destination${intlClusters.length === 1 ? "" : "s"}`
                    : ""}
                  . Scroll or tap <strong>+</strong> to zoom down to exact cities.
                </>
              ) : (
                "Click Sync Buyer Locations from eBay to pull buyer cities, ZIPs & states for your orders."
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-[#DDE2DF] bg-[#F8FAF9] p-0.5">
              {[
                { label: "7d", days: 7 },
                { label: "30d", days: 30 },
                { label: "90d", days: 90 },
                { label: "1 Yr", days: 365 },
                { label: "All", days: 9999 },
              ].map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => {
                    setRangeDays(opt.days);
                    setSelectedCluster(null);
                  }}
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

        {/* Real Interactive Leaflet Map */}
        <div className="relative isolate z-0 rounded-xl border border-[#DCE6EC] overflow-hidden bg-[#D5E8F0]">
          <div
            ref={mapContainerRef}
            className="w-full h-[360px] sm:h-[460px] z-0"
          />

          {/* Custom Crisp Zoom & Reset Controls (Flipwise-style top-right) */}
          <div className="absolute top-3 right-3 z-[400] flex flex-col gap-1.5">
            <div className="bg-white border border-[#DCE1DE] rounded-lg shadow-md overflow-hidden flex flex-col">
              <button
                type="button"
                onClick={handleZoomIn}
                title="Zoom in to see individual cities"
                className="p-2 hover:bg-[#F3F5F4] text-[#14151A] border-b border-[#ECEFE9] cursor-pointer"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleZoomOut}
                title="Zoom out"
                className="p-2 hover:bg-[#F3F5F4] text-[#14151A] cursor-pointer"
              >
                <Minus className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={handleResetUs}
              title="Reset to full US view"
              className="p-2 bg-white border border-[#DCE1DE] rounded-lg shadow-md hover:bg-[#F3F5F4] text-[#14151A] cursor-pointer"
            >
              <Compass className="w-4 h-4" />
            </button>
          </div>

          {/* Zoom Level Indicator Pill */}
          <div className="absolute bottom-3 left-3 z-[400] bg-white/90 backdrop-blur-xs border border-[#DCE1DE] rounded-full px-2.5 py-1 text-[10px] font-semibold text-[#334155] shadow-xs pointer-events-none">
            {zoomLevel >= 8
              ? `City View (Zoom ${zoomLevel}) · Showing ${clusters.length} cities`
              : zoomLevel >= 6
                ? `Metro View (Zoom ${zoomLevel}) · Zoom in for exact cities`
                : `Regional View (Zoom ${zoomLevel}) · Click any pin or scroll to zoom`}
          </div>

          {/* Flipwise-Style Clicked City / Cluster Popup Card */}
          {selectedCluster && (
            <div className="absolute top-3 left-3 z-[450] w-72 sm:w-84 bg-white border border-[#E2E5E8] rounded-xl shadow-xl overflow-hidden">
              <div className="px-3.5 py-2.5 bg-[#FFF7ED] border-b border-[#FED7AA] flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-[#EA580C] shrink-0" />
                    <span className="text-xs font-bold text-[#9A3412] truncate">
                      {selectedCluster.label}
                    </span>
                  </div>
                  <div className="text-[10px] text-[#C2410C] mt-0.5">
                    {selectedCluster.orders.length} order
                    {selectedCluster.orders.length === 1 ? "" : "s"} ·{" "}
                    {fmtMoney(
                      selectedCluster.orders.reduce(
                        (s, o) => s + o.gross_sale_price,
                        0
                      )
                    )}{" "}
                    gross
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!selectedCluster.isSingleCity && zoomLevel < 10 && (
                    <button
                      type="button"
                      onClick={() =>
                        flyToLocation(
                          selectedCluster.lat,
                          selectedCluster.lon,
                          Math.min(11, zoomLevel + 3)
                        )
                      }
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#EA580C] hover:bg-[#C2410C] text-white text-[10px] font-bold cursor-pointer"
                    >
                      <ZoomIn className="w-3 h-3" />
                      Zoom In
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedCluster(null)}
                    className="p-1 text-[#9A3412] hover:text-[#14151A] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-[#F1F5F9]">
                {selectedCluster.orders.slice(0, 20).map((o) => (
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
                        className="w-9 h-9 rounded-md object-cover border border-[#E2E5E8] shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-md bg-[#F1F5F9] shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-[#14151A] truncate">
                        {o.title}
                      </div>
                      <div className="text-[10px] text-[#5C606B] flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono font-bold text-[#0B8A5F]">
                          {fmtMoney(o.gross_sale_price)}
                        </span>
                        <span>· {o.sold_at.slice(0, 10)}</span>
                        {o.buyer_city && (
                          <span className="text-[#475569]">
                            · {titleCaseCity(o.buyer_city)}
                            {o.buyer_state ? `, ${o.buyer_state}` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
                {selectedCluster.orders.length > 20 && (
                  <div className="px-3.5 py-2 text-[10px] text-center text-[#64748B] bg-[#F8FAF9]">
                    Showing latest 20 of {selectedCluster.orders.length} orders — zoom in to inspect specific cities.
                  </div>
                )}
              </div>
            </div>
          )}

          {locatedCount === 0 && (
            <div className="absolute inset-0 z-[420] bg-white/80 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center">
              <Globe className="w-8 h-8 text-[#0F766E] mb-2" />
              <div className="text-sm font-bold text-[#14151A]">
                {validOrders.length === 0 && salesOrders.length > 0
                  ? `No Orders in the Last ${rangeDays} Days`
                  : "No Buyer Cities Synced Yet"}
              </div>
              <p className="text-xs text-[#475569] max-w-sm mt-1">
                {validOrders.length === 0 && salesOrders.length > 0 ? (
                  "Try switching to 30d, 90d, 1 Yr, or All above — or click Sync Buyer Locations from eBay to pull the latest sales."
                ) : (
                  <>
                    Click <strong>Sync Buyer Locations from eBay</strong> above to pull real buyer cities, ZIP codes, and states for all your past eBay orders.
                  </>
                )}
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
              saved city/state (non-eBay or unshipped)
            </span>
          )}
        </div>
      </div>

      {/* Top Buyer States (Click to Fly & Zoom Into State!) + Shipping Zone Alert */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-[#E2E5E8] rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-[#14151A]">
                Top Buyer States
              </h4>
              <p className="text-[10px] text-[#64748B]">
                Click any state to zoom straight into its cities on the map
              </p>
            </div>
            <span className="text-[11px] text-[#5C606B]">
              Avg label/shipping:{" "}
              <strong className="font-mono">{fmtMoney(avgShippingAll)}</strong>
            </span>
          </div>
          {stateStats.length === 0 ? (
            <p className="text-xs text-[#64748B] py-4">
              Sync buyer locations from eBay to see your top states.
            </p>
          ) : (
            <div className="space-y-2">
              {stateStats.slice(0, 10).map((st) => {
                const maxOrders = stateStats[0]?.orders.length || 1;
                const pct = Math.max(8, (st.orders.length / maxOrders) * 100);
                return (
                  <button
                    key={st.stateCode}
                    type="button"
                    onClick={() => flyToLocation(st.lat, st.lon, st.zoom)}
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
                        className="h-full bg-[#F07855] rounded-full group-hover:bg-[#EA580C] transition"
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
                  <button
                    key={st.stateCode}
                    type="button"
                    onClick={() => flyToLocation(st.lat, st.lon, st.zoom)}
                    className="w-full py-2 flex items-center justify-between text-xs hover:bg-[#F8FAF9] px-1 rounded cursor-pointer"
                  >
                    <div>
                      <span className="font-semibold text-[#14151A]">
                        {st.label}
                      </span>
                      <span className="text-[11px] text-[#64748B] ml-1.5">
                        ({st.orders.length} order
                        {st.orders.length === 1 ? "" : "s"})
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
                  </button>
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
