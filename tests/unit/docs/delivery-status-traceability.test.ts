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

test('FREQ-496-AC-03は接続先が空の時の準備とその後の拒否を区別する', () => {
  const acceptance = rows().flatMap((line) => line.split('|')[6].split('<br>'))
    .find((item) => item.includes('FREQ-496-AC-03:'))!;
  expect(acceptance).toMatch(/空または省略[\s\S]*準備の段階で作り物の住所を入れ[\s\S]*その後の確かめ[\s\S]*省略と本番の接続先を拒否/);
});

test('E-4の担当Taskの全角括弧の前に余分な半角空白を置かない', () => {
  rows().forEach((line) => expect(line).not.toMatch(/担当 Task[^<]*\d （/));
});

test('17TRACKの知らせの図は合う行がある時だけafterで起動する', () => {
  const sequence = e4Section(read('docs/04_DetailDesign/sequence/stripe-webhooks.md'));
  expect(sequence).toMatch(/opt 合図した行が1件以上ある\s+Route--\)Worker: after\(\) で起動/);
  contains(sequence, '知らせの中身が0件なら合図を書かない');
});

test('配送追跡はStripe受け口のafterからも借りの印とprovider枠で動くと記録する', () => {
  const ops = e4Section(read('docs/06_Operations/webhook-queue-operations.md'));
  expect(ops).toMatch(/Stripeの受け口のafter\(\)[^\n]*runWebhookWorker[^\n]*借りの印[^\n]*providerの枠/);
});

test('E2EのACコメントが要求表に存在し対応するspecだけを指す', () => {
  const known = new Set(rows().flatMap((line) => line.split('|')[5].match(/FREQ-\d+-AC-\d+/g) ?? []));
  const specs = walk('e2e').filter((file) => /FR-(ADMIN-10[0-4]|ACCOUNT-04[1-3])-.*\.spec\.ts$/.test(file));
  expect(specs).toHaveLength(8);
  const unknownComments: string[] = [];
  specs.forEach((file) => {
    const id = /FR-((?:ADMIN|ACCOUNT)-\d+)/.exec(file)![1];
    // E-4 の範囲（FREQ-488〜497）だけを見る。あとのグループが同じ spec に足した AC は、そのグループの静的試験が見る。
    const comments = read(file).split('\n').filter((line) => line.trim().startsWith('//')).flatMap((line) => line.match(/FREQ-\d+-AC-\d+/g) ?? [])
      .filter((ac) => /^FREQ-(48[89]|49[0-7])-/.test(ac));
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
  expect(routes).toHaveLength(156); expect(methods).toHaveLength(199);
  contains(api, '156ファイル'); contains(api, '199組');
  contains(api, 'HEAD/OPTIONSは199組に含めない');
  for (const file of files.slice(0, 3)) contains(read(file), '配送の入口・表は E-4 の変更を 2026-10-21 に反映');
  contains(inventory, '156ファイル・199メソッド');
  const entries = inventory.split('\n').filter((line) => /^\| `\/api\//.test(line));
  expect(entries).toHaveLength(155);
  expect(entries.flatMap((line) => line.split('|')[2].match(/`(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)`/g) ?? [])).toHaveLength(198);
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
  const migration = read('supabase/migrations/20261021220816_delivery_tracking_records.sql');
  for (const table of ['order_fulfillment_events', 'order_fulfillment_tracking_changes', 'order_fulfillment_attention', 'fulfillment_tracking_registrations', 'delivery_tracking_provider_gate']) {
    contains(er, table);
    const body = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?(?:public|private)\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(migration)![1];
    for (const [, column] of body.matchAll(/^\s{2,}([a-z_]+)\s+(?:uuid|integer|bigint|text|boolean|timestamptz)\b/gm)) contains(er, `\`${column}\``);
  }
  for (const [, index] of migration.matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+)/g)) contains(er, index);
  ['20261021220816_delivery_tracking_records.sql', '20261021221140_delivery_tracking_admin.sql', '20261021221410_delivery_tracking_sync.sql', '17列', 'lease_token', 'service_role', 'SELECT', 'RESTRICTIVE', '注文 → 発送'].forEach((word) => contains(er, word));
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

// G-1 Task 14 で止めた旧の発送・発送取消・伝票番号の訂正・手動の配達済み・仕上がりの手動記録と取消の注記と現在の410。
// G-3 で発送系の5メソッドは発送票へ移行した（旧入口は410のまま）。仕上がりの2メソッドは終了のままで G-1停止 の注記を保つ
const G3_MOVE = 'G-3移行: 旧発送・発送取消・伝票訂正・手動配達済みはG-3の発送票へ移行しました。旧入口は認可後410を返します。以下のE-4記述は移行前の契約として保持します。';
const stoppedRoutes = [
  ['GET', '/api/admin/orders/[id]/fulfillments', 'LEGACY_FULFILLMENT_DISABLED', 'G-3移行'],
  ['POST', '/api/admin/orders/[id]/fulfillments', 'LEGACY_FULFILLMENT_DISABLED', 'G-3移行'],
  ['POST', '/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel', 'LEGACY_FULFILLMENT_DISABLED', 'G-3移行'],
  ['POST', '/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking', 'LEGACY_FULFILLMENT_DISABLED', 'G-3移行'],
  ['POST', '/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered', 'LEGACY_FULFILLMENT_DISABLED', 'G-3移行'],
  ['POST', '/api/admin/orders/[id]/completions', 'MANUAL_COMPLETION_DISABLED', 'G-1停止'],
  ['POST', '/api/admin/orders/[id]/completions/[completionId]/cancel', 'MANUAL_COMPLETION_DISABLED', 'G-1停止'],
] as const;

test('G-3の移行注記をE-4節と停止した入口の隣に置き、現在の410と固定の文を併記する', () => {
  const api = read(files[0]); const inventory = read(files[1]); const admin = read('docs/04_DetailDesign/pages/16_admin.md');
  for (const text of [e4Section(api), e4Section(inventory), e4Section(admin)]) contains(text, G3_MOVE);
  const source = read('src/lib/orders/fulfillment/legacy-fulfillment-disabled.ts');
  const legacyText = /LEGACY_FULFILLMENT_DISABLED_TEXT = '([^']+)'/.exec(source)![1];
  const manualText = /MANUAL_COMPLETION_DISABLED_TEXT = '([^']+)'/.exec(source)![1];
  contains(api, legacyText); contains(api, manualText);
  // 7メソッドの行は行頭の path/method を保ったまま、同じ行に移行（仕上がりは停止）と410と固定の記号を持つ
  for (const [method, route, code, marker] of stoppedRoutes) {
    const apiRow = api.split(/\r?\n/).find((line) => line.startsWith(`| \`${method} ${route}\` |`) || line.startsWith(`| ${method} \`${route}\` |`));
    expect({ route, method, apiRow: apiRow !== undefined }).toEqual({ route, method, apiRow: true });
    [marker, '410', code].forEach((word) => expect({ route, word, present: apiRow!.includes(word) }).toEqual({ route, word, present: true }));
    const inventoryRow = inventory.split(/\r?\n/).find((line) => line.startsWith(`| \`${route}\` |`))!;
    [marker, '410', code].forEach((word) => expect({ route, word, present: inventoryRow.includes(word) }).toEqual({ route, word, present: true }));
  }
  contains(inventory, '6パス・7メソッド');
});

