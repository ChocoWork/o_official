import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { DataTable } from "@/components/ui/DataTable/DataTable";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { Graph } from "@/components/ui/Graph/Graph";
import { Panel } from "@/components/ui/Panel/Panel";
import { SearchField } from "@/components/ui/SearchField/SearchField";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { TabSegmentControl } from "@/components/ui/TabSegmentControl/TabSegmentControl";
import { TagLabel } from "@/components/ui/TagLabel/TagLabel";
import { TextField } from "@/components/ui/TextField/TextField";
import { KpiSalesFunnel } from "@/components/KpiSalesFunnel";
import { MetaKpiConnection } from "@/components/MetaKpiConnection";
import type { GraphSeries } from "@/components/ui/Graph/Graph_types";
import type { SelectOption } from "@/components/ui/types";
import { clientFetch } from "@/lib/client-fetch";
import {
  SOURCE_METRICS,
  MONTHLY_KPI_FORMULAS,
  sourceStorageKey,
  kpiOverrideStorageKey,
  parseSeasonKey,
  currentSeasonKey,
  formatSeasonLabel,
  seasonSortKey,
  seasonMonthKeys,
  seasonOptionsDescending,
  findRecordedSeriesRange,
  latestAdjacentRecordedPair,
  resolveRecordedKpiValue,
  type SourceMetricDef,
} from "@/lib/kpi/monthly-metrics";

type PeriodKpiMetrics = {
  period: string;
  salesAmount: number;
  formattedSales: string;
  cvr: number;
  formattedCvr: string;
  aov: number;
  formattedAov: string;
  setPurchaseRate: number;
  formattedSetPurchaseRate: string;
  inventoryConsumptionRate: number;
  formattedInventoryConsumptionRate: string;
  ltv: number;
  formattedLtv: string;
  repeatRate: number;
  formattedRepeatRate: string;
  returnRate: number;
  formattedReturnRate: string;
  orderCount: number;
  paidOrderCount: number;
  customerCount: number;
  repeatCustomerCount: number;
  setOrderCount: number;
  cancelledOrderCount: number;
  soldItemCount: number;
  publishedItemCount: number;
};

export type AdminKpiData = {
  monthlyYearOptions: number[];
  monthlyKpiByYear: Array<{
    year: number;
    metrics: PeriodKpiMetrics[];
  }>;
  seasonalKpi: PeriodKpiMetrics[];
  targetYear: number;
  returnRateNote?: string;
  inventoryConsumptionRateNote?: string;
};

type KpiSectionProps = {
  data: AdminKpiData | null;
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
};

type KpiPriority = "◎" | "○" | "△";

type KpiTargetDefinition = {
  key: string;
  label: string;
  definition: string;
  priority: KpiPriority;
};

type KpiTargetData = {
  currentSeason: string;
  seasons: string[];
  definitions: KpiTargetDefinition[];
  values: Record<string, Record<string, string>>;
};

type KpiProgressDirection = "atLeast" | "atMost";

// KPI一覧の絞り込み。すべて＋4カテゴリ。
type KpiCategory = "販売" | "集客" | "広告" | "顧客";

const KPI_CATEGORY_FILTERS = [
  "すべて",
  "販売",
  "集客",
  "広告",
  "顧客",
] as const;

type KpiCategoryFilter = (typeof KPI_CATEGORY_FILTERS)[number];

// バックエンド実データに接続済みの指標。
const CONNECTED_KPI_METRICS: Record<
  string,
  {
    value: (metric: PeriodKpiMetrics) => number;
    formatted: (metric: PeriodKpiMetrics) => string;
    targetKey: string;
  }
> = {
  cvr: {
    value: (metric) => metric.cvr,
    formatted: (metric) => metric.formattedCvr,
    targetKey: "cvr",
  },
  aov: {
    value: (metric) => metric.aov,
    formatted: (metric) => metric.formattedAov,
    targetKey: "aov",
  },
  set_purchase_rate: {
    value: (metric) => metric.setPurchaseRate,
    formatted: (metric) => metric.formattedSetPurchaseRate,
    targetKey: "set_purchase_rate",
  },
  sales: {
    value: (metric) => metric.salesAmount,
    formatted: (metric) => metric.formattedSales,
    targetKey: "sales",
  },
  inventory_turnover: {
    value: (metric) => metric.inventoryConsumptionRate,
    formatted: (metric) => metric.formattedInventoryConsumptionRate,
    targetKey: "inventory_turnover",
  },
  ltv: {
    value: (metric) => metric.ltv,
    formatted: (metric) => metric.formattedLtv,
    targetKey: "ltv",
  },
  repeat_rate: {
    value: (metric) => metric.repeatRate,
    formatted: (metric) => metric.formattedRepeatRate,
    targetKey: "repeat_rate",
  },
  return_rate: {
    value: (metric) => metric.returnRate,
    formatted: (metric) => metric.formattedReturnRate,
    targetKey: "return_rate",
  },
};

type KpiCardSample = {
  valueText: string;
  targetText: string;
  percent: number;
  spark: number[];
};

type KpiCardDefinition = {
  key: string;
  label: string;
  unitLabel: string;
  icon: string;
  category: KpiCategory;
  direction: KpiProgressDirection;
  targetKey: string; // admin_kpi_targets.kpi_key（目標編集の保存先）
  connectedKey?: string;
  sample?: KpiCardSample;
};

// サンプル用スパークライン（参考値KPIの推移グラフに使う波形）。
const SPARK_UP = [40, 46, 43, 51, 56, 60, 66, 72];
const SPARK_STRONG = [28, 36, 41, 47, 55, 62, 70, 80];
const SPARK_GENTLE = [48, 51, 49, 54, 52, 57, 55, 60];
const SPARK_COST = [72, 68, 63, 60, 57, 54, 52, 49];

// 実データ接続済みの指標を先に並べ、参考値の指標を後ろへ回す（一覧の上部を実績で埋める）。
const KPI_CARD_DEFINITIONS: KpiCardDefinition[] = [
  {
    key: "sales",
    label: "売上",
    unitLabel: "目標円",
    icon: "ri-line-chart-line",
    category: "販売",
    direction: "atLeast",
    targetKey: "sales",
    connectedKey: "sales",
  },
  {
    key: "cvr",
    label: "CVR",
    unitLabel: "目標%",
    icon: "ri-shopping-cart-2-line",
    category: "販売",
    direction: "atLeast",
    targetKey: "cvr",
    connectedKey: "cvr",
  },
  {
    key: "aov",
    label: "客単価（AOV）",
    unitLabel: "目標円",
    icon: "ri-money-cny-circle-line",
    category: "販売",
    direction: "atLeast",
    targetKey: "aov",
    connectedKey: "aov",
  },
  {
    key: "inventory_turnover",
    label: "在庫消化率",
    unitLabel: "目標%",
    icon: "ri-archive-line",
    category: "販売",
    direction: "atLeast",
    targetKey: "inventory_turnover",
    connectedKey: "inventory_turnover",
  },
  {
    key: "repeat_rate",
    label: "リピート率",
    unitLabel: "目標%",
    icon: "ri-repeat-line",
    category: "顧客",
    direction: "atLeast",
    targetKey: "repeat_rate",
    connectedKey: "repeat_rate",
  },
  {
    key: "return_rate",
    label: "返品率",
    unitLabel: "目標%",
    icon: "ri-arrow-go-back-line",
    category: "販売",
    direction: "atMost",
    targetKey: "return_rate",
    connectedKey: "return_rate",
  },
  {
    key: "roas",
    label: "ROAS",
    unitLabel: "目標倍",
    icon: "ri-pie-chart-line",
    category: "広告",
    direction: "atLeast",
    targetKey: "roas",
    sample: {
      valueText: "3.2倍",
      targetText: "5.0倍",
      percent: 64.0,
      spark: SPARK_STRONG,
    },
  },
  {
    key: "cpa",
    label: "CPA",
    unitLabel: "目標円",
    icon: "ri-focus-3-line",
    category: "広告",
    direction: "atMost",
    targetKey: "cpa",
    sample: {
      valueText: "¥1,820",
      targetText: "¥3,000",
      percent: 60.7,
      spark: SPARK_COST,
    },
  },
  {
    key: "set_purchase_rate",
    label: "セット購入率",
    unitLabel: "目標%",
    icon: "ri-stack-line",
    category: "販売",
    direction: "atLeast",
    targetKey: "set_purchase_rate",
    connectedKey: "set_purchase_rate",
  },
  {
    key: "ltv",
    label: "LTV",
    unitLabel: "目標円",
    icon: "ri-user-heart-line",
    category: "顧客",
    direction: "atLeast",
    targetKey: "ltv",
    connectedKey: "ltv",
  },
  {
    key: "reach",
    label: "リーチ数",
    unitLabel: "目標人",
    icon: "ri-radar-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "reach",
    sample: {
      valueText: "128,450",
      targetText: "200,000 人",
      percent: 64.2,
      spark: SPARK_UP,
    },
  },
  {
    key: "save_rate",
    label: "保存率",
    unitLabel: "目標%",
    icon: "ri-bookmark-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "save_rate",
    sample: {
      valueText: "18.6%",
      targetText: "25.0%",
      percent: 74.4,
      spark: SPARK_STRONG,
    },
  },
  {
    key: "profile_rate",
    label: "プロフィール遷移率",
    unitLabel: "目標%",
    icon: "ri-user-shared-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "profile_transition_rate",
    sample: {
      valueText: "6.3%",
      targetText: "10.0%",
      percent: 63.0,
      spark: SPARK_UP,
    },
  },
  {
    key: "follow_rate",
    label: "フォロー率",
    unitLabel: "目標%",
    icon: "ri-user-add-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "follow_rate",
  },
  {
    key: "story_views",
    label: "ストーリー視聴数",
    unitLabel: "目標回",
    icon: "ri-play-circle-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "story_views",
    sample: {
      valueText: "8,420",
      targetText: "12,000 回",
      percent: 70.2,
      spark: SPARK_UP,
    },
  },
  {
    key: "story_reach",
    label: "ストーリー到達率",
    unitLabel: "目標%",
    icon: "ri-eye-2-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "story_reach_rate",
    sample: {
      valueText: "42.0%",
      targetText: "60.0%",
      percent: 70.0,
      spark: SPARK_GENTLE,
    },
  },
  {
    key: "link_click",
    label: "リンククリック率",
    unitLabel: "目標%",
    icon: "ri-links-line",
    category: "集客",
    direction: "atLeast",
    targetKey: "link_click_rate",
    sample: {
      valueText: "2.8%",
      targetText: "5.0%",
      percent: 56.0,
      spark: SPARK_UP,
    },
  },
  {
    key: "cpc",
    label: "CPC",
    unitLabel: "目標円",
    icon: "ri-cursor-line",
    category: "広告",
    direction: "atMost",
    targetKey: "cpc",
    sample: {
      valueText: "¥85",
      targetText: "¥70",
      percent: 82.4,
      spark: SPARK_COST,
    },
  },
  {
    key: "cpm",
    label: "CPM",
    unitLabel: "目標円",
    icon: "ri-bar-chart-box-line",
    category: "広告",
    direction: "atMost",
    targetKey: "cpm",
    sample: {
      valueText: "¥1,240",
      targetText: "¥1,000",
      percent: 80.6,
      spark: SPARK_COST,
    },
  },
  {
    key: "exit_rate",
    label: "離脱率",
    unitLabel: "目標%",
    icon: "ri-logout-box-r-line",
    category: "集客",
    direction: "atMost",
    targetKey: "dropoff_rate",
    sample: {
      valueText: "48.0%",
      targetText: "40.0%",
      percent: 83.3,
      spark: SPARK_COST,
    },
  },
];

