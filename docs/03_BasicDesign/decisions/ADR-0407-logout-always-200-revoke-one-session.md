# ADR-0407 ログアウトは常に 200 で Cookie を全部消し、サーバーのセッションは期限切れの JWT の session_id でその1本だけを切る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/app/api/auth/logout/route.ts`、`src/lib/cookie.ts`（範囲外の共有部品） | 基準コミット: `4facf63b`

## 概要

`/api/auth/logout` は、ログインしていなくても CSRF の確かめに落ちても 200 を返し、認証・保留・ゲストの印の Cookie を全部消す。サーバーのセッションを切るのは CSRF の確かめが通った時だけで、期限切れでも署名を確かめた access token の `session_id` で、その端末のセッションだけを切る。`session_id` が取れない時だけ、その利用者の全部のセッションを切る。そのため access token の Cookie の寿命を refresh と同じ 7 日にしている。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の AUTH |
| 対応する ID | FREQ-320-REQ-02、FREQ-514-REQ-01（範囲外）、SEC-AUTH-025（SEC-AUTH-021 は refresh の Cookie が無い時を満たさないので上位にしない） |
| 対象のコード | `src/app/api/auth/logout/route.ts` |
| 関連文書 | `docs/02_Requirements/requirements.md` の FREQ-320・FREQ-514 の行、git `e476b83e` の P1-2、`docs/superpowers/plans/2026-10-23-launch-fixes-wave1.md`（R-22）、`docs/03_BasicDesign/decisions/ADR-0019-admin-news-csrf-origin-proxy.md` |
| 要件の文書 | `docs/02_Requirements/areas/auth.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0407 ログアウトは常に 200 で Cookie を全部消し、サーバーのセッションは期限切れの JWT の session_id でその1本だけを切る

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-320-REQ-02、FREQ-514-REQ-01（範囲外）、SEC-AUTH-025 |
| 根拠 | ログアウトが 401 だと「まだ有効なセッションか」を漏らすので常に 200 にする（`logout/route.ts`）。Supabase の公式のログアウトは有効な JWT が要り、access token が切れていると呼べず、生きた refresh の印が残る。一方で全部の端末を巻き込むログアウトは不便なので、その端末の1本だけを切る（FREQ-320） |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md` の FREQ-320・FREQ-514 の行、git `e476b83e` のコミットの文 |

#### 背景

- 以前は access token の Cookie の寿命をトークンの期限に合わせていたので、期限と同時に Cookie が消え、ログアウトが `session_id` を読めず、いつも全部の端末の失効に落ちていた（`e476b83e` の P1-2）
- 波1 の R-22 で、CSRF の確かめの本物の拒否（403・照合の DB の失敗の 500）を見落とさないようにした（FREQ-514）。ログアウトは拒否でも 200 と Cookie の消去を返し、サーバーの失効だけをしない

#### 決定

- refresh の Cookie がある時だけ、CSRF の token を確かめる（`logout/route.ts`）。通れば自前の表に失効の印を付け、Supabase のセッションを切る
- Supabase のセッションは、期限切れを許して署名を確かめた JWT の `session_id` で1本だけ切る。取れない・切れない時は、自前の表の利用者で全部を切る。どちらもできなければ監査に残す（`logout/route.ts`）
- access token の Cookie の寿命を refresh と同じ 7 日にする。中の JWT は毎回期限を確かめるので、Cookie が長くても認証は通らない（FREQ-320-REQ-02、`e476b83e`）
- 応答はいつも 200 で、認証・CSRF・保留・再設定・ゲストのカートとお気に入りの印の Cookie と、Google のログインの Cookie を消す（`logout/route.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 未認証や拒否の時に 401・403 を返す | 有効なセッションかを漏らし、Cookie が残る（`logout/route.ts`） |
| Supabase の公式のログアウトを使う | 有効な JWT が要り、期限切れでは呼べない（`logout/route.ts`） |
| いつも全部の端末を切る | ほかの端末を巻き込む（FREQ-320、`e476b83e` の P1-2） |
| access token の Cookie をトークンの期限で消す（前の形） | 期限の後は `session_id` を読めず、全部の端末の失効に落ちる（FREQ-320-REQ-02） |

#### 結果

- 良くなること: ログアウトは必ず効き、その端末だけが切れる
- 悪くなること: `session_id` が取れない時は全部の端末が切れる
- 悪くなること: ログアウトは proxy の Origin の確かめ（FREQ-327）に加えて、窓口で CSRF の token も確かめる。管理のニュースの「token を重ねない」（ADR-0019）と形が違い、重ねる理由の記録は見つけていない（`docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる）
- 見直す条件: Supabase がログアウトの API の条件を変える時、CSRF の守りの形をそろえる時

## 未確認事項

- 本番で `revoke_auth_session` が Supabase の `auth.sessions` を実際に切るか（`auth-session.md` も未確認とする）
