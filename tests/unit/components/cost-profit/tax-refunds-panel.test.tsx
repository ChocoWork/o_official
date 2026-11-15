import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TaxRefundsPanel } from '@/components/cost-profit/tax-refunds-panel';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { ALL_FLAGS, BASE, envelope, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 消費税用の返金の一覧（FREQ-583）。route の答えは store が直した camelCase（rows・nextAfterDate・nextAfterKey・totals）。

type Row = Record<string, unknown>;

function row(n: number, overrides: Row = {}): Row {
	return {
		entryId: uuid(300 + n),
		lineKey: `${uuid(300 + n)}:1`,
		refundDate: '2026-10-1' + n,
		orderId: uuid(400 + n),
		orderNumber: `ORD-0000000${n}`,
		amount: 11000,
		taxRate: 10,
		taxAmount: 1000,
		itemSummary: 'シルクブラウス×2',
		originalSaleDate: '2026-09-20',
		salePeriodStatus: 'taxable',
		refundPeriodStatus: 'taxable',
		exclusion: 'none',
		...overrides,
	};
}

const TOTALS = {
	includedAmount: 11000,
	includedTax: 1000,
	excludedAmount: 38000,
	excludedBy: { beforeSale: 5000, saleUnbooked: 7000, exemptSale1416: 20000, afterExit1417: 6000 },
};

type Serve = { rows?: Row[]; next?: { date: string; key: string } | null; totals?: unknown; status?: number; cursorStatus?: number };

function serve(state: Serve = {}) {
	return mockFetch((url, method) => {
		if (url.pathname !== `${BASE}/tax-refunds` || method !== 'GET') return undefined;
		if (state.status) return { status: state.status, body: { error: '会計の処理に失敗しました。' } };
		// 続きの目印が正しくない時、DB は 22023 を返し、route は 400 の固定の文にする（目印は日と行の鍵だけなので、409 のやり直しは無い）
		if (state.cursorStatus && url.searchParams.get('afterDate')) {
			return { status: state.cursorStatus, body: { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' } };
		}
		return {
			status: 200,
			body: envelope({
				rows: state.rows ?? [row(1)],
				nextAfterDate: state.next?.date ?? null,
				nextAfterKey: state.next?.key ?? null,
				retentionNote: 'x',
				totals: state.totals ?? TOTALS,
			}, ALL_FLAGS),
		};
	});
}

function open() {
	render(<TaxRefundsPanel today="2026-11-14" />);
	return screen.getByRole('region', { name: '消費税用の返金' });
}

const from = (region: HTMLElement) => within(region).getByLabelText('期間の始まり') as HTMLInputElement;
const to = (region: HTMLElement) => within(region).getByLabelText('期間の終わり') as HTMLInputElement;
const show = (region: HTMLElement) => within(region).getByRole('button', { name: '一覧を出す' });

describe('月の形の確かめ', () => {
	it('FREQ-583-AC-01: 月の入力が使えない環境で、2026-10 の形でない月が入ると、送る前に止めて「2026-10 の形」の文を出す', () => {
		const api = serve();
		const region = open();
		// 月の入力が文字の欄になる環境（月の選びが無い）を再現する。画面を描き直すと月の入力に戻るので、入れる前に毎回文字の欄にする
		const typeInto = (input: HTMLInputElement, value: string) => {
			input.setAttribute('type', 'text');
			fireEvent.change(input, { target: { value } });
		};
		typeInto(from(region), '2026/10');
		expect(within(region).getByText('月は 2026-10 の形で入れてください。')).toBeInTheDocument();
		expect(show(region)).toBeDisabled();
		fireEvent.click(show(region));
		expect(api.calls.filter((call) => call.url === `${BASE}/tax-refunds`)).toHaveLength(0);
		// 13月は形が合わない。正しい月に直すと文が消えて送れる
		typeInto(from(region), '2026-13');
		expect(within(region).getByText('月は 2026-10 の形で入れてください。')).toBeInTheDocument();
		typeInto(from(region), '2026-10');
		expect(within(region).queryByText('月は 2026-10 の形で入れてください。')).not.toBeInTheDocument();
		expect(show(region)).toBeEnabled();
	});
});

describe('消費税用の返金の一覧', () => {
	it('FREQ-583-AC-01: 消費税用の返金の一覧は項目と対象外の理由を出し、名前やメールを出さない', async () => {
		const api = serve({
			rows: [
				row(1),
				row(2, { exclusion: 'before_sale', originalSaleDate: null, salePeriodStatus: null }),
				row(3, { exclusion: 'sale_unbooked', originalSaleDate: null, salePeriodStatus: null }),
				row(4, { exclusion: 'exempt_sale_14_1_6', salePeriodStatus: 'exempt' }),
				row(5, { exclusion: 'after_exit_14_1_7', itemSummary: null }),
			],
		});
		const region = open();
		fireEvent.click(show(region));
		const table = await within(region).findByRole('table', { name: '消費税用の返金の一覧' });
		const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
		expect(headers).toEqual(['返金した日', '注文番号', '品の内容', '税率', '返金の額', '税額', '元の売上の日', '元の売上の期間', '返金の期間', '対象外の理由']);
		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows).toHaveLength(5);
		expect(rows[0].textContent).toContain('2026/10/11');
		expect(rows[0].textContent).toContain('ORD-00000001');
		expect(rows[0].textContent).toContain('シルクブラウス×2');
		expect(rows[0].textContent).toContain('10%');
		expect(rows[0].textContent).toContain('¥1,000');
		expect(rows[0].textContent).toContain('2026/09/20');
		expect(rows[0].textContent).toContain('対象（含める）');
		// 元の売上の日が無い行は「-」。5つ目の対象外の理由は、手で確かめる旨を穏やかに出す
		expect(rows[1].textContent).toContain('出荷前の返金（元の売上がありません）');
		expect(rows[2].textContent).toContain('元の売上の仕訳がまだ無い（手で確かめる）');
		expect(rows[3].textContent).toContain('元の売上が免税の期間です');
		expect(rows[4].textContent).toContain('免税になった後・事業の形が変わった後の返金です');
		expect(rows[4].textContent).toContain('-');
		expect(region.textContent).not.toMatch(/@|様|メールアドレス|住所/);
		expect(region.textContent).not.toMatch(/[!！]/);
		// 期間は月で渡し、既定は前の月
		const sent = String(api.fn.mock.calls[0][0]);
		expect(sent).toContain('from=2026-10');
		expect(sent).toContain('to=2026-10');
	});

	it('FREQ-583-AC-01: 元の売上の期間と返金の期間の課税・免税を出し、区分が無い（NULL）時は「不明」と出す（設計 5-j）', async () => {
		serve({
			rows: [
				row(1),
				row(2, { salePeriodStatus: 'exempt', refundPeriodStatus: 'taxable', exclusion: 'exempt_sale_14_1_6' }),
				row(3, { originalSaleDate: null, salePeriodStatus: null, refundPeriodStatus: 'exempt', exclusion: 'before_sale' }),
				row(4, { originalSaleDate: null, salePeriodStatus: null, refundPeriodStatus: null, exclusion: 'sale_unbooked' }),
			],
		});
		const region = open();
		fireEvent.click(show(region));
		const table = await within(region).findByRole('table', { name: '消費税用の返金の一覧' });
		const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
		const saleAt = headers.indexOf('元の売上の期間');
		const refundAt = headers.indexOf('返金の期間');
		expect([saleAt, refundAt]).toEqual([7, 8]);
		const cells = within(table).getAllByRole('row').slice(1).map((r) => {
			const tds = within(r).getAllByRole('cell');
			return [tds[saleAt].textContent, tds[refundAt].textContent];
		});
		expect(cells).toEqual([['課税', '課税'], ['免税', '課税'], ['不明', '免税'], ['不明', '不明']]);
	});

	it('FREQ-583-AC-01: 合計は含む額と外す額を分け、外す額の内訳（5つ目の理由を含む）を出す', async () => {
		serve();
		const region = open();
		fireEvent.click(show(region));
		const totals = await within(region).findByRole('group', { name: '合計' });
		expect(totals.textContent).toContain('含む 返金の額 ¥11,000 税額 ¥1,000');
		expect(totals.textContent).toContain('外す 返金の額 ¥38,000');
		expect(totals.textContent).toContain('出荷前の返金（元の売上がありません） ¥5,000');
		expect(totals.textContent).toContain('元の売上の仕訳がまだ無い（手で確かめる） ¥7,000');
		expect(totals.textContent).toContain('元の売上が免税の期間です ¥20,000');
		expect(totals.textContent).toContain('免税になった後・事業の形が変わった後の返金です ¥6,000');
	});

	it('FREQ-583-AC-04: 一覧に7年間保存する旨が出る', async () => {
		serve();
		const region = open();
		fireEvent.click(show(region));
		await within(region).findByRole('table', { name: '消費税用の返金の一覧' });
		const note = within(region).getByTestId('tax-refund-retention-note');
		expect(note).toHaveTextContent(ACCOUNTING_LABELS.taxRefundRetentionNote);
		expect(note).toHaveTextContent('7年間保存');
	});

	it('FREQ-583-AC-03: 期間は月で選び、12か月を超える・終わりが始まりより前の時は送る前に止める', () => {
		const api = serve();
		const region = open();
		fireEvent.change(from(region), { target: { value: '2025-09' } });
		fireEvent.change(to(region), { target: { value: '2026-10' } });
		expect(show(region)).toBeDisabled();
		expect(within(region).getByText('期間は12か月までです。')).toBeInTheDocument();
		fireEvent.change(from(region), { target: { value: '2026-11' } });
		expect(show(region)).toBeDisabled();
		expect(within(region).getByText('終わりの月は始まりの月と同じか後にしてください。')).toBeInTheDocument();
		expect(api.calls).toHaveLength(0);
		fireEvent.change(from(region), { target: { value: '2025-11' } });
		expect(show(region)).toBeEnabled();
	});

	it('FREQ-583-AC-03: 続きは日と行の印で読み、前のページの行の後ろに足す', async () => {
		const api = serve({ rows: [row(1)], next: { date: '2026-10-11', key: `${uuid(301)}:1` } });
		const region = open();
		fireEvent.click(show(region));
		fireEvent.click(await within(region).findByRole('button', { name: 'さらに読み込む' }));
		await waitFor(() => expect(api.calls.length).toBe(2));
		const second = String(api.fn.mock.calls[1][0]);
		expect(second).toContain('afterDate=2026-10-11');
		expect(second).toContain('afterKey=');
	});

	it('FREQ-583-AC-03: 続きの目印が正しくないと400の固定の文を穏やかに出し、読めた行は残す（やり直しの合図や読み直しは無い）', async () => {
		const api = serve({ rows: [row(1)], next: { date: '2026-10-11', key: `${uuid(301)}:1` }, cursorStatus: 400 });
		const region = open();
		fireEvent.click(show(region));
		fireEvent.click(await within(region).findByRole('button', { name: 'さらに読み込む' }));
		expect(await within(region).findByRole('alert')).toHaveTextContent('入力を確かめてください。');
		expect(api.calls).toHaveLength(2);
		expect(within(region).queryByText('一覧が変わったため、最初から読み直しました。')).not.toBeInTheDocument();
		expect(within(within(region).getByRole('table', { name: '消費税用の返金の一覧' })).getAllByRole('row').slice(1)).toHaveLength(1);
	});

	it('FREQ-583-AC-01: 読めなかった時は固定の文を出し、前の一覧を残さない', async () => {
		serve({ status: 500 });
		const region = open();
		fireEvent.click(show(region));
		expect(await within(region).findByRole('alert')).toHaveTextContent('会計の処理に失敗しました。');
		expect(within(region).queryByRole('table')).not.toBeInTheDocument();
	});
});
