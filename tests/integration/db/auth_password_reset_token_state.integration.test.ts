/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb } from './helpers/local-db';

/**
 * AUTH の再設定の印の状態（STATE-AUTH-002）。
 * 申請・リンクの確かめ・パスワード変更の消費が行に当てる条件を、窓口と同じ形の SQL で確かめる。
 * 手元の使い捨て DB でだけ流す。取引の中の試験は最後に巻き戻し、並行の試験は自分で作った行を自分で消す。
 */
describeLocalDb('integration: AUTH の再設定の印の状態', (db) => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const TEN_MINUTES = 10;
  let marker: string;
  let email: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-auth-reset-state-${randomUUID()}`;
    email = `${marker}@example.com`;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  /** 申請の窓口と同じ形で印を作る。minutes が負なら期限切れの印になる。 */
  async function issue(token: string, minutes = TEN_MINUTES, to = email): Promise<string> {
    const result = await db().query(
      `insert into public.password_reset_tokens (email, token_hash, expires_at, used)
       values ($1, $2, now() + make_interval(mins => $3), false) returning id::text as id`,
      [to, sha256(token), minutes],
    );
    return result.rows[0].id;
  }

  /** 申請の窓口が新しい印の前に、同じ宛先の未使用の印を使用済みにする。 */
  async function invalidatePrevious(to = email): Promise<number> {
    return (await db().query('update public.password_reset_tokens set used = true where email = $1 and used = false', [to]))
      .rowCount;
  }

  /** リンクの窓口の確かめ。未使用で期限の内の行だけを有効とみなす。 */
  async function lookup(token: string): Promise<{ id: string; email: string } | undefined> {
    const result = await db().query(
      `select id::text as id, email from public.password_reset_tokens
       where token_hash = $1 and used = false and expires_at >= now()`,
      [sha256(token)],
    );
    return result.rows[0];
  }

  /** パスワード変更の窓口の消費。未使用の時だけ使用済みにして、勝てたら1行返る。 */
  async function claim(id: string): Promise<number> {
    return (
      await db().query('update public.password_reset_tokens set used = true where id = $1 and used = false returning id', [id])
    ).rowCount;
  }

  async function row(id: string): Promise<{ used: boolean; expires_at: Date; email: string } | undefined> {
    const result = await db().query('select used, expires_at, email from public.password_reset_tokens where id = $1', [id]);
    return result.rows[0];
  }

  async function ids(): Promise<string[]> {
    const result = await db().query('select id::text as id from public.password_reset_tokens where email = $1', [email]);
    return result.rows.map((found: { id: string }) => found.id).sort();
  }

  test('STATE-AUTH-002 申請で作った印は未使用から始まり、期限は作った時から10分後', async () => {
    const id = await issue('fresh');

    const created = await db().query(
      `select used, expires_at - created_at as ttl from public.password_reset_tokens where id = $1`,
      [id],
    );
    expect(created.rows[0].used).toBe(false);
    expect(created.rows[0].ttl).toMatchObject({ minutes: TEN_MINUTES });
    expect(await lookup('fresh')).toEqual({ id, email });
  });

  test('STATE-AUTH-002 同じ宛先の新しい申請で、前の未使用の印は使用済みになり、有効なのは新しい1本だけ', async () => {
    const previous = await issue('first');

    expect(await invalidatePrevious()).toBe(1);
    const latest = await issue('second');

    expect((await row(previous))?.used).toBe(true);
    expect((await row(latest))?.used).toBe(false);
    expect(await lookup('first')).toBeUndefined();
    expect(await lookup('second')).toEqual({ id: latest, email });
  });

  test('STATE-AUTH-002 新しい申請は別の宛先の未使用の印を使用済みにしない', async () => {
    const mine = await issue('mine');
    const theirs = await issue('theirs', TEN_MINUTES, `${marker}-other@example.com`);

    await invalidatePrevious();

    expect((await row(mine))?.used).toBe(true);
    expect((await row(theirs))?.used).toBe(false);
  });

  test('STATE-AUTH-002 すでに使用済みの印への前の印の無効化は何も変えず、0行を返す', async () => {
    const id = await issue('consumed');
    await claim(id);

    expect(await invalidatePrevious()).toBe(0);
    expect((await row(id))?.used).toBe(true);
  });

  test('STATE-AUTH-002 リンクの確かめは行を変えず、何度確かめても未使用のまま', async () => {
    const id = await issue('read-only');
    const before = await row(id);

    expect(await lookup('read-only')).toEqual({ id, email });
    expect(await lookup('read-only')).toEqual({ id, email });

    expect(await row(id)).toEqual(before);
  });

  test('STATE-AUTH-002 期限の切れた印はリンクの確かめで無効になるが、行は残り使用の印も変わらない', async () => {
    const id = await issue('expired', -1);

    expect(await lookup('expired')).toBeUndefined();
    expect((await row(id))?.used).toBe(false);
  });

  test('STATE-AUTH-002 期限ちょうどの印はまだ有効で、期限を1分でも過ぎると無効', async () => {
    const onTheEdge = await issue('edge', 0);
    await issue('over', -1);

    expect(await lookup('edge')).toEqual({ id: onTheEdge, email });
    expect(await lookup('over')).toBeUndefined();
  });

  test('STATE-AUTH-002 使用済みの印はリンクの確かめで無効になる', async () => {
    const id = await issue('used-up');
    await claim(id);

    expect(await lookup('used-up')).toBeUndefined();
  });

  test('STATE-AUTH-002 存在しない印は確かめで見つからない', async () => {
    expect(await lookup(`${marker}-unknown`)).toBeUndefined();
  });

  test('STATE-AUTH-002 パスワード変更の消費は1回目だけ成功し、2回目は0行で使用済みのまま', async () => {
    const id = await issue('claim-once');

    expect(await claim(id)).toBe(1);
    expect(await claim(id)).toBe(0);
    expect((await row(id))?.used).toBe(true);
  });

  test('STATE-AUTH-002 消費は期限を見ない。期限が過ぎた未使用の印でも使用済みにできる', async () => {
    const id = await issue('claim-expired', -1);

    expect(await claim(id)).toBe(1);
    expect((await row(id))?.used).toBe(true);
  });

  test('STATE-AUTH-002 新しい申請で使用済みになった印は消費できない', async () => {
    const previous = await issue('superseded');
    await invalidatePrevious();

    expect(await claim(previous)).toBe(0);
  });

  test('STATE-AUTH-002 存在しない印の消費は0行を返す', async () => {
    expect(await claim(randomUUID())).toBe(0);
  });

  test('STATE-AUTH-002 消費の後に行を消すと、確かめにも消費にも現れない', async () => {
    const id = await issue('consume-then-delete');
    await claim(id);

    const deleted = await db().query('delete from public.password_reset_tokens where id = $1', [id]);

    expect(deleted.rowCount).toBe(1);
    expect(await row(id)).toBeUndefined();
    expect(await lookup('consume-then-delete')).toBeUndefined();
    expect(await claim(id)).toBe(0);
  });

  test('STATE-AUTH-002 使用済み・期限切れの行は掃除の関数が消し、有効な印は残す', async () => {
    const used = await issue('old-used');
    const expired = await issue('old-expired', -1);
    const live = await issue('old-live');
    await claim(used);
    await db().query(`update public.password_reset_tokens set created_at = now() - interval '30 days' where email = $1`, [email]);

    await db().query('select public.cleanup_password_reset_tokens(7)');

    const remaining = await ids();
    expect(remaining).toEqual([live]);
    expect(remaining).not.toContain(used);
    expect(remaining).not.toContain(expired);
  });

  test('STATE-AUTH-002 掃除の関数は作ってから保持の日数に届かない行を、使用済みでも残す', async () => {
    const used = await issue('recent-used');
    await claim(used);

    await db().query('select public.cleanup_password_reset_tokens(7)');

    expect(await ids()).toEqual([used]);
  });

  test('STATE-AUTH-002 同じ印を2つの接続が同時に消費しても、勝てるのは1つだけ', async () => {
    const first = await connectLocalDb();
    const second = await connectLocalDb();
    const claimSql = 'update public.password_reset_tokens set used = true where id = $1 and used = false returning id';
    let id: string | undefined;
    try {
      // この試験だけは接続をまたぐので確定した行で動かし、finally で必ず消す。
      id = (
        await first.query(
          `insert into public.password_reset_tokens (email, token_hash, expires_at)
           values ($1, $2, now() + interval '10 minutes') returning id::text as id`,
          [email, sha256(`${marker}-race`)],
        )
      ).rows[0].id;

      await first.query('begin');
      const winner = await first.query(claimSql, [id]);
      const loser = second.query(claimSql, [id]);
      // 後の接続が先の接続の行ロックを待つ間に確定させ、待っていた側が条件を見直す形にする。
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query('commit');

      expect(winner.rowCount).toBe(1);
      expect((await loser).rowCount).toBe(0);
      const stored = await first.query('select used from public.password_reset_tokens where id = $1', [id]);
      expect(stored.rows[0].used).toBe(true);
    } finally {
      await first.query('rollback').catch(() => undefined);
      if (id) await first.query('delete from public.password_reset_tokens where id = $1', [id]);
      await first.end();
      await second.end();
    }
  }, 20000);
});
