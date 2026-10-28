# ADR-0462 管理の操作の監査に、行為者のメール・送り元の IP・ブラウザの名乗りを残す

> 状態: 現行（ADMIN の窓口と、LOOK・NEWS の監査の分。LOOK は `logAdminLookAudit`、NEWS は `logNewsAudit` が同じ `getAuditRequestContext` を使う。取扱店の監査は別の作業で同じ形に揃える） | 確認日: 2026-10-28 | 対象: `src/app/api/admin/create-user/route.ts`、`revoke-user-sessions/route.ts`、`users/mfa/reset/route.ts`、`contact/**`、`audit-logs/route.ts`、`item-color-presets/**` | 基準コミット: `ea393ce4`（作業ツリー）

## 概要

管理の操作の監査（`audit_logs`）に、行為者の id に加えて、行為者のメール・送り元の IP・ブラウザの名乗り（`user-agent`）を全部の結果の行に残す。IP は共有の `getAuditRequestContext`（`getClientIp` の値。ADR-0416）から取り、取れなければ `null` のまま保存する。色見本の作成と削除は、これまで監査を書かなかったので新しく書く。読み出しの記録（問い合わせの一覧・詳細、監査ログ）にも読んだ人の IP とブラウザの名乗りを付ける。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | SEC-ADMIN-009、SEC-ADMIN-022、SEC-ADMIN-023、THR-ADMIN-009、THR-ADMIN-022、THR-ADMIN-025 |
| 対象のコード | 上の対象のコード。IP の取り出しは `src/lib/request-ip.ts`（ADR-0416）。共有の `src/lib/audit.ts` の `logAudit` は変えない |
| 関連文書 | [ADMIN の要件](../../02_Requirements/areas/admin.md)、[ADMIN の脅威](../../05_Quality/security/threats/admin.md)、ADR-0416、ADR-0460、ADR-0461、`docs/superpowers/plans/2026-10-28-wave4-client-ip-audit-admin-ui.md`（Task 9）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave4-decisions.md`（Q13）、LOOK の `ADR-0158` と NEWS の `ADR-0010`（「IP を残さない」としていた判断。2026-10-28 に本ADRが置き換え、両方の本文に置き換えを書いた。状態の字は検査の決まりで `現行`・`推定`・`廃止` のどれかなので、残る部分があるため変えていない） |
| 試験 | 窓口ごとの単体（`tests/unit/api/admin/`）、結合（`tests/integration/api/admin-misc/admin-audit-write.test.ts` ほか）、E2E（`FR-ADMIN-MISC-002`〜`005`・`007`） |
| 調べた時点 | 2026-10-28（単体・結合の試験は流した。E2E と本番の中継の振る舞いは未実行） |

## 判断

### ADR-0462 管理の操作の監査に、行為者のメール・送り元の IP・ブラウザの名乗りを残す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ADMIN-009、SEC-ADMIN-022、SEC-ADMIN-023 |
| 根拠 | 管理者が利用者を作る・session を切る・2要素を外す・問い合わせの個人情報を読む操作は、乗っ取られた管理者の session が使われた時に被害が大きい。行為者の id だけでは、後から「どの端末・どの場所からか」を追えない。対象は管理者だけで、会員の閲覧の記録ではない。以前に IP を残さないとしたのは、`x-forwarded-for` の左端を信じると偽りの値が記録に入るため（ADR-0158・ADR-0010）で、偽れない `getClientIp`（ADR-0416）で解けた。ユーザーが 2026-10-28 に承認した（決定 Q13） |
| 状態 | 現行 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave4-decisions.md`（Q13）、`design-final.md`（R11）、[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)（記録に残す事項の「who」に発信元のアドレスを含める）、OWASP ASVS 4.0.3 V7.1.3（当てはめは推定） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 管理の操作の記録に残す物 | 窓口ごとにまちまち。利用者の作成は IP もブラウザも入れず、強制失効は一部の結果にだけ IP、問い合わせの記録はメールも IP も入れず、色見本は書かず、読み出しの記録は IP を入れなかった | 確かめていない（Shopify の公式資料でスタッフの操作の記録の項目を読んでいない。ホスト型で店の側に選択が無いと推測するが、根拠にしない） | 行為者・時刻・操作・対象・結果・発信元のアドレスを残す。機密は残さない | 全部の結果の行に行為者のメール・IP・ブラウザの名乗りを残し、機密（パスワード・色の値・問い合わせの本文）は残さない |
| IP の取り出し | `x-forwarded-for` の左端（偽れる） | - | 信頼する中継が付けた値だけを使う | `getClientIp`（ADR-0416）。取れなければ `null` |
| 色見本の変更 | 監査を書かない | - | 管理の変更は全部記録する | 作れた時（201）と消せた時だけ書く |

