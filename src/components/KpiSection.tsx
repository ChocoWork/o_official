import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl/TabSegmentControl';
import type { SelectOption } from '@/components/ui/types';
import { clientFetch } from '@/lib/client-fetch';

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

type KpiPriority = '◎' | '○' | '△';

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

type KpiProgressDirection = 'atLeast' | 'atMost';

const KPI_SUB_TABS = [
	{ key: 'progress', label: '目標 & 進捗' },
	{ key: 'trend', label: '過去推移' },
	{ key: 'targets', label: '月次記録' },
	{ key: 'cost', label: 'コスト & 利益' },
] as const;

type KpiSubTabKey = (typeof KPI_SUB_TABS)[number]['key'];

// シーズン切替は表示のみ（データ連動なし）。
const KPI_SEASON_OPTIONS = [
	{ key: '2026SS', label: '2026 S/S' },
	{ key: '2026AW', label: '2026 A/W' },
	{ key: '2027SS', label: '2027 S/S' },
	{ key: '2027AW', label: '2027 A/W' },
	{ key: '2028SS', label: '2028 S/S' },
] as const;

// バックエンド実データに接続済みの指標。
const CONNECTED_KPI_METRICS: Record<
	string,
	{ value: (metric: PeriodKpiMetrics) => number; formatted: (metric: PeriodKpiMetrics) => string; targetKey: string }
