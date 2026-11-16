/**
 * FR-LOGIN-045 管理の入口の3つの条件の関数（staff_passkey_amr_ok・staff_passkey_count_ok・staff_passkey_entry_ok）は、anon・service_role の鍵では PostgREST から呼べない（関数が公開されていない）
 * 対応: FR-AUTH-011-AC-01
 *
 * 手元の Supabase の PostgREST（/rest/v1/rpc/<関数名>）を、anon の鍵と service_role の鍵で直接叩く。
 * 関数は private にあり PostgREST に公開されていないので、どの鍵でも 404・PGRST202 になる。execute をだれにも渡していないことそのものは、DB 結合テスト（DATA-AUTH-016 の権限の試験）と移行の末尾の確かめで示す。画面は開かない（HTTP の試験なので幅で結果は変わらないが、
 * 3つの幅（390・768・1280）でくり返す）。
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

    test(`FR-AUTH-011-AC-01 anon と service_role の鍵では管理の入口の条件の関数を PostgREST から呼べない (${viewport.name})`, async () => {
      requireLocalEnv();
      for (const key of [ANON_KEY, SERVICE_KEY]) {
        const client = createClient(SUPABASE_URL, key, clientOptions);
        for (const name of ['staff_passkey_amr_ok', 'staff_passkey_count_ok', 'staff_passkey_entry_ok']) {
          const { data, error, status } = await client.rpc(name);
          expect(data).toBeNull();
          expect(status).toBe(404);
          expect(error?.code).toBe('PGRST202');
        }
      }
    });
  });
}
