/**
 * DD-AUTH-067 パスキーの知らせのメールの文面（src/lib/auth/passkey-notification-compose.ts）の単体テスト。
 */
import { composePasskeyNotification, isStaffNoticeKind, sanitizePasskeyNameForMail } from '@/lib/auth/passkey-notification-compose';

const AT = new Date('2026-11-17T15:05:00Z'); // 日本時間 2026年11月18日 0:05
const WHEN = '2026年11月18日 0:05（日本時間）';
const URL = 'https://example.com/contact';
const base = { friendlyName: 'iPhone', occurredAt: AT, subjectEmail: 'staff@example.com', actorEmail: null, contactUrl: URL } as const;

const customerBody = (lead: string, selfLine: string) => [
  'Le Fil des Heures をご利用いただき、ありがとうございます。',
  '',
  lead,
  '',
  '名前: iPhone',
  `日時: ${WHEN}`,
  '',
  selfLine,
  '心当たりがない場合は、お手数ですが、すぐに次のお問い合わせからご連絡ください。',
  URL,
].join('\n');

const staffBody = (lead: string) => [
  'Le Fil des Heures をご利用いただき、ありがとうございます。',
  '',
  lead,
  '',
  '名前: iPhone',
  `日時: ${WHEN}`,
  '',
  'ご自身で行われた操作でない場合は、すぐに店長へお知らせください。',
].join('\n');

const adminBody = (tail: string) => [
  `staff@example.com ${tail}`,
  '',
  '名前: iPhone',
  `日時: ${WHEN}`,
  '',
  '本人の操作か確認してください。心当たりがない場合は、そのアカウントのログインを止めてください。',
].join('\n');

