# パスキーの手元の試し（T1〜T7）の結果

> 対象: [ログインをパスキーに置き換える 設計書](2026-11-07-passkey-auth-design.md) の 4-1「最初に手元で試す」の T1〜T7
> 関連: [試しの計画](../plans/2026-11-16-passkey-local-trials.md)、[設計書](2026-11-07-passkey-auth-design.md)
> 確認日: 2026-11-16。手元の使い捨ての Supabase（本番にも、いつもの手元の Supabase にも触れていない専用の物）で動かして測った結果と、レビューが読んだソースを書く。本番のホスト版の挙動は未確認

---

## 概要

結論: **T1〜T6 は設計どおりに動いた。T7 は手元では測れず、ソースから「免除されない」が有力。段1（作る作業）に進めない崩れは無い。** ただし注意が4つある。(1) T6 は設計 6-2 手順 3 の直しが要る（案 B を勧める）。(2) T4 はソフトの認証器だけで確かめた。(3) Google のログインは本物では未試験。(4) T5 と T7 は本番で確かめる必要がある。オーナーに決めていただくことは、末尾の一覧に8つある。

使った物の版は次のとおり。

| 物 | 版 |
| --- | --- |
| GoTrue（Supabase のログインを受け持つ部分） | v2.196.0（起動した入れ物のイメージ名で確認） |
| Supabase CLI | 2.116.0 |
| `@supabase/supabase-js`（`auth-js` も同じ） | 2.119.0（試しの道具の中だけに入れた。リポジトリ本体は上げていない） |
| Postgres | 17.6.1.165 |
| ブラウザ | Playwright 1.58.2 の Chromium（本物のキーの代わりに、仮想の認証器を使った） |

「確かさ」の言葉は次の意味。確定 = 手元で実際に動かして確かめた。有力 = ソースや文書の裏付けはあるが、動かして確かめていない。暫定 = 一部だけ確かめた、または推論。

| # | 確かめたこと | 結果 | 確かさ | 証拠の記録（試しの記録の名前） |
| --- | --- | --- | --- | --- |
| T1 | パスキーの登録とログインが動き、JWT（ログインの証明書）が `aal1`・`amr` に `passkey` を持つ | PASS | 確定 | `t1.log` |
| T2 | フックで店員の「パスキー以外のログイン」と「上限を超えた更新」を拒否できる | PASS | 確定（Google は未試験） | `t2.log`、`t2-grants.log`、`t2-gotrue-docker.log` |
| T3 | RLS（行ごとの見せる・見せないの決まり）の中で `amr` が読める | PASS | 確定 | `t3.log` |
| T4 | UV（本人確認）を必須にでき、サーバーが印を読める | PASS（ソフトの認証器） | 確定（物理キーは未確認） | `t4.log` |
| T5 | パスキーの追加・削除を DB の側で拾える | PASS（引き金で全部の道を拾えた。採るかはオーナーの判断 5） | 確定（本番は未確認） | `t5.log`、`t5-trigger-create.log` |
| T6 | 招待のセッションでパスキーを2本登録でき、窓の `session_id` と突き合わせられる | PASS（案 B は確実。案 A は危険あり）。設計 6-2 手順 3 の直しが要る | 確定 | `t6.log` |
| T7 | 始めの回数の制限がサービスの鍵で免除されるか | 判定不能（手元では制限が効かない）。ソースでは免除されない。設計 4-1 の「免除されないなら、ブラウザから直に呼ぶ」の指示に当たるが、5-1 に3つ目の道（サーバーから `sb_secret_` と `Sb-Forwarded-For` で呼ぶ）がある | 有力 | `t7a.log`、`t7c.log`〜`t7f.log`、`step0-container-env-names.log` |
| T7 の captcha | 始めに captcha（Turnstile）が要るか | captcha の対象は始めだけ。管理者の鍵（古い形も `sb_secret_` も）は免除。公開の鍵は、本文に captcha のトークンを付ける必要がある | 確定 | `t7b.log`、`step0-i2.log` |

試しの記録は、後始末で道具ごと消したので、要点は文書の最後の「付録」に写した。

### 用語の言い換え

この文書の言葉を、やさしく言い換えた表。

