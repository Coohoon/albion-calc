// frontend/src/components/AlbionCraftingCalculator.tsx
// v2025-11-02: Infinite scroll + Missing materials handling + Quality filter reactive

import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchPricesBulk, invalidatePriceCache, type ServerKey } from "../utils/price_feed";
import { parseItemId, classifyMeta, computeItemValue, computeUsageFee, type ArteType } from "../utils/item_meta_resolver";
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
  materialCost: number;              // 원재료 총합(반환률 적용 전)
  usageFee: number;                  // 제작소 수수료
  requiresArtefact: boolean;
  arteType: ArteType;
  arteSub?: { used: boolean; via: string };
  missingMaterials: string[];        // 가격이 0/없음인 재료(원 아티팩트 포함)
}

type RowStatus = "profit" | "loss" | "incomplete";

interface RowDerived extends RowBase {
  materialCostAfterReturn: number;
  netProfit: number;
  roiPct: number;
  status: RowStatus;
}

const nf = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString();

const CITY_OPTIONS: Record<Server, string[]> = {
  East: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  West: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Europe: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Local: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
};

// 아티타입 → 결정체 키
const CRYSTALLIZED_FOR: Record<Exclude<ArteType, "Standard" | "Mist" | "Crystal">, string> = {
  Rune: "RUNE",
  Soul: "SOUL",
  Relic: "RELIC",
  Avalonian: "AVALONIAN_ENERGY",
};

// ---------- CSV → Recipe ----------
function parseRecipeCSV(csvText: string): Recipe[] {
  const { data } = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const recipes: Recipe[] = [];

  for (const row of data as any[]) {
    const id = row.id?.trim();
    if (!id) continue;
    if (row.is_final_item !== "True") continue;
    if (id.includes("ARTEFACT") || id.includes("TOOL")) continue;
    if (!id.match(/^T[4-8]_/)) continue;

    const parsed = parseItemId(id);
    if (!parsed) continue;

    const requiresArtefact = row.requires_artefact === "True";
    const mats: MaterialRequirement[] = [];

    const { tier, slot, enchant } = parsed;
    const ench = enchant > 0 ? `@${enchant}` : "";

    if (slot === "BAG" || slot === "CAPE") {
      mats.push({ itemId: `T${tier}_CLOTH${ench}`, quantity: 8, kind: "resource" });
      mats.push({ itemId: `T${tier}_LEATHER${ench}`, quantity: 8, kind: "resource" });
    } else if (slot === "OFF") {
      mats.push({ itemId: `T${tier}_PLANKS${ench}`, quantity: 8, kind: "resource" });
      mats.push({ itemId: `T${tier}_METALBAR${ench}`, quantity: 8, kind: "resource" });
    } else if (slot === "MAIN") {
      mats.push({ itemId: `T${tier}_METALBAR${ench}`, quantity: 16, kind: "resource" });
      mats.push({ itemId: `T${tier}_LEATHER${ench}`, quantity: 8, kind: "resource" });
    } else if (slot === "2H") {
      mats.push({ itemId: `T${tier}_METALBAR${ench}`, quantity: 20, kind: "resource" });
      mats.push({ itemId: `T${tier}_LEATHER${ench}`, quantity: 12, kind: "resource" });
    } else if (slot === "HEAD" || slot === "ARMOR" || slot === "SHOES") {
      mats.push({ itemId: `T${tier}_CLOTH${ench}`, quantity: 16, kind: "resource" });
      mats.push({ itemId: `T${tier}_LEATHER${ench}`, quantity: 8, kind: "resource" });
    }

    if (requiresArtefact) {
      const artefactId = `T${tier}_ARTEFACT_${slot}_${parsed.core}`;
      mats.push({ itemId: artefactId, quantity: 1, kind: "artefact" });
    }

    recipes.push({
      itemId: id,
      tier,
      enchant,
      handed: row.handed,
      core: parsed.core,
      requiresArtefact,
      materials: mats,
    });
  }
  return recipes;
}

