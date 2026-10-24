# ADR-0406 トークンの更新の門番は Supabase のトークンの交換とし、自前の sessions の表は明示の失効の印の時だけ断る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/refresh/route.ts`、`src/features/auth/services/session.ts`（範囲外の共有部品） | 基準コミット: `4facf63b`

## 概要

`/api/auth/refresh` は、refresh の Cookie を Supabase のトークンの交換に出し、Supabase が断ったら 401 にして認証の Cookie を消す。自前の `sessions` の表は監査のための記録として扱い、行が無くても断らない。断るのは、行に失効の印（`revoked_at`）が立っている時だけ。使い回しの見つけ出しは Supabase Auth に任せ、自前の印（jti）の照合はしない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | DRV-AUTH-008、SEC-AUTH-021 |
| 対象のコード | `src/app/api/auth/refresh/route.ts` |
| 関連文書 | git `e476b83e` の P1-3、`docs/04_DetailDesign/sequence/auth-session.md`、`docs/03_BasicDesign/architecture/auth-structure.md` の 5 章、`docs/04_DetailDesign/pages/14_login.md` |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0406 トークンの更新の門番は Supabase のトークンの交換とし、自前の sessions の表は明示の失効の印の時だけ断る

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-AUTH-008、SEC-AUTH-021 |
| 根拠 | 自前の表に行が無いのは「失効の証拠が無い」だけで、取りこぼしで正しい利用者を締め出さないため。推測（jti・前のハッシュの照合）をしないので誤って断らない。ログアウトや管理者の強制の失効が Supabase へ届かなかった時の最後の砦として、明示の失効の印だけは見る（`refresh/route.ts`） |
| 状態 | 推定 |
| 出どころ | `src/app/api/auth/refresh/route.ts` のコメント、git `e476b83e` のコミットの文（P1-3「残った唯一の門番」）。ユーザーの確認の記録は見つけていない |

#### 背景

- 前の設計は、refresh の印を DB にハッシュで持ち、jti を `sessions.current_jti` に置いて回し、使い回しを見つけたら隔離・通知・全部のセッションの失効、としていた（`auth-structure.md` の 5 章、`14_login.md`）
- この使い回しの見つけ出しは消され、`e476b83e` で代わりのテストとして「失効の印があれば 401 と Cookie の消去」「Supabase が交換を断れば 401 と Cookie の消去」を固めた

#### 決定

- refresh の Cookie が無ければ 401（`refresh/route.ts`）
- 自前の表を引き、行が無ければ警告だけ出して進む（`refresh/route.ts`）。行に失効の印があれば監査に残し、401 と Cookie の消去
- service role の鍵で Supabase のトークンの交換を呼ぶ（`refresh/route.ts`）。断られたら監査に残し、401 と Cookie の消去
- 交換できたら新しい Cookie と表の行を作る。表への記録に失敗しても、出したトークンは必ず配る。前の refresh の印は既に無効なので、500 にすると利用者は死んだ印だけを持って詰む（`refresh/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| jti を回して自前で使い回しを見つける（前の設計） | 推測の照合は誤って断りうる。使い回しの見つけ出しは Supabase Auth が持つ（`refresh/route.ts`） |
| 自前の表に行が無ければ断る | 記録の取りこぼしで正しい利用者を締め出す（`refresh/route.ts`） |
| 表への記録に失敗したら 500 にする | 前の印が既に無効なので、利用者が詰む（`refresh/route.ts`） |

#### 結果

- 良くなること: 自前の表の欠けで利用者が締め出されない。門番が Supabase の1つにまとまる
- 悪くなること: 使い回しを見つけた時の隔離・通知は無い。Supabase の使い回しの見つけ出しの設定に頼る
- 悪くなること: 応答の本文にも新しい access token と利用者の記録を入れている（`refresh/route.ts`）。SEC-AUTH-022 と合わない
- 文書: `auth-structure.md` の 5 章と `14_login.md` の jti の回しは今のコードと合わない（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる）。DRV-AUTH-008 の本文の「自前の表に行が無い時は断る」も合わなかったが、2026-10-24 に「行が無くても続け、明示の失効の印がある時だけ断る」へ直した
- 見直す条件: Supabase の refresh の使い回しの見つけ出しの設定を変える時、隔離・通知を入れる時

## 未確認事項

- 本番の Supabase の refresh の使い回しの見つけ出しの設定と寿命（`auth-session.md` も未確認とする）
- jti の回しを消した判断をユーザーが承認したか。そのため状態は「推定」
