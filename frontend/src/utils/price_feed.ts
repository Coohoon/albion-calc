// src/utils/price_feed.ts

export interface PriceRow {
  item_id: string;
  city: string;
  sell_price_min: number;
  quality?: number; // 1: Normal, 2: Good, 3: Outstanding, 4: Excellent, 5: Masterpiece
}

export type PriceMap = Record<string, number>;

// 결과와 함께 어떤 도시 가격을 썼는지도 알고 싶다면:
export interface PickedPrice {
  price: number;
  cityUsed: string | null; // preferCity or fallback city, 없으면 null
  quality?: number | null; // 실제로 선택된 행의 품질(선택품질 범위 내)
}
export type PickedPriceMap = Record<string, PickedPrice>;

const SERVER_BASE = {
  Local: "http://127.0.0.1:8000", // 로컬 FastAPI 서버 (프록시/모킹)
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

// 도시명 → LocationId (로컬 Type-A 엔드포인트 용)
const CITY_TO_LOCID: Record<string, string> = {
  Lymhurst: "1002",
  Bridgewatch: "1006",
  Martlock: "1004",
  Thetford: "1005",
  "Fort Sterling": "1003",
  Caerleon: "2002",
  Brecilien: "3008",
};

// 모듈 전역 메모리 캐시(세션용)
// 도시 및 품질 조합별로 결과가 달라질 수 있으므로 키에 qualities도 포함
// key: `${server}|${city}|q=${qualities.join(',')}|${item_id}` -> prefer or fallback minNonZero
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
    } catch (e: any) {
      lastErr = e;
      if (e?.name === "AbortError") throw e;
      const wait = withJitter(300 * Math.pow(2, attempt));
      await sleep(wait);
      attempt++;
    }
  }

  if (lastErr) throw lastErr;
  // 마지막 시도
  return fetch(url, { cache: "no-store", signal });
}

// ---- 응답 정규화 (로컬/원격 서로 다른 포맷을 공통 PriceRow로 변환) ----

/** 로컬 서버 Type A: [{ item_id, price, cityUsed }] */
function normalizeLocalTypeA(arr: Array<{ item_id: string; price: number; cityUsed?: string | null }>): PriceRow[] {
  return arr.map((x) => ({
    item_id: decodeURIComponent(x.item_id ?? ""), // 혹시 서버가 인코딩된 키를 줄 경우 대비
    city: x.cityUsed ?? "",
    sell_price_min: Number(x.price ?? 0) || 0,
    // quality 정보 없음 (서버에서 이미 집계된 값이라 가정)
  }));
}

/** 원격/Albion-Data: [{ item_id, city, sell_price_min, quality }] */
function normalizeAlbion(rows: any[]): PriceRow[] {
  return rows.map((r) => ({
    item_id: String(r.item_id ?? ""),
    city: String(r.city ?? ""),
    sell_price_min: Number(r.sell_price_min ?? 0) || 0,
    quality: r.quality != null ? Number(r.quality) : undefined,
  }));
}

function buildQualitiesParam(qualities?: number[]) {
  if (!qualities || qualities.length === 0) return ""; // 서버 디폴트(=전체) 사용
  const qs = qualities.join(",");
  return `&qualities=${encodeURIComponent(qs)}`;
}

// ---- 멀티시티 조회 (서버/엔드포인트 별로 분기) ----
async function fetchMultiCity(
  server: ServerKey,
  ids: string[],
  cities: string[],
  qualities?: number[],
  signal?: AbortSignal
): Promise<PriceRow[]> {
  const base = SERVER_BASE[server];
  // 각 아이템 ID만 개별 인코딩(@ → %40 등), 콤마(,)는 그대로 유지
  const encodedIds = ids.map(encodeURIComponent).join(",");
  const locationsParam = encodeURIComponent(cities.join(","));
  const qualitiesParam = buildQualitiesParam(qualities);

  // ── Local 서버: 품질 필터가 지정된 경우에는 AOD 스타일만 사용 (Type-A는 quality 미지원)
  if (server === "Local") {
    if (!qualities || qualities.length === 0) {
      // 품질 미지정 시: 먼저 Type-A 시도
      const preferCity = cities[0]; // 첫 번째가 사용자가 고른 도시
      const loc = CITY_TO_LOCID[preferCity] ?? "";
      // Type-A: GET /api/v2/stats/prices?items=...&location_id=1002
      const urlA = `${base}/api/v2/stats/prices?items=${encodedIds}&location_id=${encodeURIComponent(loc)}`;
      try {
        const rA = await fetchWithRetry(urlA, 3, signal);
        if (rA.ok) {
          const dataA = (await rA.json()) as Array<{ item_id: string; price: number; cityUsed?: string | null }>;
          return normalizeLocalTypeA(dataA);
        }
        // 404 등: 다음 시도로 넘어감
      } catch (_) {
        // 다음 시도
      }
    }
    // Local-대안: Albion-Data 스타일 (품질 파라미터 포함 가능)
    // GET /api/v2/stats/prices/{ids}.json?locations=Lymhurst,Bridgewatch,...&qualities=1,2,3
    const urlB = `${base}/api/v2/stats/prices/${encodedIds}.json?locations=${locationsParam}${qualitiesParam}`;
    const rB = await fetchWithRetry(urlB, 3, signal);
    if (!rB.ok) return [];
    const dataB = await rB.json();
    return normalizeAlbion(Array.isArray(dataB) ? dataB : []);
  }

  // ── 원격(공식) 서버
  // https://{region}.albion-online-data.com/api/v2/stats/prices/T4_OFF_SHIELD%2CT4_OFF_SHIELD%401.json?locations=Lymhurst&qualities=1,2
  const remoteUrl = `${base}/api/v2/stats/prices/${encodedIds}.json?locations=${locationsParam}${qualitiesParam}`;
  const r = await fetchWithRetry(remoteUrl, 4, signal);
  if (!r.ok) return [];
  const rows = await r.json();
  return normalizeAlbion(Array.isArray(rows) ? rows : []);
}