| 言葉 | 意味 |
| --- | --- |
| レビュー | 作った人とは別の AI（Claude Opus）が、試しの記録とソースを読んで確かめた点検のこと。人間のレビューではない |
| PASS / FAIL | PASS は「期待どおりに動いた」、FAIL は「期待と違った」。「判定不能」は、試し方の都合で PASS とも FAIL とも言えないこと |
| GoTrue | Supabase の中でログインを受け持つ部分 |
| セッション | ログインしている間の「入室の記録」。1回のログインにつき1つできる |
| トークン | 入室の証明書。アクセストークン（短い間だけ使える）と更新トークン（アクセストークンを取り直すための物）がある |
| session_id | セッションの番号 |
| amr | 「どの方法でログインしたか」の記録。パスキーなら `passkey`、メールのコードなら `otp` が入る |
| aal | ログインの確かさの段階。`aal1` は1段（パスキー1つ、またはメールのコード）のこと |
| フック | GoTrue が証明書を出す直前に呼ぶ、こちらの Postgres の関数。ここで「通す・断る」を決める |
| RLS | DB の行ごとに「見せる・見せない」を決める仕組み |
| attestation | 登録の時に、鍵の作り手が付ける証明のこと。今回は付かない設定（`none`）で、署名が無い |
| captcha / Turnstile | 「ロボットでないこと」を確かめる仕組み。Turnstile は Cloudflare の物で、利用者に操作をさせない形にもできる |
| IP | つないできた機械の住所 |
| HTTP の数（200・400・403・429） | サーバーの返事の番号。200 は通った、400 と 403 は断られた、429 は回数の制限に当たった |
| sb_secret_ | Supabase の新しい形の「管理者の鍵」。サーバーの中だけで使い、ブラウザには渡さない |
| Sb-Forwarded-For | サーバーから呼ぶ時に「本当のお客さんの IP はこれ」と伝える、Supabase 独自の添え書き |
| 窓 / 始め | 「窓」は、店員に任命する時の最初の短い時間で、ここで最初のパスキーを登録できる。「始め」は、パスキーのログインを始める最初の呼び出し |

---

## T1 パスキーの登録とログイン

- 管理 API で作ったお客さんが、メールのリンク（magiclink）で入り、パスキーを登録し、サインアウトして、パスキーでログインした。全部通った。
- ログイン後の JWT は `aal` が `aal1`、`amr` が `[{"method":"passkey","timestamp":<秒>}]`。登録に使ったメールのリンクのセッションは `amr` が `[{"method":"otp",...}]` で、パスキーのログインで `passkey` に変わるのが見えた。
- JWT の中身: `iss`・`sub`・`aud`・`exp`・`iat`・`email`・`phone`・`app_metadata`・`user_metadata`・`role`・`aal`・`amr`・`session_id`・`is_anonymous`。**`session_id` が入っている**。
- GoTrue への呼び出し回数: 登録の始め1・終わり1、ログインの始め1・終わり1。
- 設計の「作り方を見直す」の条件には当たらない。

## T2 フックで店員を締める（Custom Access Token フック）

フックとは、GoTrue がトークンを出す直前に呼ぶ、こちらの Postgres の関数のこと。ここで店員に「パスキーで入った人だけ」を強制した。

- 通る・拒否の結果（全部、ログイン時と更新時の両方で確かめた）:
  - 店員がパスキーで入る → 通る。JWT に独自の印 `trial_approved_passkeys_ok` が入る（認めたパスキーが2本以上なら `true`）。
  - 約10秒後の更新 → 通る。約25秒後（上限20秒）の更新 → 拒否。更新後の `amr` の時刻はログインの時刻のままなので、**24時間の基準は最後の更新ではなくログインの時刻**になる。24時間は待てないので上限を20秒に縮めて確かめた。縮めた上限で動いたこと自体が、時刻の比べが正しい確認になる。
  - 店員がメールのリンク・メールのコード・パスワードで入る → どれも拒否。
  - お客さんがパスキー・メールのコードで入る → 通る。お客さんがパスワードで入る → 拒否（パスワードだけを拒否する設計）。
  - 直に SQL で関数を呼んだ試し: `amr` が空で `authentication_method` が無い入力は、店員なら拒否、お客さんなら素通し（どちらも安全な側に倒れる）。
- **フックがパスキーのログインの道で実際に走った証拠**を取った（通る場合はフックが走らなくても通るため）。フックの記録の表に、`authentication_method` が `passkey` で `session_id` を持つ行があった。
- **拒否の応答の形**: HTTP 403、supabase-js では `AuthApiError`、`code` は `unknown`。`message` にフックが返した文がそのまま入る（例: 店員のメールのコード → `staff must sign in with a fresh passkey (method=otp)`）。コードは `unknown` なので、アプリが「店員はパスキーで」と見分けるには、文の中身で見分けることになる。拒否の行はトランザクションの巻き戻りでフックの記録に残らないので、拒否の証拠は応答と GoTrue の入れ物のログ（`Hook errored out`、`403: ...`）で取った。
- **拒否された更新の扱い（レビューの指摘の書き直し）**:
  - 拒否された更新は、**GoTrue のセッションを終わらせない**。セッションの行は残り、拒否された更新トークンは回されず、同じトークンを再度送っても同じ拒否の文が返る（回し済みの古いトークンも、再利用の検知ではなくフックの 403 になった）。
  - したがって、アプリ側の `app_session_is_live`（セッションがまだ生きているかを調べる関数）は、拒否の後も真のままで、店員を切らない。
  - 1時間以内に店員を切るのは、設計 5-2 がすでに求めている「管理の入口の2つ目の条件」（`amr` の `passkey` の時刻から24時間。API と RLS の両方）。T3 の③が、期限内の JWT のままでも RLS でそれを止められることを示している。だから設計の追加は要らず、**2つ目の条件を API と RLS の両方で必ず作る**ことが要点。
  - 「拒否の後も、前に出したアクセストークンは期限（3600秒）まで使える」は、**測っていない**（署名と期限だけで受けられるのでほぼ確かだが、推論）。`auth.sessions.not_after` も記録していない。
  - 段1への申し送り: フックが更新を拒否した時に、アプリがそのセッションを終わらせるかどうかは、作り手が決める。今のままだと、拒否されたセッションの行は残り続ける。
