export type ArteType = "Standard" | "Rune" | "Soul" | "Relic" | "Mist" | "Avalonian" | "Crystal";

const ART_MULT: Record<ArteType, number> = {
  Standard: 0, Rune: 4, Soul: 12, Relic: 28, Mist: 28, Avalonian: 60, Crystal: 60
};

const pow2 = (e: number) => Math.pow(2, e);
const shapeMult = (is: boolean) => (is ? 16/11 : 1);

export function parseItemId(itemId: string) {
  const m = itemId.toUpperCase().match(/^T([4-8])_([A-Z0-9]+)_(.+?)(?:@([0-4]))?$/);
  if (!m) return null;
  return { tier: +m[1], slot: m[2], core: m[3], enchant: m[4] ? +m[4] : 0 };
}

export function classifyMeta(core: string, slot: string) {
  const up = core.toUpperCase();
  const s  = slot.toUpperCase();

  const isShapeshifter = /SHAPESHIFTER/.test(up);
  const isBag = /BAG|SATCHEL/.test(up);
  const isInsightBag = /INSIGHT/.test(up);
  const isCapeGeneral = /(^|_)CAPE$/.test(up);
  const isCapeCity = /_CAPE_/.test(up);
  const isBow = /BOW/.test(up);

  let numItems = 24;
  let handed: "1H" | "2H" | "OFF" | "OTHER" = "1H";

  if (s === "OFF") { handed = "OFF"; numItems = 8; }
  else if (s === "2H") { handed = "2H"; numItems = 32; }
  else if (s === "MAIN") { handed = "1H"; numItems = 24; }
  else { handed = "OTHER"; }

  if (isBag) numItems = 16;
  if (isCapeGeneral) numItems = 8;
  if (isCapeCity) numItems = 0;
  if (isShapeshifter) { handed = "2H"; numItems = 32; }
  if (isBow) { handed = "2H"; numItems = 32; }

  return { handed, numItems, isShapeshifter, isBag, isCapeGeneral, isCapeCity, requiresTome: isInsightBag };
}

export function computeArteTypeByCore(core: string, arteMap: Record<string, ArteType>): ArteType {
  return arteMap[core.toUpperCase()] ?? "Standard";
}

export function computeItemValue(
  tier: number, enchant: number, numItems: number, arteType: ArteType, isShapeshifter: boolean
) {
  const base = 16 * pow2(tier + enchant - 4);
  const arte = ART_MULT[arteType] * pow2(tier - 4);
  return numItems * (base + arte) * shapeMult(isShapeshifter);
}

export function computeUsageFee(itemValue: number, stationFeePer100: number) {
  return itemValue * 0.1125 * (stationFeePer100 / 100);
}
