# ADR-0405 漏れたパスワードの照合はアプリで HIBP の k-匿名の方式で行い、届かない時は止めずに監査に残す

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/register/route.ts`、`src/app/api/auth/password-reset/confirm/route.ts`、`src/lib/pwned-password.ts`（範囲外の共有部品） | 基準コミット: `4facf63b`

## 概要

会員登録と再設定の確定で、HaveIBeenPwned の Pwned Passwords の範囲の API に SHA-1 の先頭5文字だけを送り、返った一覧と手元で照らす。漏れていれば 400 で断る。API に届かない時は登録・再設定を通し、照合できなかったことを監査に残す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-323-REQ-01、FREQ-323-REQ-02、SEC-AUTH-014 |
| 対象のコード | `src/app/api/auth/register/route.ts`、`src/app/api/auth/password-reset/confirm/route.ts`、`src/lib/pwned-password.ts`（範囲外の共有部品） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-323 の行） |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0405 漏れたパスワードの照合はアプリで HIBP の k-匿名の方式で行い、届かない時は止めずに監査に残す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-323-REQ-01、FREQ-323-REQ-02、SEC-AUTH-014 |
| 根拠 | Supabase の漏れたパスワードの守り（leaked password protection）は Pro の契約からしか使えないので、同じ守りをアプリに置く（FREQ-323 の行、`register/route.ts`）。パスワードもハッシュの全部も外に出さない。外のサービスの障害で自社の登録・再設定を止めない |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-323 の行） |

#### 背景

- 最小の長さを 16 文字にし、文字の種類の決まりは足さない（FREQ-323-REQ-03）。強さは長さと漏洩の照合で持たせる
- 照合を課す道は、会員登録と再設定の確定の2つ

#### 決定

- 範囲の API（`pwned-password.ts`）に SHA-1 の先頭5文字だけを送り、残りは手元で照らす（FREQ-323-REQ-01）
- 漏れていれば 400 で断る（`register/route.ts`、`confirm/route.ts`）
- 時間切れ（`pwned-password.ts`）や 200 でない応答・例外は「照合できない」とし、呼ぶ側は通して監査に `pwned_check_unavailable` を残す（`register/route.ts`、`confirm/route.ts`）
- 再設定では、印の行が有効だと確かめた後に照合する。消費済みや偽の印で外の API を叩かせない（`confirm/route.ts`）。会員登録ではボットの確かめと送り先の住所の見張りの後に置く（`register/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| Supabase の leaked password protection を使う | Pro の契約からしか使えない（`register/route.ts`、`confirm/route.ts`） |
| 届かない時は断る（fail-closed） | 外のサービスの障害で自社の登録・再設定が止まる（FREQ-323-REQ-02） |
| パスワードのハッシュの全部を送る | 外にハッシュを渡すことになる。範囲の方式なら先頭5文字だけで済む（FREQ-323-REQ-01） |
| 再設定で印の確かめの前に照合する | 未認証の相手に外の API を叩かせる踏み台になり、待ち時間も無駄になる（`confirm/route.ts`） |

#### 結果

- 良くなること: 無料の契約のままで漏れたパスワードを断れる
- 悪くなること: HIBP が落ちている間は漏れたパスワードも通る。監査の印で期間を追うしかない
- 悪くなること: 公開の anon の鍵で Supabase Auth の登録やパスワードの変更を直接呼ぶと、この照合も 16 文字も通らない（推定、SEC-AUTH-015）。手元の Supabase の最小の長さは 6（`supabase/config.toml`）
- 見直す条件: Supabase の契約を Pro 以上にする時、HIBP の範囲の API の扱いが変わる時

## 未確認事項

- 本番の Supabase の最小の長さ・漏洩の照合の設定（ダッシュボードは見ていない）
