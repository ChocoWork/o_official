/**
 * FR-LOGIN-074 パスキーの知らせの点検の DB の関数（死んだ知らせの一覧・印付け）は、
 * anon・authenticated の鍵では PostgREST から呼べず、service_role の鍵だけが呼べる
 * 対応: FR-AUTH-049-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数名>）を、anon・本物のログイン済みのお客さん（authenticated）・service_role の鍵で直接叩く。
 * anon・authenticated は 401/403・コード 42501 で断られる。service_role は呼べて、何も変えない呼び方（0件の印付け・一覧）だけを使う。
 * 画面は開かない（HTTP の試験で、3つの幅でくり返す）。
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

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['list_unnotified_dead_passkey_notifications', { _limit: 1 }],
  ['mark_passkey_notification_dead_notified', { _ids: [] }],
];

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-049-AC-01 anon・authenticated の鍵では点検の2つの関数を呼べず、service_role だけが呼べる (${viewport.name})`, async () => {
      requireLocalEnv();
      const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
      const email = `fr-login-074-${randomUUID()}@example.com`;
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
        const list = await service.rpc('list_unnotified_dead_passkey_notifications', { _limit: 0 });
        expect(list.error).toBeNull();
        expect(list.data).toEqual([]);
        const mark = await service.rpc('mark_passkey_notification_dead_notified', { _ids: [] });
        expect(mark.error).toBeNull();
        expect(mark.data).toBe(0);
      } finally {
        await service.auth.admin.deleteUser(userId);
      }
    });
  });
}
