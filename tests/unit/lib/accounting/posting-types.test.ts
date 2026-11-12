import fs from 'node:fs';
import path from 'node:path';
import {
	DEFAULT_POSTING_BATCH,
	MAX_DISPUTE_NOTE,
	MAX_PENDING_PAGE,
	MAX_POSTING_BATCH,
	MAX_POSTING_LOOPS,
	PENDING_REASONS,
} from '@/lib/accounting/posting-types';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p2_posting_tables.sql'));
const CHECK_PATTERN = /accounting_pending_events_reason_check\s+CHECK \(reason IN \(([^)]*)\)\)/;
/** reason の CHECK を書く移行（版の順）。計画2 S6 が作り、後の移行（計画3 S15 など）が作り直す。 */
const checkFiles = fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
	.filter((name) => CHECK_PATTERN.test(fs.readFileSync(path.join(directory, name), 'utf8')));

/** 最新の移行にある accounting_pending_events の reason の CHECK の値（書いた順）。 */
function sqlReasons(): string[] {
	const latest = checkFiles.at(-1);
	const match = latest ? CHECK_PATTERN.exec(fs.readFileSync(path.join(directory, latest), 'utf8')) : null;
	return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

describe('FREQ-569-AC-01: 計上待ちの理由の一覧はSQLのCHECKと一致する', () => {
	it('移行が1本だけあり、理由が20個ある', () => {
		expect(files).toHaveLength(1);
		expect(PENDING_REASONS).toHaveLength(20);
		expect(new Set(PENDING_REASONS).size).toBe(20);
	});

	it('TS の理由の一覧は SQL の CHECK と同じ値を同じ順で持つ', () => {
		expect(checkFiles.at(-1)).toMatch(/_accounting_p3_return_refund_tables\.sql$/);
		expect(sqlReasons()).toEqual([...PENDING_REASONS]);
	});

	it('計画3の2つ（refund_prior_unposted・refund_cancel_undecided）を計画2の18個の後に持つ', () => {
		expect(PENDING_REASONS.slice(18)).toEqual(['refund_prior_unposted', 'refund_cancel_undecided']);
	});

	it('自動で解決済みになる no_revenue と、確認済みにできる before_cutover を含む', () => {
		expect(PENDING_REASONS).toEqual(expect.arrayContaining(['no_revenue', 'before_cutover', 'period_missing', 'posting_error']));
	});
});

describe('FREQ-569-AC-01: 上限の定数は計画の表のとおり', () => {
	it('係の件数・繰り返し・一覧の1ページ・メモの字数', () => {
		expect(DEFAULT_POSTING_BATCH).toBe(50);
		expect(MAX_POSTING_BATCH).toBe(200);
		expect(MAX_POSTING_LOOPS).toBe(20);
		expect(MAX_PENDING_PAGE).toBe(100);
		expect(MAX_DISPUTE_NOTE).toBe(500);
	});
});
