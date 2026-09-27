/** @jest-environment node */
export {};

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;

jest.setTimeout(60000);

function isLocalDatabase(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const COMPAT_SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260925000132_add_checkout_session_claim_rpcs.sql",
  ),
  "utf8",
);
const HARDENING_SQL = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/pending/harden_checkout_session_claims.sql",
  ),
  "utf8",
);
const CLEANUP_SQL = `
BEGIN;
DROP FUNCTION IF EXISTS public.claim_checkout_draft(
  text, smallint, text, text, text, text, text, integer, integer, integer, integer, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.attach_checkout_session_to_draft(
  uuid, text, smallint, text, text
);
DROP FUNCTION IF EXISTS public.retire_expired_checkout_draft(
  uuid, text, text, smallint, text
);
DROP INDEX IF EXISTS public.checkout_drafts_active_request_key;
ALTER TABLE public.checkout_drafts
  DROP CONSTRAINT IF EXISTS checkout_drafts_request_identity_check,
  DROP CONSTRAINT IF EXISTS checkout_drafts_tax_amount_check,
  DROP COLUMN IF EXISTS checkout_request_version,
  DROP COLUMN IF EXISTS checkout_request_fingerprint,
  DROP COLUMN IF EXISTS checkout_ui_mode,
  DROP COLUMN IF EXISTS checkout_origin,
  DROP COLUMN IF EXISTS tax_amount;
GRANT INSERT ON TABLE public.checkout_drafts TO anon, authenticated, service_role;
COMMIT;
`;

