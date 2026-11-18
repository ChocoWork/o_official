/**
 * FR-LOGIN-075 店員の招待の DB の関数（発行・消費・結び・有効化・取り消し・開いているかの確かめ）は、
 * anon・authenticated の鍵では PostgREST から呼べず、service_role の鍵だけが呼べる。service_role でも最後の手段の種類は通らない
 * 対応: FR-AUTH-034-AC-01、FR-AUTH-035-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数名>）を、anon・本物のログイン済みのお客さん（authenticated）・service_role の鍵で直接叩く。
 * anon・authenticated は 401/403・コード 42501 で断られる。service_role は呼べて、知らない合言葉・行・セッションは
 * 空・false・DB の文の例外になる（何も変えない呼び方だけを使う）。画面は開かない（HTTP の試験で、3つの幅でくり返す）。
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { DUMMY_CAPTCHA_TOKEN } from './captcha-test-utils';

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

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const HASH = '\\x' + '00'.repeat(32);
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['staff_invite_issue', {
    p_user_id: ZERO_UUID, p_role_code: 'admin', p_kind: 'invite', p_issued_by: ZERO_UUID, p_reason: 'x', p_token_hash: HASH,
  }],
  ['staff_invite_consume', { p_token_hash: HASH }],
  ['staff_invite_bind_window', { p_invite_id: ZERO_UUID, p_session_id: ZERO_UUID }],
  ['staff_role_activate', { p_user_id: ZERO_UUID, p_session_id: ZERO_UUID }],
  ['staff_invite_cancel', { p_actor_id: ZERO_UUID, p_user_id: ZERO_UUID }],
  ['staff_invite_open', { p_user_id: ZERO_UUID }],
];

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-034-AC-01 anon・authenticated の鍵では招待の6つの関数を呼べず、service_role でも最後の手段の発行は通らない (${viewport.name})`, async () => {
      requireLocalEnv();
      const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
      const email = `fr-login-075-${randomUUID()}@example.com`;
      const password = `Pw-${randomUUID()}-aA1!`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      const userId = created.data.user?.id as string;
      try {
        const anon = createClient(SUPABASE_URL, ANON_KEY, clientOptions);
        const signedIn = await anon.auth.signInWithPassword({ email, password, options: { captchaToken: DUMMY_CAPTCHA_TOKEN } });
        expect(signedIn.error).toBeNull();
        const token = signedIn.data.session?.access_token as string;
        const authenticated: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
          ...clientOptions,
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        for (const [name, args] of CALLS) {
          for (const client of [anon, authenticated]) {
            const { data, error, status } = await client.rpc(name, args);
            expect(data).toBeNull();
            expect([401, 403]).toContain(status);
            expect(error?.code).toBe('42501');
          }
        }
        const lastResort = await service.rpc('staff_invite_issue', {
          p_user_id: ZERO_UUID, p_role_code: 'admin', p_kind: 'last_resort', p_issued_by: null, p_reason: 'x', p_token_hash: HASH,
        });
        expect(lastResort.error?.message).toBe('STAFF_INVITE_KIND_FORBIDDEN');
        expect(lastResort.error?.code).toBe('42501');
      } finally {
        await service.auth.admin.deleteUser(userId);
      }
    });

    test(`FR-AUTH-035-AC-01 service_role の鍵では、知らない合言葉・招待・セッションは空・false・決まった文の例外になる (${viewport.name})`, async () => {
      requireLocalEnv();
      const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
      const consume = await service.rpc('staff_invite_consume', { p_token_hash: HASH });
      expect(consume.error).toBeNull();
      expect(consume.data).toEqual([]);
      const open = await service.rpc('staff_invite_open', { p_user_id: ZERO_UUID });
      expect(open.error).toBeNull();
      expect(open.data).toBe(false);
      const bind = await service.rpc('staff_invite_bind_window', { p_invite_id: ZERO_UUID, p_session_id: ZERO_UUID });
      expect(bind.error?.message).toBe('STAFF_INVITE_INVALID');
      const activate = await service.rpc('staff_role_activate', { p_user_id: ZERO_UUID, p_session_id: ZERO_UUID });
      expect(activate.error?.message).toBe('STAFF_ACTIVATE_INVITE_INVALID');
      const cancel = await service.rpc('staff_invite_cancel', { p_actor_id: ZERO_UUID, p_user_id: ZERO_UUID });
      expect(cancel.error?.message).toBe('ROLE_PERMISSION_FORBIDDEN');
    });
  });
}
