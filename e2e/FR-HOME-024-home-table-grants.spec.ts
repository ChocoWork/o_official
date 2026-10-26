/**
 * FR-HOME-024 ホームに出る商品の表と原価の履歴の表の権限が、DB の直接の道で閉じていることを確かめる
 * 対応: SEC-HOME-003-AC-01 / SEC-HOME-003-AC-02 / SEC-HOME-004-AC-01 / SEC-HOME-005-AC-01 / SEC-HOME-020-AC-01
 *
 * 手元の Supabase の PostgREST（NEXT_PUBLIC_SUPABASE_URL/rest/v1）を request fixture で直接叩く。手元の DB への足し込みと確かめは pg。
 * - SEC-HOME-003-AC-01/02: admin ロール（admin.items.read・admin.items.manage を持つ）の aal1 の JWT。
 *   admin.items.* の付与を確かめる間は withPermissionScenario の advisory lock を持ち、終わりに差分で元へ戻す
 * - SEC-HOME-004-AC-01: anon の鍵と一般会員の JWT で、原価の2つの列（pattern_cost・mass_production_cost）を select する。
 *   product_note はお客さん向けの注意書きなので公開の列で、200 で値が返ることを対照として確かめる
 * - SEC-HOME-005-AC-01: anon の鍵で items の insert・update・delete を送り、ホームの商品の名前の並びが変わらないことを確かめる
 * - SEC-HOME-020-AC-01: anon の鍵と一般会員の JWT で item_cost_history の select・insert・update・delete を送る。
 *   anon は全部が権限の誤り。一般会員は select が 200 で 0 件（admin.finance.read の方針で絞られる）、insert・update・delete が権限の誤り
 * 足した行は finally で消す。公開の商品は見本の最新の直後の日時で入れ（ホームの ITEM の節に出る前提を落とさず、いちばん新しい商品は奪わない）、
 * 公開の行を足す試験（003-AC-02・004-AC-01・005-AC-01）は withHomeCatalogLock('exclusive') でほかの HOME の試験と直列にする。
 * 一般会員・管理者の JWT は worker ごとに1回だけ作る（ログインの回数の制限を使い切らない）。
 */
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import {
  ANON_KEY,
  COST_HISTORY_VALUES,
  COST_VALUES,
  cleanupHomeRows,
  createMemberActor,
  deleteHomeGrantUsers,
  ensureAdminItemsPermissions,
  expectNoLeak,
  expectPermissionError,
  jsonRows,
  readHomeItemNames,
  requireLocalSupabase,
  restHeaders,
  restUrl,
  seedCostHistory,
  seedHomeItem,
  trackHomeGrantUser,
  uniqueTag,
  type MemberActor,
} from './home-grant-test-utils';
import { withHomeCatalogLock } from './home-test-utils';
import { withLocalDb } from './order-email-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

test.use({ trace: 'off' });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  memberPromise = null;
  adminPromise = null;
  await deleteHomeGrantUsers();
});

let memberPromise: Promise<MemberActor> | null = null;
function memberActor(): Promise<MemberActor> {
  memberPromise ??= createMemberActor();
  return memberPromise;
}

let adminPromise: Promise<AdminSessionActor> | null = null;
/** admin ロールの aal1 の JWT。呼ぶ側が持つ withPermissionScenario の接続で作る */
function adminAal1(db: Parameters<typeof createAdminSessionActor>[0]): Promise<AdminSessionActor> {
  adminPromise ??= createAdminSessionActor(db, 'admin', 'aal1').then((actor) => {
    trackHomeGrantUser(actor.userId);
    return actor;
  });
  return adminPromise;
}

/** 「権限の誤り（401・403）か、0 件で終わった」こと。行が1件でも返れば変更が通ったとみなす */
async function expectDeniedOrZero(response: APIResponse, label: string): Promise<void> {
  const status = response.status();
  if (status === 401 || status === 403) return;
  const rows = await jsonRows(response);
  expect(status < 300 && rows.length === 0, `${label}: 権限の誤りでも 0 件でもない（status: ${status}, 返った行: ${rows.length}）`).toBe(true);
}

