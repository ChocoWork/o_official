/**
 * @jest-environment jsdom
 */
/**
 * SCR-AUTH-014 /staff/register: 画面の部品・段2の鍵の登録（registerPasskey）・終わりの呼びを本物で動かし、
 * 境界（router・窓口への fetch・ブラウザの鍵の作成）だけを差し替える。2本そろうと完了の窓口が1回だけ呼ばれる。
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import StaffRegisterScreen from '@/features/auth/staff/components/StaffRegisterScreen';

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
const mockFetchApi = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetchApi(...args) }));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  requestAttestation: jest.fn().mockResolvedValue({ ok: true, credential: { id: 'cred', rawId: 'cred' } }),
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let created = 0;

function route(completeStatus: number, completeBody: unknown) {
  mockFetchApi.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/register/start')) return json(200, { challenge_id: 'c', options: {}, mode: 'window' });
    if (url.endsWith('/register/finish')) {
      created += 1;
      return json(200, { passkey: { id: `pk${created}`, friendly_name: null, created_at: '2026-11-18T00:00:00Z' }, approvedCount: created });
    }
    if (init?.method === 'PATCH') return json(200, { passkey: { id: `pk${created}`, friendly_name: 'この端末' } });
    if (url === '/api/auth/staff/register/complete') return json(completeStatus, completeBody);
    throw new Error(`unexpected ${url}`);
  });
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  replace.mockReset();
  mockFetchApi.mockReset();
  created = 0;
});

describe('SCR-AUTH-014 2本の登録の画面', () => {
  test('SCR-AUTH-014 1本目 → 2本目で完了の窓口を1回だけ呼び、完了の文と「ログインへ」を出す', async () => {
    route(200, { redirectTo: '/login' });
    render(<StaffRegisterScreen initialRegistered={0} />);

    await click('1本目を登録');
    expect(await screen.findByText('別の端末か、セキュリティキーでの登録をおすすめします。')).toBeInTheDocument();
    expect(mockFetchApi.mock.calls.filter(([url]) => url === '/api/auth/staff/register/complete')).toHaveLength(0);

    await click('2本目を登録');
    expect(await screen.findByText('登録が終わりました。パスキーでログインしてください。')).toBeInTheDocument();
    expect(mockFetchApi.mock.calls.filter(([url]) => url === '/api/auth/staff/register/complete')).toHaveLength(1);
    await click('ログインへ');
    expect(replace).toHaveBeenCalledWith('/login');
  });

  test('SCR-AUTH-014 完了の窓口が 403 window_closed なら、時間が過ぎた文だけを出してボタンを消す', async () => {
    route(403, { error: 'window_closed' });
    render(<StaffRegisterScreen initialRegistered={1} />);

    await click('2本目を登録');
    expect(await screen.findByText('時間が過ぎました。店長に、もう一度招待を出してもらってください。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登録を完了する' })).toBeNull();
    expect(screen.queryByRole('button', { name: '2本目を登録' })).toBeNull();
  });
});
