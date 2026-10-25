/**
 * FR-ADMIN-MISC-007 問い合わせの管理の返信: メールの届き方・スレッドへの結び付け・回数の制限・監査の記録
 * 対応する受け入れ条件: FREQ-25-AC-01、SEC-ADMIN-006-AC-01・AC-02、SEC-ADMIN-017-AC-01、SEC-ADMIN-018-AC-01、SEC-ADMIN-022-AC-02
 *
 * 画面を描かない窓口の確かめ（管理画面に CONTACT のタブは無い。TM-ADMIN-01）。通信は Playwright の request で送り、窓口の答えは
 * 画面幅で変わらないので、viewport の繰り返しは無い（1本ずつ。特に回数の制限の探りは最大 RATE_LIMIT_PROBE_CAP 件の返信・メール・監査の行を作るので、
 * 3倍にしない）。
 *
 * 管理者のログイン:
 * - 共有の道具（e2e/admin-session-test-utils.ts）で、手元の GoTrue が署名した本物の aal2 の JWT を作り、Authorization: Bearer で送る。
 *   窓口の認可（verifyAccessToken → 失効の確認 → ACL → aal2）は本物がそのまま通る。JWT は自分で署名しない。
 * - 店長の役割（有効な user_roles）は道具が足す。権限の画面の試験（permission-settings-test-utils の withPermissionScenario）が
 *   店長の付与を一時的に変えるので、同じ advisory lock（190520, 0）を、試験の間だけ共有で取って重ならないようにする（共有どうしは待たず、権限の画面の試験の排他とだけ重ならない）。
 * - 試験ごとに自分の管理者・自分の問い合わせ・自分のお客様のメールを作る（回数の制限の試験が他の試験を巻き込まない）。作った行は消さない
 *   （db reset で消える。作ったテンプレートだけ自分で消す）。
 *
  * メール: MAIL_PROVIDER=local で、アプリが手元の Mailpit（MAIL_LOCAL_URL）へ送ったものを API で読む。
 * 送り手（MAIL_FROM_ADDRESS）・返信の宛先の秘密と受信の領域（CONTACT_REPLY_SECRET・CONTACT_INBOUND_DOMAIN）・受信の Webhook の鍵
 * （RESEND_WEBHOOK_SECRET）は scripts/e2e/environment.ts の E2E_FIXED_ENV が固定する。
 *
 * 今のコードの状態（受け入れ条件の下の根拠より）:
 * - SEC-ADMIN-006（TM-ADMIN-47）・SEC-ADMIN-018（TM-ADMIN-59）・SEC-ADMIN-022-AC-02（TM-ADMIN-63）は満たさない。この spec では失敗する。
 * - SEC-ADMIN-017-AC-01 と FREQ-25-AC-01 は今のコードで通る。
 * - SEC-ADMIN-006 は回数がまだ決まっていない。決めた回数が分からないので、429 が初めて出るまで送り（上限は RATE_LIMIT_PROBE_CAP）、
 *   その時点までの 201 の数を「決めた回数」として数え合わせる。回数の制限が無い間は上限まで返信とメールが溜まる。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { buildReplyAddress } from '@/lib/contact/reply-address';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createAdminSessionActor } from './admin-session-test-utils';
import { uniqueEmail, withLocalDb } from './order-email-test-utils';

/** permission-settings-test-utils.ts の SCENARIO_LOCK（'190520, 0'）と同じ。権限の付与を変える試験と重ならないため */
const PERMISSION_SCENARIO_LOCK = '190520, 0';

/** 回数の制限の試験が 429 を待つ最大の送信数（決めた回数が分からないので、429 が出るまで送る） */
const RATE_LIMIT_PROBE_CAP = 200;

// ---------------------------------------------------------------------------------------------
// 管理者・問い合わせ（手元の Supabase）
// ---------------------------------------------------------------------------------------------