type ItemRow = { id: string; name: string; status: string; pattern_cost: number | null; mass_production_cost: number | null };

async function readItemRows(ids: number[], names: string[]): Promise<ItemRow[]> {
  return withLocalDb(async (db) => {
    const result = await db.query(
      `select id::text, name, status, pattern_cost, mass_production_cost
         from public.items where id = any($1::bigint[]) or name = any($2::text[]) order by id`,
      [ids, names],
    );
    return result.rows as ItemRow[];
  });
}

test.describe('FR-HOME-024 admin ロールの aal1 の JWT で items を直接読む', () => {
  test('SEC-HOME-003-AC-01: admin.items.read を持つ利用者の aal1 の JWT で select した時、下書きの商品の行が結果に含まれない', async ({ request }) => {
    test.fail(true, 'SEC-HOME-003 今のコードは満たさない（docs/02_Requirements/areas/home.md）');
    test.setTimeout(180_000);
    requireLocalSupabase();

    await withPermissionScenario(async (db) => {
      await ensureAdminItemsPermissions(db);
      const actor = await adminAal1(db);
      expect(actor.aal).toBe('aal1');
      const draft = await seedHomeItem(db, 'draft', 'private');
      try {
        const headers = restHeaders(actor.accessToken);

        // JWT 自体は通っている（公開の商品は読める）うえで、下書きの商品の行が含まれないことを確かめる
        const published = await request.get(restUrl('items', '?select=id,status&status=eq.published&limit=1'), { headers, failOnStatusCode: false });
        expect(published.status(), 'aal1 の JWT で公開の商品は読める').toBe(200);
        expect((await jsonRows(published)).length, 'aal1 の JWT で公開の商品が1件以上返る').toBeGreaterThan(0);

        const byId = await request.get(restUrl('items', `?select=id,name,status&id=eq.${draft.id}`), { headers, failOnStatusCode: false });
        const byIdText = await byId.text();
        const byIdRows = byId.status() === 200 ? await jsonRows(byId) : [];
        expect(byIdRows.map((row) => Number(row.id)), '下書きの商品の id を指した select の結果に、その行が含まれない').not.toContain(draft.id);
        expect(byIdText.includes(draft.name), '下書きの商品の名前が応答に含まれない').toBe(false);

        const drafts = await request.get(restUrl('items', '?select=id,name,status&status=neq.published'), { headers, failOnStatusCode: false });
        const draftsRows = drafts.status() === 200 ? await jsonRows(drafts) : [];
        expect(draftsRows.map((row) => Number(row.id)), '下書きの商品を指した select の結果に、その行が含まれない').not.toContain(draft.id);
        expect(draftsRows.filter((row) => row.status !== 'published'), '下書きの商品の行が1件も含まれない').toHaveLength(0);
        expect((await drafts.text()).includes(draft.name), '下書きを指した select の応答に、その商品の名前が含まれない').toBe(false);
      } finally {
        await cleanupHomeRows(db, [draft.id]);
      }
    });
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`FR-HOME-024 admin ロールの aal1 の JWT で items を直接書き換える (${vp.name})`, () => {
    test(`SEC-HOME-003-AC-02 ${vp.name}: admin.items.manage を持つ利用者の aal1 の JWT の update・delete が行を変えずに終わり、ホームに元の名前のまま表示される`, async ({ request, page }) => {
      test.setTimeout(300_000);
      requireLocalSupabase();
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 公開の商品を足す間はほかの HOME の試験と重ならないよう排他の lock を持ち、そのうえで権限の場面の lock を取る
      await withHomeCatalogLock('exclusive', () => withPermissionScenario(async (db) => {
        await ensureAdminItemsPermissions(db);
        const actor = await adminAal1(db);
        expect(actor.aal).toBe('aal1');
        const item = await seedHomeItem(db, `write-${vp.name}`, 'published');
        const updatedName = uniqueTag(`updated-${vp.name}`);
        try {
          const headers = restHeaders(actor.accessToken);

          const before = await readHomeItemNames(page);
          expect(before, '足した公開の商品がホームの ITEM の節に出ている（前提）').toContain(item.name);

          // JWT 自体は通っている（その公開の商品を読める）うえで、書く道が閉じていることを確かめる
          const readable = await request.get(restUrl('items', `?select=id&id=eq.${item.id}`), { headers, failOnStatusCode: false });
          expect(readable.status(), 'aal1 の JWT で公開の商品は読める').toBe(200);
          expect((await jsonRows(readable)).length, 'aal1 の JWT で公開の商品は読める（件数）').toBe(1);

          const updated = await request.patch(restUrl('items', `?id=eq.${item.id}`), {
            headers,
            data: { name: updatedName },
            failOnStatusCode: false,
          });
          await expectDeniedOrZero(updated, 'update');

          const deleted = await request.delete(restUrl('items', `?id=eq.${item.id}`), { headers, failOnStatusCode: false });
          await expectDeniedOrZero(deleted, 'delete');

          // DB の行が変わっていない
          const rows = await readItemRows([item.id], [updatedName]);
          expect(rows.map((row) => row.name), '行が消えず、名前も変わっていない').toEqual([item.name]);

          // その後のホームに元の名前のまま表示される
          const after = await readHomeItemNames(page);
          expect(after, 'ホームに元の名前のまま表示される').toContain(item.name);
          expect(after, 'ホームに update 後の名前が表示されない').not.toContain(updatedName);
        } finally {
          await cleanupHomeRows(db, [item.id], { itemNames: [updatedName] });
        }
      }));
    });
  });
}

test.describe('FR-HOME-024 anon の鍵と一般会員の JWT で items の原価と注記を直接読む', () => {
  test('SEC-HOME-004-AC-01: anon の鍵と一般会員の JWT で pattern_cost・mass_production_cost を select すると、どちらも権限の誤りで終わり、原価の値が返らない（product_note は公開の列として読める）', async ({ request }) => {
    test.setTimeout(120_000);
    requireLocalSupabase();
    const member = await memberActor();
    // 公開の商品を足している間は、ホームの公開の件数・並びを読むほかの試験と重ならないよう排他の lock を持つ
    await withHomeCatalogLock('exclusive', async () => {
      const item = await withLocalDb((db) => seedHomeItem(db, 'cost', 'published'));
      const secrets = [COST_VALUES.pattern, COST_VALUES.massProduction];
      try {
        const callers = [
          { label: 'anon の鍵', token: ANON_KEY },
          { label: '一般会員の JWT', token: member.accessToken },
        ];
        for (const caller of callers) {
          const headers = restHeaders(caller.token);

          // 鍵自体は通っている（公開の商品の名前は読める）ので、拒否は列の権限による
          const control = await request.get(restUrl('items', `?select=id,name&id=eq.${item.id}`), { headers, failOnStatusCode: false });
          expect(control.status(), `${caller.label}: 公開の列は読める`).toBe(200);
          expect((await jsonRows(control)).map((row) => row.name), `${caller.label}: 公開の列は読める（名前）`).toEqual([item.name]);

          // product_note はお客さん向けの注意書きで公開の列（Q7）。対照として 200 で値が返る
          const note = await request.get(restUrl('items', `?select=id,product_note&id=eq.${item.id}`), { headers, failOnStatusCode: false });
          expect(note.status(), `${caller.label}: product_note は公開の列として読める`).toBe(200);
          expect((await jsonRows(note)).map((row) => row.product_note), `${caller.label}: product_note は公開の列として読める（値）`).toEqual([item.note]);

          const columnSets = ['pattern_cost,mass_production_cost', 'pattern_cost', 'mass_production_cost'];
          for (const columns of columnSets) {
            const response = await request.get(restUrl('items', `?select=${columns}&id=eq.${item.id}`), { headers, failOnStatusCode: false });
            expectPermissionError(response, `${caller.label}: select=${columns}`);
            await expectNoLeak(response, `${caller.label}: select=${columns}`, secrets);
          }
        }
      } finally {
        await withLocalDb((db) => cleanupHomeRows(db, [item.id]));
      }
    });
  });
});

type AnonWrite = 'insert' | 'update' | 'delete';

/**
 * anon の鍵で items に指定の書き込みを送り、どれも権限の誤りで終わることと、DB の行・その後のホームの表示が変わらないことを確かめる。
 * 前後のホームの並びを比べるので、公開の商品を足し引きするほかの HOME の試験と重ならないよう排他の lock を持つ。
 */
async function expectAnonWritesDenied(
  request: APIRequestContext,
  page: Page,
  vp: (typeof VIEWPORTS)[number],
  operations: AnonWrite[],
): Promise<void> {
  requireLocalSupabase();
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await withHomeCatalogLock('exclusive', async () => {
    const item = await withLocalDb((db) => seedHomeItem(db, `anon-${vp.name}`, 'published'));
    const insertName = uniqueTag(`insert-${vp.name}`);
    const updatedName = uniqueTag(`updated-${vp.name}`);
    try {
      const headers = restHeaders(ANON_KEY);

      const before = await readHomeItemNames(page);
      expect(before, '足した公開の商品がホームの ITEM の節に出ている（前提）').toContain(item.name);

      if (operations.includes('insert')) {
        const inserted = await request.post(restUrl('items'), {
          headers,
          data: { name: insertName, description: 'E2E', price: 1000, category: 'TOPS', image_url: 'https://example.com/e2e.png', status: 'published' },
          failOnStatusCode: false,
        });
        expectPermissionError(inserted, 'anon の insert');
      }

      if (operations.includes('update')) {
        const updated = await request.patch(restUrl('items', `?id=eq.${item.id}`), {
          headers,
          data: { name: updatedName },
          failOnStatusCode: false,
        });
        expectPermissionError(updated, 'anon の update');
      }

      if (operations.includes('delete')) {
        const deleted = await request.delete(restUrl('items', `?id=eq.${item.id}`), { headers, failOnStatusCode: false });
        expectPermissionError(deleted, 'anon の delete');
      }

      // DB の行が変わっていない
      const rows = await readItemRows([item.id], [insertName, updatedName]);
      expect(rows.map((row) => row.name), '行が消えず、名前も変わらず、insert した行も無い').toEqual([item.name]);

      // その後のホームの表示が変わらない
      const after = await readHomeItemNames(page);
      expect(after, 'ホームの商品の名前の並びが変わらない').toEqual(before);
      expect(after, 'ホームに insert した商品が表示されない').not.toContain(insertName);
      expect(after, 'ホームに update 後の名前が表示されない').not.toContain(updatedName);
    } finally {
      await withLocalDb((db) => cleanupHomeRows(db, [item.id], { itemNames: [insertName, updatedName] }));
    }
  });
}

// SEC-HOME-005-AC-01 は insert と update・delete を、片方の失敗がもう片方を隠さないよう別の試験にする。
for (const vp of VIEWPORTS) {
  test.describe(`FR-HOME-024 anon の鍵で items を直接書く (${vp.name})`, () => {
    test(`SEC-HOME-005-AC-01 ${vp.name}: anon の鍵の items への insert が権限の誤りで終わり、その後のホームの表示が変わらない`, async ({ request, page }) => {
      test.setTimeout(120_000);
      await expectAnonWritesDenied(request, page, vp, ['insert']);
    });

    test(`SEC-HOME-005-AC-01 ${vp.name}: anon の鍵の items への update・delete が、どちらも権限の誤りで終わり、その後のホームの表示が変わらない`, async ({ request, page }) => {
      test.setTimeout(120_000);
      await expectAnonWritesDenied(request, page, vp, ['update', 'delete']);
    });
  });
}

test.describe('FR-HOME-024 anon の鍵と一般会員の JWT で item_cost_history を直接読み書きする', () => {
  test('SEC-HOME-020-AC-01: anon の鍵の item_cost_history への select・insert・update・delete が権限の誤りで終わり、一般会員の JWT の select が 200 で 0 件、insert・update・delete が権限の誤りで終わり、どちらでも原価の値が返らず行が変わらない', async ({ request }) => {
    requireLocalSupabase();
    const member = await memberActor();
    const { item, history } = await withLocalDb(async (db) => {
      const seeded = await seedHomeItem(db, 'history', 'private');
      return { item: seeded, history: await seedCostHistory(db, seeded.id, 'history') };
    });
    const insertKeys: string[] = [];
    try {
      const callers = [
        { label: 'anon の鍵', token: ANON_KEY },
        { label: '一般会員の JWT', token: member.accessToken },
      ];
      const secrets = [COST_HISTORY_VALUES.pattern, COST_HISTORY_VALUES.massProduction, history.seasonKey, history.pdfUrl];
      for (const [index, caller] of callers.entries()) {
        const headers = restHeaders(caller.token);

        const selected = await request.get(
          restUrl('item_cost_history', `?select=id,season_key,pattern_cost,mass_production_cost,pdf_url&id=eq.${history.id}`),
          { headers, failOnStatusCode: false },
        );
        if (caller.token === ANON_KEY) {
          expectPermissionError(selected, `${caller.label}: select`);
        } else {
          // 一般会員は表の SELECT 権限を持つが、admin.finance.read の方針で行が1件も見えない
          expect(selected.status(), `${caller.label}: select は 200`).toBe(200);
          expect(await jsonRows(selected), `${caller.label}: select は 0 件`).toHaveLength(0);
        }
        await expectNoLeak(selected, `${caller.label}: select`, secrets);

        const insertKey = uniqueTag(`history-insert-${index}`);
        insertKeys.push(insertKey);
        const inserted = await request.post(restUrl('item_cost_history'), {
          headers,
          data: { item_id: item.id, season_key: insertKey, pattern_cost: 1, mass_production_cost: 2 },
          failOnStatusCode: false,
        });
        expectPermissionError(inserted, `${caller.label}: insert`);
        await expectNoLeak(inserted, `${caller.label}: insert`, secrets);

        const updated = await request.patch(restUrl('item_cost_history', `?id=eq.${history.id}`), {
          headers,
          data: { pattern_cost: 999 },
          failOnStatusCode: false,
        });
        expectPermissionError(updated, `${caller.label}: update`);
        await expectNoLeak(updated, `${caller.label}: update`, secrets);

        const deleted = await request.delete(restUrl('item_cost_history', `?id=eq.${history.id}`), { headers, failOnStatusCode: false });
        expectPermissionError(deleted, `${caller.label}: delete`);
        await expectNoLeak(deleted, `${caller.label}: delete`, secrets);
      }

      // DB の行が変わっていない（行がある・値が元のまま・insert した行が無い）
      const state = await withLocalDb(async (db) => {
        const rows = await db.query(
          'select pattern_cost, mass_production_cost, pdf_url, season_key from public.item_cost_history where id = $1::bigint',
          [history.id],
        );
        const inserted = await db.query('select id from public.item_cost_history where season_key = any($1::text[])', [insertKeys]);
        return { rows: rows.rows, inserted: inserted.rows };
      });
      expect(state.rows, '原価の履歴の行が消えず、値が元のまま').toEqual([
        {
          pattern_cost: history.patternCost,
          mass_production_cost: history.massProductionCost,
          pdf_url: history.pdfUrl,
          season_key: history.seasonKey,
        },
      ]);
      expect(state.inserted, 'insert した行が DB に無い').toHaveLength(0);
    } finally {
      await withLocalDb((db) => cleanupHomeRows(db, [item.id], { seasonKeys: insertKeys }));
    }
  });
});
