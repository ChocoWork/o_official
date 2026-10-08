/**
 * FR-CHECKOUT-046 ではアプリが発行するログイン・CSRF の Cookie が必要になる。
 * Turnstile を伴うパスワード検証の前段だけを既存の助けで作り、確認コードの検証は実際のルートを通す。
 * この助けを呼ぶ spec は `test.use({ trace: 'off' })` が必須。
 * 確認コード・ログインの Cookie・2FA の Cookie がブラウザの文脈の通信に載り、通信記録に残るため。
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

export type TestMember = { userId: string; email: string };

type MailpitSearch = { messages?: Array<{ ID: string }> };
type MailpitMessage = { Text?: string; HTML?: string };

function localAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) {
    throw new Error('会員を作れるのは手元の Supabase だけ');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function localMailUrl(): string {
  const url = process.env.MAIL_LOCAL_URL;
  if (!url || !isLocalUrl(url)) {
    throw new Error('手元のメール受け（MAIL_LOCAL_URL）が無い');
  }
  return url;
}

/** 宛先を試験ごとに分けることで、別の試験のメールや会員を拾わないようにする。 */
export async function createTestMember(label: string): Promise<TestMember> {
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error('会員のラベルは小文字の英数字とハイフンだけで指定してください');
  }
  const email = `e2e-member-${label}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.com`;
  const { data, error } = await localAdmin().auth.admin.createUser({
    email,
    email_confirm: true,
    password: `E2e-${randomBytes(12).toString('hex')}!`,
  }).catch(() => {
    // SDK の例外に要求の秘密値が含まれても、失敗の報告へ引き継がないため。
    throw new Error('手元の会員を作る要求に失敗した');
  });
  if (error || !data.user) {
    throw new Error(`手元の会員を作れない（status: ${error?.status ?? '不明'}, code: ${error?.code ?? '不明'}）`);
  }
  return { userId: data.user.id, email };
}

async function readMailpitMessages(email: string): Promise<Array<{ ID: string }>> {
  const searchUrl = new URL('/api/v1/search', localMailUrl());
  searchUrl.searchParams.set('query', `to:${email}`);
  // 確認コード入りの応答をブラウザの文脈の通信記録へ載せないため、Node で読む。
  const search = await fetch(searchUrl, {
    signal: AbortSignal.timeout(5_000),
    redirect: 'manual',
  }).catch(() => {
    throw new Error('手元のメール受けを検索できない');
  });
  if (!search.ok) {
    throw new Error(`手元のメール受けを検索できない: ${search.status}`);
  }
  const body = (await search.json().catch(() => {
    throw new Error('手元のメール検索の応答を読めない');
  })) as MailpitSearch;
  return body.messages ?? [];
}

async function readLatestCode(email: string, previousMessageIds: ReadonlySet<string>): Promise<string> {
  const mailUrl = localMailUrl();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const messages = await readMailpitMessages(email);
    const latest = messages.find((message) => !previousMessageIds.has(message.ID));
    if (latest) {
      const message = await fetch(new URL(`/api/v1/message/${encodeURIComponent(latest.ID)}`, mailUrl), {
        signal: AbortSignal.timeout(5_000),
        redirect: 'manual',
      }).catch(() => {
        throw new Error('手元の確認コードのメールを取得できない');
      });
      if (!message.ok) {
        throw new Error(`手元の確認コードのメールを取得できない: ${message.status}`);
      }
      const content = (await message.json().catch(() => {
        throw new Error('手元の確認コードのメール本文を読めない');
      })) as MailpitMessage;
      // リンクのハッシュや HTML 属性の数字を確認コードと取り違えないため。
      const text = `${content.Text ?? ''}\n${(content.HTML ?? '').replace(/<[^>]*>/g, ' ')}`
        .replace(/https?:\/\/\S+/g, ' ');
      const code = text.match(/\b(\d{8})\b/)?.[1];
      if (code) return code;
      throw new Error('メールに8桁の確認コードが無い。手元の OTP メールテンプレートを確認してください');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('確認コードのメールが届かない');
}

/** 同じブラウザで注文する際の認証と CSRF を、アプリの実際の発行処理で揃える。 */
export async function loginAsMember(page: Page, member: TestMember): Promise<void> {
  if (!isLocalUrl(process.env.NEXT_PUBLIC_SUPABASE_URL) || process.env.MAIL_PROVIDER !== 'local') {
    throw new Error('会員のログインは手元の Supabase とメール送信だけで使える');
  }
  localMailUrl();
  if (page.url() === 'about:blank') {
    await page.goto('/');
  }
  const origin = new URL(page.url()).origin;
  if (!isLocalUrl(origin)) {
    throw new Error('会員のログイン先は手元のアプリに限る');
  }
  await setLoginTwoFactorCookie(page, member.email, member.userId);
  // アプリと Mailpit の時計がずれても、再送前からあるメールを選ばないため。
  const previousMessageIds = new Set((await readMailpitMessages(member.email)).map((message) => message.ID));
  // page.request の baseURL と表示中のページが違っても、確認済みの手元へだけ送るため。
  const resend = await page.request.post(new URL('/api/auth/login/resend', origin).toString(), {
    headers: { origin },
    maxRedirects: 0,
  }).catch(() => {
    throw new Error('確認コードを送る要求に失敗した');
  });
  if (!resend.ok()) {
    throw new Error(`確認コードを送れない: ${resend.status()}`);
  }
  const code = await readLatestCode(member.email, previousMessageIds);
  const verify = await page.request.post(new URL('/api/auth/otp/verify', origin).toString(), {
    headers: { origin },
    data: { code },
    maxRedirects: 0,
  }).catch(() => {
    throw new Error('確認コードを検証する要求に失敗した');
  });
  if (!verify.ok()) {
    throw new Error(`確認コードが通らない: ${verify.status()}`);
  }
  const cookies = await page.context().cookies(origin);
  if (!['sb-access-token', 'sb-refresh-token', 'sb-csrf-token', 'session_id']
    .every((name) => cookies.some((cookie) => cookie.name === name && cookie.value))) {
    throw new Error('ログイン・CSRF の Cookie が揃っていない');
  }
  const me = await page.request.get(new URL('/api/auth/me', origin).toString(), { maxRedirects: 0 }).catch(() => {
    throw new Error('ログインした会員を確かめる要求に失敗した');
  });
  if (!me.ok()) {
    throw new Error(`ログインした会員を確かめられない: ${me.status()}`);
  }
  const body = (await me.json().catch(() => {
    throw new Error('ログインした会員の応答を読めない');
  })) as { authenticated?: boolean; user?: { id?: string } };
  if (body.authenticated !== true || body.user?.id !== member.userId) {
    throw new Error('会員としてログインできていない');
  }
}
