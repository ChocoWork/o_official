# ADR-0454 強制失効は自前の sessions の表と Supabase Auth の session の両方を消す

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/admin/revoke-user-sessions/route.ts` | 基準コミット: `4facf63b`

## 概要

管理者が利用者の session を強制失効させる時は、自前の `sessions` の表の行に失効の時刻を入れるだけでなく、service role だけが実行できる DB の関数 `revoke_auth_sessions_for_user` で Supabase Auth 側の session も消す。Auth 側を消せなければ 500 を返す。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 対応する ID | FREQ-316-REQ-03（範囲外）、SEC-ADMIN-004。SEC-ADMIN-016 は上位にしない（SEC-ADMIN-016 を参照） |
| 対象のコード | `src/app/api/admin/revoke-user-sessions/route.ts` |
| DB | DB の関数 `revoke_auth_sessions_for_user`（git `d9d693bd` で追加、実行は service role だけ）。試験 `tests/unit/migrations/091_auth_session_revocation.test.ts`（範囲外） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-316）、`docs/03_BasicDesign/api/api-spec.md` |
| 要件の文書 | `docs/02_Requirements/areas/admin.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

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

- 自前の表の、その利用者の行に失効の時刻を入れる（`revoke-user-sessions/route.ts`）
- 続けて DB の関数で Auth 側の session を消し、消した数を監査に残す
- Auth 側で誤りが出たら、結果 error を監査に残して 500 を返す

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 自前の表だけを更新する（前の形） | 出した token が期限まで通る（`revoke-user-sessions/route.ts`） |
| Auth 側の session の表をアプリから直接消す | 他人の session を消す操作を service role だけの関数1つに閉じ込め、実行できる人を絞るため（`d9d693bd`、推定） |

#### 結果

- 良くなること: 失効させた利用者の token は、期限を待たずに管理の窓口で断られる
- 悪くなること: 自前の表の更新の誤りは見ないので、自前の表だけが残っても 200 を返しうる（`revoke-user-sessions/route.ts`）。この判断は SEC-ADMIN-016 の上位にしない（SEC-ADMIN-016 を参照）。利用者の id は UUID かを見ず、自分自身と存在しない利用者も断らない（SEC-ADMIN-015）
- 見直す条件: 自前の `sessions` の表をやめる時、失効の画面を作る時（今は呼ぶ画面が無い）

## 未確認事項

- `api-spec.md` の関数の名前（`revoke_sessions_for_user`）は今のコードの名前と違う（TM-ADMIN-13）
