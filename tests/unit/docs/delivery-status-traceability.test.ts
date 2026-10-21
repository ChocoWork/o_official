/** @jest-environment node */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const contains = (text: string, expected: string) => expect({ expected, present: text.includes(expected) }).toEqual({ expected, present: true });
// H2 の E-4 節だけを返し、後続の H2 と従来本文を検査対象へ混ぜない。
const e4Section = (text: string): string => {
  const section = /^## [^\r\n]*E-4[^\r\n]*\r?\n(?:(?!^## )[\s\S])*/m.exec(text)?.[0];
  if (!section) throw new Error('E-4 section missing');
  return section;
};
const errorRows = (text: string) => text.split(/\r?\n/)
  .filter((line) => /^\| `[A-Z_]+` \|/.test(line))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const requirements = 'docs/02_Requirements/requirements.md';
const spec = 'docs/superpowers/specs/2026-10-21-delivery-status-design.md';
const plan = 'docs/superpowers/plans/2026-10-21-delivery-status.md';
const counts = [4, 3, 5, 4, 4, 4, 5, 5, 3, 3];
const expectedAcs = counts.flatMap((count, index) =>
  Array.from({ length: count }, (_, ac) => `FREQ-${488 + index}-AC-${String(ac + 1).padStart(2, '0')}`),
);
// 指示書の40 ACの割り当て。E2Eの無いACをE2Eの証拠に変えない。
const e2eByAc: string[][] = [
  ['ADMIN-100'], ['ADMIN-100'], ['ADMIN-100'], [],
  ['ADMIN-101'], ['ADMIN-101'], ['ADMIN-101'],
  ['ADMIN-102', 'ACCOUNT-041'], [], [], [], [],
  ['ADMIN-102'], ['ADMIN-102'], [], [],
  ['ADMIN-100', 'ADMIN-101', 'ADMIN-102'], ['ADMIN-102'], [], ['ADMIN-100'],
  ['ADMIN-100', 'ADMIN-101'], ['ADMIN-103'], ['ADMIN-103'], [],
  ['ACCOUNT-043'], ['ACCOUNT-041', 'ACCOUNT-042'], ['ACCOUNT-043'], ['ACCOUNT-041', 'ACCOUNT-042'], ['ACCOUNT-042'],
  ['ADMIN-104'], ['ADMIN-104'], ['ADMIN-104', 'ACCOUNT-043'], ['ADMIN-104'], ['ACCOUNT-043'],
  [], [], [], [], [], ['ACCOUNT-043'],
];
const files = [
  'docs/03_BasicDesign/api/api-spec.md', 'docs/03_BasicDesign/api/route-inventory.md',
  'docs/03_BasicDesign/data/er.md', 'docs/03_BasicDesign/ui/screen-list.md', 'docs/03_BasicDesign/ui/screen-flow.md',
  'docs/04_DetailDesign/pages/15_account.md', 'docs/04_DetailDesign/pages/16_admin.md', 'docs/04_DetailDesign/pages/17_privacy.md',
  'docs/04_DetailDesign/states/order-payment.md', 'docs/04_DetailDesign/sequence/order-administration.md',
  'docs/04_DetailDesign/sequence/stripe-webhooks.md', 'docs/04_DetailDesign/states/stripe-webhook-queue.md',
  'docs/06_Operations/order-email-operations.md', 'docs/06_Operations/webhook-queue-operations.md',
  'supabase/pending/README.md',
  'docs/superpowers/specs/2026-10-10-group-e-overview-design.md',
  'docs/superpowers/specs/2026-10-10-partial-fulfillment-design.md',
  'docs/superpowers/specs/2026-10-09-order-email-outbox-design.md',
  'docs/superpowers/specs/2026-10-12-returns-design.md',
];
const newPaths = [
  '/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking',
  '/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered',
  '/api/admin/order-attention/deliveries/[attentionId]/resolve', '/api/webhook/17track',
];
const walk = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const name = `${dir}/${entry.name}`;
  return entry.isDirectory() ? walk(name) : [name];
});
const rows = () => read(requirements).split(/\r?\n/).filter((line) => /^\| FREQ-49[0-7] \||^\| FREQ-48[89] \|/.test(line));

