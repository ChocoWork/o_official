// 減価償却の計算。国税庁 No.2100（減価償却のあらまし）/ No.2106（定額法と定率法）に準拠。
//
// 対応する償却方法:
//   straightLine  定額法。個人事業主の法定償却方法。
//                 各年の償却費 = 取得価額 × 定額法償却率。年の中途取得は使用月数/12。
//                 平成19年4月1日以後取得分は残存簿価1円まで償却する。
//   lumpSum3Year  一括償却資産（10万円以上20万円未満）。取得価額の1/3を3年間。月割しない。
//                 残存簿価は残さず全額を必要経費に算入する。
//   immediate     即時償却。10万円未満の少額資産、または青色申告者の
//                 中小企業者等の少額減価償却資産の特例（30万円未満・年300万円まで）。

export type DepreciationMethod =
  | "straightLine"
  | "lumpSum3Year"
  | "immediate";

export type FixedAsset = {
  id: number;
  name: string;
  /** 資産の勘定科目名（工具器具備品 / ソフトウェア 等） */
  account: string;
  acquiredOn: string;
  acquisitionCost: number;
  usefulLife: number;
  method: DepreciationMethod;
  /** 事業専用割合（%）。必要経費算入額の按分に使う。 */
  businessUseRatio: number;
  disposedOn: string | null;
  memo: string;
};

export const DEPRECIATION_METHOD_LABELS: Record<DepreciationMethod, string> = {
  straightLine: "定額法",
  lumpSum3Year: "一括償却（3年均等）",
  immediate: "即時償却",
};

/**
 * 定額法の償却率。
 * 国税庁の「減価償却資産の償却率表」の定額法償却率は 1/耐用年数 を
 * 小数第3位に切り上げた値と一致する（例 耐用年数6年 → 1/6=0.1666… → 0.167）。
 */
export function straightLineRate(usefulLife: number): number {
  if (usefulLife <= 0) return 0;
  return Math.ceil((1 / usefulLife) * 1000) / 1000;
}

function yearOf(date: string): number {
  return Number.parseInt(date.slice(0, 4), 10);
}

function monthOf(date: string): number {
  return Number.parseInt(date.slice(5, 7), 10);
}

/** 当年の事業供用月数。取得年は取得月から、除却年は除却月まで（暦月単位）。 */
function monthsInYear(asset: FixedAsset, fiscalYear: number): number {
  const acquiredYear = yearOf(asset.acquiredOn);
  const disposedYear = asset.disposedOn ? yearOf(asset.disposedOn) : null;

  if (fiscalYear < acquiredYear) return 0;
  if (disposedYear !== null && fiscalYear > disposedYear) return 0;

  const start = fiscalYear === acquiredYear ? monthOf(asset.acquiredOn) : 1;
  const end =
    disposedYear !== null && fiscalYear === disposedYear
      ? monthOf(asset.disposedOn as string)
      : 12;

  return Math.max(0, end - start + 1);
}

export type DepreciationForYear = {
  asset: FixedAsset;
  /** 期首帳簿価額 */
  openingBookValue: number;
  /** 当期の事業供用月数 */
  months: number;
  /** 当期償却費（按分前の全額） */
  depreciation: number;
  /** 必要経費算入額（事業専用割合を適用した額） */
  businessExpense: number;
  /** 家事使用分（事業主貸へ振り替える額） */
  privatePortion: number;
  /** 期末帳簿価額 */
  closingBookValue: number;
  /** 期末減価償却累計額 */
  accumulated: number;
  /** 償却が終わる年か（残存簿価に到達） */
  isFinalYear: boolean;
};

