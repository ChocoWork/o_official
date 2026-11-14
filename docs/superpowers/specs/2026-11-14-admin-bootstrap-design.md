# 最初の店長を作るコマンドの設計

確認日: 2026-11-14

## 目的と理由

新しい環境（手元の `db reset` の後・検証用・作り直した本番）を作った時、最初の店長（`admin` の役割の人）を作る道が無い。2人目からは店長が管理画面で作れる（`/api/admin/create-user` と `admin_set_user_role`）。今は E2E・結合テストが SQL で `user_roles` に直接書いて店長を作っている。

この設計は、環境を作る人（Supabase の住所と service role キーを持つ人）だけが流せるコマンドを1本足し、最初の店長を作れるようにする。

## 決めたこと（オーナー 2026-11-14）

- 使う場面: 新しい環境を作る時だけ
- やり方: 手元で流すコマンド（案1）

## 案の比べ

| 案 | 中身 | 良い点 | 弱い点 | 結果 |
|---|---|---|---|---|
| 1 コマンド | 手元で `npm run admin:bootstrap` を流す。Django `createsuperuser`・Mastodon `tootctl accounts create --role Owner` と同じ形 | Web に入口が無い。どの環境にも同じ手順で使える | 鍵を持つ人が端末で流す必要がある | **採用** |
| 2 初期データの SQL | `supabase/seed.sql` で手元の DB に店長を入れる | 手元は手間ゼロ | 手元でしか流れない。パスワードがファイルに残る | 不採用 |
| 3 画面＋使い捨ての鍵 | 環境変数に鍵がある時だけ `/setup` を開く（Jenkins の形） | 画面だけで済む | 公開の入口が増える（2017 年の WordPress の WPSetup 攻撃の型）。守りが一式要る。環境を作る人は鍵を持っているので得が少ない | 不採用 |

## コマンドの動き

```text
npm run admin:bootstrap -- --email <店長のメール> [--name <表示名>]
```

1. 環境変数 `SUPABASE_URL`（無ければ `NEXT_PUBLIC_SUPABASE_URL`）と `SUPABASE_SERVICE_ROLE_KEY` を読む。無ければ止まる。コマンド自体は `.env` を読まない。手元では `--env-file=.env.development.local` を付けて流す例を手順書に書く
2. 向ける先の Supabase の住所（ホスト名）を画面に出す
3. 有効な店長（`user_roles` の `admin` で `active = true`、期限切れでない）が既に1人でもいれば、何もせずに止まる
4. 同じメールのアカウントが既にあれば止まる
5. パスワードを2回、字を出さずに聞く。会員登録と同じ決まり（`passwordSchema`：16〜128 文字・UTF-8 で 72 バイト以内）と漏洩の照合（`checkPwnedPassword`）を当てる。照合先が使えない時は `/api/admin/create-user` と同じく通して警告を出し、監査に残す
6. Auth の利用者を確認済み（`email_confirm: true`）で作る。`app_metadata.role = 'admin'`
7. `user_roles` に `admin` の役割を `active = true`・期限なしで入れる
8. 6 の後で 7 が失敗したら、6 で作った利用者を消して止まる（流し直せるように）
9. 監査に1行残す（`action: 'admin_bootstrap'`・行為者なし・作った利用者の id）。パスワードは残さない
10. 作った利用者の id とメールを出して終わる

TOTP はこのコマンドでは作らない。作った店長は、最初のログインで今の流れ（メール OTP の後に TOTP を登録。SEC-AUTH-031）を通る。

## 目指さないこと

- 店長が全員ログインできなくなった時の立て直し（パスワード・TOTP の作り直し）
- Web の初回画面
- サポーターの作成、2人目以降の店長の作成（管理画面ですでにできる）
- 手元の `db reset` で店長を自動で入れること
- 2回を同時に流した時の重なりの防止（環境を作る人が1人で1回流す前提）

## 確かめ方

- 単体テスト: 既に店長がいる・同じメールがある・パスワードが短い・2回の入力が違う・役割の書き込みが失敗した時の後始末
- 結合テスト（手元の Supabase）: 店長のいない DB で流すと `user_roles` と `app_metadata` が店長になり、監査に1行残る。2回目は止まる
- E2E（390 / 768 / 1280px）: コマンドで作った店長が、ログイン → メール OTP → TOTP の登録の画面まで進める

## 文書

範囲（`scripts/trace/scope.json`）の ADMIN 領域として扱う。

- 要件: `docs/02_Requirements/areas/admin.md` に `SR-ADMIN-NNN` を足す（番号は `documentation-guide` に従う）
- 運用の手順: `docs/06_Operations/` に「新しい環境の最初の店長」の節を足す
- 作業と指摘の台帳の状態欄を直す

## 作り手に任せること

- コマンドの置き場所（`scripts/` の下）と書き方（`tsx` で `@/` の部品を読み込む）
- パスワードを字を出さずに聞く方法
- テストの細かい組み立て
