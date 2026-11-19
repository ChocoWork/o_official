# 管理画面「ユーザー」の店員の操作（招待・やり直し・お客さんに戻す・招待の取り消し・店員にする）

> 状態: 推定 | 確認日: 2026-11-20（段3b Task 18） | 対象: `src/features/auth/staff/components/InviteStaffDialog.tsx`、`RedoStaffDialog.tsx`、`StaffRoleActions.tsx`、`src/features/auth/staff/staff-user-actions.ts`、`src/components/UserSection.tsx`（差し込むだけ。AUTH の IMPL は付けない）

## 概要

店長が管理画面の「ユーザー」タブから、店員の招待・パスキーのやり直し・お客さんに戻す・招待の取り消し・「店員にする」を行う画面の処理。窓口は `POST /api/admin/staff/invites`・`[id]/redo`・`[id]/demote`・`[id]/invite/cancel` と `PATCH /api/admin/users`（API-AUTH-033〜036）。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 対応する ID | FR-AUTH-040、FR-AUTH-052、SCR-AUTH-016、SEC-AUTH-056、DD-AUTH-084、DD-AUTH-090 |
| 対象のコード | 上の「対象」のとおり |
| 関連文書 | [段3の計画](../../superpowers/plans/2026-11-18-passkey-stage3-staff.md)（Task 11・付録）、[招待・DB の関数](auth-staff-invite.md)、[管理画面の詳細設計](../pages/16_admin.md) |
| 調べた時点 | 2026-11-19（手元の DB・本番ビルドの E2E で確かめた） |

## 処理の詳細