> = {
	cvr: { value: (metric) => metric.cvr, formatted: (metric) => metric.formattedCvr, targetKey: 'cvr' },
	aov: { value: (metric) => metric.aov, formatted: (metric) => metric.formattedAov, targetKey: 'aov' },
	set_purchase_rate: {
		value: (metric) => metric.setPurchaseRate,
		formatted: (metric) => metric.formattedSetPurchaseRate,
		targetKey: 'set_purchase_rate',
	},
	sales: { value: (metric) => metric.salesAmount, formatted: (metric) => metric.formattedSales, targetKey: 'sales' },
	inventory_turnover: {
		value: (metric) => metric.inventoryConsumptionRate,
		formatted: (metric) => metric.formattedInventoryConsumptionRate,
		targetKey: 'inventory_turnover',
	},
	ltv: { value: (metric) => metric.ltv, formatted: (metric) => metric.formattedLtv, targetKey: 'ltv' },
	repeat_rate: {
		value: (metric) => metric.repeatRate,
		formatted: (metric) => metric.formattedRepeatRate,
		targetKey: 'repeat_rate',
	},
	return_rate: {
		value: (metric) => metric.returnRate,
		formatted: (metric) => metric.formattedReturnRate,
		targetKey: 'return_rate',
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
	direction: KpiProgressDirection;
	targetKey: string; // admin_kpi_targets.kpi_key（目標編集の保存先）
	connectedKey?: string;
	sample?: KpiCardSample;
};

// サンプル用スパークライン（参考値カードの装飾）。
const SPARK_UP = [40, 46, 43, 51, 56, 60, 66, 72];
const SPARK_STRONG = [28, 36, 41, 47, 55, 62, 70, 80];
const SPARK_GENTLE = [48, 51, 49, 54, 52, 57, 55, 60];
const SPARK_COST = [72, 68, 63, 60, 57, 54, 52, 49];

const KPI_CARD_DEFINITIONS: KpiCardDefinition[] = [
	{ key: 'reach', label: 'リーチ数', unitLabel: '目標人', icon: 'ri-radar-line', direction: 'atLeast', targetKey: 'reach', sample: { valueText: '128,450', targetText: '200,000 人', percent: 64.2, spark: SPARK_UP } },
	{ key: 'save_rate', label: '保存率', unitLabel: '目標%', icon: 'ri-bookmark-line', direction: 'atLeast', targetKey: 'save_rate', sample: { valueText: '18.6%', targetText: '25.0%', percent: 74.4, spark: SPARK_STRONG } },
	{ key: 'profile_rate', label: 'プロフィール遷移率', unitLabel: '目標%', icon: 'ri-user-shared-line', direction: 'atLeast', targetKey: 'profile_transition_rate', sample: { valueText: '6.3%', targetText: '10.0%', percent: 63.0, spark: SPARK_UP } },
	{ key: 'story_views', label: 'ストーリー視聴数', unitLabel: '目標回', icon: 'ri-play-circle-line', direction: 'atLeast', targetKey: 'story_views', sample: { valueText: '8,420', targetText: '12,000 回', percent: 70.2, spark: SPARK_UP } },
	{ key: 'story_reach', label: 'ストーリー到達率', unitLabel: '目標%', icon: 'ri-eye-2-line', direction: 'atLeast', targetKey: 'story_reach_rate', sample: { valueText: '42.0%', targetText: '60.0%', percent: 70.0, spark: SPARK_GENTLE } },
	{ key: 'link_click', label: 'リンククリック率', unitLabel: '目標%', icon: 'ri-links-line', direction: 'atLeast', targetKey: 'link_click_rate', sample: { valueText: '2.8%', targetText: '5.0%', percent: 56.0, spark: SPARK_UP } },
	{ key: 'cvr', label: 'CVR', unitLabel: '目標%', icon: 'ri-shopping-cart-2-line', direction: 'atLeast', targetKey: 'cvr', connectedKey: 'cvr' },
	{ key: 'aov', label: '客単価（AOV）', unitLabel: '目標円', icon: 'ri-money-cny-circle-line', direction: 'atLeast', targetKey: 'aov', connectedKey: 'aov' },
	{ key: 'set_purchase_rate', label: 'セット購入率', unitLabel: '目標%', icon: 'ri-stack-line', direction: 'atLeast', targetKey: 'set_purchase_rate', connectedKey: 'set_purchase_rate' },
	{ key: 'sales', label: '売上', unitLabel: '目標円', icon: 'ri-line-chart-line', direction: 'atLeast', targetKey: 'sales', connectedKey: 'sales' },
	{ key: 'inventory_turnover', label: '在庫消化率', unitLabel: '目標%', icon: 'ri-archive-line', direction: 'atLeast', targetKey: 'inventory_turnover', connectedKey: 'inventory_turnover' },
	{ key: 'cpa', label: 'CPA', unitLabel: '目標円', icon: 'ri-focus-3-line', direction: 'atMost', targetKey: 'cpa', sample: { valueText: '¥1,820', targetText: '¥3,000', percent: 60.7, spark: SPARK_COST } },
	{ key: 'roas', label: 'ROAS', unitLabel: '目標倍', icon: 'ri-pie-chart-line', direction: 'atLeast', targetKey: 'roas', sample: { valueText: '3.2倍', targetText: '5.0倍', percent: 64.0, spark: SPARK_STRONG } },
	{ key: 'cpc', label: 'CPC', unitLabel: '目標円', icon: 'ri-cursor-line', direction: 'atMost', targetKey: 'cpc', sample: { valueText: '¥85', targetText: '¥70', percent: 82.4, spark: SPARK_COST } },
	{ key: 'cpm', label: 'CPM', unitLabel: '目標円', icon: 'ri-bar-chart-box-line', direction: 'atMost', targetKey: 'cpm', sample: { valueText: '¥1,240', targetText: '¥1,000', percent: 80.6, spark: SPARK_COST } },
	{ key: 'ltv', label: 'LTV', unitLabel: '目標円', icon: 'ri-user-heart-line', direction: 'atLeast', targetKey: 'ltv', connectedKey: 'ltv' },
	{ key: 'repeat_rate', label: 'リピート率', unitLabel: '目標%', icon: 'ri-repeat-line', direction: 'atLeast', targetKey: 'repeat_rate', connectedKey: 'repeat_rate' },
	{ key: 'return_rate', label: '返品率', unitLabel: '目標%', icon: 'ri-arrow-go-back-line', direction: 'atMost', targetKey: 'return_rate', connectedKey: 'return_rate' },
	{ key: 'exit_rate', label: '離脱率', unitLabel: '目標%', icon: 'ri-logout-box-r-line', direction: 'atMost', targetKey: 'dropoff_rate', sample: { valueText: '48.0%', targetText: '40.0%', percent: 83.3, spark: SPARK_COST } },
];

// 各指標の平易な説明（用語を知らないオーナー向けのツールチップ文）。key は KPI_CARD_DEFINITIONS.key に対応。
const KPI_DESCRIPTIONS: Record<string, string> = {
	reach: '投稿や広告が届いた人数。どれだけの人の目に触れたかを表す',
	save_rate: '投稿を見た人のうち、後で見返すために保存した人の割合',
	profile_rate: '投稿を見た人のうち、プロフィールを訪れた人の割合',
	story_views: 'ストーリーが再生された回数',
	story_reach: 'ストーリーがフォロワーのうち何割に届いたか',
	link_click: 'プロフィールや投稿のリンクがクリックされた割合',
	cvr: 'サイトを訪れた人のうち、実際に購入した人の割合（購入率）',
	aov: '1回の注文あたりの平均購入金額',
	set_purchase_rate: '全購入のうち、上下やセットでまとめ買いされた割合',
	sales: '期間内に売れた総額',
	inventory_turnover: '仕入れた在庫のうち、売れた割合',
	cpa: '顧客を1人獲得するのにかかった広告費',
	roas: '広告費に対して何倍の売上になったか（広告費用対効果）',
	cpc: '広告が1回クリックされるのにかかった費用（クリック単価）',
	cpm: '広告を1,000回表示するのにかかった費用（表示単価）',
	ltv: '1人の顧客が生涯を通じて使ってくれる金額の合計（顧客生涯価値）',
	repeat_rate: '一度購入した人が、再び購入してくれた割合',
	return_rate: '購入のうち、返品・キャンセルされた割合',
	exit_rate: 'ページを訪れた人が、何もせず離れた割合',
};

// 過去推移タブの期間粒度。
type TrendGranularity = 'year' | 'season' | 'month';

const TREND_GRANULARITY_OPTIONS: { key: TrendGranularity; label: string }[] = [
	{ key: 'year', label: '年度' },
	{ key: 'season', label: 'シーズン' },
	{ key: 'month', label: '月' },
];

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
type TrendPoint = TrendMetricValues & {
	label: string;
	targetSeasonKeys: string[];
	targetDivisor: number;
};

const YEN_FORMATTER = new Intl.NumberFormat('ja-JP');

function formatSeasonLabel(period: string): string {
	const matched = period.match(/^(\d{4})(SS|AW)$/);
	if (!matched) {
		return period;
	}
	return `${matched[1]} ${matched[2] === 'SS' ? 'S/S' : 'A/W'}`;
}

function seasonSortKey(period: string): number {
	const matched = period.match(/^(\d{4})(SS|AW)$/);
	if (!matched) {
		return 0;
	}
	return Number(matched[1]) * 2 + (matched[2] === 'AW' ? 1 : 0);
}

// 月（暦年 year の monthNumber）が属するシーズンキー。
// SS=4〜9月（当年）、AW=10〜12月（当年）/ 1〜3月（前年AW）。
function seasonKeyForMonth(year: number, monthNumber: number): string {
	if (monthNumber >= 4 && monthNumber <= 9) {
		return `${year}SS`;
	}
	if (monthNumber >= 10) {
		return `${year}AW`;
	}
	return `${year - 1}AW`;
}

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
		return {
			sales: 0,
			aov: 0,
			cvr: 0,
			setPurchaseRate: 0,
			inventoryConsumptionRate: 0,
			ltv: 0,
			repeatRate: 0,
			returnRate: 0,
		};
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

// 推移グラフに出せる実データ（KPI_CARD_DEFINITIONS.connectedKey → TrendPoint の値）。
const TREND_KPI_ACCESSORS: Record<string, (point: TrendPoint) => number> = {
	cvr: (point) => point.cvr,
	aov: (point) => point.aov,
	set_purchase_rate: (point) => point.setPurchaseRate,
	sales: (point) => point.sales,
	inventory_turnover: (point) => point.inventoryConsumptionRate,
	ltv: (point) => point.ltv,
	repeat_rate: (point) => point.repeatRate,
	return_rate: (point) => point.returnRate,
};

// 参考値KPIは期間別データを持たないため、カードと同じサンプル波形を期間数に合わせて標本化する。
function sampleSparkSeries(spark: number[], count: number): number[] {
	if (count <= 0 || spark.length === 0) {
		return [];
	}
	if (count === 1) {
		return [spark[spark.length - 1]];
	}
	return Array.from({ length: count }, (_, index) => spark[Math.round((index * (spark.length - 1)) / (count - 1))]);
}

// 1指標の期間別の値。実データ接続済みは実値、参考値はサンプル波形。グラフとKPI一覧表で共用する。
function kpiSeriesValues(definition: KpiCardDefinition, points: TrendPoint[]): number[] {
	const accessor = definition.connectedKey ? TREND_KPI_ACCESSORS[definition.connectedKey] : undefined;

	if (accessor) {
		return points.map(accessor);
	}

	return sampleSparkSeries(definition.sample?.spark ?? [], points.length);
}

// 単位は KPI_CARD_DEFINITIONS.unitLabel（「目標円」「目標%」等）から接頭辞を落として得る。
function kpiUnit(unitLabel: string): string {
	return unitLabel.replace('目標', '');
}

function formatKpiValue(value: number, unit: string): string {
	if (unit === '円') {
		return `¥${YEN_FORMATTER.format(Math.round(value))}`;
	}
	if (unit === '%') {
		return `${value.toFixed(1)}%`;
	}
	if (unit === '倍') {
		return `${value.toFixed(1)}倍`;
	}
	return `${YEN_FORMATTER.format(Math.round(value))}${unit}`;
}

// 年平均成長率（CAGR）。first→last を (期間数-1) 乗根で年率化する。
function computeCagr(first: number, last: number, periodCount: number): number | null {
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
	icon: string;
	description: string;
	// 月次記録タブの「定義」列（総売上・売上÷注文数 等）。ツールチップに併記する。
	definition: string;
	valueText: string;
	targetText: string;
	percentText: string;
	spark: number[];
	isSample: boolean;
};

function parseTargetNumericValue(targetText: string, direction: KpiProgressDirection): number | null {
	const normalized = targetText.replaceAll(',', '').trim();
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
		const multiplier = match[2] === '億' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
		values.push(base * multiplier);
	}
	if (values.length === 0) {
		return null;
	}

	const hasRange = normalized.includes('〜') || normalized.includes('~') || normalized.includes('-');
	if (hasRange && values.length >= 2) {
		return direction === 'atLeast' ? values[0] : values[1];
	}

	return values[0];
}

