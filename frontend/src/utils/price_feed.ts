// src/utils/price_feed.ts

export interface PriceRow {
  item_id: string;
  city: string;
  sell_price_min: number;
  quality?: number;
}

export type PriceMap = Record<string, number>;

// 🔧 (new) 결과와 함께 어떤 도시 가격을 썼는지도 알고 싶다면:
export interface PickedPrice {
  price: number;
  cityUsed: string | null; // preferCity or fallback city, 없으면 null
}
export type PickedPriceMap = Record<string, PickedPrice>;

const SERVER_BASE = {
  Local: "http://127.0.0.1:8000", // 로컬 FastAPI 서버
  West: "https://west.albion-online-data.com",
  East: "https://east.albion-online-data.com",
  Europe: "https://europe.albion-online-data.com",
} as const;

export type ServerKey = keyof typeof SERVER_BASE;

// 선택 도시 + 대체 도시(한 번의 호출에서 모두 질의)
const CITY_ORDER = [
  "Martlock",
  "Bridgewatch",
  "Lymhurst",
  "Fort Sterling",
  "Thetford",
  "Caerleon",
  "Brecilien",
];

// 모듈 전역 메모리 캐시(세션용)
// 🔧 (fix) 도시별로 결과가 달라질 수 있으므로 키에 city 포함
// key: `${server}|${city}|${item_id}` -> prefer or fallback minNonZero
const memCache = new Map<string, PickedPrice>();

// 안전한 청크 크기(150~200 권장; 너무 크면 429 유발)
const CHUNK_SIZE = 150;

// ---- 유틸 ----
const unique = <T,>(arr: T[]) => [...new Set(arr)];

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function withJitter(baseMs: number) {
  const jitter = Math.floor(Math.random() * 100);
  return baseMs + jitter;
}

// ---- fetch with retry/backoff ----
async function fetchWithRetry(url: string, tries = 4, signal?: AbortSignal): Promise<Response> {
  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt < tries) {
    try {
      const res = await fetch(url, { cache: "no-store", signal });
      if (res.ok) return res;

      // 재시도 대상 상태코드
      if ([429, 502, 503, 504].includes(res.status)) {
        const wait = withJitter(300 * Math.pow(2, attempt)); // 300, 600, 1200, 2400 + jitter
        await sleep(wait);
        attempt++;
        continue;
      }
      // 그 외는 즉시 실패
      return res;
    } catch (e) {
      lastErr = e;
      // Abort면 곧장 throw
      if ((e as any)?.name === "AbortError") throw e;
      const wait = withJitter(300 * Math.pow(2, attempt));
      await sleep(wait);
      attempt++;
    }
  }

  if (lastErr) throw lastErr;
  // 마지막 시도
  return fetch(url, { cache: "no-store", signal });
}

// 한 번의 호출에 여러 도시를 넣어서 응답 받기
async function fetchMultiCity(
  base: string,
  ids: string[],
  cities: string[],
  signal?: AbortSignal
): Promise<PriceRow[]> {
  const url =
    `${base}/api/v2/stats/prices/` +
    // 🔧 (compat) 확실히 .json 붙여서 AOD/Local 동일 호환
    `${encodeURIComponent(ids.join(","))}.json` +
    `?locations=${encodeURIComponent(cities.join(","))}`;

  const res = await fetchWithRetry(url, 4, signal);
  if (!res.ok) return [];
  return (await res.json()) as PriceRow[];
}

/**
 * 선택 도시 가격이 0이 아니면 그 값을 사용.
 * 0이면, 같은 응답 내 "다른 도시들" 중 최저가(0 제외)를 사용.
 * 🔧 (enhance) 어떤 도시를 썼는지도 같이 반환
 */
function pickPreferredOrMinOther(
  rows: PriceRow[],
  preferCity: string
): PickedPriceMap {
  const byItem: Record<string, PriceRow[]> = {};
  for (const r of rows) {
    (byItem[r.item_id] ||= []).push(r);
  }

  const out: PickedPriceMap = {};
  for (const [item, arr] of Object.entries(byItem)) {
    const preferRow = arr.find((x) => x.city === preferCity);
    const prefer = preferRow?.sell_price_min ?? 0;

    if (prefer && prefer > 0) {
      out[item] = { price: prefer, cityUsed: preferCity };
      continue;
    }
    // 다른 도시 중 최저가(0 제외)
    let min = Infinity;
    let minCity: string | null = null;
    for (const r of arr) {
      const v = r.sell_price_min || 0;
      if (v > 0 && v < min) {
        min = v;
        minCity = r.city;
      }
    }
    out[item] = Number.isFinite(min)
      ? { price: min, cityUsed: minCity }
      : { price: 0, cityUsed: null };
  }
  return out;
}

/**
 * 가격 일괄 수집
 * @returns 가격만 필요한 경우는 prices, 대체 도시 배지도 쓰려면 picked 사용
 */
export async function fetchPricesBulk(
  server: ServerKey,
  city: string,
  itemIds: string[],
  opts?: { signal?: AbortSignal }
): Promise<{ prices: PriceMap; picked: PickedPriceMap }> {
  const base = SERVER_BASE[server];
  const uniqIds = unique(itemIds);

  // 메모리 캐시에 있는 값 선반영
  const prices: PriceMap = {};
  const picked: PickedPriceMap = {};
  const miss: string[] = [];

  for (const id of uniqIds) {
    const key = `${server}|${city}|${id}`; // 🔧 include city
    const cached = memCache.get(key);
    if (cached) {
      prices[id] = cached.price;
      picked[id] = cached;
    } else {
      miss.push(id);
    }
  }
  if (miss.length === 0) return { prices, picked };

  // 질의 도시 배열: 선택 도시 + 나머지
  const cities = [city, ...CITY_ORDER.filter((c) => c !== city)];

  // API 호출(청크 + 재시도 + 멀티시티 한 번 호출)
  const chunks = chunk(miss, CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    const ids = chunks[i];
    const rows = await fetchMultiCity(base, ids, cities, opts?.signal);
    const pickedChunk = pickPreferredOrMinOther(rows, city);

    // 결과 반영 + 캐시 저장
    for (const id of ids) {
      const p = pickedChunk[id] ?? { price: 0, cityUsed: null };
      prices[id] = p.price;
      picked[id] = p;
      memCache.set(`${server}|${city}|${id}`, p);
    }

    // 과한 연속 호출 방지(약간의 텀)
    if (i < chunks.length - 1) await sleep(withJitter(120));
  }

  return { prices, picked };
}

// 🔧 (optional) 캐시 무효화 유틸
export function invalidatePriceCache(predicate?: (key: string) => boolean) {
  if (!predicate) {
    memCache.clear();
    return;
  }
  for (const k of Array.from(memCache.keys())) {
    if (predicate(k)) memCache.delete(k);
  }
}
