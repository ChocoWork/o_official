/**
 * @jest-environment jsdom
 */
/**
 * SCR-AUTH-015 /admin/passkeys: 画面の部品・一覧の部品（loadStaffPasskeys）・段2の鍵の部品（registerPasskey・deletePasskey）を本物で動かし、
 * 境界（router・窓口への fetch・ブラウザの鍵の作成）だけを差し替える。削除の下限は、窓口の答え（409）を画面が受けて数え直すところまで確かめる。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StaffPasskeyManager from '@/features/auth/staff/components/StaffPasskeyManager';
import StaffOneMoreKey from '@/features/auth/staff/components/StaffOneMoreKey';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => ({ refreshAuthState: jest.fn().mockResolvedValue(undefined) }) }));
const mockFetchApi = jest.fn();
const mockRefreshOnce = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockFetchApi(...args),
  refreshSessionOnce: () => mockRefreshOnce(),
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  isPasskeySupported: () => true,
  requestAttestation: jest.fn().mockResolvedValue({ ok: true, credential: { id: 'cred', rawId: 'cred' } }),
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const A = { id: 'a', friendly_name: 'Mac', created_at: '2026-11-17T20:00:00Z', last_used_at: null, approved: true };
const B = { id: 'b', friendly_name: 'iPhone', created_at: '2026-11-17T20:00:00Z', last_used_at: null, approved: true };
const C = { id: 'c', friendly_name: 'Key', created_at: '2026-11-17T20:00:00Z', last_used_at: null, approved: true };

let listed: Array<typeof A>;
let deleteResponse: Response;

function route() {
  mockFetchApi.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/auth/passkey') {
      return json(200, { isStaff: true, approvedCount: listed.filter((item) => item.approved).length, passkeys: listed });
    }
    if (init?.method === 'DELETE') return deleteResponse;
    if (url.endsWith('/register/start')) return json(200, { challenge_id: 'c', options: {} });
    if (url.endsWith('/register/finish')) return json(200, { passkey: { id: 'n', friendly_name: null, created_at: '2026-11-18T00:00:00Z' } });
    if (init?.method === 'PATCH') return json(200, { passkey: { id: 'n', friendly_name: 'この端末' } });
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  replace.mockReset();
  mockFetchApi.mockReset();
  mockRefreshOnce.mockReset().mockResolvedValue('refreshed');
  listed = [A, B, C];
  deleteResponse = json(200, { ok: true });
  route();
});

describe('SCR-AUTH-015 店員のパスキー管理', () => {
  test('SCR-AUTH-015 認めた鍵が3本なら1本消せて、数え直した2本では削除が止まる', async () => {
    render(<StaffPasskeyManager />);
    await screen.findByText('Mac');
    fireEvent.click(screen.getByRole('button', { name: 'Macを削除' }));
    listed = [B, C];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    });
    expect(await screen.findByText('パスキーを削除しました。')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Mac')).not.toBeInTheDocument());
    for (const button of screen.getAllByRole('button', { name: /を削除$/ })) expect(button).toBeDisabled();
    expect(mockFetchApi.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });

  test('SCR-AUTH-015 窓口が 409 staff_min_keys で断ったら、失敗の文を出し、鍵は残る', async () => {
    deleteResponse = json(409, { error: 'staff_min_keys' });
    render(<StaffPasskeyManager />);
    await screen.findByText('Mac');
    fireEvent.click(screen.getByRole('button', { name: 'Macを削除' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    });
    expect(await screen.findByText('削除できませんでした。認めた鍵は2本以上が必要です。')).toBeInTheDocument();
    expect(within(screen.getAllByRole('list')[0]).getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('SCR-AUTH-015 「もう1本」の画面', () => {
  test('SCR-AUTH-015 2本目を登録すると、ログインの印を更新して /admin へ移る', async () => {
    render(<StaffOneMoreKey />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'));
    expect(mockRefreshOnce).toHaveBeenCalledTimes(1);
  });

  test('SCR-AUTH-015 登録の窓口が reauth_required を返すと、入り直しのリンクを出し、移らない', async () => {
    mockFetchApi.mockImplementation(async (url: string) => {
      if (url.endsWith('/register/start')) return json(403, { error: 'registration_not_allowed', reason: 'reauth_required' });
      throw new Error(`unexpected ${url}`);
    });
    render(<StaffOneMoreKey />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    });
    expect(await screen.findByText('安全のため、もう一度パスキーでログインしてから追加してください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスキーでログインし直す' })).toHaveAttribute('href', '/login?next=%2Fadmin%2Fpasskeys');
    expect(replace).not.toHaveBeenCalled();
  });
});