- **フックに要った権限**（権限を1つずつ外して試した）: `supabase_auth_admin` に、関数の `execute`、`trial_staff`・`trial_approved`・`trial_config` の `select`、記録の表の `insert` が要る。`trial_window` の `select`（`session_id` がある時）と `update`（案 A の結びで書く時）は、外して試していないので**推論**。スキーマの `usage` は外しても動いた（PUBLIC 経由）。関数の `execute` は `public`・`authenticated`・`anon` から外した。
- フックの入力の形: 最上位の鍵は `claims`・`user_id`・`metadata`（`name`・`time`・`uuid`・`ip_address`）・`authentication_method`。`authentication_method` は、パスキーのログインで `passkey`、更新で `token_refresh`、メールのリンク・メールのコードの両方で `otp`、パスワードで `password`。`claims` の中に `amr`・`aal`・`session_id` などが入り、`amr` はログインの時点ですでに `[{"method":"passkey",...}]` になっている。
- 再起動に要った時間: 止める3秒、起動26秒。データは残った。
- 試していないこと（段1の試験に入れること）: 独自の印が `false` になる側（認めたパスキーが2本未満）、お客さんの本物の更新（`token_refresh`）、更新の拒否の後の古いトークンの状態を家族ごとに見ること。「メッセージで間違ったパスワードと見分けられる」の確かめは、拒否の文がフックの文に合うかだけで、間違ったパスワードの応答との比べではない。10秒・25秒の更新の時点で実際に経った秒数も記録していない（結論は変わらない）。
- **Google のログインは本物では試していない**。`amr` が `oauth` の入力を関数に直に渡して拒否されることを確かめただけ。

## T3 RLS の中で `amr` を読む

- JWT の `amr` は、`{method, timestamp}` の配列として `auth.jwt()->'amr'` で読めた。`timestamp` は秒の数字。配列であることの根拠は、`jsonb_array_elements` を使った方針が実際に動いた（配列でなければ誤りで落ちる）こと。
- ①パスキーでログインした JWT → 1行読める。②同じ人のメールのリンクのセッション（`amr` に `passkey` なし）→ 0行。③上限を5秒に縮めて7秒待ち、同じ JWT（まだ期限内）で読む → 0行。
- 「期限内の JWT のままでも、RLS の側で時刻の比べで止められる」と分かった。独自の印を JWT に足す予備は、ここでは要らない。
- 注: 試しの記録に「`jsonb_typeof` が `array` と `number`」と出ているのは、手で書いた JSON を調べた物で、`auth.jwt()` そのものの型ではない。

## T4 UV（本人確認）を必須にする

- 選択肢（ブラウザに渡す条件）の `userVerification` を、アプリ側で `required` に書き換えて UV のできる認証器に渡すと、登録もログインも通り、届いた `authenticatorData` の UV の印が立っていた。
- 印の場所: `authenticatorData` は、前の32バイトが相手の名前の指紋、**次の1バイト（先頭から数えて位置 32、33バイト目）が flags**、その後ろ4バイトが回数。UV の印は flags の `0x04`。計画に「37バイト目」とあったのは誤りで、37は最短の長さ。
- GoTrue は、選択肢を `preferred` のままにすると、UV の無い認証器のログインも**通す**（設計 5-3 の前提どおり）。同じ応答の UV の印は `false`。印が `false` なら終わりの窓口を呼ばずに拒否する門を置いたところ、GoTrue への呼び出しは0回だった。
- `required` が効いている間接の証拠: UV の無い認証器に `required` の選択肢を渡すと、ブラウザが `NotAllowedError` で止まった（UV のできる認証器は `preferred` でも印が立つので、通った話だけでは `required` が効いた証拠にならない）。
- ログインの応答の UV の印を無理に立てて GoTrue に送ると、署名の検証で拒否された（400 `webauthn_verification_failed`）。
- 登録の応答で同じ改ざんをすると**通ってしまう**（attestation が `none` で署名が無いため）。これは参考で、本当の守りはログインの確かめ。
- 注（確かさを狭める点）: 改ざんは、ログインの前に取った鍵の写しから作り直した認証器で行ったので、回数（sign count）は増えていない。同じ認証器での改ざん無しの対照は取っていない。ただし、GoTrue は回数の逆戻りを確かめない（ソースにその確かめが無い）ので、拒否の理由は署名で、結論は変わらない。GoTrue は複製の検知（回数の逆戻りの確認）をしない（有力: ソースで確かめたが、動かして確かめていない）。
- 注: UV の無い仮想の認証器は、Chromium では「相手を指定しないログイン」（一覧を渡さない形）に答えられなかったので、その認証器のログインだけ `allowCredentials`（使う鍵の一覧）を足した。サーバーが確かめる中身（`authenticatorData`・署名・`userHandle`）は同じ形になるので、サーバーの確かめには影響しない。本物の PIN の無い物理キーでの挙動は別。
- 登録の選択肢を `required` に書き換えて UV の無い認証器で試した場合は、試していない（ログインだけ）。
- **限界**: ソフトの認証器での確かめ。PIN の無い物理キーの実機の挙動は未確認。

