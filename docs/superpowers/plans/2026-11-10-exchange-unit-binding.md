# 交換の印を着そのものに結び付け、返金を手元に残る服の正しい値段から決める 実装計画

> 確認日: 2026-11-10。設計書（2026-11-10 オーナー承認、`2a9e06ef`）と、現状の調べ3本（作業場所の `research-db.md`・`research-ts.md`・`research-docs.md`）から書いた。DB・E2E は今回未実行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1着ずつの記録（着の枠）に状態・今の値段・交換の結びを持たせ、返品・交換・発送前の取り消しで返す額を「払った合計 − 手元に残る服の正しい値段 − 後の注文で外れた割引の分 − 手数料」の増えた分から決める。FREQ-641 の既知の点4つを消す。

**Architecture:** 注文の時に割引の写し（使った割引・事実・行の単価）と着の枠を DB に残す。返品・取り消しの時、サーバーの TypeScript が注文の時と同じ割引の計算（`src/lib/discounts/`）で正しい値段を出して「値段の計画」を作り、DB の入口の関数に渡す。DB は計画の版・上限・状態の移り方・割り振りの式を確かめ、出来事と1着ごとの行を記録し、H の取り押さえの列を出来事から書く。見込み（お客様の申し込み・管理の受け取り・管理の返金）は同じ計画の関数から出す。

**Tech Stack:** 今の Next.js 16、React 19、TypeScript、Zod、Supabase Postgres・PostgREST、Jest・React Testing Library、Playwright。依存を増やさない。

**Spec:** [承認済み設計書](../specs/2026-11-08-exchange-unit-binding-design.md)（2026-11-10 オーナー承認）を正とする。現状の調べは作業場所 `.superpowers/sdd/2026-11-10-exchange-unit-binding/` の `research-db.md`（DB）・`research-ts.md`（TS・画面）・`research-docs.md`（文書・番号）。

## 概要

| Task | 作る物 | 設計の節 | 主な確かめ |
| --- | --- | --- | --- |
| 1 | 要求の番号・要求の表 | 9章 | validate-docs |
| 2 | 移行 A: 表・注文の時の写し・前の注文の着数・理由の設定 | 2-2・2-3・4-1〜4-4 | DB 結合 |
| 3 | 値段の計画（TypeScript の純関数） | 2-1〜2-5・3章・5章 | 単体（例1〜例17） |
| 4 | 移行 B: 計画を確かめて記録する DB の芯 | 4-1・5章・7章 | DB 結合 |
| 5 | 移行 C: 受け取り・返金の結果・交換の結び | 2-3・4-1・5章・既知の点1・3・4 | DB 結合 |
| 6 | 移行 D: 相談後の返金・注文の返金・取り消し・前の注文から戻す | 2-2・2-3・5-2 Q7 | DB 結合 |
| 7 | サーバー: 材料・見込みの窓口・入口の窓口 | 6章・7章 | 単体 |
| 8 | 管理画面: 受け取り・返金の見込み・割引の扱いの欄 | 6-2・2-3 | RTL・画面結合 |
| 9 | お客様の画面: 申し込みの見込み・交換だけ・文 | 6-1・2-3 | RTL |
| 10 | E2E（新規と既存の直し） | 9章 | 本番ビルド・手元 DB・3幅 |
| 11 | 範囲外の正本・台帳 | — | validate-docs・report:traceability |
| 12 | 会計の計画3の前提を直す・会計のセッションへ知らせる | 5章・10-2 | 計画の静的確認 |

順番: Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12。Task 3 は DB に触らないので、Task 2 の DB 結合の実測を待つ間に進めてよい。正本（Task 11 の表）は各 Task の実装と同じコミットで直し、Task 11 は最後の突き合わせ。

## Global Constraints

- 正本は承認済み設計。返す額は「新しい E − それまでの E の最高（取り消した出来事を除く）」、0円より少なければ0円。起点は計算した E で、店長が変えた額は後に持ち越さない（2-1・J-8）。
- E ＝ 払った合計 − 手元に残る服の正しい値段 − 後の注文で外れた割引の分 − 手数料の累計。払った合計は `order_line_unit_amounts.paid_amount` の合計で送料を入れない。送料の返金・返送料・交換の手数料と送料は今と同じく E の外（2-5）。
- お店の側の事情（不良・誤送で送れず返金、発送前の取り消し、交換を返金に変えた時、店長が「お店の側」に直した行）は「数える籠 ＝ 手元にある着 ＋ お店の側で返した着」で出し直し、籠から割引の付いた着（計算した値段の安い方）を引き、手元に残る服だけで出し直した値段と比べて低い方を使う（2-2・J-1・J-15）。手数料を掛けず、前の注文から差し引かない。
- お客様のご都合は手元にある着だけで出し直す（全部の種類の割引、注文全体の割引の合計の条件、重ねた割引も注文の時と同じ計算。J-14）。
- 手数料を掛ける元の額 ＝ E′ − E′不備。E′ は手数料を引く前の E、E′不備はお客様のご都合で返した着をまだ手元にあるとみなした E′。返品ごとの率は、その出来事で増えた分に掛ける。端数は今と同じ切り捨て（`floor`）（2-4）。
- 前の注文から差し引く分は、お客様のご都合の返品で後の注文の累計の2着目割引が外れた時だけ。後の注文の「前の注文の着数」を今の数に直して出し直した値段 − 注文の時の数で出した値段。差し引いた注文の E が0円より少なくなる分は引かない。戻す時は後に引いた注文から（2-2・J-13）。
- 初期不良・誤送のご希望は `exchange_only`（設定の2行。店長は今のとおり設定の画面で変えられる）。在庫の無い交換は今のとおり `make`（2-3）。
- 1着の状態は一度だけ変わる。例外は、店が返金をやめた発送前の取り消しの着を「手元にある」へ戻すことだけ（7章・5-2 Q7）。返金の error・やり直しでは状態と割り振りを動かさない（4-1・Q6）。
- 割り振りの式: 出来事ごとに `Σ割り振り − Σ直し − その出来事の手数料 ＝ 新しい E − 前の出来事の E`。1着の割り振りの累計はその着の `paid_amount` 以下。返す着の割り振りは「その着の今の値段」と「払った額 − それまでの割り振り」の小さい方で、残りはその着の直し（0以下）にする。直しは仕訳にしない（2026-11-10 オーナー決定 Q1）が、記録は残す。
- 返す着の選び方: 同じ商品の空きの着のうち、今の値段がその着に当てる額にいちばん近い着、同じなら安い順・`unit_index` の順（J-12）。発送前の取り消しは `private.accounting_shipped_units` に無い着から、発送後の返品は有る着から（Q5）。交換の品の返品は、結びをたどった元の着（枠）に記録する（4-1）。
- 注文の時の写しが無い注文（この変更より前の注文）は今の計算のまま（4-3・AC-20）。DB は写しのある注文で計画が無い呼び出しを断る。
- サーバーは画面から額を受け取らない。店長が直す額は今と同じ別の欄（`refundAmount` など）で、上限は今と同じ「注文の返せる額」（7章）。
- 適用済みの移行は直さない。新しい移行は `20261108230000` より後で、作る時刻は実装の時に `supabase migration new` で決め、決まった版を Task 12 で会計のセッションへ知らせる。`BEGIN;` 1組、末尾の確かめの DO → `NOTIFY pgrst, 'reload schema';` → `COMMIT;`。UTF-8・BOM なし・LF・SQL はコメントも文字列も ASCII（日本語は `U&'\XXXX'`）。
- private の本体は postgres 所有・`SECURITY DEFINER SET search_path = ''`・`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`。入口だけ `GRANT EXECUTE ... TO service_role`。public の入口は同じ引数の `LANGUAGE sql SECURITY INVOKER SET search_path = ''`。新しい表は RLS・「deny direct client access」・`REVOKE ALL`・`GRANT SELECT ... TO service_role`、書くのは private の関数だけ。追記だけの表は UPDATE・DELETE・TRUNCATE を断るトリガーを付ける。
- G の共通の鍵 `pg_advisory_xact_lock(190521,1)` と `private.lock_group_g_inventory` の行の鍵の順を保つ。前の注文・後の注文に触る出来事は、関わる注文を全部 `lock_group_g_inventory` の注文の配列に入れて鍵を取る。
- `order_line_unit_amounts` の主キー・`unit_index`・`paid_amount` を変えず、行を消さず、列を足さない。取り押さえの列は `group_h_guard_unit_claim` が許す4つの関数名（`group_h_claim_refund_units`・`group_h_release_refund_units`・`group_h_claim_return_units`・`group_h_release_return_units`）の重ね定義（同じ名前・別の引数）からだけ書く（4-2）。
- 書き込みの窓口は 認可 → CSRF → 回数の制限 → 入力 → DB → 監査 の順を保つ。生の DB の誤り・メモ・お客様の情報を監査に足さない。見込みの窓口は読むだけで、回数の制限は今の返品の読む窓口と同じ。
- 番号: 要求は FREQ-642（`FREQ-642-REQ-01`、受け入れ条件は設計の AC-01〜AC-31 を `FREQ-642-AC-01`〜`FREQ-642-AC-31` に1対1）。E2E は FR-ADMIN-165・166、FR-ACCOUNT-048、FR-ITEM-DETAIL-070、FR-CHECKOUT-061、FR-LEGAL-008、FR-TERMS-007。作る直前に `ls e2e` と `rg -n "FR-(ADMIN|ACCOUNT|ITEM-DETAIL|CHECKOUT|LEGAL|TERMS)-[0-9]+" docs/superpowers/plans` で空きを取り直す（会計の予約: FREQ-575〜640、FR-ADMIN-128〜163、FR-ACCOUNT-047、FR-ITEM-DETAIL-069、FR-CHECKOUT-059・060、FR-LEGAL-007、FR-TERMS-006）。
- 返品は追跡の範囲（`scripts/trace/scope.json`）の外。正本は範囲外の表（CLAUDE.md）に従い、ADR は作らない。DD の番号は各ページ文書の次の番号（`16_admin.md` は DD-ADMIN-021 から）。
- E2E は手元の Supabase・3000番・本番ビルド（`next build && next start`）、mobile 390px・tablet 768px・desktop 1280px。dev の結果を合否に使わず、retries で隠さない。本番の DB に当てる・本番を読む作業はこの計画に入れない（未確認事項 1 は Task 2 Step 1 で手元の印だけ確かめ、本番の確認は調整役がオーナーの許可を得てから）。
- 書き手は単体・型・lint、調整役は手元 DB の reset・DB 結合・PostgREST・build・E2E を受け持つ。`.claude/CLAUDE.md`・`package.json`・`.superpowers/` の今の差分を保ち、コミットはパスを指定する。最後のコードの変更の後に調整役が `graphify update .` を1回だけ流す（コミットのフックが後ろで作り直す時は流さない）。
- 画面・窓口を作る前に関係するスキルと `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`・`15-route-handlers.md` を読む。

