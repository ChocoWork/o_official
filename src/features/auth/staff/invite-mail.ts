export type InviteMailInput = {
  kind: 'invite' | 'redo' | 'promote';
  roleLabel: '店長' | 'サポーター';
  url: string;
  expiresAtJst: string;
  passkeysDeleted: boolean;
};

const SUBJECT = '店員のアカウントの登録のご案内';
const SHOP_NAME = 'Le Fil des Heures';
const DELETED_NOTICE = 'これまでのパスキーはすべて削除されました。';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 店員の招待のメール（件名・テキスト・HTML）の文面を作る。挨拶・署名・件名の頭の店名は付けない。
 * `redo`・`promote`、およびパスキーを持っていた人への `invite`（`passkeysDeleted`）は、冒頭に削除の知らせを入れる
 * （削除の知らせを送らないので、本人に知らせる物はこのメールだけになる）。合言葉は URL にだけ入り、ログには出さない。
 *
 * @impl IMPL-AUTH-356
 * @design DD-AUTH-075
 */
export function composeInviteMail(input: InviteMailInput): { subject: string; text: string; html: string } {
  const notice = input.kind !== 'invite' || input.passkeysDeleted;
  const paragraphs: string[][] = [
    ...(notice ? [[DELETED_NOTICE]] : []),
    [`${SHOP_NAME} の${input.roleLabel}として、パスキーの登録をお願いします。`],
    [
      '下のリンクを開き、ボタンを押して、顔認証・指紋・PIN で入る方法（パスキー）を2本登録してください。',
      '2本目は、別の端末かセキュリティキーでの登録をおすすめします。',
    ],
    [input.url],
    [`リンクの有効期限は ${input.expiresAtJst} までです。`],
    ['ご自身で心当たりがない場合は、何もしないでください。'],
  ];

  const text = paragraphs.map((lines) => lines.join('\n')).join('\n\n');
  const html = paragraphs
    .map((lines) => {
      const body = lines
        .map((line) => {
          const escaped = escapeHtml(line);
          return line === input.url ? `<a href="${escaped}">${escaped}</a>` : escaped;
        })
        .join('<br>');
      return `<p>${body}</p>`;
    })
    .join('\n');

  return { subject: SUBJECT, text, html };
}
