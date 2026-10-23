import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VerifiedPage from '@/app/auth/verified/page';

/**
 * FREQ-515: ログインの確認（2要素認証）で認証要素が2つ以上あるとき、
 * 選択欄（native）で選んだ要素が検証に使われる。
 */

const mockReplace = jest.fn();
const mockRefreshAuthState = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ refreshAuthState: mockRefreshAuthState }),
}));

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === '/api/auth/me') {
      return jsonResponse({ authenticated: true, user: { role: 'admin', mfaVerified: false } });
    }
    if (url === '/api/auth/mfa/status') {
      return jsonResponse({
        data: {
          hasVerifiedFactor: true,
          factors: [
            { id: 'factor-1', factorType: 'totp', friendlyName: 'iPhone' },
            { id: 'factor-2', factorType: 'totp', friendlyName: 'iPad' },
          ],
        },
      });
    }
    if (url === '/api/auth/mfa/verify') {
      return jsonResponse({ data: { verified: true } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('2要素認証の認証要素の選択欄（FREQ-515）', () => {
  it('2つ目の認証要素を選ぶと、その要素で検証する', async () => {
    // FREQ-515-AC-02
    const user = userEvent.setup();
    render(<VerifiedPage />);

    const select = await screen.findByRole('combobox', { name: '認証要素' });
    expect(select.tagName).toBe('SELECT');
    await user.selectOptions(select, 'factor-2');
    expect(select).toHaveValue('factor-2');

    await user.type(screen.getByRole('textbox', { name: '認証コード（6〜8桁）' }), '123456');
    await user.click(screen.getByRole('button', { name: '2要素認証を完了' }));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/mfa/verify', expect.anything()),
    );
    const verifyCall = mockFetch.mock.calls.find(([url]) => url === '/api/auth/mfa/verify');
    expect(JSON.parse(String(verifyCall?.[1]?.body))).toEqual({ factorId: 'factor-2', code: '123456' });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
  });
});