### DD-AUTH-084 管理画面の店員の操作は、確認を挟んで窓口を1回だけ呼び、失敗は窓口の符号から決めた文を `LiveMessage` に出す

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-056、SCR-AUTH-016 |
| 根拠 | やり直しは取り返しがつかないので、確認の語と理由（10〜500字）を画面の側でも揃えるまで送らせない（窓口と同じ守り）。送信中は送るボタンを `disabled`・`aria-busy` にして二重に送らせない。店員にする（昇格）は招待のメールを出すだけで役割はすぐには変わらないので、画面も役割を先に書き換えない。失敗の文は窓口の本文でなく符号と状態から決め、503 は一時的な障害なのでログアウトにせず再試行を案内する |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/staff/user-section-staff.test.tsx`、`staff-user-actions.test.ts`、`tests/unit/components/UserSection.test.tsx`）、結合テスト（`tests/integration/ui/auth-admin-users-staff-screen.test.tsx`）、E2E（`e2e/FR-LOGIN-070-admin-users-staff-screen.spec.ts`、`e2e/FR-ADMIN-108-select-fields.spec.ts`） |
| 出どころ | `.superpowers/sdd/2026-11-18-passkey-stage3-staff/task-11-brief.md`、`docs/superpowers/plans/2026-11-18-passkey-stage3-staff.md`（Task 11） |

```mermaid
sequenceDiagram
    participant U as 店長（画面）
    participant S as UserSection
    participant A as 窓口（staff/* ・ PATCH users）
    U->>S: 操作（招待・やり直し・戻す・取り消し・店員にする）
    S->>U: 確認（やり直しは語と理由、戻す・店員にするは確認のダイアログ）
    U->>A: 確認の後に1回だけ送る（送信中は disabled・aria-busy）
    A-->>S: 200 / 4xx / 502 / 503
    S->>U: 成功は知らせを出し一覧を読み直す。失敗は LiveMessage（ダイアログは開いたまま）
```

- 送りの部品 `postStaffAction`（IMPL-AUTH-396）: `clientFetch` で POST し、成功か `{ ok:false, message }` を返す（投げない）。`staffInviteFailureMessage`: 502・`mail_failed` は「メールを送れませんでした。もう一度、招待を出してください。」、`already_staff` は一覧の「パスキーを全部消してやり直す」の案内、503 は「ただいま処理できません。しばらくしてからお試しください。」。無操作の 401 `session_idle` は `clientFetch` が `/login?reason=idle` へ送る
- 招待（IMPL-AUTH-393）: メール・役割（サポーター・店長）。メールが空のあいだは送れない
- やり直し（IMPL-AUTH-394。段3b Task 18 で DD-AUTH-090 へ移した）: 確認の語が「やり直し」と等しく、理由（前後の空白を除く）が10〜500字のあいだだけ送れる
- 1行の操作（IMPL-AUTH-395。段3b Task 18 で DD-AUTH-090 へ移した）: 店員の行は認めた鍵の本数・やり直し・お客さんに戻す（確認を挟む）。自分の行・最後の店長の行は押せず理由の文を出す。役割が無く開いた招待がある人は「招待中」と「招待を取り消す」
- 429（回数の枠）: 「ただいま処理できません。しばらくしてからお試しください。」を出す（ログアウトにしない）
- 店員の行の役割の選択は Admin・Support の2つだけ。お客さんに降ろす道は「お客さんに戻す」（確認を挟む）だけで、選択欄からは確認なしに降格できない
- 一覧（`UserSection`、差し込むだけ）: 自分の id は `/api/auth/me` で読み、最後の店長は一覧の店長が1人の時の行。お客さんの行で Admin・Support を選ぶと「店員にする」の確認を出し、確認後に PATCH。役割は書き換えず、成功したら一覧を読み直す（`silent`）
- 段3b Task 18 の直しは DD-AUTH-090 に書く
- 既知の残り: 一覧は `GET /api/admin/users` の最初の200人まで（既存の制限）。自分の id が読めない時は自分の行のボタンは押せるが、窓口が 403 `self` で断る

### DD-AUTH-090 店長の画面の持ち越しの直し（やり直しのメールの失敗・招待の取り消しの確認・確認の文・通知とフォーカス・店員のパスキーの削除の失敗の文）

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-AUTH-016 |
| 根拠 | やり直しの窓口が 502 `mail_failed` を返す時は、DB の発行は済んでいる（メールだけが出ていない）。ダイアログに失敗を出したままだと、一覧は古いまま（行がまだ店員のまま）で、店長はやり直しが効いたか分からない。だからダイアログを閉じて一覧を読み直し、既存の文を通知に出す。招待の取り消しは取り返しがつかない（同じリンクが使えなくなる）ので確認を挟む。「招待しました」は、サーバーが答えた事実（`invited: true`）だけに従い、クライアントの旗では出さない。一覧の再描画で押したボタンやダイアログが消えるので、フォーカスを見出しへ戻す。失敗の通知と成功の通知を同時に出さない。店員のパスキーの削除が失敗した時は、下限（409 `staff_min_keys`）とそれ以外（500・通信の失敗）で文を分ける（F-4。下限でない失敗に「認めた鍵は2本以上」と出すと、店員が原因を取り違える） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト（`tests/unit/features/auth/staff/user-section-staff.test.tsx`、`staff-user-actions.test.ts`、`tests/unit/components/UserSection.test.tsx`）、結合テスト（`tests/integration/ui/auth-admin-users-staff-screen.test.tsx`）、E2E（`e2e/FR-LOGIN-072-admin-users-staff-recovery.spec.ts`、`e2e/FR-LOGIN-070-admin-users-staff-screen.spec.ts`。F-4（店員のパスキーの削除の失敗の文。DD-AUTH-082 の画面）の単体テスト（`tests/unit/features/auth/passkey/passkey-client-min-keys.test.ts`、`staff-passkey-manager.test.tsx`）も、名前の先頭を DD-AUTH-090 にしている） |
| 出どころ | `.superpowers/sdd/2026-11-19-passkey-stage3b-staff-ops/task-18-brief.md`、`docs/superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md`（Task 18） |

- 送りの部品 `postStaffAction`（IMPL-AUTH-396）: 失敗が 502・`mail_failed` の時だけ `{ ok:false, message, mailFailed: true }` を返す
- やり直し（IMPL-AUTH-394）: `mailFailed` の時は、ダイアログに失敗を出さず `onMailFailed(message)` を呼ぶ。それ以外の失敗は今までどおりダイアログの `LiveMessage`
- 1行の操作（IMPL-AUTH-395）: `onMailFailed` でダイアログを閉じて `onError(message, { reload: true })`。「招待を取り消す」は確認「この招待を取り消します。よろしいですか。」（「取り消す」「キャンセル」）の後に取り消しの窓口を呼ぶ。`cancelled: false` の扱い（DD-AUTH-091）は変えない
- F-4（店員のパスキーの画面。DD-AUTH-082。IMPL-AUTH-385・310）: `passkey-client` の失敗の理由に `min_keys` を足し、窓口の 409 で本文が `staff_min_keys` の時だけそれにする（それ以外の 409・500・通信の失敗は `failed`）。管理の画面は `min_keys` に下限の文、`failed` に「削除できませんでした。もう一度お試しください。」を出す。失敗の応答の本文は必ず読み切る
- 一覧（`UserSection`、差し込むだけ）: `onError` は前の成功の通知を消し、`reload` なら一覧を読み直す。成功の読み直しの後は、フォーカスが `body`（か無し）に落ちている時だけ、見出し（`tabIndex={-1}`）へ戻す（生きた要素にあれば奪わない。`AccountPasskeys`・`StaffPasskeyManager` と同じ決まり）。PATCH の成功は応答の `invited: true` の時だけ「招待のメールを送りました。」を出して一覧を読み直す。「店員にする」の確認の文は「`<メール>` へ、店長／サポーターの招待のメールを送ります。…」