## Review Focus

- 同じお客様の2つの注文を2つの画面で同時に受け取る → 後の方は版の食い違い `UNIT_PRICING_STALE / 40001` で断られ、サーバーが材料を読み直して1回だけ作り直し、二重に数えない → Task 4 `FREQ-642-AC-17`・Task 7 `DD-ADMIN-022`。
- 結果がわからず同じ requestKey で送り直した時、その間に着の状態が変わっていても、計画を出し直さず前と同じ結果を返す（版を確かめる前に requestKey で探す） → Task 5 `FREQ-642-AC-17`・Task 7。
- 手元に残る着が0着、または残る小計が 50円未満 → 割引の計算の例外（`total_below_minimum`）で止まらず、0着は0円、50円未満は割引なしの単価の合計 → Task 3 `DD-ADMIN-021`。
- FREQ-641 の時に `return_line_id` で取り押さえた着を、別の返品で交換の品として返す → 取り押さえの守り（規則 e・f）に当たらず返金の記録が付く（元の着の `return_line_id` を外してから `refund_id` だけ付ける） → Task 5 `FREQ-642-AC-04`。
- 写しの無い古い注文で、新しい見込みの窓口と入口を通す → 今の計算と同じ額・同じ画面になり、計画を作らない → Task 7 `FREQ-642-AC-20`・Task 10。

---

### Task 1: 要求の番号と要求の表

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（FREQ-641 の節の後に FREQ-642 の節）

**Interfaces:**
- Produces: `FREQ-642`・`FREQ-642-REQ-01`・`FREQ-642-AC-01`〜`FREQ-642-AC-31`。AC の文は設計9章の同じ番号の「確かめること」を、検証できる形（〜が表示されること・〜円であること）に言い換える。後の Task は試験名の先頭にこの ID を使う。

- [ ] **Step 1: 空きの番号を確かめる。** `rg -n "FREQ-64[2-9]" docs` が0件、`ls e2e` で上の E2E の番号が空いていること。使われていたら次の空きに替え、ledger に Ruling を書く。
- [ ] **Step 2: requirements.md に FREQ-642 の節を足す。** 6列の表に1行（要求「返品・交換・発送前の取り消しの返金を手元に残る服の正しい値段から決め、交換の印を着そのものに結び付ける」、要件 REQ-01、受け入れ条件 AC-01〜AC-31 を `<br>` で並べる）。冒頭の確認日を直す。
- [ ] **Step 3: 確かめる。** Run: `npm.cmd run validate-docs` Expected: `Documentation validation passed`。
- [ ] **Step 4: コミット。**

```bash
git add docs/02_Requirements/requirements.md
git commit -m "docs(returns): 交換の印と手元に残る服の正しい値段の返金の要求 FREQ-642 を足す"
```

---

### Task 2: 移行 A — 表・注文の時の写し・前の注文の着数・理由の設定

**Files:**
- Create: `supabase/migrations/<tsA>_unit_binding_schema.sql`、`tests/integration/db/unit-binding-schema.integration.test.ts`
- Modify: `tests/integration/db/group_h_acceptance.integration.test.ts`、`tests/integration/db/group_h_context.integration.test.ts`、`tests/integration/db/group_h_migration_asserts.integration.test.ts`（取り替える関数の現行の本文の照合を新しい移行に向ける）、`tests/integration/db/helpers/group-h-fixtures.ts`（写しと枠を作る道具）
- Modify（正本）: `docs/03_BasicDesign/data/er.md`、`docs/06_Operations/db-migrations.md`
- Read: `supabase/migrations/20261029130300_group_h_discounts_acceptance.sql:127-188,1461-1548`、`20261029130100_group_h_discounts_admin.sql:134-146`、`20261012235910_order_return_records.sql:511-538`

**Interfaces:**
- Produces（表。すべて public、RLS、service_role は SELECT だけ）:
  - `order_discount_snapshots(order_id uuid PK FK orders RESTRICT, engine_version smallint NOT NULL, definitions jsonb NOT NULL, codes text[] NOT NULL, facts jsonb NOT NULL, lines jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`。追記だけ。`definitions` は注文で額が付いた割引（`discount_result.applied` の amount>0）の `private.group_h_definition(id)` の配列。`facts` は下書きの `discount_facts`（`priorUnitsByItem`・`buyer`・`at`・`hasPreviousOrder`・`hasFirstOrderReservation`・`usage`）。`lines` は `[{lineKey, orderItemId, itemId, unitPrice, quantity}]`（`line_kind='order'` の行、単価は `order_items.item_price`）。`codes` は使った割引コード。
  - `order_unit_slots(order_item_id uuid, unit_index integer, order_id uuid NOT NULL, item_id integer NOT NULL, state text NOT NULL DEFAULT 'kept' CHECK (state IN ('kept','returned_customer','returned_shop')), current_price integer NOT NULL CHECK (current_price >= 0), holder_order_item_id uuid NOT NULL FK order_items, holder_unit_index integer NOT NULL, last_event_id uuid NULL, PRIMARY KEY (order_item_id, unit_index), FOREIGN KEY (order_item_id, unit_index) REFERENCES order_line_unit_amounts RESTRICT)`。初めは `state='kept'`・`current_price=paid_amount`・持ち主は自分。
  - `order_unit_exchange_links(exchange_order_item_id uuid, exchange_unit_index integer, slot_order_item_id uuid, slot_unit_index integer, previous_order_item_id uuid, previous_unit_index integer, receipt_id uuid NOT NULL FK order_return_receipts, created_at, PRIMARY KEY (exchange_order_item_id, exchange_unit_index), FK (slot_order_item_id, slot_unit_index) → order_unit_slots)`。追記だけ。
  - `order_unit_events(id uuid PK, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE, order_id uuid NOT NULL, kind text CHECK (kind IN ('return_receive','pre_shipment_cancel','cancel_reverted','hold_release')), request_key uuid NULL, return_id uuid NULL, receipt_id uuid NULL, reverts_event_id uuid NULL UNIQUE, entitlement_previous integer, entitlement_max_before integer, entitlement_gross integer, entitlement_shop_only integer, fee_amount integer CHECK >= 0, hold_total integer CHECK >= 0, entitlement integer, standard_refund integer CHECK >= 0, now_refund integer CHECK >= 0, consult_refund integer CHECK >= 0, actor_id uuid NULL, created_at)`。`CHECK (now_refund + consult_refund = standard_refund)`。追記だけ。
  - `order_unit_event_lines(id uuid PK, event_id uuid NOT NULL FK, line_kind text CHECK (line_kind IN ('returned','kept','hold')), order_item_id uuid, unit_index integer, slot_order_id uuid NOT NULL, holder_order_item_id uuid, holder_unit_index integer, state_before text, state_after text, price_before integer, price_after integer, allocation integer NOT NULL, correction integer NOT NULL, part text NULL CHECK (part IN ('now','consult')), return_line_id uuid NULL, shipped boolean NOT NULL, FK (order_item_id, unit_index) → order_unit_slots)`。追記だけ。割り振りを負にできるのは `cancel_reverted` の出来事の行だけで、これは書く関数（Task 4・6）が守る（私の判断: 表の CHECK から出来事の表を読めないため、表には割り振りの CHECK を付けない）。
  - `order_unit_holds(id uuid PK, event_id uuid NOT NULL FK, held_order_id uuid NOT NULL, later_order_id uuid NOT NULL, item_id integer NOT NULL, amount integer NOT NULL CHECK (amount <> 0), created_at)`。正は差し引いた額、負は戻した額。追記だけ。
  - `order_unit_event_refunds(event_id uuid FK, refund_id uuid FK order_refunds, part text CHECK (part IN ('now','consult','release')), PRIMARY KEY (event_id, refund_id))`。追記だけ。
  - `order_return_line_treatments(id uuid PK, return_line_id uuid NOT NULL FK, treatment text CHECK (treatment IN ('shop','customer')), receipt_id uuid NULL, actor_id uuid NOT NULL, created_at)`。追記だけ。最後の行が今の扱い。
- Produces（関数の取り替え。同じ署名で CREATE OR REPLACE）:
  - `private.group_h_copy_order_discounts(_draft_id uuid, _order_id uuid, _line_map jsonb)`（今の本文の後で、H の注文に `order_discount_snapshots` 1行と、`order_line_unit_amounts` の全着の `order_unit_slots` を足す）。
  - `private.get_checkout_discount_context(...)`（同じ署名。会員の `priorUnitsByItem` を、枠のある注文は商品ごとの `state='kept'` の枠の数、枠の無い注文は今の式で数えた数の合計にする。交換の品は枠で数えるので足さない。4-4・AC-16）。
- Produces（データ）: `shop_return_reason_settings` の `reason IN ('defective','wrong_item')` の `resolutions` を `'exchange_only'` に UPDATE（ほかの列は変えない）。
- Produces（確かめの記号）: 末尾の DO は `UNIT_BINDING_SCHEMA_MIGRATION_ASSERTION_FAILED / P0001`、DETAIL は `ub_tables` / `ub_acl` / `ub_functions` / `ub_settings`。

- [ ] **Step 1: 失敗する DB 試験を書く。** `tests/integration/db/unit-binding-schema.integration.test.ts`。

