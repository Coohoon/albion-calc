// FORCE RELOAD v4 (quality filter auto-rescan)
// frontend/src/components/AlbionCraftingCalculator.tsx

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
  materialCost: number;
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

const nf = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString();

const CITY_OPTIONS: Record<Server, string[]> = {
  East: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  West: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Europe: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Local: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
};

const CRYSTALLIZED_FOR: Record<Exclude<ArteType, "Standard" | "Mist" | "Crystal">, string> = {
  Rune: "RUNE",
  Soul: "SOUL",
  Relic: "RELIC",
  Avalonian: "AVALONIAN_ENERGY",
};

// ───────────────────────── CSV → 레시피 파싱 ─────────────────────────
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
    const materials: MaterialRequirement[] = [];
    const { tier, slot, enchant } = parsed;
    const suff = enchant > 0 ? `@${enchant}` : "";

    if (slot === "BAG" || slot === "CAPE") {
      materials.push({ itemId: `T${tier}_CLOTH${suff}`, quantity: 8, kind: "resource" });
      materials.push({ itemId: `T${tier}_LEATHER${suff}`, quantity: 8, kind: "resource" });
    } else if (slot === "OFF") {
      materials.push({ itemId: `T${tier}_PLANKS${suff}`, quantity: 8, kind: "resource" });
      materials.push({ itemId: `T${tier}_METALBAR${suff}`, quantity: 8, kind: "resource" });
    } else if (slot === "MAIN") {
      materials.push({ itemId: `T${tier}_METALBAR${suff}`, quantity: 16, kind: "resource" });
      materials.push({ itemId: `T${tier}_LEATHER${suff}`, quantity: 8, kind: "resource" });
    } else if (slot === "2H") {
      materials.push({ itemId: `T${tier}_METALBAR${suff}`, quantity: 20, kind: "resource" });
      materials.push({ itemId: `T${tier}_LEATHER${suff}`, quantity: 12, kind: "resource" });
    } else if (["HEAD", "ARMOR", "SHOES"].includes(slot)) {
      materials.push({ itemId: `T${tier}_CLOTH${suff}`, quantity: 16, kind: "resource" });
      materials.push({ itemId: `T${tier}_LEATHER${suff}`, quantity: 8, kind: "resource" });
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

// ───────────────────────── ArteMap 로드 ─────────────────────────
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

export default function AlbionCraftingCalculator() {
  // ---------- Controls ----------
  const [server, setServer] = useState<Server>("East");
  const [city, setCity] = useState("Lymhurst");
  const [saleTaxPct, setSaleTaxPct] = useState(6.5);
  const [listingPct, setListingPct] = useState(1.5);
  const [returnRate, setReturnRate] = useState(24);
  const [stationFeePer100, setStationFeePer100] = useState(200);
  const [tomePrice, setTomePrice] = useState(120_000);
  const [showProfitOnly, setShowProfitOnly] = useState(true);
  const [sortKey, setSortKey] = useState<keyof RowDerived>("netProfit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");

  // ✅ 품질 필터: 1~5 중 선택 (기본: 1~4만 허용, 걸작 5 제외)
  const [allowedQualities, setAllowedQualities] = useState<number[]>([1, 2, 3, 4]);

  // ---------- Data ----------
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [rows, setRows] = useState<RowBase[]>([]);
  const [pickedCityByItem, setPickedCityByItem] = useState<Record<string, string | null>>({});
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [arteMap, setArteMap] = useState<Record<string, ArteType>>({});

  // 내부: 자동 재스캔 디바운스 타이머
  const rescanTimerRef = useRef<number | null>(null);

  // ArteMap 로드
  useEffect(() => {
    loadArteMap().then(setArteMap);
  }, []);

  // 레시피 로드
  const handleReloadRecipes = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/data/aodp_parsed_items.csv", { cache: "no-store" });
      if (!r.ok) throw new Error("레시피 파일을 불러올 수 없습니다");

      const txt = await r.text();
      const parsed = parseRecipeCSV(txt);
      if (parsed.length === 0) {
        throw new Error("파싱된 레시피가 없습니다. CSV 형식을 확인하세요.");
      }

      setRecipes(parsed);

      const initialRows: RowBase[] = parsed.slice(0, 200).map((rec) => {
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
        };
      });

      setRows(initialRows);
      setPickedCityByItem({});
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  // 스캔 시작
  const handleScan = async () => {
    if (!recipes.length) {
      setError("먼저 레시피를 불러오세요");
      return;
    }

    setScanning(true);
    setError(null);
    const ac = new AbortController();

    try {
      // 모든 아이템 ID 수집 (데모로 100개 한정)
      const productIds = recipes.slice(0, 100).map((r) => r.itemId);
      const materialIds = new Set<string>();
      recipes.slice(0, 100).forEach((r) => {
        r.materials.forEach((m) => materialIds.add(m.itemId));
      });

      const allIds = [...productIds, ...Array.from(materialIds), "RUNE", "SOUL", "RELIC", "AVALONIAN_ENERGY"];

      // ✅ 품질 필터 반영하여 가격 조회
      const { prices, picked } = await fetchPricesBulk(server, city, allIds, {
        signal: ac.signal,
        qualities: allowedQualities,
      });

      // 행 계산
      const nextRows: RowBase[] = recipes.slice(0, 100).map((recipe) => {
        const parsed = parseItemId(recipe.itemId);
        if (!parsed) return null;

        const meta = classifyMeta(parsed.core, parsed.slot);
        const arteType = (arteMap[recipe.core.toUpperCase()] ?? "Standard") as ArteType;
        const itemValue = computeItemValue(parsed.tier, parsed.enchant, meta.numItems, arteType, meta.isShapeshifter);
        const usageFee = Math.round(computeUsageFee(itemValue, stationFeePer100));

        // 재료비 계산(품질 필터 적용된 prices 사용)
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
      }).filter((r) => r !== null) as RowBase[];

      const usedMap: Record<string, string | null> = {};
      for (const id of productIds) {
        usedMap[id] = picked[id]?.cityUsed ?? null;
      }

      setRows(nextRows);
      setPickedCityByItem(usedMap);
    } catch (e: any) {
      if ((e as any)?.name !== "AbortError") {
        setError(e?.message ?? String(e));
      }
    } finally {
      setScanning(false);
    }
  };

  // 서버/도시/품질 변경 시: 관련 캐시 무효화 + 자동 재스캔 (디바운스)
  useEffect(() => {
    // 캐시: 현재 조합 키만 부분 무효화(동일 조합이면 최신 조회를 강제)
    const qKey = (arr: number[]) => arr.join(",");
    invalidatePriceCache((k) => k.startsWith(`${server}|${city}|q=${qKey(allowedQualities)}`));

    // 디바운스 재스캔
    if (!recipes.length) return;
    if (scanning || loading) return;

    // 기존 타이머 제거
    if (rescanTimerRef.current) {
      window.clearTimeout(rescanTimerRef.current);
    }
    // 300ms 뒤 자동 재스캔
    rescanTimerRef.current = window.setTimeout(() => {
      handleScan();
    }, 300);

    return () => {
      if (rescanTimerRef.current) {
        window.clearTimeout(rescanTimerRef.current);
        rescanTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, city, allowedQualities.join(","), recipes.length]);

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

  const toggleSort = (key: keyof RowDerived) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const toggleQuality = (q: number) => {
    setAllowedQualities((prev) => {
      const has = prev.includes(q);
      const next = has ? prev.filter((x) => x !== q) : [...prev, q].sort((a, b) => a - b);
      return next.length ? next : prev; // 최소 1개 유지
    });
  };

  const qualityLabel = (q: number) =>
    ({ 1: "보통(1)", 2: "좋음(2)", 3: "훌륭(3)", 4: "탁월(4)", 5: "걸작(5)" } as Record<number, string>)[q] ?? String(q);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-slate-100">
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
              options={["East", "West", "Europe", "Local"]}
            />
            <SelectField label="도시" value={city} onChange={(v) => setCity(v)} options={CITY_OPTIONS[server]} />

            <NumberField label="판매세 %" value={saleTaxPct} onChange={setSaleTaxPct} step={0.1} />
            <NumberField label="리스팅 %" value={listingPct} onChange={setListingPct} step={0.1} />
            <NumberField label="반환률 %" value={returnRate} onChange={setReturnRate} step={1} />
            <NumberField label="제작소 수수료/100" value={stationFeePer100} onChange={setStationFeePer100} step={10} />
            <NumberField label="Tome 가격" value={tomePrice} onChange={setTomePrice} step={1000} />

            {/* ✅ 품질 필터 */}
            <div className="md:col-span-2">
              <label className="text-sm block">
                <div className="text-slate-300 mb-1">품질(여러 개 선택)</div>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5].map((q) => {
                    const active = allowedQualities.includes(q);
                    return (
                      <button
                        key={q}
                        type="button"
                        onClick={() => toggleQuality(q)}
                        className={`px-2.5 py-1 rounded-lg text-xs border transition ${
                          active
                            ? "bg-amber-500/20 border-amber-400/60 text-amber-200"
                            : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                        }`}
                        title="클릭으로 토글"
                      >
                        {qualityLabel(q)}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  기본값은 1–4(걸작 제외). 걸작(5)을 포함하면 고가에 왜곡될 수 있어요.
                </p>
              </label>
            </div>

            <div className="flex items-end gap-2">
              <button
                onClick={handleReloadRecipes}
                className="px-3 py-2 rounded-xl bg-amber-600 text-white text-sm shadow hover:bg-amber-500"
                disabled={loading}
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
              {recipes.length}개 레시피 로드됨 | {filtered.length}개 표시중
              {scanning && <span className="ml-2 text-amber-300">· 스캔 중…</span>}
            </div>
          </div>
          {error && <p className="mt-2 text-sm text-rose-300">오류: {error}</p>}
        </section>

        {/* Table */}
        <section className="rounded-2xl overflow-hidden bg-white/5 backdrop-blur border border-white/10 shadow-xl">
          <div className="overflow-auto">
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
                {filtered.map((r) => {
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
          </div>
        </section>

        <p className="text-xs text-slate-400 mt-3">* 제작소 수수료 = ItemValue × 0.1125 × (수수료/100)</p>
      </main>
    </div>
  );
}

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
  return (
    <label className="text-sm">
      <div className="text-slate-300 mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="scheme-dark w-full appearance-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 pr-7 text-sm outline-none focus:ring-2 focus:ring-amber-500"
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