#### 決定

- 利用者の作成・強制失効・2要素のリセット・問い合わせの状態の変更・返信・テンプレートの作成と更新と削除・色見本の作成と削除の監査は、どの結果の行にも `actor_id`・`actor_email`・`ip`・`user_agent` を入れる。窓口は `...getAuditRequestContext(request)` を書くか、同じ値を閉包に持たせる
- 認可で断る強制失効の行（`unauthorized`・`unauthorized_burst`）は行為者が分からないので、これまでどおり id・メールを空にして IP とブラウザの名乗りを入れる（ADR-0460）
- 色見本は、新しく作れた時（201）に `admin.item_color_preset.create`、消せた時に `admin.item_color_preset.delete` を書く。`resource` は `item_color_preset`、`resource_id` は行の id の文字。色の名前と値は入れない。既にある行を返す 200・消した行が 0 行の 404・DB の誤り・認可の断りは、何も変えていないので書かない
- 問い合わせの一覧・詳細と監査ログの読み出しの記録（`admin.contact.list`・`admin.contact.read`・`admin.audit_logs.read`）にも読んだ人の IP とブラウザの名乗りを付ける。記録に失敗しても読み出しは止めない
- `create-user` の失敗の `detail` は固定の符号のまま変えない（ADR-0461 の流儀）
- IP が取れない配置（Vercel の外で `CLIENT_IP_HEADER` が無い手元・単体）では `ip` は `null`。`unknown` などの偽の値は入れない

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| IP を残さない（以前の形） | 乗っ取られた session の追跡で、場所を手掛かりにできない。偽れる値が理由だったが、`getClientIp` で解けた |
| `x-forwarded-for` を右から数えて IP を取る | Vercel は `x-forwarded-for` を上書きし、前段の中継を置かない前提では段数の設定も要らない（ADR-0416） |
| 色見本の窓口で 200（既にある行）や 0 行の 404 も書く | 何も変えていない要求を成功の行にすると、行為者が変えたと取り違える。0 行の 404 を残すかは、ほかの窓口の流儀（変更と削除の対象なしは失敗として残す）と食い違うが、色見本は元から書かない窓口で、まず変更だけを残す |
| 色見本の名前・値を `metadata` に入れる | 商品の色の見本は個人情報ではないが、記録に写す必要が無く、行の id と作った時刻で足りる |

#### 結果

- 良くなること: 管理の変更と個人情報の読み出しを、誰が・どの端末・どの場所からしたかまで追える。偽の `x-forwarded-for` が記録に入らない
- 悪くなること: IP は個人情報にあたりうる（管理者の IP）。保存期間と開示は、法令対応を後回しにする決め（電子帳簿保存法と監査ログの保持。システムの完成後）に従い、今は決めない。Vercel の外・中継を挟む配置では IP が `null` になる。色見本の 0 行の 404 は記録に残らない
- 見直す条件: 保存期間と開示の扱いを決める時。前段の中継（Cloudflare など）を置く時（ADR-0416 の `TRUSTED_PROXY_HOPS`）

## 未確認事項

- 監査ログの IP の保存期間と開示の扱い（法令対応の後回し。`src/lib/auditCleanup.ts` の既定 365 日は今は呼ばれていない）
- Vercel が偽の `x-real-ip`・`x-vercel-forwarded-for` を上書きすること（本番は未デプロイ。最初の preview で実測する）
- 色見本の 0 行の 404（消す対象が無い）を失敗として残すか（今は書かない）
