# ADR-0466 フックが更新を拒否した店員のセッションは、アプリが終わらせる

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/app/api/auth/refresh/route.ts` | 基準コミット: 77b0a489

## 概要

GoTrue のフックが店員の更新を拒否した（403 で文の頭が印 `[staff-passkey-required]`）時だけ、アプリがそのセッション（`public.sessions` の行と GoTrue の `auth.sessions`）を終わらせ、Cookie を消して 401 を返す。印の無い失敗は今のまま。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-020、FR-AUTH-022、SEC-AUTH-047、THR-AUTH-048、DD-AUTH-058、API-AUTH-014、ADR-0463 |
| 対象のコード | `src/app/api/auth/refresh/route.ts`、`src/lib/auth/staff-passkey-reject.ts`（1a） |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-2）、[段1b の計画](../../superpowers/plans/2026-11-17-passkey-stage1b-server-endpoints.md)、[ADR-0463](ADR-0463-staff-entry-by-passkey-conditions.md) |
| 試験 | 単体 `tests/unit/api/auth/refresh-route.test.ts`、E2E `e2e/FR-LOGIN-053-passkey-refresh-rejection.spec.ts` |
| 調べた時点 | 2026-11-17（手元の GoTrue v2.196.0 と本番ビルドの E2E で確かめた） |

## 判断

### ADR-0466 フックが更新を拒否した店員のセッションは、アプリが終わらせる

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-047 |
| 根拠 | 拒否された更新の後、アプリが Cookie を消すだけだと、GoTrue の `auth.sessions` の行と `public.sessions` の行が生きたまま残り、前のアクセストークン（最長1時間）が `/api/auth/me` やお客さんの機能で使い続けられる。管理の入口は24時間の条件で止まる（1a）が、期限が切れた店員のセッションそのものを終わらせる方が、残りのセッションを数えない・無操作1時間（段3）の土台になる |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-2。「段1で決める」とした点）、`.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/task-9-brief.md`（作り手の判断） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 更新が拒否された後のセッション | 拒否は想定外。Cookie を消して 401 を返すだけで、セッションの行は残る | 店員の権限が変わると、その店員の管理画面のセッションは次の要求で切れる（Shopify の公式資料でこの内部は読んでいない。推定） | OWASP のセッション管理の手引きは、認証の条件を満たさなくなったセッションをサーバー側で無効にするよう求める | 条件を満たさなくなったことが分かった時点で、サーバー側のセッションを終わらせる |
| 一時の不調との区別 | 区別しない（全部 Cookie を消す） | 不明 | 一時の失敗でセッションを捨てると正当な利用者を追い出すので、確かな拒否の印だけで捨てる | 印（文の頭の一致）がある拒否だけ終わらせる |

#### 決定

- GoTrue の `/token?grant_type=refresh_token` が 403 で、本文の `msg`（無ければ `message`）が `isStaffPasskeyRequiredError`（1a）を満たす時だけ、前の `public.sessions` の行（`session.id`）を `revoked_at = now()` にし（`persistNewSession` は呼ばず、新しい行は作らない）、その行の `auth_session_id` があれば RPC `revoke_auth_session` で GoTrue のセッションを消す
- 拒否された更新は GoTrue のセッションを終わらせない（手元の試し T2）ので、アプリが消す
- 3つの認証 Cookie を消し、401 `{ error: 'Staff passkey required', code: 'staff_passkey_required' }` を返す。画面は `/login` に送る（文言は段3）
- 監査は `outcome: failure`・`detail: staff_passkey_required_session_ended`。行の失効か RPC が落ちたら `outcome: error`・`detail: staff_passkey_required_end_failed`。どちらが落ちても Cookie は消して 401（閉じる側）。片方が落ちても両方を試す
- 印の無い403・401・5xx・ネットワークの誤りは今のまま。旗 `AUTH_REQUIRE_APP_SESSION` の挙動とお客さんの更新は変えない
- 印の判定は文字列の頭の一致だけ（1a の `isStaffPasskeyRequiredError`）。手元の試し T2 で 403・`code: unknown`・フックの文と確かめた。本番で形が違わないかは設計 8-2 の9で確かめる

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 終わらせずに 401 だけ返す | 拒否の後も `/api/auth/me` が最長1時間 `authenticated: true` を返し続け、画面の表示（`mfaVerified: false`）と「ログイン状態」の食い違いが出る |
| 印の無い失敗でも終わらせる | GoTrue の一時の不調（5xx など）で、正当な利用者のセッションを捨ててしまう |
| 終わらせる処理が落ちたら Cookie を残して 5xx を返す | 拒否された店員の Cookie が残り、再試行が続く。閉じる側（Cookie を消して 401）に倒す |

#### 結果

- 良くなること: 条件を失った店員のセッションが、拒否された時点で終わる。前のアクセストークンも `/api/auth/me` で `authenticated: false` になる。残りのセッションを数える・無操作1時間（段3）の土台になる
- 悪くなること: 印の形が本番の GoTrue で違うと、終わらせずに今までどおり Cookie を消して 401 になる（閉じる側のまま）。終わらせる処理が落ちた時は GoTrue の行が残りうる（管理の入口は24時間の条件で止まる）
- 見直す条件: 本番の GoTrue の拒否の形を読んだ時（設計 8-2 の9）、段3（拒否の後の画面の文言・無操作1時間）を作る時