## T5 パスキーの追加・削除を DB の側で拾う

- 表は `auth.webauthn_credentials`（持ち主 `supabase_auth_admin`）。`postgres` は管理者ではなく、`auth` に表は作れないが、この表への TRIGGER の権限を持つ。**引き金（表が変わった時に自動で動く仕掛け）を `postgres` で作れた**。`supabase_admin` は使わなかった。
- 拾えた道（全部、行が出た）: 本人のトークンでの登録、管理 API での削除、本人のトークンでの削除、SQL での直の削除、ユーザーの削除による連鎖。名前の変更は「UPDATE:name」として出た。ログインのたびに回数と最後に使った時刻が更新され、「UPDATE:other」の雑音が出る。
- 監査の記録（`auth.audit_log_entries`）は、登録・変更・削除（`passkey_created`・`passkey_updated`・`passkey_deleted`）を残すが、**SQL の直の削除は残らず、ユーザーの削除の連鎖はユーザー削除の1行だけでパスキーの行が無い**。だから採るのは引き金。
- 本番の引き金の注意: 引き金が拾えない道がある。`TRUNCATE`（表を空にする命令は行ごとの引き金が動かない）、`ALTER TABLE ... DISABLE TRIGGER` や `session_replication_role = replica`（強い権限の人だけ）。試しの分け方では、鍵の中身の書き換えもログインの雑音と同じ「UPDATE:other」になる。**本番では `public_key`・`credential_id` の変化を別に拾い、雑音（回数・最後に使った時刻）は知らせから外す**。
- 未確認（8-2 へ）: GoTrue の更新（移行）で引き金が消されないか、本番の Supabase のホスト版で `auth` の表に引き金を作れるか、監査の道を採るなら本番で `auth.audit_log_entries` に書かれる設定か。
- 試しの Step 1 で見た表の様子（持ち主・列・権限）の詳しい出力は、試しの記録に残していない。

## T6 招待のセッションでパスキーを2本、窓との突き合わせ

設計の 6-2 手順 3 のあいまいさ: 「合言葉を確かめ、その場で GoTrue のセッションを作り、同時に窓を開ける」とあるが、窓の行に書く `session_id` は、セッションができるまで分からない。実測で次の2案とも成り立つと分かった。

- **案 A（先に窓を `session_id` なしで開け、フックが最初のセッションに結ぶ）**:
  - 招待のメールのリンクの検証が通った。フックの入力の `session_id` と JWT の `session_id` と窓の行が同じになった。アプリ側の突き合わせ（JWT の `session_id` が窓の行と同じか）も通った。
  - 結ぶ条件を、`session_id` が空・期限内・開けてから60秒以内の行を、1文で1回だけ結ぶ、とした。90秒前に開けた窓は結ばれなかった。結んだ後の、同じ人のメールのコードのセッションは拒否された。
  - 招待のセッションでパスキーを2本登録できた（`auth.webauthn_credentials` が2行。2本目の前に1本目の認証器を外して別の認証器を足した）。回数の制限には当たらなかった。
  - 登録の後も、そのセッションの `amr` に `passkey` は付かなかった（更新した後の新しい JWT と `auth.mfa_amr_claims` の両方で `otp` だけ）。設計 6-2 手順 5 の前提が確かめられた。
  - 窓が開いている間の更新は通り、窓の行を消した後の更新は拒否された。
- **案 B（アプリがセッションを作った後に、分かった `session_id` で窓を開け、最後に店員の役割を有効にする）**:
  - お客さんとしてメールのリンクで入り、窓を既知の `session_id` で開け、店員の役割を有効にした。更新は窓を通して通り、窓を消すと拒否された。セッションの数は役割を変える前後で変わらなかった（管理 API で `app_metadata` を変えても切れない）。
  - 窓を取り合う競りが無い。ただし、役割の切り替えの監査・知らせの副作用は、試しの表が単純なので測っていない。

**案 A の危険（実測と、その広がりのレビュー）**:

