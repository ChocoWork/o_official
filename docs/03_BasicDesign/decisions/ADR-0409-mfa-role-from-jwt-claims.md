# ADR-0409 TOTP の窓口は役割を検証した JWT のクレームから読み、DB の ACL を引かない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/mfa/{enroll-totp,status,verify}/route.ts` | 基準コミット: `4facf63b`

## 概要

TOTP の登録・状態・確認の3つの窓口は、役割を検証した JWT の `app_metadata` から読み、管理者とサポーターだけに TOTP を設定させる。DB の役割と権限の表（ACL）は引かない。管理の機能を使えるかは、管理の認可（`admin-rbac`）が DB の ACL と `aal2` で別に断る。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FR-LOGIN-007、SEC-AUTH-028 |
| 対象のコード | `src/app/api/auth/mfa/enroll-totp/route.ts`、`src/app/api/auth/mfa/status/route.ts`、`src/app/api/auth/mfa/verify/route.ts`、`src/lib/auth/admin-rbac.ts`（範囲外の共有部品） |
| 関連文書 | git `9f1a21c4` のコミットの文、`docs/02_Requirements/requirements.md` の FREQ-325 の行 |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0409 TOTP の窓口は役割を検証した JWT のクレームから読み、DB の ACL を引かない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-LOGIN-007、SEC-AUTH-028 |
| 根拠 | ここで決めるのは「自分のアカウントに TOTP を設定させるか」だけで、管理の機能へ入れるかは管理の認可が DB の ACL で別に断る。降格の直後の利用者が自分の端末で TOTP を設定できても権限は増えないので、ACL へのつながりを増やす得が無い（`9f1a21c4`、各窓口のコメント） |
| 状態 | 推定 |
| 出どころ | git `9f1a21c4` のコミットの文（「当初は ACL 由来へ移す計画だった」）、`src/app/api/auth/mfa/status/route.ts` のコメント。ユーザーの確認の記録は文書に見つけていない |

#### 背景

- 管理者とサポーターはメールの確認コードに加えて TOTP も通る（FR-LOGIN-007）
- 2026-09-01 に、認証の道を共有の `authenticateRequest`（JWT の検証とセッションの生存の確認）にそろえた（FREQ-325（範囲外）、`9f1a21c4`）。その時、TOTP の3つの窓口の役割を ACL から読むように移す計画があった

#### 決定

- 3つの窓口は共有の部品で認証し、役割を検証した JWT の `app_metadata` から読む。知らない値は一般の会員にする（`enroll-totp/route.ts`、`status/route.ts`、`verify/route.ts`）
- 登録と確認は、管理者とサポーター以外を 403 で断る（`enroll-totp/route.ts`、`verify/route.ts`）。状態は役割を返すだけ
- 役割は利用者が書き換えられる `user_metadata` からは読まない（SEC-AUTH-028）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 役割を DB の ACL から読む（当初の計画） | 判断の対象が自分の TOTP の設定だけで、権限は管理の認可が別に断るので、ACL へのつながりを増やす得が無い（`9f1a21c4`） |
| 役割を `user_metadata` から読む | 利用者が書き換えられる（SEC-AUTH-028） |

#### 結果

- 良くなること: TOTP の窓口が DB の ACL に頼らず、JWT の検証だけで役割が分かる
- 悪くなること: 役割は JWT の寿命の間（最大1時間）古いままでありうる。降格した直後の人も TOTP を設定できる。権限は増えない
- 悪くなること: TOTP の確認の回数の制限は IP 単位だけで、アカウント単位の制限と成否の監査は無い（`verify/route.ts`、SEC-AUTH-009）。この判断とは別の課題
- 見直す条件: 役割の変更をすぐに効かせる必要が出た時、TOTP の設定にも ACL の権限を課す時

## 未確認事項

- この判断をユーザーが承認したか（コミットの文にはあるが、文書の記録は見つけていない）。そのため状態は「推定」
