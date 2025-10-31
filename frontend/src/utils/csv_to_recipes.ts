import Papa from "papaparse";

export interface RecipeMat { itemId: string; quantity: number; kind: "A"|"B"|"Artefact"|"Tome"; }
export interface Recipe { itemId: string; tier: number; enchant: number; slot: string; core: string; materials: RecipeMat[]; requiresTome?: boolean; }

// 인챈트 붙이는 헬퍼
const withEnchant = (baseId: string, enchant: number) => {
  return enchant > 0 ? `${baseId}@${enchant}` : baseId;
};

export function parseAodpCsvToRecipes(csvText: string): Recipe[] {
  const { data } = Papa.parse(csvText, { header: false, skipEmptyLines: true, dynamicTyping: true });
  const out: Recipe[] = [];

  for (const row of data as any[]) {
    const [item_id, tier, slotRaw, coreRaw, enchant] = row;
    const itemId = String(item_id).trim();
    if (!/^T[4-8]_(MAIN|2H|OFF|ARMOR|HEAD|SHOES|BAG|CAPE)_/.test(itemId)) continue;

    const slot = String(slotRaw).toUpperCase();
    const core = String(coreRaw).toUpperCase();
    const ench = Number(enchant) || 0;

    // 특수 도시 망토 제외
    if (slot === "CAPE" && /_CAPE_/.test(core)) continue;

    const mats: RecipeMat[] = [];

    if (slot === "BAG") {
      mats.push({ itemId: withEnchant(`T${tier}_CLOTH`, ench),   quantity: 8, kind: "A" });
      mats.push({ itemId: withEnchant(`T${tier}_LEATHER`, ench), quantity: 8, kind: "B" });
      if (/INSIGHT/.test(core)) mats.push({ itemId: "TOME_OF_INSIGHT", quantity: 1, kind: "Tome" });
    } else if (slot === "CAPE") {
      mats.push({ itemId: withEnchant(`T${tier}_CLOTH`, ench),   quantity: 4, kind: "A" });
      mats.push({ itemId: withEnchant(`T${tier}_LEATHER`, ench), quantity: 4, kind: "B" });
    } else if (slot === "OFF") {
      // 기본형(추후 Shield/Torch/Book 세분화 가능)
      mats.push({ itemId: withEnchant(`T${tier}_PLANKS`, ench),   quantity: 4, kind: "A" });
      mats.push({ itemId: withEnchant(`T${tier}_METALBAR`, ench), quantity: 4, kind: "B" });
    } else {
      // 무기/방어구 기본치(세부 규칙은 이후 확장)
      mats.push({ itemId: withEnchant(`T${tier}_METALBAR`, ench), quantity: 16, kind: "A" });
      mats.push({ itemId: withEnchant(`T${tier}_LEATHER`,  ench), quantity: 8,  kind: "B" });
    }

    out.push({
      itemId,
      tier: +tier,
      enchant: ench,
      slot,
      core,
      materials: mats,
      requiresTome: /INSIGHT/.test(core),
    });
  }
  return out;
}
