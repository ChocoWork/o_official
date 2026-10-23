import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserSection from '@/components/UserSection';

/**
 * FREQ-515: 管理画面のユーザー一覧で役割の選択欄（dropdown）で選んだ値が、変更の送信に使われる。
 * 送信に失敗したら、選択欄は元の役割へ戻る。
 */

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const USERS = [
  {
    id: 'user-1',
    name: '山田 花子',
    email: 'hanako@example.com',
    role: 'User',
    roleValue: 'user',
    lastLogin: '2026-10-01',
    status: 'アクティブ',
  },
];

function mockUsersThenPatch(patchResponse: { ok: boolean; status: number }, body: unknown = {}) {
  mockClientFetch.mockImplementation(async (_url, init) => {
    if (init?.method === 'PATCH') {
      return { ...patchResponse, json: async () => body } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ data: USERS }) } as Response;
  });
}

async function chooseRole(label: string) {
  const user = userEvent.setup();
  const combobox = await screen.findByRole('combobox');
  await user.click(combobox);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: label }));
  return combobox;
}

describe('UserSection の役割の選択欄（FREQ-515）', () => {
  // jsdom は canvas の getContext を実装せず「Not implemented」を console.error に出す（SingleSelect が文字の幅を測るために呼ぶ）。
  // jsdom の答えも null なので、動きは変えずに null を返す差し替えにして雑音だけを消す
  let getContextSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  it('役割を選ぶと、選んだ役割で PATCH を送る', async () => {
    // FREQ-515-AC-01
    mockUsersThenPatch({ ok: true, status: 200 });
    render(<UserSection />);

    const combobox = await chooseRole('Support');

    await waitFor(() =>
      expect(mockClientFetch).toHaveBeenCalledWith(
        '/api/admin/users',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ userId: 'user-1', role: 'supporter' });
    await waitFor(() => expect(combobox).not.toBeDisabled());
    expect(combobox).toHaveTextContent('Support');
  });

  it('送信に失敗したら、元の役割に戻して誤りを出す', async () => {
    // FREQ-515-AC-01
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsersThenPatch({ ok: false, status: 500 });
    render(<UserSection />);

    const combobox = await chooseRole('Admin');

    expect(await screen.findByText('権限の更新に失敗しました。')).toBeInTheDocument();
    expect(combobox).toHaveTextContent('User');
    const patchCall = mockClientFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ userId: 'user-1', role: 'admin' });
    expect(consoleError).toHaveBeenCalledWith('Failed to update role:', expect.any(Error));
    consoleError.mockRestore();
  });

  it.each<[string, number, string]>([
    ['LAST_ADMIN_REQUIRED', 409, '店長を1人以上残してください。'],
    ['SELF_ROLE_CHANGE_FORBIDDEN', 403, '自分自身の役割は変更できません。'],
    ['UNKNOWN_CODE', 403, '権限変更は管理者のみ実行できます。'],
  ])('拒否code=%sなら指定文を出し、元の役割と操作可能な状態へ戻す', async (code, status, message) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockUsersThenPatch({ ok: false, status }, { code, error: 'ignored server text' });
      render(<UserSection />);

      const combobox = await chooseRole('Admin');

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByText('ignored server text')).not.toBeInTheDocument();
      expect(combobox).toHaveTextContent('User');
      await waitFor(() => expect(combobox).not.toBeDisabled());
      const patchCalls = mockClientFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
      expect(patchCalls).toHaveLength(1);
      expect(JSON.parse(String(patchCalls[0][1]?.body))).toEqual({ userId: 'user-1', role: 'admin' });
    } finally {
      consoleError.mockRestore();
    }
  });
});
