'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import CostProfitSection from '@/components/CostProfitSection';
import {
	currentFiscalYear,
	fiscalYearOptionsDescending,
	formatFiscalYearLabel,
} from '@/lib/finance/fiscal-year';

// ACCOUNTING タブ。財務概要 / 取引管理 / 帳簿 / 商品原価 / 税務レポートを
// CostProfitSection がサブタブとして描画し、ここでは会計期間（暦年）だけを決める。
// シーズン（S/S・A/W）は商品原価タブ内のボタンで切り替える。
export default function AccountingSection() {
	const current = useMemo(() => currentFiscalYear(), []);
	const yearOptions = useMemo(() => fiscalYearOptionsDescending(current), [current]);
	const [selectedYear, setSelectedYear] = useState(current);

	return (
		<section>
			<div className="mb-6 flex flex-wrap items-center gap-1.5">
				{yearOptions.map((option) => (
					<Button
						key={option.year}
						variant="outline"
						size="2xs"
						shape="rounded"
						selected={option.year === selectedYear}
						onClick={() => setSelectedYear(option.year)}
						className="font-acumin tracking-wider"
					>
						{option.label}
					</Button>
				))}
				<span className="ml-1 font-acumin text-[11px] text-[#707070]">
					会計期間 {selectedYear}/01/01〜{selectedYear}/12/31
				</span>
			</div>
			<CostProfitSection
				fiscalYear={selectedYear}
				fiscalYearLabel={formatFiscalYearLabel(selectedYear)}
			/>
		</section>
	);
}
