# ADR-0105 ホームの VIEW ALL は区画の下の中央に共通のボタンで置き、続きがある時だけ出す

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/home/components/HomeSectionViewAll.tsx` | 基準コミット: `a03beaff`

## 概要

ホームの ITEM・LOOK・NEWS の区画の一覧への入口は、見出しの右に常に出すリンク（FREQ-126）ではなく、区画の下の中央に置く共通のボタン（HomeSectionViewAll）にし、その幅で見せる数より公開の総数が多い時だけ出す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の HOME |
| 対応する ID | FR-HOME-004、FREQ-147-REQ-03、FREQ-148-REQ-03、DRV-HOME-005、FREQ-146-REQ-01（NEWS が定義） |
| 対象のコード | `src/features/home/components/HomeSectionViewAll.tsx`、呼ぶ側 `src/features/items/components/PublicItemGrid.tsx`・`src/features/look/components/PublicLookGrid.tsx`（範囲外） |
| 関連文書 | `docs/02_Requirements/requirements.md`（「要求トレーサビリティ追記（LOGIN 2FA・登録/ログイン分離）」節の FREQ-126、FREQ-146〜149 の行）、git `716b1a44`・`1796199e`（2026-07-18）、`ce1dd530`（2026-08-18、見出しの右のリンクの部品を消した） |
| 要件の文書 | `docs/02_Requirements/areas/home.md` |
| 関わる ADR | ADR-0016（ホームの NEWS の件数と VIEW ALL。NEWS の判断） |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0105 ホームの VIEW ALL は区画の下の中央に共通のボタンで置き、続きがある時だけ出す

| 属性 | 値 |
| --- | --- |
| 上位 | FR-HOME-004、FREQ-147-REQ-03、FREQ-148-REQ-03、DRV-HOME-005、FREQ-146-REQ-01（範囲外） |
| 根拠 | 区画の中身を全部見せ切れる時に一覧への入口を出すと、押しても同じ物しか無い頁へ送ってしまう（FREQ-147・148）。見た目は共通のボタンにそろえる（FREQ-146）。同じ「VIEW ALL」が3つ並ぶので、読み上げで行き先が分かる名前を必須にした（`HomeSectionViewAll.tsx`） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-146〜148。ユーザーの依頼の行）、実装から推定（FREQ-126 の形をやめた記録は無い） |

#### 背景

- FREQ-126 は、見出しの右に VIEW ALL のリンク（矢印付き）を常に出し、下の中央の条件付きのボタンをやめる、と決めた（`requirements.md`）
- その後の FREQ-146 は、VIEW ALL を共通のボタンで描き矢印を消すと決め、FREQ-147〜149 は総数が多い時だけ出すと決めた（`requirements.md`）
- 見出しの右のリンクの部品は、見出しを共通にした時（FREQ-275）に消えた（git `ce1dd530`）

#### 決定

- 一覧への入口は HomeSectionViewAll 1つにまとめ、区画の下の中央に置く。中身は共通の Button（secondary・四角）で、文字は "VIEW ALL"（`HomeSectionViewAll.tsx`）
- 行き先を区別する読み上げの名前を、呼ぶ側に必ず渡させる（`HomeSectionViewAll.tsx`）。E2E が見つけるための目印も付ける
- 出すかどうかは呼ぶ側が決め、総数と幅ごとの表示数を比べた CSS のクラスで出し分ける（`PublicItemGrid.tsx`、`PublicLookGrid.tsx`。ADR-0100）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 見出しの右に VIEW ALL のリンクを常に出す（FREQ-126） | 続きが無い時も出る。FREQ-146〜149 の形に戻した（推定。戻した理由の記録は無い） |
| 区画ごとに文字の違うボタン（VIEW ALL ITEMS・VIEW LOOKBOOK・VIEW ALL NEWS） | FREQ-126 の前の形。見た目の文字は "VIEW ALL" にそろえ、違いは読み上げの名前で持たせた（推定） |

#### 結果

- 良くなること: 3つの区画の入口が同じ見た目・同じ場所になり、続きがある時だけ出る
- 悪くなること: 公開の総数が少ないと入口が出ず、一覧の頁へはヘッダーからしか行けない
- FREQ-126 の要件・受け入れ条件（NEWS が定義）とは食い違ったまま。NEWS も同じ食い違いを記録している（ADR-0016）
- FR-HOME-004 は「もっと見る」を常に置くように読め、条件つきで隠すことと合うかは決まっていない

## 未確認事項

- FREQ-126 を FREQ-146〜149 で置き換えたとみなし「廃止」にするか（持ち主は NEWS）
- FR-HOME-004 の「もっと見る」を、総数が少ない時に隠してよいか
