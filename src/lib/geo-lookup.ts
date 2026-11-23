import zipcodes from "zipcodes";

const US_STATE_CENTROIDS: Record<string, [number, number]> = {
  AL: [32.8067, -86.7911],
  AK: [61.3707, -152.4044],
  AZ: [33.7298, -111.4312],
  AR: [34.9697, -92.3731],
  CA: [36.1162, -119.6816],
  CO: [39.0598, -105.3111],
  CT: [41.5978, -72.7554],
  DE: [39.3185, -75.5071],
  DC: [38.9072, -77.0369],
  FL: [27.7663, -81.6868],
  GA: [33.0406, -83.6431],
  HI: [21.0943, -157.4983],
  ID: [44.2405, -114.4788],
  IL: [40.3495, -88.9861],
  IN: [39.8494, -86.2583],
  IA: [42.0115, -93.2105],
  KS: [38.5266, -96.7265],
  KY: [37.6681, -84.6701],
  LA: [31.1695, -91.8678],
  ME: [44.6939, -69.3819],
  MD: [39.0639, -76.8021],
  MA: [42.2302, -71.5301],
  MI: [43.3266, -84.5361],
  MN: [45.6945, -93.9002],
  MS: [32.7416, -89.6787],
  MO: [38.4561, -92.2884],
  MT: [46.9219, -110.4544],
  NE: [41.1254, -98.2681],
  NV: [38.3135, -117.0554],
  NH: [43.4525, -71.5639],
  NJ: [40.2989, -74.521],
  NM: [34.8405, -106.2485],
  NY: [42.1657, -74.9481],
  NC: [35.6301, -79.8064],
  ND: [47.5289, -99.784],
  OH: [40.3888, -82.7649],
  OK: [35.5653, -96.9289],
  OR: [44.572, -122.0709],
  PA: [40.5908, -77.2098],
  PR: [18.2208, -66.5901],
  RI: [41.6809, -71.5118],
  SC: [33.8569, -80.945],
  SD: [44.2998, -99.4388],
  TN: [35.7478, -86.6923],
  TX: [31.0545, -97.5635],
  UT: [40.15, -111.8624],
  VT: [44.0459, -72.7107],
  VA: [37.7693, -78.17],
  WA: [47.4009, -121.4905],
  WV: [38.4912, -80.9545],
  WI: [44.2685, -89.6165],
  WY: [42.756, -107.3025],
};

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "puerto rico": "PR",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  CA: [43.6532, -79.3832],
  GB: [51.5074, -0.1278],
  UK: [51.5074, -0.1278],
  DE: [51.1657, 10.4515],
  FR: [48.8566, 2.3522],
  BE: [50.8503, 4.3517],
  NL: [52.3676, 4.9041],
  IT: [41.9028, 12.4964],
  ES: [40.4168, -3.7038],
  AU: [-33.8688, 151.2093],
  JP: [35.6762, 139.6503],
  MX: [19.4326, -99.1332],
  IE: [53.3498, -6.2603],
  CH: [46.948, 7.4474],
  SE: [59.3293, 18.0686],
  NO: [59.9139, 10.7522],
  NZ: [-36.8485, 174.7633],
  SG: [1.3521, 103.8198],
  KR: [37.5665, 126.978],
  BR: [-23.5505, -46.6333],
  IL: [32.0853, 34.7818],
  PL: [52.2297, 21.0122],
  AT: [48.2082, 16.3738],
  DK: [55.6761, 12.5683],
};

function normalizeStateCode(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (US_STATE_CENTROIDS[upper]) return upper;
  return STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

/**
 * Server-side offline geocoder resolving buyer postal codes (42,000+ US ZIPs),
 * city+state pairs, US state centroids, and international country codes into
 * exact [lat, lon] coordinates with zero external API calls and zero client JS bloat.
 */
export function resolveBuyerCoords(params: {
  city?: string | null;
  state?: string | null;
  postal?: string | null;
  country?: string | null;
}): { lat: number; lon: number } | null {
  const country = (params.country || "").trim().toUpperCase();
  const isUs = !country || country === "US" || country === "USA" || country === "PR";

  if (isUs) {
    // 1. Exact 5-digit US ZIP code lookup (most accurate city/neighborhood position!)
    const postalRaw = (params.postal || "").trim();
    const zipMatch = postalRaw.match(/^(\d{5})/);
    if (zipMatch) {
      const hit = zipcodes.lookup(zipMatch[1]);
      if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
        return { lat: hit.latitude, lon: hit.longitude };
      }
    }

    // 2. Exact City + State lookup
    const stateCode = normalizeStateCode(params.state);
    const cleanCity = (params.city || "").trim();
    if (cleanCity && stateCode) {
      const hits = zipcodes.lookupByName(cleanCity, stateCode);
      if (Array.isArray(hits) && hits.length > 0) {
        const hit = hits[0];
        if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
          return { lat: hit.latitude, lon: hit.longitude };
        }
      }
    }

    // 3. US State centroid fallback
    if (stateCode && US_STATE_CENTROIDS[stateCode]) {
      const [lat, lon] = US_STATE_CENTROIDS[stateCode];
      return { lat, lon };
    }
  }

  // 4. Canadian postal / international country fallback
  if (country === "CA" && params.postal) {
    const hit = zipcodes.lookup(params.postal.trim().slice(0, 3));
    if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
      return { lat: hit.latitude, lon: hit.longitude };
    }
  }
  if (country && COUNTRY_CENTROIDS[country]) {
    const [lat, lon] = COUNTRY_CENTROIDS[country];
    return { lat, lon };
  }

  return null;
}
