/**
 * FR-LOGIN-061 パスキーの知らせを取り出して送るための DB の関数（claim・complete・fail・skip・recipients）は、
 * anon・authenticated の鍵では PostgREST から呼べず、service_role の鍵だけが呼べる
 * 対応: FR-AUTH-030-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数名>）を、anon・本物のログイン済みのお客さん（authenticated）・service_role の鍵で直接叩く。
 * 関数は public にあり、権限（execute）で守っている。anon・authenticated は 401/403・コード 42501 で断られ、service_role は 200 で戻りが返る。
 * service_role で呼ぶ claim は、手元の表に残る行を担当にしてしまうので、行が無い時の戻り（空）は確かめず、範囲外の秒数の 22023 だけで「呼べた」ことを示す。
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
  ['claim_passkey_notification', { _lease_seconds: 60 }],
  ['complete_passkey_notification', { _id: ZERO_UUID, _lease_token: ZERO_UUID }],
  ['fail_passkey_notification', { _id: ZERO_UUID, _lease_token: ZERO_UUID, _error_code: 'smtp_error', _retry_after_seconds: 0 }],
  ['skip_passkey_notification', { _id: ZERO_UUID, _lease_token: ZERO_UUID, _reason: 'no_recipient' }],
  ['passkey_notification_recipients', { _id: ZERO_UUID }],
];

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-030-AC-01 anon・authenticated の鍵では知らせの関数を呼べず、service_role の鍵だけが呼べる (${viewport.name})`, async () => {
      requireLocalEnv();
      const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
      const email = `fr-login-061-${randomUUID()}@example.com`;
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

        // service_role は呼べる。実在しない行・合わない印は false、宛先は空、範囲外の秒数は 22023（権限でなく入力の誤り）
        const complete = await service.rpc('complete_passkey_notification', { _id: ZERO_UUID, _lease_token: ZERO_UUID });
        expect(complete.error).toBeNull();
        expect(complete.data).toBe(false);
        const fail = await service.rpc('fail_passkey_notification', {
          _id: ZERO_UUID, _lease_token: ZERO_UUID, _error_code: 'smtp_error', _retry_after_seconds: 0,
        });
        expect(fail.error).toBeNull();
        expect(fail.data).toBe(false);
        const skip = await service.rpc('skip_passkey_notification', { _id: ZERO_UUID, _lease_token: ZERO_UUID, _reason: 'no_recipient' });
        expect(skip.error).toBeNull();
        expect(skip.data).toBe(false);
        const recipients = await service.rpc('passkey_notification_recipients', { _id: ZERO_UUID });
        expect(recipients.error).toBeNull();
        expect(recipients.data).toEqual([]);
        const claim = await service.rpc('claim_passkey_notification', { _lease_seconds: 1 });
        expect(claim.error?.code).toBe('22023');
      } finally {
        await service.auth.admin.deleteUser(userId);
      }
    });
  });
}
