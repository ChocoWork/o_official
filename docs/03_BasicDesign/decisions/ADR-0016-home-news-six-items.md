# ADR-0016 ホームの NEWS は画面の幅に依らず6件を出し、公開の総数が6件より多い時だけ VIEW ALL を出す

> 状態: 廃止 | 確認日: 2026-10-24 | 対象: `src/features/news/components/PublicNewsGrid.tsx`、`src/features/news/services/public.ts` | 基準コミット: `a03beaff`

## 概要

廃止。この判断は FREQ-149 の要件の言い換えで、実装の選び分けを記録していなかった。件数と VIEW ALL の出し方は FREQ-149-REQ-01・FREQ-149-REQ-02 と、それを受ける SCR-NEWS-006 が正本。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | FREQ-149-REQ-01、FREQ-149-REQ-02 |
| 対象のコード | `src/features/news/components/PublicNewsGrid.tsx` の `variant="home"` の枝、`src/features/news/services/public.ts` の `getPublishedNewsCount` |
| 関連文書 | `docs/02_Requirements/requirements.md` の FREQ-149 |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0016 ホームの NEWS は画面の幅に依らず6件を出し、公開の総数が6件より多い時だけ VIEW ALL を出す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-149-REQ-01、FREQ-149-REQ-02 |
| 根拠 | 廃止の理由: 退けた案は「モバイルで3件に絞る」の1つだけで、これは FREQ-149 が廃止した以前の仕様そのもの。要件の根拠と同じ内容を繰り返すだけで、コードの構造を選び分けた記録ではない（実装に見合う案を比べていない）。要件側で足りるので判断の記録としては持たない |
| 状態 | 廃止 |
| 出どころ | `docs/02_Requirements/requirements.md` の FREQ-149 |

#### 背景

以前のホームの NEWS は、モバイルでは3件に絞っていた。

#### 決定

ホームは全部の幅で6件を取り、公開の総数が6件より多い時だけ VIEW ALL を出す。この決まりは FREQ-149-REQ-01・FREQ-149-REQ-02 と SCR-NEWS-006 が持つ。

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| モバイルで3件に絞る（以前の形） | モバイルで見えない記事が出る。FREQ-149 で廃止した |

#### 結果

- 置き換え先: FREQ-149-REQ-01、FREQ-149-REQ-02 と SCR-NEWS-006。この ADR の番号は使い回さない
- FREQ-126（見出しの右に VIEW ALL を常に出す）との食い違いは、trace-matrix.md の「食い違い」節に載せる

## 未確認事項

- FREQ-126 と FREQ-149 のどちらが今の決まりか
