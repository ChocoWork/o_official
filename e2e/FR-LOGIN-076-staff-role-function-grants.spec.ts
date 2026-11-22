/**
 * FR-LOGIN-076 降格・鍵の削除の下限・役割の変更の DB の関数は、anon・authenticated の鍵では PostgREST から呼べず、service_role の鍵だけが呼べる。
 * 最後の手段（private.staff_invite_issue_manual）は PostgREST の口に無い
 * 対応: FR-AUTH-037-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数名>）を、anon・本物のログイン済みのお客さん（authenticated）・service_role の鍵で直接叩く。
 * anon・authenticated は 401/403・コード 42501 で断られる。service_role は、知らない操作者・鍵が DB の文の例外になる
 * （何も変えない呼び方だけを使う）。画面は開かない（HTTP の試験で、3つの幅でくり返す）。
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { signInCustomerWithoutPassword } from './customer-session-test-utils';

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
  ['staff_demote', { p_actor_id: ZERO_UUID, p_user_id: ZERO_UUID }],
  ['passkey_delete_with_floor', { p_user_id: ZERO_UUID, p_passkey_id: ZERO_UUID }],
  ['admin_set_user_role', { _actor_id: ZERO_UUID, _user_id: ZERO_UUID, _role_code: 'user' }],
];

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-037-AC-01 anon・authenticated の鍵では降格・鍵の削除・役割の変更を呼べず、service_role では知らない操作者・鍵が決まった文になり、最後の手段は PostgREST に無い (${viewport.name})`, async () => {
      requireLocalEnv();
      const service = createClient(SUPABASE_URL, SERVICE_KEY, clientOptions);
      const email = `fr-login-076-${randomUUID()}@example.com`;
      const created = await service.auth.admin.createUser({ email, email_confirm: true });
      expect(created.error).toBeNull();
      const userId = created.data.user?.id as string;
      try {
        const anon = createClient(SUPABASE_URL, ANON_KEY, clientOptions);
        const token = (await signInCustomerWithoutPassword(email)).accessToken;
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
        const demote = await service.rpc('staff_demote', { p_actor_id: ZERO_UUID, p_user_id: ZERO_UUID });
        expect(demote.error?.message).toBe('ROLE_PERMISSION_FORBIDDEN');
        const remove = await service.rpc('passkey_delete_with_floor', { p_user_id: ZERO_UUID, p_passkey_id: ZERO_UUID });
        expect(remove.error?.message).toBe('PASSKEY_NOT_FOUND');
        const change = await service.rpc('admin_set_user_role', { _actor_id: ZERO_UUID, _user_id: ZERO_UUID, _role_code: 'admin' });
        expect(change.error?.message).toBe('ROLE_PERMISSION_FORBIDDEN');
        const manual = await service.rpc('staff_invite_issue_manual', { p_email: email });
        expect(manual.error?.code).toBe('PGRST202');
      } finally {
        await service.auth.admin.deleteUser(userId);
      }
    });
  });
}
