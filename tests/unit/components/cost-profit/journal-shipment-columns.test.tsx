import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JournalShipmentPanel } from '@/components/cost-profit/journal-view';
import { BASE, envelope, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 仕訳帳の出荷の列と出荷の跡（FREQ-564-AC-03・AC-04）。
// 仕訳の読み口は shipmentMeta（出荷の仕訳だけ）を足す。跡は {slip, history, entries}（snake_case）。

const PERIOD = uuid(2026);
const SLIP = uuid(901);
const E5 = uuid(305);
const E6 = uuid(306);
const E7 = uuid(307);

function entry(id: string, no: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		periodId: PERIOD,
		entryNo: no,
		entryDate: '2026-11-03',
		eventKind: 'payment_confirmed',
		dedupeKey: `k:${no}`,
		description: '注文の支払い',
		recordedAt: '2026-11-03T05:00:00+00:00',
		recordedBy: null,
		isLate: false,
		reversesEntryId: null,
		reason: null,
		sourceTable: 'orders',
		sourceId: uuid(800 + no),
		migratedFrom: null,
		migratedAt: null,
		sourceRecordedAt: null,
		lines: [],
		...overrides,
	};
}

const SHIPMENT_ENTRY = entry(E5, 5, { eventKind: 'shipment_confirmed', description: '出荷', sourceTable: 'shipment_slips', sourceId: SLIP });
const PAYMENT_ENTRY = entry(uuid(304), 4);
const META = { entryId: E5, slipNumber: 'SL-20261103-0001', shipmentDate: '2026-11-03', confirmedAt: '2026-11-03T16:30:00+00:00' };

const TRACE = {
	slip: { number: 'SL-20261103-0001', confirmed_at: '2026-11-03T16:30:00+00:00', shipment_date: '2026-11-05', stage: 'confirmed' },
	history: [
		{ version: 1, kind: 'initial', previous_date: '2026-11-03', new_date: '2026-11-03', reason: null, actor_id: uuid(11), created_at: '2026-11-03T16:30:00+00:00' },
		{ version: 2, kind: 'correction', previous_date: '2026-11-03', new_date: '2026-11-05', reason: '出荷日の記録の誤り', actor_id: uuid(12), created_at: '2026-11-04T02:00:00+00:00' },
	],
	entries: [
		{ entry_id: E5, entry_no: 5, event_kind: 'shipment_confirmed', entry_date: '2026-11-03', recorded_at: '2026-11-03T17:00:00+00:00', reverses_entry_id: null },
		{ entry_id: E6, entry_no: 6, event_kind: 'reversal', entry_date: '2026-11-03', recorded_at: '2026-11-04T02:00:01+00:00', reverses_entry_id: E5 },
		{ entry_id: E7, entry_no: 7, event_kind: 'shipment_redated', entry_date: '2026-11-05', recorded_at: '2026-11-04T02:00:02+00:00', reverses_entry_id: null },
	],
};

function serve(pages?: Record<string, unknown>) {
	return mockFetch((url) => {
		if (url.pathname === `${BASE}/journal`) {
			const body = pages?.[url.searchParams.get('afterEntryNo') ?? 'first'] ?? {
				entries: [PAYMENT_ENTRY, SHIPMENT_ENTRY], nextAfter: null, opening: [], shipmentMeta: [META],
			};
			return { status: 200, body: envelope(body) };
		}
		if (url.pathname === `${BASE}/shipment-trace`) return { status: 200, body: envelope(TRACE) };
		return undefined;
	});
}

