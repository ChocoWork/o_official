import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の ORDER タブと、履歴のダイアログ・発送の画面のつなぎ込み（グループ D、Task 7）。
 * 部品ごとの試験（OrderHistoryDialog・OrderShipDialog・OrderSection）では見えない、管理画面の中での配線を確かめる。
 * 一覧は本物の OrderSection を使い、窓口（clientFetch）だけを差し替える。
 */
const clientFetchMock = jest.fn();

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=ORDER'),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: true,
    isAuthResolved: true,
    userRole: 'admin',
    isMfaVerified: true,
  }),
}));
jest.mock('@/lib/client-fetch', () => ({
  // 要対応・要確認はこの試験の対象ではないので、未処理なしを返す
  clientFetch: (...args: unknown[]) =>
    String(args[0]) === '/api/admin/order-attention'
      ? Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }),
        })
      : clientFetchMock(...args),
}));
jest.mock('@/components/AdminSideNav', () => () => null);
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

const ordersBody = {
  data: [
    {
      id: ORDER_ID,
      customerName: '山田 花子',
      customerEmail: 'hanako@example.com',
      orderDate: '2026-10-09',
      itemCount: '1点',
      items: [{ name: 'シルクブラウス', quantity: 1 }],
      totalAmount: '¥28,800',
      status: '決済完了',
      canShip: true,
    },
  ],
  pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
};

const historyBody = {
  order: { id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: 'hanako@example.com' },
  sendPaused: null,
  entries: [{ type: 'created', at: '2026-10-09T00:59:00.000Z' }],
};

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** 発送の窓口（/status）へ送った本文を取り出す */
function shipBody(): unknown {
  const call = clientFetchMock.mock.calls.find(([url]) => String(url).endsWith('/status'));
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

describe('管理画面の注文の履歴と発送のつなぎ込み', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    clientFetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/admin/orders?')) return ok(ordersBody);
      if (String(url).endsWith('/history')) return ok(historyBody);
      if (String(url).endsWith('/status')) return ok({ success: true, status: 'shipped' });
      return ok({});
    });
  });

  it('「履歴」を押すと履歴のダイアログが開き、Escape で閉じると、その「履歴」のボタンへフォーカスが戻る', async () => {
    render(<AdminPage />);
    const historyButton = await screen.findByRole('button', { name: 'ORD-A1B2C3D4 の履歴' });
    historyButton.focus();
    fireEvent.click(historyButton);

    const dialog = await screen.findByRole('dialog', { name: 'この注文の履歴' });
    await within(dialog).findByText('宛先: hanako@example.com');
    expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/history`, { cache: 'no-store' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(historyButton).toHaveFocus();
  });

  it('発送: チェックを外すと notifyCustomer=false で送り、画面を閉じて、一覧を「発送済み」にする', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));

    const dialog = screen.getByRole('dialog', { name: '発送済みにする' });
    const checkbox = within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: ' E2E-1 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(clientFetchMock).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/status`, expect.objectContaining({ method: 'POST' }));
    expect(shipBody()).toEqual({ status: 'shipped', carrier: 'yamato', trackingNumber: 'E2E-1', notifyCustomer: false });
    expect(await screen.findByText('発送済み', { selector: 'span' })).toBeInTheDocument();
  });

  it('発送: 既定のままなら notifyCustomer=true で送る', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = screen.getByRole('dialog', { name: '発送済みにする' });
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(shipBody()).toBeDefined());
    expect(shipBody()).toEqual({ status: 'shipped', carrier: 'yamato', trackingNumber: '1234-5678', notifyCustomer: true });
  });

  it('発送: 追跡番号が不正なら、画面の中に知らせて、送らず、画面は開いたまま', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = screen.getByRole('dialog', { name: '発送済みにする' });
    fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value: 'あいう' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(shipBody()).toBeUndefined();
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
  });

  it('発送: 「キャンセル」で閉じ、送らない。開き直すと既定（チェックは入っている）に戻る', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '発送済みにする' }));
    const dialog = screen.getByRole('dialog', { name: '発送済みにする' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(shipBody()).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: '発送済みにする' }));
    expect(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
  });
});
