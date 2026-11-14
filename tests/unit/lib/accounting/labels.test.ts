import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTING_LABELS, encodeSqlUnicodeLiteral } from '@/lib/accounting/labels';
import { buildLabelsSql } from '@/../scripts/accounting/emit-labels';

const directory = path.join(process.cwd(), 'supabase/migrations');
/** 計画2の移行（在る物だけ）。S7〜S11 が無い間も通る。 */
const p2Files = fs.readdirSync(directory).filter((name) => /_accounting_p2_.*\.sql$/.test(name));
/** 計画3の移行（在る物だけ）。 */
const p3Files = fs.readdirSync(directory).filter((name) => /_accounting_p3_.*\.sql$/.test(name));

const decode = (escaped: string) =>
	escaped.replace(/\\([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/''/g, "'");

describe('FREQ-562-AC-01: 仕訳の説明・メモ・相手の日本語は ACCOUNTING_LABELS が正本', () => {
	it('計画2・3で使う31個の語を持ち、空でなく重ならない', () => {
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
				'quantityTimesCompact',
				'refundAfterShipment',
				'refundBankTransfer',
				'refundCancelled',
				'refundOwed',
				'refundPreShipment',
				'refundReturn',
				'returnAmountDecided',
				'returnArrivalRedated',
				'returnArrived',
				'returnFeeRevenue',
				'disputeOffsetReturn',
				'disputeOffsetReview',
				'shipmentCancelled',
				'shipmentRevenue',
				'stripeJapan',
				'taxAdjustment',
				'taxRefundRetentionNote',
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

/**
 * 語の出力（ACCOUNTING_LABELS）に入れず、前の移行の本文から S17 が写した文（裁定 P3-T10c・P3-T10e）。仕訳の摘要ではない。
 * 足す時は、前の移行の本文にある物だけにする。
 * - 支払額の違いの自動の取消: begin_order_refund の auto_amount_mismatch の道のメモ
 * - Stripe で返金が見つかったため自動で解決: 要対応の自動の解決のメモ（20261023211425_group_g1_allocation.sql の写し）
 */
const CARRIED_OVER_REFUND_NOTES = ['支払額の違いの自動の取消', 'Stripe で返金が見つかったため自動で解決'];

describe('FREQ-578-AC-01: 返品・返金のラベルはSQLと一致する', () => {
	it('計画3の12個の語は計画で決めた文字のまま', () => {
		const keys = [
			'returnArrived', 'returnFeeRevenue', 'refundPreShipment', 'refundReturn', 'refundAfterShipment', 'refundOwed',
			'refundBankTransfer', 'refundCancelled', 'returnAmountDecided', 'returnArrivalRedated', 'disputeOffsetReturn',
			'disputeOffsetReview',
		] as const;
		expect(Object.fromEntries(keys.map((key) => [key, ACCOUNTING_LABELS[key]]))).toEqual({
			returnArrived: '返品の到着',
			returnFeeRevenue: '返品の手数料',
			refundPreShipment: '出荷前の返金',
			refundReturn: '返品の返金',
			refundAfterShipment: '出荷後の返金・値引き',
			refundOwed: '返金の未払い',
			refundBankTransfer: '振込での返金',
			refundCancelled: '返金の取り消し',
			returnAmountDecided: '返金の額の決定',
			returnArrivalRedated: '届いた日の直し',
			disputeOffsetReturn: '返品の返金待ちとの相殺',
			disputeOffsetReview: '返金済みと重なる分（分けて調べる）',
		});
	});

	it('FREQ-583-AC-04: 消費税用の返金の一覧の保存の注記と品の内容の区切りは、S23 の文のとおり', () => {
		expect(ACCOUNTING_LABELS.taxRefundRetentionNote).toBe('消費税法施行令58条の2により7年間保存する');
		expect(ACCOUNTING_LABELS.quantityTimesCompact).toBe('×');
		const sql = fs.readFileSync(path.join(directory, fs.readdirSync(directory).filter((n) => n.endsWith('_accounting_p3_intake_tax_reads.sql'))[0]), 'utf8');
		expect(sql).toContain(encodeSqlUnicodeLiteral(ACCOUNTING_LABELS.taxRefundRetentionNote));
		expect(sql).toContain(encodeSqlUnicodeLiteral(ACCOUNTING_LABELS.quantityTimesCompact));
	});

	it('計画3の移行はASCIIだけで、U& の文字列は全部が語の出力のどれかと一致する', () => {
		expect(p3Files.length).toBeGreaterThanOrEqual(1);
		const allowed = new Set(Object.values(ACCOUNTING_LABELS).map(encodeSqlUnicodeLiteral));
		// 前の移行の本文の写しは、16進の大文字・小文字のどちらで書かれていてもよい（語の出力は大文字）
		for (const note of CARRIED_OVER_REFUND_NOTES) {
			const upper = encodeSqlUnicodeLiteral(note);
			allowed.add(upper);
			allowed.add(upper.replace(/\\([0-9A-F]{4})/g, (hex) => hex.toLowerCase()));
		}
		for (const name of p3Files) {
			const text = fs.readFileSync(path.join(directory, name), 'utf8');
			expect({ name, ascii: /[^\x00-\x7f]/.test(text) }).toEqual({ name, ascii: false });
			for (const literal of [...text.matchAll(/U&'(?:[^']|'')*'/g)].map((m) => m[0])) {
				expect({ name, literal, allowed: allowed.has(literal) }).toEqual({ name, literal, allowed: true });
			}
		}
	});

	it('語の出力（buildLabelsSql）は計画3の語も1行ずつ持つ', () => {
		const lines = buildLabelsSql().trimEnd().split('\n');
		expect(lines).toContain(`-- returnArrived: ${encodeSqlUnicodeLiteral('返品の到着')}`);
		expect(lines).toContain(`-- disputeOffsetReview: ${encodeSqlUnicodeLiteral('返金済みと重なる分（分けて調べる）')}`);
	});
});