describe('仕訳帳の出荷の列', () => {
	jest.setTimeout(30000);

	it('FREQ-564-AC-04: 仕訳帳の出荷の仕訳に出荷した日と登録した日が並び、ほかの仕訳は空', async () => {
		const api = serve();
		render(<JournalShipmentPanel periodId={PERIOD} />);
		const region = await screen.findByRole('region', { name: '出荷の仕訳の日付' });
		const table = await within(region).findByRole('table', { name: '保存した仕訳' });
		expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
			'伝票No.', '日付', '摘要', '出荷した日', '登録した日', '出荷の跡',
		]);
		expect(api.fn.mock.calls[0][0]).toContain(`periodId=${PERIOD}`);
		const rows = within(table).getAllByRole('row').slice(1);
		const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);
		// 出荷の仕訳: 出荷した日 = 発送票の出荷日、登録した日 = 発送票を確定した日（日本時間）。
		expect(cells(rows[1]).slice(0, 5)).toEqual(['JE-000005', '2026/11/03', '出荷', '2026/11/03', '2026/11/04']);
		expect(within(rows[1]).getByRole('button', { name: 'JE-000005の出荷の跡を開く' })).toBeInTheDocument();
		// 出荷でない仕訳は、2つの列とも空で、跡の操作も無い。
		expect(cells(rows[0])).toEqual(['JE-000004', '2026/11/03', '注文の支払い', '', '', '']);
		expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument();
	});

	it('FREQ-564-AC-04: 続きがあれば「さらに読み込む」で次の仕訳を足す', async () => {
		const api = serve({
			first: { entries: [PAYMENT_ENTRY], nextAfter: { entryDate: '2026-11-03', entryNo: 4 }, opening: [], shipmentMeta: [] },
			'4': { entries: [SHIPMENT_ENTRY], nextAfter: null, opening: [], shipmentMeta: [META] },
		});
		render(<JournalShipmentPanel periodId={PERIOD} />);
		fireEvent.click(await screen.findByRole('button', { name: 'さらに読み込む' }));
		await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes('afterEntryDate=2026-11-03&afterEntryNo=4'))).toBe(true);
		expect(screen.queryByRole('button', { name: 'さらに読み込む' })).not.toBeInTheDocument();
	});

	it('FREQ-564-AC-04: 期間が無ければ読まず、案内だけを出す', () => {
		const api = serve();
		render(<JournalShipmentPanel periodId={null} />);
		expect(screen.getByText('期間を選ぶと、出荷の仕訳の日付を出します')).toBeInTheDocument();
		expect(api.calls).toHaveLength(0);
	});

	it('FREQ-564-AC-03: 出荷の跡に直した理由・人・前後の日と、取り消しと正しい仕訳が並ぶ', async () => {
		const api = serve();
		render(<JournalShipmentPanel periodId={PERIOD} />);
		fireEvent.click(await screen.findByRole('button', { name: 'JE-000005の出荷の跡を開く' }));

		const trace = await screen.findByRole('region', { name: '出荷の跡' });
		expect(api.fn.mock.calls.some((call) => String(call[0]).includes(`shipment-trace?slipId=${SLIP}`))).toBe(true);
		await within(trace).findByRole('list', { name: '出荷日の直した跡' });
		expect(trace).toHaveTextContent('SL-20261103-0001');
		expect(trace).toHaveTextContent('今の出荷日 2026/11/05');

		const history = within(trace).getByRole('list', { name: '出荷日の直した跡' });
		const items = within(history).getAllByRole('listitem');
		expect(items[0]).toHaveTextContent('最初の出荷日 2026/11/03');
		expect(items[1]).toHaveTextContent('2026/11/03 から 2026/11/05 へ直しました');
		expect(items[1]).toHaveTextContent('理由 出荷日の記録の誤り');
		expect(items[1]).toHaveTextContent('担当 00000000');
		expect(items[1]).toHaveTextContent('直した日 2026/11/04');

		const entries = within(trace).getByRole('list', { name: 'この出荷の仕訳' });
		const rows = within(entries).getAllByRole('listitem');
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent('JE-000005');
		expect(rows[0]).toHaveTextContent('取り消されました（JE-000006）');
		expect(rows[1]).toHaveTextContent('JE-000006');
		expect(rows[1]).toHaveTextContent('JE-000005を取り消す');
		expect(rows[2]).toHaveTextContent('JE-000007');
		expect(rows[2]).toHaveTextContent('今の正しい仕訳');
		// お客様の名前・メールは出さない。
		expect(trace.textContent).not.toMatch(/@|様/);
	});

	it('FREQ-564-AC-03: 跡が読めなければ固定の文を出して本文を読み切り、閉じられる', async () => {
		const api = mockFetch((url) => {
			if (url.pathname === `${BASE}/journal`) return { status: 200, body: envelope({ entries: [SHIPMENT_ENTRY], nextAfter: null, opening: [], shipmentMeta: [META] }) };
			return { status: 404, body: { code: 'ACCOUNTING_NOT_FOUND', error: '会計の記録が見つかりません。' } };
		});
		render(<JournalShipmentPanel periodId={PERIOD} />);
		fireEvent.click(await screen.findByRole('button', { name: 'JE-000005の出荷の跡を開く' }));
		expect(await screen.findByText('会計の記録が見つかりません。')).toBeInTheDocument();
		expect(api.calls.find((call) => call.url === `${BASE}/shipment-trace`)?.response.bodyUsed).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: '出荷の跡を閉じる' }));
		expect(screen.queryByRole('region', { name: '出荷の跡' })).not.toBeInTheDocument();
	});
});
