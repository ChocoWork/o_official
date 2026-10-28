# ADR-0161 管理の LOOK の操作ボタンは窓口の `meta.canManage` で出し分ける（暫定は認可の2回目）

> 状態: 現行 | 確認日: 2026-10-26 | 対象: `src/app/api/admin/looks/route.ts`（GET）、`src/components/LookSection.tsx` | 基準コミット: `4fe88539`（作業ツリーに別の作業の未コミットの差分あり）

## 概要

管理の LOOK タブのカードの3つの操作（公開の切り替え・編集・削除）は、`GET /api/admin/looks` が応答に添える `meta.canManage` が真の時だけ出す。窓口は `admin.looks.manage` の認可をもう一度行って `canManage` を決める。暫定の作りで、`admin-rbac.ts` が権限の集合を返すようになったら1回の認可にする。「新規作成」のボタンは共有の頁にあり、この判断の外（波 4）。

> 2026-10-28 追記: 暫定は解いた。`admin-rbac.ts` が権限の集合を返すようになり、`canManage` はその集合から作る 1 回の認可になった。「新規作成」も `canManage` で出す。詳しくは [ADR-0166](./ADR-0166-look-create-button-by-can-manage-permissions-set.md)。下の「決定」の 2 回目の認可と「新規作成は役のまま」は、この追記の前の記録。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | SEC-LOOK-019（AC-04・AC-05）、THR-LOOK-019、DRV-LOOK-012、DD-LOOK-060、DD-LOOK-063、SCR-LOOK-006、API-LOOK-001 |
| 対象のコード | `src/app/api/admin/looks/route.ts`（GET）、`src/components/LookSection.tsx`。触らない物: `src/lib/auth/admin-rbac.ts`、`src/app/admin/page.tsx` |
| 関連文書 | `docs/02_Requirements/areas/look.md`、`docs/05_Quality/security/threats/look.md`、`docs/04_DetailDesign/pages/16-3_admin_look.md`。同じ形は G-3 の `GET /api/admin/packing` の `canManage` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合テストで確かめた。本番ビルドの画面は E2E `FR-LOOK-SEC-003` の `SEC-LOOK-019-AC-05` で確かめる） |

## 判断

### ADR-0161 管理の LOOK の操作ボタンは窓口の `meta.canManage` で出し分ける（暫定は認可の2回目）

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 権限を役割ごとに切り替えられるようになったので、画面を役でなく権限で出し分ける（SEC-LOOK-019）。画面は端末で動いて守りを持てないので、窓口が「この人は変更できるか」を答え、画面はそれを案内に使う。押された時の守りは今までどおり窓口の 403 |
| 状態 | 現行 |
| 出どころ | `design-final.md` の R16（局所版。波 1-C の計画。ユーザーが「波1を全部（推奨）」と承認した 2026-10-26） |

#### 背景

- カードの3つのボタンは権限で出し分けず、`admin.looks.read` だけの人にも出て、押すと 403 になっていた
- 権限の集合を返す仕組みは共有の `admin-rbac.ts` で、波 4 で足す。「新規作成」は `src/app/admin/page.tsx` が役（`admin`）で出していて、共有の頁なので直せない

#### 決定

- `GET /api/admin/looks` は `admin.looks.read` の認可の後に、`admin.looks.manage` の認可をもう一度行う（何も書かない）。権限が無いための 403 だけ `canManage:false` にして一覧を返し、401・503 などはその応答をそのまま返す。応答は `{data, meta:{canManage}}`
- `LookSection` は `json.meta?.canManage === true` の時だけ3つのボタンを出す。読み込み中・取り出しの失敗・`meta` なし・偽（文字や数を含む）は出さない（fail-closed）。取り直すたびに入れ直す
- `SEC-LOOK-019-AC-05` を足す。数える範囲は一覧の区画の中だけ（頁のヘッダーの「新規作成」などで赤にならないように）。`AC-04`（「新規作成」も出ない）は赤のまま印を残す
- 暫定の印: `admin-rbac.ts` が権限の集合を返すようになったら、この2回目の認可をやめて1回にする

#### Shopify との突き合わせ

| 観点 | Shopify の一般的な形 | この判断 |
| --- | --- | --- |
| スタッフの権限と操作 | 権限の無い操作は管理画面に出さず、サーバー側でも断る（出典は未確認） | 画面は `canManage` で出さず、サーバーの 403 は残す |
| 画面が権限を知る手段 | 画面の読み込みの時にスタッフの権限を取る（出典は未確認） | 一覧の応答に `meta.canManage` を添える（G-3 の packing と同じ形） |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `src/app/admin/page.tsx` で権限を取って渡す | 共有の頁で、波 4 の範囲 |
| `admin-rbac.ts` に権限の集合を返す関数を足す | 共有部品で、波 4 の範囲 |
| 役（`admin`）で出し分ける今のまま | 権限を外されたサポーターにも出る。画面と窓口がずれる |
| 画面が `/api/admin/looks` とは別の権限の窓口を呼ぶ | 窓口の数を増やさない決まり。往復も増える |

#### 結果

- 良くなること: 読み出しだけの人にカードの切り替え・編集・削除が出ない。窓口の判定が画面の出し分けと同じ元になる
- 悪くなること: 一覧を取るたびに認可の確かめ（DB の ACL の照会）が1回増える。読み出しだけの人の一覧では共有の認可が `[RBAC] Permission denied` の警告を1行出す。「新規作成」は権限の無い人に出たまま（波 4）
- 見直す条件: `admin-rbac.ts` が権限の集合を返す時（1回の認可にする）、`src/app/admin/page.tsx` を直す波 4（どちらも 2026-10-28 に ADR-0166 で済んだ）

## 未確認事項

- 本番ビルドで、読み出しだけの人の一覧のたびに `[RBAC] Permission denied` の警告が1行増える件が運用上許せるか
- Shopify の各挙動の出典