```ts
test('FREQ-642-AC-16: 交換の品を全部返金した後の前の注文の着数は0', async () => {
  // 会員がジャケット 20,000円を1着買う → 交換 → 交換の品を返品で返金（枠の state を returned_customer にする道具を使う）
  expect(context.facts.priorUnitsByItem[jacketItemId] ?? 0).toBe(0);
});
test('FREQ-642-AC-20: 写しは H の注文に1行、枠は着の数だけ作られる', async () => {
  // ジャケット2着（20,000円・17,000円）の注文を受け付ける
  expect(snapshot.definitions.map((d: { kind: string }) => d.kind)).toEqual(['repeat']);
  expect(snapshot.facts.priorUnitsByItem).toEqual({});
  expect(slots.map(s => [s.unit_index, s.state, s.current_price])).toEqual([[0, 'kept', 20000], [1, 'kept', 17000]]);
});
test('FREQ-642-AC-30: 初期不良と誤送のご希望は交換だけ', async () => {
  expect(rows).toEqual([{ reason: 'defective', resolutions: 'exchange_only' }, { reason: 'wrong_item', resolutions: 'exchange_only' }]);
});
test('FREQ-642-AC-20: 新しい表は追記だけで、利用者から読めない', async () => {
  await expect(updateSlotAsAuthenticated()).rejects.toMatchObject({ code: '42501' });
  await expect(deleteEventRow()).rejects.toThrow(/IMMUTABLE/);
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/integration/db/unit-binding-schema.integration.test.ts` Expected: FAIL（表が無い）。
- [ ] **Step 3: 移行 A を書く。** 上の Interfaces どおり。`group_h_copy_order_discounts` と `get_checkout_discount_context` は今の本文（acceptance.sql の行）を写して足すだけにし、ほかの振る舞いを変えない。取り替えた2つの本文の md5 を末尾の DO で確かめる。
- [ ] **Step 4: 通るのを確かめる（調整役）。** Run: `npm run db:reset` の後 `npx jest tests/integration/db/unit-binding-schema.integration.test.ts tests/integration/db/group_h_acceptance.integration.test.ts tests/integration/db/group_h_context.integration.test.ts tests/integration/db/group_h_migration_asserts.integration.test.ts` Expected: PASS。
- [ ] **Step 5: 正本を直す。** `er.md` に表7つと関係、`db-migrations.md` に移行 A の行（版・目的・取り替えた関数・設定の UPDATE・戻し方）。
- [ ] **Step 6: コミット。**

```bash
git add supabase/migrations/<tsA>_unit_binding_schema.sql tests/integration/db/unit-binding-schema.integration.test.ts tests/integration/db/group_h_acceptance.integration.test.ts tests/integration/db/group_h_context.integration.test.ts tests/integration/db/group_h_migration_asserts.integration.test.ts tests/integration/db/helpers/group-h-fixtures.ts docs/03_BasicDesign/data/er.md docs/06_Operations/db-migrations.md
git commit -m "feat(returns): 注文の時の割引の写しと1着ずつの枠を残し前の注文の着数を手元にある着で数える"
```

---

### Task 3: 値段の計画（TypeScript の純関数）

**Files:**
- Create: `src/lib/orders/unit-pricing/unit-pricing-types.ts`、`src/lib/orders/unit-pricing/kept-price.ts`、`src/lib/orders/unit-pricing/unit-event-plan.ts`、`tests/unit/lib/orders/unit-pricing/kept-price.test.ts`、`tests/unit/lib/orders/unit-pricing/unit-event-plan.test.ts`、`tests/unit/lib/orders/unit-pricing/fixtures.ts`
- Read: `src/lib/discounts/discount-engine.ts`、`discount-types.ts`（`MIN_CHECKOUT_TOTAL`・`validateDiscountInput`）、`discount-allocation.ts`、`tests/unit/lib/discounts/fixtures.ts`

**Interfaces:**
- Produces（`unit-pricing-types.ts`）:

```ts
export type SlotState = 'kept' | 'returned_customer' | 'returned_shop';
export type ReturnSide = 'customer' | 'shop';
export type SlotKey = `${string}:${number}`; // `${orderItemId}:${unitIndex}`
export interface UnitSlot { orderItemId: string; unitIndex: number; itemId: number; paidAmount: number; allocatedAmount: number; currentPrice: number; state: SlotState; holderOrderItemId: string; holderUnitIndex: number; shipped: boolean; returnedCustomerAt: string | null; claimedReturnLineId: string | null }
export interface OrderDiscountSnapshot { engineVersion: number; definitions: DiscountDefinition[]; codes: string[]; facts: DiscountFacts; lines: { lineKey: string; orderItemId: string; itemId: number; unitPrice: number; quantity: number }[] }
export interface UnitHold { heldOrderId: string; laterOrderId: string; itemId: number; amount: number; seq: number }
export interface OrderPricingState { orderId: string; placedAt: string; paidTotal: number; snapshot: OrderDiscountSnapshot; slots: UnitSlot[]; entitlementPrevious: number; entitlementMax: number; feeTotal: number; holds: UnitHold[] }
export interface UnitPricingMaterials { version: string; target: OrderPricingState; related: OrderPricingState[] }
export interface UnitReturnInput { returnLineId: string | null; holderOrderItemId: string; quantity: number; side: ReturnSide; part: 'now' | 'consult'; feePercent: number }
export type UnitEventChange =
  | { kind: 'return_receive'; returns: UnitReturnInput[]; excludedSlots: SlotKey[] }
  | { kind: 'pre_shipment_cancel'; cancels: { orderItemId: string; quantity: number }[] };
export interface UnitPlanLine { lineKind: 'returned' | 'kept' | 'hold'; orderItemId: string; unitIndex: number; slotOrderId: string; holderOrderItemId: string; holderUnitIndex: number; stateBefore: SlotState; stateAfter: SlotState; priceBefore: number; priceAfter: number; allocation: number; correction: number; part: 'now' | 'consult' | null; returnLineId: string | null; shipped: boolean }
export interface UnitPricingPlan { version: string; orderId: string; kind: 'return_receive' | 'pre_shipment_cancel' | 'hold_release'; entitlementPrevious: number; entitlementMaxBefore: number; entitlementGross: number; entitlementShopOnly: number; feeAmount: number; holdTotal: number; entitlement: number; standardRefund: number; nowRefund: number; consultRefund: number; lines: UnitPlanLine[]; holds: Omit<UnitHold, 'seq'>[]; releases: UnitPricingPlan[]; treatments: { returnLineId: string; treatment: ReturnSide }[] }
// treatments は returns のうち returnLineId のある物の side をそのまま並べる（受け取りで記録する。最後の行が今の扱い）
```

- Produces（`kept-price.ts`）: `priceSlots(state: OrderPricingState, include: readonly SlotKey[], options?: { priorUnitsByItem?: Readonly<Record<string, number>> }): Map<SlotKey, number>` と `correctKeptPrice(state: OrderPricingState, states: ReadonlyMap<SlotKey, SlotState>, options?: { priorUnitsByItem?: Readonly<Record<string, number>> }): { total: number; perSlot: Map<SlotKey, number> }`。
- Produces（`unit-event-plan.ts`）: `planUnitEvent(materials: UnitPricingMaterials, change: UnitEventChange): UnitPricingPlan` と `UnitPricingError`（code: `'unit_not_available' | 'snapshot_invalid'`）。
- 決めたこと（体は書き手が書く。ここに無い選びは書き手の判断で ledger に書く）:
  - `priceSlots`: 写しの行の単価で、含める枠を商品の行ごとの数量にして `calculateDiscounts` を呼ぶ。事実は `phase:'acceptance'`・`at` は写しの値・`buyer`・`hasPreviousOrder`・`hasFirstOrderReservation` は写しの値、`usage` は写しの行を保ち数（予約・確定・本人の回数・コードの回数）を0にする（期間・回数・初回を注文の時に満たした物として扱う。2-2）。`priorUnitsByItem` は options があればそれ、無ければ写しの値。含める小計が0なら全部0円、0より大きく `MIN_CHECKOUT_TOTAL` 未満なら割引なしの単価。結果の着の額は、商品ごとに額の安い順に、枠の今の値段の安い順（同じなら `unit_index`）へ当てる（私の判断: 直しを小さくするため）。
  - `correctKeptPrice`: 手元にある枠が0なら0。お店の側で返した枠が無ければ `priceSlots(手元にある)`。有れば A ＝ 籠（手元にある＋お店の側で返した）を出し、商品ごとに籠の中の額の安い着からお店の側で返した数を引いた残り、B ＝ `priceSlots(手元にある)`。合計の低い方の着ごとの額を返す（J-1・J-15）。
  - `planUnitEvent` の E: E′ ＝ 払った合計 − `correctKeptPrice` の合計 − 前の注文から差し引いた額の合計（この注文が `heldOrderId` の holds の和）。E′不備 ＝ 同じ式でお客様のご都合で返した枠を手元にあるとみなした値。手数料の増えた分 ＝ この出来事の各返品の率で `floor((E′ − E′不備) の増えた分のうちその返品の分 × 率 / 100)`。返品が1つの出来事は1つの率で、複数の率が混じる時は返品の行の id の順に増えた分を割る（私の判断）。E ＝ E′ − 手数料の累計。
  - 返す額: `standardRefund = max(E − entitlementMax, 0)`。`nowRefund` は相談の着を手元にあるとみなした E で出した `max(E_now − entitlementMax, 0)` と `standardRefund` の小さい方、`consultRefund = standardRefund − nowRefund`（私の判断: 今すぐと相談の分け方を行の順で変えないため）。
  - 返す枠の選び方: Global Constraints の J-12・Q5 の決まり。交換の品の返品（`holderOrderItemId` が交換の品の行）は、持ち主がその行の枠。`excludedSlots` は同じ受け取りで交換に出す枠。足りなければ `UnitPricingError('unit_not_available')`。
  - 行: 返す枠は `lineKind:'returned'`、割り振り ＝ min(今の値段, 払った額 − それまでの割り振り)、直し ＝ 割り振り − 今の値段、`priceAfter` ＝ 割り振り。手元にある枠で値段が変わった物は `lineKind:'kept'`、割り振り0、直し ＝ 新しい値段 − 今の値段。`Σ割り振り − Σ直し − 手数料 = E − entitlementPrevious` が成り立つこと（成り立たなければ計画の誤りとして throw）。
  - 前の注文から差し引く分（お客様のご都合の返品だけ）: `related` の会員の注文のうち `placedAt` が対象の後で、写しの `priorUnitsByItem[item] > 0` かつ定義に `kind:'repeat'` と `repeatPrevious:true` が有る注文 L ごとに、L の「前の注文の着数」を「写しの値 − L より前の注文で L の受け付けの後にお客様のご都合で返された枠の数（下限0）」に直し、`correctKeptPrice(L, 今の状態, {priorUnitsByItem: 直した数})` − `correctKeptPrice(L, 今の状態)` を外れた分にする。今の holds の和より増えた分は対象の注文の holds に正で足し（対象の E が0円より少なくならない分まで）、L の手元にある枠に `lineKind:'hold'` の行（直し ＝ 増えた分、割り振り0、L の枠の今の値段は変えない）を付ける。減った分は holds の新しい順に負で戻し、戻す注文ごとに `kind:'hold_release'` の計画を `releases` に入れる（その注文の E を戻した分だけ上げ、返す額 ＝ 増えた分）。