/** 償却率・取得価額から1年分の理論償却費（按分前・上限適用前）を出す。 */
function annualDepreciation(
  asset: FixedAsset,
  fiscalYear: number,
  elapsedYearIndex: number,
): number {
  if (asset.method === "immediate") {
    // 即時償却は取得年に全額。
    return elapsedYearIndex === 0 ? asset.acquisitionCost : 0;
  }

  if (asset.method === "lumpSum3Year") {
    // 3年均等・月割なし。端数は最終年に寄せる。
    if (elapsedYearIndex > 2) return 0;
    const perYear = Math.floor(asset.acquisitionCost / 3);
    return elapsedYearIndex === 2
      ? asset.acquisitionCost - perYear * 2
      : perYear;
  }

  // 定額法。年の中途取得・中途除却は月割。
  const months = monthsInYear(asset, fiscalYear);
  if (months === 0) return 0;
  const full = asset.acquisitionCost * straightLineRate(asset.usefulLife);
  return Math.floor((full * months) / 12);
}

/** 償却後に残す簿価。定額法は1円、一括償却・即時償却は0円。 */
function residualValue(asset: FixedAsset): number {
  return asset.method === "straightLine" ? 1 : 0;
}

/**
 * 指定年度の減価償却費。取得年から対象年まで積み上げて期首簿価を確定させるので、
 * 残存簿価の下限（定額法は1円）と最終年の端数処理が自然に効く。
 */
export function depreciationForYear(
  asset: FixedAsset,
  fiscalYear: number,
): DepreciationForYear {
  const acquiredYear = yearOf(asset.acquiredOn);
  const residual = residualValue(asset);

  let bookValue = asset.acquisitionCost;
  let accumulated = 0;
  let depreciation = 0;
  let openingBookValue = asset.acquisitionCost;

  for (let year = acquiredYear; year <= fiscalYear; year += 1) {
    openingBookValue = bookValue;
    const theoretical = annualDepreciation(asset, year, year - acquiredYear);
    // 残存簿価を割らないように上限をかける。これが最終年の端数調整になる。
    depreciation = Math.max(0, Math.min(theoretical, bookValue - residual));
    bookValue -= depreciation;
    accumulated += depreciation;
  }

  // 対象年より前に取得していない資産は当期の償却なし。
  if (fiscalYear < acquiredYear) {
    return {
      asset,
      openingBookValue: 0,
      months: 0,
      depreciation: 0,
      businessExpense: 0,
      privatePortion: 0,
      closingBookValue: 0,
      accumulated: 0,
      isFinalYear: false,
    };
  }

  const businessExpense = Math.floor(
    (depreciation * asset.businessUseRatio) / 100,
  );

  return {
    asset,
    openingBookValue,
    months: monthsInYear(asset, fiscalYear),
    depreciation,
    businessExpense,
    privatePortion: depreciation - businessExpense,
    closingBookValue: bookValue,
    accumulated,
    isFinalYear: depreciation > 0 && bookValue <= residual,
  };
}

export type DepreciationSchedule = {
  rows: DepreciationForYear[];
  /** 当期償却費の合計（按分前） */
  depreciationTotal: number;
  /** 必要経費算入額の合計。決算書1ページの減価償却費に載る額。 */
  businessExpenseTotal: number;
  /** 期末の帳簿価額合計（貸借対照表の固定資産） */
  closingBookValueTotal: number;
  /** 期末の減価償却累計額合計 */
  accumulatedTotal: number;
};

/** 台帳全体の当年度償却明細。取得前・除却済みで動きのない資産は除く。 */
export function depreciationSchedule(
  assets: readonly FixedAsset[],
  fiscalYear: number,
): DepreciationSchedule {
  const rows = assets
    .filter((asset) => yearOf(asset.acquiredOn) <= fiscalYear)
    .map((asset) => depreciationForYear(asset, fiscalYear))
    .sort(
      (a, b) =>
        a.asset.acquiredOn.localeCompare(b.asset.acquiredOn) ||
        a.asset.id - b.asset.id,
    );

  const sum = (pick: (row: DepreciationForYear) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  return {
    rows,
    depreciationTotal: sum((row) => row.depreciation),
    businessExpenseTotal: sum((row) => row.businessExpense),
    closingBookValueTotal: sum((row) => row.closingBookValue),
    accumulatedTotal: sum((row) => row.accumulated),
  };
}
