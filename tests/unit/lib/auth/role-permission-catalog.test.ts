import fs from 'node:fs';
import path from 'node:path';
import { FIXED_PERMISSION_CODES, ROLE_PERMISSION_CATALOG, getMissingPermissionDependencies } from '@/lib/auth/role-permission-catalog';

const h1Sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261029130000_group_h_discounts_foundation.sql'), 'utf8');

test('FREQ-542-AC-01: H1の旧表triggerは関係列とH保存注文だけを検査し読取はINVOKERを保つ', () => {
  expect(/h1_order_items_sum AFTER UPDATE OF order_id,quantity,line_total,line_kind ON public\.order_items[\s\S]*?WHEN \(private\.group_h_order_has_units\(OLD\.order_id\) OR private\.group_h_order_has_units\(NEW\.order_id\)\)/.test(h1Sql)).toBe(true);
  const reader = h1Sql.match(/CREATE OR REPLACE FUNCTION private\.order_line_discounts[\s\S]*?\n\$\$;/)?.[0];
  expect(reader).toContain('SECURITY INVOKER');
  expect(h1Sql).toContain("pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\\r',''))");
  expect(h1Sql).toContain('IF NOT FOUND THEN RETURN NULL; END IF;');
});

test('FREQ-542-AC-01: H1は注文と会員と服のFK読取を支える索引を持つ', () => {
  for (const [table, column] of [['order_line_discount_allocations', 'order_id'], ['order_line_unit_amounts', 'order_id'],
    ['discounts', 'created_by'], ['discounts', 'updated_by'], ['discount_items', 'item_id'],
    ['discount_codes', 'assigned_user_id'], ['discount_assignments', 'user_id'], ['discount_redemptions', 'user_id'],
    ['discount_redemptions', 'attention_resolved_by'], ['discount_assignments', 'discount_id'], ['order_line_discount_allocations', 'discount_id']]) {
    expect(new RegExp(`CREATE INDEX \\w+ ON public\\.${table}\\(${column}\\);`).test(h1Sql)).toBe(true);
  }
});

