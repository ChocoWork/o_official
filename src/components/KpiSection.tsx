import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SingleSelect } from '@/components/ui/SingleSelect';
import type { SelectOption } from '@/components/ui/shared';

export type AdminKpiData = {
	summaryCards: Array<{
		label: string;
		value: string;
		trend: string;
		tone: 'positive' | 'negative' | 'neutral';
	}>;
	monthlySales: Array<{
		month: string;
		salesAmount: number;
		formattedSales: string;
		orderCount: number;
	}>;
	monthlyYearOptions: number[];
	monthlySalesByYear: Array<{
		year: number;
		monthlySales: Array<{
			month: string;
			salesAmount: number;
			formattedSales: string;
			orderCount: number;
		}>;
	}>;
	annualSales: Array<{
		year: number;
		salesAmount: number;
		formattedSales: string;
		orderCount: number;
	}>;
	seasonalSales: Array<{
		season: string;
		salesAmount: number;
		formattedSales: string;
		orderCount: number;
	}>;
	targetYear: number;
	categorySales: Array<{
		name: string;
		salesAmount: number;
		formattedSales: string;
		percentage: number;
	}>;
	operationalCards: Array<{
		label: string;
		value: string;
		detail: string;
	}>;
	topProducts: Array<{
		rank: number;
		name: string;
		formattedSales: string;
		unitsLabel: string;
	}>;
	managementSummary: Array<{
		label: string;
		value: string;
		tone: 'success' | 'warning' | 'neutral';
	}>;
};

type KpiSectionProps = {
	data: AdminKpiData | null;
	isLoading: boolean;
	errorMessage: string | null;
	onRetry: () => void;
};

type SalesChartMode = 'monthly' | 'annual' | 'seasonal';

function getTrendClassName(tone: 'positive' | 'negative' | 'neutral'): string {
	if (tone === 'positive') {
		return 'text-green-700';
	}

	if (tone === 'negative') {
		return 'text-red-700';
	}

	return 'text-[#474747]';
}

function getSummaryBadgeClassName(tone: 'success' | 'warning' | 'neutral'): string {
	if (tone === 'success') {
		return 'bg-green-100 text-green-800';
	}

	if (tone === 'warning') {
		return 'bg-yellow-100 text-yellow-800';
	}

	return 'bg-[#f5f5f5] text-[#474747]';
}

function formatYAxisValue(value: number): string {
	return new Intl.NumberFormat('ja-JP', {
		style: 'currency',
		currency: 'JPY',
		maximumFractionDigits: 0,
	}).format(Math.round(value));
}

