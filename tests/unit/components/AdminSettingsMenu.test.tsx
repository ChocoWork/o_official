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
jest.mock('@/components/ContactSection', () => () => {
  return require('react').createElement('div', { 'data-testid': 'contact-section' });
});

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
    return ok({ data: {} });
  });
});

describe('管理画面の左のメニューの SETTINGS', () => {
  it('FREQ-525-AC-01: 店長のメニューには、ORDER・INVENTORY・PACKING・CONTACT の次（最後）に SETTINGS が出る。印は細線の歯車', async () => {
    render(<AdminPage />);
    const nav = await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(menuLabels(nav)).toEqual(['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER', 'INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT', 'SETTINGS']);
    expect(within(nav).getByRole('button', { name: 'SETTINGS' }).querySelector('i')).toHaveClass('ri-settings-3-line');
  });

  it('店長が SETTINGS を押すと、ショップの設定の画面が開いて、設定を読む', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'SETTINGS' }));

    expect(await screen.findByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: AUTO_REFUND_NAME })).toBeInTheDocument();
    const settingsMenu = screen.getByRole('navigation', { name: '設定メニュー' });
    expect(within(settingsMenu).getByRole('link', { name: '権限' })).toHaveAttribute('href', '/admin/settings/permissions');
    expect(settingsMenu.compareDocumentPosition(screen.getByRole('heading', { name: 'ショップの設定' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(clientFetchMock).toHaveBeenCalledWith(SETTINGS_URL, { cache: 'no-store' });
    expect(screen.getByRole('button', { name: 'SETTINGS' })).toHaveAttribute('aria-current', 'page');
  });

  it('店長は URL の tab=SETTINGS で直接開ける', async () => {
    mockSearchParams = new URLSearchParams('tab=SETTINGS');
    render(<AdminPage />);

    expect(await screen.findByRole('switch', { name: AUTO_REFUND_NAME })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
  });

  it('FREQ-525-AC-01: サポートの人のメニューは ORDER・INVENTORY・PACKING・CONTACT で、SETTINGS は出ない', async () => {
    mockUserRole = 'supporter';
    render(<AdminPage />);
    const nav = await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(menuLabels(nav)).toEqual(['ORDER', 'INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT']);
    expect(screen.queryByRole('button', { name: 'SETTINGS' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '権限' })).not.toBeInTheDocument();
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

/**
 * 管理画面の左のメニューの ORDER（G-4 / FREQ-539-AC-05。注文一覧表への入口だけ）。
 * 中身は役割で出し分けず、店長とサポーターの両方に同じ物を出す。一覧・要対応の欄・各操作は /admin/orders と /admin/orders/[id] にある。
 */
describe('管理画面の左のメニューの ORDER', () => {
  const MENU = '注文メニュー';

  it.each(['admin', 'supporter'] as const)('FREQ-539-AC-05: %s の ORDER は注文一覧表へのリンクだけが並び、旧い一覧の窓口は読まない', async (role) => {
    mockUserRole = role;
    mockSearchParams = new URLSearchParams('tab=ORDER');
    render(<AdminPage />);

    const menu = await screen.findByRole('navigation', { name: MENU });
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['注文一覧表']);
    expect(within(menu).getByRole('link', { name: '注文一覧表' })).toHaveAttribute('href', '/admin/orders');
    expect(screen.getByRole('button', { name: 'ORDER' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(clientFetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/api/admin/orders'))).toEqual([]);
  });

  it('FREQ-539-AC-05: タブを移るたびに要対応の件数を読み直す（開きっぱなしの間も、バッジと KPI の帯を新しく保つ）', async () => {
    mockSearchParams = new URLSearchParams('tab=ORDER');
    render(<AdminPage />);
    await screen.findByRole('navigation', { name: '注文メニュー' });
    const attentionReads = () => clientFetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/order-attention').length;
    await waitFor(() => expect(attentionReads()).toBeGreaterThanOrEqual(1));
    const before = attentionReads();

    fireEvent.click(screen.getByRole('button', { name: 'INVENTORY' }));
    await screen.findByRole('navigation', { name: '在庫・発注メニュー' });
    await waitFor(() => expect(attentionReads()).toBe(before + 1));

    fireEvent.click(screen.getByRole('button', { name: 'ORDER' }));
    await screen.findByRole('navigation', { name: '注文メニュー' });
    await waitFor(() => expect(attentionReads()).toBe(before + 2));
  });

  it('FREQ-539-AC-05: ORDER の外（INVENTORY）では注文メニューを出さない', async () => {
    mockSearchParams = new URLSearchParams('tab=INVENTORY');
    render(<AdminPage />);
    await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(screen.queryByRole('navigation', { name: MENU })).not.toBeInTheDocument();
  });
});

/**
 * 管理画面の左のメニューの INVENTORY（G-2 / FREQ-525。在庫一覧表と発注一覧表への入口）。
 * 中身は役割で出し分けず、店長とサポーターの両方に同じ物を出す。権限の無い人が開いた先は各頁の権限の文（窓口と DB が守る）。
 */
describe('管理画面の左のメニューの INVENTORY', () => {
  const MENU = '在庫・発注メニュー';

  it.each(['admin', 'supporter'] as const)('FREQ-525-AC-01: %s が INVENTORY を押すと、在庫一覧表と発注一覧表へのリンクが並ぶ', async (role) => {
    mockUserRole = role;
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'INVENTORY' }));

    const menu = await screen.findByRole('navigation', { name: MENU });
    const links = within(menu).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['在庫一覧表', '発注一覧表']);
    expect(within(menu).getByRole('link', { name: '在庫一覧表' })).toHaveAttribute('href', '/admin/inventory');
    expect(within(menu).getByRole('link', { name: '発注一覧表' })).toHaveAttribute('href', '/admin/purchase-orders');
    expect(screen.getByRole('button', { name: 'INVENTORY' })).toHaveAttribute('aria-current', 'page');
    // 一覧そのものはリンク先の頁が読む。この画面は在庫の窓口を読まない
    expect(clientFetchMock).not.toHaveBeenCalledWith('/api/admin/inventory', expect.anything());
  });

  it('FREQ-525-AC-01: INVENTORY の印は細線の箱で、店長のメニューでは ORDER の次（SETTINGS の前）に並ぶ', async () => {
    render(<AdminPage />);
    const nav = await screen.findByRole('navigation', { name: '管理メニュー' });
    expect(within(nav).getByRole('button', { name: 'INVENTORY' }).querySelector('i')).toHaveClass('ri-archive-line');
    expect(menuLabels(nav).slice(7, 9)).toEqual(['ORDER', 'INVENTORY']);
  });

  it.each(['admin', 'supporter'] as const)('FREQ-525-AC-01: %s は URL の tab=INVENTORY で直接開ける（サポーターは先頭の ORDER に戻されない）', async (role) => {
    mockUserRole = role;
    mockSearchParams = new URLSearchParams('tab=INVENTORY');
    render(<AdminPage />);

    expect(await screen.findByRole('navigation', { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'INVENTORY' })).toHaveAttribute('aria-current', 'page');
  });

  it('FREQ-525-AC-01: INVENTORY の外（ORDER）では在庫・発注メニューを出さない', async () => {
    mockUserRole = 'supporter';
    render(<AdminPage />);
    await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(screen.queryByRole('navigation', { name: MENU })).not.toBeInTheDocument();
  });
});

/**
 * 管理画面の左のメニューの PACKING（G-3 / FREQ-531。荷作り表への入口）。
 * 中身は役割で出し分けず、店長とサポーターの両方に同じ物を出す。権限の無い人が開いた先は荷作り表の頁の権限の文（窓口と DB が守る）。
 */
describe('管理画面の左のメニューの PACKING', () => {
  const MENU = '荷作りメニュー';

  it.each(['admin', 'supporter'] as const)('FREQ-531-AC-01: %s のメニューに PACKING があり、押すと荷作り表へのリンクが並ぶ', async (role) => {
    mockUserRole = role;
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'PACKING' }));

    const menu = await screen.findByRole('navigation', { name: MENU });
    const links = within(menu).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['荷作り表']);
    expect(within(menu).getByRole('link', { name: '荷作り表' })).toHaveAttribute('href', '/admin/packing');
    expect(screen.getByRole('button', { name: 'PACKING' })).toHaveAttribute('aria-current', 'page');
    // 荷作り表そのものはリンク先の頁が読む。この画面は荷作り表の窓口を読まない
    expect(clientFetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/admin/packing'), expect.anything());
  });

  it('FREQ-531-AC-01: PACKING の印は細線の箱で、店長のメニューでは INVENTORY の次（SETTINGS の前）に並ぶ', async () => {
    render(<AdminPage />);
    const nav = await screen.findByRole('navigation', { name: '管理メニュー' });
    expect(within(nav).getByRole('button', { name: 'PACKING' }).querySelector('i')).toHaveClass('ri-box-3-line');
    expect(menuLabels(nav).slice(8, 13)).toEqual(['INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT', 'SETTINGS']);
  });

  it.each(['admin', 'supporter'] as const)('FREQ-531-AC-01: %s は URL の tab=PACKING で直接開ける（サポーターは先頭の ORDER に戻されない）', async (role) => {
    mockUserRole = role;
    mockSearchParams = new URLSearchParams('tab=PACKING');
    render(<AdminPage />);

    expect(await screen.findByRole('navigation', { name: MENU })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PACKING' })).toHaveAttribute('aria-current', 'page');
  });

  it('FREQ-531-AC-01: PACKING の外（ORDER）では荷作りメニューを出さない', async () => {
    mockUserRole = 'supporter';
    render(<AdminPage />);
    await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(screen.queryByRole('navigation', { name: MENU })).not.toBeInTheDocument();
  });
});

/**
 * 管理画面の左のメニューの CONTACT（FR-ADMIN-009-AC-01）。店長とサポーターの両方に出し、押すと問い合わせの一覧（ContactSection）を開く。
 * 権限の無い人には窓口が 403 を返す（権限は窓口が守る。タブの出し分けは案内）。
 */
describe('管理画面の左のメニューの CONTACT', () => {
  it.each(['admin', 'supporter'] as const)('FR-ADMIN-009-AC-01: %s のメニューに CONTACT があり、押すと問い合わせの区画が開く', async (role) => {
    mockUserRole = role;
    render(<AdminPage />);
    expect(screen.queryByTestId('contact-section')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'CONTACT' }));

    expect(await screen.findByTestId('contact-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CONTACT' })).toHaveAttribute('aria-current', 'page');
  });

  it.each(['admin', 'supporter'] as const)('FR-ADMIN-009-AC-01: %s は URL の tab=CONTACT で直接開ける（サポーターは先頭の ORDER に戻されない）', async (role) => {
    mockUserRole = role;
    mockSearchParams = new URLSearchParams('tab=CONTACT');
    render(<AdminPage />);

    expect(await screen.findByTestId('contact-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CONTACT' })).toHaveAttribute('aria-current', 'page');
  });

  it('FR-ADMIN-009-AC-01: CONTACT の外（ORDER）では問い合わせの区画を出さない', async () => {
    mockUserRole = 'supporter';
    render(<AdminPage />);
    await screen.findByRole('navigation', { name: '管理メニュー' });

    expect(screen.queryByTestId('contact-section')).not.toBeInTheDocument();
  });
});