- 窓が `session_id` なしの間に、同じ人のメールのコードのセッションが先に来ると、**そのセッションが窓に結ばれ、パスキー無しで発行された**（実測）。フックの入力では、メールのリンクとメールのコードは区別できない（どちらも `authentication_method` が `otp`、`amr` が `otp`）。
- 危険は報告より広い（レビューの指摘）。結ぶ条件は「店員で、`session_id` があり、窓が空」だけで、ログインの道を見ていない。**先に来さえすれば、メールのコードだけでなく、パスワードや Google、前からあるセッションの更新（`token_refresh`）でも窓を取りうる**（試したのはメールのコードだけ）。
- 窓を取ったセッションは、アプリ側の突き合わせも通る（窓の行がそのセッション自身の物になるため）。試しの「アプリ側の突き合わせが取り違えを捕まえる」の確かめは中身のない確かめで、実際に危険を防いだのは、あとから来た招待の検証をフックが拒否したことだけ。
- 招待の検証が失敗した後も、窓は相手のセッションに結ばれたまま残る（窓を閉じる処理を試しは入れていない）。設計 5-5 の「窓の中の最初の2本は、直前の入り直し無しで認めたパスキーにする」と合わさると、**相手が自分の鍵を足せる道（店員の乗っ取り）**になる。
- 手当ては足せる（`token_refresh` では結ばない、窓を開けた後に作られたセッションだけ結ぶ、招待の検証が失敗したら窓を閉じる）が、それでもメールのコードのセッションとは見分けられない。フックに届く手がかり（`metadata.ip_address`・時刻・`auth.sessions` の行・`authentication_method`）では、セッションごとの秘密が届かないので、「アプリが作ったセッションか」は確定できない。
- 起きやすさは試していない。相手は同じ人のメールを読めて、アプリが窓を開けてから自分の検証をするまでの間にコードの検証を済ませる必要がある。アプリが「リンクを作る → 窓を開ける → すぐ検証」を1つの要求の中で行えば、隙は短い。リンクを作り直した時に前のメールのコードが無効になるかは試していない。
- **確実と言えるのは案 B だけ**（既知の `session_id` に先に結ぶので、競りが無い）。

設計の直しの提案: 6-2 手順 3 に、窓の開け方を案 B（セッションを作ってから、分かった `session_id` で窓を開け、その後に店員の役割を有効にする）と書く。案 A を採る場合は、上の3つの手当てを必ず書き、残る危険をオーナーに受け入れていただく。

## T7 始めの回数の制限と captcha

### 9a 回数の制限（手元では判定不能。ソースでは「免除されない」が有力）

- 試し: 始め（`POST /auth/v1/passkeys/authentication/options`）を、サービスの鍵（JWT 形）で35回、新しい形の秘密の鍵（`sb_secret_`）で35回、5分あけて匿名の鍵で35回。**全部 200**。計画の決まりどおり、対照の匿名の鍵が1度も制限に当たらなかったので、「免除」の判定は無意味で、判定不能（終了コード 2）。
- 調べ: 匿名の始めを200回、終わりの窓口へのでたらめの呼びを40回、さらに制限の設定値が入れ物に入っているはずの他の窓口（検証 30・メールの送り 30・更新 150・パスワードのログイン）も40〜170回叩き、`X-Forwarded-For`・`X-Real-IP` も付けたが、**どこでも 429 は出なかった**。入れ物の環境変数の名前の一覧（`step0-container-env-names.log`）に、制限の見出しを指す物（`RATE_LIMIT_HEADER`）も、パスキーの制限（`RATE_LIMIT_PASSKEY`）も、`SB_FORWARDED_FOR` も無かった。
- 原因（レビューが GoTrue v2.196.0 のソース `api.go`・`middleware.go`・`apilimiter.go`・`sbff/sbff.go`・`passkey_authentication.go` と、Supabase の文書「Auth の回数の制限」〔`supabase.com/docs/guides/auth/rate-limits`〕を読んで確かめた結果。GoTrue のソースは v2.196.0 の物）:
  - 始めは `limitHandler`（パスキーの認証の制限。`GOTRUE_RATE_LIMIT_PASSKEY`、5分あたり、最初に30）を通る。
  - 制限は、「`sb-forwarded-for` の IP（`GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED` が true の時だけ）」か「`GOTRUE_RATE_LIMIT_HEADER` で決めた見出しの値」を鍵に数える。**どちらも無ければ何もしない**。手元の CLI の GoTrue はどちらも設定されないので、制限が一切効かない。手元の設定ファイルにも、この2つを入れる項目が無い。
  - **回数の制限には、管理者・サービスの鍵の免除が無い**（captcha の確かめには免除がある）。
- 結論: 「サービスの鍵で免除されるか」は、**有力: 免除されない**（ソースが根拠。手元で動かして確かめたのではない）。
- 設計 5-1 への影響（3つ目の道）: 免除されないなら、始めを「ブラウザから GoTrue を直に呼ぶ」しか無い、とは限らない。本番（ホスト版）の文書では、サーバーから呼ぶ時に `Sb-Forwarded-For` という見出しに**お客さんの IP** を入れれば、その IP で数える。この見出しは、**新しい秘密の鍵（`sb_secret_`）でだけ受け付け**、古い `anon`・`service_role` の鍵や公開の鍵では受け付けない。この道なら、店全体で5分30回になる心配が無く、始めをサーバーに置ける。本番での挙動（見出しが効くか）は 8-2 で確かめる。
- Step 0 の追加（手元で `sb-forwarded-for` を効かせられるか）: 入れ物の環境変数に `GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED` を渡す手段が、CLI の設定ファイルに無く（入れ物の環境変数の名前の一覧にも出ない）、CLI の外で入れ物を作り直さない限り入れられないので、手元では確かめない。本番の確認（8-2）に回す。

