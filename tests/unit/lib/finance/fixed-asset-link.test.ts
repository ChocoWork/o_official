import {
	ASSET_THRESHOLD,
	classifyAssetCandidate,
	fixedAssetCode,
	fixedAssetLinkStatus,
	isFixedAssetAccount,
	suggestDepreciationMethod,
	pendingAssetCandidateEntries,
	unlinkedAssetEntries,
	type AssetCandidateEntry,
	type LinkableFixedAsset,
} from '@/lib/finance/fixed-asset-link';

function entry(partial: Partial<AssetCandidateEntry> = {}): AssetCandidateEntry {
	return {
		id: 1,
		entryType: 'expense',
		date: '2026-08-01',
		category: '工具器具備品',
		item: '業務用PC',
		partner: '株式会社A',
		amount: 300_000,
		paymentMethod: '銀行振込',
		memo: '',
		...partial,
	};
}

function asset(partial: Partial<LinkableFixedAsset> = {}): LinkableFixedAsset {
	return { id: 42, acquiredOn: '2026-08-01', entryId: 1, ...partial };
}

describe('isFixedAssetAccount', () => {
	it.each(['工具器具備品', '一括償却資産', '少額減価償却資産', 'ソフトウェア', '建物'])(
		'%s は固定資産科目',
		(name) => {
			expect(isFixedAssetAccount(name)).toBe(true);
		},
	);

	it.each(['消耗品費', '普通預金', '商品', '売上高'])('%s は固定資産科目ではない', (name) => {
		expect(isFixedAssetAccount(name)).toBe(false);
	});

	it('科目マスタに無い名称は固定資産扱いしない', () => {
		expect(isFixedAssetAccount('存在しない科目')).toBe(false);
	});
});

describe('classifyAssetCandidate', () => {
	it('固定資産科目の支出は金額を問わず asset', () => {
		expect(classifyAssetCandidate(entry({ amount: 50_000 }))).toBe('asset');
		expect(classifyAssetCandidate(entry({ amount: 300_000 }))).toBe('asset');
	});

	it('理由付きで対象外にした固定資産科目は候補から外れる', () => {
		expect(classifyAssetCandidate(entry({ fixedAssetExempt: true }))).toBeNull();
	});

	it('収入は候補にしない', () => {
		expect(classifyAssetCandidate(entry({ entryType: 'income' }))).toBeNull();
	});

	describe('費用科目の金額境界', () => {
		it('10万円未満は候補にしない', () => {
			expect(
				classifyAssetCandidate(entry({ category: '消耗品費', amount: ASSET_THRESHOLD - 1 })),
			).toBeNull();
		});

		it('ちょうど10万円から suspect', () => {
			expect(
				classifyAssetCandidate(entry({ category: '消耗品費', amount: ASSET_THRESHOLD })),
			).toBe('suspect');
		});

		it.each(['消耗品費', '事務用品費', '修繕費'])('%s は疑い対象', (category) => {
			expect(classifyAssetCandidate(entry({ category, amount: 300_000 }))).toBe('suspect');
		});

		it('疑い対象でない費用科目は10万円以上でも候補にしない', () => {
			expect(classifyAssetCandidate(entry({ category: '地代家賃', amount: 300_000 }))).toBeNull();
		});

		it('除外済みなら候補から外れる', () => {
			expect(
				classifyAssetCandidate(
					entry({ category: '消耗品費', amount: 300_000, fixedAssetExempt: true }),
				),
			).toBeNull();
		});
	});
});

describe('pendingAssetCandidateEntries', () => {
	it('固定資産科目と高額な費用科目の疑いをまとめて返す', () => {
		const entries = [
			entry({ id: 1, category: '工具器具備品' }),
			entry({ id: 2, category: '消耗品費', amount: 300_000 }),
			entry({ id: 3, category: '地代家賃', amount: 300_000 }),
			entry({ id: 4, category: 'ソフトウェア', fixedAssetExempt: true }),
		];
		expect(pendingAssetCandidateEntries(entries, []).map((row) => row.id)).toEqual([1, 2]);
	});
});

describe('fixedAssetLinkStatus', () => {
	it('取引と繋がっておらず証憑もあるなら linked', () => {
		expect(fixedAssetLinkStatus(asset(), { id: 1, receipts: [{}] }, 2026)).toBe('linked');
	});

	it('取引と繋がっているが証憑が無いなら noReceipt', () => {
		expect(fixedAssetLinkStatus(asset(), { id: 1, receipts: [] }, 2026)).toBe('noReceipt');
		expect(fixedAssetLinkStatus(asset(), { id: 1 }, 2026)).toBe('noReceipt');
	});

	it('entryId が無ければ direct', () => {
		expect(fixedAssetLinkStatus(asset({ entryId: null }), undefined, 2026)).toBe('direct');
	});

	it('同年度で取引が見つからなければ entryMissing', () => {
		expect(fixedAssetLinkStatus(asset(), undefined, 2026)).toBe('entryMissing');
	});

	it('別年度に取得した資産は取引が手元に無くても削除と断定しない', () => {
		// 会計期間で絞って取得しているため、過年度の取引はそもそも読み込まれていない。
		expect(fixedAssetLinkStatus(asset({ acquiredOn: '2025-08-01' }), undefined, 2026)).toBe(
			'linked',
		);
	});
});

describe('unlinkedAssetEntries', () => {
	const entries = [
		entry({ id: 1, category: '工具器具備品' }),
		entry({ id: 2, category: 'ソフトウェア' }),
		entry({ id: 3, category: '消耗品費', amount: 300_000 }),
		entry({ id: 4, category: '地代家賃', amount: 300_000 }),
	];

	it('台帳に未連携の固定資産科目の取引だけを返す', () => {
		const assets = [asset({ id: 10, entryId: 1 })];
		expect(unlinkedAssetEntries(entries, assets).map((row) => row.id)).toEqual([2]);
	});

	it('suspect は科目を直させるのが先なので含めない', () => {
		expect(unlinkedAssetEntries(entries, []).map((row) => row.id)).toEqual([1, 2]);
	});

	it('直接登録の資産は連携済み判定に影響しない', () => {
		const assets = [asset({ id: 10, entryId: null }), asset({ id: 11, entryId: 2 })];
		expect(unlinkedAssetEntries(entries, assets).map((row) => row.id)).toEqual([1]);
	});
});

describe('suggestDepreciationMethod', () => {
	it.each([
		[1, 'immediate'],
		[99_999, 'immediate'],
		[100_000, 'lumpSum3Year'],
		[199_999, 'lumpSum3Year'],
		[200_000, 'straightLine'],
		[300_000, 'straightLine'],
	])('%d円 → %s', (amount, expected) => {
		expect(suggestDepreciationMethod(amount)).toBe(expected);
	});
});

describe('fixedAssetCode', () => {
	it('取得年と id から FA-YYYY-NNNN を組み立てる', () => {
		expect(fixedAssetCode({ id: 42, acquiredOn: '2026-08-01' })).toBe('FA-2026-0042');
	});

	it('4桁を超える id は切り詰めない', () => {
		expect(fixedAssetCode({ id: 123_456, acquiredOn: '2026-08-01' })).toBe('FA-2026-123456');
	});
});
