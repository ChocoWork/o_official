'use client';

import { useMemo, useState } from 'react';
import CostProfitSection from '@/components/CostProfitSection';
import { currentFiscalYear, formatFiscalYearLabel } from '@/lib/finance/fiscal-year';

// ACCOUNTING タブ。財務概要 / 取引管理 / 帳簿 / 商品原価 / 税務レポートを
// CostProfitSection がサブタブとして描画し、ここでは会計の期間だけを決める。
// 期間の一覧は cost-profit GET の periods から、CostProfitSection がサブタブ行の右端の
// PeriodPicker に出す。未選択の間は今年を個人の暦年の期間に結んで読む。期間は設定・期間のタブで作る。
// シーズン（S/S・A/W）は商品原価タブ内のボタンで切り替える。
export default function AccountingSection() {
	const current = useMemo(() => currentFiscalYear(), []);
	const [periodId, setPeriodId] = useState<string | null>(null);

	return (
		<section>
			<CostProfitSection
				periodId={periodId}
				onPeriodChange={setPeriodId}
				fiscalYear={current}
				fiscalYearLabel={formatFiscalYearLabel(current)}
			/>
		</section>
	);
}