### 9b captcha（確定）

captcha を有効にして（Cloudflare のテスト用の秘密を、起動する時のシェルの環境変数だけで渡し、ファイル・ログ・結果には残していない）測った。

| 呼び出し | 結果 |
| --- | --- |
| 始め、匿名の鍵、トークン無し | 400 `captcha_failed` |
| 始め、サービスの鍵（古い JWT 形）、トークン無し | 200（免除） |
| 始め、新しい秘密の鍵 `sb_secret_`、トークン無し（Step 0。見出しだけの場合も Authorization 付きの場合も） | **200（免除）** |
| 始め、匿名の鍵 + トークンを本文（`gotrue_meta_security.captcha_token`）で渡す | 200 |
| 始め、トークンを見出し（`x-captcha-token`）で渡す | 400 `captcha_failed`（見出しは読まれない） |
| supabase-js の `startAuthentication({options:{captchaToken}})` | 通る。トークン無しは `captcha_failed` |
| 終わり（ログイン・登録）、登録の始め | captcha の対象外（トークン無しでも、captcha の誤りではなく中身の誤りが返る。ソースでも `verifyCaptcha` が付くのは始めだけと確認済み） |

**設計 6-1 が書くべき結論**:

- GoTrue の captcha が見るのは、パスキーのログインの**始めだけ**。終わり（ログイン・登録）と、登録の始めには Turnstile のトークンは要らない。
- 始めを**サーバーから管理者の鍵（古い `service_role` の JWT も、新しい `sb_secret_` も、実測済み）で呼ぶなら、captcha は免除**されるので、パスキーのログインに Turnstile は付けない（設計の「付けない」が成り立つ）。
- 始めを**ブラウザから公開の鍵で直に呼ぶなら、見えない形の Turnstile が要る**。トークンは本文の `gotrue_meta_security.captcha_token` で渡す（supabase-js の `options.captchaToken`）。見出しでは渡せない。
- 注: 終わりの窓口はでたらめな本文だけで確かめた（本物の応答では試していない）が、ソースで対象外と確認できているので、判定不能にはしない。

注意: 手元の GoTrue の回数の制限と captcha の挙動が、本番のホスト版と同じ値・同じ免除かは、ここから確定しない。8-2 で本番の応答の見出しで確かめる。

---

## 段1への材料

- 隔離した手元のスタック: 設定のパスキー（`[auth.passkey] enabled`）と、WebAuthn の相手の名前・出所（`[auth.webauthn] rp_id`・`rp_origins`）で動く。`/auth/v1/settings` に `passkeys_enabled: true` が出る。
- `supabase-js` 2.119.0 のパスキーのメソッド: `auth.passkey.startRegistration()`（`{challenge_id, options, expires_at}`）、`auth.passkey.verifyRegistration({challengeId, credential})`、`auth.passkey.startAuthentication({options:{captchaToken}})`、`auth.passkey.verifyAuthentication({challengeId, credential})`（`{session, user}`）、`auth.passkey.list()`・`update({passkeyId, friendlyName})`・`delete({passkeyId})`、管理側 `auth.admin.passkey.listPasskeys({userId})`・`deletePasskey({userId, passkeyId})`。選択肢は W3C の JSON 形（base64url）で、ブラウザ側で ArrayBuffer に直して `navigator.credentials.create/get` に渡し、結果を base64url に戻して送る。ログインの選択肢の `userVerification` の初期値は `preferred`。
- フックに要った権限・拒否の応答の形・`amr` の実際の形・フックの入力の形・拒否された更新の扱いは、T2・T1 の節のとおり。
- 段1の試験に必ず入れること: 独自の印が `false` になる側、お客さんの本物の更新、拒否された更新の後のセッションの扱い、フックが拒否した時にアプリがセッションを終わらせるか、拒否の後の前のアクセストークンで `/auth/v1/user` と `/rest/v1` を呼ぶこと、`auth.sessions.not_after` を見ること。
- 段1の作り方の申し送り: 試しでは、時間の上限を入れた設定の表（`trial_config`）を、ログインした人（`authenticated`）に直に読ませた。段1では、この設定を `security definer` の関数（持ち主の権限で動く関数）で読ませ、表そのものは見せない。
- 案 B を採る場合、役割を切り替える時の監査・知らせの副作用は試しの表が単純なので測っていない。段1で確かめる。

## 本番の確認（8-2）に回す未確認

