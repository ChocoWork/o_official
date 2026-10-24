# ADR-0410 ログインと会員登録は /login の1つの画面のタブにまとめ、/register の頁は置かない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/login/page.tsx`、`src/components/AuthTabs.tsx`、`src/components/RegisterModal.tsx` | 基準コミット: `4facf63b`

## 概要

ログインと会員登録の入口は `/login` の1つで、「ログイン」と「会員登録」のタブで切り替える。タブを切り替えても URL は `/login` のまま。`/register` の頁は無く、ほかの画面から会員登録へ直に送る時は `/login?tab=register` を使う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-63-REQ-01 |
| 対象のコード | `src/app/login/page.tsx`、`src/components/AuthTabs.tsx`、`src/components/RegisterModal.tsx`、`src/app/`（`register` の頁が無いこと） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-59・FREQ-61・FREQ-63 の行）、`e2e/FR-SIGNUP-001-register-page.spec.ts` |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0410 ログインと会員登録は /login の1つの画面のタブにまとめ、/register の頁は置かない

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-63-REQ-01 |
| 根拠 | FREQ-59 で `/register` を分け、FREQ-61 でタブと URL（`/login` と `/register`）を合わせたが、FREQ-63 でこの URL を分ける方針を逆にし、入口を `/login` 1つにした（FREQ-63 の行の「FREQ-59・FREQ-61 のURL分離方針を反転」） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-63 の行） |

#### 背景

- FREQ-59 は専用の登録の頁 `/register` を置き、FREQ-61 は `/login` と `/register` を1つの画面にまとめて、タブと URL を合わせた
- FREQ-63 は、その URL を分ける方針を逆にした。行の文に理由は書いていない

#### 決定

- `/register` の頁は置かない（`src/app/` に `register` が無い。`e2e/FR-SIGNUP-001-register-page.spec.ts` は 404 を確かめる）
- 2つのタブはどちらも URL を `/login` にし、切り替えで URL を置き換えるだけにする（`AuthTabs.tsx`）
- ほかの画面から会員登録のタブで開く時は `tab=register` を付け、宛先を入れておく時は `email` を付ける（`login/page.tsx`。使う側は決済の `GuestRegisterPrompt.tsx` と注文の状況の `status-messages.ts`、どちらも範囲外）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `/register` を専用の頁にする（FREQ-59） | FREQ-63 で入口を `/login` 1つにした |
| タブと URL を `/login` と `/register` で合わせる（FREQ-61） | FREQ-63 で URL を分ける方針を逆にした。理由の記録は見つけていない |

#### 結果

- 良くなること: 入口が1つになり、タブの切り替えで頁を読み直さない
- 悪くなること: タブの選択は URL に残らない。会員登録のタブを共有したい時は `tab=register` を付ける
- 文書: FREQ-59・FREQ-61 と FR-LOGIN-004 の `/register` の記述は、FREQ-63 が置き換えたのに廃止の印が無い（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節）
- 使われていない形: `AuthTabs` の `path` はどちらも `/login` で、`RegisterModal` の `/login` へのリンクの側（`RegisterModal.tsx`）は今の呼び出しでは出ない
- 見直す条件: 会員登録の入口を別の頁にしたくなった時

## 未確認事項

- FREQ-63 で方針を逆にした理由（行の文に無い）
