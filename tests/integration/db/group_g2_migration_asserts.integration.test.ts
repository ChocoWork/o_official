/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { G2_ALLOWLIST, G3C_ALLOWLIST, replaceAllowlistSql, runWithAllowlist } from './helpers/group-g-allowlist';

/**
 * G-2 Task 9（FREQ-540-AC-08）: G-2 の移行 2 本（基盤 foundation と書き手 writers）の形と、末尾の確かめの節（G2A_FINAL_ASSERT・G2B_FINAL_ASSERT）。
 * 形（DB なし）: 名前の時刻の順、BOM・CR・全角空白・NBSP が無いこと、先頭の BEGIN; と末尾の COMMIT; が各 1 つ、節の印、
 *   USAGE ON SCHEMA private の文が無いこと、関数の本体の外（最後の確かめの DO の本体を含む）にデータを変える文が無いこと
 *   （DO の本体はタグ付き $tag$ だけ。タグ無しの DO $$ や DO '…' はこの走査から本体が外れるので使えない）、確かめの節の失敗はすべて
 *   GROUP_G_MIGRATION_ASSERTION_FAILED / 55000 で DETAIL は項目名だけ、書き手の閉じた一覧が G-1 の 56 本 + 新 9 本の 65 本で最後の確かめの固定の一覧と同じこと。
 *   1 本あたりの大きさの上限は置かない（本番は CLI の db push で 1 本ずつ 1 つの取引に当て、確かめが落ちればそのファイルは巻き戻る）。
 * 動き（DB あり）: 節を取り出して今の DB で流すと通り、取引の中で関数を落とす・EXECUTE を変える・trigger 名を変える・
 *   書き手の一覧を変えると、GROUP_G_MIGRATION_ASSERTION_FAILED で止まって DETAIL が項目名になる（変更は savepoint で必ず戻す）。
 * G-3 以降へ: 「今の DB で通る」と固定の 65 本（書き手の一覧）の試験は、書き手の閉じた一覧が 65 本を超える時と、この移行の関数を
 *   置き換える時に赤くなる。G-3 は、その変更と同じコミットで、この試験と、同じ確かめを今の DB で流す G-2 の DB 試験
 *   （group_g2_purchase_model・group_g2_purchase_reads・group_g2_purchase_documents・group_g2_public_function_acl）を直す。
 * G-3 Task 5・6（書き手の一覧が70本、さらに72本になった）: G2B の確かめの節（writers）を今の DB で流す前に、共有の道具 group-g-allowlist の
 *   runWithAllowlist／G2_ALLOWLIST で取引の中の一覧を G-2 の65本へ入れ替える（戻すのは各試験の rollback）。今の DB の一覧そのものは
 *   G3C_ALLOWLIST（G-3 の現在の本数）と同じことを別に確かめる。
 */
jest.setTimeout(60000);

const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const FILE_NAMES = fs.readdirSync(MIGRATION_DIRECTORY);
const FOUNDATION_FILES = FILE_NAMES.filter((name) => name.endsWith('_group_g2_purchasing_foundation.sql'));
const WRITERS_FILES = FILE_NAMES.filter((name) => name.endsWith('_group_g2_purchasing_writers.sql'));
const G1_FILES = FILE_NAMES.filter((name) => name.endsWith('_group_g1_allocation.sql'));
const read = (file: string | undefined) => (file === undefined ? '' : fs.readFileSync(path.join(MIGRATION_DIRECTORY, file), 'utf8'));
const FOUNDATION_SQL = read(FOUNDATION_FILES[0]);
const WRITERS_SQL = read(WRITERS_FILES[0]);
const G1_SQL = read(G1_FILES[0]);
const G1_LAST_VERSION = '20261023211425';
const versionOf = (file: string) => file.slice(0, file.indexOf('_'));

/** 印の間の節（印の行は含めない） */
function sectionOf(sql: string, begin: string, end: string): string {
  const from = sql.indexOf(begin);
  const to = from < 0 ? -1 : sql.indexOf(end, from + begin.length);
  if (from < 0 || to < 0) throw new Error(`missing ${begin}`);
  return sql.slice(from + begin.length, to);
}
const FOUNDATION_ASSERT = sectionOf(FOUNDATION_SQL, '-- G2A_FINAL_ASSERT_BEGIN', '-- G2A_FINAL_ASSERT_END');
const WRITERS_ASSERT = sectionOf(WRITERS_SQL, '-- G2B_FINAL_ASSERT_BEGIN', '-- G2B_FINAL_ASSERT_END');

