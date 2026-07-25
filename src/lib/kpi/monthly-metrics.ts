// 月次記録タブの算出モデル。API（/api/admin/kpi/monthly-record）とフロント（KpiSection）で共有する。
// - 源データ（SOURCE_METRICS）: 各KPIを算出するための元数値。order 由来は注文DBから機械取得、manual 由来はSNS・広告系で手入力。
// - KPI算出式（MONTHLY_KPI_FORMULAS）: 源データから19指標を計算する式。KPIキーは KPI_CARD_DEFINITIONS と一致させる。

export type SourceMetricGroup = 'order' | 'manual';

export type SourceMetricDef = {
	key: string;
	label: string;
	unit: string; // '円' | '人' | '回' | '件' | '点'
	group: SourceMetricGroup;
};

// order = 注文DBから機械取得（現在月の PeriodKpiMetrics から読む）。manual = SNS・広告系の手入力。
export const SOURCE_METRICS: SourceMetricDef[] = [
	// --- order 由来（自動取得） ---
	{ key: 'paid_sales', label: '売上額', unit: '円', group: 'order' },
	{ key: 'paid_orders', label: '有効注文数', unit: '件', group: 'order' },
	{ key: 'all_orders', label: '全注文数', unit: '件', group: 'order' },
	{ key: 'set_orders', label: 'セット注文数', unit: '件', group: 'order' },
	{ key: 'cancelled_orders', label: 'キャンセル数', unit: '件', group: 'order' },
	{ key: 'customers', label: '顧客数', unit: '人', group: 'order' },
	{ key: 'repeat_customers', label: 'リピート顧客数', unit: '人', group: 'order' },
	{ key: 'sold_items', label: '販売実績商品数', unit: '点', group: 'order' },
	{ key: 'published_items', label: '公開商品数', unit: '点', group: 'order' },
	// --- manual 由来（SNS・広告系の手入力） ---
	{ key: 'reach', label: 'リーチ数', unit: '人', group: 'manual' },
	{ key: 'saves', label: '保存数', unit: '回', group: 'manual' },
	{ key: 'profile_visits', label: 'プロフィールアクセス数', unit: '回', group: 'manual' },
	{ key: 'story_views', label: 'ストーリー視聴数', unit: '回', group: 'manual' },
	{ key: 'followers', label: 'フォロワー数', unit: '人', group: 'manual' },
	{ key: 'story_reach', label: 'ストーリー到達数', unit: '人', group: 'manual' },
	{ key: 'link_clicks', label: 'リンククリック数', unit: '回', group: 'manual' },
	{ key: 'ad_spend', label: '広告費', unit: '円', group: 'manual' },
	{ key: 'ad_conversions', label: '広告コンバージョン数', unit: '件', group: 'manual' },
	{ key: 'ad_revenue', label: '広告経由売上', unit: '円', group: 'manual' },
	{ key: 'ad_clicks', label: '広告クリック数', unit: '回', group: 'manual' },
	{ key: 'ad_impressions', label: '広告表示回数', unit: '回', group: 'manual' },
	{ key: 'lp_sessions', label: 'LPセッション数', unit: '回', group: 'manual' },
	{ key: 'lp_exits', label: 'LP離脱数', unit: '回', group: 'manual' },
];

export const SOURCE_METRIC_KEYS = SOURCE_METRICS.map((metric) => metric.key);

export type MonthlyKpiFormulaDef = {
	key: string; // KPI_CARD_DEFINITIONS.key に対応
	label: string;
	formulaText: string;
	// 源データ（source[key]）から算出。分母0や源データ欠損時は null。
	compute: (source: Record<string, number | undefined>) => number | null;
};

// 比率（分子/分母×100）。分母が正のときのみ算出。
function ratio(numerator: number | undefined, denominator: number | undefined, scale = 100): number | null {
	if (numerator === undefined || denominator === undefined || denominator <= 0) {
		return null;
	}
	return (numerator / denominator) * scale;
}

function direct(value: number | undefined): number | null {
	return value === undefined ? null : value;
}

