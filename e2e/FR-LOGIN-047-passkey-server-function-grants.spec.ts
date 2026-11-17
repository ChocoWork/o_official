/**
 * FR-LOGIN-047 パスキーの窓口が使う DB の関数（passkey_is_staff・passkey_credential_is_approved・passkey_approved_ids・passkey_approve）は、
 * anon・authenticated の鍵では PostgREST から呼べず、service_role の鍵だけが呼べる
 * 対応: FR-AUTH-015-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数名>）を、anon・本物のログイン済みのお客さん（authenticated）・service_role の鍵で直接叩く。
 * 関数は public にあり、権限（execute）で守っている。anon・authenticated は 401/403・コード 42501 で断られ、service_role は 200 で戻りが返る。
 * 画面は開かない（HTTP の試験なので幅で結果は変わらないが、3つの幅（390・768・1280）でくり返す）。
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
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['passkey_is_staff', { p_user_id: ZERO_UUID }],
  ['passkey_credential_is_approved', { p_user_id: ZERO_UUID, p_credential_id: '\\x0102' }],
  ['passkey_approved_ids', { p_user_id: ZERO_UUID }],
  ['passkey_approve', { p_user_id: ZERO_UUID, p_passkey_id: ZERO_UUID, p_via: 'script' }],
];

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-015-AC-01 anon・authenticated の鍵ではパスキーの窓口の関数を呼べず、service_role の鍵だけが呼べる (${viewport.name})`, async () => {
      requireLocalEnv();
      const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
      const email = `fr-login-047-${randomUUID()}@example.com`;
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

        const staff = await service.rpc('passkey_is_staff', { p_user_id: userId });
        expect(staff.error).toBeNull();
        expect(staff.data).toBe(false);
        const approved = await service.rpc('passkey_credential_is_approved', { p_user_id: userId, p_credential_id: '\\x0102' });
        expect(approved.error).toBeNull();
        expect(approved.data).toBe(false);
        const ids = await service.rpc('passkey_approved_ids', { p_user_id: userId });
        expect(ids.error).toBeNull();
        expect(ids.data).toEqual([]);
        // 実在しない鍵は、service_role が呼べるので権限の誤りでなく「持ち主でない」（42501 だが文が passkey_not_owned）で止まる
        const approve = await service.rpc('passkey_approve', { p_user_id: userId, p_passkey_id: ZERO_UUID, p_via: 'script' });
        expect(approve.error?.message).toBe('passkey_not_owned');
      } finally {
        await service.auth.admin.deleteUser(userId);
      }
    });
  });
}