- [ ] **Step 1: 失敗する単体の試験を書く。** `fixtures.ts` に設計3章の注文（リピート: 20,000円の2着目 3,000円引き、セット: ジャケット2着とパンツで 4,500円引き〔3,000/1,500〕、例13〜例16 の注文）を作る道具。試験名は `DD-ADMIN-021:` で始め、各例の額を確かめる。

```ts
test.each([
  ['AC-01 例1 リピート ご都合1着', repeat(), ret(1, 'customer'), 17000],
  ['AC-08 例5 リピート 不良で送れず返金', repeat(), ret(1, 'shop'), 17000],
  ['AC-09 例6 セット ご都合でジャケット', set(), retJacket('customer'), 20000],
  ['AC-09 例7 セット ご都合でパンツ', set(), retPants('customer'), 5500],
  ['AC-08 例8 セット 不良のパンツ', set(), retPants('shop'), 8500],
  ['AC-08 例12 セット 不良のジャケット', set(), retJacket('shop'), 20000],
  ['AC-08 例13 ジャケットとパンツだけ 不良のジャケット', pairSet(), retJacket('shop'), 17000],
  ['AC-29 例13 をご都合で返すと', pairSet(), retJacket('customer'), 15500],
  ['AC-29 例14 10%引き ジャケットを返す', percent10(), retJacket('customer'), 18000],
  ['AC-29 例15 30,000円以上で1,000円引き パンツを返す', threshold(), retPants('customer'), 9000],
  ['AC-29 例15 交換できず返金', threshold(), retPants('shop'), 9667],
  ['AC-29 例16 重ねた割引 1着返す', stacked(), ret(1, 'customer'), 15300],
])('DD-ADMIN-021: %s', (_name, materials, change, refund) => {
  expect(planUnitEvent(materials, change).standardRefund).toBe(refund);
});
test('DD-ADMIN-021: AC-14 3着以上で50%引きを1着ずつ返すと 5,000・0・5,000・10,000', () => {
  expect(sequence(quantityTier(), 4).map(p => p.standardRefund)).toEqual([5000, 0, 5000, 10000]);
});
test('DD-ADMIN-021: 例7 の行はパンツに 8,500・組のジャケットに +3,000', () => {
  expect(lines(plan)).toEqual([['returned', 'pants', 8500, 0], ['kept', 'jacketInSet', 0, 3000]]);
});
test('DD-ADMIN-021: 例10 前の注文の返品は 17,000、後の注文の着に hold +3,000', () => {
  expect(plan.standardRefund).toBe(17000);
  expect(plan.holds).toEqual([{ heldOrderId: order1, laterOrderId: order2, itemId: jacket, amount: 3000 }]);
});
test('DD-ADMIN-021: 例10-2 後の注文の返品は 17,000 と前の注文への戻し 3,000', () => {
  expect(plan.standardRefund).toBe(17000);
  expect(plan.releases.map(r => [r.orderId, r.standardRefund])).toEqual([[order1, 3000]]);
});
test('DD-ADMIN-021: 例10 を不良で送れず返金すると差し引かず 20,000', () => {
  expect(plan.standardRefund).toBe(20000);
  expect(plan.holds).toEqual([]);
});
test('DD-ADMIN-021: AC-24・例11 手数料10% 不良とご都合を1回でも2回でもどちらの順でも 35,000', () => {
  expect(totals).toEqual([35000, 35000, 35000]);
  expect(fees).toEqual([2000, 2000, 2000]);
});
test('DD-ADMIN-021: AC-06 10% を1着ずつ2回 手数料は 1,700 と 2,000', () => {
  expect([first.feeAmount, second.feeAmount]).toEqual([1700, 2000]);
});
test('DD-ADMIN-021: AC-13 注文全体の1円引き 残る1着 9,999 返す額 10,000', () => {
  expect(plan.standardRefund).toBe(10000);
});
test('DD-ADMIN-021: 手元0着は0円 残る小計50円未満は割引なし', () => {
  expect(correctKeptPrice(state, allReturned).total).toBe(0);
  expect(correctKeptPrice(tiny, keepOne40Yen).total).toBe(40);
});
test('DD-ADMIN-021: 例9 発送前の取り消しは出荷済みでない着から 17,000', () => {
  expect(plan.lines.find(l => l.lineKind === 'returned')).toMatchObject({ shipped: false, allocation: 17000 });
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/unit/lib/orders/unit-pricing` Expected: FAIL（モジュールが無い）。
- [ ] **Step 3: 3つのファイルを書く。** 上の Interfaces どおり。`'server-only'` を付けない（純関数。画面からは読まないが、試験と窓口から使う）。`src/lib/discounts/` は変えない。
- [ ] **Step 4: 通るのを確かめる。** Run: `npx jest tests/unit/lib/orders/unit-pricing tests/unit/lib/discounts` Expected: PASS。`npx tsc --noEmit` と `npm run lint` も通る。
- [ ] **Step 5: 正本を直す。** `docs/04_DetailDesign/pages/16_admin.md` に DD-ADMIN-021（値段の計画: 籠・低い方・手数料・割り振りの式・前の注文から差し引く分）を足す。`@impl`・`@design` を3つのファイルの冒頭に付ける。
- [ ] **Step 6: コミット。**

```bash
git add src/lib/orders/unit-pricing tests/unit/lib/orders/unit-pricing docs/04_DetailDesign/pages/16_admin.md
git commit -m "feat(returns): 手元に残る服の正しい値段から返す額と1着ごとの割り振りを出す計画を足す"
```

---

### Task 4: 移行 B — 計画を確かめて記録する DB の芯

**Files:**
- Create: `supabase/migrations/<tsB>_unit_binding_core.sql`、`tests/integration/db/unit-binding-core.integration.test.ts`
- Read: `20261029130400_group_h_discounts_refunds.sql:30-82,178-300`（守りと取り押さえ）、`20261108150000_accounting_p2_posting_tables.sql:318-444`（出荷済みの着・割り振りの道具）

**Interfaces:**
- Consumes: Task 2 の表、Task 3 の `UnitPricingPlan` の JSON の形（キーは camelCase のまま DB に渡す）。
- Produces:
  - `private.order_unit_pricing_materials(_order_id uuid) RETURNS jsonb` と public の入口（service_role）。Task 3 の `UnitPricingMaterials` の形を返す。写しが無い注文は `NULL`。`version` は会員の関わる注文（対象と、写しのある同じ会員の入金済みの注文）に触った出来事の `seq` の最大（無ければ `'0'`）の文字列。`shipped` は `private.accounting_shipped_units(item, NULL)` に有るか。`entitlementMax` は `cancel_reverted` で取り消された出来事を除いた `entitlement` の最大。
  - `private.order_unit_apply_plan(_plan jsonb, _request_key uuid, _return_id uuid, _receipt_id uuid, _actor_id uuid) RETURNS uuid`（出来事の id。入口の関数の中からだけ呼ぶ。EXECUTE は誰にも渡さない）。確かめること: (1) 共通の鍵を持っている（`group_h_assert_unit_lock`）、(2) `version` が今の版と同じ。違えば `UNIT_PRICING_STALE / 40001`、(3) 各行の枠が有り `state_before`・`price_before` が今の枠と同じ、(4) 状態の移り方は `kept → returned_*` だけ、(5) 割り振り ≥ 0、割り振りの累計 ≤ `paid_amount`、`kept`・`hold` の行の割り振りは0、(6) `Σ割り振り − Σ直し − fee_amount = entitlement − entitlement_previous`、(7) `standard_refund = max(entitlement − entitlement_max_before, 0)` と `entitlement_max_before`・`entitlement_previous` が DB の値と同じ、(8) `entitlement ≤ 払った合計`、`hold_total ≥ 0`、(9) holds の正の和は対象の注文が `held_order_id`、負は既存の holds を超えて戻さない。違反は `UNIT_PRICING_INVALID / 22023`（DETAIL に番号 `ub_plan_1`〜`ub_plan_9`）。書くこと: 出来事・行・holds、枠の `state`・`current_price`（`returned`・`kept` の行の `price_after`。`hold` の行は変えない）・`last_event_id`。`releases` は書かない（Task 6 が別の出来事として呼ぶ）。
  - `private.group_h_claim_refund_units(_refund_id uuid, _order_item_id uuid, _unit_indexes integer[], _before_shipment boolean, _return_line_id uuid) RETURNS integer`（重ね定義。指定の着に `refund_id`・`refund_before_shipment`・`return_line_id` を付け、`paid_amount` の和を返す。同じ返金で付いていれば何もしない）と `private.group_h_release_return_units(_order_item_id uuid, _unit_indexes integer[]) RETURNS void`（重ね定義。指定の着の `return_line_id` だけ外す）。
  - `private.order_unit_link_refund(_event_id uuid, _refund_id uuid, _part text) RETURNS void`: `order_unit_event_refunds` に1行、出来事の `returned` の行のうち `part` が同じ着（`release` は無し）に、交換の品の返品なら先に `group_h_release_return_units` で元の着の `return_line_id` を外してから、上の重ね定義で取り押さえを付ける（守りの規則 e・f。Review Focus 4）。
  - `private.order_unit_outstanding(_return_id uuid) RETURNS integer`（返品の出来事の `standard_refund` の和 − その出来事に結んだ返金のうち状態が `awaiting_response`・`pending`・`succeeded`・`error` の額の和。下限0）。
  - 確かめの記号 `UNIT_BINDING_CORE_MIGRATION_ASSERTION_FAILED / P0001`、DETAIL `ubc_functions` / `ubc_acl`。

