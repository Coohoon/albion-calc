import React, { useMemo, useState } from "react";
import { fetchPricesBulk, type ServerKey } from "../utils/price_feed";

/**
 * AlbionCraftingCalculator (real hook-in ready)
 * - Controls: server/city/taxes/listing/returnRate/station fee/Tome price
 * - "스캔 시작" 시 price_feed.fetchPricesBulk 호출하여 완제품 가격 갱신
 * - 반환률/세금/수수료 변경 시 테이블 즉시 재계산
 * - 아티팩트→결정체 대체 배지(데모 필드), 도시 대체 사용 배지(실데이터)
 */

// ---------- Types ----------
// price_feed의 서버 키와 동일하게 사용
export type Server = ServerKey; // "East" | "West" | "Europe" | "Local"

interface RowBase {
  id: string;
  tier: string; // e.g., T6@2
  city: string;
  productPrice: number; // 완제품가(스캔으로 갱신)
  baseMaterialCost: number; // BEFORE return rate (레시피 원가 합)
  baseUsageFee: number; // baseline usage fee, scaled by stationFeePer100
  arteSub?: { used: boolean; via: string }; // crystal id when substituted (도메인 로직 연결 예정)
}

interface RowDerived extends RowBase {
  materialCostAfterReturn: number;
  usageFee: number;
  netProfit: number;
  roiPct: number; // percent
  status: "profit" | "loss";
}

// ---------- Demo seed rows (레시피 연결 전 임시) ----------
const SEED_ROWS: RowBase[] = [
  { id: "T6_2H_FIRESTAFF_HELL@2", tier: "T6@2", city: "Lymhurst", productPrice: 1_480_000, baseMaterialCost: 1_340_000, baseUsageFee: 65_000, arteSub: { used: true, via: "CRYSTALLIZED_MAGIC" } },
  { id: "T7_MAIN_DAGGER@3", tier: "T7@3", city: "Bridgewatch", productPrice: 3_250_000, baseMaterialCost: 3_050_000, baseUsageFee: 120_000, arteSub: { used: false, via: "" } },
  { id: "T5_BAG@0", tier: "T5", city: "Martlock", productPrice: 240_000, baseMaterialCost: 205_000, baseUsageFee: 12_000, arteSub: { used: false, via: "" } },
  { id: "T8_CAPE@1", tier: "T8@1", city: "Thetford", productPrice: 1_950_000, baseMaterialCost: 1_880_000, baseUsageFee: 140_000, arteSub: { used: true, via: "CRYSTALLIZED_MAGIC" } },
  { id: "T6_OFF_TORCH@2", tier: "T6@2", city: "Fort Sterling", productPrice: 580_000, baseMaterialCost: 520_000, baseUsageFee: 22_000, arteSub: { used: false, via: "" } },
];

// util: number formatting
const nf = (n: number) => n.toLocaleString();

