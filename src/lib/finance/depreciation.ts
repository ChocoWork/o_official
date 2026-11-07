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
//   decliningBalance  定率法。型だけ持つ未対応の値で、計算に渡すと
//                 UnsupportedDepreciationMethodError を投げる（定額法に黙って置き換えない）。
//
// 会計の期間（法人の短い事業年度・期の途中の使い始め・個人が事業をやめた年）を渡すと、
// 月数を暦年でなく期間で数える（設計 11-f・11-f2）。期間なしの呼び出しは従来の暦年のまま。

import { parseIsoDate } from "@/lib/accounting/period";
import { splitPeriodByMonth } from "@/lib/accounting/period-months";

export type DepreciationMethod =
  "straightLine" | "lumpSum3Year" | "immediate" | "decliningBalance";

/** 画面で選べる償却方法。定率法（decliningBalance）は未対応なので入れない。 */
export const SELECTABLE_DEPRECIATION_METHODS = [
  "straightLine",
  "lumpSum3Year",
  "immediate",
] as const satisfies readonly DepreciationMethod[];

/** 償却を数える会計の期間。 */
export type DepreciationPeriod = {
  businessType: "soleProprietor" | "corporation";
  startsOn: string;
  endsOn: string;
};

/** 未対応の償却方法（定率法）を計算に渡したときに投げる。 */
export class UnsupportedDepreciationMethodError extends Error {
  readonly method: DepreciationMethod;

  constructor(method: DepreciationMethod) {
    super(`Unsupported depreciation method: ${method}`);
    this.name = "UnsupportedDepreciationMethodError";
    this.method = method;
  }
}

