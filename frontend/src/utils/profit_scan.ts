import { classifyMeta, computeItemValue, computeUsageFee, type ArteType } from "./item_meta_resolver";
import { fetchPricesBulk, type PriceMap } from "./price_feed";
import type { Recipe } from "./csv_to_recipes";

const CRYSTALIZED_FOR: Record<Exclude<ArteType,"Standard"|"Mist"|"Crystal">, string> = {
  Rune: "CRYSTALLIZED_SPIRIT",
  Soul: "CRYSTALLIZED_DREAD",
  Relic: "CRYSTALLIZED_MAGIC",
  Avalonian: "CRYSTALLIZED_DIVINITY",
};

export interface ScanConfig {
  server: "West" | "East" | "Europe";
  city: string;
  saleTaxPct: number;
  listingPct: number;
  returnRatePct: number;
  stationFeePer100: number;
  tomePrice?: number;
}

export interface ProfitRow {
  itemId: string;
  profit: number;
  profitMargin: number;
  productPrice: number;
  usageFee: number;
  materialCost: number;
  effectiveMaterialCost: number;
  arteType: string;
}

let _arteMap: Record<string, ArteType> | null = null;
async function loadArteMap(): Promise<Record<string, ArteType>> {
  if (_arteMap) return _arteMap;
  try {
    const r = await fetch("/data/arte_type_by_core_v3.json", { cache: "no-store" });
    if (r.ok) { _arteMap = await r.json(); return _arteMap!; }
  } catch {}

  try {
    const r = await fetch("/data/arte_type_by_core_v3.csv", { cache: "no-store" });
    if (r.ok) {
      const txt = await r.text();
      const map: Record<string, ArteType> = {};
      for (const line of txt.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("#")) continue;
        const [core, kind] = s.split(",").map(x=>x?.trim());
        if (!core || !kind) continue;
        if (core.toUpperCase()==="CORE" && kind.toUpperCase()==="ARTETYPE") continue;
        map[core.toUpperCase()] = (kind as ArteType);
      }
      _arteMap = map;
      return map;
    }
  } catch {}

  _arteMap = {};
  return _arteMap;
}

function arteTypeOf(core: string, arteMap: Record<string, ArteType>): ArteType {
  return arteMap[core.toUpperCase()] ?? "Standard";
}

function pickArtefactOrCrystallized(arteType: ArteType, arteItemId: string, prices: PriceMap) {
  const subId = (CRYSTALIZED_FOR as any)[arteType] as string | undefined;
  const artePrice = prices[arteItemId] ?? Infinity;
  const subPrice = subId ? prices[subId] ?? Infinity : Infinity;
  return artePrice <= subPrice ? artePrice : subPrice;
}

export async function scanProfit(recipes: Recipe[], cfg: ScanConfig): Promise<ProfitRow[]> {
  const arteMap = await loadArteMap();

  const productIds = recipes.map(r => r.itemId);
  const matIds = recipes.flatMap(r => r.materials.map(m => m.itemId));
  const altIds = Object.values(CRYSTALIZED_FOR);
  const allIds = [...new Set([...productIds, ...matIds, ...altIds])];

  const prices = await fetchPricesBulk(cfg.server, cfg.city, allIds);
  const out: ProfitRow[] = [];

  for (const r of recipes) {
    const meta = classifyMeta(r.core, r.slot);
    if (meta.isCapeCity) continue;

    const arteType = arteTypeOf(r.core, arteMap);
    const itemValue = computeItemValue(r.tier, r.enchant, meta.numItems, arteType, meta.isShapeshifter);
    const usageFee = computeUsageFee(itemValue, cfg.stationFeePer100);

    const productPrice = prices[r.itemId] ?? 0;

    const abCost = r.materials
      .filter(m => m.kind === "A" || m.kind === "B")
      .reduce((s, m) => s + (prices[m.itemId] ?? 0) * m.quantity, 0);

    const arteItemId = `T${r.tier}_ARTEFACT_${r.slot}_${r.core}`;
    const arteCost = pickArtefactOrCrystallized(arteType, arteItemId, prices);
    const tomeCost = meta.requiresTome ? (cfg.tomePrice ?? 0) : 0;

    const effectiveAB = abCost * (1 - cfg.returnRatePct / 100);
    const materialCost = abCost + arteCost + tomeCost;
    const effectiveMaterialCost = effectiveAB + arteCost + tomeCost;

    const saleTax = productPrice * (cfg.saleTaxPct / 100);
    const listingFee = productPrice * (cfg.listingPct / 100);
    const netRevenue = Math.max(0, productPrice - saleTax - listingFee);
    const totalCost = effectiveMaterialCost + usageFee;

    const profit = netRevenue - totalCost;
    const profitMargin = productPrice > 0 ? (profit / productPrice) * 100 : 0;

    out.push({ itemId: r.itemId, profit, profitMargin, productPrice, usageFee, materialCost, effectiveMaterialCost, arteType });
  }

  out.sort((a, b) => b.profit - a.profit);
  return out;
}