/**
 * 선택 도시 가격이 0이 아니면 그 값을 사용.
 * 0이면, 같은 응답 내 "다른 도시들" 중 최저가(0 제외)를 사용.
 * 어떤 도시와 어떤 품질을 썼는지도 같이 반환.
 * (allowedQualities가 지정되면 해당 품질만 고려)
 */
function pickPreferredOrMinOther(
  rows: PriceRow[],
  preferCity: string,
  allowedQualities?: number[]
): PickedPriceMap {
  // 품질 필터 사전 적용
  const filtered = !allowedQualities || allowedQualities.length === 0
    ? rows
    : rows.filter(r => !r.quality || allowedQualities.includes(r.quality));

  const byItem: Record<string, PriceRow[]> = {};
  for (const r of filtered) {
    (byItem[r.item_id] ||= []).push(r);
  }

  const out: PickedPriceMap = {};
  for (const [item, arr] of Object.entries(byItem)) {
    // 1) 선호 도시 우선
    const preferRow = arr.find((x) => x.city === preferCity && (x.sell_price_min || 0) > 0);
    if (preferRow) {
      out[item] = { price: preferRow.sell_price_min, cityUsed: preferCity, quality: preferRow.quality ?? null };
      continue;
    }

    // 2) 다른 도시 중 최저가(0 제외)
    let best: PriceRow | null = null;
    for (const r of arr) {
      const v = r.sell_price_min || 0;
      if (v <= 0) continue;
      if (!best || v < best.sell_price_min) best = r;
    }
    out[item] = best
      ? { price: best.sell_price_min, cityUsed: best.city, quality: best.quality ?? null }
      : { price: 0, cityUsed: null, quality: null };
  }
  return out;
}

/**
 * 가격 일괄 수집
 * @param qualities 선택 품질 배열 (예: [1] 또는 [1,2,3,4]) — 미지정 또는 빈배열이면 전체
 * @returns 가격만 필요한 경우는 prices, 대체 도시/품질 배지도 쓰려면 picked 사용
 */
export async function fetchPricesBulk(
  server: ServerKey,
  city: string,
  itemIds: string[],
  opts?: { signal?: AbortSignal; qualities?: number[] }
): Promise<{ prices: PriceMap; picked: PickedPriceMap }> {
  const uniqIds = unique(itemIds);
  const qualities = opts?.qualities ?? []; // 캐시 키에 포함

  // 메모리 캐시에 있는 값 선반영
  const prices: PriceMap = {};
  const picked: PickedPriceMap = {};
  const miss: string[] = [];

  for (const id of uniqIds) {
    const key = `${server}|${city}|q=${qualities.join(",")}|${id}`;
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
    const rows = await fetchMultiCity(server, ids, cities, qualities, opts?.signal);
    const pickedChunk = pickPreferredOrMinOther(rows, city, qualities);

    // 결과 반영 + 캐시 저장
    for (const id of ids) {
      const p = pickedChunk[id] ?? { price: 0, cityUsed: null, quality: null };
      prices[id] = p.price;
      picked[id] = p;
      memCache.set(`${server}|${city}|q=${qualities.join(",")}|${id}`, p);
    }

    // 과한 연속 호출 방지(약간의 텀)
    if (i < chunks.length - 1) await sleep(withJitter(120));
  }

  return { prices, picked };
}

// 캐시 무효화 유틸
export function invalidatePriceCache(predicate?: (key: string) => boolean) {
  if (!predicate) {
    memCache.clear();
    return;
  }
  for (const k of Array.from(memCache.keys())) {
    if (predicate(k)) memCache.delete(k);
  }
}
