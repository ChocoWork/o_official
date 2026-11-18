/**
 * DD-AUTH-075 店員の招待のメールの文面（src/features/auth/staff/invite-mail.ts）の単体テスト。
 */

import { composeInviteMail } from '@/features/auth/staff/invite-mail';

const TOKEN = '0123456789abcdef0123456789abcdef0123456789a';
const URL_WITH_TOKEN = `https://shop.example.com/staff/invite#${TOKEN}`;
const EXPIRES = '2026年11月19日 10:30（日本時間）';
const DELETED = 'これまでのパスキーはすべて削除されました。';

const base = { kind: 'invite' as const, roleLabel: '店長' as const, url: URL_WITH_TOKEN, expiresAtJst: EXPIRES, passkeysDeleted: false };

describe('invite-mail', () => {
  it('DD-AUTH-075 本文に役割・URL・期限・心当たりがない時の案内が入る', () => {
    const mail = composeInviteMail(base);
    expect(mail.subject).toBe('店員のアカウントの登録のご案内');
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain('Le Fil des Heures の店長として、パスキーの登録をお願いします。');
      expect(body).toContain('顔認証・指紋・PIN で入る方法（パスキー）を2本登録してください');
      expect(body).toContain('別の端末かセキュリティキーでの登録をおすすめします');
      expect(body).toContain(URL_WITH_TOKEN);
      expect(body).toContain(`リンクの有効期限は ${EXPIRES} までです。`);
      expect(body).toContain('ご自身で心当たりがない場合は、何もしないでください。');
    }
  });

  it('DD-AUTH-075 役割の名前をサポーターに替えられる', () => {
    const mail = composeInviteMail({ ...base, roleLabel: 'サポーター' });
    expect(mail.text).toContain('Le Fil des Heures のサポーターとして');
  });

  it('DD-AUTH-075 挨拶・署名・件名の頭の店名を付けず、感嘆符も使わない', () => {
    const mail = composeInviteMail({ ...base, passkeysDeleted: true });
    expect(mail.subject).not.toContain('Le Fil des Heures');
    expect(mail.subject).not.toContain('【');
    expect(mail.text).not.toContain('ありがとうございます');
    expect(mail.text).not.toContain('敬具');
    expect(mail.text).not.toMatch(/[!！]/);
    expect(mail.text.split('\n')[0]).not.toContain('様');
  });

  it('DD-AUTH-075 合言葉は URL にだけ入り、件名には出ない', () => {
    const mail = composeInviteMail(base);
    expect(mail.subject).not.toContain(TOKEN);
    expect(mail.text.split(TOKEN)).toHaveLength(2);
  });

  it('DD-AUTH-075 passkeysDeleted が真なら冒頭に削除の一文を入れ、偽なら入れない', () => {
    const withNotice = composeInviteMail({ ...base, passkeysDeleted: true });
    expect(withNotice.text.startsWith(DELETED)).toBe(true);
    expect(withNotice.html).toContain(DELETED);
    expect(composeInviteMail(base).text).not.toContain(DELETED);
    expect(composeInviteMail(base).html).not.toContain(DELETED);
  });

  it('DD-AUTH-075 redo と promote は passkeysDeleted が偽でも削除の一文を入れる', () => {
    for (const kind of ['redo', 'promote'] as const) {
      const mail = composeInviteMail({ ...base, kind, passkeysDeleted: false });
      expect(mail.text.startsWith(DELETED)).toBe(true);
      expect(mail.html).toContain(DELETED);
    }
  });

  it('DD-AUTH-075 html は差し込む文字を escape する', () => {
    const mail = composeInviteMail({ ...base, url: 'https://x.example/a?b=1&c="2"#<t>', expiresAtJst: '<b>' });
    expect(mail.html).not.toContain('<t>');
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&amp;');
    expect(mail.html).toContain('&lt;t&gt;');
  });

  it('DD-AUTH-075 合言葉を console に出さない', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    composeInviteMail(base);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
