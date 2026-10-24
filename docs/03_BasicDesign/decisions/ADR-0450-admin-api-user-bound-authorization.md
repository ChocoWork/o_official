# ADR-0450 管理のそのほかの窓口は共有の秘密でなく、利用者に結んだ認可で守る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/create-user/route.ts`、`src/app/api/admin/revoke-user-sessions/route.ts`、`src/app/api/admin/audit-logs/route.ts`、`src/app/api/admin/users/mfa/reset/route.ts`、`src/app/api/admin/contact/`、`src/app/api/admin/item-color-presets/` | 基準コミット: `4facf63b`

## 概要

ADMIN の範囲の管理の窓口は、どれも最初に共有の認可の部品（`authorizeAdminPermission`）を通し、DB の ACL の権限・生きている session・2要素済み（aal2）の3つを満たす利用者だけを通す。前にあった共有の秘密の見出し（`x-admin-token`）での通し方は使わない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | SEC-ADMIN-001、FREQ-316-REQ-01（範囲外）、FREQ-316-REQ-02（範囲外）、FREQ-540-REQ-01（範囲外） |
| 対象のコード | `src/app/api/admin/audit-logs/route.ts`、`src/app/api/admin/revoke-user-sessions/route.ts`、`src/app/api/admin/create-user/route.ts`、`src/app/api/admin/users/mfa/reset/route.ts`、`src/app/api/admin/contact/route.ts`、`src/app/api/admin/contact/[id]/reply/route.ts`、`src/app/api/admin/item-color-presets/route.ts` |
| 共有の部品（範囲外） | `src/lib/auth/admin-rbac.ts`（権限の照会・session の生存・aal2） |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-admin-security-review.md`、`docs/02_Requirements/requirements.md`（FREQ-316） |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0450 管理のそのほかの窓口は共有の秘密でなく、利用者に結んだ認可で守る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-ADMIN-001、FREQ-316-REQ-01（範囲外）、FREQ-316-REQ-02（範囲外）、FREQ-540-REQ-01（範囲外） |
| 根拠 | 秘密の値を1つ知るだけで監査ログを読み、誰の session でも消せる形だと、2要素・役割・操作した人の記録が全部すり抜ける。利用者の JWT から権限と session を確かめれば、誰がしたかを監査に残せ、権限の付け外しも DB の ACL の1か所で済む（2026-04-18 の管理のセキュリティレビューの指摘 3 を直した形） |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-admin-security-review.md`、git `77def926`（2026-04-29。audit-logs と revoke から `x-admin-token` と `ADMIN_API_KEY` の照合を外し、`authorizeAdminPermission` に替えた） |

#### 背景

- 監査ログの読み出しと session の強制失効は、前は見出し `x-admin-token` が環境変数 `ADMIN_API_KEY` と一致すれば通していた（`2026-04-18-admin-security-review.md`）
- 利用者の作成は前は認証も認可も無く、service role で Auth の利用者を作れた
- FREQ-316 は管理の窓口の認可を1つの検証の道にまとめ、2要素を JWT の aal で見ることを求める（`requirements.md`）

#### 決定

- 範囲の窓口は全部、処理の頭で共有の認可の部品に要る権限の印を渡す。利用者の作成・強制失効・2要素のリセットは `admin.users.manage`、監査ログは `admin.audit.read`、問い合わせは `admin.contact.read`／`admin.contact.manage`、色見本は `admin.items.read`／`admin.items.manage`
- 共有の部品は、JWT を確かめ、session が生きているかと DB の ACL の権限を同時に引き、権限があって aal2 の時だけ通す（`src/lib/auth/admin-rbac.ts`）。session の生存を確かめられない時は 503、無い時は 401、権限か 2要素が足りない時は 403
- 通った後の監査には、認可が返す利用者の id とメールを操作した人として書く（例 `revoke-user-sessions/route.ts`、`create-user/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 共有の秘密の見出しで通す（前の形） | 秘密を持つだけで通り、2要素・役割・操作した人の記録が効かない（`2026-04-18-admin-security-review.md`） |
| 機械どうしの呼び出し用に秘密の道を残す | レビューは要るなら別の内部の窓口にするとした。今は範囲に機械からの呼び出しが無い |
| JWT の `app_metadata` の役割で判定する | 役割は利用者の付帯の情報で、ACL の付け外しと食い違いうる（`docs/03_BasicDesign/architecture/hybrid-rbac.md`） |

#### 結果

- 良くなること: 範囲の全部の窓口で、権限・session・2要素の判断が1か所にそろう。誰がしたかが監査に残る
- 悪くなること: 認可の振る舞い（権限の一覧・固定の権限）は権限と割当の作業が変える共有の部品に頼るので、ADMIN の側だけでは決められない
- 見直す条件: 機械どうしの呼び出し（定時の仕事など）から範囲の窓口を呼ぶ要りようが出た時
- 書き込みの窓口の Origin の照合と回数の制限は、この判断の外（SEC-ADMIN-005・006）

## 未確認事項

- 共有の秘密を外す判断をユーザーが認めた記録（レビューの指摘を直したコミットだけがある）
