# ADR-0454 強制失効は自前の sessions の表と Supabase Auth の session の両方を消す

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/app/api/admin/revoke-user-sessions/route.ts`、`src/lib/auth/revoke-user-sessions.ts` | 基準コミット: `4facf63b`（2026-10-26 に `77e7f844` の作業ツリーで更新）

## 概要

管理者が利用者の session を強制失効させる時は、自前の `sessions` の表の行に失効の時刻を入れるだけでなく、service role だけが実行できる DB の関数 `revoke_auth_sessions_for_user` で Supabase Auth 側の session も消す。自前の更新も Auth 側の削除も、どちらかの誤りがあれば 500 を返す。この失効は共有の部品 `revokeAllSessionsForUser`（`src/lib/auth/revoke-user-sessions.ts`）にまとめ、2要素のリセット（ADR-0461）も使う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | FREQ-316-REQ-03（範囲外）、SEC-ADMIN-004、SEC-ADMIN-013・015（2026-10-26 に満たした）。SEC-ADMIN-016 は上位にしない（SEC-ADMIN-016 を参照） |
| 対象のコード | `src/app/api/admin/revoke-user-sessions/route.ts`、`src/lib/auth/revoke-user-sessions.ts`（範囲外の共有部品） |
| DB | DB の関数 `revoke_auth_sessions_for_user`（git `d9d693bd` で追加、実行は service role だけ）。試験 `tests/unit/migrations/091_auth_session_revocation.test.ts`（範囲外） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-316）、`docs/03_BasicDesign/api/api-spec.md` |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-26 の作業ツリー（単体・結合試験の写しで確かめた。2026-10-24 の記述を、同日の直しに合わせて更新した。本物の DB の関数との通しと E2E は未実行） |

## 判断

### ADR-0454 強制失効は自前の sessions の表と Supabase Auth の session の両方を消す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-316-REQ-03（範囲外）、SEC-ADMIN-004 |
| 根拠 | 自前の表だけを更新しても Supabase 側の session は生き残り、出した access token が期限まで通ってしまう。管理の窓口は JWT の session id が Auth 側で生きているかを見るので（ADR-0450）、Auth 側を消せば、その利用者の token は管理の窓口で即座に断られる（FREQ-316-REQ-03） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-316-REQ-03）、`src/app/api/admin/revoke-user-sessions/route.ts` のコメント、git `d9d693bd`（2026-08-30） |

#### 背景

- 前の強制失効は自前の `sessions` の表に失効の時刻を入れるだけだった（git `d9d693bd` より前）
- 他人の Auth の session を消す操作は、利用者の token では行えず、関数の実行も service role だけに絞った（`d9d693bd` のコミットの本文）

#### 決定

- 窓口は、本文の `user_id` が UUID の形で、要求した本人でなく、実在する利用者（`auth.admin.getUserById`）の時だけ失効に進む。自分自身は 400、存在しない利用者は 404（SEC-ADMIN-013・015）
- 共有の部品 `revokeAllSessionsForUser` で、自前の表のその利用者の行に失効の時刻を入れる。続けて DB の関数で Auth 側の session を消し、消した数を監査に残す
- 自前の更新か Auth 側のどちらかで誤りが出たら、部品が固定の文で throw し、窓口は結果 error・`revoke_failed` を監査に残して 500 を返す（誤りの文は残さない）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 自前の表だけを更新する（前の形） | 出した token が期限まで通る（`revoke-user-sessions/route.ts`） |
| 自前の更新の誤りを見ずに進む（2026-10-26 までの形） | 自前の表だけが残っても成功を返しうる。部品は両方の誤りで throw し、窓口は 500 にする |
| Auth 側の session の表をアプリから直接消す | 他人の session を消す操作を service role だけの関数1つに閉じ込め、実行できる人を絞るため（`d9d693bd`、推定） |

#### 結果

- 良くなること: 失効させた利用者の token は、期限を待たずに管理の窓口で断られる
- 悪くなること: 自前の表を先に更新し、続けて Auth 側を消すので、Auth 側が失敗すると自前の表だけが失効した状態で 500 になる（再実行すれば閉じる）。この判断は SEC-ADMIN-016 の上位にしない（SEC-ADMIN-016 を参照）。店長どうしの失効を止める守りは無い（ユーザーの決め待ち）
- 見直す条件: 自前の `sessions` の表をやめる時、失効の画面を作る時（今は呼ぶ画面が無い）

## 未確認事項

- `api-spec.md` の関数の名前（`revoke_sessions_for_user`）は今のコードの名前と違う（TM-ADMIN-13）
