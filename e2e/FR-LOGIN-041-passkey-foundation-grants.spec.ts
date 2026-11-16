/**
 * FR-LOGIN-041 パスキーの土台の DB の関数は、anon・ログイン済みの会員からは呼べず、service_role だけが呼べる
 * 対応: FR-AUTH-007-AC-01 / FR-AUTH-007-AC-02
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数>）を、anon の鍵と service_role の鍵で直接叩く。画面は開かない
 * （HTTP の試験なので幅で結果は変わらない。幅のくり返しはせず AC ごとに1本だけ流す）。表は private スキーマにあり、
 * PostgREST に出ていないので、service_role でも表を直には読めない。
 */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';

test.use({ trace: 'off' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

function requireLocalEnv(): void {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !isLocalUrl(SUPABASE_URL)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
}

test('FR-AUTH-007-AC-01 anon の鍵では passkey の関数を直接呼べない', async () => {
  requireLocalEnv();
  const anon = createClient(SUPABASE_URL, ANON_KEY, clientOptions);
  const id = randomUUID();
  const calls = await Promise.all([
    anon.rpc('passkey_approved_count', { p_user_id: id }),
    anon.rpc('passkey_approve', { p_user_id: id, p_passkey_id: id, p_via: 'script' }),
    anon.rpc('passkey_window_open', { p_user_id: id, p_session_id: id }),
    anon.rpc('passkey_window_close', { p_session_id: id }),
    anon.rpc('passkey_window_is_open', { p_user_id: id, p_session_id: id }),
  ]);
  for (const { data, error } of calls) {
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  }
});

test('FR-AUTH-007-AC-02 service_role は認めたパスキーの数を数えられ、private の表は PostgREST に出ていない', async () => {
  requireLocalEnv();
  const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
  const count = await service.rpc('passkey_approved_count', { p_user_id: randomUUID() });
  expect(count.error).toBeNull();
  expect(count.data).toBe(0);
  const table = await service.from('approved_passkeys').select('passkey_id').limit(1);
  expect(table.error).not.toBeNull();
});