export const MONTHLY_KPI_FORMULAS: MonthlyKpiFormulaDef[] = [
	{ key: 'reach', label: 'リーチ数', formulaText: 'リーチ数', compute: (s) => direct(s.reach) },
	{ key: 'save_rate', label: '保存率', formulaText: '保存数 ÷ リーチ数', compute: (s) => ratio(s.saves, s.reach) },
	{ key: 'profile_rate', label: 'プロフィール遷移率', formulaText: 'プロフィールアクセス数 ÷ リーチ数', compute: (s) => ratio(s.profile_visits, s.reach) },
	{ key: 'story_views', label: 'ストーリー視聴数', formulaText: 'ストーリー視聴数', compute: (s) => direct(s.story_views) },
	{ key: 'story_reach', label: 'ストーリー到達率', formulaText: 'ストーリー到達数 ÷ フォロワー数', compute: (s) => ratio(s.story_reach, s.followers) },
	{ key: 'link_click', label: 'リンククリック率', formulaText: 'リンククリック数 ÷ プロフィールアクセス数', compute: (s) => ratio(s.link_clicks, s.profile_visits) },
	{ key: 'cvr', label: 'CVR', formulaText: '有効注文数 ÷ 全注文数', compute: (s) => ratio(s.paid_orders, s.all_orders) },
	{ key: 'aov', label: '客単価（AOV）', formulaText: '売上額 ÷ 有効注文数', compute: (s) => ratio(s.paid_sales, s.paid_orders, 1) },
	{ key: 'set_purchase_rate', label: 'セット購入率', formulaText: 'セット注文数 ÷ 有効注文数', compute: (s) => ratio(s.set_orders, s.paid_orders) },
	{ key: 'sales', label: '売上', formulaText: '売上額', compute: (s) => direct(s.paid_sales) },
	{ key: 'inventory_turnover', label: '在庫消化率', formulaText: '販売実績商品数 ÷ 公開商品数', compute: (s) => ratio(s.sold_items, s.published_items) },
	{ key: 'cpa', label: 'CPA', formulaText: '広告費 ÷ 広告コンバージョン数', compute: (s) => ratio(s.ad_spend, s.ad_conversions, 1) },
	{ key: 'roas', label: 'ROAS', formulaText: '広告経由売上 ÷ 広告費', compute: (s) => ratio(s.ad_revenue, s.ad_spend, 1) },
	{ key: 'cpc', label: 'CPC', formulaText: '広告費 ÷ 広告クリック数', compute: (s) => ratio(s.ad_spend, s.ad_clicks, 1) },
	{ key: 'cpm', label: 'CPM', formulaText: '広告費 ÷ 広告表示回数 × 1000', compute: (s) => ratio(s.ad_spend, s.ad_impressions, 1000) },
	{ key: 'ltv', label: 'LTV', formulaText: '売上額 ÷ 顧客数', compute: (s) => ratio(s.paid_sales, s.customers, 1) },
	{ key: 'repeat_rate', label: 'リピート率', formulaText: 'リピート顧客数 ÷ 顧客数', compute: (s) => ratio(s.repeat_customers, s.customers) },
	{ key: 'return_rate', label: '返品率', formulaText: 'キャンセル数 ÷ 全注文数', compute: (s) => ratio(s.cancelled_orders, s.all_orders) },
	{ key: 'exit_rate', label: '離脱率', formulaText: 'LP離脱数 ÷ LPセッション数', compute: (s) => ratio(s.lp_exits, s.lp_sessions) },
];

// 保存キーの名前空間。源データは 'src:'、KPI上書きは 'kpi:' で前置する。
export const SOURCE_PREFIX = 'src:';
export const KPI_OVERRIDE_PREFIX = 'kpi:';

export function sourceStorageKey(metricKey: string): string {
	return `${SOURCE_PREFIX}${metricKey}`;
}

export function kpiOverrideStorageKey(kpiKey: string): string {
	return `${KPI_OVERRIDE_PREFIX}${kpiKey}`;
}

const VALID_STORAGE_KEYS = new Set<string>([
	...SOURCE_METRIC_KEYS.map(sourceStorageKey),
	...MONTHLY_KPI_FORMULAS.map((formula) => kpiOverrideStorageKey(formula.key)),
]);

export function isValidStorageKey(key: string): boolean {
	return VALID_STORAGE_KEYS.has(key);
}

// --- シーズン（YYYYSS / YYYYAW）と月キー（YYYY-MM）の対応 ---
// SS=4〜9月（同年）、AW=10〜12月（同年）+ 1〜3月（翌年）。
export function parseSeasonKey(season: string): { year: number; type: 'SS' | 'AW' } | null {
	const matched = season.match(/^(\d{4})(SS|AW)$/);
	if (!matched) {
		return null;
	}
	return { year: Number.parseInt(matched[1], 10), type: matched[2] as 'SS' | 'AW' };
}

export function seasonMonthKeys(season: string): string[] {
	const parsed = parseSeasonKey(season);
	if (!parsed) {
		return [];
	}
	const pad = (month: number) => String(month).padStart(2, '0');
	if (parsed.type === 'SS') {
		return [4, 5, 6, 7, 8, 9].map((month) => `${parsed.year}-${pad(month)}`);
	}
	return [
		`${parsed.year}-10`,
		`${parsed.year}-11`,
		`${parsed.year}-12`,
		`${parsed.year + 1}-01`,
		`${parsed.year + 1}-02`,
		`${parsed.year + 1}-03`,
	];
}

// 次のシーズンキー（SS→同年AW / AW→翌年SS）。
export function nextSeasonKey(season: string): string {
	const parsed = parseSeasonKey(season);
	if (!parsed) {
		return season;
	}
	return parsed.type === 'SS' ? `${parsed.year}AW` : `${parsed.year + 1}SS`;
}

// 現在（JST）のシーズンキー。
export function currentSeasonKey(now: Date = new Date()): string {
	const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' });
	const parts = formatter.formatToParts(now);
	const year = Number.parseInt(parts.find((part) => part.type === 'year')?.value ?? '1970', 10);
	const month = Number.parseInt(parts.find((part) => part.type === 'month')?.value ?? '1', 10);
	if (month >= 4 && month <= 9) {
		return `${year}SS`;
	}
	if (month >= 10) {
		return `${year}AW`;
	}
	return `${year - 1}AW`;
}
