'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import CostProfitSection from '@/components/CostProfitSection';
import { currentSeasonKey, formatSeasonLabel, seasonOptionsDescending } from '@/lib/kpi/monthly-metrics';

// ACCOUNTING タブ。財務概要 / 取引管理 / 帳簿 / 商品原価 / 税務レポートを
// CostProfitSection がサブタブとして描画し、ここでは対象シーズンだけを決める。
export default function AccountingSection() {
	const current = useMemo(() => currentSeasonKey(), []);
	const seasonOptions = useMemo(() => seasonOptionsDescending(current), [current]);
	const [selectedSeason, setSelectedSeason] = useState(current);

	const selectedSeasonLabel =
		seasonOptions.find((season) => season.key === selectedSeason)?.label ?? formatSeasonLabel(selectedSeason);

	return (
		<section>
			<div className="mb-6 flex flex-wrap items-center gap-1.5">
				{seasonOptions.map((season) => (
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
			<CostProfitSection seasonKey={selectedSeason} seasonLabel={selectedSeasonLabel} />
		</section>
	);
}
