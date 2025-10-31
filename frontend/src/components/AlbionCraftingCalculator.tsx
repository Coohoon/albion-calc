import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, Calculator, Filter, TrendingUp, TrendingDown } from "lucide-react";
import { parseAodpCsvToRecipes, type Recipe } from "../utils/csv_to_recipes";
import { useProfitScan } from "../hooks/useProfitScan";

const AlbionCraftingCalculator: React.FC = () => {
  const [server, setServer] = useState<"West" | "East" | "Europe">("West");
  const [city, setCity] = useState<string>("Martlock");
  const [saleTaxPct, setSaleTaxPct] = useState<number>(6.5);
  const [listingPct, setListingPct] = useState<number>(1.5);
  const [returnRatePct, setReturnRatePct] = useState<number>(15.2);
  const [stationFeePer100, setStationFeePer100] = useState<number>(200);
  const [tomePrice, setTomePrice] = useState<number>(0);
  const [onlyProfit, setOnlyProfit] = useState<boolean>(true);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loadingCsv, setLoadingCsv] = useState<boolean>(false);
  const [csvError, setCsvError] = useState<string | null>(null);

  const loadCsv = async () => {
    try {
      setLoadingCsv(true);
      setCsvError(null);
      const res = await fetch("/data/aodp_parsed_items.csv", { cache: "no-store" });
      if (!res.ok) throw new Error(`CSV 로드 실패 (${res.status})`);
      const text = await res.text();
      const parsed = parseAodpCsvToRecipes(text);
      setRecipes(parsed);
    } catch (err: any) {
      setCsvError(err?.message ?? "CSV 로드 중 오류 발생");
      setRecipes([]);
    } finally {
      setLoadingCsv(false);
    }
  };

  useEffect(() => { loadCsv(); }, []);

  const cfg = useMemo(() => ({
    server, city, saleTaxPct, listingPct, returnRatePct, stationFeePer100, tomePrice
  }), [server, city, saleTaxPct, listingPct, returnRatePct, stationFeePer100, tomePrice]);

  const { rows, loading } = useProfitScan(recipes, cfg);
  const visibleRows = useMemo(() => (onlyProfit ? rows.filter(r => r.profit > 0) : rows), [rows, onlyProfit]);

  const servers: Array<"West" | "East" | "Europe"> = ["West", "East", "Europe"];
  const cities = ["Martlock", "Bridgewatch", "Lymhurst", "Fort Sterling", "Thetford", "Caerleon", "Brecilien"];

  const totalCount = rows.length;
  const profitCount = rows.filter((r) => r.profit > 0).length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-6 text-slate-100">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* 헤더 */}
        <div className="flex items-center gap-3">
          <Calculator className="w-8 h-8 text-amber-400" />
          <h1 className="text-3xl font-bold text-amber-400">알비온 제작 수익 계산기</h1>
        </div>

        {/* 설정 패널 */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div className="col-span-2">
              <label className="block text-sm text-slate-300 mb-1">서버</label>
              <select
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded"
                value={server}
                onChange={(e) => setServer(e.target.value as any)}
              >
                {servers.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-300 mb-1">도시</label>
              <select
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              >
                {cities.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2 flex items-end">
              <button
                onClick={loadCsv}
                className="w-full px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold rounded flex items-center justify-center gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${loadingCsv ? "animate-spin" : ""}`} />
                레시피 다시 불러오기
              </button>
            </div>
          </div>

          <div className="mt-3 text-sm text-slate-400">
            레시피: {recipes.length.toLocaleString()}개 · 결과: {totalCount.toLocaleString()}개 (수익 {profitCount.toLocaleString()}개)
          </div>
          {(loading || loadingCsv) && (
            <div className="mt-2 text-amber-300 text-sm">계산 중입니다… 가격·레시피를 불러오는 중입니다.</div>
          )}
          {csvError && <div className="mt-2 text-red-400 text-sm">CSV 오류: {csvError}</div>}
        </div>

        {/* 결과 테이블 */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
            <h2 className="text-xl font-semibold">수익성 리스트</h2>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={onlyProfit} onChange={(e) => setOnlyProfit(e.target.checked)} />
              <Filter className="w-4 h-4" /> 수익만 보기
            </label>
          </div>

          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr className="text-left text-slate-300">
                  <th className="px-4 py-3">아이템ID</th>
                  <th className="px-4 py-3 text-right">완제품가</th>
                  <th className="px-4 py-3 text-right">재료비(반환후)</th>
                  <th className="px-4 py-3 text-right">제작소 수수료</th>
                  <th className="px-4 py-3 text-right">순이익</th>
                  <th className="px-4 py-3 text-right">수익률</th>
                  <th className="px-4 py-3">상태</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.slice(0, 300).map((r) => {
                  const positive = r.profit > 0;
                  return (
                    <tr key={r.itemId} className="border-t border-slate-700 hover:bg-slate-800/50">
                      <td className="px-4 py-2 font-mono">{r.itemId}</td>
                      <td className="px-4 py-2 text-right">{r.productPrice.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{r.effectiveMaterialCost.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{r.usageFee.toLocaleString()}</td>
                      <td className={`px-4 py-2 text-right font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
                        {Math.round(r.profit).toLocaleString()}
                      </td>
                      <td className={`px-4 py-2 text-right ${positive ? "text-emerald-300" : "text-red-300"}`}>
                        {r.profitMargin.toFixed(2)}%
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded ${
                            positive ? "bg-emerald-900/40 text-emerald-300" : "bg-red-900/30 text-red-300"
                          }`}
                        >
                          {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {positive ? "수익" : "손실"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {visibleRows.length === 0 && !loading && (
                  <tr>
                    <td className="px-4 py-6 text-slate-400 text-center" colSpan={7}>
                      표시할 결과가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AlbionCraftingCalculator;