export default function KpiSection({ data, isLoading, errorMessage, onRetry }: KpiSectionProps) {
	const [salesChartMode, setSalesChartMode] = useState<SalesChartMode>('monthly');
	const [selectedMonthlyYear, setSelectedMonthlyYear] = useState<number>(data?.targetYear ?? new Date().getFullYear());

	useEffect(() => {
		if (!data) {
			return;
		}

		if (data.monthlyYearOptions.includes(selectedMonthlyYear)) {
			return;
		}

		setSelectedMonthlyYear(data.targetYear);
	}, [data, selectedMonthlyYear]);

	const monthlySalesMap = useMemo(() => {
		if (!data) {
			return new Map<number, AdminKpiData['monthlySales']>();
		}

		return new Map<number, AdminKpiData['monthlySales']>(
			data.monthlySalesByYear.map((entry) => [entry.year, entry.monthlySales]),
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

	const salesChartSeries = useMemo(() => {
		if (!data) {
			return [] as Array<{
				key: string;
				label: string;
				salesAmount: number;
				formattedSales: string;
				orderCount: number;
			}>;
		}

		if (salesChartMode === 'monthly') {
			const selectedMonthlySeries = monthlySalesMap.get(selectedMonthlyYear) ?? data.monthlySales;

			return selectedMonthlySeries.map((item) => ({
				key: `${selectedMonthlyYear}-${item.month}`,
				label: item.month,
				salesAmount: item.salesAmount,
				formattedSales: item.formattedSales,
				orderCount: item.orderCount,
			}));
		}

		if (salesChartMode === 'annual') {
			return data.annualSales.map((item) => ({
				key: String(item.year),
				label: String(item.year),
				salesAmount: item.salesAmount,
				formattedSales: item.formattedSales,
				orderCount: item.orderCount,
			}));
		}

		if (salesChartMode === 'seasonal') {
			return data.seasonalSales.map((item) => ({
				key: item.season,
				label: item.season,
				salesAmount: item.salesAmount,
				formattedSales: item.formattedSales,
				orderCount: item.orderCount,
			}));
		}

		return [];
	}, [data, monthlySalesMap, salesChartMode, selectedMonthlyYear]);

	const maxSalesAmount = Math.max(...salesChartSeries.map((item) => item.salesAmount), 0);
	const yAxisTicks = useMemo(() => [maxSalesAmount, maxSalesAmount / 2, 0], [maxSalesAmount]);

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

	const chartTitle = salesChartMode === 'monthly' ? '月間売上推移' : salesChartMode === 'annual' ? '年間売上推移' : 'シーズン売上推移';

	return (
		<section>
			<div className="grid grid-cols-1 gap-6 mb-8 md:grid-cols-2 lg:grid-cols-4">
				{data.summaryCards.map((card) => (
					<div key={card.label} className="border border-[#d5d0c9] p-6">
						<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">{card.label}</p>
						<p className="text-3xl text-black mb-1 font-didot">{card.value}</p>
						<p className={`text-xs font-acumin ${getTrendClassName(card.tone)}`}>{card.trend}</p>
					</div>
				))}
			</div>

			<div className="grid grid-cols-1 gap-6 mb-8 lg:grid-cols-2">
				<div className="border border-[#d5d0c9] p-6">
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="text-sm text-black tracking-widest font-acumin">{chartTitle}</p>
							<p className="text-xs text-[#474747] font-acumin">
								対象年: {salesChartMode === 'monthly' ? selectedMonthlyYear : data.targetYear}年
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant={salesChartMode === 'monthly' ? 'primary' : 'secondary'}
								size="sm"
								className="font-acumin"
								onClick={() => setSalesChartMode('monthly')}
							>
								月間
							</Button>
							<Button
								variant={salesChartMode === 'annual' ? 'primary' : 'secondary'}
								size="sm"
								className="font-acumin"
								onClick={() => setSalesChartMode('annual')}
							>
								年間
							</Button>
							<Button
								variant={salesChartMode === 'seasonal' ? 'primary' : 'secondary'}
								size="sm"
								className="font-acumin"
								onClick={() => setSalesChartMode('seasonal')}
							>
								シーズン
							</Button>
							{salesChartMode === 'monthly' ? (
								<div className="min-w-[150px]">
									<SingleSelect
										label=""
										variant="dropdown"
										options={monthlyYearOptions}
										value={String(selectedMonthlyYear)}
										onValueChange={(value) => setSelectedMonthlyYear(Number(value))}
										size="sm"
										aria-label="月間売上対象年"
									/>
								</div>
							) : null}
						</div>
					</div>
					<div className="flex gap-3">
						<div className="flex h-48 w-20 shrink-0 flex-col justify-between text-[10px] text-[#474747] font-acumin">
							{yAxisTicks.map((tick, index) => (
								<span key={`${tick}-${index}`}>{formatYAxisValue(tick)}</span>
							))}
						</div>
						<div className="flex-1">
							<div
								className="grid h-48 items-end gap-2"
								style={{ gridTemplateColumns: `repeat(${Math.max(salesChartSeries.length, 1)}, minmax(0, 1fr))` }}
							>
								{salesChartSeries.map((item) => {
									const height = maxSalesAmount === 0 ? 0 : Math.max((item.salesAmount / maxSalesAmount) * 100, 4);

									return (
										<div key={item.key} className="flex h-full min-w-0 flex-col items-center justify-end">
											<div className="flex w-full flex-1 items-end">
												<div
													className="w-full bg-black/80 transition-colors"
													style={{ height: item.salesAmount === 0 ? '0%' : `${height}%` }}
													title={`${item.label}: ${item.formattedSales} / ${item.orderCount}件`}
												/>
											</div>
											<span className="mt-2 text-xs text-[#474747] font-acumin">{item.label}</span>
										</div>
									);
								})}
							</div>
						</div>
					</div>
				</div>

				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">カテゴリ別売上</p>
					<div className="space-y-4">
						{data.categorySales.map((item) => (
							<div key={item.name}>
								<div className="flex justify-between mb-1 gap-3">
									<span className="text-xs text-[#474747] font-acumin">{item.name}</span>
									<span className="text-xs text-black font-acumin">
										{item.formattedSales} ({item.percentage.toFixed(1)}%)
									</span>
								</div>
								<div className="h-2 bg-[#f5f5f5] rounded-full overflow-hidden">
									<div className="h-full bg-black" style={{ width: `${item.percentage}%` }} />
								</div>
							</div>
						))}
					</div>
				</div>
			</div>

			<div className="grid grid-cols-1 gap-6 mb-8 md:grid-cols-3">
				{data.operationalCards.map((card) => (
					<div key={card.label} className="border border-[#d5d0c9] p-6">
						<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">{card.label}</p>
						<p className="text-3xl text-black mb-1 font-didot">{card.value}</p>
						<p className="text-xs text-[#474747] font-acumin">{card.detail}</p>
					</div>
				))}
			</div>

			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">売れ筋商品 TOP5</p>
					<div className="space-y-3">
						{data.topProducts.length === 0 ? (
							<p className="text-sm text-[#474747] font-acumin">対象期間の販売データがありません。</p>
						) : (
							data.topProducts.map((item) => (
								<div key={item.rank} className="flex items-center justify-between py-2 border-b border-[#f5f5f5] last:border-0 gap-4">
									<div className="flex items-center gap-4 min-w-0">
										<span className="w-6 h-6 shrink-0 bg-black text-white text-xs flex items-center justify-center font-acumin">
											{item.rank}
										</span>
										<span className="text-sm text-black font-acumin truncate">{item.name}</span>
									</div>
									<div className="text-right shrink-0">
										<p className="text-sm text-black font-acumin">{item.formattedSales}</p>
										<p className="text-xs text-[#474747] font-acumin">{item.unitsLabel}</p>
									</div>
								</div>
							))
						)}
					</div>
				</div>

				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">運用サマリー</p>
					<div className="space-y-3">
						{data.managementSummary.map((item) => (
							<div key={item.label} className="flex items-center justify-between py-2 border-b border-[#f5f5f5] last:border-0 gap-4">
								<span className="text-sm text-black font-acumin">{item.label}</span>
								<span className={`px-2 py-1 text-xs font-acumin ${getSummaryBadgeClassName(item.tone)}`}>
									{item.value}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
