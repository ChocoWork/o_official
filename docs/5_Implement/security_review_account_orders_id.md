# account/orders/[id] セキュリティレビュー

- レビュー日: 2026-06-27（dynamic workflow / security-check skill + `scripts/page-audit.sh`）
- 対象: [src/app/account/orders/[id]/page.tsx](../../src/app/account/orders/[id]/page.tsx)、関連: [src/app/api/orders/[id]/route.ts](../../src/app/api/orders/[id]/route.ts)
- レビュー観点: 認証・所有権検証（IDOR）、注文PIIの露出、キャッシュ制御、列挙、レート制限
- 機械監査スコープ: UI到達クロージャ 8 ファイル / 関連Route Handler 5 件（LoginModal 経由で auth 系も到達）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| Open | 未修正 |
| Partially Fixed | アプリ層は対処済み、別層は未対処 |
| Fixed | 修正済み |

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/orders/[id]/route.ts](../../src/app/api/orders/[id]/route.ts) | 認証（`resolveRequestUser`）+ 所有権検証（`.eq('user_id', user.id)`）+ `maybeSingle` で他人注文は 404。IDOR 対策は適切 | 現行維持。RLS 側でも `user_id = auth.uid()` ポリシーが効いていることを確認 | Fixed | L100-138。所有権不一致は data=null→404、`Cache-Control: no-store` 付与 | Info |
| [src/app/api/orders/[id]/route.ts](../../src/app/api/orders/[id]/route.ts) | 注文詳細（氏名/住所/電話/メール等PII）を返す GET にレート制限がない。注文IDはUUIDで推測困難だが、漏洩ID列挙の多層防御として弱い | `orders:detail` 軸のIP/ユーザー レート制限を追加し、認可失敗を audit 記録 | Open | 他の公開系（items/cart/wishlist）はレート制限済みだが本 route は未設定 | Low |
| [src/app/api/orders/[id]/route.ts](../../src/app/api/orders/[id]/route.ts) | 画像URLは `signItemImageUrl`（service role 署名）で都度生成し、保存URLを直出ししない | 現行維持 | Fixed | L149-169。署名URLのみ返却 | Info |
| [src/app/account/orders/[id]/page.tsx](../../src/app/account/orders/[id]/page.tsx) | `/api/orders/${params.id}` を呼び、結果を React で描画（自動エスケープ）。`dangerouslySetInnerHTML` 不使用 | 現行維持 | Fixed | L61 fetch。表示はテキストバインドのみ | Info |

---

## 機械監査（page-audit.sh）所見の分類

| 機械検出 | 分類 | 根拠 |
|---|---|---|
| identify/otp/verify/logout「auth/CSRF なし」(HIGH) | 偽陽性（このページの責務外） | LoginModal がクロージャに含まれ login 系 route まで到達したもの。詳細は [security_review_login.md](./security_review_login.md) で評価済 |
| orders/[id] への直接指摘 | なし | 入力フォーカス検査・OWASP机上で追加 sink 検出なし |

## 重点結論

1. 注文詳細は認証＋所有権検証で IDOR 安全。PII 露出も所有者本人に限定。
2. 唯一の改善は detail GET のレート制限欠如（Low）。UUID 不可推測のため実害は限定的だが多層防御として付与推奨。
3. クロージャに login 系 route が混入する機械検出は本ページ責務外（login レビュー参照）。
