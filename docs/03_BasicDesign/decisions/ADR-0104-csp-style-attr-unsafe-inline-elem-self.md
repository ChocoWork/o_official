# ADR-0104 本番の CSP は style 属性だけを 'unsafe-inline' で許し、style 要素・link 要素は 'self' のまま締める

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/proxy.ts`（共有） | 基準コミット: `a03beaff`

## 概要

本番の CSP の style-src に 'unsafe-inline' を常に入れて React の style 属性を通し、代わりに style-src-elem を分けて style 要素・link 要素は 'self'（と使う CDN）だけに締める。ホームの本番ビルドで style 属性の字の大きさが崩れたことから決めた要求（FREQ-280）による。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME（コードは共有の `src/proxy.ts` で、HOME の範囲のコードではない） |
| 対応する ID | FREQ-280-REQ-01、FREQ-280-REQ-02 |
| 対象のコード | `src/proxy.ts` の `buildCsp`（理由のコメントと `style-src`・`style-src-elem` の許可の組み立て）と、`proxy` が応答の見出しに2つの指示を並べる所 |
| 関連文書 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行）、`src/styles/globals.css`（古い CSP の時のコメント） |
| 要件の文書 | `docs/02_Requirements/areas/home.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0104 本番の CSP は style 属性だけを 'unsafe-inline' で許し、style 要素・link 要素は 'self' のまま締める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-280-REQ-01、FREQ-280-REQ-02 |
| 根拠 | React の style の指定は style 属性になり、属性は nonce で許せず 'unsafe-inline' しか手段が無い（FREQ-280-REQ-01 の文、`proxy.ts`）。一方、属性セレクタと背景の画像で値を抜く CSS の盗み出しは、攻撃者が style 要素を差し込めることが前提なので、要素の側を締めれば成り立たない（`proxy.ts`） |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-280 の行。ユーザーの依頼の行）、`src/proxy.ts` のコメント |

#### 背景

- ホームのヒーローの SCROLL・ABOUT の本文（`page.tsx`）、ITEM の価格（`PublicItemGrid` の中の `ItemCard.tsx`）などは、字の大きさを style 属性で共通の値から当てている
- 以前の本番の CSP は style-src に 'unsafe-inline' が無く、style 属性が落ちた。ヒーローの書体と大きさは、それを避けるためにクラスで当てた（`globals.css` のコメント）

#### 決定

- style-src は 'self'・'unsafe-inline'・使う CDN にする（`proxy.ts`）
- style-src-elem を分け、'self' と使う CDN だけにする。開発のサーバーだけは、画面の差し替えが style 要素を差し込むので 'unsafe-inline' を足す（`proxy.ts`）
- 2つの指示を本番の応答のヘッダーに並べる（`proxy.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| style にも nonce を付けて 'unsafe-inline' を使わない | nonce は要素にしか付かず、style 属性は許せない（FREQ-280-REQ-01） |
| style 属性を全部やめてクラスへ移す（以前のヒーローの逃げ方） | 共通の値で大きさを当てる style 属性が多くの画面にあり、全部を直す必要がある（推定） |
| style 要素・link 要素にも 'unsafe-inline' を許す | CSS を使った情報の盗み出しの道が開く（FREQ-280-REQ-02） |

#### 結果

- 良くなること: 本番ビルドでも style 属性の大きさが崩れず、style 要素の差し込みは止まったまま
- 悪くなること: style 属性の差し込み（見た目の書き換え）は CSP では止まらない。生の HTML を描かないこと（SEC-HOME-008）に頼る
- `globals.css` のコメントは「style-src に 'unsafe-inline' が無い」と今と逆のことを書く（TM-HOME-21）。ヒーローの大きさをクラスで当てる理由は今は無い
- CSP は全部の頁で共有なので、この判断は HOME の外の頁にも効く

## 未確認事項

- 本番の応答のヘッダーを実測していない（E2E FR-HOME-018 の5つ目が確かめる形）
- `globals.css` の古いコメントを直すか
