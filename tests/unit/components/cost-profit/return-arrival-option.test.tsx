import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReturnArrivalOptionSection } from '@/components/cost-profit/settings-view';
import { SwitchToggle } from '@/components/ui/SwitchToggle/SwitchToggle';
import { BASE, envelope } from './accounting-fixtures';
import { mockFetch } from './settings-fixtures';

// 返品の届いた日に運送会社の配達日を使う設定（FREQ-575-AC-04）。route は GET/PUT /return-options。

const NOTICE_KEY = 'return_tracking_unregistered';

function option(enabled: boolean, version = '1') {
	return { useCarrierDeliveryDate: enabled, changedAt: enabled ? '2026-11-01T00:00:00+00:00' : null, version, noticeKey: NOTICE_KEY };
}

type Serve = { enabled?: boolean; manageSettings?: boolean; put?: { status: number; body: unknown }; getStatus?: number };

function serve(state: Serve = {}) {
	let enabled = state.enabled ?? false;
	let version = 1;
	return mockFetch((url, method, body) => {
		if (url.pathname !== `${BASE}/return-options`) return undefined;
		if (method === 'GET') {
			if (state.getStatus) return { status: state.getStatus, body: { error: '会計の処理に失敗しました。' } };
			return { status: 200, body: envelope({ option: option(enabled, String(version)) }, { manageSettings: state.manageSettings ?? true } as never) };
		}
		if (state.put) return state.put;
		enabled = (body as { enabled: boolean }).enabled;
		version += 1;
		return { status: 200, body: { data: { option: option(enabled, String(version)) } } };
	});
}

function open() {
	render(<ReturnArrivalOptionSection />);
	return screen.getByRole('region', { name: '返品の届いた日' });
}

const toggle = (region: HTMLElement) => within(region).getByRole('switch', { name: '運送会社の配達日を届いた日に使う' });

describe('配達日を使う設定', () => {
	it('FREQ-575-AC-04: 配達日の設定は既定がオフで、切り替える時に年の途中の注意が出る', async () => {
		const api = serve();
		const region = open();
		await waitFor(() => expect(toggle(region)).toHaveAttribute('aria-checked', 'false'));
		// 追跡のサービスに登録できるようになるまでは使えない旨は、いつも出す
		const trackingNotice = within(region).getByTestId('return-option-tracking-notice');
		expect(trackingNotice).toHaveTextContent('返品の追跡番号を追跡のサービスに登録できるようになるまで、配達日は自動では入りません');
		// 切り替えを押しても、注意に同意するまで送らない
		fireEvent.click(toggle(region));
		expect(await within(region).findByText(/年の途中で切り替えると/)).toBeInTheDocument();
		expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
		fireEvent.click(within(region).getByRole('button', { name: 'この内容で切り替える' }));
		await waitFor(() => expect(toggle(region)).toHaveAttribute('aria-checked', 'true'));
		const puts = api.calls.filter((call) => call.method === 'PUT');
		expect(puts).toHaveLength(1);
		expect(puts[0].body).toEqual({ enabled: true, expectedVersion: '1', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
		expect(region.textContent).not.toMatch(/[!！]/);
	});

	it('FREQ-575-AC-04: 切り替えは、追跡のサービスの注意の文に aria-describedby で結ばれている', async () => {
		serve();
		const region = open();
		await waitFor(() => expect(toggle(region)).toBeEnabled());
		const describedBy = toggle(region).getAttribute('aria-describedby') ?? '';
		expect(describedBy).not.toBe('');
		const target = document.getElementById(describedBy.split(' ')[0]);
		expect(target).toBe(within(region).getByTestId('return-option-tracking-notice'));
	});

	it('FREQ-575-AC-04: 権限が無い人には切り替えを押せなくして、読み取りだけにする', async () => {
		serve({ enabled: true, manageSettings: false });
		const region = open();
		await waitFor(() => expect(toggle(region)).toHaveAttribute('aria-checked', 'true'));
		expect(toggle(region)).toBeDisabled();
		expect(within(region).getByText('切り替えられるのは、権限のある人だけです')).toBeInTheDocument();
	});

	it('FREQ-575-AC-04: 版の衝突（409）は読み直す旨を出し、非okの本文を読み切る', async () => {
		const api = serve({ put: { status: 409, body: { error: '設定が変わりました。読み直してください。', code: 'ACCOUNTING_VERSION_CONFLICT' } } });
		const region = open();
		await waitFor(() => expect(toggle(region)).toBeEnabled());
		fireEvent.click(toggle(region));
		fireEvent.click(await within(region).findByRole('button', { name: 'この内容で切り替える' }));
		expect(await within(region).findByText('設定が変わりました。読み直してください。')).toBeInTheDocument();
		const put = api.calls.find((call) => call.method === 'PUT');
		expect(put?.response.bodyUsed).toBe(true);
	});
});

describe('SwitchToggle の aria-describedby', () => {
	it('Task 2 M6: ariaDescribedBy を渡すと切り替えのボタンに aria-describedby が付き、渡さなければ付かない', () => {
		const { rerender } = render(<SwitchToggle label="設定" checked={false} onChange={() => undefined} ariaDescribedBy="reason-note" />);
		expect(screen.getByRole('switch')).toHaveAttribute('aria-describedby', 'reason-note');
		rerender(<SwitchToggle label="設定" checked={false} onChange={() => undefined} />);
		expect(screen.getByRole('switch')).not.toHaveAttribute('aria-describedby');
	});
});
