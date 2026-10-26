# ADR-0414 公開スキーマの表・列・関数・連番の権限は移行が明示する

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `supabase/migrations/20261026130200_sec_grants_hardening.sql`（認証の5表・連番・`profiles`）、以後の移行すべて | 基準コミット: `10b211a8`

## 概要

公開スキーマ（`public`）の表・列・関数・連番の権限は、移行が明示して書く。REVOKE で全部外してから、要る役に要る物だけ GRANT する。service_role の権限も明示する。認証の5表（`sessions`・`password_reset_tokens`・`rate_limit_counters`・`audit_logs`・`audit_logs_backups`）と連番 `rate_limit_counters_id_seq` は、anon・authenticated に権限を付けない。`profiles` は anon に付けず、authenticated には本人の行を扱う4つ（SELECT・INSERT・UPDATE・DELETE）だけを付ける。管理だけが書く表は SELECT だけを anon・authenticated に付ける（この適用は別の移行で行い、この ADR が考え方を持つ）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH（ほかの領域の表にも同じ考えを当てる） |
| 対応する ID | SEC-AUTH-011、SEC-AUTH-033 |
| 対象のコード | 移行 `sec_grants_hardening`。書き手は `src/features/auth/services/session.ts`・`register.ts`、`src/app/api/auth/{logout,password-reset}/`、`src/lib/audit.ts`・`auditCleanup.ts`・`csrfMiddleware.ts`・`auth/revoke-user-sessions.ts`（全部 service role）。回数の数えは SECURITY DEFINER の `increment_rate_limit_counter`。`profiles` は `src/app/api/profile/` が利用者の JWT で書く |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md` の Task 4、ADR-0106、ADR-0107 |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（`.from('<表>')` の呼び元と client の種類を全部読んだ。DB への効き方は書いただけで流していない） |

## 判断

### ADR-0414 公開スキーマの表・列・関数・連番の権限は移行が明示する

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-011、SEC-AUTH-033 |
| 根拠 | 公開スキーマの表は、作った時に anon・authenticated・postgres・service_role へ8権限が全部付く（`remote_schema.sql` の GRANT。`ALTER DEFAULT PRIVILEGES` は0件）。守りが RLS の「全部断る」方針1段だけだと、方針を1つ消す・書き違えるだけで再設定の印・セッション・回数・監査が開く。TRUNCATE・TRIGGER・REFERENCES・MAINTAIN は RLS を受けない。権限が第1の門、RLS が第2の門という二重にする。Supabase の手引きも「各役に最小の権限だけを付ける」と勧める |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/plans/2026-10-26-wave2-local-fixes.md` の Task 4、[Supabase Securing your API](https://supabase.com/docs/guides/api/securing-your-api)、[Supabase Hardening the Data API](https://supabase.com/docs/guides/database/hardening-data-api)、OWASP ASVS 4.0.3 V4.1.3 |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | Supabase の公式の手引き | 結論 |
| --- | --- | --- | --- | --- |
| 内部の表の見せ方 | 権限は全役に付き、RLS の全拒否の方針だけで塞ぐ | 内部のデータは決まった API の権限の枠（access scope）だけで触らせ、表そのものは直接出さない | 公開しない表は Data API に出さない（権限を付けない）か、RLS を有効にし最小の権限だけ付ける | 権限を付けない（RLS の全拒否の方針は二重の守りとして残す） |
| 新しい物の既定 | 全役に全権限 | 新しい項目は権限の枠で決まる | 付け直さない限り見えないのが安全側 | 移行が GRANT を明示する。`ALTER DEFAULT PRIVILEGES` には頼らない |

#### 決定

- 認証の5表と連番 `rate_limit_counters_id_seq`: `REVOKE ALL ... FROM PUBLIC, anon, authenticated`。service_role に表は `GRANT ALL`、連番は `GRANT USAGE, SELECT`。RLS の全拒否の方針（anon・authenticated・service_role の3本）は消さない
- 書き手と読み手は変えない。5表を `.from()` で触る呼び元は全部 `createServiceRoleClient()`、回数の数えは SECURITY DEFINER の関数（表の権限に左右されない）。SECURITY DEFINER の関数（`cleanup_password_reset_tokens` ほか）も同じ
- `profiles`: `REVOKE ALL ... FROM PUBLIC, anon`、authenticated から TRUNCATE・REFERENCES・TRIGGER・MAINTAIN を外す。SELECT・INSERT・UPDATE・DELETE は残す（`/api/profile`・`/api/profile/addresses` が利用者の JWT で本人の行を読み・upsert・消す。行の絞りは RLS の本人だけの方針）。新規利用者の行は SECURITY DEFINER のトリガーが作る
- 移行の末尾に自己検査（`has_table_privilege`・`has_column_privilege`・`has_sequence_privilege`）を置き、権限が意図と違えば移行ごと落とす。ヘッダーに対のロールバックの SQL を残す
- 以後の移行は、新しい表・列・関数・連番の GRANT（service_role を含む）を必ず明示する。管理だけが書く表（`looks`・`look_items`・`news_articles`・`stockists`・`item_color_presets`）は anon・authenticated に SELECT だけを付ける（別の移行 `sec_grants_admin_tables` で適用）。公開スキーマの付与の一覧を DB 試験で守る決まりは、下の「決まり（以後の移行）」と SEC-AUTH-033 で足した

#### 決まり（以後の移行）

- 以後の移行は、新しい表・列・関数・連番ごとに anon・authenticated・service_role の GRANT・REVOKE を明示する。広い権限を新しい表に残さない
- 新しい表の雛形: `REVOKE ALL ON TABLE public.<表> FROM PUBLIC, anon, authenticated;` のあと、要る役に要る権限だけ `GRANT <権限> ON TABLE public.<表> TO <役>;`、最後に `GRANT ALL ON TABLE public.<表> TO service_role;`。連番は `REVOKE ALL ON SEQUENCE … FROM PUBLIC, anon, authenticated;` のあと `GRANT USAGE, SELECT ON SEQUENCE … TO service_role;`。関数は `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated;` のあと、呼ぶ役に `GRANT EXECUTE`（service role の窓口だけが呼ぶ関数は service_role だけ）
- `ALTER DEFAULT PRIVILEGES` は project 全体・作る役ごとに効き、既存の物には効かないので、移行では使わない。使う判断は別に行う（設計書 Q9。今回はやらない）
- 権限の一覧と歯止めは DB 結合テスト `tests/integration/db/auth_grants_inventory.integration.test.ts`（DATA-AUTH-006）で守る。権限を替える移行を足したら、同じ変更でその一覧も直す。一覧にも既知の例外にも無い表に anon・authenticated の書き込み・TRUNCATE が付くと、その試験が表の名前を出して落ちる
- 根拠: Supabase 公式は、公開スキーマの既定の権限が project ごとに違い、自動で付く権限は外される方向だと案内する（[Hardening the Data API](https://supabase.com/docs/guides/database/hardening-data-api)）。移行が明示すれば、どの project でも同じ権限になる
- 既知の例外: 会計・問い合わせ・注文・カート・権限の表は、まだ広い権限を持つかもしれない（`remote_schema.sql` の GRANT のまま）。この波では直さず、試験の既知の例外に載せる。直す時は、その領域の移行が REVOKE を持ち、例外の一覧から外す

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| RLS の全拒否の方針だけを頼る（今のまま） | 方針の書き違い1つで全部が開く。TRUNCATE などは RLS を受けない |
| `ALTER DEFAULT PRIVILEGES` で新しい表の既定を絞る | 役ごと・作る人ごとに効き方が違い、既存の表には効かない。移行の GRANT の明示のほうが読めて検査できる |
| 認証の5表を `private` スキーマへ移す | 書き手・関数・移行・試験の変更が大きい。権限を外せば同じ守りが取れる |
| `profiles` も service role の窓口にまとめる | 本人の行の読み書きが画面ごとに窓口を通る作りに変わり、変更が大きい。本人だけを許す RLS の方針が既にある |

#### 結果

- 良くなること: anon の鍵・一般会員の JWT で認証の表を select すると、0件でなく権限の誤り（42501）になる。方針を書き違えても開かない。連番を anon が進められない
- 悪くなること: 認証の表を利用者の JWT で触るコードを足すと 42501 になる（service role の窓口で触る）。権限を戻す移行は、このヘッダーのロールバックを使う
- FREQ-540 との食い違い: FREQ-540（範囲外。DB の ACL で管理の操作を守る）は、管理の書き込みを DB の ACL＋RLS で守る前提だった。管理だけが書く表（`looks`・`look_items`・`news_articles`・`stockists`・`item_color_presets`）は、今は窓口の認可（ACL・aal2）＋ service role の書き込みで守り、DB の表の権限は SELECT だけにする。RLS の書き込み方針は消さず、権限を戻した時の二重の守りとして残す（`sec_grants_admin_tables`。`docs/02_Requirements/areas/look.md` の SEC-LOOK-003-AC-02 の要件に同じ記述）
- 見直す条件: 認証の表を公開の API に出す要件が出た時。`ALTER DEFAULT PRIVILEGES` で既定を絞る運用に変える時

## 未確認事項

- 本番の5表と連番、`profiles` の権限が `remote_schema.sql` と同じ「8権限を4役」のままか（適用の前に `pg_policies` と `has_table_privilege` で読む）
- 権限の効き方の DB 結合試験と E2E（`FR-LOGIN-031` の SEC-AUTH-011-AC-01）は、この作業では流していない
