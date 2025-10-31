import { useState, useEffect } from "react";
import { scanProfit } from "../utils/profit_scan"; // 별칭 안 쓰면 상대경로로

import type { Recipe } from "../utils/csv_to_recipes";

export function useProfitScan(recipes: Recipe[], cfg: any) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await scanProfit(recipes, cfg);
        if (alive) setRows(res);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [JSON.stringify(recipes), JSON.stringify(cfg)]);

  return { rows, loading };
}
