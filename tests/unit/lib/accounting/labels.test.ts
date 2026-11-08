import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTING_LABELS, encodeSqlUnicodeLiteral } from '@/lib/accounting/labels';
import { buildLabelsSql } from '@/../scripts/accounting/emit-labels';

const directory = path.join(process.cwd(), 'supabase/migrations');
/** 計画2の移行（在る物だけ）。S7〜S11 が無い間も通る。 */
const p2Files = fs.readdirSync(directory).filter((name) => /_accounting_p2_.*\.sql$/.test(name));

const decode = (escaped: string) =>
	escaped.replace(/\\([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/''/g, "'");

describe('FREQ-562-AC-01: 仕訳の説明・メモ・相手の日本語は ACCOUNTING_LABELS が正本', () => {
	it('計画2で使う17個の語を持ち、空でなく重ならない', () => {
		expect(Object.keys(ACCOUNTING_LABELS).sort()).toEqual(
			[
				'bankArrived',
				'balanceTopup',
				'disputeAssigned',
				'disputeConfirmed',
				'disputeReversal',
				'disputeWithdrawn',
				'feeDispute',
				'feeFx',
				'feePayment',
				'paymentReceived',
				'payoutFailed',
				'payoutStarted',
				'quantityTimes',
				'shipmentCancelled',
				'shipmentRevenue',
				'stripeJapan',
				'taxAdjustment',
			].sort(),
		);
		const values = Object.values(ACCOUNTING_LABELS);
		expect(values.every((value) => value.length > 0 && value.length <= 100)).toBe(true);
		expect(new Set(values).size).toBe(values.length);
	});

	it('計画で決めた5つの語は決めた文字のまま', () => {
		expect(ACCOUNTING_LABELS.stripeJapan).toBe('ストライプジャパン株式会社');
		expect(ACCOUNTING_LABELS.feePayment).toBe('決済の手数料');
		expect(ACCOUNTING_LABELS.feeDispute).toBe('取り消しの手数料');
		expect(ACCOUNTING_LABELS.feeFx).toBe('為替の手数料');
		expect(ACCOUNTING_LABELS.shipmentCancelled).toBe('出荷の取り消し');
	});

	it('「チャージバック」「感嘆符」「絵文字」を使わない', () => {
		for (const value of Object.values(ACCOUNTING_LABELS)) {
			expect(value).not.toMatch(/チャージバック|[!！]|\p{Extended_Pictographic}/u);
		}
	});
});

describe('FREQ-562-AC-01: 標準出力の U& の形は語を1字も変えずに戻せる', () => {
	it('encodeSqlUnicodeLiteral は ASCII だけで、元の文字に戻る', () => {
		for (const value of Object.values(ACCOUNTING_LABELS)) {
			const literal = encodeSqlUnicodeLiteral(value);
			expect(literal).toMatch(/^U&'[\x20-\x7e]*'$/);
			expect(decode(literal.slice(3, -1))).toBe(value);
		}
	});

	it('ASCII の文字は変えず、引用符と \\ は二重にする', () => {
		expect(encodeSqlUnicodeLiteral("a'b")).toBe("U&'a''b'");
		expect(encodeSqlUnicodeLiteral('a\\b')).toBe("U&'a\\\\b'");
	});

	it('buildLabelsSql は語ごとに1行で、語の順と数が ACCOUNTING_LABELS と同じ', () => {
		const lines = buildLabelsSql().trimEnd().split('\n');
		expect(lines).toHaveLength(Object.keys(ACCOUNTING_LABELS).length);
		Object.entries(ACCOUNTING_LABELS).forEach(([key, value], index) => {
			expect(lines[index]).toBe(`-- ${key}: ${encodeSqlUnicodeLiteral(value)}`);
		});
	});
});

describe('FREQ-562-AC-01: 計画2の移行の本文の日本語は ACCOUNTING_LABELS の語だけ', () => {
	it('移行はASCIIだけで、U& の文字列は全部が語の出力のどれかと一致する', () => {
		const allowed = new Set(Object.values(ACCOUNTING_LABELS).map(encodeSqlUnicodeLiteral));
		for (const name of p2Files) {
			const text = fs.readFileSync(path.join(directory, name), 'utf8');
			expect({ name, ascii: /[^\x00-\x7f]/.test(text) }).toEqual({ name, ascii: false });
			const literals = [...text.matchAll(/U&'(?:[^']|'')*'/g)].map((m) => m[0]);
			for (const literal of literals) {
				expect({ name, literal, allowed: allowed.has(literal) }).toEqual({ name, literal, allowed: true });
			}
		}
	});
});