- [ ] **Step 1: 失敗する DB 試験を書く。** 計画は Task 3 の `planUnitEvent` で作り、`order_unit_apply_plan` を共通の鍵の中で呼ぶ試験の道具を足す。

```ts
test('FREQ-642-AC-18: 例7 の計画を記録すると枠と行と式がそろう', async () => {
  expect(event).toMatchObject({ entitlement: 5500, standard_refund: 5500, fee_amount: 0 });
  expect(lines.map(l => [l.line_kind, l.allocation, l.correction])).toEqual([['returned', 8500, 0], ['kept', 0, 3000]]);
  expect(slotOf(jacketInSet).current_price).toBe(20000);
});
test('FREQ-642-AC-17: 版が違う計画は STALE で何も書かない', async () => {
  await expect(apply(stalePlan)).rejects.toMatchObject({ message: 'UNIT_PRICING_STALE', code: '40001' });
  expect(await counts()).toEqual(before);
});
test.each(['ub_plan_3', 'ub_plan_4', 'ub_plan_5', 'ub_plan_6', 'ub_plan_7', 'ub_plan_8', 'ub_plan_9'])('FREQ-642-AC-18: 壊した計画は %s で断る', async detail => {
  await expect(apply(tampered(detail))).rejects.toMatchObject({ message: 'UNIT_PRICING_INVALID', code: '22023', detail });
});
test('FREQ-642-AC-18: 発送前の取り消しの割り振りは accounting_record_unit_refund が受け付ける', async () => {
  // 取引の中で記録された割り振りを会計の道具へ渡し、例外が出ないことだけ確かめて巻き戻す（実際に書くのは会計の計画3。5-2 Q4）
  await expect(passAllocationsToAccounting(eventId)).resolves.toBeUndefined();
});
test('FREQ-642-AC-04: FREQ-641 の取り押さえが付いた元の着でも、交換の品の返金を結べる', async () => {
  expect(unitRow).toMatchObject({ refund_id: refundId, return_line_id: null, refund_before_shipment: false });
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/integration/db/unit-binding-core.integration.test.ts` Expected: FAIL。
- [ ] **Step 3: 移行 B を書く。** 上の Interfaces どおり。読み手の関数は `STABLE`。`order_unit_apply_plan` は計画の中の数を DB の値と突き合わせるだけで、割引の計算は持たない（7章）。
- [ ] **Step 4: 通るのを確かめる（調整役）。** Run: `npm run db:reset` の後 `npx jest tests/integration/db/unit-binding-core.integration.test.ts tests/integration/db/group_h_refunds.integration.test.ts tests/integration/db/accounting_p2_posting_tables.integration.test.ts` Expected: PASS。
- [ ] **Step 5: 正本を直す。** `db-migrations.md` に移行 B、`docs/04_DetailDesign/sequence/order-administration.md` に「計画 → 版と式の確かめ → 記録 → 取り押さえ」の流れ、`docs/04_DetailDesign/states/order-payment.md` に枠の状態（kept・returned_customer・returned_shop、戻すのは店が返金をやめた取り消しだけ）。
- [ ] **Step 6: コミット。**

```bash
git add supabase/migrations/<tsB>_unit_binding_core.sql tests/integration/db/unit-binding-core.integration.test.ts docs/06_Operations/db-migrations.md docs/04_DetailDesign/sequence/order-administration.md docs/04_DetailDesign/states/order-payment.md
git commit -m "feat(returns): 値段の計画の版と式を確かめて1着ずつの出来事を記録する DB の芯を足す"
```

---

### Task 5: 移行 C — 受け取り・返金の結果・交換の結び

**Files:**
- Create: `supabase/migrations/<tsC>_unit_binding_receive.sql`、`tests/integration/db/unit-binding-receive.integration.test.ts`
- Modify: `tests/integration/db/return-receive-per-item-migration.integration.test.ts`（`DEDUP_REPLACED` のように、この移行で取り替える関数の「今の本文」を新しい移行から読む）、`tests/integration/db/return-receive-per-item.integration.test.ts`・`return-receive-per-item-repro.integration.test.ts`・`order_return_receipts.integration.test.ts`・`group_h_refund_outcomes.integration.test.ts`・`group_g1_return_exchange.integration.test.ts`・`return_postgrest.integration.test.ts`（写しのある注文の呼び方を15の引数に。写しの無い注文の期待はそのまま）、`tests/integration/db/helpers/group-h-refund-fixtures.ts`、`tests/integration/db/helpers/group-g-allowlist.ts` と `group_g1_writer_inventory.integration.test.ts`（書き手の一覧の署名の入れ替え）
- Modify（正本）: `docs/03_BasicDesign/api/api-spec.md`、`docs/06_Operations/db-migrations.md`、`docs/04_DetailDesign/pages/16_admin.md`（既知の点の節）

**Interfaces:**
- Consumes: Task 4 の `order_unit_apply_plan`・`order_unit_link_refund`。
- Produces:
  - `private.admin_receive_return(... 今の14の引数 ..., _pricing jsonb)` と public の入口（15の引数）。14の引数の private・public は DROP し、書き手の一覧（`private.group_g_writer_allowlist()`）の署名を入れ替える。返り値は今の列に `release_refund_ids uuid[]` を足す。
  - 振る舞い: requestKey の送り直しを、版を確かめる前に探して前の結果を返す（Review Focus 2）。写しのある注文で `_pricing` が NULL なら `UNIT_PRICING_REQUIRED / 22023`、写しの無い注文で `_pricing` があれば `UNIT_PRICING_INVALID / 22023`（DETAIL `ub_legacy`）。写しの無い注文は今の本文のまま。
  - 写しのある注文: 受け取りの行・在庫・交換の品の行を今のとおり作った後、`_pricing` を `order_unit_apply_plan` で記録する（`_units` の返す行と計画の `returned` の行の数が返品の行ごとに合わなければ `UNIT_PRICING_INVALID`、DETAIL `ub_receive_lines`）。商品の額は計画の `nowRefund`（相談の分は `consultRefund` を出来事に残す）。手数料の率の分は E の中なので、`v_fees` は返送料・交換の手数料と送料だけ。`fee_pending_deduction` も、それだけを残す（私の判断: 率の分を二重に引かないため）。`_refund_amount`（店長の額）の上限は今と同じ。
  - 交換: 交換の品の行を作る時、`order_unit_exchange_links` に交換の品の着ごとに1行。結ぶ枠は、その返品の行で返さない手元にある枠のうち、持ち主がその返品の行の品で、FREQ-641 の `return_line_id` がその行の物を先に、次に `unit_index` の順（4-1）。枠の持ち主を交換の品の着にする。`exchange_paid_amount` には結んだ枠の `current_price` の和を書く（表示だけ。返金の計算に使わない）。
  - `treatments`: `_pricing.treatments` の `{returnLineId, treatment}` を `order_return_line_treatments` に1行ずつ（受け取りの id・店長の id）。計画の `side` と一致しなければ `UNIT_PRICING_INVALID`（DETAIL `ub_treatment`）。
  - 返金を作った後、`order_unit_link_refund(event, refund, 'now')`。H の安い順の取り押さえは、写しのある注文では使わない。
  - `private.record_group_g_refund_result`（同じ署名）: 返金が出来事に結ばれている時、error → pending・succeeded の取り直しは、結んだ出来事の `returned` の行の着をそのまま付け直す（位置で選ばない。既知の点4）。failed では今のとおり取り押さえを外し、枠の状態は変えない（AC-17）。結ばれていない返金は今の本文のまま。
  - 確かめの記号 `UNIT_BINDING_RECEIVE_MIGRATION_ASSERTION_FAILED / P0001`。

- [ ] **Step 1: 失敗する DB 試験を書く。** 既知の点と設計の例を、受け取りの入口から確かめる。

```ts
test('FREQ-642-AC-02: 交換が先でも返品が先でも、交換0円・返品17,000円', async () => {
  expect(byOrder).toEqual({ exchangeFirst: [0, 17000], returnFirst: [17000, 0] });
});
test('FREQ-642-AC-03: 交換と返品を同じ受け取りで、行の id の順を入れ替えても 0円と17,000円', async () => {
  expect([a.refund_amount, b.refund_amount]).toEqual([17000, 17000]);
});
test('FREQ-642-AC-04: 例4 交換の品の返品で20,000円、合計37,000円（34,000円にならない）', async () => {
  expect(secondRefund).toBe(20000);
  expect(totalRefunded).toBe(37000);
});
test('FREQ-642-AC-05: 既知の点4の順でも合計37,000円を超えず交換の結びが動かない', async () => {
  expect(totalRefunded).toBeLessThanOrEqual(37000);
  expect(linksAfter).toEqual(linksBefore);
});
test('FREQ-642-AC-06: 10%で1着ずつ2回相談すると控えは1,700円と2,000円', async () => {
  expect(events.map(e => e.fee_amount)).toEqual([1700, 2000]);
});
test('FREQ-642-AC-12: 数量2の交換の品を1行にまとめた後に1着返すと17,000円', async () => {
  expect(refund.amount).toBe(17000);
});
test('FREQ-642-AC-17: 同じ requestKey の送り直しは、間に状態が変わっても同じ結果', async () => {
  expect(replay).toMatchObject({ receipt_id: first.receipt_id, refund_id: first.refund_id, replayed: true });
});
test('FREQ-642-AC-17: error の後のやり直しで、結んだ着だけを付け直す', async () => {
  expect(claimedAfterRetry).toEqual(claimedAtEvent);
});
test('FREQ-642-AC-20: 写しの無い注文は14の引数の時と同じ額', async () => {
  expect(legacyResult).toEqual(expectedFromRdBody);
});
test('FREQ-642-AC-31: 例17 セットの1着を交換すると 0円で、残りのセットの割引と枠の値段は変わらない', async () => {
  expect(result.refund_amount).toBe(0);
  expect(slotPricesAfter).toEqual(slotPricesBefore);
});
test('FREQ-642-AC-25: 割引の扱いを直した行は受け取りの id と店長で残る', async () => {
  expect(treatmentRows).toEqual([{ return_line_id: lineId, treatment: 'shop', receipt_id: receiptId, actor_id: managerId }]);
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/integration/db/unit-binding-receive.integration.test.ts` Expected: FAIL。
- [ ] **Step 3: 移行 C を書く。** `admin_receive_return` は `20261108063711_return_receive_unit_dedup.sql:146` の本文を写して上を足す。`record_group_g_refund_result` は `20261106005536_return_receive_per_item.sql:423` を写す。書き手の一覧の差し替えは `replaceAllowlistSql` と同じ形。
- [ ] **Step 4: 通るのを確かめる（調整役）。** Run: `npm run db:reset` の後 `npx jest tests/integration/db` Expected: PASS（全件。期待を変えた既存の試験は、変えた理由を ledger に1行ずつ書く）。
- [ ] **Step 5: 正本を直す。** `api-spec.md` の受け取りの RPC（15の引数・返り値）、`db-migrations.md` に移行 C、`16_admin.md` の既知の点（`20261108063711` の節の4項目）を「直した（移行 C、FREQ-642）」に書き換える。
- [ ] **Step 6: コミット。**

