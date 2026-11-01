import fs from 'node:fs';
import path from 'node:path';

/**
 * 波 6 で手元の Supabase の設定を本番の前提にそろえた版（Task 8）を、Supabase を起動せずに確かめる。
 * 2026-11-01 に `supabase/config.toml` へ切り替えた（波 6 の Task 10）。
 */

const ROOT = process.cwd();
const TARGET_PATH = path.join(ROOT, 'supabase/config.toml');

type Section = Record<string, string>;

/** 行ごとに `[section]` と `key = value` を読む最小の読み手（コメント行・行末のコメントを除く）。 */
function parseToml(file: string): Record<string, Section> {
  const sections: Record<string, Section> = { '': {} };
  let current = '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      current = header[1];
      sections[current] ??= {};
      continue;
    }
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!pair) continue;
    const value = pair[2].replace(/\s+#.*$/, '').trim();
    sections[current][pair[1]] = value;
  }
  return sections;
}

const target = parseToml(TARGET_PATH);
const rawTarget = fs.readFileSync(TARGET_PATH, 'utf8');

describe('DD-AUTH-040 手元の Supabase の設定を本番の前提にそろえる（波 6 Task 8）', () => {
  it('DD-AUTH-040 最小の長さは 16 で、構成規則は課さない', () => {
    expect(target.auth.minimum_password_length).toBe('16');
    expect(target.auth.password_requirements).toBe('""');
  });

  it('DD-AUTH-040 captcha は turnstile で有効、秘密は環境変数の参照だけで平文を置かない', () => {
    const captcha = target['auth.captcha'];
    expect(captcha).toBeDefined();
    expect(captcha.enabled).toBe('true');
    expect(captcha.provider).toBe('"turnstile"');
    expect(captcha.secret).toBe('"env(SUPABASE_AUTH_CAPTCHA_SECRET)"');
    expect(rawTarget).not.toContain('1x0000000000000000000000000000000AA');
  });

  it('DD-AUTH-040 確認メール必須・パスワード変更の再認証・OTP 300 秒・8 桁・二重確認・登録の許可', () => {
    const email = target['auth.email'];
    expect(email.enable_confirmations).toBe('true');
    expect(email.secure_password_change).toBe('true');
    expect(email.otp_expiry).toBe('300');
    expect(email.otp_length).toBe('8');
    expect(email.double_confirm_changes).toBe('true');
    expect(email.enable_signup).toBe('true');
    expect(target.auth.enable_signup).toBe('true');
  });

  it('DD-AUTH-040 TOTP の登録と確認が有効', () => {
    const totp = target['auth.mfa.totp'];
    expect(totp.enroll_enabled).toBe('true');
    expect(totp.verify_enabled).toBe('true');
  });

  it('DD-AUTH-040 パスワード変更の通知が有効で、本文のファイルが在り、パスワードを含まない', () => {
    const notice = target['auth.email.notification.password_changed'];
    expect(notice).toBeDefined();
    expect(notice.enabled).toBe('true');
    const contentPath = /^"\.\/(.+)"$/.exec(notice.content_path)?.[1];
    expect(contentPath).toBeDefined();
    const file = path.join(ROOT, contentPath as string);
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).not.toMatch(/\{\{\s*\.(Token|Password|ConfirmationURL|TokenHash)/);
  });

  it('DD-AUTH-040 ログインの確認コードの雛形は変えない', () => {
    const template = target['auth.email.template.magic_link'];
    expect(template.content_path).toBe('"./supabase/templates/magic_link.html"');
  });

  it('DD-AUTH-040 会員登録の確認メールは token_hash と type=signup を持つ確認の窓口へのリンク（GoTrue の既定のリンクにしない）', () => {
    const template = target['auth.email.template.confirmation'];
    expect(template).toBeDefined();
    const contentPath = /^"\.\/(.+)"$/.exec(template.content_path)?.[1];
    expect(contentPath).toBeDefined();
    const file = path.join(ROOT, contentPath as string);
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup');
    expect(body).not.toMatch(/\{\{\s*\.(ConfirmationURL|Token|Password)\b/);
  });

  it('DD-AUTH-040 自前の SMTP は有効にしない（手元のメールは mailpit）', () => {
    const smtp = target['auth.email.smtp'];
    expect(smtp === undefined || smtp.enabled === 'false').toBe(true);
  });

  it('DD-AUTH-040 メールの送信先（手元の mailpit）とポートは今のまま', () => {
    expect(target.api.port).toBe('54321');
    expect(target.db.port).toBe('54322');
    expect(target['db.pooler'].port).toBe('54329');
    expect(target.studio.port).toBe('54323');
    expect(target.local_smtp.port).toBe('54324');
    expect(target.local_smtp.enabled).toBe('true');
  });

  it('DD-AUTH-040 回数の枠は変えない（手元の E2E の前提）', () => {
    const limit = target['auth.rate_limit'];
    expect(limit.email_sent).toBe('2');
    expect(limit.sign_in_sign_ups).toBe('30');
    expect(limit.token_refresh).toBe('150');
  });

  it('DD-AUTH-040 captcha の秘密の例は公開のテスト用の値で、本番の秘密を置かない', () => {
    const example = path.join(ROOT, 'supabase/.env.example');
    expect(fs.existsSync(example)).toBe(true);
    const body = fs.readFileSync(example, 'utf8');
    expect(body).toMatch(/^SUPABASE_AUTH_CAPTCHA_SECRET=1x0000000000000000000000000000000AA\s*$/m);
    expect(body).not.toMatch(/0x4[A-Za-z0-9_-]{20,}/);
  });
});
