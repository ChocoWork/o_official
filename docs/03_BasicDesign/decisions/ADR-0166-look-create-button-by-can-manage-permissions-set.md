# ADR-0166 LOOK の「新規作成」は `canManage` で出し、権限の集合は `admin-rbac` の成功結果が返す

> 状態: 推定 | 確認日: 2026-10-28 | 対象: `src/lib/auth/admin-rbac.ts`、`src/app/api/admin/looks/route.ts`（GET）、`src/components/LookSection.tsx`、`src/app/admin/page.tsx` | 基準コミット: `ea393ce4`（作業ツリーに別の作業の未コミットの差分あり）

## 概要

管理の LOOK タブの「新規作成」を、頁の役（`admin`）でなく、`GET /api/admin/looks` が添える `meta.canManage` で `LookSection` が出す。`canManage` は共有の `authorizeAdminPermission` の成功結果が返す権限の集合（`permissions`）から作り、`admin.looks.manage` の認可をもう一度行う ADR-0161 の暫定をやめる。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の LOOK |
| 対応する ID | SEC-LOOK-019（AC-04・AC-05）、THR-LOOK-019、DD-LOOK-060、DD-LOOK-063、SCR-LOOK-006、API-LOOK-001 |
| 対象のコード | `src/lib/auth/admin-rbac.ts`（共有。`AuthzSuccess` に `permissions` を足すだけ）、`src/app/api/admin/looks/route.ts`（GET）、`src/components/LookSection.tsx`、`src/app/admin/page.tsx`（共有。LOOK の「新規作成」の分岐を消し、CONTACT のタブを足した） |
| 関連文書 | `docs/02_Requirements/areas/look.md`、`docs/05_Quality/security/threats/look.md`、`docs/04_DetailDesign/pages/16-3_admin_look.md`、ADR-0161 |
| 要件の文書 | `docs/02_Requirements/areas/look.md` |
| 調べた時点 | 2026-10-28 の作業ツリー（単体・結合テストで確かめた。本番ビルドの画面は E2E `FR-LOOK-SEC-003` の `SEC-LOOK-019-AC-04` で確かめる。流すのは controller） |

## 判断

### ADR-0166 LOOK の「新規作成」は `canManage` で出し、権限の集合は `admin-rbac` の成功結果が返す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-LOOK-019 |
| 根拠 | 権限を役割ごとに切り替えられるので、画面を役でなく権限で出し分ける（SEC-LOOK-019）。ADR-0161 はカードの3つのボタンだけを直し、「新規作成」は共有の頁の役の分岐と、権限の集合を返す共有部品が無いことで残した。波 4 で共有部品に権限の集合を足せるので、残りと暫定の 2 回目の認可を一度に解く |
| 状態 | 推定 |
| 出どころ | `design-final.md` の R16、`wave4-decisions.md`（Q14 D9 を推奨で進める物とし、controller が計画の裁定 1〜13 を採った 2026-10-28） |

#### 背景

- 「新規作成」は `src/app/admin/page.tsx` の `tabRightContent` が役（`userRole !== 'admin'` なら出さない）で出していた。権限の組を変えて `admin.looks.manage` を外された店長の組にも出て、押すと作成の頁で 403 になる。E2E `SEC-LOOK-019-AC-04` が赤の印を持っていた
- `GET /api/admin/looks` は `canManage` のために `admin.looks.manage` の認可をもう一度行い、session の確かめと ACL の照会が 1 回増えていた（ADR-0161 の暫定）
- 一覧が 0 件の時、`LookSection` は早く戻るので、「新規作成」を中へ移すだけでは最初の 1 件を作れなくなる

#### 決定

- `AuthzSuccess` に `permissions: ReadonlySet<PermissionCode>` を足す（追加のみ。既に引いている ACL の集合をそのまま返す。要ったコード以外も含む）。`AuthzFailure` と既存の呼び手は変えない
- `GET /api/admin/looks` は `admin.looks.read` の認可を 1 回だけ行い、`canManage = authz.permissions?.has('admin.looks.manage') === true` とする。集合が無い（試験の差し替えなど）なら false（fail-closed）。401・403・503 は認可の応答のまま
- 「新規作成」を `LookSection` の中へ移し、`canManage` が真の時だけ出す。0 件の一覧でも出す。読み込み中・失敗・`meta` なし・偽は出さない。`page.tsx` の LOOK の分岐を消す
- ADR-0161 の「暫定の印」を解いた旨を ADR-0161 に書く（ADR-0161 の `meta.canManage` で出し分ける決めは残る）
- 同じ頁に CONTACT のタブを足す（FR-ADMIN-009、ADMIN の領域。店長とサポーターの両方に出し、窓口が権限を守る）。別の決めだが、同じ共有の頁を 1 回で触るために同じ作業で入れた

#### Shopify との突き合わせ

| 観点 | Shopify の一般的な形 | この判断 |
| --- | --- | --- |
| スタッフの権限と操作 | 権限は役割に割り当て、領域ごとに許可・制限する（出典: [Shopify Help Center「Staff permissions」](https://help.shopify.com/en/manual/your-account/staff-accounts/staff-permissions)、2026-10-28 確認。「権限の無い操作の部品を隠すか」は頁に書かれておらず未確認） | 画面は `canManage` で出さず、サーバーの 403 は残す |
| 画面が権限を知る手段 | 画面の読み込みで、スタッフの権限を取る（上の頁に書かれておらず、出典は未確認） | 一覧の応答に `meta.canManage` を添える。認可の成功結果の集合から 1 回で作る |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `page.tsx` が権限を取って `LookSection` へ渡す | 画面から権限の窓口を別に呼ぶことになり、窓口が増える。往復も増える |
| 2 回目の認可を残す | 一覧のたびに ACL の照会と session の確かめが増える。読み出しだけの人で警告が出続ける |
| `permissions` を `AuthzSuccess` に足さず、窓口が ACL を引き直す | 認可と同じ引きを二重にする。判定の元が 2 つになる |
| 「新規作成」を 0 件の時は出さない | 最初の 1 件を作れない |

#### 結果

- 良くなること: 権限の無い人に「新規作成」が出ない。一覧の認可が 1 回になり、`[RBAC] Permission denied` の警告が一覧ごとに出ない。権限の集合は他の窓口の出し分けにも使える
- 悪くなること: `AuthzSuccess` の形を固定している試験（`tests/unit/lib/auth/admin-rbac.test.ts`、`tests/integration/api/admin-misc/admin-authorization-path.test.ts`）と、型付きで成功を差し替える試験 2 本（`cost-profit-route`・`receipt-route`）に `permissions` を足した。権限の呼び手の試験の差し替えは `permissions` を持たないので、窓口は `?.` で読み、無ければ false に倒す
- 見直す条件: 作成・編集の頁の入口に権限の確かめを足す時（取扱店の `ADR-0269` と同じ形にできる）、G-3 の `GET /api/admin/packing` の `canManage` を集合から作り直す時

## 未確認事項

- 作成・編集の頁を直に開いた権限の無い人にフォームが見える件（窓口が送信を 403 にする）。取扱店の作成の頁は入口で確かめる（`ADR-0269`）が、LOOK には足していない
- Shopify の各挙動の出典（権限の割り当ては確認済み。権限の無い操作の部品を隠すか、画面が権限を取る手段は頁に書かれておらず未確認）
