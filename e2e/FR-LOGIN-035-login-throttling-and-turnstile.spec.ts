/**
 * FR-LOGIN-035 トークン更新の送り元の数え方（パスワードのログインの回数の制限・Turnstile・監査の試験は、窓口を消した段4で消した）
 * 対応: SEC-AUTH-013-AC-01
 *
 * 道具立て
 * - Playwright の request（HTTP）で /api/auth/refresh を直に叩く。画面は見ない。
 *   HTTP の試験なので結果は画面の幅で変わらない。1つの幅（desktop）だけ流す（DB の書き込みと回数の制限の枠を3倍にしない）。
 * - 回数の制限の枠は「送り元（x-real-ip。E2E のアプリは固定の環境 CLIENT_IP_HEADER で信頼し、x-forwarded-for は読まない）× 10分（時計の10分きざみ）」で数える。
 *   試験ごと・要求ごとに新しい送り元を使い、ほかの試験・ほかの spec と枠を共有しない。
 *   10分の枠が切り替わる間際に始めると途中で数えが0に戻るので、切れ目の手前に近いときだけ、次の枠に入るのを条件で待つ。
 * - SEC-AUTH-013-AC-01 は、1 試験で固定の x-real-ip を付け、偽れる x-forwarded-for だけを毎回変えて 31 回送り、31 回目が 429 になることを見る
 *   （2026-10-28、波 4 で getClientIp が x-forwarded-for を読まなくなり満たす）。x-real-ip まで毎回変えると枠を逃れるので変えない。
 */
import { randomInt } from 'node:crypto';
import { expect, test, type APIResponse } from '@playwright/test';

// ログインの Cookie が通信記録に残らないよう、記録は取らない。
test.use({ trace: 'off' });

// 窓口を HTTP で叩く試験で、画面の幅で結果が変わらない。幅ごとに流すと DB の書き込みと回数の制限の枠が3倍になるので、1つの幅（desktop）だけ流す。
const viewports = [{ name: 'desktop', width: 1280, height: 800 }] as const;

const REFRESH_PATH = '/api/auth/refresh';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/** 枠の切れ目までこれより短いと、数回の送信の途中で枠が切り替わりうるので、切り替わるのを待つ */
const MIN_ROOM_IN_WINDOW_MS = 20_000;

/** 試験ごと・要求ごとに違う送り元（ベンチマーク用の 198.18.0.0/15 から乱数で選ぶ） */
const usedForwardedFor = new Set<string>();
function uniqueForwardedFor(): string {
  for (;;) {
    const ip = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    if (!usedForwardedFor.has(ip)) {
      usedForwardedFor.add(ip);
      return ip;
    }
  }
}

/** 時計の10分の枠の切れ目が近いときだけ、次の枠に入るまで条件で待つ（固定の sleep はしない） */
async function ensureRoomInRateLimitWindow(): Promise<void> {
  const remaining = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
  if (remaining >= MIN_ROOM_IN_WINDOW_MS) {
    return;
  }
  const nextWindowStart = Date.now() + remaining;
  await expect
    .poll(() => Date.now() >= nextWindowStart, {
      message: '10分の枠が切り替わるのを待つ',
      timeout: MIN_ROOM_IN_WINDOW_MS + 15_000,
      intervals: [250],
    })
    .toBe(true);
}

/** state を変える /api/* の POST は Origin か Referer が無いと proxy が 403 で止める。request フィクスチャは付けないので自分で付ける */
function originOf(baseURL: string | undefined): string {
  return new URL(baseURL ?? 'http://localhost:3000').origin;
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-035 login throttling, Turnstile and audit (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-AUTH-013-AC-01 ${viewport.name}: x-forwarded-for を毎回変えても、固定の x-real-ip で /api/auth/refresh に31回送ると、31回目が 429 になる`, async ({ request, baseURL }) => {
      const origin = originOf(baseURL);
      // 信頼する見出し（x-real-ip。E2E のアプリは CLIENT_IP_HEADER で信頼する）は 1 試験で 1 つに固定し、偽れる x-forwarded-for だけを毎回変える。
      // x-real-ip まで毎回変えると枠を逃れて 429 にならず、付けないと全試験が共有する「送り元なし」の枠を使い切って他の試験を 10 分間 429 にする。
      const fixedRealIp = uniqueForwardedFor();
      // 31回の途中で10分の枠が切り替わると数えが0に戻るので、切れ目が近いときは次の枠に入るのを待つ
      await ensureRoomInRateLimitWindow();

      let last: APIResponse | null = null;
      for (let attempt = 1; attempt <= 31; attempt += 1) {
        last = await request.post(REFRESH_PATH, {
          headers: { 'x-real-ip': fixedRealIp, 'x-forwarded-for': uniqueForwardedFor(), origin },
          maxRedirects: 0,
        });
      }

      expect(last?.status(), '送り元を毎回変えた31回目の状態').toBe(429);
    });
  });
}
