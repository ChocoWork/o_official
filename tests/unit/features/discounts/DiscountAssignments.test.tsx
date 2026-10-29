import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DiscountAssignments from '@/features/discounts/components/DiscountAssignments';
import type { AdminDiscountDetail, DiscountAssignmentRow } from '@/lib/discounts/admin-discount-types';
import { CODE_ID, DISCOUNT_ID, ORDER_ID, assignmentRow, definition, failResponse, okResponse, unreadableResponse, wasDrained, expectNoActWarnings } from './discount-test-utils';

const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

const COLUMNS = ['コード', '割り当てた人', '状態', '使った日', '注文'];

function tenRows(): DiscountAssignmentRow[] {
  return Array.from({ length: 10 }, (_, i) => assignmentRow({
    rowId: `aaaaaaaa-0000-4000-8000-00000000000${i}`, userId: `44444444-4444-4444-8444-44444444444${i}`, assigneeName: `会員${i + 1}`,
  }));
}

function build(rows: DiscountAssignmentRow[], overrides: Partial<AdminDiscountDetail> = {}): AdminDiscountDetail {
  return {
    codes: [], discount: definition({ audience: 'assigned' }), used: false, assignmentTotal: rows.length, assignments: rows,
    searchAttention: null, permissions: { read: true, manage: true }, ...overrides,
  };
}

function renderAssignments(detail: AdminDiscountDetail, extra: { page?: number; onPage?: jest.Mock; onChanged?: jest.Mock; disabled?: boolean } = {}) {
  const onPage = extra.onPage ?? jest.fn();
  const onChanged = extra.onChanged ?? jest.fn().mockResolvedValue(undefined);
  render(<DiscountAssignments detail={detail} page={extra.page ?? 1} onPage={onPage} onChanged={onChanged} disabled={extra.disabled} />);
  return { onPage, onChanged };
}

beforeEach(() => {
  mockFetch.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expectNoActWarnings();
  jest.restoreAllMocks();
});

