import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DiscountDetail from '@/features/discounts/components/DiscountDetail';
import type { DiscountMember } from '@/lib/discounts/admin-discount-types';
import {
  CODE_ID, DISCOUNT_ID, assignmentRow, definition, detailBody, failResponse, okResponse, unreadableResponse, wasDrained, expectNoActWarnings,
} from './discount-test-utils';

const mockFetch = jest.fn();
const mockPush = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

const DETAIL_URL = `/api/admin/discounts/${DISCOUNT_ID}`;
const NEW_ID = '99999999-9999-4999-8999-999999999999';
const HANAKO: DiscountMember = { userId: '44444444-4444-4444-8444-444444444444', name: '山田 花子', email: 'hanako@example.com' };

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const calls = (): Call[] => mockFetch.mock.calls.map(([url, init]) => ({
  url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null,
}));
const writes = (): Call[] => calls().filter((call) => call.method !== 'GET' && !call.url.includes('/members'));

/** 詳細の読みは reads の順に返す。書込みは writeAnswer。会員の検索は members */
let reads: Array<() => unknown>;
let writeAnswer: (call: Call) => unknown;
let members: unknown;
beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  reads = [() => okResponse(detailBody())];
  writeAnswer = () => okResponse({ data: { discountId: DISCOUNT_ID, version: '4', replayed: false } });
  members = okResponse({ data: [HANAKO] });
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null };
    if (call.url.includes('/members')) return Promise.resolve(members);
    if (call.method === 'GET') {
      const next = reads.length > 1 ? reads.shift() : reads[0];
      return Promise.resolve((next as () => unknown)());
    }
    return Promise.resolve(writeAnswer(call));
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expectNoActWarnings();
  jest.restoreAllMocks();
});

const open = async (id = DISCOUNT_ID) => {
  render(<DiscountDetail discountId={id} />);
  await screen.findByRole('heading', { level: 1 });
};
const readOnlyBody = () => detailBody({ permissions: { read: true, manage: false } });