describe('composePasskeyNotification', () => {
  it('DD-AUTH-067 お客さん3種類の件名と本文を固定する', () => {
    expect(composePasskeyNotification({ ...base, kind: 'passkey_added', audience: 'subject_customer' })).toEqual({
      subject: 'パスキーが追加されました',
      text: customerBody('ご登録のアカウントに、パスキーが追加されました。', 'ご自身で追加された場合は、このメールへのご対応は必要ありません。'),
    });
    expect(composePasskeyNotification({ ...base, kind: 'passkey_removed', audience: 'subject_customer' })).toEqual({
      subject: 'パスキーが削除されました',
      text: customerBody('ご登録のアカウントから、パスキーが削除されました。', 'ご自身で削除された場合は、このメールへのご対応は必要ありません。'),
    });
    expect(composePasskeyNotification({ ...base, kind: 'passkey_key_replaced', audience: 'subject_customer' })).toEqual({
      subject: 'パスキーの内容が変更されました',
      text: customerBody(
        'ご登録のアカウントのパスキーの内容が、通常の操作では行われない方法で変更されました。',
        'ご自身で変更された場合は、このメールへのご対応は必要ありません。',
      ),
    });
  });

  it('DD-AUTH-067 店員（本人）3種類は末尾を店長への連絡に替え、お問い合わせの住所を入れない', () => {
    const added = composePasskeyNotification({ ...base, kind: 'passkey_added', audience: 'subject_staff' });
    expect(added).toEqual({ subject: 'パスキーが追加されました', text: staffBody('ご登録のアカウントに、パスキーが追加されました。') });
    expect(composePasskeyNotification({ ...base, kind: 'passkey_removed', audience: 'subject_staff' })).toEqual({
      subject: 'パスキーが削除されました',
      text: staffBody('ご登録のアカウントから、パスキーが削除されました。'),
    });
    const replaced = composePasskeyNotification({ ...base, kind: 'passkey_key_replaced', audience: 'subject_staff' });
    expect(replaced.subject).toBe('パスキーの内容が変更されました');
    expect(replaced.text).toBe(staffBody('ご登録のアカウントのパスキーの内容が、通常の操作では行われない方法で変更されました。'));
    expect(added.text).not.toContain(URL);
  });

  it('DD-AUTH-067 店長3種類は本人のアドレスを入れた文面になる', () => {
    expect(composePasskeyNotification({ ...base, kind: 'passkey_added', audience: 'admin' })).toEqual({
      subject: '店員のパスキーが追加されました',
      text: adminBody('のパスキーが追加されました。'),
    });
    expect(composePasskeyNotification({ ...base, kind: 'passkey_removed', audience: 'admin' })).toEqual({
      subject: '店員のパスキーが削除されました',
      text: adminBody('のパスキーが削除されました。'),
    });
    expect(composePasskeyNotification({ ...base, kind: 'passkey_key_replaced', audience: 'admin' })).toEqual({
      subject: '店員のパスキーの内容が変更されました',
      text: adminBody('のパスキーの内容が変更されました。'),
    });
  });

  it('DD-AUTH-067 本人のアドレスは、お客さん・店員（本人）の文面に出ない', () => {
    for (const audience of ['subject_customer', 'subject_staff'] as const) {
      const { subject, text } = composePasskeyNotification({ ...base, kind: 'passkey_added', audience });
      expect(`${subject}\n${text}`).not.toContain('staff@example.com');
    }
  });

  it('DD-AUTH-067 日時は日本時間で、月・日・時を0埋めしない', () => {
    const text = composePasskeyNotification({
      ...base, kind: 'passkey_added', audience: 'admin', occurredAt: new Date('2026-01-05T00:30:00Z'),
    }).text;
    expect(text).toContain('日時: 2026年1月5日 9:30（日本時間）');
  });

  it('DD-AUTH-067 名前が無い・空・空白だけなら「名前なし」', () => {
    for (const friendlyName of [null, '', '   ', '\u202e\n']) {
      expect(composePasskeyNotification({ ...base, friendlyName, kind: 'passkey_added', audience: 'admin' }).text).toContain('名前: 名前なし');
    }
  });

  it('DD-AUTH-067 名前の改行は空白に替え、制御文字・表示の向きを変える文字を除き、64字で切る', () => {
    expect(sanitizePasskeyNameForMail('a\r\nb\nc')).toBe('a b c');
    expect(sanitizePasskeyNameForMail('x\u0000y\u0085z\u202eq\u2066r\u200fs')).toBe('xyzqrs');
    expect(sanitizePasskeyNameForMail('あ'.repeat(70))).toBe('あ'.repeat(64));
    const text = composePasskeyNotification({
      ...base, friendlyName: 'ok\nBcc: evil@example.com', kind: 'passkey_added', audience: 'admin',
    }).text;
    expect(text.split('\n')).toContain('名前: ok Bcc: evil@example.com');
  });

  it('DD-AUTH-067 絵文字・感嘆符を使わない', () => {
    const kinds = ['passkey_added', 'passkey_removed', 'passkey_key_replaced'] as const;
    const audiences = ['subject_customer', 'subject_staff', 'admin'] as const;
    for (const kind of kinds) {
      for (const audience of audiences) {
        const { subject, text } = composePasskeyNotification({ ...base, kind, audience });
        expect(`${subject}${text}`).not.toMatch(/[!！\p{Extended_Pictographic}]/u);
      }
    }
  });

  it('DD-AUTH-067 店長の文面で本人のアドレスが無い（アカウントが消えた後）時は「店員の」で始める', () => {
    const { text } = composePasskeyNotification({ ...base, subjectEmail: null, kind: 'passkey_removed', audience: 'admin' });
    expect(text.split('\n')[0]).toBe('店員のパスキーが削除されました。');
  });

  describe('店長への知らせ（やり直し・招待・降格）', () => {
    const staffBase = { ...base, actorEmail: 'boss@example.com', friendlyName: null, audience: 'admin' } as const;
    const cases = [
      ['staff_redo_issued', '店員のパスキーのやり直しが出されました', 'staff@example.com のパスキーのやり直しが出されました。', '店員のパスキーのやり直しが出されました。'],
      ['staff_invited', '店員の招待が出されました', 'staff@example.com への店員の招待が出されました。', '店員の招待が出されました。'],
      ['staff_demoted', '店員がお客さんに戻されました', 'staff@example.com が、店員からお客さんに戻されました。', '店員が、お客さんに戻されました。'],
    ] as const;

    it.each(cases)('DD-AUTH-087 %s の件名・本文は付録のとおり（日時と操作した店長を出し、名前の行は出さない）', (kind, subject, lead) => {
      expect(composePasskeyNotification({ ...staffBase, kind })).toEqual({
        subject,
        text: [lead, '', `日時: ${WHEN}`, '操作した店長: boss@example.com', '', '心当たりがない場合は、店長の権限を確認してください。'].join('\n'),
      });
    });

    it.each(cases)('DD-AUTH-087 %s は actorEmail が null でも作れ、操作した店長の行を出さない', (kind, _subject, _lead, noTarget) => {
      const { text } = composePasskeyNotification({ ...staffBase, kind, actorEmail: null, subjectEmail: null });
      expect(text).not.toContain('操作した店長');
      expect(text.split('\n')[0]).toBe(noTarget);
      expect(text).toContain(`日時: ${WHEN}`);
    });

    it.each(cases)('DD-AUTH-087 %s の件名に対象・操作した店長のアドレスを入れない', (kind) => {
      const { subject } = composePasskeyNotification({ ...staffBase, kind });
      expect(subject).not.toContain('@');
    });

    it.each(cases)('DD-AUTH-087 %s は admin 以外の宛先なら例外', (kind) => {
      expect(() => composePasskeyNotification({ ...staffBase, kind, audience: 'subject_customer' })).toThrow();
      expect(() => composePasskeyNotification({ ...staffBase, kind, audience: 'subject_staff' })).toThrow();
    });

    it('DD-AUTH-087 絵文字・感嘆符を使わない', () => {
      for (const [kind] of cases) {
        const { subject, text } = composePasskeyNotification({ ...staffBase, kind });
        expect(`${subject}${text}`).not.toMatch(/[!！\p{Extended_Pictographic}]/u);
      }
    });
  });

  it('DD-AUTH-087 isStaffNoticeKind は店長への知らせの3種類だけ真', () => {
    for (const kind of ['staff_redo_issued', 'staff_invited', 'staff_demoted'] as const) expect(isStaffNoticeKind(kind)).toBe(true);
    for (const kind of ['passkey_added', 'passkey_removed', 'passkey_key_replaced'] as const) expect(isStaffNoticeKind(kind)).toBe(false);
  });
});