describe("integration: Checkout Session draft claim", () => {
  if (!DATABASE_URL) {
    test.skip("DATABASE_URL 未設定のためスキップ", () => {});
    return;
  }

  if (!isLocalDatabase(DATABASE_URL)) {
    test("使い捨てのDB以外では実行しない", () => {
      throw new Error("localhost 以外の DATABASE_URL では実行しない");
    });
    return;
  }

  let clientA: any;
  let clientB: any;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    clientA = new Client({ connectionString: DATABASE_URL });
    clientB = new Client({ connectionString: DATABASE_URL });
    await clientA.connect();
    await clientB.connect();
    await clientA.query(CLEANUP_SQL);
    await clientA.query(COMPAT_SQL);
    await clientA.query(HARDENING_SQL);
  });

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await clientA.query(
        "delete from public.checkout_drafts where session_id = any($1::text[])",
        [sessionIds.splice(0)],
      );
    }
  });

  afterAll(async () => {
    if (clientA) await clientA.query(CLEANUP_SQL);
    if (clientA) await clientA.end();
    if (clientB) await clientB.end();
  });

  function fixture() {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = `claim-session-${suffix}`;
    sessionIds.push(sessionId);
    return {
      sessionId,
      fingerprint: `v1:${"a".repeat(64)}`,
      items: [
        {
          source_cart_id: `cart-${suffix}`,
          item_id: 1,
          item_name: "競合テスト商品",
          item_price: 1000,
          item_image_url: null,
          color: "BLACK",
          size: "M",
          quantity: 1,
          line_total: 1000,
        },
      ],
    };
  }

  function claim(
    client: any,
    row: ReturnType<typeof fixture>,
    subtotal = 1000,
  ) {
    return client.query(
      `select *
       from public.claim_checkout_draft(
         $1::text,
         1::smallint,
         $2::text,
         'custom'::text,
         'http://localhost:3000'::text,
         'stripe_card'::text,
         'jpy'::text,
         $3::integer,
         0::integer,
         0::integer,
         $3::integer,
         null::jsonb,
         $4::jsonb
       )`,
      [row.sessionId, row.fingerprint, subtotal, JSON.stringify(row.items)],
    );
  }

  test("同一要求を同時にclaimしても1行と同じdraft IDへ収束する", async () => {
    const row = fixture();

    const [first, second] = await Promise.all([
      claim(clientA, row),
      claim(clientB, row),
    ]);

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    expect(first.rows[0].id).toBe(second.rows[0].id);
    expect(
      [first.rows[0].claim_created, second.rows[0].claim_created].sort(),
    ).toEqual([false, true]);

    const persisted = await clientA.query(
      `select count(*)::int as count
       from public.checkout_drafts
       where session_id = $1
         and checkout_request_version = 1
         and checkout_request_fingerprint = $2`,
      [row.sessionId, row.fingerprint],
    );
    expect(persisted.rows[0].count).toBe(1);
  });

  test("同じfingerprintを異なる正規データへ再利用すると拒否する", async () => {
    const row = fixture();
    await claim(clientA, row);

    const changedItems = [
      { ...row.items[0], item_price: 1100, line_total: 1100 },
    ];
    await expect(
      clientA.query(
        `select *
         from public.claim_checkout_draft(
           $1::text, 1::smallint, $2::text, 'custom'::text,
           'http://localhost:3000'::text, 'stripe_card'::text, 'jpy'::text,
           1100, 0, 0, 1100, null::jsonb, $3::jsonb
         )`,
        [row.sessionId, row.fingerprint, JSON.stringify(changedItems)],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("CHECKOUT_FINGERPRINT_MISMATCH"),
    });
  });

  test("Session IDは未設定または同じIDだけを受け入れ、異なるIDで上書きしない", async () => {
    const row = fixture();
    const claimed = await claim(clientA, row);
    const draftId = claimed.rows[0].id;

    const first = await clientA.query(
      `select * from public.attach_checkout_session_to_draft(
         $1::uuid, $2::text, 1::smallint, $3::text, 'cs_canonical'::text
       )`,
      [draftId, row.sessionId, row.fingerprint],
    );
    const retry = await clientA.query(
      `select * from public.attach_checkout_session_to_draft(
         $1::uuid, $2::text, 1::smallint, $3::text, 'cs_canonical'::text
       )`,
      [draftId, row.sessionId, row.fingerprint],
    );
    const conflict = await clientA.query(
      `select * from public.attach_checkout_session_to_draft(
         $1::uuid, $2::text, 1::smallint, $3::text, 'cs_other'::text
       )`,
      [draftId, row.sessionId, row.fingerprint],
    );

    expect(first.rows).toEqual([
      { checkout_session_id: "cs_canonical", attached: true },
    ]);
    expect(retry.rows).toEqual([
      { checkout_session_id: "cs_canonical", attached: false },
    ]);
    expect(conflict.rows).toEqual([]);

    const persisted = await clientA.query(
      "select checkout_session_id from public.checkout_drafts where id = $1",
      [draftId],
    );
    expect(persisted.rows[0].checkout_session_id).toBe("cs_canonical");
  });

  test("expired退役は完全一致したcreated行だけを変更し、同じ要求を新しいdraftへ進める", async () => {
    const row = fixture();
    const claimed = await claim(clientA, row);
    const draftId = claimed.rows[0].id;

    await clientA.query(
      `select * from public.attach_checkout_session_to_draft(
         $1::uuid, $2::text, 1::smallint, $3::text, 'cs_expired'::text
       )`,
      [draftId, row.sessionId, row.fingerprint],
    );

    const wrongFingerprint = await clientA.query(
      `select public.retire_expired_checkout_draft(
         $1::uuid, $2::text, 'cs_expired'::text, 1::smallint, $3::text
       ) as changed`,
      [draftId, row.sessionId, `v1:${"b".repeat(64)}`],
    );
    expect(wrongFingerprint.rows[0].changed).toBe(false);

    const retired = await clientA.query(
      `select public.retire_expired_checkout_draft(
         $1::uuid, $2::text, 'cs_expired'::text, 1::smallint, $3::text
       ) as changed`,
      [draftId, row.sessionId, row.fingerprint],
    );
    expect(retired.rows[0].changed).toBe(true);

    const replacement = await claim(clientA, row);
    expect(replacement.rows[0].id).not.toBe(draftId);
    expect(replacement.rows[0].claim_created).toBe(true);

    const statuses = await clientA.query(
      `select id, status
       from public.checkout_drafts
       where session_id = $1
       order by created_at, id`,
      [row.sessionId],
    );
    expect(statuses.rows).toEqual(
      expect.arrayContaining([
        { id: draftId, status: "failed" },
        { id: replacement.rows[0].id, status: "created" },
      ]),
    );
  });

  test("許可していない支払方法はservice-role RPCでも拒否する", async () => {
    const row = fixture();

    await expect(
      clientA.query(
        `select *
         from public.claim_checkout_draft(
           $1::text, 1::smallint, $2::text, 'custom'::text,
           'http://localhost:3000'::text, 'cash'::text, 'jpy'::text,
           1000, 0, 0, 1000, null::jsonb, $3::jsonb
         )`,
        [row.sessionId, row.fingerprint, JSON.stringify(row.items)],
      ),
    ).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining("INVALID_CHECKOUT_DRAFT_CLAIM"),
    });
  });

  test("互換マイグレーションは既存列を黙って受け入れず失敗する", async () => {
    try {
      await expect(clientB.query(COMPAT_SQL)).rejects.toMatchObject({
        code: "42701",
      });
    } finally {
      await clientB.query("ROLLBACK");
    }
  });

  test("3つのRPCはservice role専用で、hardening後は直接INSERTを拒否する", async () => {
    const privileges = await clientA.query(
      `select
         has_function_privilege(
           'anon',
           'public.claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb)',
           'EXECUTE'
         ) as anon_can_claim,
         has_function_privilege(
           'authenticated',
           'public.claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb)',
           'EXECUTE'
         ) as authenticated_can_claim,
         has_function_privilege(
           'service_role',
           'public.claim_checkout_draft(text,smallint,text,text,text,text,text,integer,integer,integer,integer,jsonb,jsonb)',
           'EXECUTE'
         ) as service_can_claim,
         has_function_privilege(
           'anon',
           'public.attach_checkout_session_to_draft(uuid,text,smallint,text,text)',
           'EXECUTE'
         ) as anon_can_attach,
         has_function_privilege(
           'authenticated',
           'public.attach_checkout_session_to_draft(uuid,text,smallint,text,text)',
           'EXECUTE'
         ) as authenticated_can_attach,
         has_function_privilege(
           'service_role',
           'public.attach_checkout_session_to_draft(uuid,text,smallint,text,text)',
           'EXECUTE'
         ) as service_can_attach,
         has_function_privilege(
           'anon',
           'public.retire_expired_checkout_draft(uuid,text,text,smallint,text)',
           'EXECUTE'
         ) as anon_can_retire,
         has_function_privilege(
           'authenticated',
           'public.retire_expired_checkout_draft(uuid,text,text,smallint,text)',
           'EXECUTE'
         ) as authenticated_can_retire,
         has_function_privilege(
           'service_role',
           'public.retire_expired_checkout_draft(uuid,text,text,smallint,text)',
           'EXECUTE'
         ) as service_can_retire,
         has_table_privilege('anon', 'public.checkout_drafts', 'INSERT') as anon_can_insert,
         has_table_privilege('authenticated', 'public.checkout_drafts', 'INSERT') as authenticated_can_insert,
         has_table_privilege('service_role', 'public.checkout_drafts', 'INSERT') as service_can_insert`,
    );

    expect(privileges.rows[0]).toEqual({
      anon_can_claim: false,
      authenticated_can_claim: false,
      service_can_claim: true,
      anon_can_attach: false,
      authenticated_can_attach: false,
      service_can_attach: true,
      anon_can_retire: false,
      authenticated_can_retire: false,
      service_can_retire: true,
      anon_can_insert: false,
      authenticated_can_insert: false,
      service_can_insert: false,
    });

    const nullability = await clientA.query(
      `select column_name, is_nullable
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'checkout_drafts'
         and column_name in (
           'checkout_request_version',
           'checkout_request_fingerprint'
         )
       order by column_name`,
    );
    expect(nullability.rows).toEqual([
      {
        column_name: "checkout_request_fingerprint",
        is_nullable: "NO",
      },
      {
        column_name: "checkout_request_version",
        is_nullable: "NO",
      },
    ]);
  });
});