// ---------- Arte map (선택적) ----------
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
  const [server, setServer] = useState<Server>("Local");
  const [city, setCity] = useState("Lymhurst");
  const [saleTaxPct, setSaleTaxPct] = useState(6.5);
  const [listingPct, setListingPct] = useState(1.5);
  const [returnRate, setReturnRate] = useState(24);
  const [stationFeePer100, setStationFeePer100] = useState(200);
  const [tomePrice, setTomePrice] = useState(120_000);
  const [showProfitOnly, setShowProfitOnly] = useState(true);
  const [showIncomplete, setShowIncomplete] = useState(false); // 미확보 포함 여부
  const [sortKey, setSortKey] = useState<keyof RowDerived>("netProfit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");

  // 품질 필터(다중 선택). 1~5 중 선택. 기본: 1~3(걸작 4/5 제외)
  const [qualities, setQualities] = useState<number[]>([1, 2, 3]);

  // Data
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [rows, setRows] = useState<RowBase[]>([]);
  const [pickedCityByItem, setPickedCityByItem] = useState<Record<string, string | null>>({});
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [arteMap, setArteMap] = useState<Record<string, ArteType>>({});

  // Infinite Scroll
  const listRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(200);
  const BOTTOM_GAP = 200;
  const PAGE = 200;

  // Arte map
  useEffect(() => {
    loadArteMap().then(setArteMap);
  }, []);

  // 품질 변경 시: 캐시 무효화(도시/서버/품질별 키를 쓰기 때문에 server|city|id 캐시만 지워도 충분)
  useEffect(() => {
    invalidatePriceCache((k) => k.startsWith(`${server}|${city}|`));
  }, [server, city, qualities]);

  // 레시피 불러오기
  const handleReloadRecipes = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/data/aodp_parsed_items.csv", { cache: "no-store" });
      if (!r.ok) throw new Error("레시피 파일을 불러올 수 없습니다.");
      const txt = await r.text();
      const parsed = parseRecipeCSV(txt);
      if (parsed.length === 0) throw new Error("파싱된 레시피가 없습니다.");
      setRecipes(parsed);

      // 초기 행 생성 (가격 0)
      const initialRows: RowBase[] = parsed.slice(0, 400).map((rec) => {
        const parsedId = parseItemId(rec.itemId);
        const arteType = (arteMap[rec.core.toUpperCase()] ?? "Standard") as ArteType;
        return {
          id: rec.itemId,
          tier: `T${rec.tier}${rec.enchant > 0 ? `@${rec.enchant}` : ""}`,
          city,
          productPrice: 0,
          materialCost: 0,
          usageFee: 0,
          requiresArtefact: rec.requiresArtefact,
          arteType,
          arteSub: undefined,
          missingMaterials: [],
        };
      });

      setRows(initialRows);
      setPickedCityByItem({});
      // 스크롤 리셋
      setVisibleCount(200);
      queueMicrotask(() => listRef.current?.scrollTo({ top: 0 }));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  // 가격 스캔
  const handleScan = async () => {
    if (!recipes.length) {
      setError("먼저 레시피를 불러오세요.");
      return;
    }
    setScanning(true);
    setError(null);

    const ac = new AbortController();
    try {
      // 1) 질의 ID 모으기
      const productIds = recipes.map((r) => r.itemId);
      const matSet = new Set<string>();
      recipes.forEach((r) => r.materials.forEach((m) => matSet.add(m.itemId)));

      // 결정체 키(대체 가능성)도 함께 질의
      const crystalKeys = new Set<string>();
      for (const r of recipes) {
        const aType = (arteMap[r.core.toUpperCase()] ?? "Standard") as ArteType;
        const key = CRYSTALLIZED_FOR[aType as keyof typeof CRYSTALLIZED_FOR];
        if (key) crystalKeys.add(key);
      }

      const allIds = [...productIds, ...Array.from(matSet), ...Array.from(crystalKeys)];

      // 2) 가격 조회 (품질 필터 반영)
      const { prices, picked } = await fetchPricesBulk(server, city, allIds, {
        signal: ac.signal,
        // @ts-ignore - 확장 인자(내가 준 price_feed 확장판 기준)
        qualities,
      });

      // 3) 행 재계산
      const next: RowBase[] = recipes.map((recipe) => {
        const parsed = parseItemId(recipe.itemId);
        if (!parsed) {
          return {
            id: recipe.itemId,
            tier: `T${recipe.tier}${recipe.enchant ? `@${recipe.enchant}` : ""}`,
            city,
            productPrice: 0,
            materialCost: 0,
            usageFee: 0,
            requiresArtefact: recipe.requiresArtefact,
            arteType: "Standard",
            arteSub: undefined,
            missingMaterials: [recipe.itemId],
          };
        }

        const meta = classifyMeta(parsed.core, parsed.slot);
        const arteType = (arteMap[recipe.core.toUpperCase()] ?? "Standard") as ArteType;
        const itemValue = computeItemValue(parsed.tier, parsed.enchant, meta.numItems, arteType, meta.isShapeshifter);
        const usageFee = Math.round(computeUsageFee(itemValue, stationFeePer100));

        let materialCost = 0;
        let arteSub: { used: boolean; via: string } | undefined;
        const missing: string[] = [];

        for (const m of recipe.materials) {
          if (m.kind === "resource") {
            const unit = prices[m.itemId] ?? 0;
            if (unit <= 0) missing.push(m.itemId);
            materialCost += unit * m.quantity;
          } else {
            // === 아티팩트 ===
            const artePrice = prices[m.itemId] ?? 0;                   // 원 아티 가격
            const cKey = CRYSTALLIZED_FOR[arteType as keyof typeof CRYSTALLIZED_FOR];
            const crystalPrice = cKey ? (prices[cKey] ?? 0) : 0;        // 결정체 가격

            // 아티 가격이 없으면 → 미확보 표시(요청사항)
            if (artePrice <= 0) {
              if (!missing.includes(m.itemId)) missing.push(m.itemId);
            }

            // 비용은 "사용 가능한 것"으로 잡기 (아티 >0 vs 결정체 >0 비교)
            let chosen = artePrice;
            if (cKey && crystalPrice > 0 && (artePrice <= 0 || crystalPrice < artePrice)) {
              chosen = crystalPrice;
              arteSub = { used: true, via: cKey };
            }
            materialCost += Math.max(0, chosen);
          }
        }

        const productPrice = prices[recipe.itemId] ?? 0;

        return {
          id: recipe.itemId,
          tier: `T${recipe.tier}${recipe.enchant ? `@${recipe.enchant}` : ""}`,
          city,
          productPrice,
          materialCost,
          usageFee,
          requiresArtefact: recipe.requiresArtefact,
          arteType,
          arteSub,
          missingMaterials: missing,
        };
      });

      const usedMap: Record<string, string | null> = {};
      for (const id of productIds) usedMap[id] = picked[id]?.cityUsed ?? null;

      setRows(next);
      setPickedCityByItem(usedMap);

      // 스크롤 리셋(사용자 혼란 최소화)
      setVisibleCount(200);
      queueMicrotask(() => listRef.current?.scrollTo({ top: 0 }));
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message ?? String(e));
    } finally {
      setScanning(false);
    }
  };

  // 서버/도시 바뀌면 캐시 무효화
  useEffect(() => {
    invalidatePriceCache((k) => k.startsWith(`${server}|${city}|`));
  }, [server, city]);

  // 파생 테이블
  const derived: RowDerived[] = useMemo(() => {
    return rows.map((r) => {
      const materialCostAfterReturn = Math.max(0, Math.round(r.materialCost * (1 - returnRate / 100)));
      const sales = (saleTaxPct / 100) * r.productPrice;
      const listing = (listingPct / 100) * r.productPrice;
      const tome = r.id.includes("BAG") ? tomePrice : 0; // (필요시 유지)
      const netRevenue = r.productPrice - sales - listing;
      const totalCost = materialCostAfterReturn + r.usageFee + tome;
      const netProfit = Math.round(netRevenue - totalCost);
      const roiPct = r.productPrice ? (netProfit / r.productPrice) * 100 : 0;

      // 미확보 또는 재료비 0이면 incomplete
      let status: RowStatus =
        r.missingMaterials.length > 0 || r.materialCost <= 0 ? "incomplete" : netProfit >= 0 ? "profit" : "loss";

      return { ...r, materialCostAfterReturn, netProfit, roiPct, status };
    });
  }, [rows, returnRate, saleTaxPct, listingPct, tomePrice]);

  // 필터/정렬/검색
  const filtered = useMemo(() => {
    let out = derived;

    // 수익만 보기 → profit만
    if (showProfitOnly) {
      out = out.filter((r) => r.status === "profit");
    } else {
      // profit only가 꺼져 있을 때, 미확보 포함 체크
      if (!showIncomplete) {
        out = out.filter((r) => r.status !== "incomplete");
      }
    }

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((r) => r.id.toLowerCase().includes(q));
    }

    out = [...out].sort((a, b) => {
      const va = a[sortKey] as number | string;
      const vb = b[sortKey] as number | string;
      if (typeof va === "number" && typeof vb === "number") return sortDir === "asc" ? va - vb : vb - va;
      if (sortKey === "status") return String(va).localeCompare(String(vb));
      return 0;
    });

    return out;
  }, [derived, showProfitOnly, showIncomplete, sortKey, sortDir, query]);

  // 무한 스크롤: 바닥 근처에서 visibleCount 증가
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_GAP) {
        setVisibleCount((v) => (v < filtered.length ? Math.min(filtered.length, v + PAGE) : v));
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [filtered.length]);

  // 필터/정렬/검색 변경 시 스크롤/개수 리셋
  useEffect(() => {
    setVisibleCount(200);
    queueMicrotask(() => listRef.current?.scrollTo({ top: 0 }));
  }, [showProfitOnly, showIncomplete, sortKey, sortDir, query]);

  // 표시할 조각
  const slice = filtered.slice(0, visibleCount);

  const toggleSort = (key: keyof RowDerived) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const qualityToggled = (q: number) => {
    setQualities((prev) => {
      const has = prev.includes(q);
      const next = has ? prev.filter((x) => x !== q) : [...prev, q].sort();
      return next.length ? next : [1]; // 최소 한 개는 유지
    });
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
          <div className="flex items-center gap-3 text-xs text-slate-300">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Connected
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4">
        {/* Controls */}
        <section className="rounded-2xl bg-white/5 backdrop-blur border border-white/10 shadow-lg p-4 md:p-5 mb-4">
          <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
            <SelectField label="서버" value={server} onChange={(v) => setServer(v as Server)} options={["Local", "East", "West", "Europe"]} />
            <SelectField label="도시" value={city} onChange={(v) => setCity(v)} options={CITY_OPTIONS[server]} />
            <NumberField label="판매세 %" value={saleTaxPct} onChange={setSaleTaxPct} step={0.1} />
            <NumberField label="리스팅 %" value={listingPct} onChange={setListingPct} step={0.1} />
            <NumberField label="반환률 %" value={returnRate} onChange={setReturnRate} step={1} />
            <NumberField label="제작소 수수료/100" value={stationFeePer100} onChange={setStationFeePer100} step={10} />
            <NumberField label="Tome 가격" value={tomePrice} onChange={setTomePrice} step={1000} />

            {/* 품질 필터 */}
            <div className="col-span-full flex flex-wrap items-center gap-3 mt-1">
              <span className="text-sm text-slate-300">품질:</span>
              {[1, 2, 3, 4, 5].map((q) => (
                <label key={q} className="inline-flex items-center gap-1 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    className="size-4 accent-amber-500"
                    checked={qualities.includes(q)}
                    onChange={() => qualityToggled(q)}
                  />
                  Q{q}
                </label>
              ))}
              <span className="text-xs text-slate-400">(* 변경 시 캐시 무효화 후 스캔에 반영)</span>
            </div>

            <div className="flex items-end gap-2">
              <button onClick={handleReloadRecipes} className="px-3 py-2 rounded-xl bg-amber-600 text-white text-sm shadow hover:bg-amber-500" disabled={loading}>
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
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-300 select-none cursor-pointer">
                <input type="checkbox" className="size-4 accent-amber-500" checked={showProfitOnly} onChange={(e) => setShowProfitOnly(e.target.checked)} />
                수익만 보기
              </label>
              {!showProfitOnly && (
                <label className="inline-flex items-center gap-2 text-sm text-slate-300 select-none cursor-pointer">
                  <input type="checkbox" className="size-4 accent-amber-500" checked={showIncomplete} onChange={(e) => setShowIncomplete(e.target.checked)} />
                  미확보 포함(회색)
                </label>
              )}
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
              {recipes.length}개 레시피 로드됨 | {filtered.length}개 중 {slice.length}개 표시중
            </div>
          </div>
          {error && <p className="mt-2 text-sm text-rose-300">오류: {error}</p>}
        </section>

        {/* Table + Infinite scroll container */}
        <section className="rounded-2xl overflow-hidden bg-white/5 backdrop-blur border border-white/10 shadow-xl">
          <div ref={listRef} className="max-h-[70vh] overflow-auto">
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
                {slice.map((r) => {
                  const usedCity = pickedCityByItem[r.id] ?? null;
                  const usedFallback = usedCity && usedCity !== city;
                  const isIncomplete = r.status === "incomplete";

                  return (
                    <tr key={r.id} className={`border-t border-white/10 ${isIncomplete ? "opacity-60" : ""}`}>
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
                        {r.missingMaterials.length > 0 && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-slate-500/20 text-slate-200 px-2 py-0.5 text-[11px]"
                            title={`미확보 재료: ${r.missingMaterials.slice(0, 6).join(", ")}${r.missingMaterials.length > 6 ? " …" : ""}`}
                          >
                            미확보 {r.missingMaterials.length}
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
                        {r.status === "profit" && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 px-2 py-1 text-xs">수익</span>}
                        {r.status === "loss" && <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 text-rose-300 px-2 py-1 text-xs">손실</span>}
                        {r.status === "incomplete" && <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/20 text-slate-200 px-2 py-1 text-xs">미확보</span>}
                      </td>
                    </tr>
                  );
                })}

                {/* 바닥 안내 */}
                <tr className="border-t border-white/10">
                  <td colSpan={8} className="px-3 py-3 text-center text-slate-400">
                    {slice.length < filtered.length ? "아래로 스크롤하면 더 보기…" : "모든 결과를 표시했습니다"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <p className="text-xs text-slate-400 mt-3">
          * 제작소 수수료는 ItemValue × 0.1125 × (수수료/100) 공식으로 계산됩니다. 품질(Q1~Q5) 필터는 스캔 시점의 가격 질의에 반영됩니다.
        </p>
      </main>
    </div>
  );
}

// ---------- UI bits ----------
function Th({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <th className="px-3 py-2 font-medium select-none cursor-pointer" onClick={onClick}>
      {label}
    </th>
  );
}

function SelectField({ label, value, onChange, options }: { label: React.ReactNode; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="text-sm">
      <div className="text-slate-300 mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 pr-7 text-sm outline-none focus:ring-2 focus:ring-amber-500 scheme-dark text-slate-100"
      >
        {options.map((o) => (
          <option key={o} value={o} className="text-slate-900">
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({ label, value, onChange, step = 1 }: { label: React.ReactNode; value: number; onChange: (v: number) => void; step?: number }) {
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