// 各指標の平易な説明（用語を知らないオーナー向けのツールチップ文）。key は KPI_CARD_DEFINITIONS.key に対応。
const KPI_DESCRIPTIONS: Record<string, string> = {
  reach: "投稿や広告が届いた人数。どれだけの人の目に触れたかを表す",
  save_rate: "投稿を見た人のうち、後で見返すために保存した人の割合",
  profile_rate: "投稿を見た人のうち、プロフィールを訪れた人の割合",
  follow_rate: "プロフィールを訪れた人のうち、新しくフォローした人の割合",
  story_views: "ストーリーが再生された回数",
  story_reach: "ストーリーがフォロワーのうち何割に届いたか",
  link_click: "プロフィールや投稿のリンクがクリックされた割合",
  cvr: "サイトを訪れた人のうち、実際に購入した人の割合（購入率）",
  aov: "1回の注文あたりの平均購入金額",
  set_purchase_rate: "全購入のうち、上下やセットでまとめ買いされた割合",
  sales: "期間内に売れた総額",
  inventory_turnover: "仕入れた在庫のうち、売れた割合",
  cpa: "顧客を1人獲得するのにかかった広告費",
  roas: "広告費に対して何倍の売上になったか（広告費用対効果）",
  cpc: "広告が1回クリックされるのにかかった費用（クリック単価）",
  cpm: "広告を1,000回表示するのにかかった費用（表示単価）",
  ltv: "1人の顧客が生涯を通じて使ってくれる金額の合計（顧客生涯価値）",
  repeat_rate: "一度購入した人が、再び購入してくれた割合",
  return_rate: "購入のうち、返品・キャンセルされた割合",
  exit_rate: "ページを訪れた人が、何もせず離れた割合",
};

// 推移グラフの期間粒度。月次は選択シーズンの6ヶ月、シーズンは全シーズン、年度は暦年。
type TrendGranularity = "month" | "season" | "year";

const TREND_GRANULARITY_OPTIONS: { key: TrendGranularity; label: string }[] = [
  { key: "month", label: "月次" },
  { key: "season", label: "シーズン" },
  { key: "year", label: "年度" },
];

const TREND_COMPARISON_LABELS: Record<TrendGranularity, string> = {
  month: "前月比",
  season: "前シーズン比",
  year: "前年度比",
};

type TrendMetricValues = {
  sales: number;
  aov: number;
  cvr: number;
  setPurchaseRate: number;
  inventoryConsumptionRate: number;
  ltv: number;
  repeatRate: number;
  returnRate: number;
};

// 期間の識別情報。目標を粒度に応じて算出するため、対象シーズンキーと除数を持つ。
// 年度=[YYYYSS, YYYYAW] を合計 / シーズン=当該シーズン / 月=該当シーズンを6分割。
// prev は同じ指標の1年前の値（グラフの「前年」系列）。
type TrendPoint = TrendMetricValues & {
  label: string;
  targetSeasonKeys: string[];
  targetDivisor: number;
  prev: TrendMetricValues | null;
};

const YEN_FORMATTER = new Intl.NumberFormat("ja-JP");

const EMPTY_TREND_VALUES: TrendMetricValues = {
  sales: 0,
  aov: 0,
  cvr: 0,
  setPurchaseRate: 0,
  inventoryConsumptionRate: 0,
  ltv: 0,
  repeatRate: 0,
  returnRate: 0,
};

function toTrendValues(metric: PeriodKpiMetrics): TrendMetricValues {
  return {
    sales: metric.salesAmount,
    aov: metric.aov,
    cvr: metric.cvr,
    setPurchaseRate: metric.setPurchaseRate,
    inventoryConsumptionRate: metric.inventoryConsumptionRate,
    ltv: metric.ltv,
    repeatRate: metric.repeatRate,
    returnRate: metric.returnRate,
  };
}

function aggregateYearMetrics(metrics: PeriodKpiMetrics[]): TrendMetricValues {
  if (metrics.length === 0) {
    return EMPTY_TREND_VALUES;
  }
  // 金額は合計、率と LTV は月平均で年次化する。
  const mean = (get: (metric: PeriodKpiMetrics) => number) =>
    metrics.reduce((sum, metric) => sum + get(metric), 0) / metrics.length;
  const sales = metrics.reduce((sum, m) => sum + m.salesAmount, 0);
  const orderCount = metrics.reduce((sum, m) => sum + m.orderCount, 0);
  const cvr = mean((m) => m.cvr);
  const aov = orderCount > 0 ? sales / orderCount : mean((m) => m.aov);
  return {
    sales,
    aov,
    cvr,
    setPurchaseRate: mean((m) => m.setPurchaseRate),
    inventoryConsumptionRate: mean((m) => m.inventoryConsumptionRate),
    ltv: mean((m) => m.ltv),
    repeatRate: mean((m) => m.repeatRate),
    returnRate: mean((m) => m.returnRate),
  };
}

// 推移グラフに出せる実データ（KPI_CARD_DEFINITIONS.connectedKey → 期間の値）。
const TREND_KPI_ACCESSORS: Record<
  string,
  (values: TrendMetricValues) => number
> = {
  cvr: (values) => values.cvr,
  aov: (values) => values.aov,
  set_purchase_rate: (values) => values.setPurchaseRate,
  sales: (values) => values.sales,
  inventory_turnover: (values) => values.inventoryConsumptionRate,
  ltv: (values) => values.ltv,
  repeat_rate: (values) => values.repeatRate,
  return_rate: (values) => values.returnRate,
};

// 1指標の期間別の値。月次は保存済み記録だけを使い、未記録値を生成しない。
function kpiSeriesValues(
  definition: KpiCardDefinition,
  points: TrendPoint[],
  granularity: TrendGranularity,
  monthKeys: string[],
  recordValues: Record<string, Record<string, string>>,
): (number | null)[] {
  if (granularity === "month") {
    return monthKeys.map((monthKey) =>
      resolveRecordedKpiValue(recordValues[monthKey] ?? {}, definition.key),
    );
  }

  const accessor = definition.connectedKey
    ? TREND_KPI_ACCESSORS[definition.connectedKey]
    : undefined;

  if (accessor) {
    return points.map(accessor);
  }

  return points.map(() => null);
}

// 1指標の「1年前」の値。実データ接続済みで、前年の期間が揃っているときだけ描く。
function kpiPrevSeriesValues(
  definition: KpiCardDefinition,
  points: TrendPoint[],
): (number | null)[] {
  const accessor = definition.connectedKey
    ? TREND_KPI_ACCESSORS[definition.connectedKey]
    : undefined;

  if (!accessor) {
    return points.map(() => null);
  }

  return points.map((point) => (point.prev ? accessor(point.prev) : null));
}

// 単位は KPI_CARD_DEFINITIONS.unitLabel（「目標円」「目標%」等）から接頭辞を落として得る。
function kpiUnit(unitLabel: string): string {
  return unitLabel.replace("目標", "");
}

function formatKpiValue(value: number, unit: string): string {
  if (unit === "円") {
    return `¥${YEN_FORMATTER.format(Math.round(value))}`;
  }
  if (unit === "%") {
    return `${value.toFixed(1)}%`;
  }
  if (unit === "倍") {
    return `${value.toFixed(1)}倍`;
  }
  return `${YEN_FORMATTER.format(Math.round(value))}${unit}`;
}

// 月次記録：order 由来の源データを現在月の PeriodKpiMetrics から機械取得するマップ。
const ORDER_SOURCE_ACCESSORS: Record<
  string,
  (metric: PeriodKpiMetrics) => number
> = {
  paid_sales: (m) => m.salesAmount,
  paid_orders: (m) => m.paidOrderCount,
  all_orders: (m) => m.orderCount,
  set_orders: (m) => m.setOrderCount,
  cancelled_orders: (m) => m.cancelledOrderCount,
  customers: (m) => m.customerCount,
  repeat_customers: (m) => m.repeatCustomerCount,
  sold_items: (m) => m.soldItemCount,
  published_items: (m) => m.publishedItemCount,
};

// KPIキー→単位（KPI_CARD_DEFINITIONS の unitLabel から接頭辞を除いたもの）。
const KPI_UNIT_BY_KEY: Record<string, string> = Object.fromEntries(
  KPI_CARD_DEFINITIONS.map((definition) => [
    definition.key,
    kpiUnit(definition.unitLabel),
  ]),
);

const KPI_FORMULA_BY_KEY = new Map(
  MONTHLY_KPI_FORMULAS.map((formula) => [formula.key, formula]),
);

