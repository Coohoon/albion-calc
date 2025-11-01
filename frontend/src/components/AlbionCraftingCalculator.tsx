// frontend/src/components/AlbionCraftingCalculator.tsx
// FORCE RELOAD v3
import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchPricesBulk, invalidatePriceCache, type ServerKey } from "../utils/price_feed";
import {
  parseItemId,
  classifyMeta,
  computeItemValue,
  computeUsageFee,
  type ArteType,
} from "../utils/item_meta_resolver";
import Papa from "papaparse";

// ---------- Types ----------
export type Server = ServerKey;

interface MaterialRequirement {
  itemId: string;
  quantity: number;
  kind: "resource" | "artefact";
}

interface Recipe {
  itemId: string;
  tier: number;
  enchant: number;
  handed: string;
  core: string;
  requiresArtefact: boolean;
  materials: MaterialRequirement[];
}

interface RowBase {
  id: string;
  tier: string;
  city: string;
  productPrice: number;
  materialCost: number; // BEFORE return rate
  usageFee: number;
  requiresArtefact: boolean;
  arteType: ArteType;
  arteSub?: { used: boolean; via: string };
}

interface RowDerived extends RowBase {
  materialCostAfterReturn: number;
  netProfit: number;
  roiPct: number;
  status: "profit" | "loss";
}

// ---------- UI helpers ----------
const nf = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString();

const CITY_OPTIONS: Record<Server, string[]> = {
  East: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  West: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Europe: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Local: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
};

// 결정체 대체 맵
const CRYSTALLIZED_FOR: Record<Exclude<ArteType, "Standard" | "Mist" | "Crystal">, string> = {
  Rune: "RUNE",
  Soul: "SOUL",
  Relic: "RELIC",
  Avalonian: "AVALONIAN_ENERGY",
};

// ---------- Utils (재료 ID 규칙 통일) ----------
// enchant 0 → T{tier}_{BASE}
// enchant ≥1 → T{tier}_{BASE}_LEVEL{enchant}@{enchant}
function refinedId(
  tier: number,
  base: "METALBAR" | "PLANKS" | "LEATHER" | "CLOTH" | "STONEBLOCK",
  enchant: number
) {
  if (!enchant || enchant === 0) return `T${tier}_${base}`;
  return `T${tier}_${base}_LEVEL${enchant}@${enchant}`;
}

// ---------- CSV → Recipe 파서 ----------
function parseRecipeCSV(csvText: string): Recipe[] {
  const { data } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const recipes: Recipe[] = [];

  for (const row of data as any[]) {
    const id = row.id?.trim();
    if (!id) continue;
    // 최종 생산물만
    if (row.is_final_item !== "True") continue;
    // 제작 불가 or 제외 대상 제거
    if (id.includes("ARTEFACT") || id.includes("TOOL")) continue;
    // T4~T8만
    if (!id.match(/^T[4-8]_/)) continue;

    const parsed = parseItemId(id);
    if (!parsed) continue;

    const requiresArtefact = row.requires_artefact === "True";
    const materials: MaterialRequirement[] = [];

    const { tier, slot, enchant } = parsed;

    // 슬롯/무기종류 간단 규칙 (필요 시 실제 레시피 테이블로 교체 가능)
    if (slot === "BAG" || slot === "CAPE") {
      materials.push({ itemId: refinedId(tier, "CLOTH", enchant), quantity: 8, kind: "resource" });
      materials.push({ itemId: refinedId(tier, "LEATHER", enchant), quantity: 8, kind: "resource" });
    } else if (slot === "OFF") {
      materials.push({ itemId: refinedId(tier, "PLANKS", enchant), quantity: 8, kind: "resource" });
      materials.push({ itemId: refinedId(tier, "METALBAR", enchant), quantity: 8, kind: "resource" });
    } else if (slot === "MAIN") {
      materials.push({ itemId: refinedId(tier, "METALBAR", enchant), quantity: 16, kind: "resource" });
      materials.push({ itemId: refinedId(tier, "LEATHER", enchant), quantity: 8, kind: "resource" });
    } else if (slot === "2H") {
      materials.push({ itemId: refinedId(tier, "METALBAR", enchant), quantity: 20, kind: "resource" });
      materials.push({ itemId: refinedId(tier, "LEATHER", enchant), quantity: 12, kind: "resource" });
    } else if (slot === "HEAD" || slot === "ARMOR" || slot === "SHOES") {
      materials.push({ itemId: refinedId(tier, "CLOTH", enchant), quantity: 16, kind: "resource" });
      materials.push({ itemId: refinedId(tier, "LEATHER", enchant), quantity: 8, kind: "resource" });
    }

    if (requiresArtefact) {
      const artefactId = `T${tier}_ARTEFACT_${slot}_${parsed.core}`;
      materials.push({ itemId: artefactId, quantity: 1, kind: "artefact" });
    }

    recipes.push({
      itemId: id,
      tier,
      enchant,
      handed: row.handed,
      core: parsed.core,
      requiresArtefact,
      materials,
    });
  }

  return recipes;
}

