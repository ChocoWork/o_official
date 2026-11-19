import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { LoginProvider, useLogin } from '@/contexts/LoginContext';
import { SESSION_EXPIRED_EVENT, SESSION_IDLE_EVENT } from '@/lib/client-fetch';

jest.mock('@/lib/supabase/client', () => ({ supabase: { auth: { signOut: jest.fn() } } }));
jest.mock('@/lib/browser-location', () => ({ navigateBrowser: jest.fn() }));

// DD-AUTH-081: 無操作で落とした理由 idle は、後から来る session-expired（同じ落ち方の2通目）で消さない。
const probe: { seen: ReturnType<typeof useLogin> | null } = { seen: null };
function Probe() {
  const login = useLogin();
  React.useEffect(() => {
    probe.seen = login;
  });
  return null;
}

const fetchMock = jest.fn();

beforeEach(() => {
  probe.seen = null;
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ authenticated: true, user: { role: 'admin', mfaVerified: true } }) });
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

async function renderResolved() {
  render(
    <LoginProvider>
      <Probe />
    </LoginProvider>,
  );
  await waitFor(() => expect(probe.seen?.isAuthResolved).toBe(true));
  expect(probe.seen?.isLoggedIn).toBe(true);
}

describe('DD-AUTH-081 LoginContext の無操作の理由', () => {
  test('DD-AUTH-081 無操作の通知で落ちて理由 idle が付き、その後の session-expired でも idle は残る', async () => {
    await renderResolved();

    act(() => {
      window.dispatchEvent(new Event(SESSION_IDLE_EVENT));
    });
    expect(probe.seen?.isLoggedIn).toBe(false);
    expect(probe.seen?.authReason).toBe('idle');

    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });
    expect(probe.seen?.isLoggedIn).toBe(false);
    expect(probe.seen?.authReason).toBe('idle');
  });

  test('DD-AUTH-081 無操作の通知が先に無い session-expired だけなら、理由は付かない', async () => {
    await renderResolved();

    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });
    expect(probe.seen?.isLoggedIn).toBe(false);
    expect(probe.seen?.authReason).toBeNull();
  });
});