type AdminActor = { id: string; email: string; token: string };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が無い（E2E の見張りが渡す値。npm run test:e2e か npx playwright test で流す）`);
  return value;
}

/** 手元の GoTrue に店長の利用者を作り（共有の道具）、GoTrue が署名した本物の aal2 の access token を得る */
async function createAdminActor(db: PgClient): Promise<AdminActor> {
  const actor = await createAdminSessionActor(db, 'admin', 'aal2');
  return { id: actor.userId, email: actor.email, token: actor.accessToken };
}

/** 管理者を作り、権限の画面の試験と重ならないよう advisory lock（共有）を取って run を流す（接続を閉じると lock も外れる） */
async function withAdminActor<T>(run: (actor: AdminActor, db: PgClient) => Promise<T>): Promise<T> {
  return withLocalDb(async (db) => {
    await db.query(`select pg_catalog.pg_advisory_lock_shared(${PERMISSION_SCENARIO_LOCK})`);
    try {
      const actor = await createAdminActor(db);
      return await run(actor, db);
    } finally {
      await db.query(`select pg_catalog.pg_advisory_unlock_shared(${PERMISSION_SCENARIO_LOCK})`);
    }
  });
}

/** お客様の問い合わせを DB に1件入れる（公開の問い合わせの窓口は回数の制限があるので、DB に直に入れる） */
async function createInquiry(db: PgClient, input: { email: string; subject: string }): Promise<string> {
  const result = await db.query(
    `insert into public.contact_inquiries (name, email, inquiry_type, subject, message)
     values ('E2E お客様', $1, 'other', $2, 'E2E の問い合わせ本文') returning id`,
    [input.email, input.subject],
  );
  return result.rows[0].id as string;
}

async function adminMessageCount(db: PgClient, inquiryId: string): Promise<number> {
  const result = await db.query(
    `select count(*)::int as n from public.contact_messages where inquiry_id = $1::uuid and sender_role = 'admin'`,
    [inquiryId],
  );
  return result.rows[0].n as number;
}

type AuditRow = { action: string; actor_id: string | null; actor_email: string | null; ip: string | null };

async function auditRowsOf(db: PgClient, actorId: string, actions: readonly string[]): Promise<AuditRow[]> {
  const result = await db.query(
    `select action, actor_id, actor_email, ip from public.audit_logs where actor_id = $1::uuid and action = any($2::text[]) order by created_at`,
    [actorId, actions],
  );
  return result.rows as AuditRow[];
}

// ---------------------------------------------------------------------------------------------
// 窓口の呼び出し
// ---------------------------------------------------------------------------------------------

function originOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  return new URL(baseURL).origin;
}

function adminHeaders(actor: AdminActor, origin: string, forwardedFor: string): Record<string, string> {
  return { authorization: `Bearer ${actor.token}`, origin, 'x-forwarded-for': forwardedFor };
}

/** 試験ごとの送り元（x-forwarded-for の左端。192.0.2.0/24 は文書用の範囲） */
function testIp(): string {
  return `192.0.2.${1 + Math.floor(Math.random() * 250)}`;
}

function postReply(
  request: APIRequestContext,
  inquiryId: string,
  headers: Record<string, string>,
  body: string,
): Promise<APIResponse> {
  return request.post(`/api/admin/contact/${inquiryId}/reply`, { headers, data: { body } });
}

type InquiryDetail = {
  data: { id: string; messages: Array<{ sender_role: string; body: string; channel: string }> };
};

async function readInquiryDetail(request: APIRequestContext, inquiryId: string, headers: Record<string, string>): Promise<InquiryDetail['data']> {
  const response = await request.get(`/api/admin/contact/${inquiryId}`, { headers });
  expect(response.status()).toBe(200);
  return ((await response.json()) as InquiryDetail).data;
}

// ---------------------------------------------------------------------------------------------
// 手元のメール受け（Mailpit）
// ---------------------------------------------------------------------------------------------

type SentMail = { subject: string; to: string[]; bcc: string[]; replyTo: string[]; text: string; headerNames: string[] };

type MailpitAddress = { Address: string };
type MailpitMessage = {
  Subject: string;
  To: MailpitAddress[] | null;
  Bcc: MailpitAddress[] | null;
  ReplyTo: MailpitAddress[] | null;
  Text: string;
};

/** その宛先（To・Cc・Bcc）へ届いたメールを、中身と見出しの名前つきで読む（API: https://mailpit.axllent.org/docs/api-v1/） */
async function sentMailsTo(request: APIRequestContext, address: string): Promise<SentMail[]> {
  const mailUrl = process.env.MAIL_LOCAL_URL;
  if (!mailUrl || !isLocalUrl(mailUrl)) throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  const search = await request.get(new URL('/api/v1/search', mailUrl).toString(), {
    params: { query: `to:${address}`, limit: 500 },
    timeout: 5_000,
  });
  expect(search.ok()).toBe(true);
  const { messages } = (await search.json()) as { messages?: Array<{ ID: string }> };

  const mails: SentMail[] = [];
  for (const summary of messages ?? []) {
    const id = encodeURIComponent(summary.ID);
    const message = await request.get(new URL(`/api/v1/message/${id}`, mailUrl).toString(), { timeout: 5_000 });
    expect(message.ok()).toBe(true);
    const body = (await message.json()) as MailpitMessage;
    const headers = await request.get(new URL(`/api/v1/message/${id}/headers`, mailUrl).toString(), { timeout: 5_000 });
    expect(headers.ok()).toBe(true);
    const headerMap = (await headers.json()) as Record<string, string[]>;
    mails.push({
      subject: body.Subject,
      to: (body.To ?? []).map((entry) => entry.Address),
      bcc: (body.Bcc ?? []).map((entry) => entry.Address),
      replyTo: (body.ReplyTo ?? []).map((entry) => entry.Address),
      text: body.Text,
      headerNames: Object.keys(headerMap),
    });
  }
  return mails;
}

// ---------------------------------------------------------------------------------------------
// 受信の Webhook（Resend の返信の受け口。Svix の署名つき）
// ---------------------------------------------------------------------------------------------

/** Svix の署名: HMAC-SHA256(鍵, `${id}.${timestamp}.${本文}`) の base64 を `v1,` に続ける（鍵は whsec_ の後ろの base64） */
function svixSign(secret: string, svixId: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${svixId}.${timestamp}.${rawBody}`).digest('base64')}`;
}

/** お客様のメールの返信が届いた、という署名つきの知らせを /api/contact/inbound へ送る */
function postInbound(
  request: APIRequestContext,
  input: { to: string; fromEmail: string; text: string },
): Promise<APIResponse> {
  const rawBody = JSON.stringify({
    type: 'email.received',
    data: { email_id: `e2e-${randomUUID()}`, from: `E2E お客様 <${input.fromEmail}>`, to: [input.to], text: input.text },
  });
  const svixId = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return request.post('/api/contact/inbound', {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': timestamp,
      'svix-signature': svixSign(requiredEnv('RESEND_WEBHOOK_SECRET'), svixId, timestamp, rawBody),
    },
    data: rawBody,
  });
}

// ---------------------------------------------------------------------------------------------
// 回数の制限の探り（SEC-ADMIN-006）
// ---------------------------------------------------------------------------------------------

type RateLimitProbe = {
  /** 201 を返した返信の数（= 回数の制限が許した数） */
  accepted: number;
  /** そのうち mailSent が true だった数 */
  mailed: number;
  /** 最初に 429 を返した応答。上限まで送っても出なければ null */
  limited: APIResponse | null;
};

/** 429 が初めて出るまで（上限 RATE_LIMIT_PROBE_CAP）同じ管理者の JWT で返信を送り続ける。429 以外の失敗は、その場で試験を落とす */
async function replyUntilLimited(
  request: APIRequestContext,
  inquiryId: string,
  headersFor: (attempt: number) => Record<string, string>,
): Promise<RateLimitProbe> {
  let accepted = 0;
  let mailed = 0;
  for (let attempt = 1; attempt <= RATE_LIMIT_PROBE_CAP; attempt += 1) {
    const response = await postReply(request, inquiryId, headersFor(attempt), `回数の制限の確認 ${attempt}`);
    if (response.status() === 429) return { accepted, mailed, limited: response };
    expect(response.status(), `${attempt} 回目の返信が 201 でも 429 でもない`).toBe(201);
    accepted += 1;
    if (((await response.json()) as { mailSent?: boolean }).mailSent === true) mailed += 1;
  }
  return { accepted, mailed, limited: null };
}

/** 429 の応答に Retry-After（正の整数の秒）がある */
function expectRetryAfter(response: APIResponse): void {
  const retryAfter = response.headers()['retry-after'];
  expect(retryAfter, '429 の応答に Retry-After の見出しが無い').toBeDefined();
  expect(retryAfter).toMatch(/^\d+$/);
  expect(Number(retryAfter)).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------------------------
// 試験
// ---------------------------------------------------------------------------------------------

  test(`FREQ-25-AC-01 管理の返信でエラーが出ず、顧客へメールが届き、スレッドに反映される`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    await withAdminActor(async (actor, db) => {
      const customerEmail = uniqueEmail('contact-customer');
      const subject = `E2E 返信の確認 ${randomUUID().slice(0, 8)}`;
      const inquiryId = await createInquiry(db, { email: customerEmail, subject });
      const headers = adminHeaders(actor, origin, testIp());
      const replyBody = `お問い合わせありがとうございます。${randomUUID()}`;

      // 返信でエラーが発生しない
      const response = await postReply(request, inquiryId, headers, replyBody);
      expect(response.status()).toBe(201);
      expect(await response.json()).toEqual({ success: true, mailSent: true });

      // 顧客へメール送信される（件名は Re: 付き、本文は返信の本文、返信先はこのスレッドの印つきの宛先）
      await expect.poll(async () => (await sentMailsTo(request, customerEmail)).length, { timeout: 10_000 }).toBe(1);
      const [mail] = await sentMailsTo(request, customerEmail);
      expect(mail.to).toEqual([customerEmail]);
      expect(mail.subject).toBe(`Re: ${subject}`);
      expect(mail.text).toContain(replyBody);
      expect(mail.replyTo).toEqual([buildReplyAddress(inquiryId)]);

      // スレッドに反映される（詳細の窓口のやり取りに、管理者の返信が出る）
      const detail = await readInquiryDetail(request, inquiryId, headers);
      const adminMessages = detail.messages.filter((message) => message.sender_role === 'admin');
      expect(adminMessages).toHaveLength(1);
      expect(adminMessages[0].body).toBe(replyBody);
    });
  });

  test(`SEC-ADMIN-006-AC-01 決めた回数を超えた返信を 429 と Retry-After で断り、返信の行もメールも増えない`, async ({ request, baseURL }) => {
    test.fail(true, 'SEC-ADMIN-006-AC-01 今のコードは満たさない（docs/02_Requirements/areas/admin.md）');
    test.setTimeout(180_000);
    const origin = originOf(baseURL);
    await withAdminActor(async (actor, db) => {
      const customerEmail = uniqueEmail('contact-ratelimit');
      const inquiryId = await createInquiry(db, { email: customerEmail, subject: 'E2E 回数の制限' });
      const ip = testIp();

      const probe = await replyUntilLimited(request, inquiryId, () => adminHeaders(actor, origin, ip));

      // 決めた回数より1回多く送ると、最後の要求に 429 が返る（上限まで送っても出なければ、回数の制限が無い）
      expect(probe.limited, `${RATE_LIMIT_PROBE_CAP} 回送っても 429 が返らない（回数の制限が無い）`).not.toBeNull();
      const limited = probe.limited as APIResponse;
      expect(limited.status()).toBe(429);
      expectRetryAfter(limited);

      // 返信の行が増えない（429 の要求の分の行が無い。行の数は 201 を返した数と同じ）
      expect(await adminMessageCount(db, inquiryId)).toBe(probe.accepted);

      // メールも送られない（届いたメールは、mailSent が true だった返信の数だけ）
      expect((await sentMailsTo(request, customerEmail)).length).toBe(probe.mailed);
    });
  });

  test(`SEC-ADMIN-006-AC-02 x-forwarded-for の左端を毎回変えても数え直されず、決めた回数を超えた要求に 429 が返る`, async ({ request, baseURL }) => {
    test.fail(true, 'SEC-ADMIN-006-AC-02 今のコードは満たさない（docs/02_Requirements/areas/admin.md）');
    test.setTimeout(180_000);
    const origin = originOf(baseURL);
    await withAdminActor(async (actor, db) => {
      const customerEmail = uniqueEmail('contact-ratelimit-xff');
      const inquiryId = await createInquiry(db, { email: customerEmail, subject: 'E2E 回数の制限（送り元の偽装）' });
      // 毎回ちがう左端（198.51.100.0/24 と 203.0.113.0/24 は文書用の範囲）。2番目以降は固定で、左端だけが変わる
      const spoofedFor = (attempt: number): string => `198.51.100.${(attempt % 250) + 1}, 203.0.113.${Math.floor(attempt / 250) + 1}`;

      const probe = await replyUntilLimited(request, inquiryId, (attempt) => adminHeaders(actor, origin, spoofedFor(attempt)));

      expect(
        probe.limited,
        `送り元を毎回変えると ${RATE_LIMIT_PROBE_CAP} 回送っても 429 が返らない（送り元の見出しで数え直されている）`,
      ).not.toBeNull();
      const limited = probe.limited as APIResponse;
      expect(limited.status()).toBe(429);
      expectRetryAfter(limited);

      // まだ見ていない左端でもう1回送っても、決めた回数を超えているので 429 のまま
      const next = await postReply(
        request,
        inquiryId,
        adminHeaders(actor, origin, '192.0.2.250, 203.0.113.250'),
        '回数を超えた後の確認',
      );
      expect(next.status()).toBe(429);
      expect(await adminMessageCount(db, inquiryId)).toBe(probe.accepted);
    });
  });

  test(`SEC-ADMIN-017-AC-01 印の1字を変えた宛先で受信の Webhook に送った返信は、詳細のやり取りに出ない`, async ({ request, baseURL }) => {
    const origin = originOf(baseURL);
    await withAdminActor(async (actor, db) => {
      const customerEmail = uniqueEmail('contact-inbound');
      const inquiryId = await createInquiry(db, { email: customerEmail, subject: 'E2E 返信の宛先の印' });
      const headers = adminHeaders(actor, origin, testIp());

      const validAddress = buildReplyAddress(inquiryId);
      expect(validAddress, 'CONTACT_REPLY_SECRET・CONTACT_INBOUND_DOMAIN が E2E の固定の値で入っていない').not.toBeNull();
      const address = validAddress as string;

      // 印（`reply+{id}.` の後ろ、`@` の前）の先頭の1字だけを、ほかの字に変える
      const tokenStart = `reply+${inquiryId}.`.length;
      expect(address.startsWith(`reply+${inquiryId}.`)).toBe(true);
      const alteredAddress = `${address.slice(0, tokenStart)}${address[tokenStart] === 'A' ? 'B' : 'A'}${address.slice(tokenStart + 1)}`;
      expect(alteredAddress).not.toBe(address);

      // 印を変えた宛先への返信: 受け口は署名が正しいので受けるが、スレッドには結ばない
      const alteredText = `印を変えた返信 ${randomUUID()}`;
      const altered = await postInbound(request, { to: alteredAddress, fromEmail: customerEmail, text: alteredText });
      expect(altered.status()).toBe(200);
      expect(await altered.json()).toEqual({ ignored: true });
      const afterAltered = await readInquiryDetail(request, inquiryId, headers);
      expect(afterAltered.messages.map((message) => message.body)).not.toContain(alteredText);
      expect(afterAltered.messages).toHaveLength(0);

      // 対照: 印が正しい宛先の同じ返信は、スレッドに出る（印を変えたから出ない、という差を確かめる）
      const validText = `印が正しい返信 ${randomUUID()}`;
      const valid = await postInbound(request, { to: address, fromEmail: customerEmail, text: validText });
      expect(valid.status()).toBe(200);
      expect(await valid.json()).toEqual({ success: true });
      const afterValid = await readInquiryDetail(request, inquiryId, headers);
      expect(afterValid.messages.map((message) => ({ role: message.sender_role, channel: message.channel, body: message.body }))).toEqual([
        { role: 'user', channel: 'email', body: validText },
      ]);
      expect(afterValid.messages.map((message) => message.body)).not.toContain(alteredText);
    });
  });

  test(`SEC-ADMIN-018-AC-01 CR・LF と Bcc の行を含む件名の問い合わせに返信しても、送るメールの件名に CR・LF が無く、Bcc の宛先も無い`, async ({ request, baseURL }) => {
    test.fail(true, 'SEC-ADMIN-018-AC-01 今のコードは満たさない（docs/02_Requirements/areas/admin.md）');
    const origin = originOf(baseURL);
    await withAdminActor(async (actor, db) => {
      const customerEmail = uniqueEmail('contact-crlf');
      const attackerEmail = uniqueEmail('contact-bcc-attacker');
      const inquiryId = await createInquiry(db, {
        email: customerEmail,
        subject: `E2E 件名の確認\r\nBcc: ${attackerEmail}`,
      });
      const headers = adminHeaders(actor, origin, testIp());

      const response = await postReply(request, inquiryId, headers, '件名に改行のある問い合わせへの返信');
      expect(response.status()).toBe(201);
      expect(await response.json(), '改行入りの件名でもメールは送れる（改行を消して送る）').toEqual({ success: true, mailSent: true });

      await expect.poll(async () => (await sentMailsTo(request, customerEmail)).length, { timeout: 10_000 }).toBe(1);
      const [mail] = await sentMailsTo(request, customerEmail);

      // 送ったメールの件名に CR・LF が無い
      expect(mail.subject).not.toMatch(/[\r\n]/);
      // Bcc の宛先が無い（見出しの差し込みで足されていない）
      expect(mail.bcc).toEqual([]);
      expect(mail.headerNames.map((name) => name.toLowerCase())).not.toContain('bcc');
      expect(await sentMailsTo(request, attackerEmail)).toHaveLength(0);
    });
  });

  test(`SEC-ADMIN-022-AC-02 問い合わせの状態の変更・返信・テンプレートの作成の監査ログに、行為者のメールと IP が入る`, async ({ request, baseURL }) => {
    test.fail(true, 'SEC-ADMIN-022-AC-02 今のコードは満たさない（docs/02_Requirements/areas/admin.md）');
    const origin = originOf(baseURL);
    await withAdminActor(async (actor, db) => {
      const customerEmail = uniqueEmail('contact-audit');
      const inquiryId = await createInquiry(db, { email: customerEmail, subject: 'E2E 監査の記録' });
      const ip = testIp();
      const headers = adminHeaders(actor, origin, ip);
      let templateId: string | null = null;
      try {
        const status = await request.patch(`/api/admin/contact/${inquiryId}`, { headers, data: { status: 'pending' } });
        expect(status.status()).toBe(200);

        const reply = await postReply(request, inquiryId, headers, '監査の記録の確認');
        expect(reply.status()).toBe(201);

        const template = await request.post('/api/admin/contact/templates', {
          headers,
          data: { title: `E2E 監査 ${randomUUID().slice(0, 8)}`, body: '監査の記録の確認のテンプレート' },
        });
        expect(template.status()).toBe(201);
        templateId = ((await template.json()) as { id: string }).id;

        const actions = ['admin.contact.status_update', 'admin.contact.reply', 'admin.contact.template.create'];
        await expect.poll(async () => (await auditRowsOf(db, actor.id, actions)).length, { timeout: 10_000 }).toBe(3);
        const rows = await auditRowsOf(db, actor.id, actions);
        expect(rows.map((row) => row.action).sort()).toEqual([...actions].sort());
        for (const row of rows) {
          expect(row.actor_email, `${row.action} の actor_email が空`).toBe(actor.email);
          expect(row.ip, `${row.action} の ip が空`).toBeTruthy();
        }
      } finally {
        if (templateId) await db.query('delete from public.contact_reply_templates where id = $1::uuid', [templateId]);
      }
    });
  });