// 入力文字列を数値へ。空文字・非数値は null。カンマと空白は無視する。
function parseNumericInput(value: string): number | null {
  const normalized = value.replace(/[,\s]/g, "");
  if (normalized === "") {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

// 'YYYY-MM' → '7月'（列見出し用）。
function monthColumnLabel(monthKey: string): string {
  const matched = monthKey.match(/^\d{4}-(\d{2})$/);
  return matched ? `${Number.parseInt(matched[1], 10)}月` : monthKey;
}

// 'YYYY-MM' → 2026（年の絞り込み用）。
function monthKeyYear(monthKey: string): number {
  return Number.parseInt(monthKey.slice(0, 4), 10);
}

// シーズンキー → '2026年4月〜9月' / '2026年10月〜2027年3月'。
function formatSeasonRangeLabel(season: string): string {
  const parsed = parseSeasonKey(season);
  if (!parsed) {
    return season;
  }
  return parsed.type === "SS"
    ? `${parsed.year}年4月〜9月`
    : `${parsed.year}年10月〜${parsed.year + 1}年3月`;
}

// 年平均成長率（CAGR）。first→last を (期間数-1) 乗根で年率化する。
function computeCagr(
  first: number,
  last: number,
  periodCount: number,
): number | null {
  if (periodCount < 2 || first <= 0 || last <= 0) {
    return null;
  }
  return Math.pow(last / first, 1 / (periodCount - 1)) - 1;
}

type ResolvedKpiCard = {
  key: string;
  targetKey: string;
  label: string;
  unitLabel: string;
  unit: string;
  icon: string;
  category: KpiCategory;
  direction: KpiProgressDirection;
  description: string;
  // 「算出式」欄に出す定義（総売上・売上÷注文数 等）。ツールチップにも併記する。
  definition: string;
  valueText: string;
  currentValue: number | null;
  rawTarget: string;
  targetText: string;
  targetValue: number | null;
  percent: number | null;
  percentText: string;
  isSample: boolean;
};

function parseTargetNumericValue(
  targetText: string,
  direction: KpiProgressDirection,
): number | null {
  const normalized = targetText.replaceAll(",", "").trim();
  if (!normalized) {
    return null;
  }

  // 数字に続く「万」「億」を単位倍率として解釈する（例: 130万 → 1,300,000）。
  // これを行わないと「約130万円」が 130 と読まれ、目標が実額の 1/10000 になる。
  const tokenPattern = /(\d+(?:\.\d+)?)\s*(億|万)?/g;
  const values: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(normalized)) !== null) {
    const base = Number(match[1]);
    if (!Number.isFinite(base)) {
      continue;
    }
    const multiplier =
      match[2] === "億" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
    values.push(base * multiplier);
  }
  if (values.length === 0) {
    return null;
  }

  const hasRange =
    normalized.includes("〜") ||
    normalized.includes("~") ||
    normalized.includes("-");
  if (hasRange && values.length >= 2) {
    return direction === "atLeast" ? values[0] : values[1];
  }

  return values[0];
}

function calculateProgressPercent(
  currentValue: number,
  targetValue: number,
  direction: KpiProgressDirection,
): number | null {
  if (targetValue <= 0) {
    return null;
  }

  if (direction === "atLeast") {
    return (currentValue / targetValue) * 100;
  }

  if (currentValue <= 0) {
    return 100;
  }

  return (targetValue / currentValue) * 100;
}

/** 達成率だけを描く帯。Graph の progress をラベル無しで使う。 */
function ProgressBar({
  percent,
  className,
}: {
  percent: number | null;
  className?: string;
}) {
  return (
    <Graph
      variant="progress"
      size="3xs"
      maxValue={100}
      className={className}
      data={[
        {
          label: "",
          value: percent === null ? 0 : Math.max(0, Math.min(100, percent)),
          formattedValue: "",
        },
      ]}
    />
  );
}