/** 注釈の行を除いた文 */
const codeOf = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
/**
 * ファイルが実行する時にデータを変える文（INSERT INTO・UPDATE … SET・DELETE FROM・文頭の TRUNCATE・COPY）。
 * CREATE FUNCTION の本体（タグ無しの $$ … $$。書き手の関数は本来ここで書く）だけを除き、DO の本体（$tag$ … $tag$。最後の確かめ）は除かない:
 * 最後の確かめや本体の外で、行を書いて確かめを通す抜け道を許さない。注釈と文字の値（'…'）は先に除く。
 */
function dataStatementsOutsideFunctions(sql: string): string[] {
  const code = codeOf(sql).replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const name = String.raw`[A-Za-z_."]+(?:\.[A-Za-z_."]+)?`;
  return [
    ...(code.match(new RegExp(String.raw`\bINSERT\s+INTO\s+${name}`, 'gi')) ?? []),
    ...(code.match(new RegExp(String.raw`\bUPDATE\s+${name}\s+(?:AS\s+\w+\s+)?SET\b`, 'gi')) ?? []),
    ...(code.match(new RegExp(String.raw`\bDELETE\s+FROM\s+${name}`, 'gi')) ?? []),
    ...(code.match(/^\s*(?:TRUNCATE|COPY)\b[^;]*/gim) ?? []),
  ].map((statement) => statement.replace(/\s+/g, ' ').trim());
}
/**
 * 開始が DO で、タグ付きの本体（DO $tag$ … $tag$。最後の確かめ）ではない文。タグ無しの `DO $$ … $$` や文字の値の本体（`DO '…'`）は、
 * 上の走査が関数の本体・文字の値として除くので、そこに書かれたデータを変える文は見えない。DO はタグ付きだけを許し、この抜け道を閉じる
 * （`ON CONFLICT … DO NOTHING／DO UPDATE` は DO の文ではない）。
 */
const untaggedDoStatements = (sql: string) => (codeOf(sql).match(/(?:^|;)\s*DO\s+(?!NOTHING\b|UPDATE\b|\$[A-Za-z_][A-Za-z0-9_]*\$)\S*/gim) ?? [])
  .map((statement) => statement.replace(/^;/, '').replace(/\s+/g, ' ').trim());
/** 'private.name(args)' の形の行を並びのまま集める */
const signaturesIn = (text: string) => [...text.matchAll(/^\s*'((?:private|public)\.[a-z_0-9]+\([^']*\))',?\s*$/gm)].map((match) => match[1]);

const WRITER_NAMES = [
  'admin_create_purchase_order', 'admin_update_purchase_order_header', 'admin_confirm_purchase_order_quantities',
  'admin_short_close_purchase_order', 'admin_receive_purchase_order', 'admin_reverse_purchase_order_receipt',
  'admin_reserve_purchase_order_attachment', 'admin_attach_purchase_order_document', 'admin_revise_purchase_order_document',
];

/** Task 1 の公開関数 11 本（最後の確かめ $g2a_final_public_function_acl$ の一覧と同じ） */
const TASK1_FUNCTIONS = [
  'public.cleanup_password_reset_tokens(integer)',
  'public.clear_admin_expense_cost_allocations(bigint)',
  'public.create_profile_for_new_auth_user()',
  'public.find_auth_user_id_by_email(text)',
  'public.increment_rate_limit_counter(inet,text,timestamp with time zone,integer)',
  'public.increment_rate_limit_counter(inet,text,timestamp with time zone)',
  'public.is_auth_session_active(uuid)',
  'public.record_admin_finance_entry_revision()',
  'public.replace_admin_expense_cost_allocations(bigint,jsonb,uuid)',
  'public.revoke_auth_session(uuid)',
  'public.revoke_auth_sessions_for_user(uuid)',
];

