# ADR-0154 管理の LOOK の変更の窓口に、送り元と操作者の2段の回数の制限と、画像の枚数・大きさ・1時間あたりの量の上限をかける

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/look/services/admin-rate-limit.ts`、`src/app/api/admin/looks/route.ts`、`src/app/api/admin/looks/[id]/route.ts` | 基準コミット: `4facf63b`

## 概要

管理の LOOK の作成・更新・公開の切り替え・削除の窓口は、権限を確かめた後に、操作の種類ごとの回数を送り元（IP）と操作者の2段で数える。画像は1枚5MB、1回6枚・合計20MB、操作者ごとに1時間60MB までとし、量を数えられない時は断る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | SEC-LOOK-011（SEC-LOOK-012 は今のコードが満たさないので上位にしない。「結果」を参照） |
| 対象のコード | `src/features/look/services/admin-rate-limit.ts`、`src/app/api/admin/looks/route.ts`、`src/app/api/admin/looks/[id]/route.ts`、`src/features/auth/middleware/rateLimit.ts`（範囲外の共有部品） |
| 関連文書 | `docs/05_Quality/reviews/security/security_review_look.md` |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0154 管理の LOOK の変更の窓口に、送り元と操作者の2段の回数の制限と、画像の枚数・大きさ・1時間あたりの量の上限をかける

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-011 |
| 根拠 | 画像を上げる窓口は置き場の容量と費用を使うので、乗っ取られた session や誤った自動の操作が続いても害を小さく止めるため。送り元の段は見出しを偽ると逃れられるので、操作者の段を必ず重ねる。量を数えられない時に通すと上限が無いのと同じになるので断る |
| 状態 | 推定 |
| 出どころ | 実装から推定（`src/features/look/services/admin-rate-limit.ts`）、`docs/05_Quality/reviews/security/security_review_look.md`（多層の制限を「継続」、Fixed）。上限の値を決めた記録は無い |

#### 背景

- 管理の LOOK の窓口は1回に複数の画像を受け、置き場に書く
- 共有の回数の制限は送り元を `x-forwarded-for` から取り、偽れる（`security_review_look.md`、Open・High。範囲外）

#### 決定

- 権限を確かめた後に回数を数える。作成10回、更新15回、公開の切り替え・削除30回を10分ごとに、送り元の段と操作者の段で別々に数え、どちらかを超えたら断る（`admin-rate-limit.ts`、`route.ts`）
- 1枚5MB（`route.ts`、`[id]/route.ts`）、1回6枚・合計20MB（`admin-rate-limit.ts`）を超える画像は断る
- 操作者ごとに1時間の画像の量を数え、60MB を超えたら 429、数えられない時は 503 で断る（`admin-rate-limit.ts`）。作成と更新は別々に数える

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 送り元の段だけで数える | 見出しを偽ると逃れられる（`security_review_look.md`） |
| 量を数えられない時は通す | 数える仕組みが止まった間は上限が無くなる（推定。NEWS の ADR-0009 と同じ向き） |

#### 結果

- 良くなること: 1人の操作者が短い間に上げられる画像の量に上限がある
- 悪くなること: 作成と更新を別々に数えるので、合わせると1時間に120MB まで上げられる。SEC-LOOK-012 の根拠（上限が実際の2倍になる）と合わない。一覧と1件の取得にも回数の制限が無いので、SEC-LOOK-012 は満たさず、上位にしない。送り元の段は共有の部品の直しまで偽れる（SEC-LOOK-011）
- 見直す条件: 共有の回数の制限が信頼できる送り元を取るようになった時、作成と更新の量を合わせて数える時

## 未確認事項

- 回数と量の上限の値をユーザーが決めた記録
- 作成と更新を別々に数えるのが意図か