1. T7: 本番のホスト版で、始めの回数の制限が効くか、サービスの鍵・`sb_secret_` で免除されるか、`Sb-Forwarded-For` にお客さんの IP を入れた時にその IP で数えるか。
2. T7: `sb_secret_` が、本番でも captcha を免除されるか（手元では免除された）。
3. T5: GoTrue の更新で引き金が消されないか、本番の `auth` の表に `postgres` で引き金を作れるか。監査の道を採るなら、本番で `auth.audit_log_entries` に書かれる設定か。
4. T4: PIN の無い物理キーでの挙動（UV の印、一覧を渡さないログイン）。
5. T2: 本物の Google ログイン（`oauth`）の `amr` と、フックの拒否。
6. 本番でパスキーを使えるか（無料のプランでダッシュボードの「Passkeys」を有効にできるか）。設計 4-1 の既存の項目で、本番の住所が決まってから。
7. 本番の GoTrue の版が v2.196.0 か（違えば、試し T1〜T7 の前提を見直す。試しは全部この版で行った）。
8. T7: 古い形の `service_role` の鍵も、本番で captcha を免除されるか（上の 2 は `sb_secret_` だけ）。
9. T2: 本番のフックの登録後に、拒否の応答の形（403・`unknown`・フックの文）が手元と同じか（アプリは文で「店員はパスキーで」と見分ける）。

## 試しの限界と、残していない記録

- 手元の隔離スタックでの試しで、本番にも、いつもの手元の Supabase（3000番・共有の DB）にも触れていない。
- ソフトの認証器（Chromium の仮想の認証器）での確かめで、本物の物理キーではない。
- 残していない記録: 更新の10秒・25秒の時点で実際に経った秒数（やり直すとグループ 2 の証拠を上書きするので飛ばした。結論は変わらない）、拒否の後の前のアクセストークンの実際の使用、`auth.sessions.not_after`、T5 の Step 1 の権限の出力の全体。
- 設計とずれた点（計画・設計の訂正）: UV の印の位置は「37バイト目」でなく位置 32（33バイト目）。

---

## オーナーに決めていただくこと

用語は、冒頭の「用語の言い換え」の表を見てください。

1. **招待の窓の開け方**: 案 A（先に窓を開けて、最初に来たセッションに結ぶ）か、案 B（セッションを作ってから、分かったその番号で窓を開け、最後に店員の役割を有効にする）か。**レビュー（上の表を参照）は案 B を勧める**。案 B は、役割を切り替える時の監査・知らせの副作用を、まだ測っていない。案 A は、メールを読める人が窓の間に自分の鍵を足せる危険（手当てを足しても残る）があり、案 B には無い。
2. **案 A を選ぶ場合**: 上の危険（メールを読める人が店員の登録の窓を取れる。手当てを足しても、メールのコードと見分けられないので残る）を受け入れるか。
3. **パスキーのログインの「始め」の呼び方**（「始め」は、ログインを始める最初の呼び出し。これが店全体で5分に30回までに制限されるかもしれない、というのが T7 の心配）:
   - (a) お店のサーバーから、Supabase の新しい管理者の鍵（`sb_secret_`）を使って呼び、お客さんの機械の住所（IP）を添え書き（`Sb-Forwarded-For`）で伝える。**店全体で5分に30回になる心配が無い**。ロボット確認（captcha・Turnstile）も要らない。ただし、本番で添え書きが効くかを確かめるまでは断言できない。本番で効かなかった時は (b) に戻る。
   - (b) お客さんのブラウザから Supabase に直に呼ぶ。ロボット確認（見えない形の Turnstile）を付ける必要がある。お店のサーバーに始めの窓口が無いので、設計 5-3 の「始めの窓口で本人確認を必須に書き換える」処理が、ブラウザ側の処理になる（守りの本体はサーバーの終わりの門なので崩れはしないが、5-3 の書き方が変わる）。
   - 元の設計の道（サーバーから添え書き無しで呼ぶ）は、回数の制限が免除されない見込み（有力）なので、店全体で5分30回になる。だから (a) か (b) のどちらかを選ぶ。
4. **T7 の 9a（回数の制限）**: 手元では測れなかったので、本番での確認（8-2）に回すことを認めるか。認めない場合の道は、Supabase の手元の道具の外で、ログインの入れ物を作り直して測ることで、手間がかかる（手元の設定では入れられないと分かっている）。
5. **T5**: パスキーの追加・削除を DB の引き金で拾う方式を採ってよいか（雑音の更新は外し、鍵の中身の変化は別に拾う）。本番の `auth` の表に引き金を作れるか、GoTrue の更新で消えないかは 8-2 で確かめる。
6. **T4**: ソフトの認証器での PASS を認め、PIN の無い物理キーでの確かめを開店前に足すか。物理キーで違いがあっても、サーバーの門が本人確認の印で断るので、守りは崩れない。困るのは「PIN の無いキーの人が入れない」ことと、「一覧を渡さないログインが動くか」の2点。
7. **Google のログイン**: 本物では試していない（拒否の判定を関数に直に渡して確かめただけ）。このまま段1に進むか、本番の住所が決まった後に本物で確かめるか。店員は「パスキー（と窓）以外は全部断る」作りなので、本物の Google の記録（`amr`）の形が違っても店員は通らない。だから危険は小さい。
8. **設計の直しを認めるか**: 試しで分かったことを、設計書の次の節に入れてよいか。5-1（始めの呼び方に3つ目の道を足す）、5-3（始めをブラウザから呼ぶ場合の書き方）、5-4 と §11（引き金を採る。鍵の中身の変化を別に拾う）、6-1（captcha は始めだけが対象で、管理者の鍵は免除、という結論）、6-2 手順 3（窓の開け方を案 B にする）、4-1 の T7 の行（手元では測れず、本番で確かめる）。あわせて、計画の「37バイト目」の誤り（正しくは位置 32）を直す。認めていただければ、controller が段1の計画を作る。