test('FREQ-542-AC-01: H1の明示CHECK名は列CHECKの自動名と衝突しない', () => {
  const collisions: string[] = [];
  const tables = [...h1Sql.matchAll(/CREATE (?:TEMP )?TABLE ((?:public\.)?\w+)\s*\(([\s\S]*?)\)(?: ON COMMIT DROP)?;/g)];
  expect(tables.length).toBeGreaterThanOrEqual(15);
  for (const table of tables) {
    const name = table[1];
    const definition = table[2];
    const implicit = [...definition.matchAll(/^\s*(\w+)\s+(?:text|integer|bigint|smallint|uuid|boolean|jsonb|timestamptz)\b[^\n]*\bCHECK\s*\(/gm)]
      .map((column) => `${name.replace(/^public\./, '')}_${column[1]}_check`);
    const explicit = [...definition.matchAll(/\bCONSTRAINT (\w+) CHECK\b/g)].map((constraint) => constraint[1]);
    const seen = new Set<string>();
    for (const constraint of [...implicit, ...explicit]) {
      if (seen.has(constraint)) collisions.push(`${name}.${constraint}`);
      seen.add(constraint);
    }
  }
  expect(collisions).toEqual([]);
});

test('FREQ-542-AC-01: H1末尾assertの一時表FKは永続表を参照しない', () => {
  const assertion = h1Sql.split('-- H1_FINAL_ASSERT_BEGIN')[1];
  const temporaryTables = [...assertion.matchAll(/CREATE TEMP TABLE \w+ \(([\s\S]*?)\) ON COMMIT DROP;/g)];
  expect(temporaryTables.length).toBeGreaterThanOrEqual(8);
  const permanentReferences = temporaryTables.flatMap((table) =>
    [...table[1].matchAll(/REFERENCES ((?:public|auth)\.\w+)/g)].map((reference) => reference[1]));
  expect(permanentReferences).toEqual([]);
});

// Task 1 の表示表。実装側の配列から期待値を生成しない。
const ROWS = [
  ['利用者', '利用者の閲覧', 'admin.users.read'],
  ['利用者', '利用者の管理', 'admin.users.manage'],
  ['商品', '商品の閲覧', 'admin.items.read'],
  ['商品', '商品の管理', 'admin.items.manage'],
  ['お知らせ', 'お知らせの閲覧', 'admin.news.read'],
  ['お知らせ', 'お知らせの管理', 'admin.news.manage'],
  ['LOOK', 'LOOKの閲覧', 'admin.looks.read'],
  ['LOOK', 'LOOKの管理', 'admin.looks.manage'],
  ['取扱店', '取扱店の閲覧', 'admin.stockists.read'],
  ['取扱店', '取扱店の管理', 'admin.stockists.manage'],
  ['注文', '注文一覧・詳細・CSV・履歴・要対応の閲覧', 'admin.orders.read'],
  ['注文', '未入金取消・取消申請審査・要確認解消・メール再送', 'admin.orders.manage'],
  ['問い合わせ', '問い合わせの閲覧', 'admin.contact.read'],
  ['問い合わせ', '問い合わせの管理', 'admin.contact.manage'],
  ['会計', '会計の閲覧', 'admin.finance.read'],
  ['会計', '会計の管理', 'admin.finance.manage'],
  ['監査', '監査の閲覧', 'admin.audit.read'],
  ['注文', '返金・返金再試行・金額決定', 'admin.orders.refund'],
  ['ショップ設定', 'ショップ設定', 'admin.settings.manage'],
  ['注文', '返品作成・審査・受取・検品・取消・開き直し・金額相談', 'admin.orders.return'],
  ['在庫', '在庫一覧', 'admin.stock.read'],
  ['在庫', '入荷・棚卸・割当強制解除', 'admin.stock.manage'],
  ['注文', '割り当てを入れ替える', 'admin.orders.allocate'],
  ['発注', '発注一覧・発注書・取引添付の閲覧/取得', 'admin.purchase_orders.read'],
  ['発注', '発注入力/確認/確定・数量/単価訂正・添付追加・打切り/再確定', 'admin.purchase_orders.manage'],
  ['受け取り', '全部/一部受取・受取取消/訂正（取消・訂正で在庫が足りなくなる時は、新しい注文から順に支払い済みの割当を外す）', 'admin.receiving.manage'],
  ['発送', '荷作り・発送票閲覧', 'admin.shipping.read'],
  ['発送', '票の下書き/品物選択・発送・伝票訂正・手動配達済み・発送取消', 'admin.shipping.manage'],
  ['発送', '確定後の出荷日訂正', 'admin.shipping.correct_date'],
  ['権限管理', '権限設定の閲覧・保存', 'admin.permissions.manage'],
  ['割引', '割引の閲覧', 'admin.discounts.read'],
  ['割引', '割引の管理', 'admin.discounts.manage'],
  ['会計', '会計の設定・期間', 'admin.accounting.settings.manage'],
  ['会計', '仕訳の訂正・取り消し', 'admin.accounting.entries.correct'],
  ['会計', '期間の締め・締めの解除', 'admin.accounting.close.manage'],
  ['会計', '棚卸・原価の確定', 'admin.accounting.inventory.manage'],
  ['会計', '帳簿・写しの書き出し', 'admin.accounting.export.read'],
  ['会計', '会計ソフトとの連携', 'admin.accounting.integration.manage'],
] as const;
const ACCOUNTING_CODES = ['admin.accounting.settings.manage', 'admin.accounting.entries.correct', 'admin.accounting.close.manage',
  'admin.accounting.inventory.manage', 'admin.accounting.export.read', 'admin.accounting.integration.manage'] as const;

test('FREQ-543-AC-01: 全38行の表示順・分野・ラベルと固定2件・準備中0件を返す', () => {
  expect(ROLE_PERMISSION_CATALOG).toHaveLength(38);
  expect(ROLE_PERMISSION_CATALOG.map(({ area, label, code }) => [area, label, code])).toEqual(ROWS);
  expect(FIXED_PERMISSION_CODES).toEqual(['admin.users.manage', 'admin.permissions.manage']);
  expect(ROLE_PERMISSION_CATALOG.filter((p) => p.fixed).map((p) => p.code)).toEqual(['admin.users.manage', 'admin.permissions.manage']);
});

// G-4 の割り当て入替も公開済み。準備中は無い。
test('FREQ-540-AC-06: upcoming（準備中）は0件で全38コードが公開済み', () => {
  expect(ROLE_PERMISSION_CATALOG.filter((p) => p.upcoming).map((p) => p.code)).toEqual([]);
  expect(ROLE_PERMISSION_CATALOG.filter((p) => !p.upcoming)).toHaveLength(38);
  for (const code of ['admin.stock.read', 'admin.stock.manage', 'admin.purchase_orders.read', 'admin.purchase_orders.manage',
    'admin.receiving.manage', 'admin.shipping.read', 'admin.shipping.manage', 'admin.shipping.correct_date', 'admin.permissions.manage']) {
    expect(ROLE_PERMISSION_CATALOG.find((p) => p.code === code)?.upcoming).toBe(false);
  }
});

test('FREQ-543-AC-01: 依存のある14行だけに指定順の必要コードを表示する', () => {
  expect(Object.fromEntries(ROLE_PERMISSION_CATALOG.filter((p) => p.requires.length).map((p) => [p.code, p.requires]))).toEqual({
    'admin.stock.manage': ['admin.stock.read'],
    'admin.orders.allocate': ['admin.orders.read'],
    'admin.purchase_orders.manage': ['admin.purchase_orders.read'],
    'admin.receiving.manage': ['admin.purchase_orders.read'],
    'admin.shipping.read': ['admin.orders.read'],
    'admin.shipping.manage': ['admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'],
    'admin.shipping.correct_date': ['admin.shipping.read', 'admin.orders.read'],
    'admin.discounts.manage': ['admin.discounts.read'],
    ...Object.fromEntries(ACCOUNTING_CODES.map((code) => [code, ['admin.finance.read']])),
  });
});

test('FREQ-553-AC-01: 6権限の表示の依存はfinance.readでmanage系もreadなしは不足と出る', () => {
  for (const code of ACCOUNTING_CODES) {
    const permission = ROLE_PERMISSION_CATALOG.find((p) => p.code === code);
    expect(permission).toMatchObject({ area: '会計', requires: ['admin.finance.read'], fixed: false, upcoming: false });
    expect(getMissingPermissionDependencies([code])).toEqual(['admin.finance.read']);
    expect(getMissingPermissionDependencies([code, 'admin.finance.read'])).toEqual([]);
  }
  // 書き出しは名前が read でも閲覧と別。finance.manage を持っていても finance.read が無ければ不足と出す
  expect(getMissingPermissionDependencies([...ACCOUNTING_CODES, 'admin.finance.manage'])).toEqual(['admin.finance.read']);
  expect(getMissingPermissionDependencies(['admin.finance.read'])).toEqual([]);
});

test('依存不足は重複なし辞書順で返し、入力に権限を追加しない', () => {
  const codes = ['admin.shipping.manage', 'admin.shipping.correct_date', 'admin.stock.manage', 'admin.receiving.manage'] as const;
  expect(getMissingPermissionDependencies(codes)).toEqual(['admin.orders.manage', 'admin.orders.read', 'admin.purchase_orders.read', 'admin.shipping.read', 'admin.stock.read']);
  expect(codes).toHaveLength(4);
  expect(getMissingPermissionDependencies(['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'])).toEqual([]);
  expect(getMissingPermissionDependencies([])).toEqual([]);
});
