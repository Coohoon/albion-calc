// src/utils/price_push.ts

export type SnapshotInput = {
  item_id: string;
  city: string;
  sell_price_min: number;     // 0 허용
  buy_price_max?: number;     // 기본 0
  quality?: number | null;    // 1~5 또는 null
};

const SERVER_BASE = {
  Local: "http://127.0.0.1:8000",
  West: "https://west.albion-online-data.com",
  East: "https://east.albion-online-data.com",
  Europe: "https://europe.albion-online-data.com",
} as const;

const CHUNK_SIZE = 200;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withJitter(baseMs: number) {
  const j = Math.floor(Math.random() * 100);
  return baseMs + j;
}

async function postWithRetry(url: string, body: unknown, tries = 4): Promise<Response> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < tries) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      if ([429, 502, 503, 504].includes(res.status)) {
        await sleep(withJitter(300 * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(withJitter(300 * Math.pow(2, attempt)));
      attempt++;
    }
  }
  if (lastErr) throw lastErr;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 로컬 서버로 스냅샷 벌크 업로드 */
export async function pushSnapshotsToLocal(
  data: SnapshotInput[],
): Promise<{ ok: boolean; inserted: number }> {
  const base = SERVER_BASE.Local;
  const url = `${base}/snapshots/bulk`;

  const normalized = data.map((d) => ({
    item_id: d.item_id,
    city: d.city,
    sell_price_min: Math.trunc(d.sell_price_min ?? 0),
    buy_price_max: Math.trunc(d.buy_price_max ?? 0),
    quality: d.quality ?? null,
  }));

  let total = 0;
  for (let i = 0; i < normalized.length; i += CHUNK_SIZE) {
    const chunk = normalized.slice(i, i + CHUNK_SIZE);
    const res = await postWithRetry(url, chunk);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`bulk upload failed: ${res.status} ${res.statusText} ${text}`);
    }
    const json = (await res.json()) as { ok: boolean; inserted: number };
    total += json.inserted ?? chunk.length;
    if (i + CHUNK_SIZE < normalized.length) await sleep(withJitter(120));
  }
  return { ok: true, inserted: total };
}