export type FixedAsset = {
  id: number;
  name: string;
  /** 資産の勘定科目名（工具器具備品 / ソフトウェア 等） */
  account: string;
  acquiredOn: string;
  /**
   * 事業供用日。null は取得日と同じ。
   * 償却は取得した日ではなく事業の用に供した日から始まる（国税庁 No.2100）。
   */
  serviceStartedOn?: string | null;
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
  decliningBalance: "定率法",
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

/**
 * 期間の月数。暦で数え、1か月に満たない端数は1か月に切り上げる
 * （耐用年数省令5条5項。例 `2027-07-01`〜`2027-12-31` は6、`2027-07-15`〜`2028-07-14` は12）。
 */
export function monthsInPeriod(startsOn: string, endsOn: string): number {
  const start = parseIsoDate(startsOn);
  const end = parseIsoDate(endsOn);
  if (startsOn > endsOn) {
    throw new RangeError("startsOn must not be after endsOn");
  }
  const monthsApart = (end.year - start.year) * 12 + (end.month - start.month);
  if (start.day === 1) return monthsApart + 1;
  // 応当日の前日（その月に無ければ月末）までで満了する月数に、余りの日があれば1か月足す。
  const lastDayOfWholeMonths = Math.min(
    start.day - 1,
    new Date(Date.UTC(end.year, end.month, 0)).getUTCDate(),
  );
  return monthsApart + (end.day > lastDayOfWholeMonths ? 1 : 0);
}

/**
 * 期間のうち、使い始めた日の月から期間の終わりの月までの月数。使い始めた月も1か月に数える
 * （設計 11-f2）。期間の前に使い始めていれば期間の最初の月から数える。
 * 期間の終わりが早い個人の最後の期間は、事業をやめた日の月まで。
 */
export function usedMonthsInPeriod(
  startedOn: string,
  period: { startsOn: string; endsOn: string },
): number {
  if (startedOn > period.endsOn) return 0;
  const from = startedOn > period.startsOn ? startedOn : period.startsOn;
  return splitPeriodByMonth(from, period.endsOn).length;
}

/** 資産が期間に使った月数。除却した月まで数える。 */
function assetUsedMonthsInPeriod(
  asset: FixedAsset,
  period: { startsOn: string; endsOn: string },
): number {
  const endsOn =
    asset.disposedOn && asset.disposedOn < period.endsOn
      ? asset.disposedOn
      : period.endsOn;
  if (endsOn < period.startsOn) return 0;
  return usedMonthsInPeriod(depreciationStartOn(asset), {
    startsOn: period.startsOn,
    endsOn,
  });
}

/** 浮動小数の誤差（100,200.00000000001 など）で切り捨てが1円ずれないよう丸めてから切り捨てる。 */
function floorYen(value: number): number {
  return Math.floor(Math.round(value * 1e6) / 1e6);
}

/**
 * 償却の起点となる日。事業供用日が未入力なら取得日と同じとみなす。
 * 一括償却・即時償却の経過年数もこの日の属する年から数える（供用年度基準）。
 */
export function depreciationStartOn(asset: FixedAsset): string {
  return asset.serviceStartedOn || asset.acquiredOn;
}

/** 当年の事業供用月数。供用年は供用月から、除却年は除却月まで（暦月単位）。 */
function monthsInYear(asset: FixedAsset, fiscalYear: number): number {
  const startOn = depreciationStartOn(asset);
  const startYear = yearOf(startOn);
  const disposedYear = asset.disposedOn ? yearOf(asset.disposedOn) : null;

  if (fiscalYear < startYear) return 0;
  if (disposedYear !== null && fiscalYear > disposedYear) return 0;

  const start = fiscalYear === startYear ? monthOf(startOn) : 1;
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
  /** 期間で数えた使用月数。無ければ暦年（fiscalYear）で数える。 */
  usedMonths?: number,
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
  const months = usedMonths ?? monthsInYear(asset, fiscalYear);
  if (months === 0) return 0;
  const full = asset.acquisitionCost * straightLineRate(asset.usefulLife);
  return Math.floor((full * months) / 12);
}

/** 償却後に残す簿価。定額法は1円、一括償却・即時償却は0円。 */
function residualValue(asset: FixedAsset): number {
  return asset.method === "straightLine" ? 1 : 0;
}

/** 供用前の資産（当期の償却なし）。 */
function notStarted(asset: FixedAsset): DepreciationForYear {
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

/**
 * 期（年）ごとの理論償却費を積み上げ、最後の期の明細を返す。
 * 残存簿価の下限（定額法は1円）と最終年の端数処理がここで効く。
 */
function accumulate(
  asset: FixedAsset,
  theoreticals: readonly number[],
  months: number,
): DepreciationForYear {
  const residual = residualValue(asset);

  let bookValue = asset.acquisitionCost;
  let accumulated = 0;
  let depreciation = 0;
  let openingBookValue = asset.acquisitionCost;

  for (const theoretical of theoreticals) {
    openingBookValue = bookValue;
    // 残存簿価を割らないように上限をかける。これが最終年の端数調整になる。
    depreciation = Math.max(0, Math.min(theoretical, bookValue - residual));
    bookValue -= depreciation;
    accumulated += depreciation;
  }

  const businessExpense = Math.floor(
    (depreciation * asset.businessUseRatio) / 100,
  );

  return {
    asset,
    openingBookValue,
    months,
    depreciation,
    businessExpense,
    privatePortion: depreciation - businessExpense,
    closingBookValue: bookValue,
    accumulated,
    isFinalYear: depreciation > 0 && bookValue <= residual,
  };
}

/**
 * 法人の期の理論償却費。定額法は、期が1年に満たなければ償却率に月数/12を掛け（①）、
 * 期の途中で使い始めた資産はその限度額を期の月数で割って使った月数を掛ける（②）。
 * 一括償却・即時償却は月割せず、使い始めた期から数えた期の順で決める。
 */
function corporatePeriodTheoretical(
  asset: FixedAsset,
  period: DepreciationPeriod,
  elapsedPeriodIndex: number,
): number {
  if (asset.method !== "straightLine") {
    return annualDepreciation(
      asset,
      yearOf(period.startsOn),
      elapsedPeriodIndex,
    );
  }
  const used = assetUsedMonthsInPeriod(asset, period);
  if (used === 0) return 0;
  const periodMonths = monthsInPeriod(period.startsOn, period.endsOn);
  const full = asset.acquisitionCost * straightLineRate(asset.usefulLife);
  const limit = (full * Math.min(periodMonths, 12)) / 12;
  return floorYen((limit / periodMonths) * Math.min(used, periodMonths));
}

/**
 * 指定年度（または会計の期間）の減価償却費。使い始めた年（期）から対象まで積み上げて
 * 期首簿価を確定させるので、残存簿価の下限（定額法は1円）と最終年の端数処理が自然に効く。
 *
 * `period` を渡さなければ暦年（fiscalYear）で数える。渡したときは:
 * - 法人の期間: 使い始めた期から、`earlierPeriods`（前の期）と `period` を順に数える。
 * - 個人の期間: 前の年は暦年で数え、`period` の年だけ期間の月数で数える
 *   （事業をやめた年は期間の最初の月〜やめた日の月、暦年なら従来と同じ値）。
 * 定率法（decliningBalance）は未対応なので UnsupportedDepreciationMethodError を投げる。
 */
export function depreciationForYear(
  asset: FixedAsset,
  fiscalYear: number,
  period?: DepreciationPeriod,
  earlierPeriods: readonly DepreciationPeriod[] = [],
): DepreciationForYear {
  if (asset.method === "decliningBalance") {
    throw new UnsupportedDepreciationMethodError(asset.method);
  }

  const startOn = depreciationStartOn(asset);

  if (period?.businessType === "corporation") {
    if (startOn > period.endsOn) return notStarted(asset);
    const sequence = [
      ...earlierPeriods
        .filter(
          (earlier) =>
            earlier.businessType === "corporation" &&
            earlier.startsOn < period.startsOn,
        )
        .sort((a, b) => a.startsOn.localeCompare(b.startsOn)),
      period,
    ];
    const first = Math.max(
      0,
      sequence.findIndex((candidate) => candidate.endsOn >= startOn),
    );
    const theoreticals = sequence
      .slice(first)
      .map((candidate, index) =>
        corporatePeriodTheoretical(asset, candidate, index),
      );
    // 日の途中から始まる期間は暦の月で数えると期間の月数より1多くなるので、期間の月数で頭打ちにする。
    const months = Math.min(
      assetUsedMonthsInPeriod(asset, period),
      monthsInPeriod(period.startsOn, period.endsOn),
    );
    return accumulate(asset, theoreticals, months);
  }

  const lastYear = period ? yearOf(period.startsOn) : fiscalYear;
  const startYear = yearOf(startOn);

  // 対象年より前に事業供用していない資産は当期の償却なし。
  if (lastYear < startYear) return notStarted(asset);

  const periodMonths = period ? assetUsedMonthsInPeriod(asset, period) : null;
  const theoreticals: number[] = [];
  for (let year = startYear; year <= lastYear; year += 1) {
    theoreticals.push(
      annualDepreciation(
        asset,
        year,
        year - startYear,
        year === lastYear && periodMonths !== null ? periodMonths : undefined,
      ),
    );
  }

  return accumulate(
    asset,
    theoreticals,
    periodMonths ?? monthsInYear(asset, lastYear),
  );
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

/**
 * 台帳全体の当年度（または会計の期間）の償却明細。供用前・除却済みで動きのない資産は除く。
 * `period`・`earlierPeriods` の意味は `depreciationForYear` と同じ。
 */
export function depreciationSchedule(
  assets: readonly FixedAsset[],
  fiscalYear: number,
  period?: DepreciationPeriod,
  earlierPeriods: readonly DepreciationPeriod[] = [],
): DepreciationSchedule {
  const rows = assets
    .filter((asset) =>
      period
        ? depreciationStartOn(asset) <= period.endsOn
        : yearOf(depreciationStartOn(asset)) <= fiscalYear,
    )
    .map((asset) =>
      depreciationForYear(asset, fiscalYear, period, earlierPeriods),
    )
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
