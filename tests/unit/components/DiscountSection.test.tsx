import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';
import DiscountSection from '@/components/DiscountSection';
import { failResponse, listBody, listRow, okResponse, expectNoActWarnings } from '../features/discounts/discount-test-utils';

const mockFetch = jest.fn();
const mockPush = jest.fn();
const mockReload = jest.fn();
let mockRole: 'admin' | 'supporter' = 'admin';
let mockParams = new URLSearchParams();

jest.mock('next/navigation', () => ({ useSearchParams: () => mockParams, useRouter: () => ({ push: mockPush }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true, userRole: mockRole, isMfaVerified: true }),
}));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('@/hooks/useOrderAttention', () => ({ useOrderAttention: () => ({ attention: null, reload: mockReload }) }));
for (const name of ['KpiSection', 'AccountingSection', 'NewsSection', 'ItemSection', 'LookSection', 'StockistSection', 'ContactSection', 'UserSection', 'ShopSettingsSection']) {
  jest.mock(`@/components/${name}`, () => ({ __esModule: true, default: () => null }));
}

const COLUMNS = ['割引名', '種類', '効き方', '状態', '期間', '使った回数', '上限'];
const navLabels = (): string[] => within(screen.getByRole('navigation', { name: '管理メニュー' })).getAllByRole('button').map((button) => button.textContent ?? '');

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockRole = 'admin';
  mockParams = new URLSearchParams();
  mockFetch.mockImplementation(() => Promise.resolve(okResponse(listBody([listRow()], 1, true))));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expectNoActWarnings();
  jest.restoreAllMocks();
});

describe('DISCOUNT タブ', () => {
  test('FREQ-547-AC-01: CONTACTの後にDISCOUNTがあり一覧の７列と３つの絞り込みを表示する', async () => {
    render(<AdminPage />);
    const labels = navLabels();
    expect(labels.indexOf('DISCOUNT')).toBe(labels.indexOf('CONTACT') + 1);
    expect(labels).toEqual(['KPI', 'ACCOUNTING', 'NEWS', 'ITEM', 'LOOK', 'STOCKIST', 'USER', 'ORDER', 'INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT', 'SETTINGS']);

    fireEvent.click(screen.getByRole('button', { name: 'DISCOUNT' }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(COLUMNS);
    for (const name of ['状態', '種類', '効き方']) expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DISCOUNT' })).toHaveAttribute('aria-current', 'page');
  });

  test('FREQ-547-AC-01: サポートの人のタブもCONTACTの後にDISCOUNTがあり、権限がなければ権限の文を出す', async () => {
    mockRole = 'supporter';
    mockParams = new URLSearchParams('tab=DISCOUNT');
    mockFetch.mockImplementation(() => Promise.resolve(failResponse(403)));
    render(<AdminPage />);
    expect(navLabels()).toEqual(['ORDER', 'INVENTORY', 'PACKING', 'CONTACT', 'DISCOUNT']);
    expect(await screen.findByText('割引を見る権限がありません。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '割引を作る' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-543-AC-03: サポートの人にreadが付与されると、読み直した一覧が出て、manageがなければ作る操作は出ない', async () => {
    mockRole = 'supporter';
    mockFetch.mockImplementation(() => Promise.resolve(failResponse(403)));
    const first = render(<DiscountSection />);
    expect(await screen.findByText('割引を見る権限がありません。')).toBeInTheDocument();
    first.unmount();
    mockFetch.mockImplementation(() => Promise.resolve(okResponse(listBody([listRow()], 1, false))));
    render(<DiscountSection />);
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '割引を作る' })).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 割引名は詳細の頁へ、「割引を作る」は作成の頁へ移る', async () => {
    render(<DiscountSection />);
    fireEvent.click(await screen.findByRole('button', { name: '秋の10％引き' }));
    expect(mockPush).toHaveBeenCalledWith('/admin/discounts/11111111-1111-4111-8111-111111111111');
    fireEvent.click(screen.getByRole('button', { name: '割引を作る' }));
    await waitFor(() => expect(mockPush).toHaveBeenLastCalledWith('/admin/discounts/new'));
  });
});
