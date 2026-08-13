import { resolveTransactionStatus } from '@/lib/finance/transaction-status';

describe('resolveTransactionStatus', () => {
	it.each([
		{
			name: '法人の訂正確認が未完了なら要確認',
			businessType: 'corporation' as const,
			revised: true,
			openReviewReasons: ['revisedEntry'] as const,
			expected: 'review',
		},
		{
			name: '法人の訂正確認が完了し他に問題がなければ登録済み',
			businessType: 'corporation' as const,
			revised: true,
			openReviewReasons: [] as const,
			expected: 'registered',
		},
		{
			name: '個人事業主は訂正履歴だけなら登録済み',
			businessType: 'soleProprietor' as const,
			revised: true,
			openReviewReasons: [] as const,
			expected: 'registered',
		},
		{
			name: '個人事業主でも別の未確認理由があれば要確認',
			businessType: 'soleProprietor' as const,
			revised: true,
			openReviewReasons: ['duplicate'] as const,
			expected: 'review',
		},
	])('$name', ({ businessType, revised, openReviewReasons, expected }) => {
		expect(
			resolveTransactionStatus({ businessType, revised, openReviewReasons }),
		).toBe(expected);
	});
});
