# ADR-0471 店員の招待は、古い鍵・認証アプリ・役割を発行の時に全部外し、招待の窓の中で2本そろった時だけ役割を有効にする

> 状態: 推定 | 確認日: 2026-11-18 | 対象: `supabase/migrations/20261118130000_passkey_staff_invites.sql`、`src/lib/auth/staff-passkey-invite-errors.ts`

## 概要

店員を招く時の作り方（発行・窓の開け方・役割の有効化）を決める。DB の関数は Task 2、窓口と画面は Task 4 以降。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | SR-AUTH-026、FR-AUTH-034、FR-AUTH-035、DATA-AUTH-020、ARC-AUTH-012、SEC-AUTH-053、DD-AUTH-070、DD-AUTH-071、DD-AUTH-072、FR-AUTH-038、FR-AUTH-039、FR-AUTH-040、API-AUTH-033、API-AUTH-034、API-AUTH-035、API-AUTH-036、SEC-AUTH-056、DD-AUTH-076、DD-AUTH-077 |
| 対象のコード | `supabase/migrations/20261118130000_passkey_staff_invites.sql`、`src/lib/auth/staff-passkey-invite-errors.ts` |
| 関連文書 | [設計](../../superpowers/specs/2026-11-07-passkey-auth-design.md)（5-4・6-2・8-1）、[段3の計画](../../superpowers/plans/2026-11-18-passkey-stage3-staff.md)、[招待の DB の関数の詳細](../../04_DetailDesign/sequence/auth-staff-invite.md) |
| 調べた時点 | 2026-11-18（手元の Supabase で結合試験を流した） |

## 判断

### ADR-0471 店員の招待は、古い鍵・認証アプリ・役割を発行の時に全部外し、招待の窓の中で2本そろった時だけ役割を有効にする

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-AUTH-053、SEC-AUTH-056 |
| 根拠 | 役割を先に付けて鍵を足させると、鍵が足りない店員が管理に入れる。招待の時に外せば、古い鍵や認証アプリを持った人が新しい招待で店員に戻らない。認証アプリは種類を問わず全部外す（GoTrue が要素の残る人にパスキーの登録・削除で aal2 を求めるため） |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-11-18-passkey-stage3-staff/task-2-brief.md`、`docs/superpowers/plans/2026-11-18-passkey-stage3-staff.md`（Task 2） |

#### 背景

| 観点 | 以前の私たち | Shopify | 業界の定番 | 結論 |
| --- | --- | --- | --- | --- |
| 店員の招待 | 管理画面でパスワードの店員を作っていた | 出典なし（社内の比較。店員の招待のメールから入る形は知られているが、鍵の入れ替えの扱いは確かめていない） | OWASP Authentication Cheat Sheet（https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html）の資格情報の再発行の考え方（古い資格情報は新しい物が確定するまで有効にしない・使えなくする）を当てはめた社内の判断 | 発行で全部外し、窓の中の2本で有効にする |

#### 決定

- 発行は1つの取引: 古い招待を取り消し、窓を閉じ、鍵・認めた鍵・認証アプリの全要素・役割を外し、新しい招待を作る。途中で止まらない
- 錠は全体の `190519` → その人の錠の順。発行者・操作者は錠の後に確かめる
- 窓の開け方は案 B: 消費では窓を開けず、結びで `session_id` に窓を開け、2本そろったら有効化
- 有効化の門は DB の関数の1つだけ: 窓が開いている・鍵が全部窓で認めた鍵で結びの後・本数が足りる
- `last_resort` の種類はアプリの鍵では通らない（後半の `postgres` だけの関数が使う）
- 店長の窓口（段3a の Task 5）は `staff-invite-store` の関数だけを呼び、SQL を直に書かない。招待・上げる・やり直しは、発行 → 古いログインの終了 → メールの順で行う。リンクの元はサイトの設定の住所で、要求の Host・Origin は使わない。メールが送れない設定は鍵を消す発行の前に断る。今の店員への `invite`・`promote` は DB が `STAFF_ALREADY_STAFF` で断り、やり直しだけが確認の語と理由で鍵を消せる。降格は招待も取り消す `staff_demote` だけで行う（`admin_set_user_role` の `user` への変更は使わない）

#### 結果

- 良くなること: 鍵が足りない・窓の外の鍵がある人は店員にならない。古い鍵の乗っ取りが招待で終わる
- 悪くなること: やり直しは本人の鍵・認証アプリを全部消すので、本人は2本とも作り直す
- 悪くなること: メールの送りに失敗した招待は、鍵とログインが既に消えている。窓口は 502 で「もう一度、招待を出してください」と返し、再発行が古い行を取り消す
- 残る危険: GoTrue の鍵の挿入は錠を取らない（有効化の門が全部の鍵を見るので、混ざれば有効にならない）
- 見直す条件: 本番の GoTrue が `auth.mfa_factors` の削除を受け付けない時、窓が30分で足りない時
