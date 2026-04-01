import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SingleSelect } from '@/components/ui/SingleSelect';
import type { SelectOption } from '@/components/ui/shared';
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

type KpiProgressItem = {
	key: string;
	label: string;
	currentValue: number;
	currentFormatted: string;
	targetText: string;
	targetValue: number | null;
	direction: KpiProgressDirection;
	progressPercent: number | null;
	statusLabel: '達成' | '進行中' | '未達' | '目標未設定';
};

const KPI_PROGRESS_CONFIG = [
	{ key: 'cvr', label: 'CVR', direction: 'atLeast' as const },
	{ key: 'aov', label: '客単価 (AOV)', direction: 'atLeast' as const },
	{ key: 'set_purchase_rate', label: 'セット購入率', direction: 'atLeast' as const },
	{ key: 'sales', label: '売上', direction: 'atLeast' as const },
	{ key: 'inventory_turnover', label: '在庫消化率', direction: 'atLeast' as const },
	{ key: 'ltv', label: 'LTV', direction: 'atLeast' as const },
	{ key: 'repeat_rate', label: 'リピート率', direction: 'atLeast' as const },
	{ key: 'return_rate', label: '返品率', direction: 'atMost' as const },
];

function parseTargetNumericValue(targetText: string, direction: KpiProgressDirection): number | null {
	const normalized = targetText.replaceAll(',', '').trim();
	if (!normalized) {
		return null;
	}

	const numericMatches = normalized.match(/\d+(?:\.\d+)?/g);
	if (!numericMatches || numericMatches.length === 0) {
		return null;
	}

	const values = numericMatches.map((value) => Number(value)).filter((value) => Number.isFinite(value));
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

function resolveProgressStatus(progressPercent: number | null): KpiProgressItem['statusLabel'] {
	if (progressPercent === null) {
		return '目標未設定';
	}

	if (progressPercent >= 100) {
		return '達成';
	}

	if (progressPercent >= 80) {
		return '進行中';
	}

	return '未達';
}

function getProgressStatusClassName(status: KpiProgressItem['statusLabel']): string {
	if (status === '達成') {
		return 'bg-green-100 text-green-800';
	}

	if (status === '進行中') {
		return 'bg-yellow-100 text-yellow-800';
	}

	if (status === '未達') {
		return 'bg-red-100 text-red-800';
	}

	return 'bg-[#f5f5f5] text-[#474747]';
}

function cloneKpiTargetValues(values: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
	const cloned: Record<string, Record<string, string>> = {};

	for (const [kpiKey, seasonValues] of Object.entries(values)) {
		cloned[kpiKey] = { ...seasonValues };
	}

	return cloned;
}

export default function KpiSection({ data, isLoading, errorMessage, onRetry }: KpiSectionProps) {
	const [selectedMonthlyYear, setSelectedMonthlyYear] = useState<number>(data?.targetYear ?? new Date().getFullYear());
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

	useEffect(() => {
		if (!data) {
			return;
		}

		if (data.monthlyYearOptions.includes(selectedMonthlyYear)) {
			return;
		}

		setSelectedMonthlyYear(data.targetYear);
	}, [data, selectedMonthlyYear]);

	const monthlyKpiMap = useMemo(() => {
		if (!data) {
			return new Map<number, PeriodKpiMetrics[]>();
		}

		return new Map<number, PeriodKpiMetrics[]>(
			data.monthlyKpiByYear.map((entry) => [entry.year, entry.metrics]),
		);
	}, [data]);

	const monthlyYearOptions = useMemo<SelectOption[]>(() => {
		if (!data) {
			return [];
		}

		return data.monthlyYearOptions.map((year) => ({
			value: String(year),
			label: `${year}年`,
		}));
	}, [data]);

	const monthlyKpiSeries = useMemo(() => {
		if (!data) {
			return [] as PeriodKpiMetrics[];
		}

		return monthlyKpiMap.get(selectedMonthlyYear) ?? [];
	}, [data, monthlyKpiMap, selectedMonthlyYear]);

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

	const seasonKpiProgressItems = useMemo(() => {
		if (!currentSeasonMetric) {
			return [] as KpiProgressItem[];
		}

		const currentKpiValueMap: Record<string, { value: number; formatted: string }> = {
			cvr: {
				value: currentSeasonMetric.cvr,
				formatted: currentSeasonMetric.formattedCvr,
			},
			aov: {
				value: currentSeasonMetric.aov,
				formatted: currentSeasonMetric.formattedAov,
			},
			set_purchase_rate: {
				value: currentSeasonMetric.setPurchaseRate,
				formatted: currentSeasonMetric.formattedSetPurchaseRate,
			},
			sales: {
				value: currentSeasonMetric.salesAmount,
				formatted: currentSeasonMetric.formattedSales,
			},
			inventory_turnover: {
				value: currentSeasonMetric.inventoryConsumptionRate,
				formatted: currentSeasonMetric.formattedInventoryConsumptionRate,
			},
			ltv: {
				value: currentSeasonMetric.ltv,
				formatted: currentSeasonMetric.formattedLtv,
			},
			repeat_rate: {
				value: currentSeasonMetric.repeatRate,
				formatted: currentSeasonMetric.formattedRepeatRate,
			},
			return_rate: {
				value: currentSeasonMetric.returnRate,
				formatted: currentSeasonMetric.formattedReturnRate,
			},
		};

		const definitionLabelMap = new Map((targetData?.definitions ?? []).map((definition) => [definition.key, definition.label]));

		return KPI_PROGRESS_CONFIG.map((config) => {
			const current = currentKpiValueMap[config.key] ?? { value: 0, formatted: '-' };
			const targetText = targetData?.values[config.key]?.[targetData.currentSeason] ?? '';
			const targetValue = parseTargetNumericValue(targetText, config.direction);
			const progressPercent = targetValue === null ? null : calculateProgressPercent(current.value, targetValue, config.direction);

			return {
				key: config.key,
				label: definitionLabelMap.get(config.key) ?? config.label,
				currentValue: current.value,
				currentFormatted: current.formatted,
				targetText: targetText || '-',
				targetValue,
				direction: config.direction,
				progressPercent,
				statusLabel: resolveProgressStatus(progressPercent),
			};
		});
	}, [currentSeasonMetric, targetData]);

	const progressSectionTitle = targetData?.currentSeason
		? `今シーズン進捗 (${targetData.currentSeason})`
		: '今シーズン進捗';

	const progressAssumptionNote =
		'達成率は目標値から抽出した数値（範囲指定は下限、返品率のみ上限）を基準に算出しています。';

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

			console.log('Sending KPI target updates:', JSON.stringify(updates, null, 2));

			const response = await clientFetch('/api/admin/kpi/targets', {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ updates }),
			});

			const responseData = await response.json();
			console.log('KPI targets update response:', responseData, 'Status:', response.status);

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error('KPI目標の更新に失敗しました。再ログインしてください。');
				}

				if (response.status === 403) {
					throw new Error('KPI目標を編集する権限がありません。');
				}

				if (response.status === 503) {
					// Table not created error
					const detailsMsg = responseData.details
						? `\n詳細: ${responseData.details}`
						: '';
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
			// Safely extract error message from various error types
			let errorMessage = 'KPI目標の更新に失敗しました。';
			
			if (error instanceof Error) {
				errorMessage = error.message;
			} else if (typeof error === 'string') {
				errorMessage = error;
			} else if (error && typeof error === 'object') {
				// Try various ways to extract message from error object
				try {
					const errorObj = error as Record<string, unknown>;
					if (typeof errorObj.message === 'string') {
						errorMessage = errorObj.message;
					} else if (typeof errorObj.error === 'string') {
						errorMessage = errorObj.error;
					} else {
						errorMessage = JSON.stringify(error, null, 2);
					}
				} catch {
					// If JSON.stringify fails, use default
				}
			}

			console.error('Failed to save KPI targets:', {
				errorType: error instanceof Error ? 'Error' : typeof error,
				errorMessage,
				fullError: error,
			});
			
			setTargetErrorMessage(errorMessage);
		} finally {
			setIsTargetSaving(false);
		}
	}, [editableTargetValues, originalTargetValues, targetData]);

	if (isLoading) {
		return (
			<section className="border border-[#d5d0c9] p-6">
				<p className="text-sm text-[#474747] font-acumin">KPIを読み込み中...</p>
			</section>
		);
	}

	if (errorMessage) {
		return (
			<section className="border border-[#d5d0c9] p-6 space-y-4">
				<p className="text-sm text-red-700 font-acumin">{errorMessage}</p>
				<Button variant="secondary" size="sm" className="font-acumin" onClick={onRetry}>
					再取得
				</Button>
			</section>
		);
	}

	if (!data) {
		return (
			<section className="border border-[#d5d0c9] p-6">
				<p className="text-sm text-[#474747] font-acumin">KPIデータがありません。</p>
			</section>
		);
	}

	return (
		<section>
			<div className="border border-[#d5d0c9] p-6 mb-8 space-y-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p className="text-sm text-black tracking-widest font-acumin">月次 KPI</p>
						<p className="text-xs text-[#474747] font-acumin">CVR / AOV / セット購入率 / 売上 / 在庫消化率 / LTV / リピート率 / 返品率</p>
					</div>
					<div className="min-w-[150px]">
						<SingleSelect
							label=""
							variant="dropdown"
							options={monthlyYearOptions}
							value={String(selectedMonthlyYear)}
							onValueChange={(value) => setSelectedMonthlyYear(Number(value))}
							size="sm"
							aria-label="月次KPI対象年"
						/>
					</div>
				</div>

				<div className="w-full overflow-x-auto">
					<table className="w-full min-w-[980px] border-collapse">
						<thead>
							<tr className="border-b border-[#d5d0c9]">
								<th className="text-left text-xs text-[#474747] font-acumin py-2 pr-3">月</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">CVR</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">客単価 (AOV)</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">セット購入率</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">売上</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">在庫消化率</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">LTV</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">リピート率</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 pl-1.5">返品率</th>
							</tr>
						</thead>
						<tbody>
							{monthlyKpiSeries.map((metric) => (
								<tr key={`monthly-${selectedMonthlyYear}-${metric.period}`} className="border-b border-[#f0ebe5] align-top">
									<td className="text-xs text-black font-acumin py-2 pr-3">{metric.period}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedCvr}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedAov}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedSetPurchaseRate}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedSales}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedInventoryConsumptionRate}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedLtv}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedRepeatRate}</td>
									<td className="text-xs text-black font-acumin py-2 pl-1.5 text-right">{metric.formattedReturnRate}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<div className="border border-[#d5d0c9] p-6 mb-8 space-y-4">
				<div>
					<p className="text-sm text-black tracking-widest font-acumin">シーズン別 KPI</p>
					<p className="text-xs text-[#474747] font-acumin">直近シーズンの推移を確認できます。</p>
				</div>

				<div className="w-full overflow-x-auto">
					<table className="w-full min-w-[980px] border-collapse">
						<thead>
							<tr className="border-b border-[#d5d0c9]">
								<th className="text-left text-xs text-[#474747] font-acumin py-2 pr-3">シーズン</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">CVR</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">客単価 (AOV)</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">セット購入率</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">売上</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">在庫消化率</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">LTV</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 px-1.5">リピート率</th>
								<th className="text-right text-xs text-[#474747] font-acumin py-2 pl-1.5">返品率</th>
							</tr>
						</thead>
						<tbody>
							{data.seasonalKpi.map((metric) => (
								<tr key={`seasonal-${metric.period}`} className="border-b border-[#f0ebe5] align-top">
									<td className="text-xs text-black font-acumin py-2 pr-3">{metric.period}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedCvr}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedAov}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedSetPurchaseRate}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedSales}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedInventoryConsumptionRate}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedLtv}</td>
									<td className="text-xs text-black font-acumin py-2 px-1.5 text-right">{metric.formattedRepeatRate}</td>
									<td className="text-xs text-black font-acumin py-2 pl-1.5 text-right">{metric.formattedReturnRate}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				{data.inventoryConsumptionRateNote ? (
					<p className="text-xs text-[#474747] font-acumin">※ {data.inventoryConsumptionRateNote}</p>
				) : null}
				{data.returnRateNote ? <p className="text-xs text-[#474747] font-acumin">※ {data.returnRateNote}</p> : null}
			</div>

			<div className="border border-[#d5d0c9] p-6 mb-8 space-y-4">
				<div>
					<p className="text-sm text-black tracking-widest font-acumin">{progressSectionTitle}</p>
					<p className="text-xs text-[#474747] font-acumin">目標に対する現在値を達成率バーで確認できます。</p>
				</div>

				{seasonKpiProgressItems.length === 0 ? (
					<p className="text-sm text-[#474747] font-acumin">今シーズンの比較データがありません。</p>
				) : (
					<div className="space-y-3">
						{seasonKpiProgressItems.map((item) => {
							const rawProgress = item.progressPercent ?? 0;
							const barProgress = Math.min(Math.max(rawProgress, 0), 100);
							const overProgress = Math.max(rawProgress - 100, 0);

							return (
								<div key={item.key} className="border border-[#f0ebe5] p-3">
									<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
										<p className="text-sm text-black font-acumin">{item.label}</p>
										<span className={`px-2 py-1 text-xs font-acumin ${getProgressStatusClassName(item.statusLabel)}`}>
											{item.statusLabel}
										</span>
									</div>
									<div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
										<span className="text-xs text-[#474747] font-acumin">現在: {item.currentFormatted}</span>
										<span className="text-xs text-[#474747] font-acumin">目標: {item.targetText}</span>
										<span className="text-xs text-[#474747] font-acumin">
											達成率: {item.progressPercent === null ? '-' : `${item.progressPercent.toFixed(1)}%`}
										</span>
									</div>
									<div className="h-2 bg-[#f5f5f5] rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(barProgress)}>
										<div className="h-full bg-black" style={{ width: `${barProgress}%` }} />
									</div>
									{overProgress > 0 ? (
										<p className="text-[11px] text-green-700 font-acumin mt-1">目標超過 +{overProgress.toFixed(1)}%</p>
									) : null}
								</div>
							);
						})}
					</div>
				)}

				<p className="text-xs text-[#474747] font-acumin">※ {progressAssumptionNote}</p>
			</div>

			<div className="border border-[#d5d0c9] p-6 mb-8 space-y-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p className="text-sm text-black tracking-widest font-acumin">シーズン別 KPI 目標管理</p>
						<p className="text-xs text-[#474747] font-acumin">
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

				{targetErrorMessage ? <p className="text-xs text-red-700 font-acumin">{targetErrorMessage}</p> : null}
				{targetSuccessMessage ? <p className="text-xs text-green-700 font-acumin">{targetSuccessMessage}</p> : null}

				{isTargetLoading ? (
					<p className="text-sm text-[#474747] font-acumin">KPI目標を読み込み中...</p>
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
								<tr className="border-b border-[#d5d0c9]">
									<th className="sticky left-0 z-20 bg-white text-left text-xs text-[#474747] font-acumin py-2 pr-3">KPI</th>
									<th className="sticky z-20 bg-white text-left text-xs text-[#474747] font-acumin py-2 pr-3" style={{ left: targetTableLayout.definitionLeft }}>
										定義
									</th>
									<th className="sticky z-20 bg-white text-left text-xs text-[#474747] font-acumin py-2 pr-3" style={{ left: targetTableLayout.priorityLeft }}>
										必要性
									</th>
									{targetData.seasons.map((season) => (
										<th key={season} className="text-left text-xs text-[#474747] font-acumin py-2 px-1.5">
											{season}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{targetData.definitions.map((definition) => (
									<tr key={definition.key} className="border-b border-[#f0ebe5] align-top">
										<td className="sticky left-0 z-10 bg-white text-xs text-black font-acumin py-2 pr-3">{definition.label}</td>
										<td className="sticky z-10 bg-white text-xs text-[#474747] font-acumin py-2 pr-3" style={{ left: targetTableLayout.definitionLeft }}>
											{definition.definition}
										</td>
										<td className="sticky z-10 bg-white text-xs text-[#474747] font-acumin py-2 pr-3" style={{ left: targetTableLayout.priorityLeft }}>
											{definition.priority}
										</td>
										{targetData.seasons.map((season) => (
											<td key={`${definition.key}-${season}`} className="py-2 px-1.5">
												<input
													type="text"
													className="w-full rounded-none border border-[#d5d0c9] px-2 py-1 text-xs font-acumin text-black focus:border-black focus:outline-none"
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
					<p className="text-sm text-[#474747] font-acumin">KPI目標データがありません。</p>
				)}
			</div>

		</section>
	);
}
