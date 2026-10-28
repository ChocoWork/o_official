# ADR-0206 サイトの URL は本番ビルドで必須にし、getSiteUrl は投げない

> 状態: 推定 | 確認日: 2026-10-28 | 対象: `next.config.ts`（共有）、`src/lib/build-env-guard.ts` | 基準コミット: `90786822`（作業ツリー）

## 概要

本番のビルド（`VERCEL_ENV=production`）で `NEXT_PUBLIC_SITE_URL` と `NEXT_PUBLIC_SUPABASE_URL` が無ければ、`next.config.ts` の先頭の確かめ `assertBuildEnv` がビルドを落とす。あわせて `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` が別の origin を指す設定も、環境に依らずビルドを落とす（信頼する origin を 1 つに揃える）。`getSiteUrl` は変えず、投げない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ABOUT（コードの単位は `src/lib/build-env-guard.ts` の `assertBuildEnv`。`next.config.ts` は共有で範囲外） |
| 対応する ID | SEC-ABOUT-007（THR-ABOUT-005）。2 つの Supabase の URL の確かめは SEC-HOME-017・ADR-0316 の前提を設定の側で守る |
| 対象のコード | `next.config.ts` の先頭、`src/lib/build-env-guard.ts`、`.env.example` |
| 関連文書 | `docs/02_Requirements/areas/about.md`、`docs/04_DetailDesign/pages/08_about.md`（`DD-ABOUT-002`）、`docs/06_Operations/secrets.md`・`deployment-topology.md`、`docs/superpowers/plans/2026-10-28-wave3-csp-images-session.md`（Task 13、P5・P16）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave3-decisions.md`（controller の裁定） |
| 調べた時点 | 2026-10-28（単体試験と、Next の設定の読み込み `loadConfig` で、`VERCEL_ENV=production` の未設定が落ちることを確かめた。`next build` と本番の配備は流していない） |

## 判断

### ADR-0206 サイトの URL は本番ビルドで必須にし、getSiteUrl は投げない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ABOUT-007 |
| 根拠 | `getSiteUrl` は環境変数が無いと黙って `http://localhost:3000` を返し、`NEXT_PUBLIC_VERCEL_URL` だけが在るとデプロイごとの URL を返す。本番で設定が漏れても共有のカードの画像・メールの住所が手元の URL を指して公開されるので、気付ける場所で止める。`NEXT_PUBLIC_*` はビルドの時に値が埋まるので、止める場所はビルドが適する。2 つの Supabase の URL は、署名つき URL が `SUPABASE_URL` 優先で作られる一方、CSP の `img-src` と `remotePatterns` は `NEXT_PUBLIC_SUPABASE_URL` の 1 つだけを許すので、別の origin だと署名が通っても画像が止まる（ADR-0316、ADR-0108） |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R9-6）、`wave3-decisions.md`（controller の裁定: 信頼する origin は 1 つ） |

#### 背景

- `getSiteUrl`（`src/lib/redirect.ts`）は `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_BASE_URL`・`BASE_URL`・`NEXT_PUBLIC_VERCEL_URL` の順に読み、何も無いと既定の手元の URL を返す。`og:image` の基点（`metadataBase`）・メールの住所・`getRequestOrigin` が使う
- `src/lib/site-url-guard.ts` は、メールに入る住所が手元・非 https のときに一時停止する（`VERCEL_ENV=production` のとき）。実行時の最後の守りで、ビルドの確かめとは別
- 本番のアプリはまだ未デプロイ。初回の配備から確かめが効く

#### 決定

- `next.config.ts` を読み込んだ時（= `next build` と `next start` の設定の読み込み）に `assertBuildEnv(process.env)` を呼ぶ
- `VERCEL_ENV === 'production'` のとき、`NEXT_PUBLIC_SITE_URL` と `NEXT_PUBLIC_SUPABASE_URL` が無い（空白だけを含む）なら、変数名を名指しして例外を投げる
- `NEXT_PUBLIC_SUPABASE_URL` と `SUPABASE_URL` が両方在り、`new URL(...)` の `origin` が違えば、`VERCEL_ENV` に依らず、両方の変数名を名指しして例外を投げる。末尾の `/` やパスの違いは無視する。片方だけの設定、URL として読めない値は何もしない（読めない値の扱いは既存の動きに任せる）
- 失敗の文に URL の値を載せない
- `getSiteUrl` は変えない。`NEXT_PUBLIC_VERCEL_URL` の読み方を直すかは別の判断

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `getSiteUrl` で投げる | メールの一時停止（`site-url-guard`）・`legal` 頁・`getRequestOrigin` の挙動と試験が変わり、手元・preview の呼び出しも巻き込む。ビルドで足りる |
| `NODE_ENV === 'production'` で見る | E2E の本番ビルド（`next build && next start`）も `NODE_ENV=production` になり、止めてはいけない E2E が止まる。`VERCEL_ENV` は Vercel の本番の配備だけで `production` になる |
| 警告だけ出す | 気付かれず、漏れたまま公開される |
| 2 つの Supabase の origin の違いを許す（許す host を 2 つにする） | CSP の `img-src` と `remotePatterns` の許可先が 2 つに増え、「自分のプロジェクト 1 つだけ」の守りが弱くなる（ADR-0108）。設定の側で 1 つに揃えるほうが小さい |

#### 結果

- 良くなること: 本番のビルドで設定の漏れ・食い違いが配備前に分かる。公開の応答が手元の URL やデプロイごとの URL を基点にしない。署名つき画像の host と CSP の許す host が食い違わない
- 悪くなること: 配備の前に Vercel の Production に `NEXT_PUBLIC_SITE_URL`・`NEXT_PUBLIC_SUPABASE_URL` を設定しておく必要がある（設定する値はビルドの時に埋まるので、設定してからビルドする。`docs/06_Operations/secrets.md`）。Vercel の Preview・手元は影響を受けない
- 残ること: 確かめは `VERCEL_ENV` が `production` の配備に限る。別のホスティングへ移す時は判定の変数を見直す

## 未確認事項

- 本番の Vercel の環境変数に 2 変数が設定されているか（本番は未デプロイ）
- `NEXT_PUBLIC_VERCEL_URL` の読み方（`getSiteUrl`）を直すか