// ---------- ArteMap 로드 ----------
async function loadArteMap(): Promise<Record<string, ArteType>> {
  try {
    const r = await fetch("/data/arte_type_by_core_v3.csv", { cache: "no-store" });
    if (r.ok) {
      const txt = await r.text();
      const map: Record<string, ArteType> = {};
      for (const line of txt.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("core,") || s.startsWith("﻿core")) continue;
        const [core, kind] = s.split(",").map((x) => x?.trim());
        if (!core || !kind) continue;
        map[core.toUpperCase()] = kind as ArteType;
      }
      return map;
    }
  } catch {}
  return {};
}

// ---------- Component ----------
export default function AlbionCraftingCalculator() {
  // Controls
  const [server, setServer] = useState<Server>("Local"); // 로컬 기본값(요청 흐름에 맞춤)
  const [city, setCity] = useState("Lymhurst");
  const [saleTaxPct, setSaleTaxPct] = useState(6.5);
  const [listingPct, setListingPct] = useState(1.5);
  const [returnRate, setReturnRate] = useState(24);
  const [stationFeePer100, setStationFeePer100] = useState(200);
  const [tomePrice, setTomePrice] = useState(120_000); // 현재 로우 계산에 미사용(필요 시 BAG 등에 반영 가능)
  const [showProfitOnly, setShowProfitOnly] = useState(true);
  const [sortKey, setSortKey] = useState<keyof RowDerived>("netProfit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");

  // Data
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [rows, setRows] = useState<RowBase[]>([]);
  const [pickedCityByItem, setPickedCityByItem] = useState<Record<string, string | null>>({});
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [arteMap, setArteMap] = useState<Record<string, ArteType>>({});

  // Infinite scroll
  const [displayCount, setDisplayCount] = useState(100);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const DISPLAY_STEP = 100;

  // ArteMap 로드
  useEffect(() => {
    loadArteMap().then(setArteMap);
  }, []);

  // 서버/도시 변경 시 캐시 무효화
  useEffect(() => {
    invalidatePriceCache((k) => k.startsWith(`${server}|${city}|`));
  }, [server, city]);

  // 레시피 로드
  const handleReloadRecipes = async () => {
    setLoading(true);
    setError(null);
    try {
      // CSV 로딩
      const r = await fetch("/data/aodp_parsed_items.csv", { cache: "no-store" });
      if (!r.ok) throw new Error("레시피 파일을 불러올 수 없습니다");
      const txt = await r.text();

      const parsed = parseRecipeCSV(txt);
      if (parsed.length === 0) throw new Error("파싱된 레시피가 없습니다. CSV 형식을 확인하세요.");

      setRecipes(parsed);
      // 초기 행(가격 0)
      const initialRows: RowBase[] = parsed.map((rp) => {
        const p = parseItemId(rp.itemId);
        const meta = p ? classifyMeta(p.core, p.slot) : null;
        const arteType = (arteMap[rp.core.toUpperCase()] ?? "Standard") as ArteType;

        return {
          id: rp.itemId,
          tier: `T${rp.tier}${rp.enchant > 0 ? `@${rp.enchant}` : ""}`,
          city,
          productPrice: 0,
          materialCost: 0,
          usageFee: 0,
          requiresArtefact: rp.requiresArtefact,
          arteType,
        };
      });

      setRows(initialRows);
      setPickedCityByItem({});
      setDisplayCount(100); // 스크롤 초기화
      invalidatePriceCache(); // 규칙 바뀐 직후 초기화 권장
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  // 스캔 (모든 레시피 처리: price_feed.ts가 내부에서 청크/백오프 처리)
  const handleScan = async () => {
    if (!recipes.length) {
      setError("먼저 레시피를 불러오세요");
      return;
    }
    setScanning(true);
    setError(null);

    try {
      // 1) 제품 ID와 재료 ID 수집
      const productIds = recipes.map((r) => r.itemId);
      const materialIds = new Set<string>();
      for (const r of recipes) {
        for (const m of r.materials) materialIds.add(m.itemId);
      }

      const crystalIds = Object.values(CRYSTALLIZED_FOR);
      const allIds = [...productIds, ...Array.from(materialIds), ...crystalIds];

      // 2) 가격 조회
      const { prices, picked } = await fetchPricesBulk(server, city, allIds);

      // 3) 행 계산
      const nextRows: RowBase[] = recipes.map((recipe) => {
        const parsed = parseItemId(recipe.itemId);
        if (!parsed) return null as any;

        const meta = classifyMeta(parsed.core, parsed.slot);
        const arteType = (arteMap[recipe.core.toUpperCase()] ?? "Standard") as ArteType;

        // 제작소 수수료 계산용 ItemValue
        const itemValue = computeItemValue(parsed.tier, parsed.enchant, meta.numItems, arteType, meta.isShapeshifter);
        const usageFee = Math.round(computeUsageFee(itemValue, stationFeePer100));

        // 재료비 (아티팩트 ↔ 결정체 대체 포함)
        let materialCost = 0;
        let arteSub: { used: boolean; via: string } | undefined;

        for (const mat of recipe.materials) {
          if (mat.kind === "resource") {
            materialCost += (prices[mat.itemId] ?? 0) * mat.quantity;
          } else if (mat.kind === "artefact") {
            const artePrice = prices[mat.itemId] ?? Infinity;
            const crystalKey = CRYSTALLIZED_FOR[arteType as keyof typeof CRYSTALLIZED_FOR];
            const crystalPrice = crystalKey ? (prices[crystalKey] ?? Infinity) : Infinity;

            if (crystalPrice < artePrice && crystalPrice !== Infinity) {
              materialCost += crystalPrice;
              arteSub = { used: true, via: crystalKey };
            } else {
              materialCost += artePrice === Infinity ? 0 : artePrice;
            }
          }
        }

        return {
          id: recipe.itemId,
          tier: `T${recipe.tier}${recipe.enchant > 0 ? `@${recipe.enchant}` : ""}`,
          city,
          productPrice: prices[recipe.itemId] ?? 0,
          materialCost,
          usageFee,
          requiresArtefact: recipe.requiresArtefact,
          arteType,
          arteSub,
        };
      }).filter(Boolean) as RowBase[];

      const usedMap: Record<string, string | null> = {};
      for (const id of productIds) usedMap[id] = picked[id]?.cityUsed ?? null;

      setRows(nextRows);
      setPickedCityByItem(usedMap);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setScanning(false);
    }
  };

  // 파생 테이블
  const derived: RowDerived[] = useMemo(() => {
    return rows.map((r) => {
      const materialCostAfterReturn = Math.max(0, Math.round(r.materialCost * (1 - returnRate / 100)));
      const sales = (saleTaxPct / 100) * r.productPrice;
      const listing = (listingPct / 100) * r.productPrice;
      const netRevenue = r.productPrice - sales - listing;
      const totalCost = materialCostAfterReturn + r.usageFee;
      const netProfit = Math.round(netRevenue - totalCost);
      const roiPct = r.productPrice ? (netProfit / r.productPrice) * 100 : 0;
      const status: RowDerived["status"] = netProfit >= 0 ? "profit" : "loss";
      return { ...r, materialCostAfterReturn, netProfit, roiPct, status };
    });
  }, [rows, returnRate, saleTaxPct, listingPct]);

  // 필터/정렬
  const filtered = useMemo(() => {
    let out = derived.filter((r) => (showProfitOnly ? r.status === "profit" : true));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((r) => r.id.toLowerCase().includes(q));
    }
    out.sort((a, b) => {
      const va = a[sortKey] as number | string;
      const vb = b[sortKey] as number | string;
      if (typeof va === "number" && typeof vb === "number") return sortDir === "asc" ? va - vb : vb - va;
      return 0;
    });
    return out;
  }, [derived, showProfitOnly, sortDir, sortKey, query]);

  // 무한 스크롤: 스크롤 컨테이너 이벤트
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80; // 여유 80px
    if (nearBottom) {
      setDisplayCount((c) => Math.min(c + DISPLAY_STEP, filtered.length || c + DISPLAY_STEP));
    }
  };

  useEffect(() => {
    // 필터 결과 바뀌면 노출 개수 재설정(최소 100)
    setDisplayCount((prev) => Math.max(100, Math.min(prev, filtered.length)));
  }, [filtered.length]);

  const visibleRows = filtered.slice(0, displayCount);

  const toggleSort = (key: keyof RowDerived) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-10 backdrop-blur bg-white/5 border-b border-white/10">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-600 shadow" />
            <div className="font-semibold">Albion Crafting Profit Calculator</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Connected
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4">
        {/* Controls */}
        <section className="rounded-2xl bg-white/5 backdrop-blur border border-white/10 shadow-lg p-4 md:p-5 mb-4">
          <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
            <SelectField
              label="서버"
              value={server}
              onChange={(v) => setServer(v as Server)}
              options={["Local", "East", "West", "Europe"]}
            />
            <SelectField
              label="도시"
              value={city}
              onChange={(v) => setCity(v)}
              options={CITY_OPTIONS[server]}
            />
            <NumberField label="판매세 %" value={saleTaxPct} onChange={setSaleTaxPct} step={0.1} />
            <NumberField label="리스팅 %" value={listingPct} onChange={setListingPct} step={0.1} />
            <NumberField label="반환률 %" value={returnRate} onChange={setReturnRate} step={1} />
            <NumberField label="제작소 수수료/100" value={stationFeePer100} onChange={setStationFeePer100} step={10} />
            <NumberField label="Tome 가격" value={tomePrice} onChange={setTomePrice} step={1000} />
            <div className="flex items-end gap-2">
              <button
                onClick={handleReloadRecipes}
                className="px-3 py-2 rounded-xl bg-amber-600 text-white text-sm shadow hover:bg-amber-500 disabled:opacity-60"
                disabled={loading || scanning}
              >
                {loading ? "로딩중..." : "레시피 불러오기"}
              </button>
              <button
                onClick={handleScan}
                className="px-3 py-2 rounded-xl bg-cyan-600 text-white text-sm shadow hover:bg-cyan-500 disabled:opacity-60"
                disabled={scanning || !recipes.length}
              >
                {scanning ? "스캔 중..." : "스캔 시작"}
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-2 text-sm text-slate-300 select-none cursor-pointer">
                <input
                  type="checkbox"
                  className="size-4 accent-amber-500"
                  checked={showProfitOnly}
                  onChange={(e) => setShowProfitOnly(e.target.checked)}
                />
                수익만 보기
              </label>
              <div className="relative">
                <span className="absolute left-2 top-2 text-slate-400">🔎</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="아이템 ID 검색"
                  className="pl-8 pr-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
            </div>
            <div className="text-xs text-slate-300">
              {recipes.length}개 레시피 로드됨 | {visibleRows.length}개 표시중
            </div>
          </div>
          {error && <p className="mt-2 text-sm text-rose-300">오류: {error}</p>}
        </section>

        {/* Table (무한 스크롤 컨테이너) */}
        <section className="rounded-2xl overflow-hidden bg-white/5 backdrop-blur border border-white/10 shadow-xl">
          <div
            className="overflow-auto max-h-[70vh]"
            ref={scrollRef}
            onScroll={onScroll}
          >
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 sticky top-0 z-0">
                <tr className="text-slate-300">
                  <Th label="아이템" onClick={() => toggleSort("id")} />
                  <Th label="티어" onClick={() => toggleSort("tier")} />
                  <Th label="완제품가" onClick={() => toggleSort("productPrice")} />
                  <Th label="재료비(반환후)" onClick={() => toggleSort("materialCostAfterReturn")} />
                  <Th label="제작소 수수료" onClick={() => toggleSort("usageFee")} />
                  <Th label="순이익" onClick={() => toggleSort("netProfit")} />
                  <Th label="수익률" onClick={() => toggleSort("roiPct")} />
                  <Th label="상태" onClick={() => toggleSort("status")} />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const usedCity = pickedCityByItem[r.id] ?? null;
                  const usedFallback = usedCity && usedCity !== city;
                  return (
                    <tr key={r.id} className="border-t border-white/10">
                      <td className="px-3 py-2 font-mono text-[13px] text-slate-100/90">
                        {r.id}
                        {r.arteSub?.used && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-cyan-500/20 text-cyan-200 px-2 py-0.5 text-[11px]"
                            title={`아티팩트 → ${r.arteSub.via} 대체`}
                          >
                            결정체 대체
                          </span>
                        )}
                        {usedFallback && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-indigo-500/20 text-indigo-200 px-2 py-0.5 text-[11px]"
                            title={`${city} 가격 없음 → ${usedCity} 가격 사용`}
                          >
                            {usedCity}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.tier}</td>
                      <td className="px-3 py-2 tabular-nums">{nf(r.productPrice)}</td>
                      <td className="px-3 py-2 tabular-nums">{nf(r.materialCostAfterReturn)}</td>
                      <td className="px-3 py-2 tabular-nums">{nf(r.usageFee)}</td>
                      <td className={`px-3 py-2 tabular-nums font-medium ${r.netProfit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{nf(r.netProfit)}</td>
                      <td className={`px-3 py-2 tabular-nums ${r.roiPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{r.roiPct.toFixed(2)}%</td>
                      <td className="px-3 py-2">
                        {r.status === "profit" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 px-2 py-1 text-xs">수익</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 text-rose-300 px-2 py-1 text-xs">손실</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* 하단 로드 더하기 버튼 (선택) */}
            {visibleRows.length < filtered.length && (
              <div className="p-3 flex justify-center">
                <button
                  className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-slate-100 text-sm"
                  onClick={() => setDisplayCount((c) => Math.min(c + DISPLAY_STEP, filtered.length))}
                >
                  더 불러오기 ({visibleRows.length}/{filtered.length})
                </button>
              </div>
            )}
          </div>
        </section>

        <p className="text-xs text-slate-400 mt-3">
          * 제작소 수수료 = ItemValue × 0.1125 × (수수료/100). 반환률 적용은 재료비에만 반영됩니다.
        </p>
      </main>
    </div>
  );
}

// ---------- Small UI helpers ----------
function Th({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <th className="px-3 py-2 font-medium select-none cursor-pointer" onClick={onClick}>
      {label}
    </th>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  // colorScheme: 'dark'로 네이티브 드롭다운 가독성 보장(흰 배경/흰 글자 문제 해결)
  return (
    <label className="text-sm">
      <div className="text-slate-300 mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-slate-800/80 text-slate-100 px-3 py-2 pr-7 text-sm outline-none focus:ring-2 focus:ring-amber-500"
        style={{ colorScheme: "dark" }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="text-sm">
      <div className="text-slate-300 mb-1">{label}</div>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
      />
    </label>
  );
}