test('FREQ-488から497の10行と40ACが一意で試験の対応を持つ', () => {
  const actual = rows();
  expect(actual.map((line) => line.split('|')[1].trim())).toEqual(Array.from({ length: 10 }, (_, i) => `FREQ-${488 + i}`));
  const acIds = actual.flatMap((line) => line.split('|')[5].match(/FREQ-\d+-AC-\d+/g) ?? []);
  expect(acIds).toEqual(expectedAcs);
  expect(new Set(acIds).size).toBe(40);
  actual.forEach((line, index) => {
    expect(line.split('|')).toHaveLength(8);
    const columns = line.split('|').map((column) => column.trim());
    expect(columns[2]).toMatch(/を提供すること（グループ E-4）$/);
    expect(columns[3]).toBe(`FREQ-${488 + index}-REQ-01`);
    expect(columns[4]).not.toContain('実装:');
    columns[4].split('<br>').forEach((item) => expect(item).toMatch(/^・.+こと$/));
    const acceptance = line.split('|')[6].split('<br>').map((item) => item.trim());
    expect(acceptance).toHaveLength(counts[index]);
    acceptance.forEach((item) => {
      expect(item).toMatch(/^・FREQ-\d+-AC-\d+: .+こと（E2E /);
      expect(item).toMatch(/担当 Task [\d/]+/);
      expect(item).toMatch(/、(?:DB 結合|単体) /);
      const statement = item.split('こと（E2E ')[0].replace(/`[^`]+`/g, '');
      expect(statement).not.toMatch(/\b(?:ON|OFF|attention|lease|notify|confirmed|version)\b/);
      expect(item).toMatch(/\]\(\.\.\/\.\.\/tests\/(?:unit|integration)\/[^)]+\)/);
    });
  });
});

test('40ACごとのE2E対応が指示書と一致し空欄はDBと単体だけを指す', () => {
  const acceptance = rows().flatMap((line) => line.split('|')[6].split('<br>').map((item) => item.trim()));
  expect(acceptance).toHaveLength(40);
  acceptance.forEach((item, i) => {
    expect(item.startsWith(`・${expectedAcs[i]}: `)).toBe(true);
    expect([...item.matchAll(/\[FR-((?:ADMIN|ACCOUNT)-\d+)\]/g)].map((m) => m[1])).toEqual(e2eByAc[i]);
    if (!e2eByAc[i].length) contains(item, 'E2E —（DB 結合・単体で検証）');
    else contains(item, '3つの画面幅（mobile 390px・tablet 768px・desktop 1280px）で、');
    if (expectedAcs[i] === 'FREQ-491-AC-01') expect(item).toMatch(/\[FR-ADMIN-102\]\([^)]+\)（署名の401だけ）/);
    if (expectedAcs[i] === 'FREQ-495-AC-01') expect(item).toMatch(/\[FR-ADMIN-104\]\([^)]+\)（鍵が未設定の表示だけ）/);
  });
});

test('E2EのACコメントが要求表に存在し対応するspecだけを指す', () => {
  const known = new Set(rows().flatMap((line) => line.split('|')[5].match(/FREQ-\d+-AC-\d+/g) ?? []));
  const specs = walk('e2e').filter((file) => /FR-(ADMIN-10[0-4]|ACCOUNT-04[1-3])-.*\.spec\.ts$/.test(file));
  expect(specs).toHaveLength(8);
  const unknownComments: string[] = [];
  specs.forEach((file) => {
    const id = /FR-((?:ADMIN|ACCOUNT)-\d+)/.exec(file)![1];
    const comments = read(file).split('\n').filter((line) => line.trim().startsWith('//')).flatMap((line) => line.match(/FREQ-\d+-AC-\d+/g) ?? []);
    expect(comments.length).toBeGreaterThan(0);
    comments.forEach((ac) => {
      if (!known.has(ac) || !e2eByAc[expectedAcs.indexOf(ac)]?.includes(id)) unknownComments.push(`${file}: ${ac}`);
    });
    expectedAcs.forEach((ac, i) => { if (e2eByAc[i].includes(id)) expect(comments).toContain(ac); });
  });
  expect(unknownComments).toEqual([]);
});

test('指定文書がE-4の詳細と実装計画へ実在する相対リンクを持つ', () => {
  files.forEach((file) => {
    const text = read(file);
    contains(text, 'E-4');
    for (const target of [spec, plan]) {
      const relative = path.relative(path.dirname(file), target).replace(/\\/g, '/');
      contains(text, `](${relative})`);
    }
  });
});

test('要求と追加節の相対リンクが実在する', () => {
  for (const file of [requirements, ...files]) {
    const text = file === requirements ? rows().join('\n') : e4Section(read(file));
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1].split('#')[0];
      if (!href || /^(https?:|mailto:)/.test(href)) continue;
      expect({ file, href, exists: existsSync(path.resolve(root, path.dirname(file), decodeURIComponent(href))) }).toEqual({ file, href, exists: true });
    }
  }
});

test('3管理POSTと1webhookをAPIと入口一覧に記録し総数が実コードと一致する', () => {
  const api = read(files[0]); const inventory = read(files[1]);
  newPaths.forEach((route) => {
    contains(api, `\`${route}\``);
    contains(inventory, `| \`${route}\` | \`POST\` |`);
  });
  const routes = walk('src/app/api').filter((file) => file.endsWith('/route.ts'));
  const methods = routes.flatMap((file) => [...read(file).matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]);
  expect(routes).toHaveLength(128); expect(methods).toHaveLength(167);
  contains(api, '128ファイル'); contains(api, '167組');
  contains(api, 'HEAD/OPTIONSは167組に含めない');
  for (const file of files.slice(0, 3)) contains(read(file), '配送の入口・表は E-4 の変更を 2026-10-21 に反映');
  contains(inventory, '128ファイル・167メソッド');
  const entries = inventory.split('\n').filter((line) => /^\| `\/api\//.test(line));
  expect(entries).toHaveLength(127);
  expect(entries.flatMap((line) => line.split('|')[2].match(/`(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)`/g) ?? [])).toHaveLength(166);
});

test('APIに設定と顧客の条件と全エラーを反映する', () => {
  const api = e4Section(read(files[0]));
  ['deliveryTracking', 'keyConfigured', 'backfillCount', 'backfilledCount', 'everRegistered', 'admin.orders.manage', 'CSRF', '30回/600秒'].forEach((word) => contains(api, word));
  const errors = [...read('src/lib/orders/tracking/delivery-messages.ts').matchAll(/^  ([A-Z_]+): \{ status: (\d+), message: '([^']+)'/gm)];
  expect(errors).toHaveLength(10);
  errors.forEach(([, code, status, message]) => expect(errorRows(api)).toContainEqual([`\`${code}\``, status, message]));
});