// City options per server (Local도 동일 세트 사용; 필요 시 빈 배열 처리 가능)
const CITY_OPTIONS: Record<Server, string[]> = {
  East: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  West: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Europe: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
  Local: ["Lymhurst", "Bridgewatch", "Martlock", "Thetford", "Fort Sterling", "Caerleon"],
};

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

  // ---------- Data ----------
  const [rows, setRows] = useState<RowBase[]>(SEED_ROWS);
  const [pickedCityByItem, setPickedCityByItem] = useState<Record<string, string | null>>({}); // price_feed가 실제로 어떤 도시 값을 썼는지
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------- Actions ----------
  const handleReloadRecipes = async () => {
    // 실제 구현 시: csv_to_recipes.ts 로드 → setRows(...) 로 교체
    setRows(SEED_ROWS);
    setPickedCityByItem({});
  };

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const itemIds = rows.map((r) => r.id);
      const { prices, picked } = await fetchPricesBulk(server, city, itemIds);

      // 완제품가를 최신 가격으로 갱신 + 어떤 도시를 썼는지 기록
      const next = rows.map((r) => ({
        ...r,
        productPrice: prices[r.id] ?? r.productPrice,
      }));
      const usedMap: Record<string, string | null> = {};
      for (const id of itemIds) usedMap[id] = picked[id]?.cityUsed ?? null;

      setRows(next);
      setPickedCityByItem(usedMap);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setScanning(false);
    }
  };

  // ---------- Derive rows based on controls ----------
  const derived: RowDerived[] = useMemo(() => {
    return rows.map((r) => {
      const materialCostAfterReturn = Math.max(0, Math.round(r.baseMaterialCost * (1 - returnRate / 100)));
      const usageFee = Math.round(r.baseUsageFee * (stationFeePer100 / 200));
      const sales = (saleTaxPct / 100) * r.productPrice; // 판매세
      const listing = (listingPct / 100) * r.productPrice; // 리스팅
      const tome = r.id.includes("BAG") ? tomePrice : 0;
      const totalCost = materialCostAfterReturn + usageFee + tome;
      const netRevenue = r.productPrice - sales - listing;
      const netProfit = Math.round(netRevenue - totalCost);
      const roiPct = (netProfit / r.productPrice) * 100;
      const status: RowDerived["status"] = netProfit >= 0 ? "profit" : "loss";
      return { ...r, materialCostAfterReturn, usageFee, netProfit, roiPct, status };
    });
  }, [rows, returnRate, stationFeePer100, saleTaxPct, listingPct, tomePrice]);

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

  return (
    <div className="min-h-screen bg-linear-to-b from-[#0b1621] to-[#0f2236] text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-10 backdrop-blur bg-white/5 border-b border-white/10">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-2xl bg-linear-to-br from-amber-400 to-orange-600 shadow" />
            <div className="font-semibold">Albion Crafting Profit Calculator</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Connected
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4">
        {/* Controls Card */}
        <section className="rounded-2xl bg-white/5 backdrop-blur border border-white/10 shadow-lg p-4 md:p-5 mb-4">
          <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-6">
            <SelectField label="서버" value={server} onChange={(v) => setServer(v as Server)} options={["East", "West", "Europe", "Local"]} />
            <SelectField label="도시" value={city} onChange={(v) => setCity(v)} options={CITY_OPTIONS[server]} />
            <NumberField label={<LabelWithInfo text="판매세 %" info="판매 완료 시 차감되는 수수료. 판매가 × 판매세%" />} value={saleTaxPct} onChange={setSaleTaxPct} step={0.1} />
            <NumberField label={<LabelWithInfo text="리스팅 %" info="주문 등록 시 선지불하는 수수료. 등록가 × 리스팅% (거래 성사 여부 무관)" />} value={listingPct} onChange={setListingPct} step={0.1} />
            <NumberField label={<LabelWithInfo text="반환률 %" info="제작 시 반환되는 자원 비율" />} value={returnRate} onChange={setReturnRate} step={1} />
            <NumberField label={<LabelWithInfo text="제작소 수수료/100" info="ItemValue × 0.1125 × (수수료/100)" />} value={stationFeePer100} onChange={setStationFeePer100} step={10} />
            <NumberField label={<LabelWithInfo text="Tome 가격" info="통찰 가방 제작 시 필요한 Tome 1권의 가격" />} value={tomePrice} onChange={setTomePrice} step={1000} />
            <div className="flex items-end gap-2">
              <button onClick={handleReloadRecipes} className="px-3 py-2 rounded-xl bg-amber-600 text-white text-sm shadow hover:bg-amber-500" disabled={scanning}>
                레시피 다시 불러오기
              </button>
              <button onClick={handleScan} className="px-3 py-2 rounded-xl bg-cyan-600 text-white text-sm shadow hover:bg-cyan-500 disabled:opacity-60" disabled={scanning}>
                {scanning ? "스캔 중..." : "스캔 시작"}
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-2 text-sm text-slate-300 select-none cursor-pointer">
                <input type="checkbox" className="size-4 accent-amber-500" checked={showProfitOnly} onChange={(e) => setShowProfitOnly(e.target.checked)} />
                수익만 보기
              </label>
              <div className="relative">
                <span className="absolute left-2 top-2 text-slate-400">🔎</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="아이템 ID 검색 (예: T6_OFF_TORCH)"
                  className="pl-8 pr-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
            </div>
            <div className="text-xs text-slate-300">
              정렬: <strong>{labelOfKey(sortKey)}</strong> {sortDir === "desc" ? "↓" : "↑"}
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
                  <Th label="도시" onClick={() => toggleSort("city")} />
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
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-cyan-500/20 text-cyan-200 px-2 py-0.5 text-[11px] align-middle"
                            title={`아티팩트 → ${r.arteSub.via} 대체`}
                          >
                            결정체 대체
                          </span>
                        )}
                        {usedFallback && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-indigo-500/20 text-indigo-200 px-2 py-0.5 text-[11px] align-middle"
                            title={`선호 도시(${city}) 가격이 0 → ${usedCity} 가격 사용`}
                          >
                            대체도시: {usedCity}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.tier}</td>
                      <td className="px-3 py-2">{r.city}</td>
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

        {/* Footnote */}
        <p className="text-xs text-slate-400 mt-3">
          * 스캔은 <code className="font-mono">price_feed.fetchPricesBulk</code> 를 통해 실제 API로 수행됩니다. 레시피 연동 전까지는 seed rows로 동작합니다.
        </p>
      </main>
    </div>
  );
}

// ---------- Small UI helpers ----------
function Th({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <th className="px-3 py-2 font-medium select-none cursor-pointer" onClick={onClick}>
      <div className="inline-flex items-center gap-1">{label}</div>
    </th>
  );
}

function labelOfKey(k: keyof RowDerived) {
  switch (k) {
    case "id":
      return "아이템";
    case "tier":
      return "티어";
    case "city":
      return "도시";
    case "productPrice":
      return "완제품가";
    case "materialCostAfterReturn":
      return "재료비(반환후)";
    case "usageFee":
      return "제작소 수수료";
    case "netProfit":
      return "순이익";
    case "roiPct":
      return "수익률";
    case "status":
      return "상태";
  }
}

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="relative inline-flex items-center group" tabIndex={0}>
      {children}
      <span
        className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 rounded-md bg-slate-900/90 text-slate-100 text-xs px-2 py-1 shadow-lg opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition border border-white/10 w-max max-w-[260px] z-20"
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}

function InfoBadge() {
  return (
    <span
      className="ml-1 inline-flex items-center justify-center rounded-full border border-white/20 text-[11px] leading-none w-4.5 h-4.5 text-slate-200 cursor-help select-none"
      aria-hidden="true"
    >
      i
    </span>
  );
}

function LabelWithInfo({ text, info }: { text: string; info: string }) {
  return (
    <Tooltip text={info}>
      <span className="inline-flex items-center">{text}<InfoBadge /></span>
    </Tooltip>
  );
}

function FieldShell({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="text-sm">
      <div className="text-slate-300 mb-1">{label}</div>
      <div className="relative">{children}</div>
    </label>
  );
}

function SelectField({ label, value, onChange, options }: { label: React.ReactNode; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <FieldShell label={label}>
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
    </FieldShell>
  );
}

function InputField({ label, value, onChange, placeholder }: { label: React.ReactNode; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <FieldShell label={label}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
      />
    </FieldShell>
  );
}

function NumberField({ label, value, onChange, step = 1 }: { label: React.ReactNode; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <FieldShell label={label}>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500"
      />
    </FieldShell>
  );
}