describe('割引の詳細', () => {
  test('FREQ-547-AC-01: 設定の要約と状態を日本語で出し、権限があれば止める・複製・編集の操作を出す', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '秋の10％引き' })).toBeInTheDocument();
    const summary = screen.getByText('種類').closest('dl') as HTMLElement;
    expect(within(summary).getByText('注文の％引き')).toBeInTheDocument();
    expect(within(summary).getByText('10％引き')).toBeInTheDocument();
    expect(within(summary).getByText('2026-10-01 09:00 〜 無期限')).toBeInTheDocument();
    expect(within(summary).getByText('重ねない')).toBeInTheDocument();
    for (const name of ['止める', '複製']) expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(screen.getByRole('link', { name: '編集' })).toHaveAttribute('href', `/admin/discounts/${DISCOUNT_ID}/edit`);
    expect(screen.getByRole('link', { name: '一覧に戻る' })).toHaveAttribute('href', '/admin?tab=DISCOUNT');
    expect(screen.queryByRole('button', { name: '割り当てを足す' })).not.toBeInTheDocument();
  });

  test('FREQ-543-AC-03: manageなしは操作を出さず、付与後の読み直しで操作できる', async () => {
    const assignments = Array.from({ length: 2 }, (_, i) => assignmentRow({ rowId: `r${i}`, userId: `44444444-4444-4444-8444-44444444444${i}` }));
    reads = [
      () => okResponse(detailBody({ permissions: { read: true, manage: false }, assignments, assignmentTotal: 45, discount: definition({ audience: 'assigned' }) })),
      () => okResponse(detailBody({ permissions: { read: true, manage: true }, assignments, assignmentTotal: 45, discount: definition({ audience: 'assigned' }) })),
    ];
    await open();
    for (const name of ['止める', '複製', '割り当てを足す', '外す']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '編集' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    expect(await screen.findByRole('button', { name: '止める' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '割り当てを足す' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '外す' })).toHaveLength(2);
    expect(calls().at(-1)?.url).toBe(`${DETAIL_URL}?page=2`);
  });

  test('FREQ-543-AC-03: 付与前の応答の画面を開き直すと、付与後は操作が出る', async () => {
    reads = [() => okResponse(readOnlyBody())];
    const first = render(<DiscountDetail discountId={DISCOUNT_ID} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: '止める' })).not.toBeInTheDocument();
    first.unmount();
    reads = [() => okResponse(detailBody())];
    await open();
    expect(screen.getByRole('button', { name: '止める' })).toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 止めると期待する版つきで送り、読み直して再開に変わる。連打は1回', async () => {
    reads = [() => okResponse(detailBody()), () => okResponse(detailBody({ discount: definition({ stopped: true, version: '4' }) }))];
    await open();
    const stop = screen.getByRole('button', { name: '止める' });
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(await screen.findByRole('button', { name: '再開する' })).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ url: `${DETAIL_URL}/stop`, method: 'POST', body: { expectedVersion: '3', requestKey: expect.any(String) } });
    expect(screen.getByRole('status')).toHaveTextContent('止めました。');
    expect(screen.getAllByText('止めた').length).toBeGreaterThan(0);
  });

  test('FREQ-547-AC-01: 失敗した停止の再試行は同じ要求番号で、再開は版が変わった別の操作', async () => {
    writeAnswer = jest.fn()
      .mockReturnValueOnce(failResponse(500))
      .mockReturnValue(okResponse({ data: { discountId: DISCOUNT_ID, version: '4', replayed: false } })) as unknown as typeof writeAnswer;
    reads = [() => okResponse(detailBody()), () => okResponse(detailBody({ discount: definition({ stopped: true, version: '4' }) }))];
    await open();
    fireEvent.click(screen.getByRole('button', { name: '止める' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('操作に失敗しました。');
    fireEvent.click(screen.getByRole('button', { name: '止める' }));
    await screen.findByRole('button', { name: '再開する' });
    expect(writes()).toHaveLength(2);
    expect(writes()[1].body?.requestKey).toBe(writes()[0].body?.requestKey);
    fireEvent.click(screen.getByRole('button', { name: '再開する' }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[2].url).toBe(`${DETAIL_URL}/resume`);
    expect(writes()[2].body?.requestKey).not.toBe(writes()[0].body?.requestKey);
  });

  test('FREQ-547-AC-02: 複製は新しい割引の詳細へ進む', async () => {
    writeAnswer = () => okResponse({ data: { discountId: NEW_ID, version: '1', replayed: false } }, 201);
    await open();
    fireEvent.click(screen.getByRole('button', { name: '複製' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/admin/discounts/${NEW_ID}`));
    expect(writes()[0]).toMatchObject({ url: `${DETAIL_URL}/duplicate`, body: { requestKey: expect.any(String) } });
  });

  test('FREQ-547-AC-02: 使用済みの割引には、複製して新しく作る説明を出す', async () => {
    reads = [() => okResponse(detailBody({ used: true }))];
    await open();
    expect(screen.getByText('使用後に値や対象を変える場合は、複製して新しく作ってください。')).toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 変更は成功したが読み直せないとき、文を出して古い状態の操作を止める', async () => {
    reads = [() => okResponse(detailBody({ discount: definition({ audience: 'assigned' }), assignments: [assignmentRow()] })), () => failResponse(500)];
    await open();
    fireEvent.click(screen.getByRole('button', { name: '止める' }));
    expect(await screen.findByText('変更しましたが、最新の情報を読み込めませんでした。')).toBeInTheDocument();
    for (const name of ['止める', '再開する', '複製', '割り当てを足す', '外す']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '編集' })).not.toBeInTheDocument();
    reads = [() => okResponse(detailBody({ discount: definition({ stopped: true, version: '4' }) }))];
    fireEvent.click(screen.getByRole('button', { name: '読み直す' }));
    expect(await screen.findByRole('button', { name: '再開する' })).toBeInTheDocument();
    expect(screen.queryByText('変更しましたが、最新の情報を読み込めませんでした。')).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-01: 計算の要対応はread権限にも文を出し、「確認済みにする」はmanageだけ', async () => {
    const attention = { openedAt: '2026-10-20T00:00:00Z', count: 2 };
    reads = [() => okResponse(detailBody({ searchAttention: attention, permissions: { read: true, manage: false } }))];
    const view = render(<DiscountDetail discountId={DISCOUNT_ID} />);
    expect(await screen.findByText('割引の計算を確認してください。（2件）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認済みにする' })).not.toBeInTheDocument();
    view.unmount();

    reads = [() => okResponse(detailBody({ searchAttention: attention })), () => okResponse(detailBody())];
    render(<DiscountDetail discountId={DISCOUNT_ID} />);
    fireEvent.click(await screen.findByRole('button', { name: '確認済みにする' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '確認済みにする' })).not.toBeInTheDocument());
    expect(writes()[0]).toMatchObject({ method: 'PATCH', url: DETAIL_URL, body: { patch: { acknowledgeSearchAttention: true }, expectedVersion: '3' } });
  });

  test('FREQ-547-AC-01: 見つからない・権限なし・取得失敗の文と、取得失敗の読み直す', async () => {
    reads = [() => failResponse(404)];
    const a = render(<DiscountDetail discountId={DISCOUNT_ID} />);
    expect(await screen.findByText('割引が見つかりません。')).toBeInTheDocument();
    a.unmount();

    const forbidden = unreadableResponse(403);
    reads = [() => forbidden];
    const b = render(<DiscountDetail discountId={DISCOUNT_ID} />);
    expect(await screen.findByText('割引を見る権限がありません。')).toBeInTheDocument();
    expect(forbidden.body.cancel).toHaveBeenCalled();
    b.unmount();

    const broken = failResponse(503);
    reads = [() => broken, () => okResponse(detailBody())];
    render(<DiscountDetail discountId={DISCOUNT_ID} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(wasDrained(broken)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '読み直す' }));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  test('FREQ-547-AC-03: 自動の割引には割り当ての表を出さない', async () => {
    reads = [() => okResponse(detailBody({ discount: definition({ method: 'automatic', audience: 'anyone', allowGuests: true }) }))];
    await open();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('自動の割引にはコードの割り当てはありません。')).toBeInTheDocument();
  });
});

test.each([429, 500, 503])('FREQ-547-AC-03: 頁送りの%iは元の頁と行を保ち、誤りを出して同じ頁を読み直せる', async (status) => {
  const first = detailBody({ assignmentTotal: 45, assignments: [assignmentRow({ code: 'FIRST' })] });
  const second = detailBody({ assignmentTotal: 45, assignments: [assignmentRow({ code: 'SECOND' })] });
  let finish: (response: Response) => void = () => {};
  reads = [() => okResponse(first), () => new Promise<Response>((resolve) => { finish = resolve; }), () => okResponse(second)];
  await open();
  fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
  expect(screen.getByRole('region', { name: '割り当ての表' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByText('1 / 3ページ')).toBeInTheDocument();
  await act(async () => { finish(failResponse(status)); });
  expect(await screen.findByText('割り当てを読み込めませんでした。')).toBeInTheDocument();
  expect(screen.getByText('1 / 3ページ')).toBeInTheDocument();
  expect(screen.getByText('FIRST')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }));
  expect(await screen.findByText('SECOND')).toBeInTheDocument();
  expect(screen.getByText('2 / 3ページ')).toBeInTheDocument();
  expect(screen.queryByText('FIRST')).not.toBeInTheDocument();
});

test('FREQ-547-AC-01: 409の後の読取失敗は変更成功の文を出さない', async () => {
  reads = [() => okResponse(detailBody()), () => failResponse(503)];
  writeAnswer = () => failResponse(409, { code: 'GROUP_H_VERSION_CONFLICT', error: '設定が変わりました。読み直してください。' });
  await open();
  fireEvent.click(screen.getByRole('button', { name: '止める' }));
  expect(await screen.findByText('最新の情報を読み込めませんでした。')).toBeInTheDocument();
  expect(screen.queryByText('変更しましたが、最新の情報を読み込めませんでした。')).not.toBeInTheDocument();
});

describe('割り当てを足す窓', () => {
  const assignedBody = (rows = [] as ReturnType<typeof assignmentRow>[]) => detailBody({ discount: definition({ audience: 'assigned' }), assignments: rows });
  const choose = async () => {
    fireEvent.change(screen.getByRole('textbox', { name: '会員を探す' }), { target: { value: 'ha' } });
    fireEvent.click(await screen.findByRole('button', { name: '山田 花子（hanako@example.com）を追加' }, { timeout: 2000 }));
  };

  test('FREQ-547-AC-05: 使い捨ての束では先頭の文字と会員を選び、選んだ人数のコードを作る', async () => {
    reads = [() => okResponse({ data: { ...assignedBody().data, codes: [{ codeId: CODE_ID, code: 'BATCH-ABCD', singleUse: true, audience: 'assigned', allowGuests: false, assignedUserId: HANAKO.userId }] } }), () => okResponse(assignedBody([assignmentRow({ rowId: CODE_ID, code: 'FRIEND-ABCD' })]))];
    await open();
    fireEvent.click(screen.getByRole('button', { name: '割り当てを足す' }));
    const dialog = screen.getByRole('dialog', { name: '割り当てを足す' });
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toHaveTextContent('×');
    fireEvent.click(within(dialog).getByRole('button', { name: '割り当てる' }));
    expect(await within(dialog).findByText('会員を選んでください。')).toBeInTheDocument();
    await choose();
    fireEvent.click(within(dialog).getByRole('button', { name: '割り当てる' }));
    expect(await within(dialog).findByText('コードの先頭の文字は、英数字とハイフンの1〜55字で入力してください。')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'コードの先頭の文字' }), { target: { value: 'friend' } });
    expect(within(dialog).getByText(/「FRIEND-」に4〜8文字が続く形/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ url: `${DETAIL_URL}/codes`, body: { prefix: 'FRIEND', userIds: [HANAKO.userId], count: 1, requestKey: expect.any(String) } });
    expect(screen.getByRole('status')).toHaveTextContent('1人に割り当てました。');
  });

  test('FREQ-547-AC-05: 共有コードの割り当てが0件でも、そのcodeIdで最初の会員を足す', async () => {
    reads = [() => okResponse(assignedBody())];
    await open();
    fireEvent.click(screen.getByRole('button', { name: '割り当てを足す' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('textbox', { name: 'コードの先頭の文字' })).not.toBeInTheDocument();
    await choose();
    fireEvent.click(within(dialog).getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ url: `${DETAIL_URL}/assign`, body: { codeId: CODE_ID, userIds: [HANAKO.userId] } });
  });

  test('FREQ-547-AC-05: 共有コードの割り当てがある割引は、そのコードに会員を足す', async () => {
    reads = [() => okResponse(assignedBody([assignmentRow()])), () => okResponse(assignedBody([assignmentRow()]))];
    await open();
    fireEvent.click(screen.getByRole('button', { name: '割り当てを足す' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('textbox', { name: 'コードの先頭の文字' })).not.toBeInTheDocument();
    await choose();
    fireEvent.click(within(dialog).getByRole('button', { name: '割り当てる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes()[0]).toMatchObject({ url: `${DETAIL_URL}/assign`, body: { codeId: CODE_ID, userIds: [HANAKO.userId] } });
  });

  test('FREQ-547-AC-05: 窓のTabを閉じ込め、閉じると入口、変更後の再読取失敗では見出しへ戻す', async () => {
    reads = [() => okResponse(assignedBody()), () => failResponse(503)];
    await open();
    const opener = screen.getByRole('button', { name: '割り当てを足す' });
    opener.focus(); fireEvent.click(opener);
    let dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: '閉じる' });
    const last = within(dialog).getByRole('button', { name: 'やめる' });
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.click(close); expect(opener).toHaveFocus();
    fireEvent.click(opener); dialog = screen.getByRole('dialog');
    await choose(); fireEvent.click(within(dialog).getByRole('button', { name: '割り当てる' }));
    await screen.findByText('変更しましたが、最新の情報を読み込めませんでした。');
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  test('FREQ-547-AC-05: 失敗の文を窓の中に出し、二重送信は1回で、×とEscで閉じる', async () => {
    writeAnswer = () => failResponse(409, { code: 'GROUP_H_CODE_CONFLICT', error: 'このコードは既に使われています。' });
    reads = [() => okResponse(assignedBody([assignmentRow()]))];
    await open();
    fireEvent.click(screen.getByRole('button', { name: '割り当てを足す' }));
    const dialog = screen.getByRole('dialog');
    await choose();
    const submit = within(dialog).getByRole('button', { name: '割り当てる' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(await within(dialog).findByText('このコードは既に使われています。')).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '割り当てを足す' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => undefined);
  });
});
