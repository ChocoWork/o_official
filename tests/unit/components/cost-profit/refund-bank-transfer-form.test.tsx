import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RefundBankTransferForm } from '@/components/cost-profit/refund-bank-transfer-form';
import { toJstDate } from '@/lib/accounting/jst-date';
import { BASE, uuid } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 振込で返した分の記録（FREQ-579-AC-04・FREQ-584-AC-03）。route は POST /refund-bank-transfers。

const ORDER_ID = uuid(88);
const ORDERS = [{ orderId: ORDER_ID, orderNumber: 'ORD-00000058' }, { orderId: uuid(89), orderNumber: 'ORD-00000059' }];
const today = () => toJstDate(new Date());

type Reply = { status: number; body: unknown };

function serve(reply?: Reply) {
	return mockFetch((url, method) => {
		if (url.pathname === `${BASE}/refund-bank-transfers` && method === 'POST') {
			return reply ?? { status: 200, body: { data: { transfer: { entry_id: uuid(5), entry_no: 12, period_id: uuid(6), created: true } } } };
		}
		return undefined;
	});
}

function open(onDone = jest.fn()) {
	render(<RefundBankTransferForm orders={ORDERS} initial={{ orderId: ORDER_ID, origin: 'post_shipment' }} onDone={onDone} />);
	return { onDone, form: screen.getByRole('group', { name: '振込で返した分を記録する' }) };
}

const amount = (form: HTMLElement) => within(form).getByLabelText('額（円）') as HTMLInputElement;
const bankDate = (form: HTMLElement) => within(form).getByLabelText('振込の日') as HTMLInputElement;
const txn = (form: HTMLElement) => within(form).getByLabelText('銀行の取引の番号') as HTMLInputElement;
const note = (form: HTMLElement) => within(form).getByLabelText('メモ（任意）') as HTMLTextAreaElement;
const submit = (form: HTMLElement) => within(form).getByRole('button', { name: '振込を記録する' });

function fillValid(form: HTMLElement) {
	fireEvent.change(amount(form), { target: { value: '3000' } });
	fireEvent.change(bankDate(form), { target: { value: '2026-11-10' } });
	fireEvent.change(txn(form), { target: { value: 'BANK-20261110-01' } });
}

describe('振込の記録', () => {
	it('FREQ-584-AC-03: 振込の日の下に、切り替えの日より前とカード会社の取り消しが確定した日以前は記録できない旨を、日を入れる前から出す', () => {
		serve();
		const { form } = open();
		const hint = '切り替えの日より前の日と、カード会社の取り消しが確定した日以前の日は、記録できません。';
		expect(within(form).getByText(hint)).toBeInTheDocument();
		// この断りは DB が決める（画面は日付を知らない）ので、入れた日では消えず、送る前に止めもしない
		fireEvent.change(bankDate(form), { target: { value: '2026-11-10' } });
		expect(within(form).getByText(hint)).toBeInTheDocument();
		expect(form.textContent).not.toMatch(/[!！]/);
	});

	it('FREQ-584-AC-03: 振込の記録は未来の日と額0を送る前に止める', () => {
		const api = serve();
		const { form } = open();
		fillValid(form);
		expect(submit(form)).toBeEnabled();
		expect(bankDate(form).max).toBe(today());

		fireEvent.change(bankDate(form), { target: { value: '2999-01-01' } });
		expect(submit(form)).toBeDisabled();
		expect(within(form).getByText('振込の日は今日までです。')).toBeInTheDocument();

		fireEvent.change(bankDate(form), { target: { value: '2026-11-10' } });
		fireEvent.change(amount(form), { target: { value: '0' } });
		expect(submit(form)).toBeDisabled();
		expect(within(form).getByText('額は1円以上で入れてください。')).toBeInTheDocument();
		fireEvent.submit(form.closest('form') as HTMLFormElement);
		expect(api.calls).toHaveLength(0);
	});

	it('FREQ-584-AC-03: 銀行の取引の番号は英数字・ハイフン・下線の100字まで。空や記号の混じりは送れない', () => {
		serve();
		const { form } = open();
		fillValid(form);
		fireEvent.change(txn(form), { target: { value: '番号 1' } });
		expect(submit(form)).toBeDisabled();
		fireEvent.change(txn(form), { target: { value: '' } });
		expect(submit(form)).toBeDisabled();
		fireEvent.change(txn(form), { target: { value: 'ok_1-2' } });
		expect(submit(form)).toBeEnabled();
	});

	it('FREQ-579-AC-04: 記録を送ると本文が route の形で、二重に押せず、成功で onDone', async () => {
		const api = serve();
		const { form, onDone } = open();
		fillValid(form);
		fireEvent.change(note(form), { target: { value: '  銀行の控えで確認  ' } });
		fireEvent.click(submit(form));
		fireEvent.click(submit(form));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		const posts = api.calls.filter((call) => call.method === 'POST' && !call.url.includes('/api/auth/'));
		expect(posts).toHaveLength(1);
		expect(posts[0].body).toEqual({
			orderId: ORDER_ID,
			origin: 'post_shipment',
			amount: 3000,
			bankDate: '2026-11-10',
			bankTxnNo: 'BANK-20261110-01',
			note: '銀行の控えで確認',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
	});

	it('FREQ-579-AC-04: 振込の記録は借りの残高を超える額で出たエラーの文を出す', async () => {
		const api = serve({ status: 409, body: { error: 'この出来事は今は仕訳にできません。計上待ちの一覧で理由を確かめてください。', code: 'ACCOUNTING_EVENT_NOT_POSTABLE' } });
		const { form, onDone } = open();
		fillValid(form);
		fireEvent.click(submit(form));
		const alert = await within(form).findByRole('alert');
		expect(alert).toHaveTextContent('借りの残高を超えているか、借りの仕訳がまだ入っていません。額と借りの種類を確かめてください。');
		expect(onDone).not.toHaveBeenCalled();
		// 本文を読み切る（FREQ-584-AC-05）
		expect(api.calls.find((call) => call.method === 'POST' && !call.url.includes('/api/auth/'))?.response.bodyUsed).toBe(true);
	});

	it('FREQ-579-AC-04: 同じ銀行の取引の番号を別の要求で送った時（created が偽）は、もう記録済みの旨を出す', async () => {
		serve({ status: 200, body: { data: { transfer: { entry_id: uuid(5), entry_no: 12, period_id: uuid(6), created: false } } } });
		const { form, onDone } = open();
		fillValid(form);
		fireEvent.click(submit(form));
		expect(await within(form).findByRole('status')).toHaveTextContent('同じ銀行の取引の番号は、もう記録されています。');
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it('FREQ-579-AC-04: 権限が無い時の403は理由を出し、送れた扱いにしない', async () => {
		serve({ status: 403, body: { error: '権限がありません。' } });
		const { form, onDone } = open();
		fillValid(form);
		fireEvent.click(submit(form));
		expect(await within(form).findByRole('alert')).toHaveTextContent('権限がありません。');
		expect(onDone).not.toHaveBeenCalled();
	});
});