```bash
git add supabase/migrations/<tsC>_unit_binding_receive.sql tests/integration/db docs/03_BasicDesign/api/api-spec.md docs/06_Operations/db-migrations.md docs/04_DetailDesign/pages/16_admin.md
git commit -m "feat(returns): 受け取りと返金の結果を1着ずつの出来事に結び交換の印を枠に結び付ける"
```

---

### Task 6: 移行 D — 相談後の返金・注文の返金・取り消し・前の注文から戻す

**Files:**
- Create: `supabase/migrations/<tsD>_unit_binding_refunds.sql`、`tests/integration/db/unit-binding-refunds.integration.test.ts`
- Modify: `tests/integration/db/group_g1_refund_cancel.integration.test.ts`、`order_refund_requests.integration.test.ts`、`refund_postgrest.integration.test.ts`、`group_h_refunds.integration.test.ts`、`group_h_refund_concurrency.integration.test.ts`、`helpers/group-g-allowlist.ts`・`group_g1_writer_inventory.integration.test.ts`
- Modify（正本）: `docs/03_BasicDesign/api/api-spec.md`、`docs/06_Operations/db-migrations.md`、`docs/04_DetailDesign/states/order-payment.md`

**Interfaces:**
- Consumes: Task 4・5。
- Produces:
  - `private.begin_order_refund_core(... 今の15の引数 ..., _unit_event_id uuid)`（16の引数。15の引数は DROP。呼び出しを全部直す）。`_unit_event_id` が有る時は H の安い順の取り押さえをせず、返金を作った後に `order_unit_link_refund` を呼ぶ。
  - `private.begin_order_refund(... 今の13の引数 ..., _pricing jsonb)` と public の入口（14の引数。13の引数は DROP）。返り値に `release_refund_ids uuid[]` を足す。写しのある注文で発送前の行（`before_shipment=true`）か取り消し（`order_cancel`）がある時は `_pricing`（kind `pre_shipment_cancel`）が要る。発送後の行だけの返金は計画なし（J-10・AC-28）で、写しのある注文では発送後の行の着に取り押さえを付けない（私の判断: 枠の状態を変えない返金に着を結ばないため）。
  - `private.admin_refund_return(... 今の7の引数 ..., _pricing jsonb)` と public の入口（8の引数）。相談の標準の額は `order_unit_outstanding(_return_id)`。`_pricing` は相談の返金では状態を変えないので、前の注文の戻しがある時だけ `releases` を運ぶ（無ければ NULL）。
  - 前の注文から戻す: 入口は `_pricing.releases` の計画ごとに、その注文の鍵も取った上で `order_unit_apply_plan`（kind `hold_release`）→ `begin_order_refund_core(その注文, 'unit_hold_release', ...)` → `order_unit_link_refund(..., 'release')` を同じ取引で行い、作った返金の id を `release_refund_ids` に入れる。`order_refunds_source_check` と core の許す source に `'unit_hold_release'` を足す（`return_id` は NULL）。
  - `private.order_unit_revert_cancel(_refund_id uuid, _actor_id uuid) RETURNS uuid` と public の入口（service_role）: 発送前の取り消しの出来事に結ばれた返金が failed か Stripe の canceled の時だけ、その出来事の後に同じ注文の出来事が無ければ、逆の行（状態を kept へ、値段を `price_before` へ、割り振り・直しを負に）と holds の逆で `cancel_reverted` の出来事を作る。条件に合わなければ `UNIT_CANCEL_REVERT_REFUSED / 22023`。呼ぶのは会計の計画3（「店が返金をやめた」の決定。1-a08b）。この作業は窓口を作らない（5-2 Q7）。
  - 確かめの記号 `UNIT_BINDING_REFUNDS_MIGRATION_ASSERTION_FAILED / P0001`。

- [ ] **Step 1: 失敗する DB 試験を書く。**

```ts
test('FREQ-642-AC-27: 例9 発送前に1着取り消すと枠は returned_shop、標準の額17,000円', async () => {
  expect(slot.state).toBe('returned_shop');
  expect(refund.amount).toBe(17000);
});
test('FREQ-642-AC-27: 注文全体の取り消しは全部の枠が returned_shop で払った合計を返す', async () => {
  expect(states).toEqual(['returned_shop', 'returned_shop']);
  expect(refund.amount).toBe(37000);
});
test('FREQ-642-AC-28: 発送後の品を返品なしで選ぶ返金は枠と E を変えない', async () => {
  expect(slotsAfter).toEqual(slotsBefore);
  expect(eventsAfter).toHaveLength(eventsBefore.length);
});
test('FREQ-642-AC-15: お詫びの返金の後の返品は、注文の返せる額で止まる', async () => {
  expect(refund.amount).toBe(refundableBefore);
});
test('FREQ-642-AC-10: 例10-2 後の注文の受け取りで、前の注文に3,000円の返金ができる', async () => {
  expect(result.release_refund_ids).toHaveLength(1);
  expect(releaseRefund).toMatchObject({ order_id: order1, source: 'unit_hold_release', amount: 3000 });
  expect(order1Refunded).toBeLessThanOrEqual(20000);
});
test('FREQ-642-AC-23: 例2の返品を15,000円に下げても、交換の品の返品は20,000円', async () => {
  expect(laterRefund.amount).toBe(20000);
});
test('FREQ-642-AC-19: 確定した出来事の額は後の出来事で書き換わらない', async () => {
  expect(firstEventAfter).toEqual(firstEventBefore);
});
test('5-2 Q7: 店が返金をやめた発送前の取り消しは枠を kept へ戻し、後の出来事があれば断る', async () => {
  expect(slot.state).toBe('kept');
  await expect(revert(otherRefund)).rejects.toMatchObject({ message: 'UNIT_CANCEL_REVERT_REFUSED' });
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/integration/db/unit-binding-refunds.integration.test.ts` Expected: FAIL。
- [ ] **Step 3: 移行 D を書く。** core は `20261029130400_group_h_discounts_refunds.sql:641`、`begin_order_refund` は `20261023211425_group_g1_allocation.sql:4147`、`admin_refund_return` は同 H5 の `:2563` の本文を写して上を足す。
- [ ] **Step 4: 通るのを確かめる（調整役）。** Run: `npm run db:reset` の後 `npx jest tests/integration/db` Expected: PASS。
- [ ] **Step 5: 正本を直す。** `api-spec.md`（返金の RPC の引数・返り値・新しい source）、`db-migrations.md` に移行 D、`order-payment.md` に `unit_hold_release` と取り消しの戻し。
- [ ] **Step 6: コミット。**

```bash
git add supabase/migrations/<tsD>_unit_binding_refunds.sql tests/integration/db docs/03_BasicDesign/api/api-spec.md docs/06_Operations/db-migrations.md docs/04_DetailDesign/states/order-payment.md
git commit -m "feat(returns): 相談後の返金と発送前の取り消しと前の注文への戻しを1着ずつの出来事で決める"
```

---

### Task 7: サーバー — 材料・見込みの窓口・入口の窓口

**Files:**
- Create: `src/lib/orders/unit-pricing/unit-pricing-store.ts`、`src/lib/orders/unit-pricing/unit-pricing-service.ts`、`src/app/api/admin/returns/[returnId]/receive-estimate/route.ts`、`src/app/api/admin/orders/[id]/refund-estimate/route.ts`、`src/app/api/orders/[id]/return-request/estimate/route.ts`、各 route の単体試験（`tests/unit/api/admin/unit-pricing-estimate-routes.test.ts`・`tests/unit/api/orders/return-request-estimate-route.test.ts`）、`tests/unit/lib/orders/unit-pricing/unit-pricing-service.test.ts`
- Modify: `src/lib/orders/returns/return-store.ts`（`receiveReturn`・`refundReturn` に `_pricing`）、`src/lib/orders/returns/return-service.ts`（`release_refund_ids` の Stripe の依頼）、`src/lib/orders/refund/refund-store.ts`・`refund-service.ts`（`begin_order_refund` に `_pricing`、`releaseRefundIds`）、`src/app/api/admin/returns/[returnId]/receive/route.ts`（本文に `treatments?: {returnLineId, treatment}[]`）、`src/lib/orders/returns/return-types.ts`・`return-messages.ts`（`UNIT_PRICING_STALE`・`UNIT_PRICING_INVALID`・`UNIT_PRICING_REQUIRED` の文）と既存の単体試験

