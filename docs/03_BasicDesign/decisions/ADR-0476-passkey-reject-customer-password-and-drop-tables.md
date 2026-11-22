# ADR-0476 お客さんの password をフックで拒否する旗を真にし（移行 J）、使わない表と関数を消す（移行 K）。2つを別の移行に分ける

> 状態: 推定 | 確認日: 2026-11-22 | 対象: `supabase/migrations/20261122070400_passkey_reject_customer_password.sql`（J）、`supabase/migrations/20261122070500_drop_password_auth_objects.sql`（K）、`src/lib/auth/staff-passkey-defaults.ts`、`e2e/FR-LOGIN-081-customer-password-rejected.spec.ts`、`tests/integration/db/auth_passkey_stage4_migrations.integration.test.ts`

## 概要

段4の Task 26〜31 で、アプリからお客さんと店員のパスワード・認証アプリ（TOTP）・最初の店長のコマンドの道を消した。残るのは次の2つ。

- GoTrue（`/auth/v1/token?grant_type=password`）を公開の anon の鍵で直に叩く道。アプリの画面と窓口を消しても、利用者の行にパスワードが残っていれば入れてしまう（THR-AUTH-058）。フック `public.passkey_access_token_hook`（移行 B）はお客さんの `password` を拒否する分岐を最初から持ち、旗 `private.passkey_staff_config.reject_customer_password` が偽の間は止めていた。
- パスワードの再設定・変更のために作った表 `public.password_reset_tokens`・`public.password_change_challenges` と、3つの関数。呼び手がもう無い。

