import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { isLocalUrl } from '../scripts/e2e/environment';

// FREQ-416: 署名の合わない Stripe の知らせは400で断って数えるだけにし、10分に5件で店へ1通だけ知らせる（R-05）。
// 手元の Supabase の DB と手元のメール受け（Mailpit）だけを使う。1時間に1回の上限があるので、
// 画面幅ごとに知らせの状態を消してから送る。同じ1行を使うので、このファイルのテストは順に流す。
test.describe.configure({ mode: 'serial' });

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const LOCAL_DB_URL = process.env.E2E_LOCAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ALERT_SUBJECT = '【要確認】署名の合わない Stripe の知らせが届いています';

// 他のファイル（FR-CHECKOUT-009 など）の署名の無い要求も同じ件数を増やすが、5件に満たず、
// 権利も1時間は返らないので、1時間のうちに2通目の知らせにはならない。
/** 手元の DB の「署名不正」の数と送った時刻を消す（表は関数からしか触れないので、DB の管理者で消す） */
async function resetSignatureAlert(): Promise<void> {
  if (!isLocalUrl(LOCAL_DB_URL)) throw new Error('手元の DB 以外では知らせの状態を消さない');
  const client = new Client({ connectionString: LOCAL_DB_URL });
  await client.connect();
  try {
    await client.query("delete from public.ops_alert_state where alert_key = 'webhook_signature_invalid'");
  } finally {
    await client.end();
  }
}

type MailpitMessage = { Subject: string; To: Array<{ Address: string }> };

/** 手元のメール受けに届いた、店への署名不正の知らせの数 */
async function countAlertMails(request: APIRequestContext): Promise<number> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  const shopAlertEmail = process.env.SHOP_ALERT_EMAIL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  if (!shopAlertEmail) throw new Error('SHOP_ALERT_EMAIL が無い');
  const response = await request.get(new URL('/api/v1/messages?limit=500', mailUrl).toString());
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages.filter((message) =>
    message.Subject === ALERT_SUBJECT
    && message.To.some((to) => to.Address === shopAlertEmail)).length;
}

for (const viewport of viewports) {
  test.describe(`FR-CHECKOUT-035 webhook signature alert (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('署名の合わない要求を5回送ると、どれも400が返り、店への知らせが1通だけ届く', async ({ request }) => {
      // FREQ-416-AC-01, FREQ-416-AC-02
      await resetSignatureAlert();
      const before = await countAlertMails(request);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await request.post('/api/webhook/stripe', {
          headers: { 'stripe-signature': 't=1,v1=00', 'content-type': 'application/json' },
          data: { id: `evt_e2e_bad_signature_${viewport.name}_${attempt}`, type: 'checkout.session.completed' },
        });
        expect(response.status()).toBe(400);
      }

      // 数えて送るのは応答の後（after()）なので、届くまで待つ
      await expect.poll(() => countAlertMails(request), { timeout: 15_000 }).toBe(before + 1);
      // 余分に届かないこと（少し待ってから数え直す）
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await countAlertMails(request)).toBe(before + 1);
    });
  });
}
