import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrderReturnArrivalDialog from '@/components/OrderReturnArrivalDialog';
import { toJstDate } from '@/lib/accounting/jst-date';
import { mockFetch, uuid } from './cost-profit/settings-fixtures';

// 返品の届いた日を直す画面（FREQ-575・584）。route は POST /api/admin/accounting/return-arrival。

const RECEIPT_ID = uuid(31);
const URL_PATH = '/api/admin/accounting/return-arrival';
const today = () => toJstDate(new Date());

type Serve = { status?: number; body?: unknown };

function serve(reply: Serve = {}) {
	return mockFetch((url, method) => {
		if (url.pathname === URL_PATH && method === 'POST') {
			return { status: reply.status ?? 200, body: reply.body ?? { data: { arrival: { receiptId: RECEIPT_ID, version: 1, previousOn: '2026-11-09', newOn: '2026-11-08', correctionId: uuid(32), replayed: false } } } };
		}
		return undefined;
	});
}

function open() {
	const props = { onClose: jest.fn(), onDone: jest.fn() };
	render(<OrderReturnArrivalDialog receiptId={RECEIPT_ID} currentOn="2026-11-09" version={0} {...props} />);
	const dialog = screen.getByRole('dialog', { name: '届いた日を直す' });
	return { ...props, dialog };
}

const submitButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: '直して記録する' });
const dateInput = (dialog: HTMLElement) => within(dialog).getByLabelText('新しい届いた日') as HTMLInputElement;
const reasonInput = (dialog: HTMLElement) => within(dialog).getByLabelText('直す理由（必須）') as HTMLTextAreaElement;

describe('届いた日を直す画面', () => {
	it('FREQ-584-AC-02: 届いた日を直す操作は権限のある人だけに出て、理由が空なら送れない', async () => {
		const api = serve();
		const { dialog, onDone } = open();
		expect(dateInput(dialog).max).toBe(today());
		fireEvent.change(dateInput(dialog), { target: { value: '2026-11-08' } });
		// 理由が空（空白だけを含む）なら送れない
		expect(submitButton(dialog)).toBeDisabled();
		fireEvent.change(reasonInput(dialog), { target: { value: '   ' } });
		expect(submitButton(dialog)).toBeDisabled();
		fireEvent.change(reasonInput(dialog), { target: { value: '配達の記録で前の日に届いていた' } });
		expect(submitButton(dialog)).toBeEnabled();
		// 押した直後の2回目は止める
		fireEvent.click(submitButton(dialog));
		fireEvent.click(submitButton(dialog));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		const posts = api.calls.filter((call) => call.method === 'POST' && !call.url.includes('/api/auth/'));
		expect(posts).toHaveLength(1);
		expect(posts[0].body).toEqual({
			receiptId: RECEIPT_ID,
			newOn: '2026-11-08',
			reason: '配達の記録で前の日に届いていた',
			expectedVersion: 0,
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
	});

	it('FREQ-584-AC-02: 今の届いた日と同じ日・未来の日は送れない', () => {
		serve();
		const { dialog } = open();
		fireEvent.change(reasonInput(dialog), { target: { value: '理由' } });
		fireEvent.change(dateInput(dialog), { target: { value: '2026-11-09' } });
		expect(submitButton(dialog)).toBeDisabled();
		fireEvent.change(dateInput(dialog), { target: { value: '2999-01-01' } });
		expect(submitButton(dialog)).toBeDisabled();
		expect(within(dialog).getByText('未来の日は選べません。')).toBeInTheDocument();
	});

	it('FREQ-575-AC-01: 確定済みの取り消しがあって断られた時、理由の文が出る', async () => {
		serve({ status: 400, body: { error: '届いた日を確かめてください。', code: 'RETURN_ARRIVAL_DATE_INVALID' } });
		const { dialog, onDone } = open();
		fireEvent.change(dateInput(dialog), { target: { value: '2026-11-08' } });
		fireEvent.change(reasonInput(dialog), { target: { value: '前の日に届いた' } });
		fireEvent.click(submitButton(dialog));
		const alert = await within(dialog).findByRole('alert');
		expect(alert).toHaveTextContent('届いた日を確かめてください。');
		expect(alert).toHaveTextContent('カード会社の取り消しが確定した日以前');
		expect(alert.textContent).not.toMatch(/[!！]/);
		expect(onDone).not.toHaveBeenCalled();
	});

	it('FREQ-584-AC-05: 非okの応答の本文を読み切る', async () => {
		const api = serve({ status: 409, body: { error: '設定が変わりました。読み直してください。', code: 'ACCOUNTING_VERSION_CONFLICT' } });
		const { dialog } = open();
		fireEvent.change(dateInput(dialog), { target: { value: '2026-11-08' } });
		fireEvent.change(reasonInput(dialog), { target: { value: '前の日に届いた' } });
		fireEvent.click(submitButton(dialog));
		await within(dialog).findByRole('alert');
		expect(api.calls.find((call) => call.method === 'POST' && !call.url.includes('/api/auth/'))?.response.bodyUsed).toBe(true);
	});
});