---

## 付録 試しの記録の要点（後始末で道具ごと消したので、ここに写す。トークン・鍵は伏せてある）

- T1: `PASS claims.amr contains method=passkey {"amr":[{"method":"passkey","timestamp":<秒>}]}`、`claims keys [iss,sub,aud,exp,iat,email,phone,app_metadata,user_metadata,role,aal,amr,session_id,is_anonymous]`。
- T2: `hook input top-level keys ["claims","user_id","metadata","authentication_method"]`、`refresh hook input: authentication_method token_refresh`、`PASS refresh at ~25s after login (limit 20s) is rejected {"status":403,"code":"unknown","name":"AuthApiError","message":"trial: staff must sign in with a fresh passkey (method=token_refresh)"}`、`after rejected refresh: auth.sessions rows for session = 1 | refresh_tokens (revoked|count): f|1 ; t|1`。
- T2 の権限（`t2-grants.log`）: `revoke execute on trial_hook: permission denied for function`、`revoke select on trial_staff/trial_approved/trial_config: permission denied for table`、`revoke insert on trial_hook_log: permission denied for table`、`revoke select on trial_window`・`revoke usage on schema public`: 動いた。
- T3: `PASS (1) passkey session reads 1 row`、`PASS (2) magiclink session reads 0 rows`、`PASS (3) stale passkey amr (>5s) reads 0 rows while JWT still valid`。
- T4: `PASS 2 premise: GoTrue verify PASSES a UV-less (preferred) login`、`PASS 2 gate rejects the UV-less response and calls GoTrue verify 0 times {"verifyCallsDelta":0}`、`PASS 4 login with UV flag forced to 1 is rejected by GoTrue (signature) {"status":400,"code":"webauthn_verification_failed","message":"Credential verification failed"}`、`INFO 4 reference only: registration with UV flag forced to 1 {"accepted":true}`。
- T5: 引き金の作成 `CREATE TRIGGER`、出た行: 登録 `INSERT`、管理の削除・本人の削除・SQL の直の削除・ユーザー削除の連鎖 `DELETE`、名前の変更 `UPDATE:name`、ログイン `UPDATE:other`。監査の動作名: `login`・`passkey_created`・`passkey_deleted`・`passkey_updated`・（連鎖は）`user_deleted` のみ。
- T6: `A-4 email-code session while window(null) open: issued = true | bound row = <session> | bound is the email-code session = true`、`A-6 amr has no passkey after registering 2 passkeys {"amr":[{"method":"otp",...}]}`、`A-9 window opened 90s ago (> 60s) is NOT bound`、`B-3 without the window the same staff session is rejected`。
- T7: `1 service-role JWT: n=35 {"200":35}`、`1b sb_secret_: {"200":35}`、`3 anon (control): n=35 {"200":35}`、`control hit 429: false`（判定不能）。captcha: `anon, no token -> 400 captcha_failed`、`sb_secret_ (apikey only), no token -> 200`。入れ物の環境変数の名前（値は伏せた）: `GOTRUE_RATE_LIMIT_{ANONYMOUS_USERS,EMAIL_SENT,OTP,SMS_SENT,TOKEN_REFRESH,VERIFY,WEB3}`、`GOTRUE_SECURITY_{CAPTCHA_ENABLED,CAPTCHA_PROVIDER,CAPTCHA_SECRET,MANUAL_LINKING_ENABLED,REFRESH_TOKEN_REUSE_INTERVAL,REFRESH_TOKEN_ROTATION_ENABLED,UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION}`（`RATE_LIMIT_HEADER`・`RATE_LIMIT_PASSKEY`・`SB_FORWARDED_FOR` は無い）。
- 秘密の確認: 試しの記録の全部を、値の形（JWT・`sb_secret_`・`sb_publishable_`・`Bearer` の後ろの値・URL の中のパスワード）と鍵の名前（`access_token`・`refresh_token`・`token_hash`・`hashed_token`・`email_otp`・`captcha_token`・`new_password`・`password`・`privateKey`・`apikey`・`Authorization`・`secret`・`token`）の後ろに値が続く形で検索し、値の当たりは 0件。
