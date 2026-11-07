import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PeriodForm } from '@/components/cost-profit/period-form';
import { corporatePeriod, mockFetch, settingsOf, solePeriod } from './settings-fixtures';

// 期間の追加フォーム（FREQ-555）。送る前に validateNewPeriod で止める。

describe('期間の追加フォーム', () => {
	it('FREQ-555-AC-01: 期間フォームは1年を超える入力を送る前に止めすき間を案内する', async () => {
		const onCreated = jest.fn();
		const { calls: allCalls } = mockFetch((url, method) => (url.pathname === '/api/admin/accounting/periods' && method === 'POST'
			? { status: 201, body: { data: { period: solePeriod(2027) } } }
			: undefined));
		// clientFetch が先に送る要求（CSRF の印など）は数えない。
		const posts = () => allCalls.filter((call) => call.url === '/api/admin/accounting/periods' && call.method === 'POST');
		const { unmount } = render(<PeriodForm periods={[solePeriod(2026)]} settings={settingsOf()} onCreated={onCreated} />);

		// 個人は年だけを入れる。途中でやめた年は短い期間を作らず、やめた日の登録へ。
		expect(screen.getByText('個人の期間は1月1日から12月31日までです。年の途中で事業をやめた時は、ここで短い期間を作らず「事業をやめた日を登録する」から登録してください。')).toBeInTheDocument();
		expect(screen.queryByLabelText('終わり（決算日）')).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('年'), { target: { value: '2028' } });
		fireEvent.click(screen.getByRole('button', { name: '期間を追加' }));
		expect(screen.getByText('前の期間とすき間があります。2027/01/01から始まる期間にしてください。')).toBeInTheDocument();
		expect(posts()).toHaveLength(0);

		fireEvent.change(screen.getByLabelText('年'), { target: { value: '2027' } });
		fireEvent.click(screen.getByRole('button', { name: '期間を追加' }));
		await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
		expect(posts()[0].body).toEqual({
			businessType: 'soleProprietor', startsOn: '2027-01-01', endsOn: '2027-12-31',
			requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		unmount();

		// 法人は成立の日と決算日。1年を超える入力は送らない。
		render(<PeriodForm periods={[solePeriod(2026)]} settings={settingsOf({ currentBusinessType: 'corporation', soleBusinessEndedOn: '2026-12-31' })} onCreated={onCreated} />);
		fireEvent.change(screen.getByLabelText('始まり（成立の日）'), { target: { value: '2027-01-01' } });
		fireEvent.change(screen.getByLabelText('終わり（決算日）'), { target: { value: '2028-01-01' } });
		fireEvent.click(screen.getByRole('button', { name: '期間を追加' }));
		expect(screen.getByText('会計の期間は1年を超えられません。')).toBeInTheDocument();
		expect(posts()).toHaveLength(1);
	});

	it('FREQ-555-AC-01: 法人の後の期間は前の期間の翌日から始めるよう案内する', () => {
		const { calls: allCalls } = mockFetch(() => undefined);
		const posts = () => allCalls.filter((call) => call.method === 'POST');
		const first = corporatePeriod(1, '2027-01-01', '2027-12-31');
		render(<PeriodForm periods={[solePeriod(2026), first]} settings={settingsOf({ currentBusinessType: 'corporation', soleBusinessEndedOn: '2026-12-31' })} onCreated={jest.fn()} />);
		fireEvent.change(screen.getByLabelText('始まり'), { target: { value: '2028-02-01' } });
		fireEvent.change(screen.getByLabelText('終わり（決算日）'), { target: { value: '2028-12-31' } });
		fireEvent.click(screen.getByRole('button', { name: '期間を追加' }));
		expect(screen.getByText('前の期間とすき間があります。2028/01/01から始まる期間にしてください。')).toBeInTheDocument();
		expect(posts()).toHaveLength(0);
	});

	it('FREQ-555-AC-08: やめた日の登録後は後の個人の期間の追加を案内せず法人の期間の作成を案内する', () => {
		mockFetch(() => undefined);
		render(<PeriodForm periods={[solePeriod(2026, { endsOn: '2026-06-30' })]} settings={settingsOf({ soleBusinessEndedOn: '2026-06-30' })} onCreated={jest.fn()} />);

		expect(screen.getByText('やめた日を登録したので、次は法人の期間を作ります。個人の期間はこれより後に作りません。')).toBeInTheDocument();
		expect(screen.queryByLabelText('年')).not.toBeInTheDocument();
		expect(screen.queryByRole('combobox', { name: '期間の事業の形' })).not.toBeInTheDocument();
		expect(screen.getByLabelText('始まり（成立の日）')).toBeInTheDocument();
		expect(screen.getByText('決算月を変えた時は税務署へ遅滞なく届け出てください（法人税法15条）')).toBeInTheDocument();
	});
});