describe('G-2 の移行 2 本の形（DB なし）', () => {
  test('FREQ-540-AC-08: 移行は基盤 foundation と書き手 writers の 2 本で、時刻は G-1 の末尾より後で foundation が先', () => {
    expect(FOUNDATION_FILES).toHaveLength(1);
    expect(WRITERS_FILES).toHaveLength(1);
    expect(FILE_NAMES.filter((name) => name.includes('group_g2')).sort()).toEqual([FOUNDATION_FILES[0], WRITERS_FILES[0]]);
    expect(G1_FILES).toEqual([`${G1_LAST_VERSION}_group_g1_allocation.sql`]);
    const [first, second] = [versionOf(FOUNDATION_FILES[0]), versionOf(WRITERS_FILES[0])];
    expect(first).toMatch(/^[0-9]{14}$/);
    expect(second).toMatch(/^[0-9]{14}$/);
    expect(first > G1_LAST_VERSION).toBe(true);
    expect(second > first).toBe(true);
  });

  describe.each([
    ['foundation', FOUNDATION_SQL, 'G2A'],
    ['writers', WRITERS_SQL, 'G2B'],
  ] as const)('%s', (_name, sql, tag) => {
    test('FREQ-540-AC-08: BOM・CR・全角空白・NBSP が無く、空でない', () => {
      expect(sql.length).toBeGreaterThan(0);
      expect(sql.charCodeAt(0)).not.toBe(0xfeff);
      expect(sql).not.toMatch(/[\r\u3000\u00a0\ufeff]/);
    });

    test('FREQ-540-AC-08: 先頭の近くに BEGIN; が 1 つ、末尾に COMMIT; が 1 つ。その前に NOTIFY pgrst が 1 つ', () => {
      const lines = sql.split('\n');
      expect(lines.filter((line) => /^\s*BEGIN\s*;/i.test(line))).toEqual(['BEGIN;']);
      expect(lines.findIndex((line) => line === 'BEGIN;')).toBeLessThan(10);
      expect(lines.filter((line) => /^\s*COMMIT\s*;/i.test(line))).toEqual(['COMMIT;']);
      const last = lines.filter((line) => line.trim() !== '');
      expect(last.at(-1)).toBe('COMMIT;');
      expect(last.at(-2)).toBe("NOTIFY pgrst, 'reload schema';");
      expect(sql.match(/NOTIFY pgrst/g)).toHaveLength(1);
    });

    test('FREQ-540-AC-08: 節の印（本体・最後の確かめ）が 1 つずつ、この順にある', () => {
      const markers = [`-- ${tag}_BODY_BEGIN`, `-- ${tag}_BODY_END`, `-- ${tag}_FINAL_ASSERT_BEGIN`, `-- ${tag}_FINAL_ASSERT_END`];
      for (const marker of markers) expect({ marker, count: sql.split(`\n${marker}\n`).length - 1 }).toEqual({ marker, count: 1 });
      const positions = markers.map((marker) => sql.indexOf(marker));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(sql.indexOf("NOTIFY pgrst, 'reload schema';")).toBeGreaterThan(positions[3]);
    });

    test('FREQ-540-AC-08: private schema の USAGE を変える文が無い（pre-request hook を保つ）', () => {
      expect(codeOf(sql)).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bON\s+SCHEMA\s+private\b/i);
      expect(codeOf(sql)).not.toMatch(/\bON\s+SCHEMA\s+private\b/i);
    });
  });

  test('FREQ-540-AC-08: 関数の本体と注釈の外（最後の確かめの DO の本体を含む）でデータを変える文は、foundation の bucket の 1 行だけ（writers は 0）', () => {
    // 文頭の TRUNCATE だけを数える（CREATE TRIGGER … BEFORE TRUNCATE の TRUNCATE は文ではない）
    expect(dataStatementsOutsideFunctions(FOUNDATION_SQL)).toEqual(['INSERT INTO storage.buckets']);
    expect(dataStatementsOutsideFunctions(WRITERS_SQL)).toEqual([]);
    // DO の本体はタグ付き（$g2a_final_…$）だけ。タグ無しの DO $$ は上の走査から外れるので、無いことを別に確かめる
    expect(untaggedDoStatements(FOUNDATION_SQL)).toEqual([]);
    expect(untaggedDoStatements(WRITERS_SQL)).toEqual([]);
  });

  test('FREQ-540-AC-08: 抜け道を許さない: タグ無しの DO $$ ／ DO LANGUAGE … $$ ／ DO \'…\' に本体を隠すと見つかり、タグ付きの DO と ON CONFLICT … DO は数えない', () => {
    const hidden = "DO $$ BEGIN INSERT INTO public.purchase_orders DEFAULT VALUES; END $$;";
    // 置き換えの文字列では $$ が $ になるので、関数で渡す
    const withHidden = (statement: string) => FOUNDATION_SQL.replace('NOTIFY pgrst', () => `${statement}\nNOTIFY pgrst`);
    // 隠した INSERT は関数の本体として除かれ、データを変える文の走査には見えない（だから別の確かめが要る）
    expect(dataStatementsOutsideFunctions(withHidden(hidden))).toEqual(['INSERT INTO storage.buckets']);
    expect(untaggedDoStatements(withHidden(hidden))).toEqual(['DO $$']);
    expect(untaggedDoStatements(withHidden("DO LANGUAGE plpgsql $$ BEGIN DELETE FROM public.purchase_orders; END $$;"))).toEqual(['DO LANGUAGE']);
    expect(untaggedDoStatements(withHidden("DO 'BEGIN TRUNCATE public.purchase_orders CASCADE; END';"))).toEqual(["DO 'BEGIN"]);
    expect(untaggedDoStatements(`SELECT 1; ${hidden}`)).toEqual(['DO $$']);
    expect(untaggedDoStatements(withHidden('DO $x$ BEGIN NULL; END $x$;'))).toEqual([]);
    expect(untaggedDoStatements('INSERT INTO t VALUES (1)\n  ON CONFLICT (id) DO NOTHING;\nINSERT INTO t VALUES (1)\nON CONFLICT (id)\n  DO UPDATE SET id = 2;')).toEqual([]);
  });

  test('FREQ-540-AC-08: 抜け道を許さない: 最後の確かめの DO の本体や本体の外に INSERT／UPDATE／DELETE／TRUNCATE を足すと見つかり、関数の本体の中の INSERT は数えない', () => {
    const inDoBody = (statement: string) => FOUNDATION_SQL.replace(
      '  IF v_failed IS NOT NULL THEN\n    RAISE EXCEPTION', `  ${statement}\n  IF v_failed IS NOT NULL THEN\n    RAISE EXCEPTION`);
    const insert = "INSERT INTO public.purchase_orders (number, supplier_name, created_by) VALUES ('PO-29991231-0001', 'S', gen_random_uuid());";
    expect(inDoBody(insert)).not.toBe(FOUNDATION_SQL);
    expect(dataStatementsOutsideFunctions(inDoBody(insert))).toEqual(['INSERT INTO storage.buckets', 'INSERT INTO public.purchase_orders']);
    expect(dataStatementsOutsideFunctions(inDoBody('UPDATE public.purchase_orders SET version = version;'))).toContain('UPDATE public.purchase_orders SET');
    expect(dataStatementsOutsideFunctions(inDoBody('DELETE FROM public.purchase_order_lines;'))).toContain('DELETE FROM public.purchase_order_lines');
    expect(dataStatementsOutsideFunctions(inDoBody('TRUNCATE public.purchase_order_receipts;'))).toContain('TRUNCATE public.purchase_order_receipts');
    // 本体の外（ファイルの文）に足した場合
    expect(dataStatementsOutsideFunctions(WRITERS_SQL.replace('NOTIFY pgrst', 'INSERT INTO public.purchase_order_lines DEFAULT VALUES;\nNOTIFY pgrst')))
      .toEqual(['INSERT INTO public.purchase_order_lines']);
    // 文字の値や注釈の中の語は数えず、関数の本体（$$ … $$）の中の INSERT は書き手の仕事なので数えない
    const harmless = "-- INSERT INTO public.purchase_orders\nSELECT 'INSERT INTO public.purchase_orders', 'UPDATE x SET y';\n"
      + 'CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ INSERT INTO public.purchase_orders DEFAULT VALUES; $$;\n';
    expect(dataStatementsOutsideFunctions(harmless)).toEqual([]);
  });

  test('FREQ-540-AC-08: 確かめの節の失敗は GROUP_G_MIGRATION_ASSERTION_FAILED / 55000 だけで、DETAIL は項目名（英小文字と _）だけ', () => {
    for (const [section, blocks] of [[FOUNDATION_ASSERT, 5], [WRITERS_ASSERT, 2]] as const) {
      expect(section.match(/^DO \$[a-z0-9_]+\$/gm)).toHaveLength(blocks);
      const raises = section.match(/RAISE EXCEPTION [^;]*;/g) ?? [];
      expect(raises).toHaveLength(blocks);
      for (const raise of raises) {
        expect(raise).toMatch(/^RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = (?:v_failed|'[a-z_]+');$/);
      }
      // 項目名は v_failed に入れる文字の値（'…' の小文字と _ だけ）
      for (const [, name] of section.matchAll(/v_failed := '([^']*)'/g)) expect(name).toMatch(/^[a-z_]+$/);
    }
  });

  test('FREQ-540-AC-08: 書き手の閉じた一覧は G-1 の 56 本が一字も変わらず先頭に並び、新 9 本が続く 65 本で、最後の確かめの固定の一覧と同じ並び', () => {
    const g1 = signaturesIn(G1_SQL.slice(G1_SQL.indexOf('CREATE FUNCTION private.group_g_writer_allowlist()'),
      G1_SQL.indexOf('ALTER FUNCTION private.group_g_writer_allowlist() OWNER TO postgres;')));
    expect(g1).toHaveLength(56);
    const functionBody = WRITERS_SQL.slice(WRITERS_SQL.indexOf('CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()'), WRITERS_SQL.indexOf('-- G2B_BODY_END'));
    const allowlist = signaturesIn(functionBody);
    const fixed = signaturesIn(sectionOf(WRITERS_ASSERT, 'v_writers text[] := ARRAY[', '];'));
    expect(allowlist).toHaveLength(65);
    expect(new Set(allowlist).size).toBe(65);
    expect(allowlist.slice(0, 56)).toEqual(g1);
    expect(allowlist.slice(56).map((signature) => signature.slice(0, signature.indexOf('(')))).toEqual(WRITER_NAMES.map((name) => `private.${name}`));
    expect(fixed).toEqual(allowlist);
  });

  test('FREQ-540-AC-08: 末尾の確かめは名前の付いた制約・trigger と意味の ACL だけで見る（局所で作られる名前・ACL の文字列の完全一致を使わない）', () => {
    for (const section of [FOUNDATION_ASSERT, WRITERS_ASSERT]) {
      expect(section).not.toMatch(/relacl::text|proacl::text|arwdDxtm/);
    }
    // PG17 の MAINTAIN は版で守る（前の版では権限名が無く has_table_privilege が断る）
    for (const section of [FOUNDATION_ASSERT, WRITERS_ASSERT]) {
      expect(section).toContain("pg_catalog.current_setting('server_version_num')::integer >= 170000");
    }
    // 自分では PUBLIC の EXECUTE を「実効の ACL」から読む（proacl が NULL の既定には PUBLIC が含まれる）
    expect(FOUNDATION_ASSERT).toContain("pg_catalog.acldefault('f', p.proowner)");
    expect(WRITERS_ASSERT).toContain("pg_catalog.acldefault('f', p.proowner)");
  });
});

