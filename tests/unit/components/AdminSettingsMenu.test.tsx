import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の左のメニューの SETTINGS（グループ E-2 の Task 13）。ショップの設定は店長だけが開ける。
 * 出し分けは page.tsx が役割で決めるので、本物の AdminSideNav と ShopSettingsSection をつないで確かめる。
 */
const clientFetchMock = jest.fn();
let mockUserRole: 'admin' | 'supporter' = 'admin';
let mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  // 同じ物を返し続ける。実際の useSearchParams も URL が変わるまで同じ物で、毎回新しく返すと、タブを押すたびに URL の tab へ戻される
  useSearchParams: () => mockSearchParams,
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: true,
    isAuthResolved: true,
    userRole: mockUserRole,
    isMfaVerified: true,
  }),
}));
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => clientFetchMock(...args),
}));
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);
jest.mock('@/components/OrderSection', () => () => null);

const SETTINGS_URL = '/api/admin/settings/shop';
const AUTO_REFUND_NAME = '取り消した注文に届いた入金を、自動で全額返金する';

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** 左のメニューのボタンの文字を、上から順に並べる */
function menuLabels(nav: HTMLElement): Array<string | null> {
  return within(nav)
    .getAllByRole('button')
    .map((button) => button.textContent);
}

beforeEach(() => {
  mockUserRole = 'admin';
  mockSearchParams = new URLSearchParams();
  clientFetchMock.mockReset();
  clientFetchMock.mockImplementation((url: string) => {
    const target = String(url);
    if (target === SETTINGS_URL) {
      return ok({
        data: {
          autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
          autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
        },
      });
    }
    if (target === '/api/admin/order-attention') {
      return ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } });
    }
    if (target.startsWith('/api/admin/orders?')) {
      return ok({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } });
    }
    return ok({ data: {} });
  });
});

describe('管理画面の左のメニューの SETTINGS', () => {
  it('店長のメニューには、ORDER の次（最後）に SETTINGS が出る。印は細線の歯車', async () => {
    render(<AdminPage />);
    const nav = await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(menuLabels(nav)).toEqual(['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER', 'SETTINGS']);
    expect(within(nav).getByRole('button', { name: 'SETTINGS' }).querySelector('i')).toHaveClass('ri-settings-3-line');
  });

  it('店長が SETTINGS を押すと、ショップの設定の画面が開いて、設定を読む', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'SETTINGS' }));

    expect(await screen.findByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: AUTO_REFUND_NAME })).toBeInTheDocument();
    expect(clientFetchMock).toHaveBeenCalledWith(SETTINGS_URL, { cache: 'no-store' });
    expect(screen.getByRole('button', { name: 'SETTINGS' })).toHaveAttribute('aria-current', 'page');
  });

  it('店長は URL の tab=SETTINGS で直接開ける', async () => {
    mockSearchParams = new URLSearchParams('tab=SETTINGS');
    render(<AdminPage />);

    expect(await screen.findByRole('switch', { name: AUTO_REFUND_NAME })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
  });

  it('サポートの人のメニューは ORDER だけで、SETTINGS は出ない', async () => {
    mockUserRole = 'supporter';
    render(<AdminPage />);
    const nav = await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(menuLabels(nav)).toEqual(['ORDER']);
    expect(screen.queryByRole('button', { name: 'SETTINGS' })).not.toBeInTheDocument();
  });

  it('サポートの人が tab=SETTINGS で開いても、ORDER に戻され、設定の窓口は読まない', async () => {
    mockUserRole = 'supporter';
    mockSearchParams = new URLSearchParams('tab=SETTINGS');
    render(<AdminPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'ORDER' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByRole('heading', { name: 'ショップの設定' })).not.toBeInTheDocument();
    expect(clientFetchMock).not.toHaveBeenCalledWith(SETTINGS_URL, expect.anything());
  });
});
