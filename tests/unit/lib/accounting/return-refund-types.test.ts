import fs from 'node:fs';
import path from 'node:path';
import {
	MAX_ARRIVAL_REASON,
	REFUND_EVENT_STATES,
	REFUND_FACT_EVENT_KINDS,
	RETURN_FACT_KINDS,
} from '@/lib/accounting/return-refund-types';
import { ACCOUNTING_SUB_ACCOUNTS } from '@/lib/accounting/journal-types';
import { accountByCode } from '@/lib/finance/accounts';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p3_return_refund_tables.sql'));
const sql = files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '';

/** 移行の CREATE TABLE にある `<constraint> CHECK (<column> ... ARRAY[...] / IN (...))` の値（書いた順）。 */
function sqlValues(constraint: string): string[] {
	const match = new RegExp(`${constraint} CHECK \\([a-z_]+ (?:= ANY \\(ARRAY\\[|IN \\()([^\\])]*)`).exec(sql);
	return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

describe('FREQ-576-AC-01: 返金の状態の一覧はSQLのCHECKと一致する', () => {
	it('移行が1本だけあり、状態が9つある', () => {
		expect(files).toHaveLength(1);
		expect(REFUND_EVENT_STATES).toHaveLength(9);
		expect(new Set(REFUND_EVENT_STATES).size).toBe(9);
	});

	it('TS の状態の一覧は SQL の CHECK と同じ値を同じ順で持つ', () => {
		expect(sqlValues('accounting_refund_events_state_check')).toEqual([...REFUND_EVENT_STATES]);
	});

	it('返金の事実の出来事の種類と返品の事実の種類も SQL の CHECK と同じ', () => {
		expect(sqlValues('accounting_refund_facts_event_kind_check')).toEqual([...REFUND_FACT_EVENT_KINDS]);
		expect(sqlValues('accounting_return_facts_kind_check')).toEqual([...RETURN_FACT_KINDS]);
	});

	it('届いた日の直しの理由の上限は SQL の CHECK と同じ500字', () => {
		expect(MAX_ARRIVAL_REASON).toBe(500);
		expect(sql).toContain(`order_return_arrival_corrections_reason_check CHECK (char_length(reason) BETWEEN 1 AND ${MAX_ARRIVAL_REASON})`);
	});
});

describe('FREQ-578-AC-01: 補助の符号が3つ増え、勘定は2130と1470', () => {
	it('返す借りの2つは2130、返金済みと重なる分を調べる補助は1470を指し、その勘定は一覧にある', () => {
		expect(ACCOUNTING_SUB_ACCOUNTS.refund_owed_pre).toEqual({ accountCode: '2130' });
		expect(ACCOUNTING_SUB_ACCOUNTS.refund_owed_post).toEqual({ accountCode: '2130' });
		expect(ACCOUNTING_SUB_ACCOUNTS.dispute_refund_overlap_review).toEqual({ accountCode: '1470' });
		for (const key of ['refund_owed_pre', 'refund_owed_post', 'dispute_refund_overlap_review'] as const) {
			expect(accountByCode(ACCOUNTING_SUB_ACCOUNTS[key].accountCode)).toBeDefined();
		}
		expect(Object.keys(ACCOUNTING_SUB_ACCOUNTS)).toHaveLength(7);
	});
});
