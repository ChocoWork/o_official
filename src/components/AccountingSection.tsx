'use client';

import { useMemo, useState } from 'react';
import CostProfitSection from '@/components/CostProfitSection';
import {
	currentFiscalYear,
	fiscalYearOptionsDescending,
	formatFiscalYearLabel,
} from '@/lib/finance/fiscal-year';

// ACCOUNTING タブ。財務概要 / 取引管理 / 帳簿 / 商品原価 / 税務レポートを
// CostProfitSection がサブタブとして描画し、ここでは会計期間（暦年）だけを決める。
// 年度の選択UIはサブタブ行の右端（同期状態・再読み込みの並び）に置く。
// シーズン（S/S・A/W）は商品原価タブ内のボタンで切り替える。
export default function AccountingSection() {
	const current = useMemo(() => currentFiscalYear(), []);
	const yearOptions = useMemo(() => fiscalYearOptionsDescending(current), [current]);
	const [selectedYear, setSelectedYear] = useState(current);

	return (
		<section>
			<CostProfitSection
				fiscalYear={selectedYear}
				fiscalYearLabel={formatFiscalYearLabel(selectedYear)}
				fiscalYearOptions={yearOptions}
				onFiscalYearChange={setSelectedYear}
			/>
		</section>
	);
}