describe('割り当ての表', () => {
  test('FREQ-547-AC-03: 10人の割り当ては10行で３つの状態と使用日と注文リンクが分かる', () => {
    const rows = tenRows();
    rows[1] = { ...rows[1], status: 'reserved', usedAt: '2026-10-20T01:30:00Z', orderId: ORDER_ID };
    rows[2] = { ...rows[2], status: 'confirmed', usedAt: '2026-10-21T10:05:00Z', orderId: ORDER_ID };
    renderAssignments(build(rows));

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').slice(0, 5).map((cell) => cell.textContent)).toEqual(COLUMNS);
    const body = screen.getAllByTestId('assignment-row');
    expect(body).toHaveLength(10);
    expect(within(body[0]).getByText('未使用')).toBeInTheDocument();
    expect(within(body[1]).getByText('使用済み（入金待ち）')).toBeInTheDocument();
    expect(within(body[1]).getByText('2026-10-20 10:30')).toBeInTheDocument();
    expect(within(body[2]).getByText('使用済み')).toBeInTheDocument();
    expect(within(body[2]).getByText('2026-10-21 19:05')).toBeInTheDocument();
    expect(within(body[2]).getByRole('link', { name: '注文を見る' })).toHaveAttribute('href', `/admin/orders/${ORDER_ID}`);
    expect(within(body[0]).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '割り当て（10件）' })).toBeInTheDocument();
  });

  test('FREQ-547-AC-03: 「外す」は未使用の行だけで、使用済みと入金待ちには出ない', () => {
    const rows = tenRows().slice(0, 3);
    rows[1] = { ...rows[1], status: 'reserved', usedAt: '2026-10-20T01:30:00Z', orderId: ORDER_ID };
    rows[2] = { ...rows[2], status: 'confirmed', usedAt: '2026-10-21T10:05:00Z', orderId: ORDER_ID };
    renderAssignments(build(rows));
    expect(screen.getAllByRole('button', { name: '外す' })).toHaveLength(1);
    expect(within(screen.getAllByTestId('assignment-row')[0]).getByRole('button', { name: '外す' })).toBeInTheDocument();
  });

  test('FREQ-547-AC-03: ゲストの行はサーバーが伏せたメールだけを出し、退会・名前なし・未割り当てを区別する', () => {
    const rows: DiscountAssignmentRow[] = [
      assignmentRow({ ...{ guestEmail: 'guest@example.com' }, rowId: 'usage:a:b', userId: null, assigneeName: null, guestEmailMasked: 'g***@example.com', status: 'confirmed', usedAt: '2026-10-21T10:05:00Z', orderId: ORDER_ID }),
      assignmentRow({ rowId: 'r2', userId: null, assigneeName: null, assigneeDeleted: true }),
      assignmentRow({ rowId: 'r3', assigneeName: null }),
      assignmentRow({ rowId: 'r4', userId: null, assigneeName: null, guestEmailMasked: null }),
    ];
    renderAssignments(build(rows));
    const body = screen.getAllByTestId('assignment-row');
    expect(within(body[0]).getByText('g***@example.com')).toBeInTheDocument();
    expect(within(body[1]).getByText('退会した会員')).toBeInTheDocument();
    expect(within(body[2]).getByText('名前のない会員')).toBeInTheDocument();
    expect(within(body[3]).getByText('未割り当て')).toBeInTheDocument();
    // 会員の id を持たない行は外せない
    expect(within(body[3]).queryByRole('button', { name: '外す' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/guest@example\.com/);
  });

  test('FREQ-547-AC-03: 20行ずつの頁送りと、空の文', () => {
    const { onPage } = renderAssignments(build(tenRows(), { assignmentTotal: 45 }), { page: 2 });
    expect(screen.getByText('2 / 3ページ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    expect(onPage).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: '前の頁' }));
    expect(onPage).toHaveBeenCalledWith(1);
  });

  test('FREQ-547-AC-03: 割り当てが無ければ空の文を出し、表は出さない', () => {
    renderAssignments(build([]));
    expect(screen.getByText('割り当てはありません。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-543-AC-03: manage権限が無ければ「外す」の列ごと出さず、最新の情報を読めない間は止める', () => {
    const readOnly = build(tenRows().slice(0, 2), { permissions: { read: true, manage: false } });
    const { unmount } = render(<DiscountAssignments detail={readOnly} page={1} onPage={jest.fn()} onChanged={jest.fn()} />);
    expect(screen.queryByRole('button', { name: '外す' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(5);
    unmount();
    renderAssignments(build(tenRows().slice(0, 2)), { disabled: true });
    expect(screen.queryByRole('button', { name: '外す' })).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-05: 外すは要求番号つきで送り、連打しても1回で、成功したら読み直す', async () => {
    const rows = tenRows().slice(0, 1);
    let release: (value: unknown) => void = () => {};
    mockFetch.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { onChanged } = renderAssignments(build(rows));
    const button = screen.getByRole('button', { name: '外す' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/admin/discounts/${DISCOUNT_ID}/unassign`);
    const body = JSON.parse(init.body);
    expect(body).toEqual({ codeId: CODE_ID, userId: rows[0].userId, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(init.method).toBe('POST');
    release(okResponse({ data: { discountId: DISCOUNT_ID, changedCount: 1, replayed: false } }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  test('FREQ-547-AC-05: 失敗した外すを再試行すると同じ要求番号を使い、成功後の次の操作は新しい番号', async () => {
    const rows = tenRows().slice(0, 1);
    mockFetch.mockResolvedValueOnce(failResponse(500)).mockResolvedValue(okResponse({ data: {} }));
    renderAssignments(build(rows));
    fireEvent.click(screen.getByRole('button', { name: '外す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('割り当てを外せませんでした。');
    fireEvent.click(screen.getByRole('button', { name: '外す' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).requestKey).toBe(JSON.parse(mockFetch.mock.calls[0][1].body).requestKey);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '外す' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(mockFetch.mock.calls[2][1].body).requestKey).not.toBe(JSON.parse(mockFetch.mock.calls[0][1].body).requestKey);
  });

  test.each([
    [409, { code: 'GROUP_H_ASSIGNMENT_USED', error: '使用済みの割り当ては外せません。' }, '使用済みの割り当ては外せません。'],
    [403, { error: 'x' }, '割引を操作する権限がありません。'],
    [429, { error: 'x' }, 'しばらくしてから、もう一度お試しください。'],
    [503, { error: 'x' }, '現在この操作を行えません。しばらくしてからお試しください。'],
    [401, { error: 'x' }, '認証が必要です。再ログインしてください。'],
  ])('FREQ-547-AC-05: 外す操作の%i は本文を読み切って、決まった文を出し、使用済みの409だけ読み直す', async (status, body, text) => {
    const response = failResponse(status as number, body);
    mockFetch.mockResolvedValue(response);
    const { onChanged } = renderAssignments(build(tenRows().slice(0, 1)));
    fireEvent.click(screen.getByRole('button', { name: '外す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text as string);
    expect(wasDrained(response)).toBe(true);
    if (status === 409) expect(onChanged).toHaveBeenCalledWith(false); else expect(onChanged).not.toHaveBeenCalled();
  });

  test('FREQ-547-AC-05: 本文を読めない失敗はcancelで閉じる', async () => {
    const response = unreadableResponse(429);
    mockFetch.mockResolvedValue(response);
    renderAssignments(build(tenRows().slice(0, 1)));
    fireEvent.click(screen.getByRole('button', { name: '外す' }));
    await screen.findByRole('alert');
    expect(response.body.cancel).toHaveBeenCalled();
  });
});