function calculateProgressPercent(currentValue: number, targetValue: number, direction: KpiProgressDirection): number | null {
	if (targetValue <= 0) {
		return null;
	}

	if (direction === 'atLeast') {
		return (currentValue / targetValue) * 100;
	}

	if (currentValue <= 0) {
		return 100;
	}

	return (targetValue / currentValue) * 100;
}

function cloneKpiTargetValues(values: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
	const cloned: Record<string, Record<string, string>> = {};

	for (const [kpiKey, seasonValues] of Object.entries(values)) {
		cloned[kpiKey] = { ...seasonValues };
	}

	return cloned;
}

function buildSparklinePoints(data: number[], width: number, height: number): string {
	if (data.length < 2) {
		return '';
	}

	const min = Math.min(...data);
	const max = Math.max(...data);
	const range = max - min;
	const pad = 3;
	const usable = height - pad * 2;
	const stepX = width / (data.length - 1);

	return data
		.map((value, index) => {
			const x = index * stepX;
			const y = range === 0 ? height / 2 : pad + (1 - (value - min) / range) * usable;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(' ');
}

function Sparkline({ data }: { data: number[] }) {
	const width = 96;
	const height = 32;
	const points = buildSparklinePoints(data, width, height);

	if (!points) {
		return <div className="h-8 w-24 shrink-0" aria-hidden="true" />;
	}

	return (
		<svg viewBox={`0 0 ${width} ${height}`} className="h-8 w-24 shrink-0" preserveAspectRatio="none" aria-hidden="true">
			<polyline
				points={points}
				fill="none"
				stroke="#111111"
				strokeWidth={1.25}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

type KpiCardProps = {
	card: ResolvedKpiCard;
	canEdit: boolean;
	isEditing: boolean;
	editingValue: string;
	isSaving: boolean;
	errorMessage: string | null;
	onEditStart: () => void;
	onEditChange: (value: string) => void;
	onEditCancel: () => void;
	onEditSave: () => void;
};

function KpiCard({
	card,
	canEdit,
	isEditing,
	editingValue,
	isSaving,
	errorMessage,
	onEditStart,
	onEditChange,
	onEditCancel,
	onEditSave,
}: KpiCardProps) {
	return (
		<div className="rounded-lg border border-[#e8e8e8] bg-[#fafafa] p-4">
			<div className="mb-3 flex items-center gap-2.5">
				<span
					role="img"
					aria-label={`${card.label}：${card.description}${card.definition ? `（定義: ${card.definition}）` : ''}`}
					className="group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#ededed] text-[#474747]"
				>
					<i className={`${card.icon} text-base`} aria-hidden="true" />
					<span className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 hidden w-max max-w-[220px] rounded-md bg-[#111111] px-2.5 py-1.5 text-left font-acumin text-[11px] font-normal leading-snug text-white shadow-md group-hover:block">
						{card.description}
						{card.definition ? (
							<span className="mt-1 block text-white/70">定義: {card.definition}</span>
						) : null}
					</span>
				</span>
				<div className="min-w-0">
					<p className="truncate font-acumin text-sm text-black">{card.label}</p>
					<p className="font-acumin text-[11px] text-[#888888]">{card.unitLabel}</p>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					{card.isSample ? (
						<span className="rounded-full bg-[#ededed] px-2 py-0.5 font-acumin text-[10px] tracking-wider text-[#888888]">
							参考
						</span>
					) : null}
					{canEdit ? (
						<Button
							variant="outline"
							size="2xs"
							shape="rounded"
							iconOnly
							onClick={onEditStart}
							aria-label={`${card.label}の目標を編集`}
						>
							<i className="ri-pencil-line" aria-hidden="true" />
						</Button>
					) : null}
				</div>
			</div>
			<p className="font-acumin text-2xl leading-none text-black tabular-nums">{card.valueText}</p>
			{isEditing ? (
				<div className="mt-2 space-y-1.5">
					<div className="flex items-center gap-1.5">
						<input
							type="text"
							value={editingValue}
							onChange={(event) => onEditChange(event.target.value)}
							placeholder="目標値"
							aria-label={`${card.label}の目標値`}
							disabled={isSaving}
							className="w-full rounded-none border border-[#d4d4d4] px-2 py-1 font-acumin text-xs text-black focus:border-black focus:outline-none"
						/>
						<Button
							variant="primary"
							size="2xs"
							shape="rounded"
							iconOnly
							className="shrink-0"
							onClick={onEditSave}
							disabled={isSaving}
							aria-label="目標を保存"
						>
							<i className="ri-check-line" aria-hidden="true" />
						</Button>
						<Button
							variant="outline"
							size="2xs"
							shape="rounded"
							iconOnly
							className="shrink-0"
							onClick={onEditCancel}
							disabled={isSaving}
							aria-label="編集をキャンセル"
						>
							<i className="ri-close-line" aria-hidden="true" />
						</Button>
					</div>
					{errorMessage ? <p className="font-acumin text-[11px] text-red-700">{errorMessage}</p> : null}
				</div>
			) : (
				<p className="mt-1 font-acumin text-xs text-[#888888] tabular-nums">/ {card.targetText}</p>
			)}
			<div className="mt-3 flex items-end justify-between gap-2">
				<span className="font-acumin text-xs text-[#474747] tabular-nums">{card.percentText}</span>
				<Sparkline data={card.spark} />
			</div>
		</div>
	);
}

type TrendSeriesPoint = {
	label: string;
	value: number;
};

// 0 起点で「区切りのよい」目盛り上限と刻みを求める（Nice Numbers アルゴリズム）。
function niceNum(range: number, round: boolean): number {
	const exponent = Math.floor(Math.log10(range));
	const fraction = range / Math.pow(10, exponent);
	let niceFraction: number;
	if (round) {
		niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
	} else {
		niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
	}
	return niceFraction * Math.pow(10, exponent);
}

// 0〜maxValue を約 approxCount 分割する、区切りのよい目盛り上限と刻み配列。
function buildNiceTicks(maxValue: number, approxCount = 4): { niceMax: number; ticks: number[] } {
	if (!Number.isFinite(maxValue) || maxValue <= 0) {
		return { niceMax: 1, ticks: [0, 1] };
	}
	const step = niceNum(maxValue / approxCount, true);
	const niceMax = Math.ceil(maxValue / step) * step;
	const ticks: number[] = [];
	for (let value = 0; value <= niceMax + step * 1e-6; value += step) {
		ticks.push(Number(value.toFixed(10)));
	}
	return { niceMax, ticks };
}

// 選択中KPI1指標の推移を、0起点・区切りのよい目盛りで描く折れ線グラフ。
// 目標値があれば破線で重ね、データが1点でも描画する。
function TrendChart({
	points,
	kpiLabel,
	unit,
	targets,
}: {
	points: TrendSeriesPoint[];
	kpiLabel: string;
	unit: string;
	targets: (number | null)[];
}) {
	if (points.length === 0) {
		return <p className="font-acumin text-xs text-[#474747]">表示できるデータがありません。</p>;
	}

	const width = 640;
	const height = 260;
	const padL = 64;
	const padR = 24;
	const padT = 14;
	const padB = 34;
	const plotW = width - padL - padR;
	const plotH = height - padT - padB;
	const xs =
		points.length === 1
			? [padL + plotW / 2]
			: points.map((_, index) => padL + (plotW * index) / (points.length - 1));

	const dataMax = Math.max(...points.map((point) => point.value), 0);
	// 各点の目標（0以下・未設定は無効）。
	const targetAt = points.map((_, index) => {
		const value = targets[index];
		return value !== null && value !== undefined && value > 0 ? value : null;
	});
	const targetMax = Math.max(0, ...targetAt.filter((value): value is number => value !== null));
	const { niceMax, ticks } = buildNiceTicks(Math.max(dataMax, targetMax));
	const yOf = (value: number) => padT + (1 - value / niceMax) * plotH;

	// 目標を「同値の連続区間」にまとめ、粒度に応じた段状の破線で描く。
	const clampX = (x: number) => Math.min(width - padR, Math.max(padL, x));
	const halfStep = points.length >= 2 ? plotW / (points.length - 1) / 2 : plotW * 0.3;
	const targetRuns: { start: number; end: number; value: number }[] = [];
	targetAt.forEach((value, index) => {
		if (value === null) {
			return;
		}
		const last = targetRuns[targetRuns.length - 1];
		if (last && last.end === index - 1 && last.value === value) {
			last.end = index;
		} else {
			targetRuns.push({ start: index, end: index, value });
		}
	});

	return (
		<svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={`${kpiLabel}の推移グラフ`}>
			{ticks.map((tick) => (
				<g key={tick}>
					<line x1={padL} x2={width - padR} y1={yOf(tick)} y2={yOf(tick)} stroke="#ededed" strokeWidth={1} />
					<text x={padL - 8} y={yOf(tick) + 3} textAnchor="end" fill="#888888" fontSize="9">{formatKpiValue(tick, unit)}</text>
				</g>
			))}
			{targetRuns.map((run, runIndex) => {
				const xStart = clampX(xs[run.start] - halfStep);
				const xEnd = clampX(xs[run.end] + halfStep);
				const y = yOf(run.value);
				return (
					<g key={`target-${runIndex}`}>
						<line x1={xStart} x2={xEnd} y1={y} y2={y} stroke="#888888" strokeWidth={1} strokeDasharray="4 3" />
						<text x={(xStart + xEnd) / 2} y={y - 4} textAnchor="middle" fill="#888888" fontSize="9">{`目標 ${formatKpiValue(run.value, unit)}`}</text>
					</g>
				);
			})}
			{points.length >= 2 ? (
				<polyline
					fill="none"
					stroke="#111111"
					strokeWidth={2}
					strokeLinejoin="round"
					strokeLinecap="round"
					points={points.map((point, index) => `${xs[index].toFixed(1)},${yOf(point.value).toFixed(1)}`).join(' ')}
				/>
			) : null}
			{points.map((point, index) => (
				<circle key={`dot-${index}`} cx={xs[index]} cy={yOf(point.value)} r={points.length === 1 ? 3.5 : 2.5} fill="#111111" />
			))}
			{points.map((point, index) => (
				<text key={`x-${index}`} x={xs[index]} y={height - 10} textAnchor="middle" fill="#888888" fontSize="9">{point.label}</text>
			))}
		</svg>
	);
}

export default function KpiSection({ data, isLoading, errorMessage, onRetry }: KpiSectionProps) {
	const [activeSubTab, setActiveSubTab] = useState<KpiSubTabKey>('progress');
	const [selectedSeason, setSelectedSeason] = useState<string>(KPI_SEASON_OPTIONS[0].key);
	const [trendGranularity, setTrendGranularity] = useState<TrendGranularity>('year');
	const [trendKpiKey, setTrendKpiKey] = useState<string>('sales');
	const [targetData, setTargetData] = useState<KpiTargetData | null>(null);
	const [editableTargetValues, setEditableTargetValues] = useState<Record<string, Record<string, string>>>({});
	const [originalTargetValues, setOriginalTargetValues] = useState<Record<string, Record<string, string>>>({});
	const [isTargetLoading, setIsTargetLoading] = useState(false);
	const [isTargetSaving, setIsTargetSaving] = useState(false);
	const [targetErrorMessage, setTargetErrorMessage] = useState<string | null>(null);
	const [targetSuccessMessage, setTargetSuccessMessage] = useState<string | null>(null);

	const fetchKpiTargets = useCallback(async () => {
		try {
			setIsTargetLoading(true);
			setTargetErrorMessage(null);
			setTargetSuccessMessage(null);

			const response = await clientFetch('/api/admin/kpi/targets', {
				cache: 'no-store',
			});

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error('KPI目標の取得に失敗しました。再ログインしてください。');
				}

				if (response.status === 403) {
					throw new Error('KPI目標を編集する権限がありません。');
				}

				throw new Error('KPI目標の取得に失敗しました。');
			}

			const json = (await response.json()) as { data: KpiTargetData };
			const nextValues = cloneKpiTargetValues(json.data.values);

			setTargetData(json.data);
			setEditableTargetValues(nextValues);
			setOriginalTargetValues(cloneKpiTargetValues(nextValues));
		} catch (error) {
			console.error('Failed to fetch KPI targets:', {
				errorType: error instanceof Error ? 'Error' : typeof error,
				errorMessage: error instanceof Error ? error.message : String(error),
				fullError: error,
			});
			setTargetErrorMessage(error instanceof Error ? error.message : 'KPI目標の取得に失敗しました。');
		} finally {
			setIsTargetLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchKpiTargets();
	}, [fetchKpiTargets]);

	const monthlyKpiMap = useMemo(() => {
		if (!data) {
			return new Map<number, PeriodKpiMetrics[]>();
		}

		return new Map<number, PeriodKpiMetrics[]>(
			data.monthlyKpiByYear.map((entry) => [entry.year, entry.metrics]),
		);
	}, [data]);

	// 月次系列は対象年（targetYear）固定。年を選ぶプルダウンは廃止した。
	const monthlyKpiSeries = useMemo(() => {
		if (!data) {
			return [] as PeriodKpiMetrics[];
		}

		return monthlyKpiMap.get(data.targetYear) ?? [];
	}, [data, monthlyKpiMap]);

	// 過去推移タブの系列（粒度別）。年度は月次を年集計、シーズンは seasonalKpi、月は選択年の月次。
	const trendSeries = useMemo<TrendPoint[]>(() => {
		if (!data) {
			return [];
		}

		if (trendGranularity === 'season') {
			return [...data.seasonalKpi]
				.sort((a, b) => seasonSortKey(a.period) - seasonSortKey(b.period))
				.map((metric) => ({
					label: formatSeasonLabel(metric.period),
					targetSeasonKeys: [metric.period],
					targetDivisor: 1,
					...toTrendValues(metric),
				}));
		}

		if (trendGranularity === 'month') {
			return monthlyKpiSeries.map((metric) => {
				const monthNumber = Number.parseInt(metric.period, 10);
				return {
					label: metric.period,
					targetSeasonKeys: [seasonKeyForMonth(data.targetYear, monthNumber)],
					targetDivisor: 6,
					...toTrendValues(metric),
				};
			});
		}

		const currentYear = new Date().getFullYear();
		return [...data.monthlyKpiByYear]
			.sort((a, b) => a.year - b.year)
			.map((entry) => ({
				label: entry.year > currentYear ? `${entry.year}（予定）` : `${entry.year}`,
				targetSeasonKeys: [`${entry.year}SS`, `${entry.year}AW`],
				targetDivisor: 1,
				...aggregateYearMetrics(entry.metrics),
			}));
	}, [data, trendGranularity, monthlyKpiSeries]);

	// 推移グラフに表示する1指標。選択肢はKPIカードと同じ19指標。
	const trendKpiOptions = useMemo<SelectOption[]>(
		() => KPI_CARD_DEFINITIONS.map((definition) => ({ value: definition.key, label: definition.label })),
		[],
	);

	const trendKpiDefinition = useMemo(
		() => KPI_CARD_DEFINITIONS.find((definition) => definition.key === trendKpiKey) ?? KPI_CARD_DEFINITIONS[0],
		[trendKpiKey],
	);

	// 実データ接続済みの指標は期間別の実値、参考値の指標はサンプル波形を期間数に合わせて描く。
	const trendChartPoints = useMemo<TrendSeriesPoint[]>(() => {
		const values = kpiSeriesValues(trendKpiDefinition, trendSeries);
		return trendSeries.map((point, index) => ({ label: point.label, value: values[index] ?? 0 }));
	}, [trendKpiDefinition, trendSeries]);

	// 推移グラフに重ねる目標（点ごと）。粒度で算出を変える：
	// 年度=当年SS+AWの合計、シーズン=当該シーズン、月=該当シーズンを6分割。
	// 実データ接続済みKPIのみ（参考値KPIはグラフが装飾波形のため対象外）。
	const trendTargets = useMemo<(number | null)[]>(() => {
		if (!trendKpiDefinition.connectedKey) {
			return trendSeries.map(() => null);
		}
		const kpiKey = trendKpiDefinition.targetKey;
		const direction = trendKpiDefinition.direction;
		return trendSeries.map((point) => {
			const parsed = point.targetSeasonKeys
				.map((seasonKey) => parseTargetNumericValue(targetData?.values[kpiKey]?.[seasonKey] ?? '', direction))
				.filter((value): value is number => value !== null);
			if (parsed.length === 0) {
				return null;
			}
			const total = parsed.reduce((sum, value) => sum + value, 0);
			return total / point.targetDivisor;
		});
	}, [trendSeries, trendKpiDefinition, targetData]);

	// KPI一覧表の行。プルダウンと同じ19指標を、同じ系列ロジックで並べる。
	const trendTableRows = useMemo(
		() =>
			KPI_CARD_DEFINITIONS.map((definition) => {
				const values = kpiSeriesValues(definition, trendSeries);
				return {
					key: definition.key,
					label: definition.label,
					unit: kpiUnit(definition.unitLabel),
					isSample: !definition.connectedKey,
					values,
					cagr: computeCagr(values[0] ?? 0, values[values.length - 1] ?? 0, values.length),
				};
			}),
		[trendSeries],
	);

	const currentSeasonMetric = useMemo(() => {
		if (!data) {
			return null;
		}

		if (targetData?.currentSeason) {
			const matched = data.seasonalKpi.find((metric) => metric.period === targetData.currentSeason);
			if (matched) {
				return matched;
			}
		}

		return data.seasonalKpi[0] ?? null;
	}, [data, targetData]);

	const kpiCards = useMemo<ResolvedKpiCard[]>(() => {
		const currentSeason = targetData?.currentSeason ?? '';
		// 月次記録タブの定義（kpi_key→定義文）。カードのツールチップに併記するため参照する。
		const definitionByKey = new Map((targetData?.definitions ?? []).map((entry) => [entry.key, entry.definition]));

		return KPI_CARD_DEFINITIONS.map((definition) => {
			const rawTarget = targetData?.values[definition.targetKey]?.[currentSeason] ?? '';
			const targetDefinition = definitionByKey.get(definition.targetKey) ?? '';

			if (definition.connectedKey) {
				const accessor = CONNECTED_KPI_METRICS[definition.connectedKey];
				const metric = currentSeasonMetric;
				const targetNumeric = parseTargetNumericValue(rawTarget, definition.direction);
				const percent =
					metric && targetNumeric !== null
						? calculateProgressPercent(accessor.value(metric), targetNumeric, definition.direction)
						: null;

				return {
					key: definition.key,
					targetKey: definition.targetKey,
					label: definition.label,
					unitLabel: definition.unitLabel,
					icon: definition.icon,
					description: KPI_DESCRIPTIONS[definition.key] ?? '',
					definition: targetDefinition,
					valueText: metric ? accessor.formatted(metric) : '—',
					targetText: rawTarget || '—',
					percentText: percent === null ? '—' : `${percent.toFixed(1)}%`,
					spark: metric ? monthlyKpiSeries.map((entry) => accessor.value(entry)) : [],
					isSample: false,
				};
			}

			const sample = definition.sample as KpiCardSample;

			return {
				key: definition.key,
				targetKey: definition.targetKey,
				label: definition.label,
				unitLabel: definition.unitLabel,
				icon: definition.icon,
				description: KPI_DESCRIPTIONS[definition.key] ?? '',
				definition: targetDefinition,
				valueText: sample.valueText,
				targetText: rawTarget || sample.targetText,
				percentText: `${sample.percent.toFixed(1)}%`,
				spark: sample.spark,
				isSample: true,
			};
		});
	}, [currentSeasonMetric, monthlyKpiSeries, targetData]);

	const hasTargetChanges = useMemo(() => {
		if (!targetData) {
			return false;
		}

		for (const definition of targetData.definitions) {
			for (const season of targetData.seasons) {
				const currentValue = editableTargetValues[definition.key]?.[season] ?? '';
				const originalValue = originalTargetValues[definition.key]?.[season] ?? '';

				if (currentValue !== originalValue) {
					return true;
				}
			}
		}

		return false;
	}, [editableTargetValues, originalTargetValues, targetData]);

	const targetTableLayout = useMemo(() => {
		const seasonCount = targetData?.seasons.length ?? 0;
		const fixedTotal = 44;
		const seasonWidth = seasonCount > 0 ? `${(56 / seasonCount).toFixed(4)}%` : '0%';

		return {
			kpiWidth: '16%',
			definitionWidth: '20%',
			priorityWidth: '8%',
			seasonWidth,
			definitionLeft: '16%',
			priorityLeft: '36%',
			fixedTotal,
		};
	}, [targetData]);

	const handleTargetValueChange = (kpiKey: string, season: string, value: string) => {
		setTargetSuccessMessage(null);
		setEditableTargetValues((prev) => ({
			...prev,
			[kpiKey]: {
				...(prev[kpiKey] ?? {}),
				[season]: value,
			},
		}));
	};

	const handleSaveKpiTargets = useCallback(async () => {
		if (!targetData) {
			return;
		}

		const updates: Array<{ season: string; kpiKey: string; value: string }> = [];

		for (const definition of targetData.definitions) {
			for (const season of targetData.seasons) {
				const currentValue = editableTargetValues[definition.key]?.[season] ?? '';
				const originalValue = originalTargetValues[definition.key]?.[season] ?? '';

				if (currentValue === originalValue) {
					continue;
				}

				updates.push({
					season,
					kpiKey: definition.key,
					value: currentValue,
				});
			}
		}

		if (updates.length === 0) {
			setTargetSuccessMessage('変更はありません。');
			return;
		}

		try {
			setIsTargetSaving(true);
			setTargetErrorMessage(null);
			setTargetSuccessMessage(null);

			const response = await clientFetch('/api/admin/kpi/targets', {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ updates }),
			});

			const responseData = await response.json();

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error('KPI目標の更新に失敗しました。再ログインしてください。');
				}

				if (response.status === 403) {
					throw new Error('KPI目標を編集する権限がありません。');
				}

				if (response.status === 503) {
					const detailsMsg = responseData.details ? `\n詳細: ${responseData.details}` : '';
					throw new Error(`${responseData.error}${detailsMsg}`);
				}

				const details = responseData.details ? `: ${JSON.stringify(responseData.details)}` : '';
				const errorMsg = responseData.error || 'KPI目標の更新に失敗しました。';
				throw new Error(`${errorMsg}${details}`);
			}

			const json = responseData as { data: KpiTargetData };
			const nextValues = cloneKpiTargetValues(json.data.values);

			setTargetData(json.data);
			setEditableTargetValues(nextValues);
			setOriginalTargetValues(cloneKpiTargetValues(nextValues));
			setTargetSuccessMessage('KPI目標を保存しました。');
		} catch (error) {
			let saveErrorMessage = 'KPI目標の更新に失敗しました。';

			if (error instanceof Error) {
				saveErrorMessage = error.message;
			} else if (typeof error === 'string') {
				saveErrorMessage = error;
			} else if (error && typeof error === 'object') {
				try {
					const errorObj = error as Record<string, unknown>;
					if (typeof errorObj.message === 'string') {
						saveErrorMessage = errorObj.message;
					} else if (typeof errorObj.error === 'string') {
						saveErrorMessage = errorObj.error;
					} else {
						saveErrorMessage = JSON.stringify(error, null, 2);
					}
				} catch {
					// keep default message
				}
			}

			console.error('Failed to save KPI targets:', {
				errorType: error instanceof Error ? 'Error' : typeof error,
				errorMessage: saveErrorMessage,
				fullError: error,
			});

			setTargetErrorMessage(saveErrorMessage);
		} finally {
			setIsTargetSaving(false);
		}
	}, [editableTargetValues, originalTargetValues, targetData]);

	// 各カード右上の編集ボタンから、現在シーズンの目標値を直接編集する。
	const [editingCardKey, setEditingCardKey] = useState<string | null>(null);
	const [editingCardValue, setEditingCardValue] = useState('');
	const [isCardTargetSaving, setIsCardTargetSaving] = useState(false);
	const [cardTargetErrorMessage, setCardTargetErrorMessage] = useState<string | null>(null);

	const handleCardEditStart = useCallback(
		(card: ResolvedKpiCard) => {
			const currentSeason = targetData?.currentSeason ?? '';
			const rawTarget = targetData?.values[card.targetKey]?.[currentSeason] ?? '';
			setCardTargetErrorMessage(null);
			setEditingCardValue(rawTarget);
			setEditingCardKey(card.key);
		},
		[targetData],
	);

	const handleCardEditCancel = useCallback(() => {
		setEditingCardKey(null);
		setEditingCardValue('');
		setCardTargetErrorMessage(null);
	}, []);

	const handleCardTargetSave = useCallback(
		async (card: ResolvedKpiCard) => {
			if (!targetData) {
				return;
			}

			const season = targetData.currentSeason;

			try {
				setIsCardTargetSaving(true);
				setCardTargetErrorMessage(null);

				const response = await clientFetch('/api/admin/kpi/targets', {
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ updates: [{ season, kpiKey: card.targetKey, value: editingCardValue }] }),
				});

				const responseData = await response.json();

				if (!response.ok) {
					if (response.status === 401) {
						throw new Error('KPI目標の更新に失敗しました。再ログインしてください。');
					}

					if (response.status === 403) {
						throw new Error('KPI目標を編集する権限がありません。');
					}

					throw new Error(responseData?.error || 'KPI目標の更新に失敗しました。');
				}

				const json = responseData as { data: KpiTargetData };
				const nextValues = cloneKpiTargetValues(json.data.values);

				setTargetData(json.data);
				setEditableTargetValues(nextValues);
				setOriginalTargetValues(cloneKpiTargetValues(nextValues));
				setEditingCardKey(null);
				setEditingCardValue('');
			} catch (error) {
				setCardTargetErrorMessage(error instanceof Error ? error.message : 'KPI目標の更新に失敗しました。');
			} finally {
				setIsCardTargetSaving(false);
			}
		},
		[editingCardValue, targetData],
	);

	// シーズン切替は表示のみ（データ連動なし）。サブタブの下に配置する。
	const seasonSelector = (
		<div className="mb-6 flex flex-wrap items-center gap-1.5">
			{KPI_SEASON_OPTIONS.map((season) => (
				<Button
					key={season.key}
					variant="outline"
					size="2xs"
					shape="rounded"
					selected={season.key === selectedSeason}
					onClick={() => setSelectedSeason(season.key)}
					className="font-acumin tracking-wider"
				>
					{season.label}
				</Button>
			))}
		</div>
	);

	// 過去推移タブでは、シーズンボタンと同じ見た目・位置で期間粒度（年度/シーズン/月）を選ぶ。
	// 「月」選択時は同じ行に、ボタンと同じ見た目のプルダウン（対象年）を並べる。
	const granularitySelector = (
		<div className="mb-6 flex flex-wrap items-center justify-between gap-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				{TREND_GRANULARITY_OPTIONS.map((option) => (
					<Button
						key={option.key}
						variant="outline"
						size="2xs"
						shape="rounded"
						selected={option.key === trendGranularity}
						onClick={() => setTrendGranularity(option.key)}
						className="font-acumin tracking-wider"
					>
						{option.label}
					</Button>
				))}
			</div>
			<SingleSelect
				variant="dropdown"
				size="2xs"
				shape="rounded"
				align="left"
				aria-label="推移グラフに表示するKPI"
				options={trendKpiOptions}
				value={trendKpiKey}
				onValueChange={setTrendKpiKey}
			/>
		</div>
	);

	const subTabBar = (
		<>
			<div className="mb-4 overflow-x-auto border-b border-[#d4d4d4]">
				<TabSegmentControl
					variant="tabs-standard"
					size="md"
					items={KPI_SUB_TABS.map((tab) => ({ key: tab.key, label: tab.label }))}
					activeKey={activeSubTab}
					onChange={(key) => setActiveSubTab(key as KpiSubTabKey)}
				/>
			</div>
			{activeSubTab === 'trend' ? granularitySelector : seasonSelector}
		</>
	);

	if (isLoading) {
		return (
			<section>
				{subTabBar}
				<div className="border border-[#d4d4d4] p-6">
					<p className="font-acumin text-sm text-[#474747]">KPIを読み込み中...</p>
				</div>
			</section>
		);
	}

	if (errorMessage) {
		return (
			<section>
				{subTabBar}
				<div className="space-y-4 border border-[#d4d4d4] p-6">
					<p className="font-acumin text-sm text-red-700">{errorMessage}</p>
					<Button variant="secondary" size="sm" className="font-acumin" onClick={onRetry}>
						再取得
					</Button>
				</div>
			</section>
		);
	}

	if (!data) {
		return (
			<section>
				{subTabBar}
				<div className="border border-[#d4d4d4] p-6">
					<p className="font-acumin text-sm text-[#474747]">KPIデータがありません。</p>
				</div>
			</section>
		);
	}

	return (
		<section>
			{subTabBar}

			{activeSubTab === 'progress' ? (
				<div className="space-y-4">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
						{kpiCards.map((card) => (
							<KpiCard
								key={card.key}
								card={card}
								canEdit={Boolean(targetData)}
								isEditing={editingCardKey === card.key}
								editingValue={editingCardValue}
								isSaving={isCardTargetSaving}
								errorMessage={editingCardKey === card.key ? cardTargetErrorMessage : null}
								onEditStart={() => handleCardEditStart(card)}
								onEditChange={setEditingCardValue}
								onEditCancel={handleCardEditCancel}
								onEditSave={() => handleCardTargetSave(card)}
							/>
						))}
					</div>
					<div className="space-y-1">
						<p className="font-acumin text-xs text-[#888888]">
							※ 目標値は各カード右上の編集アイコンから設定できます（現在シーズンに保存されます）。
						</p>
						<p className="font-acumin text-xs text-[#888888]">
							※ SNS・広告系指標（リーチ数 / 保存率 / プロフィール遷移率 / ストーリー視聴数 / ストーリー到達率 / リンククリック率 / CPA / ROAS / CPC / CPM / 離脱率）はサンプルの参考値です。バックエンド接続後に実データへ切り替わります。
						</p>
						<p className="font-acumin text-xs text-[#888888]">
							※ 達成率は目標値から抽出した数値（範囲指定は下限、返品率・CPA・CPC・CPM・離脱率は上限）を基準に算出しています。
						</p>
					</div>
				</div>
			) : null}

			{activeSubTab === 'trend' ? (
				<div className="space-y-6">
					{/* グラフ・KPI一覧はビューポート高（svh から上部UI分を控除）に収め、
					    行数の多いKPI一覧はパネル内で縦スクロールさせる。 */}
					<div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,382fr)_minmax(0,618fr)]">
						<div className="flex max-h-[calc(100svh_-_12rem)] flex-col gap-4 overflow-hidden border border-[#d4d4d4] p-6">
							<div className="flex items-center justify-between gap-3">
								<div className="flex items-center gap-2">
									<p className="font-acumin text-sm tracking-widest text-black">{trendKpiDefinition.label}推移</p>
									{trendKpiDefinition.connectedKey ? null : (
										<span className="rounded-full bg-[#ededed] px-2 py-0.5 font-acumin text-[10px] tracking-wider text-[#888888]">
											参考
										</span>
									)}
								</div>
								<span className="font-acumin text-[11px] text-[#888888]">
									単位：{kpiUnit(trendKpiDefinition.unitLabel)}
								</span>
							</div>
							<div className="flex min-h-0 flex-1 items-center">
								<TrendChart
									points={trendChartPoints}
									kpiLabel={trendKpiDefinition.label}
									unit={kpiUnit(trendKpiDefinition.unitLabel)}
									targets={trendTargets}
								/>
							</div>
						</div>

						<div className="flex max-h-[calc(100svh_-_12rem)] flex-col gap-4 border border-[#d4d4d4] p-6">
							<div className="flex items-center justify-between gap-3">
								<p className="font-acumin text-sm tracking-widest text-black">KPI一覧</p>
								<span className="font-acumin text-[11px] text-[#888888]">全{trendTableRows.length}指標</span>
							</div>
							<div className="min-h-0 w-full flex-1 overflow-auto">
								<table className="w-full min-w-[420px] border-collapse xl:min-w-0">
									<thead>
										<tr className="border-b border-[#d4d4d4]">
											<th className="sticky left-0 top-0 z-30 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]">KPI</th>
											{trendSeries.map((point) => (
												<th key={point.label} className="sticky top-0 z-20 whitespace-nowrap bg-white px-1.5 py-2 text-right font-acumin text-xs text-[#474747]">{point.label}</th>
											))}
											<th className="sticky top-0 z-20 whitespace-nowrap bg-white py-2 pl-3 text-right font-acumin text-xs text-[#474747]">成長率(CAGR)</th>
										</tr>
									</thead>
									<tbody>
										{trendTableRows.map((row) => (
											<tr key={row.key} className="border-b border-[#ededed] align-top">
												<td className="sticky left-0 z-10 whitespace-nowrap bg-white py-2 pr-3 font-acumin text-xs text-black">
													<span className="flex items-center gap-1.5">
														{row.label}
														{row.isSample ? (
															<span className="rounded-full bg-[#ededed] px-1.5 py-0.5 font-acumin text-[10px] tracking-wider text-[#888888]">
																参考
															</span>
														) : null}
													</span>
												</td>
												{trendSeries.map((point, index) => (
													<td key={`${row.key}-${point.label}`} className="whitespace-nowrap px-1.5 py-2 text-right font-acumin text-xs text-black tabular-nums">
														{formatKpiValue(row.values[index] ?? 0, row.unit)}
													</td>
												))}
												<td className="whitespace-nowrap py-2 pl-3 text-right font-acumin text-xs text-black tabular-nums">{row.cagr === null ? '—' : `${(row.cagr * 100).toFixed(1)}%`}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					</div>

					{trendSeries.length === 0 ? (
						<p className="font-acumin text-xs text-[#474747]">表示できるデータがありません。</p>
					) : null}
				</div>
			) : null}

			{activeSubTab === 'targets' ? (
				<div className="space-y-4 border border-[#d4d4d4] p-6">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="font-acumin text-sm tracking-widest text-black">シーズン別 KPI 目標管理</p>
							<p className="font-acumin text-xs text-[#474747]">
								複数年のシーズン目標を編集できます。現在シーズン: {targetData?.currentSeason ?? '-'}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button variant="secondary" size="sm" className="font-acumin" onClick={() => void fetchKpiTargets()}>
								再取得
							</Button>
							<Button
								variant="primary"
								size="sm"
								className="font-acumin"
								onClick={() => void handleSaveKpiTargets()}
								disabled={!hasTargetChanges || isTargetSaving || isTargetLoading}
							>
								{isTargetSaving ? '保存中...' : '保存'}
							</Button>
						</div>
					</div>

					{targetErrorMessage ? <p className="font-acumin text-xs text-red-700">{targetErrorMessage}</p> : null}
					{targetSuccessMessage ? <p className="font-acumin text-xs text-green-700">{targetSuccessMessage}</p> : null}

					{isTargetLoading ? (
						<p className="font-acumin text-sm text-[#474747]">KPI目標を読み込み中...</p>
					) : targetData ? (
						<div className="w-full overflow-x-auto">
							<table className="w-full table-fixed border-collapse">
								<colgroup>
									<col style={{ width: targetTableLayout.kpiWidth }} />
									<col style={{ width: targetTableLayout.definitionWidth }} />
									<col style={{ width: targetTableLayout.priorityWidth }} />
									{targetData.seasons.map((season) => (
										<col key={`col-${season}`} style={{ width: targetTableLayout.seasonWidth }} />
									))}
								</colgroup>
								<thead>
									<tr className="border-b border-[#d4d4d4]">
										<th className="sticky left-0 z-20 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]">KPI</th>
										<th className="sticky z-20 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]" style={{ left: targetTableLayout.definitionLeft }}>
											定義
										</th>
										<th className="sticky z-20 bg-white py-2 pr-3 text-left font-acumin text-xs text-[#474747]" style={{ left: targetTableLayout.priorityLeft }}>
											必要性
										</th>
										{targetData.seasons.map((season) => (
											<th key={season} className="px-1.5 py-2 text-left font-acumin text-xs text-[#474747]">
												{season}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{targetData.definitions.map((definition) => (
										<tr key={definition.key} className="border-b border-[#ededed] align-top">
											<td className="sticky left-0 z-10 bg-white py-2 pr-3 font-acumin text-xs text-black">{definition.label}</td>
											<td className="sticky z-10 bg-white py-2 pr-3 font-acumin text-xs text-[#474747]" style={{ left: targetTableLayout.definitionLeft }}>
												{definition.definition}
											</td>
											<td className="sticky z-10 bg-white py-2 pr-3 font-acumin text-xs text-[#474747]" style={{ left: targetTableLayout.priorityLeft }}>
												{definition.priority}
											</td>
											{targetData.seasons.map((season) => (
												<td key={`${definition.key}-${season}`} className="px-1.5 py-2">
													<input
														type="text"
														className="w-full rounded-none border border-[#d4d4d4] px-2 py-1 font-acumin text-xs text-black focus:border-black focus:outline-none"
														value={editableTargetValues[definition.key]?.[season] ?? ''}
														onChange={(event) => handleTargetValueChange(definition.key, season, event.target.value)}
														aria-label={`${definition.label} ${season}`}
														title={season}
													/>
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<p className="font-acumin text-sm text-[#474747]">KPI目標データがありません。</p>
					)}
				</div>
			) : null}

			{activeSubTab === 'cost' ? (
				<div className="border border-[#d4d4d4] p-6">
					<p className="font-acumin text-sm tracking-widest text-black">コスト & 利益</p>
					<p className="mt-2 font-acumin text-xs text-[#474747]">原価・粗利・広告費などのコスト分析ビューは準備中です。</p>
				</div>
			) : null}
		</section>
	);
}
