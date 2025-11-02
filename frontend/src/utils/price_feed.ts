// frontend/src/utils/price_feed.ts
// 품질(qualities) 파라미터 반영 + 캐시 키에 품질 포함 + 멀티시티 호출 안정화

export interface PriceRow {
  item_id: string;
  city: string;
  sell_price_min: number;
  quality?: number;
}

export type PriceMap = Record<string, number>;

export interface PickedPrice {
  price: number;
  cityUsed: string | null; // preferCity 또는 대체 도시. 없으면 null
  qualityUsed?: number | null;
}
export type PickedPriceMap = Record<string, PickedPrice>;

const SERVER_BASE = {
  Local: "http://127.0.0.1:8000",
  West: "https://west.albion-online-data.com",
  East: "https://east.albion-online-data.com",
  Europe: "https://europe.albion-online-data.com",
} as const;

export type ServerKey = keyof typeof SERVER_BASE;

// 선호 도시 뒤에 대체 도시들
const CITY_ORDER = [
  "Martlock",
  "Bridgewatch",
  "Lymhurst",
  "Fort Sterling",
  "Thetford",
  "Caerleon",
  "Brecilien",
];

const memCache = new Map<string, PickedPrice>();
const CHUNK_SIZE = 150;

const unique = <T,>(arr: T[]) => [...new Set(arr)];
const chunk = <T,>(arr: T[], n: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * 100);

async function fetchWithRetry(url: string, tries = 4, signal?: AbortSignal) {
  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt < tries) {
    try {
      const res = await fetch(url, { cache: "no-store", signal });
      if (res.ok) return res;
      if ([429, 502, 503, 504].includes(res.status)) {
        await sleep(jitter(300 * 2 ** attempt));
        attempt++;
        continue;
      }
      return res; // 그 외는 즉시 반환(상세는 상위에서 판단)
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      lastErr = e;
      await sleep(jitter(300 * 2 ** attempt));
      attempt++;
    }
  }
  if (lastErr) throw lastErr;
  return fetch(url, { cache: "no-store", signal });
}

/**
 * 멀티시티 × 멀티품질 단일호출
 * - ids는 각 아이템 ID만 encodeURIComponent (콤마는 그대로)
 * - qualities는 "1,2,3,4" 같은 CSV
 */
async function fetchMultiCity(
  base: string,
  ids: string[],
  cities: string[],
  qualities: number[],
  signal?: AbortSignal
): Promise<PriceRow[]> {
  const encodedIds = ids.map(encodeURIComponent).join(",");
  const qs = new URLSearchParams();
  if (cities.length) qs.set("locations", cities.join(","));
  if (qualities.length) qs.set("qualities", qualities.join(","));
  const url = `${base}/api/v2/stats/prices/${encodedIds}.json?${qs.toString()}`;
  const res = await fetchWithRetry(url, 4, signal);
  if (!res.ok) return [];
  return (await res.json()) as PriceRow[];
}

/**
 * 선호 도시 값(0 제외)이 있으면 그걸 사용,
 * 없으면 같은 응답 묶음 내 다른 도시의 0이 아닌 최저가 사용
 * - 품질은 같은 호출에서 최소가를 고를 때, 품질 섞여 들어오면 "가격 기준"으로만 선택
 *   (원한다면 품질 우선순위 로직을 추가할 수 있음)
 */
function pickPreferredOrMinOther(
  rows: PriceRow[],
  preferCity: string
): PickedPriceMap {
  const byItem: Record<string, PriceRow[]> = {};
  for (const r of rows) (byItem[r.item_id] ||= []).push(r);

  const out: PickedPriceMap = {};
  for (const [item, arr] of Object.entries(byItem)) {
    // 선호 도시 레코드들 중 최저가(0 제외)
    const preferCandidates = arr.filter((x) => x.city === preferCity && (x.sell_price_min || 0) > 0);
    if (preferCandidates.length) {
      const best = preferCandidates.reduce((a, b) => (a.sell_price_min <= b.sell_price_min ? a : b));
      out[item] = { price: best.sell_price_min, cityUsed: preferCity, qualityUsed: best.quality ?? null };
      continue;
    }
    // 다른 도시 중 최저가(0 제외)
    let min: PriceRow | null = null;
    for (const r of arr) {
      const v = r.sell_price_min || 0;
      if (v <= 0) continue;
      if (!min || v < min.sell_price_min) min = r;
    }
    out[item] = min
      ? { price: min.sell_price_min, cityUsed: min.city, qualityUsed: min.quality ?? null }
      : { price: 0, cityUsed: null, qualityUsed: null };
  }
  return out;
}

/**
 * 일괄 가격 조회
 * - qualities: [1] (일반), [1,2], [4] (걸작) 등
 * - 캐시 키에 qualities를 포함해서 품질 변경 시 즉시 다른 결과를 보이도록 함
 */
export async function fetchPricesBulk(
  server: ServerKey,
  city: string,
  itemIds: string[],
  opts?: { signal?: AbortSignal; qualities?: number[] }
): Promise<{ prices: PriceMap; picked: PickedPriceMap }> {
  const base = SERVER_BASE[server];
  const uniqIds = unique(itemIds);
  const qualities = (opts?.qualities && opts.qualities.length ? opts.qualities : [1]).sort((a, b) => a - b);
  const qualKey = `q=${qualities.join("-")}`;

  // 캐시 우선
  const prices: PriceMap = {};
  const picked: PickedPriceMap = {};
  const miss: string[] = [];

  for (const id of uniqIds) {
    const key = `${server}|${city}|${qualKey}|${id}`;
    const cached = memCache.get(key);
    if (cached) {
      prices[id] = cached.price;
      picked[id] = cached;
    } else {
      miss.push(id);
    }
  }
  if (!miss.length) return { prices, picked };

  const cities = [city, ...CITY_ORDER.filter((c) => c !== city)];
  const chunks = chunk(miss, CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i++) {
    const ids = chunks[i];
    const rows = await fetchMultiCity(base, ids, cities, qualities, opts?.signal);
    const pickedChunk = pickPreferredOrMinOther(rows, city);

    for (const id of ids) {
      const p = pickedChunk[id] ?? { price: 0, cityUsed: null, qualityUsed: null };
      prices[id] = p.price;
      picked[id] = p;
      memCache.set(`${server}|${city}|${qualKey}|${id}`, p);
    }
    if (i < chunks.length - 1) await sleep(jitter(120));
  }

  return { prices, picked };
}

export function invalidatePriceCache(predicate?: (key: string) => boolean) {
  if (!predicate) {
    memCache.clear();
    return;
  }
  for (const k of Array.from(memCache.keys())) {
    if (predicate(k)) memCache.delete(k);
  }
}
