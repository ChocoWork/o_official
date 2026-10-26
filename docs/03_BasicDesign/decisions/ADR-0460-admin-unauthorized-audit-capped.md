# ADR-0460 認可に失敗した要求の監査は、全体で 10 分に 20 行までとし、超えたらまとめの 1 行にする

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/app/api/admin/revoke-user-sessions/route.ts` | 基準コミット: `77e7f844`

## 概要

セッションの強制失効の窓口は、認可に失敗した要求を `unauthorized` の行で監査に残す。ログイン無しで誰でも繰り返せるので、全体（送り元を問わず 1 つの枠）で 10 分に 20 行までとする。21 回目はまとめの 1 行（結果 `unauthorized_burst`）にし、22 回目以降は書かない。数える部品が壊れた時は書かない（監査の補助なので fail-open）。窓口の応答は監査の結果に関わらず変えない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | SEC-ADMIN-007、THR-ADMIN-007、DRV-ADMIN-007 |
| 対象のコード | `src/app/api/admin/revoke-user-sessions/route.ts`（`auditUnauthorized`）。数える部品は `src/features/auth/ratelimit/index.ts` の `incrementCounter`（範囲外。呼ぶだけ） |
| 関連文書 | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`（ユーザー承認 2026-10-26。D3）、`docs/superpowers/plans/2026-10-26-wave1b-local-fixes.md` の P8 と Task 4、ADR-0454 |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合試験の写しで確かめた。本物の DB の関数との通しと E2E は未実行） |

## 判断

### ADR-0460 認可に失敗した要求の監査は、全体で 10 分に 20 行までとし、超えたらまとめの 1 行にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ADMIN-007、DRV-ADMIN-007 |
| 根拠 | 以前は失敗のたびに 1 行書いた。JWT 無しで誰でも（Origin を許可の値に偽れば `proxy.ts` の検査も通る）監査ログを埋められ、本当の不正の記録が埋もれ、表が膨らむ。権限の無い試みの跡を残す価値（DRV-ADMIN-007）は捨てずに、量だけを抑える。ユーザーが 2026-10-26 に推奨の案（上限つきで残す）を承認した |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1b-decisions.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/ADMIN.md`、[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)（ログが資源を使い果たす道に使われないようにする）、[CWE-779 Logging of Excessive Data](https://cwe.mitre.org/data/definitions/779.html) |

#### 背景

比べた物は次のとおり。

| 観点 | 以前の私たち | cron の窓口（`authorizeCronRequest`） | OWASP のログの指針 | 結論 |
| --- | --- | --- | --- | --- |
| 認可の失敗の記録 | 失敗のたびに 1 行 | 監査には書かず `console.warn` だけ | 記録で資源を使い果たせないようにする | 書くが、量に上限を付ける |
| 水増しへの強さ | 弱い（無限） | 強い（書かない） | 上限か抑制を求める | 全体で 10 分に 20 行まで |
| 不正の跡 | 残る（埋もれる） | 監査には残らない | 残すことを勧める | 先頭の 20 行と、まとめの 1 行が残る |
| 数える部品の故障 | － | － | 監査の補助が本処理を止めない | 書かない（fail-open）。応答は変えない |

Shopify は店のスタッフの操作を「スタッフの活動ログ」で見せるが、ログイン前の認可の失敗の水増しをどう抑えるかは公式の文書で確かめられなかった（比べた根拠にしない）。

#### 決定

- 認可に失敗したら、`incrementCounter({ endpoint: 'admin_revoke_unauthorized_audit', bucket: <600 秒に切った ISO>, subject: 'all' })` で全体の数を 1 増やす（送り元の IP は鍵にしない。`subject: 'all'` で 1 つの枠になる）
- 数が 20 以下なら結果 `unauthorized` の行を今までの項目（IP とブラウザの情報つき）で書く。21 なら結果 `unauthorized_burst`・`detail: 'further attempts suppressed for this window'` の 1 行だけを書く。22 以上は書かない
- 数える部品が throw したら書かない。どの場合も認可の応答をそのまま返す
- 共有の部品（`rateLimit.ts`・`ratelimit/index.ts`）は変えず、呼ぶだけにする

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 失敗のたびに書く（以前の形） | 無限に増え、本当の不正の記録が埋もれる |
| cron と同じく監査に書かず、ログだけにする | 権限の無い試みの跡（DRV-ADMIN-007）を捨てる。人の session を切る操作は乗っ取りの準備にも使えるので、跡は残したい |
| 送り元の IP ごとに枠を分ける | IP は偽れる（`x-forwarded-for`。SEC-ADMIN-009）。偽るたびに別の枠になり、上限が効かない |
| 数えられない時は必ず書く（fail-closed） | 数える部品の故障が、監査の水増しの道に変わる。監査の補助が本処理に影響しない方を選ぶ |

#### 結果

- 良くなること: 監査の表が 10 分あたり最大 21 行しか増えない。先頭の 20 行で試みの跡が残り、まとめの行で「抑えた」ことが分かる
- 悪くなること: 21 回目以降の個々の試みは残らない。10 分の窓の境目をまたぐと数え直されるので、要求の途中で窓が変わると最大 40 行になりうる。全体で 1 つの枠なので、攻撃者が先に枠を使い切ると、同じ窓の中の別の試みは記録されない（抑制は意図した動き）
- 見直す条件: 他の管理の窓口にも認可失敗の監査を足す時（今は強制失効だけが書く）。窓の長さや上限を変えたい時

## 未確認事項

- 20 行・10 分は推奨の値をユーザーが承認した物で、運用で多すぎる・少なすぎると分かれば見直す
- 本物の DB の関数 `increment_rate_limit_counter` との通しと、E2E `SEC-ADMIN-007-AC-01`（書いただけで未実行。窓の境目をまたぐと揺れうる）