J で旗を真にし、K で表と関数を消す。この2つは別の移行にする。J は戻しが1行の `UPDATE` で済み、K は消した表と関数を作り直す長い戻しが要る。分ければ、お客さんの入り方に問題が出た時に、旗の戻しだけで済む。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-030、FR-AUTH-055、THR-AUTH-058、SEC-AUTH-060、DATA-AUTH-013 |
| 対象のコード | 上の「対象」の移行・試験、`src/lib/auth/staff-passkey-defaults.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)、[段4の計画](../../superpowers/plans/2026-11-20-passkey-stage4-cleanup.md)（Task 32）、[ADR-0464](ADR-0464-access-token-hook-single-gate.md)、[ADR-0469](ADR-0469-passkey-customer-email-code-login.md)、[移行の記録](../../06_Operations/db-migrations.md) |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-11-22 の作業ツリー（手元の `db reset` で J・K を当て、フックの拒否と K の戻しを試験で確かめた） |

## 判断

### ADR-0476 お客さんの password をフックで拒否する旗を真にし、使わない表と関数を消す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-060 |
| 根拠 | アプリの窓口を消しても、利用者の行にパスワードが残る限り、公開の anon の鍵で GoTrue を直に叩いて入れる（FR-LOGIN-031 が確かめる直叩きの道）。フックは入口の1か所なので、旗を真にすれば、お客さんの `password` の取り方は全部（アプリ・直叩き）で拒否され、メールのコード・Google・パスキー・更新は通る。消した窓口が使っていた表と関数は呼び手が0なので、残すと守りの穴（権限の締め直しの対象が増える）と維持の手間だけが残る |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/plans/2026-11-20-passkey-stage4-cleanup.md`（Task 32）、`.superpowers/sdd/2026-11-20-passkey-stage4-cleanup/task-32-brief.md` |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 | 出典 |
| --- | --- | --- | --- | --- | --- |
| お客さんの入り方 | メールとパスワード、メールのコード、Google、パスキー | お客さんのアカウントは、メールに送るコードでのログインが標準で、パスワードを使わない（確定） | NIST は、パスワードだけの入り方を弱いと見なし、だましに強い方法を選べるようにする。OWASP は、パスワードを持つ入り方が残る限り、総当たりと使い回しの守りが要ると言う | パスワードの入り方は全部止め、メールのコード・Google・パスキーだけを残す | [Shopify の新しいお客さんのアカウント](https://help.shopify.com/en/manual/customers/customer-accounts/new-customer-accounts)、[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/)、[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) |
| 止める場所 | アプリの窓口だけ | 認証の入口が1か所で、窓口の外に別の道が無い（推定） | 入口の1か所（IdP のフック）で止める。アプリだけで止めると、同じ IdP を直に叩く道が残る | GoTrue のフック（トークンを出す1か所）で止める | [Supabase の Auth フック](https://supabase.com/docs/guides/auth/auth-hooks)、[OWASP ASVS V2](https://owasp.org/www-project-application-security-verification-standard/) |
| 旗を戻せるか | - | - | 入口を閉じる変更は、閉じるだけを1つの戻せる操作にする | 旗の1行の `UPDATE` で戻せる。表の削除と同じ移行に入れない | [Supabase の宣言的なスキーマの移行](https://supabase.com/docs/guides/local-development/overview) |

Shopify の挙動は公開の説明で確かめた範囲に限る。「窓口の外に別の道が無い」は推定。

#### 決定

- **J**: `UPDATE private.passkey_staff_config SET reject_customer_password = true WHERE id;`。前の確かめ（設定の行が1行・フックと `private.passkey_staff_settings()` が在り、`reject_customer_password` を返す）に失敗したら `PASSKEY_MIGRATION_PRECHECK_FAILED` で止まる。終わりの確かめは、行が真であること。ヘッダーの ROLLBACK は1行（旗を偽に戻す）。古いアプリへ戻す話は書かない（開店前なので戻す先が無い）
- **K**: 3つの関数（`issue_password_change_challenge`・`consume_password_change_challenge`・`cleanup_password_reset_tokens`）と2つの表（`password_change_challenges`・`password_reset_tokens`）を `DROP`。**`CASCADE` を付けない**（依存があれば止まる）。前の確かめは行数を `RAISE NOTICE` で出すだけで、止めない。**監査の表・行、`private.auth_return_intents`、`rate_limit_counters` は触らない**
- **K の戻し**は、K を書く前の手元の DB の最終の姿（後から締め直した権限・`search_path` を含む）をヘッダーに写したもの。元の移行（`20260901102912`）の文をそのまま流すと、`password_reset_tokens` が `anon`・`authenticated` に GRANT されて戻り、セキュリティが後戻りする。消した行は戻らない（中身は期限つきの確認用のハッシュだけ）。試験が戻しの文を実際に流し、`relacl`・`proacl`・`proconfig`・方針の数が K の前の値と同じことを確かめる
- **旗の既定**: `src/lib/auth/staff-passkey-defaults.ts` の `rejectCustomerPassword` は、**列の既定値＝偽**のまま。J の後の実際の行は真。単体テストは列の既定との一致を見るので、既定を真にしない
- 当てる順は、A〜I の後・アプリのデプロイの後に J、J の後に K。**本番には、本番のドメインが決まるまで当てない**（オーナー決定 2026-11-19）。旗を真にしてからお客さんの入り方に問題が出ても、J の1行の戻しで済む

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| J の移行を作らず、旗は手で真にする | 手順書にしか残らず、`db reset` で作った手元の DB と本番が食い違う。移行にすれば試験が真の前提で書ける |
| J と K を1本にする | 戻しが長くなり、旗だけ戻したい時に表も作り直すことになる。K は消した行が戻らないので、J の後の様子を見てから当てたい |
| K で `DROP ... CASCADE` | 思わぬ依存を黙って消す。依存があれば止まる方が安全 |
| パスワードの表を残し、中身だけ空にする | 呼び手が無い表に権限・方針・試験の一覧の維持が残る |
| 列の既定を真にし、J を作らない | 既定を変えても、既に在る行は変わらない。単体テストの既定との一致も崩れる |

#### 結果

- 良くなること: お客さんの `password` での入り方が、アプリでも GoTrue の直叩きでも `[customer-password-disabled]`（403）で止まる。使わない表と関数が無くなり、権限の一覧が減る
- 悪くなること: パスワードだけで入れていたお客さんは、メールのコードで入る（ADR-0469 の確かめ済みの道）。K の後は、パスワードの再設定の印・変更の確認コードの行が戻らない
- 見直す条件: パスワードの入り方を再び許す時（旗を偽に戻す1行の `UPDATE`。表は K の戻しで作り直す）

#### 測った事実

- この Task で測った（2026-11-22）: 手元で `db reset` の後、旗の行は真・列の既定は偽。フックはお客さんの `password` を `[customer-password-disabled]` で拒否し、`otp`・`magiclink`・`oauth`・`passkey`・`token_refresh` はそのまま返す。店員の `password` は旗に関係なく `[staff-passkey-required]` で拒否される。K の戻しの文を流すと、2表・3関数が K の前と同じ `relacl`・`proacl`・`proconfig`・方針3本ずつで戻る
- K を書く前の手元の DB の控え: `password_reset_tokens`・`password_change_challenges` とも `relacl` は `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`・方針3本・行の保護あり。3つの関数とも `proacl` は `{postgres=X/postgres,service_role=X/postgres}`・`proconfig` は `search_path=""`・`SECURITY DEFINER`