**Interfaces:**
- Consumes: Task 3 の型と `planUnitEvent`、Task 4〜6 の RPC。
- Produces:
  - `loadUnitPricingMaterials(client: SupabaseClient, orderId: string): Promise<UnitPricingMaterials | null>`（RPC `order_unit_pricing_materials`。null は写しの無い注文）。
  - 入力の型は今の受け取りの窓口の Zod の型と `src/lib/orders/refund/refund-types.ts:44` の `CreateRefundRequest`（画面の部品にある `ReceiveReturnRequest` はサーバーから読まない。要れば同じ形の型を `return-types.ts` に置く）。
  - `planReturnReceive(client, returnId: string, body: ReceiveReturnRequest): Promise<{ plan: UnitPricingPlan | null; estimate: ReturnReceiveEstimate }>`、`planOrderRefund(client, orderId: string, body: CreateRefundRequest): Promise<{ plan: UnitPricingPlan | null; estimate: OrderRefundEstimate }>`、`estimateCustomerReturn(client, orderId: string, lines: CustomerReturnRequestLine[]): Promise<CustomerReturnEstimate>`、`withFreshPricing<T>(run: () => Promise<T>): Promise<T>`（`UNIT_PRICING_STALE` の時だけ1回作り直す）。
  - `ReturnReceiveEstimate = { legacy: boolean; standardRefund: number; nowRefund: number; consultRefund: number; feeAmount: number; fixedFees: number; refundAmount: number; refundCap: number }`。写しの無い注文は `legacy: true` で、今の `computePerItemReturnRefundPreview` を返品の詳細から出した値を同じ形で返す（AC-20）。`OrderRefundEstimate = { legacy: boolean; suggestedAmount: number; refundCap: number; changesUnits: boolean }`。`CustomerReturnEstimate = { refundAmount: number; moneyMoves: boolean }`（交換だけなら `moneyMoves:false`）。
  - 返品の行の扱い: 初めは理由から（`defective`・`wrong_item` は shop、ほかは customer）。交換の頼みを店が返金に変えた行は shop。`treatments` があればそれ（2-3）。発送前の取り消しは shop。率は `order_returns.restocking_fee_percent`。
  - 窓口: 見込みの3つは読むだけ（管理は今の返品・返金の読む権限、お客様は注文の持ち主の確かめ。今の `GET /api/orders/[id]/return-request` と同じ）。受け取り・返金・取り消しの入口は計画を作って RPC に渡し、`withFreshPricing` で包む。額を本文から受け取らない（店長の額の欄は今のまま）。
- 決めたこと: お客様の見込みは、選んだ行が全部届き、今すぐ返金し、店長が額を変えない時の受け取りの返金の額（`refundAmount`）。

- [ ] **Step 1: 失敗する単体の試験を書く。** RPC は今の試験と同じ作り（client の rpc を差し替え）。

```ts
test('DD-ADMIN-022: 受け取りの見込みは計画の今すぐの額から返送料を引いた額', async () => {
  expect(estimate).toMatchObject({ legacy: false, standardRefund: 17000, nowRefund: 17000, refundAmount: 17000 });
});
test('DD-ADMIN-022: STALE の時だけ材料を読み直して1回作り直す', async () => {
  expect(rpc).toHaveBeenCalledTimes(4); // 材料・入口・材料・入口
  await expect(twiceStale()).rejects.toMatchObject({ code: 'UNIT_PRICING_STALE' });
});
test('FREQ-642-AC-20: 写しの無い注文は今の見込みと同じ値で legacy', async () => {
  expect(estimate).toEqual({ ...legacyPreview, legacy: true });
});
test('FREQ-642-AC-26: 交換の頼みを店が返金に変えた行は shop の扱いで、リピートの例 17,000円', async () => {
  expect(passedPricing.treatments).toEqual([{ returnLineId: 'l1', treatment: 'shop' }]);
  expect(passedPricing.standardRefund).toBe(17000);
});
test('FREQ-642-AC-21: お客様の見込みは交換だけならお金が動かない', async () => {
  expect(estimate).toEqual({ refundAmount: 0, moneyMoves: false });
});
test('DD-ADMIN-022: 受け取りの窓口は本文の額で計画を変えず、店長の額は今の欄だけ', async () => {
  expect(passedPricing.standardRefund).toBe(17000);
});
test('DD-ADMIN-023: release_refund_ids の返金ごとに Stripe へ依頼する', async () => {
  expect(requestStripe).toHaveBeenCalledWith(releaseRefundId);
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/unit/lib/orders/unit-pricing tests/unit/api` Expected: FAIL。
- [ ] **Step 3: 書く。** 上の Interfaces どおり。store は `import 'server-only'`。
- [ ] **Step 4: 通るのを確かめる。** Run: `npx jest tests/unit` と `npx tsc --noEmit`・`npm run lint` Expected: PASS。
- [ ] **Step 5: 正本を直す。** `api-spec.md`・`docs/03_BasicDesign/api/route-inventory.md` に窓口3つ、`16_admin.md` に DD-ADMIN-022（受け取りの見込みと入口）・DD-ADMIN-023（注文の返金・取り消しと前の注文への戻し）。
- [ ] **Step 6: コミット。**

```bash
git add src/lib/orders src/app/api tests/unit docs/03_BasicDesign/api docs/04_DetailDesign/pages/16_admin.md
git commit -m "feat(returns): 値段の計画をサーバーで作り見込みの窓口と受け取り・返金の入口に渡す"
```

---

### Task 8: 管理画面 — 受け取り・返金の見込み・割引の扱いの欄

**Files:**
- Modify: `src/components/OrderReturnReceiveDialog.tsx`、`src/components/OrderReturnRefundDialog.tsx`、`src/components/OrderRefundDialog.tsx`（`RefundFlowContent.tsx`・`src/hooks/useRefundSubmission.ts`）、`src/lib/orders/returns/return-calc.ts`（冒頭の「SQL が正」の説明を直す。計算は写しの無い注文の見込みとして残す）と、それぞれの RTL 試験（`tests/unit/components/OrderReturnReceiveDialog.test.tsx`・`OrderReturnRefundDialog.test.tsx`・`OrderRefundDialog.test.tsx`・`tests/integration/ui/admin-return-receive.test.tsx`）
- Create: `src/hooks/useUnitPricingEstimate.ts`（見込みの窓口を呼ぶ。選びを変えるたびに 300ms 待って呼び、古い応答は捨てる）と試験

**Interfaces:**
- Consumes: Task 7 の窓口と `ReturnReceiveEstimate`・`OrderRefundEstimate`。
- Produces: 受け取りの画面の各返品の行に「割引の扱い」の選び（「お店の側の事情」「お客様のご都合」。初めは理由から。直すと見込みを出し直す）。送る本文の `treatments`。見込みの表示は窓口の値だけを使い、見込みを待つ間は「計算しています」と出して受け取りのボタンを止める。見込みの誤りでは額を出さず、今の誤りの出し方で文を出す。

- [ ] **Step 1: 失敗する RTL 試験を書く。**

```ts
test('FREQ-642-AC-07: 受け取りの見込みは窓口の額で、送った後の DB の額と同じ', async () => {
  expect(await screen.findByText('返金の見込み: 17,000円')).toBeInTheDocument();
});
test('FREQ-642-AC-25: 割引の扱いを直すと見込みを出し直す', async () => {
  await user.selectOptions(screen.getByLabelText('割引の扱い'), 'shop');
  expect(fetchEstimate).toHaveBeenLastCalledWith(expect.objectContaining({ treatments: [{ returnLineId: 'l1', treatment: 'shop' }] }));
});
test('DD-ADMIN-022: 見込みを待つ間は受け取りのボタンを止め、古い応答を捨てる', async () => {
  expect(screen.getByRole('button', { name: /受け取る/ })).toBeDisabled();
});
test('DD-ADMIN-023: 発送前の品を選ぶ返金の見込みは窓口の額', async () => {
  expect(await screen.findByText('17,000円')).toBeInTheDocument();
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/unit/components tests/integration/ui/admin-return-receive.test.tsx` Expected: FAIL。
- [ ] **Step 3: 書く。** 画面は今の部品と文の型を使う。`implement-uiux`・`implement-react` のスキルを読んでから。
- [ ] **Step 4: 通るのを確かめる。** Run: `npx jest tests/unit/components tests/integration/ui` と `npx tsc --noEmit`・`npm run lint` Expected: PASS。
- [ ] **Step 5: 正本を直す。** `16_admin.md` の DD-ADMIN-022・023 に画面の段落、`docs/03_BasicDesign/ui/screen-list.md`・`screen-flow.md` の受け取りと返金の画面。
- [ ] **Step 6: コミット。**

```bash
git add src/components src/hooks src/lib/orders/returns/return-calc.ts tests/unit/components tests/unit/hooks tests/integration/ui docs/04_DetailDesign/pages/16_admin.md docs/03_BasicDesign/ui
git commit -m "feat(admin): 受け取りと返金の見込みをサーバーの計画から出し割引の扱いを行ごとに直せるようにする"
```

---

### Task 9: お客様の画面 — 申し込みの見込み・交換だけ・文

**Files:**
- Modify: `src/features/account/returns/ReturnRequestForm.tsx`・`ReturnRequestConfirm.tsx`・`return-request-model.ts`（`ConfirmSummary` に `estimate`）・`customer-return-client.ts`（`fetchCustomerReturnEstimate`）、`src/app/item/[id]/ItemDetailClient.tsx`、`src/app/checkout/_components/FinalConfirmationStep.tsx`、`src/app/legal/page.tsx`、`src/app/terms/page.tsx` と、それぞれの試験（`tests/unit/features/account/returns/*`・商品ページ・最終確認・/legal・/terms の既存の試験）

**Interfaces:**
- Consumes: Task 7 の `POST /api/orders/[id]/return-request/estimate` と `CustomerReturnEstimate`。
- Produces（文。設計 6-1 の案のまま。言い回しはオーナーが後で直す）:

> 割引（2着目割引・セット割引・割引コードなど）が付いたご注文で一部の商品を返品され、割引の条件を満たさなくなる場合は、お手元に残る商品の割引後の価格を差し引いて返金いたします。以前のご注文の商品を返品され、その後のご注文の2着目割引の条件を満たさなくなる場合も、その分を差し引いて返金いたします。初期不良・誤送は、同じ商品の交換でお応えします（在庫が無い場合はお作りしてお送りします）。どうしてもお送りできない場合に限り返金し、その時はお手元に残る商品の価格は上がりません。返金額がマイナスになることはありません。

  - 置き場: /legal の「返品・交換・キャンセルについて」の段落の後（`legal/page.tsx:113-136` の後ろ）、/terms の第6条の本文の後（`terms/page.tsx:134` の後ろ）、最終確認の「返品・キャンセル」の文の後（`FinalConfirmationStep.tsx:417-420` の後ろ）、商品ページの購入の部品の近くに新しい段（`data-testid="item-discount-return-note"`、文の型は `lk-text-3xs text-[#474747]`）。/legal と /terms の今の「初期不良・誤送は…返品・交換」の文は「交換（在庫が無ければ再制作）。お送りできない時だけ返金」に合わせて直す。
  - 申し込みの確かめる段: `返金の見込み: N円`。交換だけなら `お金のやり取りはありません`。見込みは確かめる段に入る時に1回呼び、誤りの時は額を出さず「返金の額は受け取りの後にお知らせします」と出す（私の判断: 申し込みは止めない）。
  - 初期不良・誤送のご希望: 設定が `exchange_only` なので、今の部品のまま「交換」1択になる（コードの分岐は足さない）。

