/** @jest-environment node */
export {};

const { Client } = require('pg');

/**
 * 配送先スナップショットの版番号（FREQ-365、レビュー指摘⑤）。
 *
 * 配送先は3経路（画面のデバウンス同期・確定直前の同期・create-session の再利用）から
 * 書き換わる。無条件の上書きだと、遅れて届いた古い内容が新しい内容を消してしまい、
 * 古い住所のまま支払い済みの注文ができる（lost update）。
 *
 * 対策は「クライアントが見た版と一致するときだけ書く」1文の条件付き更新。
 * RFC 9110 の条件付きリクエスト（If-Match）と同じ考え方で、Read Committed の
 * Postgres は競合した更新の条件を評価し直すため、勝つのは必ず片方だけになる。
 *
 * 実行方法（ローカル Supabase を起動しておく: npm run db:start）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/checkout_draft_shipping_revision
 */

const DATABASE_URL = process.env.DATABASE_URL;

function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const CONDITIONAL_UPDATE = `
  update public.checkout_drafts
  set shipping_snapshot = $1::jsonb,
      shipping_revision = $2::bigint + 1
  where id = $3::uuid
    and status <> 'completed'
    and shipping_revision = $2::bigint
  returning shipping_revision
`;

describe('integration: checkout_drafts.shipping_revision', () => {
  if (!DATABASE_URL) {
    test.skip('DATABASE_URL 未設定のためスキップ', () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test('使い捨ての DB 以外では実行しない', () => {
      throw new Error('localhost 以外の DATABASE_URL では実行しない');
    });
    return;
  }

  let clientA: any;
  let clientB: any;

  beforeAll(async () => {
    clientA = new Client({ connectionString: DATABASE_URL });
    clientB = new Client({ connectionString: DATABASE_URL });
    await clientA.connect();
    await clientB.connect();
  });

  afterAll(async () => {
    if (clientA) await clientA.end();
    if (clientB) await clientB.end();
  });

  async function createDraft(): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const draft = await clientA.query(
      `insert into public.checkout_drafts
         (session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency,
          shipping_snapshot, items_snapshot)
       values ($1, 'stripe_card', 1000, 0, 1000, 'jpy', $2::jsonb, '[]'::jsonb)
       returning id, shipping_revision`,
      [`revision-session-${suffix}`, JSON.stringify({ address: '旧住所' })],
    );

    expect(Number(draft.rows[0].shipping_revision)).toBe(0);
    return draft.rows[0].id;
  }

  async function readDraft(draftId: string) {
    const res = await clientA.query(
      'select shipping_snapshot, shipping_revision from public.checkout_drafts where id = $1',
      [draftId],
    );
    return {
      address: res.rows[0].shipping_snapshot?.address ?? null,
      revision: Number(res.rows[0].shipping_revision),
    };
  }

  test('見た版と一致する書き込みだけが適用され、古い版の書き込みは無視される', async () => {
    const draftId = await createDraft();

    // 新しい入力が先に届く
    const first = await clientA.query(CONDITIONAL_UPDATE, [
      JSON.stringify({ address: '新住所' }),
      0,
      draftId,
    ]);
    expect(first.rowCount).toBe(1);
    expect(Number(first.rows[0].shipping_revision)).toBe(1);

    // 遅れて届いた古い入力（版 0 を見たまま）
    const stale = await clientA.query(CONDITIONAL_UPDATE, [
      JSON.stringify({ address: '古い住所' }),
      0,
      draftId,
    ]);
    expect(stale.rowCount).toBe(0);

    expect(await readDraft(draftId)).toEqual({ address: '新住所', revision: 1 });
  }, 60000);

  test('同じ版を見た2つの書き込みが同時に走っても、勝つのは片方だけ', async () => {
    const draftId = await createDraft();

    await clientA.query('begin');
    const fromA = await clientA.query(CONDITIONAL_UPDATE, [
      JSON.stringify({ address: 'A の住所' }),
      0,
      draftId,
    ]);
    expect(fromA.rowCount).toBe(1);

    // B は A のコミットを待ってから条件を評価し直す
    const fromBPromise = clientB.query(CONDITIONAL_UPDATE, [
      JSON.stringify({ address: 'B の住所' }),
      0,
      draftId,
    ]);

    await clientA.query('commit');
    const fromB = await fromBPromise;

    expect(fromB.rowCount).toBe(0);
    expect(await readDraft(draftId)).toEqual({ address: 'A の住所', revision: 1 });
  }, 60000);

  test('確定済みの draft は書き換えられない', async () => {
    const draftId = await createDraft();
    await clientA.query("update public.checkout_drafts set status = 'completed' where id = $1", [
      draftId,
    ]);

    const result = await clientA.query(CONDITIONAL_UPDATE, [
      JSON.stringify({ address: '確定後の住所' }),
      0,
      draftId,
    ]);

    expect(result.rowCount).toBe(0);
    expect(await readDraft(draftId)).toEqual({ address: '旧住所', revision: 0 });
  }, 60000);
});
