# ADR-0205 ABOUT の画像は自分の public/ に置き、外の画像の生成のサービスから読まない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/about/page.tsx`、`public/about.png` | 基準コミット: `a03beaff`

## 概要

ABOUT の画像は readdy.ai の生成の URL をやめ、サイトの `public/` に置いた画像から出す。管理された CDN でなく自分の置き場を選んだ。今は本文の画像が無く（ADR-0201）、共有の時の画像（OG）の `/about.png` だけが残る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ABOUT |
| 対応する ID | FR-ABOUT-008、SEC-ABOUT-001、DRV-ABOUT-002 |
| 対象のコード | `src/app/about/page.tsx`（OG の画像 `/about.png`） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FR-ABOUT-008 とそのレビューの副行） |
| 範囲外の関係 | `src/proxy.ts`（CSP の `img-src` に readdy.ai が残る）、`src/app/layout.tsx`（OG の絶対の URL の起点） |
| 要件の文書 | `docs/02_Requirements/areas/about.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0205 ABOUT の画像は自分の public/ に置き、外の画像の生成のサービスから読まない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-ABOUT-008、SEC-ABOUT-001、DRV-ABOUT-002 |
| 根拠 | 画像を外の生成のサービス（readdy.ai）から読むと、サービスの停止や回数の制限でページが壊れ、本番に向かないため（`requirements.md` のレビュー）。FR-ABOUT-008 は自分の置き場か管理された CDN のどちらかを認め、自分の置き場を選んだ |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`、git `5b4c9435`（2026-04-13。readdy.ai の URL を `/about.png`・`/mainphoto.png` に替え、OG の画像に `/about.png` を足した） |

#### 背景

- 作り直す前の ABOUT は、本文の画像2枚を readdy.ai の生成の URL から読んでいた（`requirements.md`）
- git `5b4c9435`（2026-04-13）で、2枚を `public/` の `/about.png`・`/mainphoto.png` に替え、OG の画像に `/about.png` を足した
- その後 git `cf822a96`（2026-06-28）で本文の画像2枚を消した（ADR-0201）

#### 決定

- ABOUT の画像はサイトの `public/` から同じオリジンで出す
- 今残るのは OG の画像 `/about.png` だけ。絶対の URL は共有の layout のサイトの起点で作る（範囲外）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| readdy.ai の生成の URL のまま使う | 停止・回数の制限でページが壊れる（`requirements.md`） |
| 管理された CDN に置く（FR-ABOUT-008 が認める） | 選ばなかった理由の記録は無い（推定: 画像が少なく、置き場を増やす要が無い） |

#### 結果

- 良くなること: ABOUT の表示と共有のカードの画像が外のサービスに頼らない
- 悪くなること: `/about.png` は HOME の ABOUT の区画と商品の E2E の見本の画像も使う共有の素材で、ABOUT 固有の写真ではない（uiux A-4 の「同じ素材の流用」）
- 守りの限り: 外の画像を読まないことを CSP や画像の最適化の許可で強制するかは SEC-ABOUT-003 を見る
- 食い違い: E2E FR-ABOUT-008 は本文の画像が1枚以上あることを前提にしていて、画像が0枚の今は落ちる（2026-10-24 の E2E 全件で赤）。外に頼らないこと自体は満たす

## 未確認事項

- 本番のホスティングで `/about.png` が実際に取得できるか（本番は未デプロイ）