test('G-1の要求8行（FREQ-520〜524・535・540・541）とFREQ-401の在庫復元の文を持つ', () => {
  const lines = read(requirements).split(/\r?\n/);
  const ids = lines.filter((line) => /^\| FREQ-(52[0-4]|535|54[01]) \|/.test(line)).map((line) => line.split('|')[1].trim());
  expect(ids).toEqual(['FREQ-520', 'FREQ-521', 'FREQ-522', 'FREQ-523', 'FREQ-524', 'FREQ-535', 'FREQ-540', 'FREQ-541']);
  const freq540 = lines.find((line) => line.startsWith('| FREQ-540 |'))!;
  // G-1/G-2を保ち、G-3 Task 1のAC-12とTask 2の読取部分AC-10、Task 4の書き手の部分AC-11を追跡する。
  const G2_FREQ_540_ADDITIONS = ['FREQ-540-AC-06', 'FREQ-540-AC-07', 'FREQ-540-AC-08', 'FREQ-540-AC-09'];
  const freq540Acs = freq540.split('|')[5].match(/FREQ-540-AC-\d+/g);
  expect(freq540Acs!.slice(0, 5)).toEqual(['FREQ-540-AC-01', 'FREQ-540-AC-02', 'FREQ-540-AC-03', 'FREQ-540-AC-04', 'FREQ-540-AC-05']);
  expect(freq540Acs!.slice(5)).toEqual([...G2_FREQ_540_ADDITIONS, 'FREQ-540-AC-10', 'FREQ-540-AC-11', 'FREQ-540-AC-12']);
  const freq533 = lines.find((line) => line.startsWith('| FREQ-533 |'))!;
  expect(freq533.split('|')[5].match(/FREQ-533-AC-\d+/g)).toEqual(['FREQ-533-AC-01', 'FREQ-533-AC-02', 'FREQ-533-AC-03', 'FREQ-533-AC-04', 'FREQ-533-AC-05']);
  contains(freq533, 'consume の裏付けの守りだけ');
  contains(freq533, '手元在庫の1回減と取消での1回戻り（空き在庫は不変）');
  contains(freq533, 'Task 1 は理由 CHECK の2値だけ');
  contains(freq533, 'shipment_confirm');
  contains(freq533, 'shipment_cancel');
  contains(freq533, 'tests/integration/db/group_g3_model.integration.test.ts');
  contains(lines.find((line) => line.startsWith('| FREQ-524 |'))!, 'MANUAL_COMPLETION_DISABLED');
  contains(lines.find((line) => line.startsWith('| FREQ-524 |'))!, 'LEGACY_FULFILLMENT_DISABLED');
  const freq401 = lines.find((line) => line.startsWith('| FREQ-401 |'))!;
  contains(freq401, '在庫復元は商品行を KEY SHARE だけで取り、通常の編集（NO KEY UPDATE）を待たない。削除だけは待たせる');
});

