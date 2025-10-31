// src/utils/ingest.ts
// 외부 AODP에서 끌어온 PriceRow[] -> 로컬 스냅샷으로 업로드

// 외부 타입(이미 너의 프로젝트에 있음)
export type PriceRow = { item_id: string; city: string; sell_price_min: number; quality?: number };

import { pushSnapshotsToLocal, SnapshotInput } from "./price_push";

export async function ingestExternalRowsToLocal(rows: PriceRow[]) {
  const toUpload: SnapshotInput[] = rows.map((r) => ({
    item_id: r.item_id,
    city: r.city,
    sell_price_min: r.sell_price_min ?? 0,
    buy_price_max: 0,
    quality: r.quality ?? null,
  }));
  const result = await pushSnapshotsToLocal(toUpload);
  console.log("uploaded:", result);
  return result;
}
