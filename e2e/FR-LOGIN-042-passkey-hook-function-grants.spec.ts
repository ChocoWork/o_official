/**
 * FR-LOGIN-042 フックの関数 passkey_access_token_hook は、anon・service_role の鍵では PostgREST から呼べない
 * 対応: FR-AUTH-008-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/passkey_access_token_hook）を、anon の鍵と service_role の鍵で直接叩く。
 * 画面は開かない（HTTP の試験なので幅で結果は変わらないが、3つの幅（390・768・1280）でくり返す）。
 * 呼べるのは GoTrue が使う supabase_auth_admin だけ。
 */
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

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`FR-AUTH-008-AC-01 anon と service_role の鍵ではフックの関数を直接呼べない (${viewport.name})`, async () => {
      requireLocalEnv();
      const event = { user_id: '00000000-0000-0000-0000-000000000000', authentication_method: 'password', claims: {} };
      for (const key of [ANON_KEY, SERVICE_KEY]) {
        const client = createClient(SUPABASE_URL, key, clientOptions);
        const { data, error } = await client.rpc('passkey_access_token_hook', { event });
        expect(data).toBeNull();
        expect(error?.code).toBe('42501');
      }
    });
  });
}