test('G-3 Task 2の荷作り表・同梱・会計入力のDB部分と未確認境界を正本で追跡する', () => {
  const lines = read(requirements).split(/\r?\n/);
  for (const [id, acs] of [['FREQ-531', ['01', '02', '03', '04']], ['FREQ-532', ['01', '02', '03', '04', '05']]] as const) {
    const row = lines.find((line) => line.startsWith(`| ${id} |`));
    expect(row).toBeDefined();
    expect(row!.split('|')[5].match(new RegExp(`${id}-AC-\\d+`, 'g'))).toEqual(acs.map((ac) => `${id}-AC-${ac}`));
    contains(row!, 'tests/integration/db/group_g3_reads.integration.test.ts');
    contains(row!, 'DB');
  }
  const accounting = lines.find((line) => line.startsWith('| FREQ-535 |'))!;
  expect(accounting.split('|')[5].match(/FREQ-535-AC-\d+/g)).toEqual(['FREQ-535-AC-01', 'FREQ-535-AC-02', 'FREQ-535-AC-03', 'FREQ-535-AC-04', 'FREQ-535-AC-05']);
  contains(accounting, 'actor');
  contains(accounting, 'list_shipment_accounting_inputs');
});

test('G-3 Task 2 Fix round 1は会計入力の打切りとTask 8の追記を記録する', () => {
  for (const file of ['docs/03_BasicDesign/data/er.md', 'docs/06_Operations/db-migrations.md']) {
    const text = read(file);
    contains(text, 'rows = _limit');
    contains(text, 'より多い行がある可能性');
  }
  const migrationRow = read('docs/06_Operations/db-migrations.md').split(/\r?\n/)
    .find((line) => line.startsWith('| 2 | `20261025070821_group_g3_shipping_reads.sql`'))!;
  contains(migrationRow, '追跡の読取側の置換');
  contains(migrationRow, 'Task 8');
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

test('G-3 Task 4の発送票の下書き（作成・入替・破棄）と書き手67本を正本で追跡する', () => {
  const lines = read(requirements).split(/\r?\n/);
  const rowOf = (id: string) => lines.find((line) => line.startsWith(`| ${id} |`))!;
  const draftSuite = 'tests/integration/db/group_g3_draft.integration.test.ts';
  const freq531 = rowOf('FREQ-531');
  for (const word of [draftSuite, 'tests/unit/api/admin/shipment-slip-draft-route.test.ts', 'tests/unit/components/ShipmentSlipSection.test.tsx',
    'tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts', 'POST /api/admin/shipment-slips', '発送票を作る権限がありません。']) contains(freq531, word);
  contains(rowOf('FREQ-532'), draftSuite);
  contains(rowOf('FREQ-533'), 'FREQ-533-AC-01（下書きの部分。G-3 Task 4）');
  contains(rowOf('FREQ-533'), 'FREQ-533-AC-03（下書きの部分。G-3 Task 4）');
  const freq540 = rowOf('FREQ-540');
  contains(freq540, 'FREQ-540-AC-11（G-3 Task 4）');
  contains(freq540, 'Task 4 で67本');
  contains(freq540, 'tests/integration/db/helpers/group-g-allowlist.ts');
  // 新しい試験・共有の道具は、要求表が指す先として実在する
  for (const file of [draftSuite, 'tests/integration/db/helpers/group-g-allowlist.ts', 'tests/unit/api/admin/shipment-slip-draft-route.test.ts',
    'tests/unit/components/ShipmentSlipSection.test.tsx', 'tests/unit/lib/orders/shipment-slips/shipment-slip-client.test.ts']) {
    expect({ file, exists: existsSync(path.resolve(root, file)) }).toEqual({ file, exists: true });
  }
  // 順序図と状態遷移図は、それぞれの README の索引から辿れる
  for (const file of ['docs/04_DetailDesign/sequence/shipping.md', 'docs/04_DetailDesign/states/shipping.md']) {
    expect({ file, exists: existsSync(path.resolve(root, file)) }).toEqual({ file, exists: true });
  }
  contains(read('docs/04_DetailDesign/sequence/README.md'), '(shipping.md)');
  contains(read('docs/04_DetailDesign/states/README.md'), '(shipping.md)');
});
test('G-3 Task 5の確定・番号なしメール・出荷日と書き手70本を正本で追跡する', () => {
  const rows = read(requirements).split(/\r?\n/);
  const row = (id: string) => rows.find((line) => line.startsWith(`| ${id} |`))!;
  contains(row('FREQ-533'), 'FREQ-533-AC-05');
  contains(row('FREQ-533'), 'tests/integration/db/group_g3_confirm.integration.test.ts');
  contains(row('FREQ-533'), 'tests/unit/lib/orders/email/order-email-compose-shipped.test.ts');
  contains(row('FREQ-535'), '初回入金日時の記録は G-1、出荷日の初期値と範囲の検証は G-3');
  contains(row('FREQ-540'), 'consume・register・confirmを足した70本');
  contains(read(files[0]), 'POST /api/admin/shipment-slips/[id]/confirm');
});
test('G-3 Task 6の発送の取消（票全体・戻しは1回）と書き手72本を正本で追跡する', () => {
  const rows = read(requirements).split(/\r?\n/);
  const row = (id: string) => rows.find((line) => line.startsWith(`| ${id} |`))!;
  const cancelSuite = 'tests/integration/db/group_g3_cancel.integration.test.ts';
  const freq533 = row('FREQ-533');
  for (const word of ['Task 6 の AC-04', cancelSuite, 'tests/unit/api/admin/shipment-slip-cancel-route.test.ts',
    'tests/unit/components/ShipmentSlipCancelDialog.test.tsx', 'CANCEL_NOT_ALLOWED → HAS_RETURN → REFUNDED', 'reverses_event_id の一意']) contains(freq533, word);
  // FREQ-534 は新規の行で、この Task が証明する AC-03 だけを持つ（残りの AC は後続Task）
  const freq534 = row('FREQ-534');
  expect(freq534.split('|')[5].match(/FREQ-534-AC-\d+/g)).toEqual(['FREQ-534-AC-01', 'FREQ-534-AC-02', 'FREQ-534-AC-03', 'FREQ-534-AC-04', 'FREQ-534-AC-05']);
  for (const word of [cancelSuite, '発送の取消は票全体で、返品・発送後返金のある注文が1つでもあれば全体を拒否する', 'skipped', 'provider_stop_pending']) contains(freq534, word);
  contains(row('FREQ-540'), 'restore・cancelを足した72本');
  contains(row('FREQ-540'), 'consume・register・confirmを足した70本');
  contains(read(files[0]), 'POST /api/admin/shipment-slips/[id]/cancel');
  for (const file of [cancelSuite, 'tests/unit/api/admin/shipment-slip-cancel-route.test.ts', 'tests/unit/components/ShipmentSlipCancelDialog.test.tsx',
    'src/components/ShipmentSlipCancelDialog.tsx', 'src/app/api/admin/shipment-slips/[id]/cancel/route.ts']) {
    expect({ file, exists: existsSync(path.resolve(root, file)) }).toEqual({ file, exists: true });
  }
  for (const doc of ['docs/04_DetailDesign/sequence/shipping.md', 'docs/04_DetailDesign/states/shipping.md']) {
    contains(read(doc), '発送の取消（G-3 Task 6）');
  }
});
test('G-3 Task 7の伝票番号の後入力・訂正と手動の配達済み（票単位）と書き手74本を正本で追跡する', () => {
  const rows = read(requirements).split(/\r?\n/);
  const row = (id: string) => rows.find((line) => line.startsWith(`| ${id} |`))!;
  const trackingSuite = 'tests/integration/db/group_g3_tracking.integration.test.ts';
  const freq534 = row('FREQ-534');
  for (const word of ['FREQ-534-AC-01（伝票番号の後入力・訂正。G-3 Task 7）', 'FREQ-534-AC-02（手動の配達済み。G-3 Task 7）',
    'FREQ-534-AC-05（旧4RPCの停止と迂回経路0。G-3 Task 7）', trackingSuite, 'tests/unit/api/admin/shipment-slip-tracking-route.test.ts',
    'tests/unit/api/admin/shipment-slip-delivered-route.test.ts', 'tests/unit/components/ShipmentSlipTrackingDialog.test.tsx',
    'tests/unit/components/ShipmentSlipDeliveredDialog.test.tsx', 'GROUP_G_SLIP_TRACKING_INCOMPLETE', 'GROUP_G_SLIP_TRACKING_UNCHANGED',
    'GROUP_G_SLIP_ALREADY_DELIVERED', 'GROUP_G_SLIP_DELIVERY_DATE_INVALID', 'LEGACY_FULFILLMENT_DISABLED']) contains(freq534, word);
  contains(row('FREQ-535'), 'FREQ-535-AC-04（一部。G-3 Task 7）');
  contains(row('FREQ-540'), '伝票番号・配達済みを足した74本');
  contains(row('FREQ-540'), 'restore・cancelを足した72本');
  const api = read(files[0]);
  contains(api, 'POST /api/admin/shipment-slips/[id]/tracking');
  contains(api, 'POST /api/admin/shipment-slips/[id]/delivered');
  for (const file of [trackingSuite, 'tests/unit/api/admin/shipment-slip-tracking-route.test.ts', 'tests/unit/api/admin/shipment-slip-delivered-route.test.ts',
    'tests/unit/components/ShipmentSlipTrackingDialog.test.tsx', 'tests/unit/components/ShipmentSlipDeliveredDialog.test.tsx',
    'src/components/ShipmentSlipTrackingDialog.tsx', 'src/components/ShipmentSlipDeliveredDialog.tsx',
    'src/app/api/admin/shipment-slips/[id]/tracking/route.ts', 'src/app/api/admin/shipment-slips/[id]/delivered/route.ts',
    'supabase/migrations/20261025134538_group_g3_shipping_actions.sql']) {
    expect({ file, exists: existsSync(path.resolve(root, file)) }).toEqual({ file, exists: true });
  }
  for (const doc of ['docs/04_DetailDesign/sequence/shipping.md', 'docs/04_DetailDesign/states/shipping.md']) {
    contains(read(doc), '伝票番号の後入力・訂正と手動の配達済み（G-3 Task 7）');
  }
  contains(read('docs/04_DetailDesign/pages/16_admin.md'), '伝票番号は入れた後は訂正できるが、空には戻せない');
  contains(read('docs/04_DetailDesign/pages/16_admin.md'), '追跡の登録の要約（`registration`');
  contains(read('docs/06_Operations/order-email-operations.md'), 'previousTrackingNumber');
});

test('FREQ-535-AC-03: G-3 Task 9の訂正・権限・日付隔離を正本で追跡する', () => {
  const freq535 = read(requirements).split(/\r?\n/).find((line) => line.startsWith('| FREQ-535 |'))!;
  for (const word of ['FREQ-535-AC-03', 'group_g3_date.integration.test.ts', 'shipment-date-isolation.test.ts', 'revision_id', '配達日JST', 'shipped_at']) contains(freq535, word);
  contains(read(files[0]), 'POST /api/admin/shipment-slips/[id]/shipment-date');
  for (const doc of ['docs/04_DetailDesign/pages/16_admin.md', 'docs/04_DetailDesign/sequence/shipping.md', 'docs/04_DetailDesign/states/shipping.md']) contains(read(doc), '出荷日の訂正（G-3 Task 9）');
});

test('FREQ-535-AC-03: Task 8の移行の履歴をTask 9のサイズで上書きしない', () => {
  const migration = read('docs/06_Operations/db-migrations.md').split(/\r?\n/).find((line) => line.startsWith('| 4 |') && line.includes('20261025134538_group_g3_shipping_actions.sql'))!;
  const task8 = migration.slice(migration.indexOf('Task 8'), migration.indexOf('Task 9'));
  contains(task8, '72,255 bytes / `4C2AA20FBDAF43F3E4CC08B5AFA5E5CC`');
});
