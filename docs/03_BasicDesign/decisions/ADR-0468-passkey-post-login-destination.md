# ADR-0468 ログインの後の行き先・戻り先の判定は、JWT のヒントで出した「パスキーの入口の条件」に置き換える

> 状態: 推定 | 確認日: 2026-11-17 | 対象: `src/features/auth/return-intent/return-intent-service.ts`、`return-path.ts`、`src/app/api/auth/post-login/route.ts`、`oauth/callback/route.ts`、`confirm/route.ts` | 基準コミット: bb6192c1

## 概要

ログインの後に店員をどこへ送るかの判定を、古い `aal2` から、パスキーの入口の条件（`amr` のパスキー・24時間以内・認めた2本）に置き換える。判定は JWT のヒントだけで行い、DB を数えない。名前（`needsMfa`・`/auth/verified`・拒否の理由 `admin_requires_privileged_aal2`）は 1b では変えず、段4でまとめて直す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-018、FR-AUTH-018、SEC-AUTH-043、THR-AUTH-044、DD-AUTH-054、DD-AUTH-034、DD-AUTH-035、ADR-0463 |
| 対象のコード | `src/features/auth/return-intent/return-intent-service.ts`、`return-path.ts`、`src/app/api/auth/post-login/route.ts`、`oauth/callback/route.ts`、`confirm/route.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-2・6-2）、[段1b の計画](../../superpowers/plans/2026-11-17-passkey-stage1b-server-endpoints.md)、[ADR-0463](ADR-0463-staff-entry-by-passkey-conditions.md) |
| 試験 | 単体 `tests/unit/features/auth/return-intent/`、`tests/unit/api/auth/post-login-route.test.ts`・`oauth-callback-route.test.ts`・`confirm-route.test.ts`、結合 `tests/integration/api/auth/return-intent-flow.test.ts`・`post-login.test.ts`、E2E `e2e/FR-LOGIN-054-passkey-post-login-destination.spec.ts` |
| 調べた時点 | 2026-11-17（手元の DB と本番ビルドの E2E で確かめた） |

## 判断

### ADR-0468 ログインの後の行き先・戻り先の判定は、JWT のヒントで出した「パスキーの入口の条件」に置き換える

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-043 |
| 根拠 | パスキーでログインした店員の JWT は `aal` が `aal1` のままなので、古い `aal2` の判定では全員が 2 段目に送られて入れない。行き先の判定を、管理の入口の条件（ADR-0463）と同じ `evaluateStaffEntry` にそろえる。行き先は「どの画面へ送るか」の決めで、権限の判定ではない |
| 状態 | 推定 |
| 出どころ | `docs/superpowers/specs/2026-11-07-passkey-auth-design.md`（5-2・6-2）、`.superpowers/sdd/2026-11-17-passkey-stage1b-server-endpoints/task-5-brief.md` |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| ログイン後の行き先の判定 | `aal2`（TOTP を通ったか）で決める | 店員の管理画面は店員の権限で決まり、ログイン後の行き先は権限の判定とは別（Shopify の公式資料でこの内部は読んでいない） | 行き先の判定は画面の出し分けで、権限は API・DB で都度確かめる（OWASP の「認可はサーバー側で都度」の考え方） | 行き先は JWT のヒントで決め、権限は管理の窓口と RLS が DB で数えて止める |

#### 決定

- `ReturnViewer = { role; staffEntryOk: boolean }`（`aal` をやめる）。`resolveReturnDestination`・`resolveStoredDestination`・`validateReturnPath` は、店員で `staffEntryOk` が真の時だけ `/admin` を通す。偽なら `{ path: '/login?error=staff_passkey_required', needsMfa: true, action: keep }`（段4の Task 30 で `/auth/verified` から付け替えた）
- `post-login` は `staffEntryOk = evaluateStaffEntry(claims, approvedCountHint(claims), now).ok`。`/api/auth/me` の `mfaVerified` と同じヒントで、DB を数えない。理由: ここは行き先の決めで、認めた鍵が消えた直後の最長1時間だけ古くなっても、管理の窓口と RLS が DB で数えて止めるので害は無い
- `oauth/callback`・`confirm` は常に `staffEntryOk: false` を渡す。Google・メールのリンクでは店員は入れない（フックが拒否する）ので、来ても 2 段目の側に倒す
- `oauth/callback` の交換が「店員はパスキーでだけ入れる」の印つきの 403 で失敗した時は、監査の `detail` を `staff_passkey_required` にし、誤りの文は残さない。応答は 502 のまま。店員への文言は段3
- 名前は変えない: `needsMfa`・拒否の理由 `admin_requires_privileged_aal2`・`/api/auth/me` の `mfaVerified` は今のまま（意味だけパスキーの条件）。段4の Task 30 で `/auth/verified` は消し、行き先は `/login?error=staff_passkey_required`（認めた鍵が1本の店員は `/admin/passkeys?more=1`）に付け替えた（ADR-0475）。名前は直さず、変えないと決めた（設計 7）
- 認めた鍵が1本の店員の着く先は、段3a で「もう1本」の画面 `/admin/passkeys?more=1` にした（段4の Task 30 から、ブラウザ側の `resolvePostLoginPath` が送る）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 行き先の判定で DB の認めた本数を数える | 行き先は画面の決めで、権限は別に DB で数えて止める。毎回 DB を数えると、ログインの後の1回ごとに DB への呼び出しが増える |
| 名前（`needsMfa` など）を直す | 画面・窓口・試験の名前が一度に変わり、約80本の E2E が形を偽装している。直さず、変えない（ADR-0475） |
| `aal2` と並べて両方を許す | パスキーの店員が `aal2` を持たないので、片方だけでは入口の抜け道が残る（ADR-0463 の切り替えと食い違う） |

#### 結果

- 良くなること: パスキーで入った条件を満たす店員が `/admin` へ着き、満たさない店員は `/admin`・`/admin` 向きの戻り先に着かない
- 悪くなること: 名前が古い（`aal2`）まま残る。認めた鍵が消えた直後は最長1時間 `/admin` の画面の骨組みへ着く（データは見えない）
- 見直す条件: 段3（もう1本の登録の画面）を作る時（済み）。名前は変えないと段4で決めた（ADR-0475）
