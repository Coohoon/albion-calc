import { useEffect, useState } from "react";
import { scanProfit, type ProfitRow, type ScanResult } from "../utils/profit_scan";
import type { Recipe } from "../utils/csv_to_recipes";
import type { PickedPriceMap } from "../utils/price_feed";

export function useProfitScan(recipes: Recipe[], cfg: any) {
  const [rows, setRows] = useState<ProfitRow[]>([]);
  const [picked, setPicked] = useState<PickedPriceMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res: ScanResult = await scanProfit(recipes, cfg); // ✅ 항상 객체
        if (!alive) return;
        setRows(res.rows);
        setPicked(res.picked);
      } catch (e: any) {
        if (alive) setError(e?.message ?? String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  // recipes/cfg가 객체라서 안정적으로 트리거하려면 JSON.stringify 사용
  }, [JSON.stringify(recipes), JSON.stringify(cfg)]);

  return { rows, picked, loading, error };
}