test('ERに全新表の列と索引と3移行と17列claimを記録する', () => {
  const er = e4Section(read(files[2]));
  const migration = read('supabase/migrations/20261022100000_delivery_tracking_records.sql');
  for (const table of ['order_fulfillment_events', 'order_fulfillment_tracking_changes', 'order_fulfillment_attention', 'fulfillment_tracking_registrations', 'delivery_tracking_provider_gate']) {
    contains(er, table);
    const body = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?(?:public|private)\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(migration)![1];
    for (const [, column] of body.matchAll(/^\s{2,}([a-z_]+)\s+(?:uuid|integer|bigint|text|boolean|timestamptz)\b/gm)) contains(er, `\`${column}\``);
  }
  for (const [, index] of migration.matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/g)) contains(er, index);
  ['20261022100000_delivery_tracking_records.sql', '20261022100100_delivery_tracking_admin.sql', '20261022100200_delivery_tracking_sync.sql', '17列', 'lease_token', 'service_role', 'SELECT', 'RESTRICTIVE', '注文 → 発送'].forEach((word) => contains(er, word));
});

test('19メールと新3種類の再送不可と数量と旧版skipを運用へ記録する', () => {
  const ops = e4Section(read('docs/06_Operations/order-email-operations.md'));
  const source = read('src/lib/orders/email/order-email-types.ts').split('export const ORDER_EMAIL_KINDS = [')[1].split('] as const')[0];
  const kinds = [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(kinds).toHaveLength(19);
  kinds.forEach((kind) => contains(ops, `\`${kind}\``));
  ['19種類', 'out_for_delivery', 'delivered', 'shipping_update', '再送不可', '旧版', ' x{数}', 'window_days', '無制限', 'SHOP_ALERT_EMAIL'].forEach((word) => contains(ops, word));
});

test('環境の2名は重複せず空値で既定URLは注記だけに置く', () => {
  const env = read('.env.example');
  const names = ['TRACKING_17TRACK_API_KEY', 'TRACKING_17TRACK_BASE_URL'];
  const lines = env.split(/\r?\n/).filter((line) => /^TRACKING_17TRACK_/.test(line));
  expect(lines).toEqual(names.map((name) => `${name}=`));
  contains(env, '空なら 17TRACK の本番の住所（https://api.17track.net/track/v2.4）');
  contains(env, '手元の試しでは作り物の住所を E2E が入れる');
});

test('手元fakeの寿命とE2Eの見張りを運用に記録する', () => {
  const ops = e4Section(read('docs/06_Operations/webhook-queue-operations.md'));
  ['TRACKING_17TRACK_BASE_URL', '127.0.0.1:4017', '/__health', 'build', 'E2E_STRICT=1', '3000', '自動', '手で止める', 'delivery_tracking', '8秒', '3秒'].forEach((word) => contains(ops, word));
});

test('開店前の9手順と責任と実未検証の境界を運用に残す', () => {
  const ops = e4Section(read('docs/06_Operations/webhook-queue-operations.md'));
  ['口座', '受け口', '無料の200件', 'gettrackinfo', '401', 'retrack', '年払い', '運営会社', '佐川', 'ユーザー', 'controller', '値を受け取らず', '新しいcron登録は不要'].forEach((word) => contains(ops, word));
});

test('2モードの表示と設定保存と数量の最終決定を記録する', () => {
  const account = e4Section(read('docs/04_DetailDesign/pages/15_account.md'));
  const admin = e4Section(read('docs/04_DetailDesign/pages/16_admin.md'));
  ['everRegistered', 'registered', 'stopped', 'deliveredAt', 'キー', '追跡オフ', '追跡オン'].forEach((word) => contains(account, word));
  ['counts.deliveries', '保存の直前', '登録待ち', '追跡中', '対応済みにする', 'もう一度確かめる'].forEach((word) => contains(admin, word));
  const privacy = e4Section(read('docs/04_DetailDesign/pages/17_privacy.md'));
  contains(privacy, '配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）');
});

test('C-2に実装後の3つの追加型を1行ずつ記録する', () => {
  const c2 = read(plan).split('### C-2 TS の部品')[1].split('### C-3')[0];
  ['OrderHistoryResponse.deliveryTrackingEnabled?: boolean', 'DeliveryDialogProps.onUncertain?: () => void', 'DeliveryRegistration.everRegistered: boolean'].forEach((signature) => contains(c2, signature));
});

test('従来本文や後続節の言葉と別行のHTTPではE-4の不足を補えない', () => {
  for (const file of files) {
    const text = read(file);
    const section = e4Section(text);
    const legacy = text.slice(0, text.indexOf(section));
    expect(() => e4Section(legacy)).toThrow('E-4 section missing');
  }
  // E-4 からだけ語を消し、節外に同語が残っても検出する。build は節外へ置いた文字列で確認。
  for (const [file, word] of [[files[0], 'CSRF'], [files[0], 'admin.orders.manage'],
    ['docs/06_Operations/webhook-queue-operations.md', 'build'],
    ['docs/06_Operations/webhook-queue-operations.md', '3000'],
    ['docs/06_Operations/webhook-queue-operations.md', '自動'],
    ['docs/06_Operations/webhook-queue-operations.md', 'ユーザー']]) {
    const text = read(file);
    const section = e4Section(text);
    const legacy = text.slice(0, text.indexOf(section));
    const missing = `${legacy}\n${word}\n${section.split(word).join('')}`;
    contains(missing, word);
    expect(e4Section(missing)).not.toContain(word);
    expect(() => contains(e4Section(missing), word)).toThrow();
    const later = `${missing}\n## 後続の節\n${word}\n`;
    expect(e4Section(later)).not.toContain(word);
  }
  const api = e4Section(read(files[0]));
  const row = ['`ORDER_NOT_FOUND`', '404', '注文が見つかりません。'];
  expect(errorRows(api)).toContainEqual(row);
  const wrongHttp = api.replace('| `ORDER_NOT_FOUND` | 404 |', '| `ORDER_NOT_FOUND` | 400 |');
  contains(wrongHttp, '404'); // 別のエラーには 404 が残る。
  expect(errorRows(wrongHttp)).not.toContainEqual(row);
  const wrongMessage = api.replace('| `ORDER_NOT_FOUND` | 404 | 注文が見つかりません。 |',
    '| `ORDER_NOT_FOUND` | 404 | 別の文言 |\n注文が見つかりません。');
  expect(errorRows(wrongMessage)).not.toContainEqual(row);
});