describeLocalDb('integration: G-2 の移行の末尾の確かめを流す（両ファイル）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  type Failure = { code?: string; message?: string; detail?: string };

  /**
   * 節を流す。止まったら { code, message, detail }、通れば null。取引は savepoint まで戻す。
   * allowlist を渡すと、流す前に取引の中の書き手の一覧をその一覧へ入れ替える（戻すのは savepoint への rollback）
   */
  async function run(section: string, allowlist?: readonly string[]): Promise<Failure | null> {
    await db().query('savepoint assert_section');
    try {
      if (allowlist === undefined) await db().query(section);
      else await runWithAllowlist(db(), allowlist, section);
      return null;
    } catch (error) {
      const caught = error as Failure;
      return { code: caught.code, message: caught.message, detail: caught.detail };
    } finally {
      await db().query('rollback to savepoint assert_section');
      await db().query('release savepoint assert_section');
    }
  }

  /** 変更を取引の中で当ててから節を流し、変更も戻す */
  async function runAfter(change: string, section: string): Promise<Failure | null> {
    await db().query('savepoint tamper');
    try {
      await db().query(change);
      return await run(section);
    } finally {
      await db().query('rollback to savepoint tamper');
      await db().query('release savepoint tamper');
    }
  }

  const failed = (detail: string): Failure => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });

  test('FREQ-540-AC-08: 今の DB で両ファイルの末尾の確かめの節が通る（G2B は取引の中で一覧を G-2 の65本へ入れ替えてから）', async () => {
    expect(await run(FOUNDATION_ASSERT)).toBeNull();
    expect(await run(WRITERS_ASSERT, G2_ALLOWLIST)).toBeNull();
  });

  test('FREQ-540-AC-10: 今の DB の書き手の一覧のままでは G2B の確かめは止まる（G-3 の書き手が加わった72本。一覧の本数・並びは G3C_ALLOWLIST と同じ）', async () => {
    expect(G2_ALLOWLIST).toHaveLength(65);
    expect(G3C_ALLOWLIST.slice(0, 65)).toEqual(G2_ALLOWLIST);
    const live = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows.map((row) => String(row.oid));
    const expected = (await db().query('select to_regprocedure(s)::oid::text as oid from unnest($1::text[]) as s', [G3C_ALLOWLIST])).rows.map((row) => row.oid);
    expect(expected.every((oid: string | null) => oid !== null)).toBe(true);
    expect([...live].sort()).toEqual([...expected].sort());
    expect(await run(WRITERS_ASSERT)).toEqual(failed('purchase_writer_allowlist_missing'));
  });

  test('FREQ-540-AC-08: 移行を流す側の search_path が違っても（pg_catalog だけ・public と private を前に）通る', async () => {
    for (const searchPath of ['pg_catalog', 'public, private, pg_catalog', 'pg_catalog, public']) {
      await db().query('savepoint search_path_run');
      try {
        await db().query(`set local search_path to ${searchPath}`);
        expect({ searchPath, foundation: await run(FOUNDATION_ASSERT), writers: await run(WRITERS_ASSERT, G2_ALLOWLIST) })
          .toEqual({ searchPath, foundation: null, writers: null });
      } finally {
        await db().query('rollback to savepoint search_path_run');
        await db().query('release savepoint search_path_run');
      }
    }
  });

  test('FREQ-540-AC-08: 変更は savepoint で戻り、確かめを流した後に何も残らない', async () => {
    expect(await runAfter('grant execute on function public.revoke_auth_session(uuid) to anon', FOUNDATION_ASSERT)).toEqual(failed('public_function_acl'));
    expect((await db().query("select has_function_privilege('anon', 'public.revoke_auth_session(uuid)', 'EXECUTE') as anon")).rows[0].anon).toBe(false);
    expect(await run(FOUNDATION_ASSERT)).toBeNull();
  });

  describe('foundation', () => {
    test.each(TASK1_FUNCTIONS.flatMap((signature) => (['anon', 'authenticated'] as const).map((role) => [signature, role] as const)))(
      'FREQ-540-AC-08: Task 1 の公開関数 %s に %s の EXECUTE を付け直すと public_function_acl で止まる',
      async (signature, role) => {
        expect(await runAfter(`grant execute on function ${signature} to ${role}`, FOUNDATION_ASSERT)).toEqual(failed('public_function_acl'));
      },
    );

    test('FREQ-540-AC-08: Task 1 の公開関数に PUBLIC の EXECUTE を付け直す、service_role の EXECUTE を外す、関数を落とすと public_function_acl で止まる', async () => {
      expect(await runAfter('grant execute on function public.is_auth_session_active(uuid) to public', FOUNDATION_ASSERT)).toEqual(failed('public_function_acl'));
      expect(await runAfter('revoke execute on function public.is_auth_session_active(uuid) from service_role', FOUNDATION_ASSERT)).toEqual(failed('public_function_acl'));
      expect(await runAfter('drop function public.cleanup_password_reset_tokens(integer)', FOUNDATION_ASSERT)).toEqual(failed('public_function_acl'));
    });

    test.each([
      ['読取の入口を 1 つ落とす', 'drop function public.search_purchase_order_documents(date,date,bigint,bigint,text,text,text,boolean,integer,integer,uuid)', 'foundation_function_set'],
      ['読取の本体を 1 つ落とす', 'drop function private.list_admin_inventory(uuid)', 'foundation_function_set'],
      ['内部の道具を落とす', 'drop function private.purchase_order_display_stages(uuid[])', 'foundation_function_set'],
      ['同名の別の overload を足す', 'create function private.get_admin_purchase_order(uuid, uuid, integer) returns jsonb language sql as $$ select null::jsonb $$', 'foundation_function_set'],
      ['service_role の EXECUTE を読取の入口から外す', 'revoke execute on function public.get_admin_purchase_order(uuid,uuid) from service_role', 'foundation_service_role_execute'],
      ['service_role の EXECUTE を読取の本体から外す', 'revoke execute on function private.list_admin_purchase_order_lines(integer,integer,uuid) from service_role', 'foundation_service_role_execute'],
      ['内部の道具に service_role の EXECUTE を付ける', 'grant execute on function private.group_g_open_work_order_ids(bigint[]) to service_role', 'foundation_functions'],
      ['内部の道具に anon の EXECUTE を付ける', 'grant execute on function private.group_g_actor_has_permissions(uuid,text[]) to anon', 'foundation_functions'],
      ['置き換えた G-1 の関数の search_path を変える', 'alter function private.list_group_g_variant_inventory(bigint[]) set search_path = public', 'foundation_functions'],
      ['置き換えた G-1 の paid_at の守りを DEFINER にする', 'alter function private.guard_group_g_paid_at() security definer', 'foundation_functions'],
      ['置き換えた G-1 の在庫の入力から service_role の EXECUTE を外す', 'revoke execute on function private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer) from service_role', 'foundation_functions'],
      ['読取の本体に authenticated の EXECUTE を付ける（読取の節で止まる）', 'grant execute on function private.get_admin_purchase_order(uuid,uuid) to authenticated', 'purchase_read_functions'],
      ['trigger の名前を変える', 'alter trigger purchase_orders_change_guard on public.purchase_orders rename to purchase_orders_guard_renamed', 'purchase_table_triggers'],
      ['追記専用の trigger を止める', 'alter table public.purchase_order_revisions disable trigger purchase_order_revisions_no_update', 'purchase_table_triggers'],
      ['行のセキュリティを外す', 'alter table public.purchase_orders disable row level security', 'purchase_tables'],
      ['この取引で書いた行がある', "insert into public.purchase_orders (number, supplier_name, created_by) values ('PO-20991231-0001', 'S', gen_random_uuid())", 'purchase_table_rows'],
      ['bucket を公開にする', "update storage.buckets set public = true where id = 'purchase-order-documents'", 'purchase_bucket'],
      ['表の権限: anon に SELECT を付ける', 'grant select on public.purchase_orders to anon', 'purchase_table_acl'],
      ['表の権限: service_role の SELECT を外す', 'revoke select on public.purchase_order_attachments from service_role', 'purchase_table_acl'],
    ])('FREQ-540-AC-08: %s と GROUP_G_MIGRATION_ASSERTION_FAILED で止まり DETAIL は項目名（%#）', async (_name, change, detail) => {
      expect(await runAfter(change, FOUNDATION_ASSERT)).toEqual(failed(detail));
    });

    test('FREQ-540-AC-08: 行が今の取引の物でなければ（別の取引が確定した行は created_at が古い）、行があっても通る。確かめは書き直しても使える', async () => {
      expect(await runAfter(
        "insert into public.purchase_orders (number, supplier_name, created_by, created_at) values ('PO-20991231-0002', 'S', gen_random_uuid(), now() - interval '1 day')",
        FOUNDATION_ASSERT,
      )).toBeNull();
    });

    test('FREQ-540-AC-08: PostgreSQL 17 以降は MAINTAIN も「無い」の一覧に入る', async () => {
      const hasMaintain = (await db().query("select current_setting('server_version_num')::int >= 170000 as has")).rows[0].has as boolean;
      if (!hasMaintain) return;
      expect(await runAfter('grant maintain on public.purchase_orders to anon', FOUNDATION_ASSERT)).toEqual(failed('purchase_table_acl'));
    });
  });

  describe('writers', () => {
    // G2B の確かめは「その移行を当てた時点の65本」を固定で持つ。今の DB の一覧（G-3 で72本）のままでは通らないので、
    // 各試験の最初（外側の BEGIN の後）に、取引の中の一覧を G-2 の65本へ入れ替える。戻すのは外側の ROLLBACK
    beforeEach(async () => { await db().query(replaceAllowlistSql(G2_ALLOWLIST)); });

    /** 固定の一覧を、書き手の閉じた一覧の関数として入れ替える文（entries は 'private.name(args)' の並び） */
    const replaceAllowlist = (entries: string[]) => replaceAllowlistSql(entries);
    const CURRENT = signaturesIn(sectionOf(WRITERS_ASSERT, 'v_writers text[] := ARRAY[', '];'));
    const LOCK_HELPER = 'private.lock_group_g_purchase_orders(uuid[],boolean)';
    const CREATE_BODY = 'private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)';
    const CREATE_ENTRY = 'public.admin_create_purchase_order(text,text,jsonb,uuid,uuid)';

    test.each([
      ['公開の入口を 1 つ落とす', `drop function ${CREATE_ENTRY}`, 'purchase_writer_functions'],
      ['書込みの本体を 1 つ落とす', 'drop function private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)', 'purchase_writer_functions'],
      ['書込みの本体に anon の EXECUTE を付ける', `grant execute on function ${CREATE_BODY} to anon`, 'purchase_writer_functions'],
      ['公開の入口に authenticated の EXECUTE を付ける', `grant execute on function ${CREATE_ENTRY} to authenticated`, 'purchase_writer_functions'],
      ['公開の入口に PUBLIC の EXECUTE を付ける', `grant execute on function ${CREATE_ENTRY} to public`, 'purchase_writer_functions'],
      ['内部の押さえの道具に service_role の EXECUTE を付ける', `grant execute on function ${LOCK_HELPER} to service_role`, 'purchase_writer_functions'],
      ['書込みの本体から service_role の EXECUTE を外す', `revoke execute on function ${CREATE_BODY} from service_role`, 'purchase_writer_functions'],
      ['公開の入口を DEFINER にする', `alter function ${CREATE_ENTRY} security definer`, 'purchase_writer_functions'],
      ['書込みの本体の search_path を変える', `alter function ${CREATE_BODY} set search_path = public`, 'purchase_writer_functions'],
      ['押さえの道具の順（共通の押さえが最初）を崩す', `create or replace function ${LOCK_HELPER.replace('(uuid[],boolean)', '(_purchase_order_ids uuid[], _with_inventory boolean)')}
        returns uuid[] language plpgsql security definer set search_path = '' as $$
        begin
          perform po.id from public.purchase_orders as po where po.id = any(_purchase_order_ids) order by po.id for update;
          perform pg_catalog.pg_advisory_xact_lock(190521,1);
          return array[]::uuid[];
        end; $$`, 'purchase_writer_lock_order'],
      ['書き手の一覧から 1 本外す（64 本）', replaceAllowlist(CURRENT.slice(0, 64)), 'purchase_writer_allowlist_missing'],
      ['書き手の一覧に 1 本足す（66 本）', replaceAllowlist([...CURRENT, LOCK_HELPER]), 'purchase_writer_allowlist_missing'],
      ['書き手の一覧の 1 本を別の関数に替える（65 本のまま）', replaceAllowlist([LOCK_HELPER, ...CURRENT.slice(1)]), 'purchase_writer_allowlist'],
      ['同名の別の overload を足す', `create function private.admin_create_purchase_order(uuid) returns integer language sql as $$ select 1 $$`, 'purchase_writer_function_set'],
      ['表の権限: service_role に発注書の SELECT を付ける', 'grant select on public.purchase_order_revisions to service_role', 'purchase_writer_table_acl'],
      ['表の権限: anon に操作の受付の列の読取を付ける', 'grant select (id) on private.group_g_operations to anon', 'purchase_writer_table_acl'],
      ['表の権限: postgres の権限を外す', 'revoke truncate on public.purchase_order_receipts from postgres', 'purchase_writer_table_acl'],
    ])('FREQ-540-AC-08: %s と GROUP_G_MIGRATION_ASSERTION_FAILED で止まり DETAIL は項目名（%#）', async (_name, change, detail) => {
      expect(await runAfter(change, WRITERS_ASSERT)).toEqual(failed(detail));
    });

    test('FREQ-540-AC-08: 固定の一覧の入れ替え（同じ 65 本）は通る。入れ替えが戻ることも確かめる', async () => {
      expect(CURRENT).toEqual([...G2_ALLOWLIST]);
      expect(await runAfter(replaceAllowlist(CURRENT), WRITERS_ASSERT)).toBeNull();
      expect((await db().query('select cardinality(private.group_g_writer_allowlist()) as n')).rows[0].n).toBe(65);
    });

    test('FREQ-540-AC-10: G-3 の書き手を足した一覧（今の DB と同じ本数）では G2B の確かめは止まり、入れ替えは savepoint で戻る', async () => {
      expect(await runAfter(replaceAllowlist([...G3C_ALLOWLIST]), WRITERS_ASSERT)).toEqual(failed('purchase_writer_allowlist_missing'));
      expect((await db().query('select cardinality(private.group_g_writer_allowlist()) as n')).rows[0].n).toBe(65);
    });

    test('FREQ-540-AC-08: PostgreSQL 17 以降は MAINTAIN も「無い」の一覧に入る', async () => {
      const hasMaintain = (await db().query("select current_setting('server_version_num')::int >= 170000 as has")).rows[0].has as boolean;
      if (!hasMaintain) return;
      expect(await runAfter('grant maintain on public.purchase_order_receipts to anon', WRITERS_ASSERT)).toEqual(failed('purchase_writer_table_acl'));
    });
  });
});
