/** @jest-environment node */
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft } from './helpers/order-fixtures';

/**
 * 決済画面の期限（設計書 2-2、R-25）。開いてから30分ちょうどまで有効、30分を超えたら失効。
 * Stripe は30分未満の expires_at を受け付けないので、作成から30分30秒後を渡す。
 * Stripe の冪等キーは同じパラメータでしか再利用できないので、失効時刻は下書きに1回だけ決めて保存する。
 */
async function reserve(db: PgClient, draftId: string) {
  const res = await db.query('select public.reserve_checkout_session_expiry($1::uuid) as expires_at', [draftId]);
  return Number(res.rows[0].expires_at);
}

async function unattachedDraft(db: PgClient) {
  const fx = await createCatalogFixture(db, { stock: 1 });
  const draft = await createDraft(db, { itemId: fx.itemId, quantity: 1 });
  await db.query('update public.checkout_drafts set checkout_session_id = null where id = $1', [draft.draftId]);
  return draft;
}

describeLocalDb('integration: 決済画面の失効時刻', (db) => {
  test('作成から30分30秒後の Unix 秒を返し、15秒以内の再送には同じ値を返す', async () => {
    const draft = await unattachedDraft(db());
    const now = Math.floor(Date.now() / 1000);

    const first = await reserve(db(), draft.draftId);
    const second = await reserve(db(), draft.draftId);

    expect(first).toBeGreaterThanOrEqual(now + 1830 - 5);
    expect(first).toBeLessThanOrEqual(now + 1830 + 5);
    expect(second).toBe(first);
  });

  test('保存した値が30分15秒より近ければ、新しい値を決め直す', async () => {
    const draft = await unattachedDraft(db());
    await db().query(
      `update public.checkout_drafts set checkout_session_expires_at = now() + interval '30 minutes 10 seconds' where id = $1`,
      [draft.draftId],
    );
    const now = Math.floor(Date.now() / 1000);

    const renewed = await reserve(db(), draft.draftId);

    expect(renewed).toBeGreaterThanOrEqual(now + 1830 - 5);
  });

  test('Session を付けた下書きには決めない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });

    await expect(reserve(db(), draft.draftId)).rejects.toMatchObject({
      code: '22023',
      message: expect.stringContaining('CHECKOUT_DRAFT_NOT_RESERVABLE'),
    });
  });

  test('anon・authenticated は実行できない', async () => {
    for (const role of ['anon', 'authenticated']) {
      const res = await db().query('select has_function_privilege($1, $2, $3) as allowed', [
        role,
        'public.reserve_checkout_session_expiry(uuid)',
        'EXECUTE',
      ]);
      expect(res.rows[0].allowed).toBe(false);
    }
  });
});
