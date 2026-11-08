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
const sql = files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '';

/** 移行の CREATE TABLE accounting_pending_events にある reason の CHECK の値（書いた順）。 */
function sqlReasons(): string[] {
	const match = /accounting_pending_events_reason_check\s+CHECK \(reason IN \(([^)]*)\)\)/.exec(sql);
	return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

describe('FREQ-569-AC-01: 計上待ちの理由の一覧はSQLのCHECKと一致する', () => {
	it('移行が1本だけあり、理由が18個ある', () => {
		expect(files).toHaveLength(1);
		expect(PENDING_REASONS).toHaveLength(18);
		expect(new Set(PENDING_REASONS).size).toBe(18);
	});

	it('TS の理由の一覧は SQL の CHECK と同じ値を同じ順で持つ', () => {
		expect(sqlReasons()).toEqual([...PENDING_REASONS]);
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