/** KPIアイコン。ホバーで説明と定義を出す。 */
function KpiIcon({
  card,
  className,
}: {
  card: ResolvedKpiCard;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={`${card.label}：${card.description}${card.definition ? `（定義: ${card.definition}）` : ""}`}
      className={`group relative flex shrink-0 items-center justify-center rounded-full bg-[#ededed] text-[#474747] ${className ?? "h-8 w-8"}`}
    >
      <i className={`${card.icon} text-base`} aria-hidden="true" />
      <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden w-max max-w-55 rounded-md bg-[#111111] px-2.5 py-1.5 text-left font-acumin text-2.75 font-normal leading-snug text-white shadow-md group-hover:block">
        {card.description}
        {card.definition ? (
          <span className="mt-1 block text-white/70">
            定義: {card.definition}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** KPI一覧の1枚。クリックで右側の詳細（目標・推移・月次記録）を切り替える。 */
function KpiListCard({
  card,
  isSelected,
  onSelect,
}: {
  card: ResolvedKpiCard;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const achievementState =
    card.percent === null ? null : card.percent >= 100 ? "達成" : "未達成";
  const statusColor =
    achievementState === "達成"
      ? "border-[#b9d9f5] bg-[#eef7ff]"
      : achievementState === "未達成"
        ? "border-[#f1c4c4] bg-[#fff1f1]"
        : "border-[#e8e8e8] bg-white";

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={`flex w-full flex-col items-stretch rounded-lg p-3 text-left transition-colors ${statusColor} ${
        isSelected ? "border-2 border-black" : "border hover:border-[#888888]"
      }`}
    >
      <span className="mb-2 flex items-center gap-2">
        <KpiIcon card={card} />
        <span className="min-w-0 flex-1 truncate font-acumin text-xs text-black">
          {card.label}
        </span>
        {achievementState ? (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 font-acumin text-2.5 tracking-wider ${achievementState === "達成" ? "bg-[#d8ecff] text-[#195b91]" : "bg-[#ffdede] text-[#9b3030]"}`}
          >
            {achievementState}
          </span>
        ) : null}
        {card.isSample ? (
          <span className="shrink-0 rounded-full bg-[#ededed] px-1.5 py-0.5 font-acumin text-2.5 tracking-wider text-[#888888]">
            参考
          </span>
        ) : null}
      </span>
      <span className="block font-acumin text-lg leading-none text-black tabular-nums">
        {card.valueText}
      </span>
      <span className="mt-1.5 block font-acumin text-2.75 text-[#888888] tabular-nums">
        目標 {card.targetText}
      </span>
      <span className="mt-2 block font-acumin text-2.75 text-[#474747] tabular-nums">
        {card.percentText}
      </span>
      <ProgressBar percent={card.percent} className="mt-1" />
    </button>
  );
}

export default function KpiSection({
  data,
  isLoading,
  errorMessage,
  onRetry,
}: KpiSectionProps) {
  const [selectedSeason, setSelectedSeason] = useState<string>("");
  const [selectedKpiKey, setSelectedKpiKey] = useState<string>("sales");
  const [categoryFilter, setCategoryFilter] =
    useState<KpiCategoryFilter>("すべて");
  const [isKpiSearchOpen, setIsKpiSearchOpen] = useState(false);
  const [kpiKeyword, setKpiKeyword] = useState("");
  const [trendGranularity, setTrendGranularity] =
    useState<TrendGranularity>("month");
  const [targetData, setTargetData] = useState<KpiTargetData | null>(null);
  const [targetLoadErrorMessage, setTargetLoadErrorMessage] = useState<
    string | null
  >(null);
  const [isSourceDrawerOpen, setIsSourceDrawerOpen] = useState(false);
  const [isBreakdownDrawerOpen, setIsBreakdownDrawerOpen] = useState(false);
  const [isFunnelOpen, setIsFunnelOpen] = useState(true);

  // 目標データはKPIカード・ヘッダーの達成率・推移グラフの目標線で参照する。
  const fetchKpiTargets = useCallback(async () => {
    try {
      setTargetLoadErrorMessage(null);
      const response = await clientFetch("/api/admin/kpi/targets", {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("KPI目標の取得に失敗しました。");
      }
      const json = (await response.json()) as { data: KpiTargetData };
      setTargetData(json.data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "KPI目標の取得に失敗しました。";
      console.warn("Failed to fetch KPI targets:", message);
      setTargetLoadErrorMessage(message);
    }
  }, []);

  useEffect(() => {
    // 主KPIの認証済みレスポンスを受け取るまで、同じ認証境界の補助APIを並行実行しない。
    if (!data || isLoading || errorMessage) {
      return;
    }
    void fetchKpiTargets();
  }, [data, errorMessage, fetchKpiTargets, isLoading]);

  // --- 月次記録：選択シーズン（6ヶ月）の算出元データ入力とKPI自動計算 ---
  // 月の並びはシーズンから決める（APIの取得可否に月次グラフ・入力欄を依存させない）。
  // 値は { 'YYYY-MM': { 'src:*'|'kpi:*': 入力文字列 } } のネスト。
  const recordMonthKeys = useMemo(
    () => (selectedSeason ? seasonMonthKeys(selectedSeason) : []),
    [selectedSeason],
  );
  const [editableRecordValues, setEditableRecordValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [originalRecordValues, setOriginalRecordValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [isRecordLoading, setIsRecordLoading] = useState(false);
  const [isRecordSaving, setIsRecordSaving] = useState(false);
  const [recordErrorMessage, setRecordErrorMessage] = useState<string | null>(
    null,
  );
  const [recordSuccessMessage, setRecordSuccessMessage] = useState<
    string | null
  >(null);
  const [selectedMonthKey, setSelectedMonthKey] = useState<string>("");

  const fetchMonthlyRecord = useCallback(async (season: string) => {
    try {
      setIsRecordLoading(true);
      setRecordErrorMessage(null);
      setRecordSuccessMessage(null);

      const response = await clientFetch(
        `/api/admin/kpi/monthly-record?season=${encodeURIComponent(season)}`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error("月次記録を編集する権限がありません。");
        }
        throw new Error("月次記録の取得に失敗しました。");
      }

      const json = (await response.json()) as {
        data: {
          season: string;
          monthKeys: string[];
          values: Record<string, Record<string, number>>;
        };
      };

      const nextValues: Record<string, Record<string, string>> = {};
      for (const monthKey of json.data.monthKeys) {
        const monthValues = json.data.values[monthKey] ?? {};
        nextValues[monthKey] = Object.fromEntries(
          Object.entries(monthValues).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      }

      setEditableRecordValues(nextValues);
      setOriginalRecordValues(structuredClone(nextValues));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "月次記録の取得に失敗しました。";
      console.warn("Failed to fetch monthly record:", message);
      setRecordErrorMessage(message);
    } finally {
      setIsRecordLoading(false);
    }
  }, []);

  // シーズン切替に追従して6ヶ月分を読み込む。
  useEffect(() => {
    if (!data || isLoading || errorMessage || !selectedSeason) {
      return;
    }
    void fetchMonthlyRecord(selectedSeason);
  }, [data, errorMessage, fetchMonthlyRecord, isLoading, selectedSeason]);

  // 記録対象の月。今月がシーズンに含まれればそれを、無ければ先頭月を選ぶ。
  useEffect(() => {
    if (recordMonthKeys.length === 0) {
      return;
    }
    if (recordMonthKeys.includes(selectedMonthKey)) {
      return;
    }
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    setSelectedMonthKey(
      recordMonthKeys.includes(thisMonth) ? thisMonth : recordMonthKeys[0],
    );
  }, [recordMonthKeys, selectedMonthKey]);

  const monthlyKpiMap = useMemo(() => {
    if (!data) {
      return new Map<number, PeriodKpiMetrics[]>();
    }

    return new Map<number, PeriodKpiMetrics[]>(
      data.monthlyKpiByYear.map((entry) => [entry.year, entry.metrics]),
    );
  }, [data]);

  // 月キー → PeriodKpiMetrics（源データの自動取得・月次グラフで参照する）。
  const monthMetricByKey = useMemo(() => {
    const map = new Map<string, PeriodKpiMetrics>();
    if (!data) {
      return map;
    }
    for (const entry of data.monthlyKpiByYear) {
      entry.metrics.forEach((metric, index) => {
        map.set(`${entry.year}-${String(index + 1).padStart(2, "0")}`, metric);
      });
    }
    return map;
  }, [data]);

  // 推移グラフの系列（粒度別）。月次は選択シーズンの6ヶ月、シーズンは seasonalKpi、年度は月次の年集計。
  const trendSeries = useMemo<TrendPoint[]>(() => {
    if (!data) {
      return [];
    }

    if (trendGranularity === "season") {
      return [...data.seasonalKpi]
        .sort((a, b) => seasonSortKey(a.period) - seasonSortKey(b.period))
        .map((metric) => {
          const parsed = parseSeasonKey(metric.period);
          const prevKey = parsed ? `${parsed.year - 1}${parsed.type}` : null;
          const prevMetric = prevKey
            ? data.seasonalKpi.find((entry) => entry.period === prevKey)
            : undefined;
          return {
            label: formatSeasonLabel(metric.period),
            targetSeasonKeys: [metric.period],
            targetDivisor: 1,
            prev: prevMetric ? toTrendValues(prevMetric) : null,
            ...toTrendValues(metric),
          };
        });
    }

    if (trendGranularity === "month") {
      return recordMonthKeys.map((monthKey) => {
        const metric = monthMetricByKey.get(monthKey);
        const prevMetric = monthMetricByKey.get(
          `${monthKeyYear(monthKey) - 1}${monthKey.slice(4)}`,
        );
        return {
          label: monthColumnLabel(monthKey),
          targetSeasonKeys: [selectedSeason],
          targetDivisor: 6,
          prev: prevMetric ? toTrendValues(prevMetric) : null,
          ...(metric ? toTrendValues(metric) : EMPTY_TREND_VALUES),
        };
      });
    }

    const currentYear = new Date().getFullYear();
    return [...data.monthlyKpiByYear]
      .sort((a, b) => a.year - b.year)
      .map((entry) => {
        const prevMetrics = monthlyKpiMap.get(entry.year - 1);
        return {
          label:
            entry.year > currentYear
              ? `${entry.year}（予定）`
              : `${entry.year}`,
          targetSeasonKeys: [`${entry.year}SS`, `${entry.year}AW`],
          targetDivisor: 1,
          prev: prevMetrics ? aggregateYearMetrics(prevMetrics) : null,
          ...aggregateYearMetrics(entry.metrics),
        };
      });
  }, [
    data,
    trendGranularity,
    recordMonthKeys,
    monthMetricByKey,
    monthlyKpiMap,
    selectedSeason,
  ]);

  const selectedDefinition = useMemo(
    () =>
      KPI_CARD_DEFINITIONS.find(
        (definition) => definition.key === selectedKpiKey,
      ) ?? KPI_CARD_DEFINITIONS[0],
    [selectedKpiKey],
  );

  // 推移グラフに重ねる目標（点ごと）。粒度で算出を変える：
  // 年度=当年SS+AWの合計、シーズン=当該シーズン、月=該当シーズンを6分割。
  // 実データ接続済みKPIのみ（参考値KPIはグラフが装飾波形のため対象外）。
  const trendTargets = useMemo<(number | null)[]>(() => {
    if (!selectedDefinition.connectedKey) {
      return trendSeries.map(() => null);
    }
    const kpiKey = selectedDefinition.targetKey;
    const direction = selectedDefinition.direction;
    return trendSeries.map((point) => {
      const parsed = point.targetSeasonKeys
        .map((seasonKey) =>
          parseTargetNumericValue(
            targetData?.values[kpiKey]?.[seasonKey] ?? "",
            direction,
          ),
        )
        .filter((value): value is number => value !== null);
      if (parsed.length === 0) {
        return null;
      }
      const total = parsed.reduce((sum, value) => sum + value, 0);
      return total / point.targetDivisor;
    });
  }, [trendSeries, selectedDefinition, targetData]);

  const trendActualValues = useMemo(
    () =>
      kpiSeriesValues(
        selectedDefinition,
        trendSeries,
        trendGranularity,
        recordMonthKeys,
        editableRecordValues,
      ),
    [
      selectedDefinition,
      trendSeries,
      trendGranularity,
      recordMonthKeys,
      editableRecordValues,
    ],
  );

  const selectedUnit = kpiUnit(selectedDefinition.unitLabel);

  // 実績・目標・前年の3系列。目標と前年は全期間そろっているときだけ重ねる。
  const trendGraphSeries = useMemo<GraphSeries[]>(() => {
    const series: GraphSeries[] = trendActualValues.some(
      (value) => value !== null,
    )
      ? [{ label: "実績", values: trendActualValues, color: "#111111" }]
      : [];

    if (
      trendTargets.length > 0 &&
      trendTargets.every((value) => value !== null)
    ) {
      series.push({
        label: "目標",
        values: trendTargets as number[],
        color: "#111111",
        dashed: true,
        hideDots: true,
      });
    }

    const prevValues = kpiPrevSeriesValues(selectedDefinition, trendSeries);
    if (prevValues.length > 0 && prevValues.every((value) => value !== null)) {
      series.push({
        label: "前年",
        values: prevValues as number[],
        color: "#b5b5b5",
        dashed: true,
        hideDots: true,
      });
    }

    return series;
  }, [trendActualValues, trendTargets, selectedDefinition, trendSeries]);

  // 内訳ドロワーの行。KPI19指標を、グラフと同じ系列ロジックで並べる。
  const trendTableRows = useMemo(
    () =>
      KPI_CARD_DEFINITIONS.map((definition) => {
        const values = kpiSeriesValues(
          definition,
          trendSeries,
          trendGranularity,
          recordMonthKeys,
          editableRecordValues,
        );
        const recordedRange = findRecordedSeriesRange(values);
        return {
          key: definition.key,
          label: definition.label,
          unit: kpiUnit(definition.unitLabel),
          isSample: !definition.connectedKey,
          values,
          cagr: recordedRange
            ? computeCagr(
                recordedRange.first,
                recordedRange.last,
                recordedRange.periodCount,
              )
            : null,
        };
      }),
    [trendSeries, trendGranularity, recordMonthKeys, editableRecordValues],
  );

  const selectedSeasonMetric = useMemo(() => {
    if (!data) {
      return null;
    }

    const matched = data.seasonalKpi.find(
      (metric) => metric.period === selectedSeason,
    );
    return matched ?? data.seasonalKpi[0] ?? null;
  }, [data, selectedSeason]);

  const selectedRecordedKpis = useMemo(() => {
    const monthValues = editableRecordValues[selectedMonthKey] ?? {};
    const source: Record<string, number | undefined> = {};
    for (const metric of SOURCE_METRICS) {
      const value = parseNumericInput(
        monthValues[sourceStorageKey(metric.key)] ?? "",
      );
      source[metric.key] = value ?? undefined;
    }
    const computed = new Map<string, number>();
    for (const formula of MONTHLY_KPI_FORMULAS) {
      const override = parseNumericInput(
        monthValues[kpiOverrideStorageKey(formula.key)] ?? "",
      );
      const value = override ?? formula.compute(source);
      if (value !== null) computed.set(formula.key, value);
    }
    return computed;
  }, [editableRecordValues, selectedMonthKey]);

  const kpiCards = useMemo<ResolvedKpiCard[]>(() => {
    // 「算出式」欄に出す定義（kpi_key→定義文）。
    const definitionByKey = new Map(
      (targetData?.definitions ?? []).map((entry) => [
        entry.key,
        entry.definition,
      ]),
    );

    return KPI_CARD_DEFINITIONS.map((definition) => {
      const rawTarget =
        targetData?.values[definition.targetKey]?.[selectedSeason] ?? "";
      const targetDefinition = definitionByKey.get(definition.targetKey) ?? "";
      const targetNumeric = parseTargetNumericValue(
        rawTarget,
        definition.direction,
      );
      // 単一の数値で書かれた目標は単位付きに整形する（範囲指定はそのまま見せる）。
      const isRangeTarget = /[〜~-]/.test(rawTarget);
      const formattedTarget =
        targetNumeric !== null && !isRangeTarget
          ? formatKpiValue(targetNumeric, kpiUnit(definition.unitLabel))
          : rawTarget;
      const base = {
        key: definition.key,
        targetKey: definition.targetKey,
        label: definition.label,
        unitLabel: definition.unitLabel,
        unit: kpiUnit(definition.unitLabel),
        icon: definition.icon,
        category: definition.category,
        direction: definition.direction,
        description: KPI_DESCRIPTIONS[definition.key] ?? "",
        definition: targetDefinition,
        rawTarget,
      };

      const recordedValue = selectedRecordedKpis.get(definition.key);
      if (recordedValue !== undefined && !definition.connectedKey) {
        const percent =
          targetNumeric !== null
            ? calculateProgressPercent(
                recordedValue,
                targetNumeric,
                definition.direction,
              )
            : null;
        return {
          ...base,
          valueText: formatKpiValue(recordedValue, base.unit),
          currentValue: recordedValue,
          targetText: formattedTarget || "—",
          targetValue: targetNumeric,
          percent,
          percentText: percent === null ? "—" : `${percent.toFixed(1)}%`,
          isSample: false,
        };
      }

      if (definition.connectedKey) {
        const accessor = CONNECTED_KPI_METRICS[definition.connectedKey];
        const metric = selectedSeasonMetric;
        const currentValue = metric ? accessor.value(metric) : null;
        const percent =
          currentValue !== null && targetNumeric !== null
            ? calculateProgressPercent(
                currentValue,
                targetNumeric,
                definition.direction,
              )
            : null;

        return {
          ...base,
          valueText: metric ? accessor.formatted(metric) : "—",
          currentValue,
          targetText: formattedTarget || "—",
          targetValue: targetNumeric,
          percent,
          percentText: percent === null ? "—" : `${percent.toFixed(1)}%`,
          isSample: false,
        };
      }

      const sample = definition.sample;
      if (!sample) {
        return {
          ...base,
          valueText: "—",
          currentValue: null,
          targetText: formattedTarget || "—",
          targetValue: targetNumeric,
          percent: null,
          percentText: "—",
          isSample: false,
        };
      }

      return {
        ...base,
        valueText: sample.valueText,
        currentValue: null,
        targetText: formattedTarget || sample.targetText,
        targetValue: targetNumeric,
        percent: sample.percent,
        percentText: `${sample.percent.toFixed(1)}%`,
        isSample: true,
      };
    });
  }, [selectedSeasonMetric, selectedRecordedKpis, targetData, selectedSeason]);

  const selectedCard = useMemo(
    () => kpiCards.find((card) => card.key === selectedKpiKey) ?? kpiCards[0],
    [kpiCards, selectedKpiKey],
  );

  // カテゴリとキーワードで絞り込んだKPI一覧。
  const visibleCards = useMemo(() => {
    const keyword = kpiKeyword.trim().toLowerCase();
    return kpiCards.filter((card) => {
      if (categoryFilter !== "すべて" && card.category !== categoryFilter) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return (
        card.label.toLowerCase().includes(keyword) || card.key.includes(keyword)
      );
    });
  }, [kpiCards, categoryFilter, kpiKeyword]);

  // 選択中KPIの目標編集（ヘッダーの「目標を編集」）。
  const [isTargetEditing, setIsTargetEditing] = useState(false);
  const [editingTargetValue, setEditingTargetValue] = useState("");
  const [isTargetSaving, setIsTargetSaving] = useState(false);
  const [targetErrorMessage, setTargetErrorMessage] = useState<string | null>(
    null,
  );

  const handleTargetEditStart = useCallback(() => {
    setTargetErrorMessage(null);
    setEditingTargetValue(selectedCard?.rawTarget ?? "");
    setIsTargetEditing(true);
  }, [selectedCard]);

  const handleTargetEditCancel = useCallback(() => {
    setIsTargetEditing(false);
    setEditingTargetValue("");
    setTargetErrorMessage(null);
  }, []);

  const handleTargetSave = useCallback(async () => {
    if (!targetData || !selectedCard) {
      return;
    }

    try {
      setIsTargetSaving(true);
      setTargetErrorMessage(null);

      const response = await clientFetch("/api/admin/kpi/targets", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          updates: [
            {
              season: selectedSeason,
              kpiKey: selectedCard.targetKey,
              value: editingTargetValue,
            },
          ],
        }),
      });

      const responseData = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            "KPI目標の更新に失敗しました。再ログインしてください。",
          );
        }

        if (response.status === 403) {
          throw new Error("KPI目標を編集する権限がありません。");
        }

        throw new Error(responseData?.error || "KPI目標の更新に失敗しました。");
      }

      const json = responseData as { data: KpiTargetData };

      setTargetData(json.data);
      setIsTargetEditing(false);
      setEditingTargetValue("");
    } catch (error) {
      setTargetErrorMessage(
        error instanceof Error
          ? error.message
          : "KPI目標の更新に失敗しました。",
      );
    } finally {
      setIsTargetSaving(false);
    }
  }, [editingTargetValue, selectedCard, selectedSeason, targetData]);

  // order 由来の源データを月ごとに機械取得する（{ monthKey: { sourceKey: value } }）。
  const orderAutoByMonth = useMemo<
    Record<string, Record<string, number>>
  >(() => {
    const result: Record<string, Record<string, number>> = {};
    for (const monthKey of recordMonthKeys) {
      const metric = monthMetricByKey.get(monthKey);
      result[monthKey] = {};
      if (metric) {
        for (const [key, accessor] of Object.entries(ORDER_SOURCE_ACCESSORS)) {
          result[monthKey][key] = accessor(metric);
        }
      }
    }
    return result;
  }, [recordMonthKeys, monthMetricByKey]);

  const getSourceCellValue = useCallback(
    (monthKey: string, sourceKey: string): string =>
      editableRecordValues[monthKey]?.[sourceStorageKey(sourceKey)] ?? "",
    [editableRecordValues],
  );

  const getKpiCellValue = useCallback(
    (monthKey: string, kpiKey: string): string =>
      editableRecordValues[monthKey]?.[kpiOverrideStorageKey(kpiKey)] ?? "",
    [editableRecordValues],
  );

  // 各月の源データの実効値。手動上書き最優先、order 由来は自動値へフォールバック、manual 未入力は undefined。
  const resolvedSourceByMonth = useMemo<
    Record<string, Record<string, number | undefined>>
  >(() => {
    const result: Record<string, Record<string, number | undefined>> = {};
    for (const monthKey of recordMonthKeys) {
      const resolved: Record<string, number | undefined> = {};
      for (const metric of SOURCE_METRICS) {
        const override = parseNumericInput(
          editableRecordValues[monthKey]?.[sourceStorageKey(metric.key)] ?? "",
        );
        if (override !== null) {
          resolved[metric.key] = override;
        } else if (metric.group === "order") {
          resolved[metric.key] = orderAutoByMonth[monthKey]?.[metric.key];
        } else {
          resolved[metric.key] = undefined;
        }
      }
      result[monthKey] = resolved;
    }
    return result;
  }, [recordMonthKeys, editableRecordValues, orderAutoByMonth]);

  // 各月・各KPIの自動計算値（数値）。表示テキストと月次記録テーブルで共用する。
  const kpiComputedByMonth = useMemo<
    Record<string, Record<string, number | null>>
  >(() => {
    const result: Record<string, Record<string, number | null>> = {};
    for (const monthKey of recordMonthKeys) {
      const source = resolvedSourceByMonth[monthKey] ?? {};
      const perKpi: Record<string, number | null> = {};
      for (const formula of MONTHLY_KPI_FORMULAS) {
        perKpi[formula.key] = formula.compute(source);
      }
      result[monthKey] = perKpi;
    }
    return result;
  }, [recordMonthKeys, resolvedSourceByMonth]);

  const hasRecordChanges = useMemo(() => {
    for (const monthKey of recordMonthKeys) {
      const keys = new Set([
        ...Object.keys(editableRecordValues[monthKey] ?? {}),
        ...Object.keys(originalRecordValues[monthKey] ?? {}),
      ]);
      for (const key of keys) {
        if (
          (editableRecordValues[monthKey]?.[key] ?? "") !==
          (originalRecordValues[monthKey]?.[key] ?? "")
        ) {
          return true;
        }
      }
    }
    return false;
  }, [recordMonthKeys, editableRecordValues, originalRecordValues]);

  const handleRecordValueChange = useCallback(
    (monthKey: string, storageKey: string, value: string) => {
      setRecordSuccessMessage(null);
      setEditableRecordValues((prev) => ({
        ...prev,
        [monthKey]: { ...(prev[monthKey] ?? {}), [storageKey]: value },
      }));
    },
    [],
  );

  const handleSaveMonthlyRecord = useCallback(async () => {
    const updates: Array<{
      monthKey: string;
      metricKey: string;
      value: number | "";
    }> = [];

    for (const monthKey of recordMonthKeys) {
      const keys = new Set([
        ...Object.keys(editableRecordValues[monthKey] ?? {}),
        ...Object.keys(originalRecordValues[monthKey] ?? {}),
      ]);
      for (const key of keys) {
        const current = (editableRecordValues[monthKey]?.[key] ?? "").trim();
        const original = (originalRecordValues[monthKey]?.[key] ?? "").trim();
        if (current === original) {
          continue;
        }
        if (current === "") {
          updates.push({ monthKey, metricKey: key, value: "" });
          continue;
        }
        const parsed = parseNumericInput(current);
        if (parsed === null) {
          setRecordErrorMessage(
            `数値で入力してください（${monthColumnLabel(monthKey)}）。`,
          );
          return;
        }
        updates.push({ monthKey, metricKey: key, value: parsed });
      }
    }

    if (updates.length === 0) {
      setRecordSuccessMessage("変更はありません。");
      return;
    }

    try {
      setIsRecordSaving(true);
      setRecordErrorMessage(null);
      setRecordSuccessMessage(null);

      const response = await clientFetch("/api/admin/kpi/monthly-record", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: selectedSeason, updates }),
      });

      const responseData = await response.json();

      if (!response.ok) {
        if (response.status === 503) {
          throw new Error(
            `${responseData.error}${responseData.details ? `\n詳細: ${responseData.details}` : ""}`,
          );
        }
        throw new Error(
          responseData?.error || "月次記録の保存に失敗しました。",
        );
      }

      const json = responseData as {
        data: {
          season: string;
          monthKeys: string[];
          values: Record<string, Record<string, number>>;
        };
      };
      const nextValues: Record<string, Record<string, string>> = {};
      for (const monthKey of json.data.monthKeys) {
        const monthValues = json.data.values[monthKey] ?? {};
        nextValues[monthKey] = Object.fromEntries(
          Object.entries(monthValues).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      }
      setEditableRecordValues(nextValues);
      setOriginalRecordValues(structuredClone(nextValues));
      setRecordSuccessMessage("月次記録を保存しました。");
    } catch (error) {
      setRecordErrorMessage(
        error instanceof Error
          ? error.message
          : "月次記録の保存に失敗しました。",
      );
    } finally {
      setIsRecordSaving(false);
    }
  }, [
    recordMonthKeys,
    editableRecordValues,
    originalRecordValues,
    selectedSeason,
  ]);

  // シーズンの選択肢：FIRST_SEASON（2026 S/S）から次シーズンまでを新しい順に並べる。
  const seasonInfo = useMemo(() => {
    const current = targetData?.currentSeason ?? currentSeasonKey();
    return { current, options: seasonOptionsDescending(current) };
  }, [targetData]);

  // ユーザーがシーズンを手動選択したか。未操作の間は現在シーズンに追従する。
  const seasonManuallySelectedRef = useRef(false);

  // 初期表示・データ更新時の選択シーズン制御。
  // 未操作: 常に現在シーズン（今の月に紐づくシーズン）を選択。操作後: 無効になった時のみ現在へ補正。
  useEffect(() => {
    if (seasonInfo.options.length === 0) {
      return;
    }
    if (!seasonManuallySelectedRef.current) {
      if (selectedSeason !== seasonInfo.current) {
        setSelectedSeason(seasonInfo.current);
      }
      return;
    }
    if (!seasonInfo.options.some((option) => option.key === selectedSeason)) {
      setSelectedSeason(seasonInfo.current);
    }
  }, [seasonInfo, selectedSeason]);

  const seasonSelectOptions = useMemo<SelectOption[]>(
    () =>
      seasonInfo.options.map((option) => ({
        value: option.key,
        label: option.label,
      })),
    [seasonInfo],
  );

  // 記録対象の年・月プルダウン（シーズンをまたぐ A/W は2年にまたがる）。
  const recordYearOptions = useMemo<SelectOption[]>(() => {
    const years = [...new Set(recordMonthKeys.map(monthKeyYear))];
    return years.map((year) => ({ value: String(year), label: `${year}年` }));
  }, [recordMonthKeys]);

  const selectedRecordYear = selectedMonthKey
    ? monthKeyYear(selectedMonthKey)
    : new Date().getFullYear();

  const recordMonthOptions = useMemo<SelectOption[]>(
    () =>
      recordMonthKeys
        .filter((monthKey) => monthKeyYear(monthKey) === selectedRecordYear)
        .map((monthKey) => ({
          value: monthKey,
          label: monthColumnLabel(monthKey),
        })),
    [recordMonthKeys, selectedRecordYear],
  );

  // 選択中KPI × 月の記録値。上書きがあれば「入力済み」、無ければ自動計算値。
  const monthlyRecordRows = useMemo(() => {
    const kpiKey = selectedDefinition.key;
    const unit = selectedUnit;
    const seasonTarget = parseTargetNumericValue(
      targetData?.values[selectedDefinition.targetKey]?.[selectedSeason] ?? "",
      selectedDefinition.direction,
    );
    const monthlyTarget = seasonTarget === null ? null : seasonTarget / 6;

    return recordMonthKeys.map((monthKey) => {
      const override = parseNumericInput(getKpiCellValue(monthKey, kpiKey));
      const computed = kpiComputedByMonth[monthKey]?.[kpiKey] ?? null;
      const actual = override ?? computed;
      const percent =
        actual !== null && monthlyTarget !== null
          ? calculateProgressPercent(
              actual,
              monthlyTarget,
              selectedDefinition.direction,
            )
          : null;

      return {
        monthKey,
        monthLabel: monthColumnLabel(monthKey),
        actualText: actual === null ? "—" : formatKpiValue(actual, unit),
        targetText:
          monthlyTarget === null ? "—" : formatKpiValue(monthlyTarget, unit),
        percentText: percent === null ? "—" : `${percent.toFixed(1)}%`,
        state:
          override !== null
            ? "入力済み"
            : actual !== null
              ? "自動取得"
              : "未記録",
      };
    });
  }, [
    recordMonthKeys,
    selectedDefinition,
    selectedUnit,
    selectedSeason,
    targetData,
    getKpiCellValue,
    kpiComputedByMonth,
  ]);

  // 選択中の月の自動計算値（「算出元」欄と入力欄のプレースホルダ）。
  const selectedMonthAutoValue = useMemo(() => {
    const computed =
      kpiComputedByMonth[selectedMonthKey]?.[selectedDefinition.key] ?? null;
    return computed === null ? null : formatKpiValue(computed, selectedUnit);
  }, [kpiComputedByMonth, selectedMonthKey, selectedDefinition, selectedUnit]);

  // 「算出元」欄の説明。注文由来の指標は自動取得、SNS・広告系は手入力の元データから算出する。
  const selectedSourceLabel = selectedDefinition.connectedKey
    ? "注文実績から自動取得"
    : "手入力データから算出";

  // インサイト：直近期間の増減と、目標までの残り。
  const insight = useMemo(() => {
    const current = trendActualValues[trendActualValues.length - 1] ?? null;
    if (current === null || !selectedCard) {
      return null;
    }
    const adjacentPair = latestAdjacentRecordedPair(trendActualValues);
    const previous = adjacentPair?.previous ?? null;
    const changeRate =
      previous !== null && previous > 0
        ? ((current - previous) / previous) * 100
        : null;
    const remaining =
      selectedCard.currentValue !== null && selectedCard.targetValue !== null
        ? selectedCard.targetValue - selectedCard.currentValue
        : null;

    return {
      comparisonLabel: TREND_COMPARISON_LABELS[trendGranularity],
      changeText:
        changeRate === null
          ? null
          : `${changeRate >= 0 ? "+" : ""}${changeRate.toFixed(1)}%`,
      isPositive: changeRate !== null && changeRate >= 0,
      remainingText:
        remaining === null || remaining <= 0
          ? null
          : formatKpiValue(remaining, selectedUnit),
    };
  }, [trendActualValues, selectedCard, trendGranularity, selectedUnit]);

  const handleRefresh = useCallback(() => {
    onRetry();
    void fetchKpiTargets();
    void fetchMonthlyRecord(selectedSeason);
  }, [onRetry, fetchKpiTargets, fetchMonthlyRecord, selectedSeason]);

  // ヘッダー（見出し・シーズン・同期状態・更新）。読み込み中／エラー時も同じ行を出す。
  const header = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-3">
        <h2 className="font-acumin text-xl tracking-widest text-black">
          KPIダッシュボード
        </h2>
        <p className="font-acumin text-xs text-[#888888]">
          カードを選択して、目標・推移・月次記録を一画面で管理
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SingleSelect
          variant="dropdown"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          aria-label="対象シーズン"
          options={seasonSelectOptions}
          value={selectedSeason}
          onValueChange={(value) => {
            seasonManuallySelectedRef.current = true;
            setSelectedSeason(value);
          }}
        />
        <StatusBadge
          shape="rounded"
          size="2xs"
          height="control"
          className={`font-acumin ${errorMessage ? "text-red-700" : "text-[#16844b]"}`}
        >
          <span className="inline-flex items-center gap-1.5" role="status">
            <StatusBadge
              variant="dot"
              tone={
                isLoading ? "neutral" : errorMessage ? "danger" : "positive"
              }
              accent={!isLoading}
              size="4xs"
            />
            {isLoading
              ? "読み込み中"
              : errorMessage
                ? "同期エラー"
                : "同期済み"}
          </span>
        </StatusBadge>
        <Button
          variant="outline"
          size="2xs"
          shape="rounded"
          className="font-acumin"
          onClick={handleRefresh}
          disabled={isLoading}
        >
          <i className="ri-refresh-line mr-1" aria-hidden="true" />
          更新
        </Button>
      </div>
    </div>
  );

  if (isLoading || errorMessage || !data || !selectedCard) {
    return (
      <section>
        {header}
        <Panel radius="rounded">
          {isLoading ? (
            <p className="font-acumin text-sm text-[#474747]">
              KPIを読み込み中...
            </p>
          ) : errorMessage ? (
            <div className="space-y-4">
              <p className="font-acumin text-sm text-red-700">{errorMessage}</p>
              <Button
                variant="secondary"
                size="sm"
                className="font-acumin"
                onClick={onRetry}
              >
                再取得
              </Button>
            </div>
          ) : (
            <p className="font-acumin text-sm text-[#474747]">
              KPIデータがありません。
            </p>
          )}
        </Panel>
      </section>
    );
  }

  return (
    <section>
      {header}
      {/* 広い画面ではKPI一覧を4列に広げ、その分だけ右カラム（推移グラフ）を狭める。 */}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,780px)_minmax(0,1fr)]">
        {/* 左：KPI一覧。カードを選ぶと右側の詳細が切り替わる。 */}
        <Panel
          radius="rounded"
          title="KPI一覧"
          className="min-w-0"
          headerWrap={false}
          actions={
            <Button
              variant="outline"
              size="3xs"
              shape="rounded"
              className="shrink-0 font-acumin"
              aria-expanded={isFunnelOpen}
              onClick={() => setIsFunnelOpen((value) => !value)}
            >
              {isFunnelOpen ? "閉じる" : "ファネルを表示"}
              <i
                className={`${isFunnelOpen ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} ml-1`}
                aria-hidden="true"
              />
            </Button>
          }
        >
          <div className="space-y-3">
            <MetaKpiConnection
              season={selectedSeason}
              onSynced={() => void fetchMonthlyRecord(selectedSeason)}
            />
            <KpiSalesFunnel
              metrics={kpiCards}
              selectedKey={selectedCard.key}
              onSelect={setSelectedKpiKey}
              isOpen={isFunnelOpen}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {KPI_CATEGORY_FILTERS.map((filter) => (
                  <Button
                    key={filter}
                    variant="outline"
                    size="3xs"
                    shape="rounded"
                    selected={filter === categoryFilter}
                    className="font-acumin tracking-wider"
                    onClick={() => setCategoryFilter(filter)}
                  >
                    {filter}
                  </Button>
                ))}
              </div>
              <Button
                variant="outline"
                size="3xs"
                shape="rounded"
                iconOnly
                className="shrink-0"
                aria-label="KPIを検索"
                aria-pressed={isKpiSearchOpen}
                onClick={() => {
                  setIsKpiSearchOpen((prev) => !prev);
                  setKpiKeyword("");
                }}
              >
                <i className="ri-search-line" aria-hidden="true" />
              </Button>
            </div>

            {isKpiSearchOpen ? (
              <SearchField
                label=""
                size="sm"
                placeholder="KPI名で絞り込み"
                value={kpiKeyword}
                onChange={(event) => setKpiKeyword(event.target.value)}
                showClearButton
                onClear={() => setKpiKeyword("")}
                className="font-acumin"
              />
            ) : null}

            {/* ツールチップが切れないよう、一覧に overflow を持たせない（ページ側でスクロールする）。 */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 2xl:grid-cols-4">
              {visibleCards.map((card) => (
                <KpiListCard
                  key={card.key}
                  card={card}
                  isSelected={card.key === selectedCard.key}
                  onSelect={() => setSelectedKpiKey(card.key)}
                />
              ))}
            </div>

            {visibleCards.length === 0 ? (
              <p className="font-acumin text-xs text-[#888888]">
                該当するKPIがありません。
              </p>
            ) : null}
          </div>
        </Panel>

        {/* 右：選択中KPIの目標・推移・月次記録。 */}
        <div className="min-w-0 space-y-4">
          {/* 目標サマリー（1/3）と推移グラフ（2/3）を横に並べる。
					    items-start を付けず、2枚の枠の下端をそろえる。 */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Panel radius="rounded">
              {/* 幅が1/3なので、現在値・目標・達成率は縦に積む。 */}
              <div className="space-y-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <KpiIcon card={selectedCard} className="h-10 w-10" />
                  <div className="min-w-0">
                    <p className="truncate font-acumin text-base tracking-widest text-black">
                      {selectedCard.label}
                    </p>
                    <TagLabel
                      variant="subtle"
                      size="3xs"
                      rounded
                      className="mt-1 font-acumin"
                    >
                      {selectedCard.category}
                    </TagLabel>
                  </div>
                </div>

                <div className="min-w-0 space-y-3 border-t border-[#ededed] pt-3">
                  <div className="min-w-0">
                    <p className="font-acumin text-2.75 text-[#888888]">
                      現在値
                    </p>
                    <p className="mt-1 font-acumin text-xl leading-none text-black tabular-nums">
                      {selectedCard.valueText}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-acumin text-2.75 text-[#888888]">目標</p>
                    {isTargetEditing ? (
                      <div className="mt-1 flex items-center gap-1.5">
                        <TextField
                          size="2xs"
                          shape="rounded"
                          className="font-acumin"
                          aria-label={`${selectedCard.label}の目標値`}
                          value={editingTargetValue}
                          disabled={isTargetSaving}
                          onChange={(event) =>
                            setEditingTargetValue(event.target.value)
                          }
                        />
                        <Button
                          variant="primary"
                          size="2xs"
                          shape="rounded"
                          iconOnly
                          aria-label="目標を保存"
                          disabled={isTargetSaving}
                          onClick={() => void handleTargetSave()}
                        >
                          <i className="ri-check-line" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="outline"
                          size="2xs"
                          shape="rounded"
                          iconOnly
                          aria-label="編集をキャンセル"
                          disabled={isTargetSaving}
                          onClick={handleTargetEditCancel}
                        >
                          <i className="ri-close-line" aria-hidden="true" />
                        </Button>
                      </div>
                    ) : (
                      <p className="mt-1 font-acumin text-xl leading-none text-black tabular-nums">
                        {selectedCard.targetText}
                      </p>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-acumin text-2.75 text-[#888888]">
                      達成率
                    </p>
                    <p className="mt-1 font-acumin text-xl leading-none text-black tabular-nums">
                      {selectedCard.percentText}
                    </p>
                    <ProgressBar
                      percent={selectedCard.percent}
                      className="mt-2"
                    />
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="2xs"
                  shape="rounded"
                  className="w-full font-acumin"
                  disabled={!targetData || isTargetEditing}
                  onClick={handleTargetEditStart}
                >
                  目標を編集
                </Button>
              </div>
              {targetLoadErrorMessage || targetErrorMessage ? (
                <p className="mt-2 font-acumin text-2.75 text-red-700">
                  {targetLoadErrorMessage ?? targetErrorMessage}
                </p>
              ) : null}
            </Panel>

            <Panel
              radius="rounded"
              title={`${selectedCard.label}推移`}
              actions={
                <TabSegmentControl
                  variant="segment-pill"
                  size="3xs"
                  items={TREND_GRANULARITY_OPTIONS.map((option) => ({
                    key: option.key,
                    label: option.label,
                  }))}
                  activeKey={trendGranularity}
                  onChange={(key) =>
                    setTrendGranularity(key as TrendGranularity)
                  }
                />
              }
            >
              {trendSeries.length > 0 && trendGraphSeries.length > 0 ? (
                <Graph
                  variant="line"
                  size="sm"
                  categories={trendSeries.map((point) => point.label)}
                  series={trendGraphSeries}
                  plotHeight={170}
                  // 実描画幅に近い設計幅を渡し、SVGの拡大で軸ラベルと線が太らないようにする。
                  plotWidth={320}
                  // 目盛りラベルの長さに合わせて左余白を決める（「¥80」のような短い単位で作図領域を広く使う）。
                  plotPadLeft="auto"
                  formatAxisValue={(value) =>
                    formatKpiValue(value, selectedUnit)
                  }
                  ariaLabel={`${selectedCard.label}の推移グラフ`}
                  legendClassName="font-acumin"
                />
              ) : (
                <p className="font-acumin text-xs text-[#474747]">
                  表示できるデータがありません。
                </p>
              )}
            </Panel>
          </div>

          {/* 入力（1/3）と記録一覧（2/3）も同じ比率で横に並べる。 */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Panel
              radius="rounded"
              title="月次記録を入力"
              actions={
                <>
                  <SingleSelect
                    variant="dropdown"
                    size="3xs"
                    shape="rounded"
                    className="font-acumin"
                    aria-label="記録対象の年"
                    options={recordYearOptions}
                    value={String(selectedRecordYear)}
                    onValueChange={(value) => {
                      const nextMonth = recordMonthKeys.find((monthKey) =>
                        monthKey.startsWith(value),
                      );
                      if (nextMonth) {
                        setSelectedMonthKey(nextMonth);
                      }
                    }}
                  />
                  <SingleSelect
                    variant="dropdown"
                    size="3xs"
                    shape="rounded"
                    className="font-acumin"
                    aria-label="記録対象の月"
                    options={recordMonthOptions}
                    value={selectedMonthKey}
                    onValueChange={setSelectedMonthKey}
                  />
                </>
              }
            >
              <div className="space-y-3">
                {/* 1/3幅では3列に入りきらないため、広い画面では縦に積む。 */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.2fr_1fr_1fr] xl:grid-cols-1">
                  <div>
                    <p className="mb-1 font-acumin text-2.75 text-[#888888]">
                      実績値
                    </p>
                    <TextField
                      size="2xs"
                      shape="rounded"
                      inputMode="decimal"
                      className="font-acumin tabular-nums"
                      aria-label={`${selectedCard.label}の実績値`}
                      placeholder={selectedMonthAutoValue ?? "—"}
                      value={getKpiCellValue(
                        selectedMonthKey,
                        selectedDefinition.key,
                      )}
                      onChange={(event) =>
                        handleRecordValueChange(
                          selectedMonthKey,
                          kpiOverrideStorageKey(selectedDefinition.key),
                          event.target.value,
                        )
                      }
                    />
                  </div>
                  <div>
                    <p className="mb-1 font-acumin text-2.75 text-[#888888]">
                      算出元
                    </p>
                    <div className="flex items-center gap-1.5 rounded-lg border border-[#e8e8e8] p-2">
                      <p className="min-w-0 flex-1 font-acumin text-2.75 leading-snug text-[#474747]">
                        {selectedSourceLabel}
                      </p>
                      <span className="shrink-0 rounded-full bg-[#ededed] px-1.5 py-0.5 font-acumin text-2.5 tracking-wider text-[#888888]">
                        自動
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 font-acumin text-2.75 text-[#888888]">
                      算出式
                    </p>
                    <div className="rounded-lg border border-[#e8e8e8] p-2">
                      <p className="font-acumin text-2.75 leading-snug text-[#474747]">
                        {KPI_FORMULA_BY_KEY.get(selectedDefinition.key)
                          ?.formulaText ?? "—"}
                      </p>
                    </div>
                  </div>
                </div>

                {recordErrorMessage ? (
                  <p className="whitespace-pre-line font-acumin text-2.75 text-red-700">
                    {recordErrorMessage}
                  </p>
                ) : null}
                {recordSuccessMessage ? (
                  <p className="font-acumin text-2.75 text-green-700">
                    {recordSuccessMessage}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button
                    variant="primary"
                    size="sm"
                    shape="rounded"
                    className="font-acumin"
                    onClick={() => void handleSaveMonthlyRecord()}
                    disabled={
                      !hasRecordChanges || isRecordSaving || isRecordLoading
                    }
                  >
                    {isRecordSaving ? "保存中..." : "記録を保存"}
                  </Button>
                  <Button
                    variant="link"
                    size="2xs"
                    className="font-acumin"
                    onClick={() => setIsSourceDrawerOpen(true)}
                  >
                    算出元データを確認
                  </Button>
                </div>
              </div>
            </Panel>

            <Panel
              radius="rounded"
              title="月次記録"
              actions={
                <span className="font-acumin text-2.75 text-[#888888]">
                  自動取得値は上書きできます
                </span>
              }
            >
              <DataTable
                size="3xs"
                shape="rounded"
                rows={monthlyRecordRows}
                rowKey={(row) => row.monthKey}
                emptyLabel="月次記録がありません。"
                rowClassName={(row) =>
                  row.monthKey === selectedMonthKey ? "bg-[#fafafa]" : ""
                }
                columns={[
                  {
                    key: "month",
                    header: "月",
                    cellClassName: "whitespace-nowrap",
                    render: (row) => row.monthLabel,
                  },
                  {
                    key: "actual",
                    header: "実績",
                    align: "right",
                    cellClassName: "tabular-nums",
                    render: (row) => row.actualText,
                  },
                  {
                    key: "target",
                    header: "目標",
                    align: "right",
                    cellClassName: "tabular-nums",
                    render: (row) => row.targetText,
                  },
                  {
                    key: "percent",
                    header: "達成率",
                    align: "right",
                    cellClassName: "tabular-nums",
                    render: (row) => row.percentText,
                  },
                  {
                    key: "state",
                    header: "状態",
                    align: "center",
                    cellClassName: "whitespace-nowrap",
                    render: (row) => (
                      <StatusBadge
                        variant="text"
                        shape="pill"
                        size="3xs"
                        className="font-acumin"
                      >
                        {row.state}
                      </StatusBadge>
                    ),
                  },
                ]}
              />
            </Panel>
          </div>

          <Panel radius="rounded">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <i
                  className="ri-lightbulb-line text-lg text-[#474747]"
                  aria-hidden="true"
                />
                <p className="font-acumin text-sm tracking-widest text-black">
                  インサイト
                </p>
              </div>
              <p className="min-w-0 flex-1 font-acumin text-xs text-[#474747]">
                {insight?.changeText ? (
                  <>
                    {selectedCard.label}は{insight.comparisonLabel}{" "}
                    <span
                      className={
                        insight.isPositive ? "text-green-700" : "text-red-700"
                      }
                    >
                      {insight.changeText}
                    </span>
                    。
                  </>
                ) : (
                  <>{selectedCard.label}の比較データがまだありません。</>
                )}
                {insight?.remainingText ? (
                  <> 目標まで {insight.remainingText}</>
                ) : null}
              </p>
              <Button
                variant="link"
                size="sm"
                className="shrink-0 font-acumin"
                onClick={() => setIsBreakdownDrawerOpen(true)}
              >
                内訳を見る
                <i className="ri-arrow-right-s-line ml-1" aria-hidden="true" />
              </Button>
            </div>
          </Panel>
        </div>
      </div>

      {/* 算出元データ：シーズン6ヶ月の入力グリッド（源データとKPIの上書き）。 */}
      <Drawer
        open={isSourceDrawerOpen}
        onClose={() => setIsSourceDrawerOpen(false)}
        side="right"
        shape="rounded"
        className="flex w-[min(96vw,880px)] flex-col bg-white"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#d4d4d4] px-5 py-4">
          <div>
            <p className="font-acumin text-sm tracking-widest text-black">
              月次記録の算出元
            </p>
            <p className="font-acumin text-xs text-[#474747]">
              {formatSeasonRangeLabel(selectedSeason)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="font-acumin"
              onClick={() => void fetchMonthlyRecord(selectedSeason)}
            >
              再取得
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="font-acumin"
              onClick={() => void handleSaveMonthlyRecord()}
              disabled={!hasRecordChanges || isRecordSaving || isRecordLoading}
            >
              {isRecordSaving ? "保存中..." : "保存"}
            </Button>
            <Button
              variant="outline"
              size="2xs"
              shape="rounded"
              iconOnly
              aria-label="算出元データを閉じる"
              onClick={() => setIsSourceDrawerOpen(false)}
            >
              <i className="ri-close-line" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <Panel
            radius="rounded"
            title="算出元データ"
            actions={
              <span className="font-acumin text-2.75 text-[#888888]">
                月別の実績値
              </span>
            }
          >
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-140 border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    <th className="sticky left-0 z-20 min-w-42 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]">
                      項目
                    </th>
                    {recordMonthKeys.map((monthKey) => (
                      <th
                        key={monthKey}
                        className="whitespace-nowrap px-1.5 py-2 text-right font-acumin text-xs text-[#474747]"
                      >
                        {monthColumnLabel(monthKey)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SOURCE_METRICS.map((metric: SourceMetricDef) => (
                    <tr
                      key={metric.key}
                      className="border-b border-[#ededed] align-top"
                    >
                      <td className="sticky left-0 z-10 min-w-42 bg-white py-2 pr-3 font-acumin text-xs text-black">
                        <span className="flex items-center gap-1.5">
                          {metric.label}
                          <span className="rounded-full bg-[#ededed] px-1.5 py-0.5 font-acumin text-2.5 tracking-wider text-[#888888]">
                            {metric.group === "order" ? "自動" : "手入力"}
                          </span>
                        </span>
                      </td>
                      {recordMonthKeys.map((monthKey) => {
                        const autoValue =
                          metric.group === "order"
                            ? orderAutoByMonth[monthKey]?.[metric.key]
                            : undefined;
                        const placeholder =
                          autoValue !== undefined
                            ? formatKpiValue(autoValue, metric.unit)
                            : metric.unit;
                        return (
                          <td
                            key={`${metric.key}-${monthKey}`}
                            className="px-1.5 py-2"
                          >
                            <input
                              type="text"
                              inputMode="decimal"
                              className="w-full min-w-16 rounded-md border border-[#d4d4d4] px-2 py-1 text-right font-acumin text-xs text-black tabular-nums focus:border-black focus:outline-none"
                              value={getSourceCellValue(monthKey, metric.key)}
                              onChange={(event) =>
                                handleRecordValueChange(
                                  monthKey,
                                  sourceStorageKey(metric.key),
                                  event.target.value,
                                )
                              }
                              placeholder={placeholder}
                              aria-label={`${metric.label} ${monthColumnLabel(monthKey)}の値`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            radius="rounded"
            title="KPI（自動計算）"
            actions={
              <span className="font-acumin text-2.75 text-[#888888]">
                全{MONTHLY_KPI_FORMULAS.length}指標
              </span>
            }
          >
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-140 border-collapse">
                <thead>
                  <tr className="border-b border-[#d4d4d4]">
                    <th className="sticky left-0 z-20 min-w-42 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]">
                      KPI
                    </th>
                    {recordMonthKeys.map((monthKey) => (
                      <th
                        key={monthKey}
                        className="whitespace-nowrap px-1.5 py-2 text-right font-acumin text-xs text-[#474747]"
                      >
                        {monthColumnLabel(monthKey)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MONTHLY_KPI_FORMULAS.map((formula) => (
                    <tr
                      key={formula.key}
                      className="border-b border-[#ededed] align-top"
                    >
                      <td
                        className="sticky left-0 z-10 min-w-42 bg-white py-2 pr-3 font-acumin text-xs text-black"
                        title={`算出式: ${formula.formulaText}`}
                      >
                        {formula.label}
                      </td>
                      {recordMonthKeys.map((monthKey) => {
                        const computed =
                          kpiComputedByMonth[monthKey]?.[formula.key] ?? null;
                        return (
                          <td
                            key={`${formula.key}-${monthKey}`}
                            className="px-1.5 py-2"
                          >
                            <input
                              type="text"
                              inputMode="decimal"
                              className="w-full min-w-16 rounded-md border border-[#d4d4d4] px-2 py-1 text-right font-acumin text-xs text-black tabular-nums focus:border-black focus:outline-none"
                              value={getKpiCellValue(monthKey, formula.key)}
                              onChange={(event) =>
                                handleRecordValueChange(
                                  monthKey,
                                  kpiOverrideStorageKey(formula.key),
                                  event.target.value,
                                )
                              }
                              placeholder={
                                computed === null
                                  ? "—"
                                  : formatKpiValue(
                                      computed,
                                      KPI_UNIT_BY_KEY[formula.key] ?? "",
                                    )
                              }
                              aria-label={`${formula.label} ${monthColumnLabel(monthKey)}の記録値（上書き）`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <p className="font-acumin text-xs text-[#888888]">
            ※ 対象シーズンはヘッダーのシーズン選択（例: 2026 S/S =
            4〜9月）で切り替えます。注文系の元データは各月の注文実績から自動取得し、空欄なら自動値、入力するとその値で上書きします。
          </p>
          <p className="font-acumin text-xs text-[#888888]">
            ※
            SNS・広告系の元データ（リーチ数・広告費など）は手入力です。Instagram等のAPI自動取得は今後対応予定です。
          </p>
        </div>
      </Drawer>

      {/* 内訳：全KPIの期間別推移。 */}
      <Drawer
        open={isBreakdownDrawerOpen}
        onClose={() => setIsBreakdownDrawerOpen(false)}
        side="right"
        shape="rounded"
        className="flex w-[min(96vw,880px)] flex-col bg-white"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#d4d4d4] px-5 py-4">
          <div>
            <p className="font-acumin text-sm tracking-widest text-black">
              KPI一覧の内訳
            </p>
            <p className="font-acumin text-xs text-[#474747]">
              全{trendTableRows.length}指標の期間別推移
            </p>
          </div>
          <Button
            variant="outline"
            size="2xs"
            shape="rounded"
            iconOnly
            aria-label="内訳を閉じる"
            onClick={() => setIsBreakdownDrawerOpen(false)}
          >
            <i className="ri-close-line" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          <table className="w-full min-w-105 border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d4]">
                <th className="sticky left-0 top-0 z-30 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]">
                  KPI
                </th>
                {trendSeries.map((point) => (
                  <th
                    key={point.label}
                    className="sticky top-0 z-20 whitespace-nowrap bg-white px-1.5 py-2 text-right font-acumin text-xs text-[#474747]"
                  >
                    {point.label}
                  </th>
                ))}
                <th className="sticky top-0 z-20 whitespace-nowrap bg-white py-2 pl-3 text-right font-acumin text-xs text-[#474747]">
                  成長率(CAGR)
                </th>
              </tr>
            </thead>
            <tbody>
              {trendTableRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-[#ededed] align-top"
                >
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white py-2 pr-3 font-acumin text-xs text-black">
                    <span className="flex items-center gap-1.5">
                      {row.label}
                      {row.isSample ? (
                        <span className="rounded-full bg-[#ededed] px-1.5 py-0.5 font-acumin text-2.5 tracking-wider text-[#888888]">
                          参考
                        </span>
                      ) : null}
                    </span>
                  </td>
                  {trendSeries.map((point, index) => (
                    <td
                      key={`${row.key}-${point.label}`}
                      className="whitespace-nowrap px-1.5 py-2 text-right font-acumin text-xs text-black tabular-nums"
                    >
                      {row.values[index] === null
                        ? "—"
                        : formatKpiValue(row.values[index], row.unit)}
                    </td>
                  ))}
                  <td className="whitespace-nowrap py-2 pl-3 text-right font-acumin text-xs text-black tabular-nums">
                    {row.cagr === null
                      ? "—"
                      : `${(row.cagr * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Drawer>
    </section>
  );
}
