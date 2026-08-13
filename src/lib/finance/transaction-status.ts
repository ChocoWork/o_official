import type { BusinessType } from '@/lib/finance/accounts';
import type { EntryReviewReasonId } from '@/lib/finance/entry-review';

export type TransactionStatus = 'registered' | 'review';

export function resolveTransactionStatus(input: {
	businessType: BusinessType;
	revised: boolean;
	openReviewReasons: readonly EntryReviewReasonId[];
}): TransactionStatus {
	return input.openReviewReasons.length > 0 ? 'review' : 'registered';
}
