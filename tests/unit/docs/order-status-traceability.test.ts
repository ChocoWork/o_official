/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const tick = String.fromCharCode(96);
const requirementsFile = 'docs/02_Requirements/requirements.md';
const pageFile = 'docs/04_DetailDesign/pages/20_order_status.md';
const specFile = 'docs/superpowers/specs/2026-10-22-order-status-page-design.md';
const planFile = 'docs/superpowers/plans/2026-10-22-order-status-page.md';
// Task 10 brief の32 AC。実行済み証拠ではなく、要求・試験定義の対応を固定する。
const expectedRequirements = [["FREQ-498","注文の状況をリンクから見られる機能を提供すること（グループ E-5）","FREQ-498-REQ-01","・ログインせずに指定の公開範囲を見られること"],["FREQ-499","電話番号で個人情報を確かめる機能を提供すること（グループ E-5）","FREQ-499-REQ-01","・下4桁の確認を通った時だけ指定の個人情報を表示すること"],["FREQ-500","本人確認の期限と回数を守る機能を提供すること（グループ E-5）","FREQ-500-REQ-01","・対象メールの送信成功からの期限と確認の上限を守ること"],["FREQ-501","会員も同じ注文リンクを使える機能を提供すること（グループ E-5）","FREQ-501-REQ-01","・持ち主のログインとゲストの確認を区別して扱うこと"],["FREQ-502","注文状況から返品とキャンセルを案内する機能を提供すること（グループ E-5）","FREQ-502-REQ-01","・記録の表示と申し込みの入口を分けること"],["FREQ-503","注文メールから状況ページへ案内する機能を提供すること（グループ E-5）","FREQ-503-REQ-01","・対象の本文に同じリンクを入れ電話番号を除くこと"],["FREQ-504","お問い合わせを注文番号入りで開く機能を提供すること（グループ E-5）","FREQ-504-REQ-01","・許可したURLの値だけで問い合わせの初期入力を作ること"],["FREQ-505","注文状況の閲覧とデータを守る機能を提供すること（グループ E-5）","FREQ-505-REQ-01","・権限と情報の分離を守り検索と漏えいを防ぐこと"]];
const expectedAcMap = [
  {"id":"FREQ-498-AC-01","statement":"リンクだけで注文番号・注文日・品物・数・金額が表示され、個人情報の項目が取得されないこと","unit":["tests/unit/lib/orders/customer-order-view.test.ts","tests/unit/components/OrderStatusPage.test.tsx","tests/unit/features/order-status/OrderStatusPublic.test.tsx","tests/unit/lib/orders/status/status-store.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-001-public-view.spec.ts"],"scope":"FR-ORDER-001","tasks":"1/3/4/6"},
  {"id":"FREQ-498-AC-02","statement":"進み具合と発送・配送の状況が会員の注文と同じ条件で表示され、取り消した発送と古い配送の版が表示されないこと","unit":["tests/unit/lib/orders/customer-order-view.test.ts","tests/unit/features/order-status/OrderStatusPublic.test.tsx"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts"],"scope":"FR-ORDER-008","tasks":"1/3/6"},
  {"id":"FREQ-498-AC-03","statement":"返金の額と状況、返品・キャンセルの申し込みの状況が表示され、失敗の詳細と店内だけの情報が表示されないこと","unit":["tests/unit/lib/orders/customer-order-view.test.ts","tests/unit/features/order-status/OrderStatusPublic.test.tsx","tests/unit/features/account/returns/OrderReturnsSection.test.tsx"],"db":["tests/integration/db/order_status_links.integration.test.ts","tests/integration/db/order_status_returns.integration.test.ts"],"e2e":["e2e/FR-ORDER-005-returns-guidance.spec.ts","e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts"],"scope":"FR-ORDER-005、FR-ORDER-008","tasks":"1/2/3/6"},
  {"id":"FREQ-498-AC-04","statement":"取り消した注文は表示され、支払いの途中・放棄・存在しない注文と形の違うリンクは同じ404で表示されること","unit":["tests/unit/components/OrderStatusPage.test.tsx","tests/unit/api/order-status/private.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-007-not-found-security.spec.ts"],"scope":"FR-ORDER-007","tasks":"1/5/6"},
  {"id":"FREQ-499-AC-01","statement":"全角数字や記号を含む注文時の電話の下4桁で確認でき、数字が4桁に満たない電話では確認できないこと","unit":["tests/unit/lib/orders/status/status-phone.test.ts","tests/unit/api/order-status/verify.test.ts","tests/unit/features/order-status/OrderStatusVerifyForm.test.tsx"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-002-verify-private.spec.ts"],"scope":"FR-ORDER-002（短い電話はDB/単体）","tasks":"1/4/5/6"},
  {"id":"FREQ-499-AC-02","statement":"正しい確認の後だけ、お届け先・連絡先メール・支払方法・発送と送り返しの伝票番号・追跡先・返品の送り先が表示されること","unit":["tests/unit/lib/orders/customer-order-view.test.ts","tests/unit/api/order-status/private.test.ts"],"db":["tests/integration/db/order_status_returns.integration.test.ts"],"e2e":["e2e/FR-ORDER-002-verify-private.spec.ts"],"scope":"FR-ORDER-002","tasks":"2/3/5/6"},
  {"id":"FREQ-499-AC-03","statement":"確認の印が署名され、24時間と確認期限の早い方まで専用窓口の住所だけに保存され、注文ごとに区別されること","unit":["tests/unit/lib/orders/status/status-session.test.ts"],"db":[],"e2e":["e2e/FR-ORDER-002-verify-private.spec.ts"],"scope":"FR-ORDER-002（属性と2注文。署名異常の全形は単体）","tasks":"4/6"},
  {"id":"FREQ-499-AC-04","statement":"改変・別注文・期限切れの印では個人情報が表示されず、公開の状況は引き続き表示されること","unit":["tests/unit/lib/orders/status/status-session.test.ts","tests/unit/api/order-status/private.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":[],"e2e":["e2e/FR-ORDER-004-expiry.spec.ts"],"scope":"FR-ORDER-004","tasks":"4/5/6"},
  {"id":"FREQ-500-AC-01","statement":"お客様向け16種類の送信成功だけで確認期限が21日後へ進み、同時に完了しても期限が戻らないこと","unit":["tests/unit/lib/orders/email/order-email-worker.test.ts","tests/unit/lib/orders/email/order-email-worker-delivery.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-006-email-link.spec.ts"],"scope":"FR-ORDER-006（paidの成功。16種類と競合はDB）","tasks":"1/7"},
  {"id":"FREQ-500-AC-02","statement":"注文ごとの15分に5回と送信元ごとの10分に30回を超える確認が拒否されること","unit":["tests/unit/api/order-status/verify.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-003-verify-limits.spec.ts"],"scope":"FR-ORDER-003","tasks":"5/9"},
  {"id":"FREQ-500-AC-03","statement":"不一致だけが合計20回まで数えられ、期限が進む送信成功の時だけ失敗数が0へ戻ること","unit":["tests/unit/api/order-status/verify.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-003-verify-limits.spec.ts"],"scope":"FR-ORDER-003","tasks":"1/5/6"},
  {"id":"FREQ-500-AC-04","statement":"確認期限が無い時と切れた時は下4桁の欄が表示されず、ログインとお問い合わせが案内されること","unit":["tests/unit/lib/orders/status/status-store.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-004-expiry.spec.ts"],"scope":"FR-ORDER-004","tasks":"1/4/6"},
  {"id":"FREQ-501-AC-01","statement":"持ち主の会員が同じリンクを開くと、下4桁の確認期限の後も個人情報が表示されること","unit":["tests/unit/api/order-status/private.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":[],"e2e":["e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts"],"scope":"FR-ACCOUNT-044","tasks":"5/6"},
  {"id":"FREQ-501-AC-02","statement":"ログインの印が切れても有効な更新の印があれば更新後に個人情報が表示されること","unit":["tests/unit/api/order-status/private.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":[],"e2e":["e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts"],"scope":"FR-ACCOUNT-044","tasks":"5/6"},
  {"id":"FREQ-501-AC-03","statement":"別の会員のログインだけでは個人情報が表示されず、その注文の有効な確認印がある時だけ表示されること","unit":["tests/unit/api/order-status/private.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":[],"e2e":["e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts"],"scope":"FR-ACCOUNT-044","tasks":"5/6"},
  {"id":"FREQ-501-AC-04","statement":"ログインの印がないゲストへの個人情報の応答は未認可の200となり、不要なログイン更新と未ログインへの描き直しが起きないこと","unit":["tests/unit/api/order-status/private.test.ts","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":[],"e2e":["e2e/FR-ORDER-001-public-view.spec.ts"],"scope":"FR-ORDER-001","tasks":"5/6"},
  {"id":"FREQ-502-AC-01","statement":"返品の読み出しを共通化した後も、既存の持ち主向け関数の答えと拒否の振る舞いが変更前と一致すること","unit":["tests/unit/lib/orders/customer-order-view.test.ts"],"db":["tests/integration/db/order_status_returns.integration.test.ts"],"e2e":[],"scope":"—（DB 結合・単体で検証）","tasks":"2/3"},
  {"id":"FREQ-502-AC-02","statement":"注文状況では返品とキャンセルの記録を表示し、申し込みのボタンとフォームを表示しないこと","unit":["tests/unit/features/account/returns/OrderReturnsSection.test.tsx","tests/unit/features/order-status/OrderStatusPublic.test.tsx"],"db":["tests/integration/db/order_status_returns.integration.test.ts"],"e2e":["e2e/FR-ORDER-005-returns-guidance.spec.ts"],"scope":"FR-ORDER-005","tasks":"2/6"},
  {"id":"FREQ-502-AC-03","statement":"持ち主としてログインしていない人へ、同じメールでの登録とメール確認の説明、お問い合わせの2つの道が表示されること","unit":["tests/unit/features/order-status/OrderStatusGuidance.test.tsx"],"db":[],"e2e":["e2e/FR-ORDER-005-returns-guidance.spec.ts"],"scope":"FR-ORDER-005","tasks":"6"},
  {"id":"FREQ-502-AC-04","statement":"持ち主の会員へ、返品・キャンセルを申し込める会員の注文のページのリンクが表示されること","unit":["tests/unit/features/order-status/OrderStatusGuidance.test.tsx","tests/unit/features/order-status/OrderStatusAccess.test.tsx"],"db":[],"e2e":["e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts"],"scope":"FR-ACCOUNT-044","tasks":"6"},
  {"id":"FREQ-503-AC-01","statement":"お客様向け16種類だけに同じ注文のリンクが1行入り、配達済みの旧会員用リンクが置き換わり、店向け3種類は変わらないこと","unit":["tests/unit/lib/orders/email/order-email-compose.test.ts","tests/unit/lib/orders/email/order-email-compose-returns.test.ts","tests/unit/lib/orders/email/order-email-compose-requests.test.ts","tests/unit/lib/orders/email/order-email-compose-delivery.test.ts","tests/unit/lib/orders/email/order-email-worker.test.ts","tests/unit/lib/orders/email/order-email-worker-delivery.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":["e2e/FR-ORDER-006-email-link.spec.ts","e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts"],"scope":"FR-ORDER-006（paidだけ）、既存FR-ADMIN-101（delivered）","tasks":"1/7/9"},
  {"id":"FREQ-503-AC-02","statement":"支払済みと支払い待ちの本文からお客様の電話が消え、名前・住所と返品先のお店の電話は残ること","unit":["tests/unit/lib/orders/email/order-email-compose.test.ts","tests/unit/lib/orders/email/order-email-compose-returns.test.ts","tests/unit/lib/orders/email/order-email-compose-requests.test.ts","tests/unit/lib/orders/email/order-email-compose-delivery.test.ts"],"db":[],"e2e":["e2e/FR-ORDER-006-email-link.spec.ts","e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts"],"scope":"FR-ORDER-006（paidだけ）、既存FR-CHECKOUT-049","tasks":"7/9"},
  {"id":"FREQ-503-AC-03","statement":"サイトの住所を作れない時はそのメールが材料不足として扱われ、ほかのメールの処理は続くこと","unit":["tests/unit/lib/orders/email/order-email-compose.test.ts","tests/unit/lib/orders/email/order-email-compose-returns.test.ts","tests/unit/lib/orders/email/order-email-compose-requests.test.ts","tests/unit/lib/orders/email/order-email-compose-delivery.test.ts","tests/unit/lib/orders/email/order-email-worker.test.ts","tests/unit/lib/orders/email/order-email-worker-delivery.test.ts"],"db":[],"e2e":[],"scope":"—（単体で検証）","tasks":"7"},
  {"id":"FREQ-503-AC-04","statement":"保存済みの本文は送り直しでも書き換えられず、既存の注文へのリンクの一括作成と一斉再送が行われないこと","unit":["tests/unit/lib/orders/email/order-email-worker.test.ts","tests/unit/lib/orders/email/order-email-worker-delivery.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts"],"e2e":[],"scope":"—（DB 結合・単体で検証）","tasks":"1/7/11"},
  {"id":"FREQ-504-AC-01","statement":"案内から開いたお問い合わせに「ご注文について」と正しい注文番号が入力されること","unit":["tests/unit/features/contact/contact-prefill.test.ts","tests/unit/components/ContactPage.test.tsx","tests/unit/features/order-status/OrderStatusGuidance.test.tsx"],"db":[],"e2e":["e2e/FR-CONTACT-014-order-status-prefill.spec.ts"],"scope":"FR-CONTACT-014","tasks":"6/8"},
  {"id":"FREQ-504-AC-02","statement":"不正な種別・注文番号・同名の重複値は無視され、正しい方の項目だけが入力されること","unit":["tests/unit/features/contact/contact-prefill.test.ts","tests/unit/components/ContactPage.test.tsx"],"db":[],"e2e":["e2e/FR-CONTACT-014-order-status-prefill.spec.ts"],"scope":"FR-CONTACT-014","tasks":"8"},
  {"id":"FREQ-504-AC-03","statement":"自動入力の後も利用者が欄を編集でき、再描画で入力が元へ戻らず、その値で送信されること","unit":["tests/unit/components/ContactPage.test.tsx"],"db":[],"e2e":["e2e/FR-CONTACT-014-order-status-prefill.spec.ts"],"scope":"FR-CONTACT-014","tasks":"8"},
  {"id":"FREQ-504-AC-04","statement":"登録の入口がログインページの登録欄を開き、問い合わせのURLの値だけで注文の持ち主が決められないこと","unit":["tests/unit/features/order-status/OrderStatusGuidance.test.tsx","tests/unit/api/contact/route.test.ts"],"db":[],"e2e":["e2e/FR-ORDER-005-returns-guidance.spec.ts"],"scope":"FR-ORDER-005（登録入口だけ）","tasks":"6/8"},
  {"id":"FREQ-505-AC-01","statement":"新しい表の行ごとのアクセス制御と利用者の拒否が有効で、直接の書き込みが拒まれ、公開のDB関数はサーバー用権限だけで実行されること","unit":["tests/unit/lib/orders/status/status-store.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts","tests/integration/db/order_status_returns.integration.test.ts","tests/integration/db/order_status_postgrest.integration.test.ts"],"e2e":[],"scope":"—（DB 結合・単体で検証）","tasks":"1/2/4"},
  {"id":"FREQ-505-AC-02","statement":"公開の取得と型に個人情報のキーが無く、リンク値と電話がログ・監査・誤り・URLのクエリに出されず、異なる送信元の確認が拒まれること","unit":["tests/unit/lib/orders/customer-order-view.test.ts","tests/unit/lib/orders/status/status-store.test.ts","tests/unit/api/order-status/verify.test.ts","tests/unit/api/order-status/private.test.ts","tests/unit/middleware/proxy-origin.test.ts"],"db":["tests/integration/db/order_status_links.integration.test.ts","tests/integration/db/order_status_returns.integration.test.ts","tests/integration/db/order_status_postgrest.integration.test.ts"],"e2e":["e2e/FR-ORDER-001-public-view.spec.ts","e2e/FR-ORDER-007-not-found-security.spec.ts"],"scope":"FR-ORDER-001、FR-ORDER-007（HTTPと表示。ログは単体/静的）","tasks":"1/2/3/4/5/9"},
  {"id":"FREQ-505-AC-03","statement":"ページに検索を拒む指定があり、窓口が保存を許さず、追跡先へ元の住所が渡らないこと","unit":["tests/unit/components/OrderStatusPage.test.tsx","tests/unit/api/order-status/private.test.ts","tests/unit/api/order-status/verify.test.ts"],"db":[],"e2e":["e2e/FR-ORDER-007-not-found-security.spec.ts"],"scope":"FR-ORDER-007","tasks":"5/6/9"},
  {"id":"FREQ-505-AC-04","statement":"3つの画面幅（mobile 390px・tablet 768px・desktop 1280px）で公開と確認後の表示と案内が横にはみ出さないこと","unit":["tests/unit/features/order-status/OrderStatusPublic.test.tsx","tests/unit/features/order-status/OrderStatusAccess.test.tsx","tests/unit/features/order-status/OrderStatusGuidance.test.tsx"],"db":[],"e2e":["e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts","e2e/FR-CONTACT-014-order-status-prefill.spec.ts","e2e/FR-ORDER-001-public-view.spec.ts","e2e/FR-ORDER-002-verify-private.spec.ts","e2e/FR-ORDER-003-verify-limits.spec.ts","e2e/FR-ORDER-004-expiry.spec.ts","e2e/FR-ORDER-005-returns-guidance.spec.ts","e2e/FR-ORDER-006-email-link.spec.ts","e2e/FR-ORDER-007-not-found-security.spec.ts","e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts"],"scope":"新10spec全て","tasks":"6/8/9"}
];
const newSpecFiles = ["e2e/FR-ACCOUNT-044-order-status-member-access.spec.ts","e2e/FR-CONTACT-014-order-status-prefill.spec.ts","e2e/FR-ORDER-001-public-view.spec.ts","e2e/FR-ORDER-002-verify-private.spec.ts","e2e/FR-ORDER-003-verify-limits.spec.ts","e2e/FR-ORDER-004-expiry.spec.ts","e2e/FR-ORDER-005-returns-guidance.spec.ts","e2e/FR-ORDER-006-email-link.spec.ts","e2e/FR-ORDER-007-not-found-security.spec.ts","e2e/FR-ORDER-008-delivery-refund-visibility.spec.ts"];
const oldMigrationCount = 64;
const oldMigrationHash = 'c0d227f753dd831805c31cf57bd343cfff602d7e91b712576ebb3514feaf713d';

const walk = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? walk(dir + '/' + entry.name) : [dir + '/' + entry.name]);
const rows = () => read(requirementsFile).split(/\r?\n/)
  .filter((line) => /^\| FREQ-(?:49[89]|50[0-5]) \|/.test(line))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const acceptance = () => rows().flatMap((row) => row[5].split('<br>'));
const e5 = (file: string): string => {
  if (file === pageFile) return read(file);
  const section = /^## [^\r\n]*E-5[^\r\n]*\r?\n(?:(?!^## )[\s\S])*/m.exec(read(file))?.[0];
  if (!section) throw new Error('E-5 section missing: ' + file);
  return section;
};
const mustContain = (text: string, words: string[]) => words.forEach((word) =>
  expect({ word, present: text.includes(word) }).toEqual({ word, present: true }));
const linkedPaths = (file: string, text: string): string[] => [...text.matchAll(/\]\(([^)]+)\)/g)]
  .map((match) => decodeURIComponent(match[1].split('#')[0]))
  .filter((href) => href && !/^(https?:|mailto:)/.test(href))
  .map((href) => path.relative(root, path.resolve(root, path.dirname(file), href)).replace(/\\/g, '/'));
const contractFiles = [
  'docs/03_BasicDesign/api/api-spec.md', 'docs/03_BasicDesign/api/route-inventory.md',
  'docs/03_BasicDesign/data/er.md', 'docs/03_BasicDesign/ui/screen-list.md',
  'docs/03_BasicDesign/ui/screen-flow.md', pageFile, 'docs/04_DetailDesign/pages/09_contact.md',
  'docs/04_DetailDesign/pages/15_account.md', 'docs/04_DetailDesign/states/order-payment.md',
  'docs/04_DetailDesign/sequence/order-administration.md',
  'docs/06_Operations/order-email-operations.md', 'docs/06_Operations/webhook-queue-operations.md',
];

test('FREQ-498から505の8行と32ACが一意で指定の日本語を持つ', () => {
  const actual = rows();
  expect(actual.map((row) => row.slice(0, 4))).toEqual(expectedRequirements);
  expect(actual).toHaveLength(8);
  actual.forEach((row) => expect(row).toHaveLength(6));
  const ids = actual.flatMap((row) => row[4].match(/FREQ-\d+-AC-\d+/g) ?? []);
  expect(ids).toEqual(expectedAcMap.map((ac) => ac.id));
  expect(new Set(ids).size).toBe(32);
  const items = acceptance();
  expect(items).toHaveLength(32);
  items.forEach((item, i) => {
    const ac = expectedAcMap[i];
    const prefix = ac.e2e.length && ac.id !== 'FREQ-505-AC-04'
      ? '3つの画面幅（mobile 390px・tablet 768px・desktop 1280px）で、' : '';
    expect(item.startsWith('・' + ac.id + ': ' + prefix + ac.statement + '（E2E ')).toBe(true);
    expect(item).toContain('担当 Task ' + ac.tasks);
  });
});

test('ACごとのE2Eと単体DBの対応が指示書の定数と一致する', () => {
  const items = acceptance();
  expect(items).toHaveLength(32);
  items.forEach((item, i) => {
    const ac = expectedAcMap[i];
    const links = linkedPaths(requirementsFile, item);
    expect(links.filter((p) => p.startsWith('e2e/')).sort()).toEqual([...ac.e2e].sort());
    expect(links.filter((p) => p.startsWith('tests/unit/'))).toEqual(ac.unit);
    expect(links.filter((p) => p.startsWith('tests/integration/'))).toEqual(ac.db);
    if (!ac.e2e.length) {
      // 503-AC-03 だけは DB 結合の試験が無いので、指示書の表の「—（単体で検証）」を使う。ほかは一般の決まり。
      const noE2e = ac.id === 'FREQ-503-AC-03' ? 'E2E —（単体で検証）' : 'E2E —（DB 結合・単体で検証）';
      expect(item).toContain(noE2e);
      if (ac.id === 'FREQ-503-AC-03') expect(item).not.toContain('E2E —（DB 結合・単体で検証）');
    }
    if (ac.unit.length) expect(item).toContain('単体 [');
    if (ac.db.length) expect(item).toContain('DB 結合 [');
    for (const p of [...ac.unit, ...ac.db, ...ac.e2e]) expect(existsSync(path.join(root, p))).toBe(true);
    if (/FREQ-499-AC-0[13]|FREQ-500-AC-01|FREQ-503-AC-0[12]|FREQ-504-AC-04|FREQ-505-AC-02/.test(ac.id)) {
      expect(item).toContain('範囲: ' + ac.scope);
    }
    if (ac.id === 'FREQ-503-AC-04') expect(item).toContain('Task 11予行演習');
    // 証拠の範囲の注記: DB だけの比較が、制限そのものや全種類を確かめたと読めないようにする。
    if (ac.id === 'FREQ-500-AC-02') expect(item).toContain('order_status_links.integration.test.ts)（カウンター非更新）');
    if (ac.id === 'FREQ-503-AC-01') expect(item).toContain('order_status_links.integration.test.ts)（1注文1本）');
  });
});

test('新10specのACコメントは要求の対応と完全一致する', () => {
  const files = walk('e2e').filter((file) => /\/FR-(?:ORDER-00[1-8]|CONTACT-014|ACCOUNT-044)-.*\.spec\.ts$/.test(file)).sort();
  expect(files).toEqual(newSpecFiles);
  for (const file of files) {
    const comments = read(file).split(/\r?\n/).filter((line) => line.trim().startsWith('//'))
      .flatMap((line) => line.match(/FREQ-\d+-AC-\d+/g) ?? []);
    expect(comments.sort()).toEqual(expectedAcMap.filter((ac) => ac.e2e.includes(file)).map((ac) => ac.id).sort());
    expect(new Set(comments).size).toBe(comments.length);
  }
});

test('既存2本のE2EにあるE-5のACコメントは要求の対応と完全一致する', () => {
  // 503-AC-01 の FR-ADMIN-101 と 503-AC-02 の FR-CHECKOUT-049。E-4 までの AC コメントは別の試験が見るので E-5 の範囲だけ比べる。
  const existingSpecs = ['e2e/FR-ADMIN-101-fulfillment-delivered.spec.ts', 'e2e/FR-CHECKOUT-049-order-email-sent-once.spec.ts'];
  const referenced = [...new Set(expectedAcMap.flatMap((ac) => ac.e2e))].filter((file) => !newSpecFiles.includes(file)).sort();
  expect(referenced).toEqual(existingSpecs);
  for (const file of existingSpecs) {
    const comments = read(file).split(/\r?\n/).filter((line) => line.trim().startsWith('//'))
      .flatMap((line) => line.match(/FREQ-\d+-AC-\d+/g) ?? [])
      .filter((id) => /^FREQ-(49[89]|50[0-5])-/.test(id));
    const expected = expectedAcMap.filter((ac) => ac.e2e.includes(file)).map((ac) => ac.id);
    expect(expected).toHaveLength(1);
    expect(comments.sort()).toEqual(expected.sort());
    expect(new Set(comments).size).toBe(comments.length);
  }
});

test('新10本は3幅のループで30ケースを定義しskipやonlyを持たない', () => {
  const helper = read('e2e/order-status-test-utils.ts');
  const viewportBlock = /export const orderStatusViewports = \[([\s\S]*?)\] as const/.exec(helper)![1];
  const widths = [...viewportBlock.matchAll(/width: (\d+)/g)].map((match) => Number(match[1]));
  expect(widths).toEqual([390, 768, 1280]);
  let count = 0;
  for (const file of newSpecFiles) {
    const text = read(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const tests: ts.CallExpression[] = [];
    const loops: ts.ForOfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'test') tests.push(node);
      if (ts.isForOfStatement(node) && node.expression.getText(source) === 'orderStatusViewports') loops.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(tests).toHaveLength(1);
    expect(loops).toHaveLength(1);
    expect(tests[0].pos > loops[0].statement.pos && tests[0].end < loops[0].statement.end).toBe(true);
    expect(tests[0].arguments[0].getText(source).startsWith(tick + '$' + '{viewport.width}px ')).toBe(true);
    expect(text).toContain("from './order-status-test-utils'");
    expect(text).not.toMatch(/\b(?:test|describe)\.(?:skip|only|fixme|fail)\s*\(/);
    expect(text).toContain("test.use({ trace: 'off', video: 'off', screenshot: 'off' })");
    expect(text).toContain('expectNoHorizontalOverflow(page)');
    count += tests.length * widths.length;
  }
  expect(count).toBe(30);
});

test.each(contractFiles)('%s のE-5節に詳細設計と実装計画への実在リンクがある', (file) => {
  const text = e5(file);
  const links = linkedPaths(file, text);
  expect(links).toContain(specFile);
  expect(links).toContain(planFile);
  for (const target of links) expect({ target, exists: existsSync(path.join(root, target)) }).toEqual({ target, exists: true });
});

test('要求のリンクは実在しE2E無しを実行証拠へ変えない', () => {
  for (const target of linkedPaths(requirementsFile, rows().map((row) => row.join('|')).join('\n'))) {
    expect(existsSync(path.join(root, target))).toBe(true);
  }
  mustContain(e5(pageFile), ['静的試験', '実行', '証拠', '32 AC', '30ケース', 'Task 11']);
});

test('2つのAPIの全HTTPとnone/401/503の違いとX1を記録する', () => {
  const api = e5(contractFiles[0]);
  for (const [code, status] of [
    ['ORDER_STATUS_NOT_FOUND', 404], ['ORDER_STATUS_INPUT_INVALID', 400], ['ORDER_STATUS_MISMATCH', 400],
    ['ORDER_STATUS_LOCKED', 423], ['ORDER_STATUS_UNAVAILABLE', 409], ['ORDER_STATUS_EXPIRED', 410],
    ['ORDER_STATUS_RATE_LIMITED', 429], ['ORDER_STATUS_FORBIDDEN', 403],
    ['ORDER_STATUS_AUTH_REQUIRED', 401], ['ORDER_STATUS_TEMPORARILY_UNAVAILABLE', 503], ['ORDER_STATUS_FAILED', 500],
  ] as const) {
    const message = code === 'ORDER_STATUS_AUTH_REQUIRED' ? 'Unauthorized' : ORDER_STATUS_ERROR_MESSAGES[code];
    expect(api).toContain('| ' + tick + code + tick + ' | ' + status + ' | ' + message + ' |');
  }
  mustContain(api, [
    'POST /api/order-status/[token]/verify', 'GET /api/order-status/[token]/private',
    '200', "access:'none'", "access:'member'", "access:'verified'", 'X1', 'P8', 'P25',
    '401', '503', 'Retry-After:30', 'Forbidden origin', 'no-store', 'no-referrer', 'nodejs',
    '15分に5回', '10分に30回', '20回目', '400', '423', 'Origin → CSRF → IP',
    'UUID', '64', '4桁ちょうど', 'dataキー無し',
  ]);
});

test('API一覧の数と2つの追加行が実ソースと一致する', () => {
  const routes = walk('src/app/api').filter((file) => file.endsWith('/route.ts'));
  const methods = routes.flatMap((file) => [...read(file).matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]);
  expect(routes).toHaveLength(132); expect(methods).toHaveLength(171);
  const inventory = read(contractFiles[1]);
  const entries = inventory.split('\n').filter((line) => line.startsWith('| ' + tick + '/api/'));
  expect(entries).toHaveLength(131);
  expect(entries.flatMap((line) => line.split('|')[2].match(new RegExp(tick + '(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)' + tick, 'g')) ?? [])).toHaveLength(170);
  mustContain(read(contractFiles[0]), ['132ファイル', '171組', '131ファイル・170組', 'HEAD/OPTIONSは171組に含めない']);
  mustContain(inventory, ['132ファイル・171メソッド', '131行・170メソッド',
    '| ' + tick + '/api/order-status/[token]/private' + tick + ' | ' + tick + 'GET' + tick + ' |',
    '| ' + tick + '/api/order-status/[token]/verify' + tick + ' | ' + tick + 'POST' + tick + ' |']);
});

test('1表の列とFKと索引と権限と2移行をERへ記録する', () => {
  mustContain(e5(contractFiles[2]), [
    'private.order_status_links', 'order_id', 'token', 'verify_until', 'failed_attempts', 'created_at',
    'public.orders(id)', 'ON DELETE RESTRICT', 'order_status_links_token_key', 'order_status_links_token_check',
    'order_status_links_failed_attempts_check', 'order_status_links_deny_clients', 'RESTRICTIVE', 'service_role',
    'SELECT', 'SECURITY DEFINER', "search_path = ''", 'postgres', 'EXECUTE', '1注文1本',
    '20261022084844_order_status_links.sql', '20261022084944_order_status_returns.sql', 'erDiagram',
  ]);
});

test('公開と個人情報の分離とCookieと固定文と2段の図を頁に記録する', () => {
  const text = e5(pageFile);
  mustContain(text, [
    '## 概要', 'flowchart', 'Server Component', 'connection()', '公開APIは作らない',
    'shipping', 'contactEmail', 'paymentMethod', 'shipments', 'returns', 'accepted', 'partially_received',
    'sb-order-status', 'HMAC-SHA256', 'tokenHashPrefix', '24時間', '21日', 'httpOnly',
    'secure', "sameSite='strict'", 'path=/api/order-status/{token}', 'ORDER_STATUS_SESSION_SECRET', 'JWT_SECRET',
    "access:'none'", 'X1', 'P8', 'P25', 'readOnly', 'noindex', 'nofollow', 'noopener noreferrer',
    '/login?tab=register', '/contact?type=order&order={orderNumber}', '/account/orders/{id}',
    '確認中…', 'もう一度読み込む', 'retry', 'OrderStatusPublic', 'OrderStatusAccess',
  ]);
  Object.values(ORDER_STATUS_ERROR_MESSAGES).forEach((message) => expect(text).toContain(message));
});

test('画面と問い合わせと会員と状態とシーケンスをつなぐ', () => {
  mustContain(e5(contractFiles[3]), ['/order-status/[token]', '/login?tab=register', '/contact?type=order&order=', '/account/orders/']);
  mustContain(e5(contractFiles[4]), ['flowchart', '/order-status/', '/login?tab=register', '/contact?type=order', '/account/orders/']);
  mustContain(e5(contractFiles[6]), ['trim', '大文字', '^ORD-[0-9A-F]{8}$', 'P13', '設計書7章', '英数字8文字', 'product/order/other', '同名', '初回', '編集', '認可']);
  mustContain(e5(contractFiles[7]), ['buildCustomerOrderDetailView', 'OrderItemRow', 'OrderReturnsSection', 'readOnly', 'returnSection:null', '所有者', 'JSON']);
  mustContain(e5(contractFiles[8]), ['enum', '変更しない', "access:'none'", "access:'member'", "access:'verified'", 'payment_in_progress', 'abandoned', 'cancelled']);
  mustContain(e5(contractFiles[9]), ['sequenceDiagram', 'complete_order_email', 'ensure_order_status_link', 'verify_order_status_phone', '21日', 'GET', 'POST', '24時間']);
});

test('16種類と期限更新と旧本文と本番URLとログの運用を記録する', () => {
  const ops = e5(contractFiles[10]);
  const kinds = ['paid', 'awaiting_payment', 'payment_expired', 'canceled', 'shipped', 'refund',
    'return_accepted', 'return_received', 'return_sent_back', 'return_requested', 'return_declined',
    'cancel_request_received', 'cancel_request_declined', 'out_for_delivery', 'delivered', 'shipping_update'];
  kinds.forEach((kind) => expect(ops).toContain(tick + kind + tick));
  mustContain(ops, [
    '16種類', 'return_refund_pending_shop', 'return_request_shop', 'cancel_request_shop',
    'complete_order_email', 'sent_at', '21日', '24時間', '20回', 'GREATEST', '進んだ時だけ',
    'subject/body_text', '保存済み', '一括', '一斉再送', '件数', 'source_missing', 'db_unavailable',
    'NEXT_PUBLIC_SITE_URL', '本番', '必須', 'http://localhost:3000/order-status/…', '後から直らない',
    'アクセスログ', '解析', 'token付きpath', '記録しない', '秘密値', '今回取得',
    'ご注文の状況はこちら: {orderStatusUrl}', '電話', 'お店',
  ]);
  mustContain(e5(contractFiles[11]), [
    'A → B', 'ORDER_STATUS_CRYPTO_UNAVAILABLE', 'pgcrypto', 'extensions.gen_random_bytes',
    'Task 11', 'controller', '本番', 'アクセスログ', '解析', 'token付きpath', '記録しない',
    '件数', '本文', 'ORDER_STATUS_SESSION_SECRET', 'JWT_SECRET', 'NEXT_PUBLIC_SITE_URL',
  ]);
});

test('環境の追加は空値のサーバー専用鍵1つで重複しない', () => {
  const env = read('.env.example').replace(/\r\n/g, '\n');
  expect(env.split('\n').filter((line) => /^ORDER_STATUS_SESSION_SECRET=/.test(line))).toEqual(['ORDER_STATUS_SESSION_SECRET=']);
  expect(env).toContain('# 注文状況の確認印に使うサーバー専用の鍵。空なら JWT_SECRET を使う。\nORDER_STATUS_SESSION_SECRET=');
  expect(env).not.toContain('NEXT_PUBLIC_ORDER_STATUS_SESSION_SECRET');
});

test('過去の移行は固定した内容のまま新2本だけに完全修飾と権限とNOTIFYがある', () => {
  const dir = 'supabase/migrations';
  const old = readdirSync(path.join(root, dir)).filter((file) => file.endsWith('.sql') && file < '20261022084844_order_status_links.sql').sort();
  expect(old).toHaveLength(oldMigrationCount);
  const hash = createHash('sha256');
  old.forEach((file) => { hash.update(file); hash.update('\0'); hash.update(readFileSync(path.join(root, dir, file))); hash.update('\0'); });
  expect(hash.digest('hex')).toBe(oldMigrationHash);
  const migrations = ['20261022084844_order_status_links.sql', '20261022084944_order_status_returns.sql'];
  for (const migration of migrations) {
    const sql = read(dir + '/' + migration);
    mustContain(sql, ['BEGIN;', 'COMMIT;', "NOTIFY pgrst, 'reload schema';", 'public.orders', "SET search_path = ''",
      'OWNER TO postgres', 'FROM PUBLIC, anon, authenticated', 'TO service_role']);
    const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION ((?:public|private)\.\w+)\(([\s\S]*?)\nAS \$\$/g)];
    expect(functions.length).toBeGreaterThan(0);
    functions.forEach(([, name, header]) => {
      mustContain(header, ["SET search_path = ''", name.startsWith('public.') ? 'SECURITY DEFINER' : 'SECURITY INVOKER']);
      expect(sql).toContain('ALTER FUNCTION ' + name + '(');
      expect(sql).toContain('REVOKE ALL ON FUNCTION ' + name + '(');
    });
  }
  const a = read(dir + '/' + migrations[0]);
  mustContain(a, ['CREATE TABLE private.order_status_links', 'ENABLE ROW LEVEL SECURITY', 'AS RESTRICTIVE FOR ALL TO anon, authenticated',
    'GRANT SELECT ON TABLE private.order_status_links TO service_role', 'extensions.gen_random_bytes(32)',
    'public.get_order_status_public_material', 'public.complete_order_email']);
  mustContain(read(dir + '/' + migrations[1]), ['private.build_customer_order_returns', 'public.get_customer_order_returns', 'public.get_order_status_returns']);
});

test('E-5の追加部分は概要とH4までを守り絵文字と文字化けを持たない', () => {
  for (const file of [requirementsFile, ...contractFiles]) {
    // 既存の要求の旧行にある装飾はこのTaskで書き換えず、追加範囲だけを検査する。
    expect(read(file)).toMatch(/^## 概要/m);
    const text = file === requirementsFile ? rows().map((row) => row.join('|')).join('\n') : e5(file);
    expect(text).not.toMatch(/^#{5,}\s/m);
    expect(text).not.toContain('?'.repeat(3));
    expect(text).not.toContain('\uFFFD');
    expect(text).not.toMatch(/[\p{Extended_Pictographic}\uFE0F\u20E3]/u);
  }
});
