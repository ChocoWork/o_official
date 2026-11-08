import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { AccountingStoreError } from '@/lib/accounting/accounting-types';
import { runAccountingPostingOnce } from '@/lib/accounting/posting-store';
import {
	DEFAULT_POSTING_BATCH,
	MAX_POSTING_LOOPS,
	type PostingRunResult,
	type PostingSource,
} from '@/lib/accounting/posting-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

export type PostingRunOptions = {
	/** 1回の呼び出しの上限（既定 50）。 */
	limit?: number;
	/** 繰り返しの最大回数（既定 20）。webhook の worker は 1（繰り返さない）。 */
	maxLoops?: number;
};

/** webhook の worker が1回の処理の終わりに使う値（worker の時間と G の鍵を食わないため少なく、繰り返さない）。 */
export const WEBHOOK_POSTING_OPTIONS: Required<PostingRunOptions> = { limit: 20, maxLoops: 1 };

/**
 * 計上係を `hasMore` が偽になるまで繰り返す（最大 `MAX_POSTING_LOOPS` 回）。数は SQL が返した値を回ごとに足す
 * （`parked` は止め直しも含み、額が0の出荷の解決は `resolved` にだけ現れる。意味は PostingRunResult の説明）。
 * `hasMore` は最後の回の値で、上限の回数で止まった時は真のまま。
 */
export async function runAccountingPosting(client: SupabaseClient, opts: PostingRunOptions = {}): Promise<PostingRunResult> {
	const limit = opts.limit ?? DEFAULT_POSTING_BATCH;
	const maxLoops = Math.min(opts.maxLoops ?? MAX_POSTING_LOOPS, MAX_POSTING_LOOPS);
	const total: PostingRunResult = { payments: 0, shipments: 0, stripe: 0, disputes: 0, parked: 0, resolved: 0, hasMore: false };
	for (let loop = 0; loop < maxLoops; loop += 1) {
		const result = await runAccountingPostingOnce(client, limit);
		total.payments += result.payments;
		total.shipments += result.shipments;
		total.stripe += result.stripe;
		total.disputes += result.disputes;
		total.parked += result.parked;
		total.resolved += result.resolved;
		total.hasMore = result.hasMore;
		if (!result.hasMore) break;
	}
	return total;
}

/** ログに残す失敗の種類。個人の情報・金額・DB の文は含めない。 */
function failureKind(error: unknown): string {
	if (error instanceof AccountingStoreError) return error.code ?? error.sqlstate ?? 'AccountingStoreError';
	return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 呼び出し側の応答や知らせの処理を、計上の失敗で失敗にしない。例外は握り、`[accounting.posting]` と入口の名前と
 * 失敗の種類だけを残して null を返す。取りこぼしは10分ごとの cron が拾う。
 */
export async function safeRunAccountingPosting(source: PostingSource, opts: PostingRunOptions = {}): Promise<PostingRunResult | null> {
	try {
		return await runAccountingPosting(await createServiceRoleClient(), opts);
	} catch (error) {
		console.error('[accounting.posting]', source, failureKind(error));
		return null;
	}
}

/** 応答を返した後に Next の `after()` で係を流す（応答を遅らせない）。`after()` が使えない時もログだけで、呼び出し側は失敗にしない。 */
export function scheduleAccountingPosting(source: PostingSource): void {
	try {
		after(async () => {
			await safeRunAccountingPosting(source);
		});
	} catch (error) {
		console.error('[accounting.posting]', source, `schedule_${failureKind(error)}`);
	}
}