- [ ] **Step 1: 失敗する試験を書く。**

```ts
test('FREQ-642-AC-21: 確かめる段に返金の見込みが出る', async () => {
  expect(await screen.findByText('返金の見込み: 17,000円')).toBeInTheDocument();
});
test('FREQ-642-AC-21: 交換だけならお金のやり取りはありません', async () => {
  expect(await screen.findByText('お金のやり取りはありません')).toBeInTheDocument();
});
test('FREQ-642-AC-30: 破損・不良を選ぶとご希望は交換だけ', () => {
  expect(resolutionOptionsOf('exchange_only', true)).toEqual(['exchange']);
});
test.each(['/legal', '/terms', '最終確認', '商品ページ'])('FREQ-642-AC-22: %s に割引の扱いの文が出る', place => {
  expect(screen.getByText(/お手元に残る商品の割引後の価格を差し引いて返金いたします/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 失敗を確かめる。** Run: `npx jest tests/unit/features/account/returns tests/unit/app` Expected: FAIL。
- [ ] **Step 3: 書く。** ブランドの文の調子は `docs/1_RequirementsDifinition/brand.md` に合わせる（文の中身は変えない）。
- [ ] **Step 4: 通るのを確かめる。** Run: `npx jest tests/unit` と `npx tsc --noEmit`・`npm run lint` Expected: PASS。
- [ ] **Step 5: 正本を直す。** `docs/04_DetailDesign/pages/15_account.md`（申し込みの見込み）、`05_item_detail.md`、`13_checkout.md`（/legal を含む）、`18_terms.md`、`screen-list.md`・`screen-flow.md`。
- [ ] **Step 6: コミット。**

```bash
git add src/features/account/returns src/app/item src/app/checkout/_components/FinalConfirmationStep.tsx src/app/legal/page.tsx src/app/terms/page.tsx tests/unit docs/04_DetailDesign/pages docs/03_BasicDesign/ui
git commit -m "feat(returns): 返品の申し込みに返金の見込みを出し割引の扱いの文を商品ページと規約に足す"
```

---

### Task 10: E2E（新規と既存の直し）

**Files:**
- Create: `e2e/FR-ADMIN-165-unit-binding-receive.spec.ts`、`e2e/FR-ADMIN-166-unit-binding-refund-cancel.spec.ts`、`e2e/FR-ACCOUNT-048-return-request-estimate.spec.ts`、`e2e/FR-ITEM-DETAIL-070-discount-return-note.spec.ts`、`e2e/FR-CHECKOUT-061-discount-return-note.spec.ts`、`e2e/FR-LEGAL-008-discount-return-policy.spec.ts`、`e2e/FR-TERMS-007-discount-return-policy.spec.ts`
- Modify: `e2e/FR-ADMIN-092-shop-return-settings.spec.ts`（`defective` の期待を `exchange_only` に）、`e2e/FR-ACCOUNT-036-return-request-photos.spec.ts`・`FR-ACCOUNT-037-return-request-eligibility.spec.ts`（初期不良・誤送でご希望に触っていれば交換に）、`e2e/FR-ADMIN-085`・`087`・`088`・`164`・`127`・`FR-ACCOUNT-045`（写しのある注文の額。変える前に読み、変えた理由を ledger に書く）、`e2e/return-test-utils.ts`・`return-request-test-utils.ts`・`refund-test-utils.ts`・`discount-test-utils.ts`（写しのある注文を作る道具）

**Interfaces:**
- Consumes: Task 2〜9 の全部。E2E は手元の Supabase に注文を作り、画面で操作する。

- [ ] **Step 1: 書く前に今の E2E を落とす。** 新しい7本を書き、`FR-ADMIN-092` の期待だけ先に直す。Run: `npx playwright test e2e/FR-ADMIN-165 e2e/FR-ADMIN-166 e2e/FR-ACCOUNT-048 e2e/FR-ITEM-DETAIL-070 e2e/FR-CHECKOUT-061 e2e/FR-LEGAL-008 e2e/FR-TERMS-007` Expected: Task 8・9 の前のコミットに対しては FAIL（見込み・文が無い）。この確かめは調整役が Task 7 の後・Task 8 の前に1回だけ流してよい（流せなかった時は ledger に書いて飛ばす）。
- [ ] **Step 2: 試験の中身。** 3つの画面幅で、試験名は `FREQ-642-AC-NN:` で始める。
  - FR-ADMIN-165: AC-02（交換→返品で 0円・17,000円）、AC-04（交換の品の返品で 20,000円、合計 37,000円）、AC-07（見込みと返した額が同じ）、AC-25（割引の扱いを直すと見込みが変わり、履歴に店長と時刻）、AC-09（例7の 5,500円）。
  - FR-ADMIN-166: AC-27（発送前に1着取り消すと 17,000円）、AC-28（発送後の品を返品なしで選ぶと見込みは店長の額の欄だけ）、AC-10（例10・例10-2 の 17,000円・3,000円）。
  - FR-ACCOUNT-048: AC-21（確かめる段に「返金の見込み: 5,500円」、受け取りで同じ額）、AC-21（交換だけは「お金のやり取りはありません」）、AC-30（破損・不良でご希望は交換だけ）。
  - FR-ITEM-DETAIL-070・FR-CHECKOUT-061・FR-LEGAL-008・FR-TERMS-007: AC-22（割引の扱いの文が出る）。
- [ ] **Step 3: 通るのを確かめる（調整役）。** 3000番の残りのアプリを止めてから、Run: `npm run db:reset` の後 `npm run test:e2e` Expected: 新しい7本が3幅で PASS。全件の前回（`.superpowers/sdd/2026-11-07-test-ng/e2e-full4.json`）より増えた赤が無い。赤は CLAUDE.md の切り分けの3段で確かめて ledger に書く。
- [ ] **Step 4: 正本を直す。** `docs/05_Quality/tests/test-spec.md` に FREQ-642 の節（試験のファイル・題・入力・期待・実測日）。
- [ ] **Step 5: コミット。**

```bash
git add e2e docs/05_Quality/tests/test-spec.md
git commit -m "test(returns): 交換の印と手元に残る服の正しい値段の返金を3つの画面幅で確かめる"
```

---

### Task 11: 範囲外の正本・台帳の突き合わせ

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（実装の状態）、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`（`:14` の FREQ-641 の行と `:395` の既知の点4つを「直した（FREQ-642）」に、冒頭の確認日）、`docs/05_Quality/reports/traceability-report.md`（生成。手で直さない）、各文書の冒頭の確認日

- [ ] **Step 1: 突き合わせる。** CLAUDE.md の範囲外の表（機能・UI、API、DB、処理の流れ、構成、試験）を1行ずつ見て、Task 2〜10 で直していない正本があれば直す。直さない物は理由を完了の報告に1行。
- [ ] **Step 2: 生成する。** Run: `npm.cmd run report:traceability` Expected: FREQ-642 の行が試験に結び付く。
- [ ] **Step 3: 確かめる。** Run: `npm.cmd run validate-docs` Expected: `Documentation validation passed`。
- [ ] **Step 4: コミット。**

```bash
git add docs/02_Requirements/requirements.md docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md docs/05_Quality/reports/traceability-report.md
git commit -m "docs(returns): 交換の印の直しの台帳と追跡の一覧をそろえる"
```

---

### Task 12: 会計の計画3の前提を直す・会計のセッションへ知らせる

**Files:**
- Modify: `docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md`（`:52` の3つの関数、`:58-70` の規則2(a)、`:285-300`・`:330-333` の関数の写しの前提、未確認の表）

**Interfaces:**
- Produces（計画3へ書く事実）: 3つの関数の今の署名（`admin_receive_return` 15の引数、`begin_order_refund_core` 16の引数、`begin_order_refund` 14の引数、`admin_refund_return` 8の引数）と、写す元が移行 C・D の本文になること。規則2(a)の返す着は `order_unit_event_lines` の `returned` の行（割り振り）と `kept`・`hold` の行（直し。仕訳にしない、Q1）から読むこと。前の注文から差し引いた分は `order_unit_holds`、戻しの返金は source `unit_hold_release`。発送前の取り消しの割り振りは会計の道具（Q4）が `order_unit_event_lines` から `accounting_record_unit_refund` へ書くこと。店が返金をやめた取り消しは `order_unit_revert_cancel` を呼ぶこと（Q7）。出荷の仕訳で残る着の今の値段を読むなら `order_unit_slots.current_price`。移行 A〜D の版の時刻。

- [ ] **Step 1: 探す。** Run: `rg -n "admin_receive_return|begin_order_refund_core|record_group_g_refund_result|規則2|2\(a\)|#17" docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md` で直す行を決める。
- [ ] **Step 2: 書き換える。** 上の事実だけを足し・直す。計画3の決まり（仕訳の形）は変えない。
- [ ] **Step 3: 確かめる。** Run: `npm.cmd run validate-docs` Expected: PASS。
- [ ] **Step 4: コミット。**

```bash
git add docs/superpowers/plans/2026-11-04-accounting-p3-returns-refunds.md
git commit -m "docs(accounting): 計画3の返金の関数と返す着の読み先を交換の印の直しに合わせる"
```

- [ ] **Step 5: 会計のセッションへ知らせる（調整役）。** 移行 A〜D の版、表と関数の名前、`unit_hold_release`、`order_unit_revert_cancel`、計画3の直した行を SendMessage で送る。push と本番の DB への適用は、この計画の外（オーナーの許可が要る）。
