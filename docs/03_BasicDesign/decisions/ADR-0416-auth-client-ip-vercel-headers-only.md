# ADR-0416 送り元の IP は Vercel の見出しだけから取り、`x-forwarded-for` は読まない

> 状態: 現行（関数と、回数の制限の鍵・取扱店と管理の監査の IP・Turnstile の呼び手の切り替え、G/H を除く 13 ファイル（Task 2b）と G/H の 12 ファイル（Task 2c）の `x-forwarded-for` の直読みの寄せまで。E2E の固定の環境（Task 3）と AUTH 系の E2E の `x-real-ip` への書き換え（Task 5）も済み。SEARCH・NEWS・取扱店・管理・LOOK・G/H の E2E の書き換えは波 4 の続き） | 確認日: 2026-10-28 | 対象: 共有の `src/lib/request-ip.ts` の `getClientIp`・`getAuditRequestContext`、`src/features/auth/middleware/rateLimit.ts` | 基準コミット: `ea393ce4`（作業ツリー）

## 概要

回数の制限の鍵と監査の IP に使う「送り元の IP」を、共有の関数 `getClientIp` が 1 か所で決める。`VERCEL=1` か `CLIENT_IP_HEADER`（空でない）が在る環境でだけ、`x-vercel-forwarded-for`、`x-real-ip` の順に最初に在った見出しを読み、`node:net` の `isIP` を通らなければ null を返す。`x-forwarded-for` は読まない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SEC-AUTH-013（送り元の取り出しの部分） |
| 対象のコード | `src/lib/request-ip.ts` の `getClientIp`・`getAuditRequestContext`。呼び手: `src/features/auth/middleware/rateLimit.ts`（鍵。429・503 に `no-store`）、取扱店の窓口の監査 4 か所、強制失効・2 要素のリセットの監査、Turnstile の `remoteip` 3 か所（2026-10-28、波 4 の Task 2） |
| 関連文書 | [AUTH の要件](../../02_Requirements/areas/auth.md)、[AUTH の脅威](../../05_Quality/security/threats/auth.md)（THR-AUTH-013）、`docs/superpowers/plans/2026-10-28-wave4-client-ip-audit-admin-ui.md`（Task 1）、`.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R6）、`wave4-decisions.md`（Q4） |
| 試験 | `tests/unit/lib/request-ip.test.ts`、`tests/unit/middleware/rateLimit.test.ts`（jest の準備 `tests/setupClientIp.js` が `CLIENT_IP_HEADER` を立てる） |
| 調べた時点 | 2026-10-28（単体の試験は流した。Vercel が見出しを上書きすることの実測は未了で、本番の前の確認に残す） |

## 判断

### ADR-0416 送り元の IP は Vercel の見出しだけから取り、`x-forwarded-for` は読まない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-013 |
| 根拠 | 今のコードは `x-forwarded-for` の左端を信じる（`rateLimit.ts` と取扱店・管理の監査）。この見出しは利用者が自由に付けられるので、毎回変えれば IP 単位の回数の制限を越えられ、監査の IP も偽れる。Vercel が付ける `x-vercel-forwarded-for`・`x-real-ip` は Vercel が上書きして付けるので偽れない（OWASP ASVS V7.1 / Logging の source address を偽らせない） |
| 状態 | 現行 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R6）、`wave4-decisions.md`（Q4 のユーザーの答え）、[Vercel: Request headers](https://vercel.com/docs/headers/request-headers)、[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) |

#### 背景

| 観点 | 今の私たち（直す前） | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 送り元の取り方 | `x-forwarded-for` の左端、無ければ `x-real-ip`、無ければ `127.0.0.1` | 確かめていない（Shopify の公式資料でこの点を読んでいない。ホスト型で店の側に送り元の取り方の選択は無いと推測するが、根拠にしない） | 信頼する中継が付けた値だけを使う。中継の段数が分かるなら右から数える。クライアントが付けた値は信じない（OWASP / 各 PaaS の資料） | 配備先（Vercel）が上書きして付ける見出しだけを使う |
| 取れない時 | 固定の `127.0.0.1` を鍵にする | - | 厳しい側（共有の 1 つの枠）に倒す | 鍵は `null`（`rate_limit_counters.ip` は `inet` で `'unknown'` は入らない）、監査は null のまま |

#### 決定

- `getClientIp(request)`: `process.env.VERCEL === '1'` か `process.env.CLIENT_IP_HEADER` が空でない時だけ、`x-vercel-forwarded-for` → `x-real-ip` の順に最初に在った見出しの値を `trim` し、`isIP` が 0 でなければ返す。それ以外（空・`foo`・複数・ポート付き）は null。上位の見出しが在って不正なら次の見出しへ進まない
- `CLIENT_IP_HEADER` は「見出しを信じる」旗で、値は見ない。手元の E2E は `scripts/e2e/environment.ts` の固定の環境で `x-real-ip` を信じさせる（手元の Supabase の時だけ。2026-10-28 Task 3 で入れた）
- `TRUST_PROXY_HEADERS` は読まない。`src/lib/redirect.ts` では「`x-forwarded-host`・`x-forwarded-proto` からオリジンを作ってよい」の別の意味で使われており、使い回すとオリジンの決め方まで変わる
- `getAuditRequestContext(request)`: `{ ip: getClientIp, user_agent: user-agent の見出し }`。取れない時は null のまま保存する
- 本番は Vercel に直接置き、前段に Cloudflare などの中継を置かない前提にする

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `x-forwarded-for` を右から数える | Vercel は `x-forwarded-for` を上書きするので右から数える意味が無く、前段の中継を置かない前提では段数の設定も要らない |
| `TRUST_PROXY_HEADERS` を使い回す | `redirect.ts` で別の意味（オリジンの決め方）に使われている。E2E で立てるとオリジンまで変わる |
| 取れない時に `'unknown'` や `127.0.0.1` を鍵にする | `'unknown'` は `inet` に入らず全窓口が 503 になる。`127.0.0.1` は実在の利用者と混ざる。`null` の 1 つの枠に倒す |

#### 結果

- 良くなること: 送り元の取り方が 1 か所に揃い、偽れる値が回数の制限の鍵にも監査にも残らない
- 悪くなること: Vercel 以外で `CLIENT_IP_HEADER` が無い手元・単体では null になり、見出しの無い要求は全員が 1 つの枠を共有する。XFF を使っていた E2E は `x-real-ip` に書き換える（波 4 の Task 3 以降。AUTH 系は Task 5 で済み: 共通の補助 `member-session-helpers.ts` と `FR-LOGIN-*`・`FR-PWRESET-*`・`FR-SIGNUP-*` の 13 ファイル。偽れる XFF を毎回変えて枠を逃れられないことを見る `FR-LOGIN-035` の SEC-AUTH-013-AC-01 だけは、1 試験で固定の `x-real-ip` を付けて XFF を毎回変える。Supabase Auth（GoTrue）へ直に送る E2E の XFF は別の仕組みの枠を避ける物なので替えない）
- 環境変数の約束（2026-10-28、Task 3）: `CLIENT_IP_HEADER` は E2E 専用の旗で、本番には置かない（Vercel は `VERCEL=1` で足りる）。`scripts/e2e/environment.ts` の `E2E_FIXED_ENV` が `x-real-ip` を入れるので、E2E のサーバーの印（`computeServerFingerprint`）が変わり、3000 番の古いアプリは使い回されない。`E2E_FIXED_ENV` は `buildE2EOverrides` の中だけで混ぜ、混ぜた環境は既存の `findUnsafeE2ESettings` が手元の Supabase であることを条件なしで確かめる。旗の専用の見張りは足さない（独立に効く場面が無く、既存の条件だけで通ってしまうため）。Vercel 以外に置く時は、前段が利用者の `x-real-ip` を上書きすると確かめてから置く。詳しくは [シークレット管理方針](../../06_Operations/secrets.md)・[配置構成](../../06_Operations/deployment-topology.md)
- 見直す条件: Cloudflare などの前段の中継を置く時は、段数を決める `TRUSTED_PROXY_HOPS` の設計を足す（今回は作らない）。配備の前に Vercel の最初の preview で、偽の `x-real-ip`・偽の `x-forwarded-for` を送って Vercel が上書きすることを実測する

## 未確認事項

- Vercel が `x-vercel-forwarded-for`・`x-real-ip` を利用者の付けた値で上書きすること（本番は未デプロイ。preview で実測する）
- GoTrue（Supabase Auth）の IP の枠は、アプリのサーバーから呼ぶと店の全員で分け合う見込みで、この ADR の範囲外（R17・開店前の確認）
