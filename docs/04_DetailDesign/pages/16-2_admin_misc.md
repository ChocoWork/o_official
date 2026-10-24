# 1.16-2 管理のそのほか（ADMIN）詳細設計

> 状態: 推定 | 確認日: 2026-10-24 | 対象: 利用者の作成の画面と窓口・セッションの強制失効・監査ログの読み出しと掃除・2要素のリセット・問い合わせの管理の窓口・返信の宛先の部品・商品の色見本の窓口 | 基準コミット: `4facf63b`

## 概要

管理のそのほか（ADMIN）の範囲にある 14 ファイル・15 単位を、詳細設計の項目（`DD-ADMIN-001`〜`015`）で書く。
中身は 2026-10-24 の作業ツリーのコードを読んで起こした今の動きで、ユーザーの確認を受けていないので全部「推定」にした。構造設計・要件とコードが食い違う所は決めずに今のコードの動きを書き、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節（`TM-ADMIN-NN`）に載せた。今のコードがセキュリティ要件を満たさない所は、その `SEC-ADMIN-NNN` の項目に1回だけ書き、ここでは `SEC-ADMIN-NNN を参照` と指す。

| ID | 題 | 単位 |
| --- | --- | --- |
| `DD-ADMIN-001` | 利用者の作成の画面 | `src/app/admin/create-user/page.tsx` |
| `DD-ADMIN-002` | 利用者の作成の窓口 | `src/app/api/admin/create-user/route.ts` |
| `DD-ADMIN-003` | セッションの強制失効の窓口 | `src/app/api/admin/revoke-user-sessions/route.ts` |
| `DD-ADMIN-004` | 監査ログの読み出しの窓口 | `src/app/api/admin/audit-logs/route.ts` |
| `DD-ADMIN-005` | 特権の利用者の2要素のリセットの窓口 | `src/app/api/admin/users/mfa/reset/route.ts` |
| `DD-ADMIN-006` | 問い合わせの一覧の窓口 | `src/app/api/admin/contact/route.ts` |
| `DD-ADMIN-007` | 問い合わせの詳細と状態の変更の窓口 | `src/app/api/admin/contact/[id]/route.ts` |
| `DD-ADMIN-008` | 管理の返信の窓口 | `src/app/api/admin/contact/[id]/reply/route.ts` |
| `DD-ADMIN-009` | 返信のテンプレートの一覧と作成の窓口 | `src/app/api/admin/contact/templates/route.ts` |
| `DD-ADMIN-010` | 返信のテンプレートの更新と削除の窓口 | `src/app/api/admin/contact/templates/[id]/route.ts` |
| `DD-ADMIN-011` | 色見本の一覧と保存の窓口 | `src/app/api/admin/item-color-presets/route.ts` |
| `DD-ADMIN-012` | 色見本の削除の窓口 | `src/app/api/admin/item-color-presets/[id]/route.ts` |
| `DD-ADMIN-013` | 返信の宛先を作る | `src/lib/contact/reply-address.ts` の `buildReplyAddress` |
| `DD-ADMIN-014` | 返信の宛先を確かめる | `src/lib/contact/reply-address.ts` の `parseReplyAddress` |
| `DD-ADMIN-015` | 古い監査ログを消す（未使用（削除の判断待ち）） | `src/lib/auditCleanup.ts` の `cleanupAuditLogs` |

- 結論: 窓口は全部、頭で共有の認可（`authorizeAdminPermission`）を通し、通った後にだけ service role の client で表と Auth の管理の機能を使う。画面は利用者の作成の1つだけで、画面には守りが無い
- 今のコードは、存在しない id への変更を 200 の成功として返す、本文の JSON が壊れていると 500 を返す（作成・強制失効・色見本の保存）、一部の DB の書き込みの誤りを見ない、などの動きを持つ。届かないセキュリティ要件は上位に書かず、本文では `SEC-ADMIN-NNN を参照` と指す（構造設計と同じ決め方）
- 15 単位の全部に単体テスト（`tests/unit/`）がある。強制失効と監査ログの既存の結合試験（`tests/integration/api/admin/`）は、分岐の網羅には数えない。各項目の「テスト観点」は、分岐を全部通すのに要る確かめ

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の ADMIN |
| 上位の文書 | [ADMIN の構造設計](../../03_BasicDesign/areas/admin.md)（`ARC-`・`SCR-`・`STATE-`・`API-`・`DATA-ADMIN-`）、[ADMIN の要件](../../02_Requirements/areas/admin.md)（`SEC-ADMIN-`） |
| 対象のコード | 「実装の単位」の表の 15 単位（14 ファイル） |
| 引き継いだ文書 | [1.16 管理画面（ADMIN）詳細設計](16_admin.md) の `IMPL-ADMIN-COLOR-01`（実装タスク管理の ADMIN-01-002 の行）。元の文書は 割当の作業が書き換え中のため変えていない |
| 調べた時点 | 2026-10-24 の作業ツリー。コードは読んだだけで、動かしての確かめはしていない |

範囲外の共有部品は ID を持たないので、上位に書かず本文にファイルの道で書く。

| 共有部品 | 道 | ここでの使われ方 |
| --- | --- | --- |
| 管理の認可 | `src/lib/auth/admin-rbac.ts` の `authorizeAdminPermission` | 窓口ごとに token・session の生存・DB の ACL の権限・aal2 を確かめる |
| Origin の検査 | `src/proxy.ts` | `/api` の書き込みの Origin・Referer を照合する（ARC-ADMIN-002） |
| 監査 | `src/lib/audit.ts` の `maskAuditEvent`・`logAudit` | 結果を `audit_logs` に残す。書き込みの失敗と例外は警告だけで握りつぶすので、窓口の応答は変わらない |
| メールの送り手 | `src/lib/mail.ts` | 管理の返信のメールを送る |
| 注文番号の形 | `src/lib/orders/order-number.ts` の `toOrderNumber` | 問い合わせの詳細で注文の id を注文番号にする |
| Supabase の client | `src/lib/supabase/server.ts` の `createServiceRoleClient` | 全部の窓口と掃除の部品の DB・Auth の管理の機能 |
| 画面の部品 | `src/components/ui/Button/Button.tsx`、`src/components/ui/TextField/TextField.tsx` | 利用者の作成の画面 |

## 実装の単位

`scripts/trace/parse-code.ts` の `parseCodeUnits` で数えた範囲内の単位と、つなぐ詳細設計。1つの単位は1つの `DD-` にだけつなぐ。`@impl`・`@design` のコメントはこの表から付ける（新しい `IMPL-ADMIN-` は既存の最大 `IMPL-ADMIN-008` より大きい 101 から振る）。

| ファイル | 単位（symbol） | DD |
| --- | --- | --- |
| `src/app/admin/create-user/page.tsx` | `<file>` | DD-ADMIN-001 |
| `src/app/api/admin/create-user/route.ts` | `<file>` | DD-ADMIN-002 |
| `src/app/api/admin/revoke-user-sessions/route.ts` | `<file>` | DD-ADMIN-003 |
| `src/app/api/admin/audit-logs/route.ts` | `<file>` | DD-ADMIN-004 |
| `src/app/api/admin/users/mfa/reset/route.ts` | `<file>` | DD-ADMIN-005 |
| `src/app/api/admin/contact/route.ts` | `<file>` | DD-ADMIN-006 |
| `src/app/api/admin/contact/[id]/route.ts` | `<file>` | DD-ADMIN-007 |
| `src/app/api/admin/contact/[id]/reply/route.ts` | `<file>` | DD-ADMIN-008 |
| `src/app/api/admin/contact/templates/route.ts` | `<file>` | DD-ADMIN-009 |
| `src/app/api/admin/contact/templates/[id]/route.ts` | `<file>` | DD-ADMIN-010 |
| `src/app/api/admin/item-color-presets/route.ts` | `<file>` | DD-ADMIN-011 |
| `src/app/api/admin/item-color-presets/[id]/route.ts` | `<file>` | DD-ADMIN-012 |
| `src/lib/contact/reply-address.ts` | `buildReplyAddress` | DD-ADMIN-013 |
| `src/lib/contact/reply-address.ts` | `parseReplyAddress` | DD-ADMIN-014 |
| `src/lib/auditCleanup.ts` | `cleanupAuditLogs` | DD-ADMIN-015 |

- 窓口のファイルは、中の GET・POST などが別々の契約でも、単位がファイルなので1つの `DD-` にまとめた。項目の本文で方法ごとに分けて書く
- 単位にならない物: 2要素のリセットの窓口の中の `resolveRoleFromAppMetadata`・`isMfaFactorList`、問い合わせの一覧の窓口の中の `sanitizeSearchTerm`、`reply-address.ts` の `computeToken`・`safeEqual`（export しない関数。それぞれの項目に含める）、`auditCleanup.ts` の最後の既定の書き出し（後から出す形）
- `reply-address.ts` の2つは、範囲外の公開の問い合わせ（`src/app/api/contact/route.ts`）と受信（`src/app/api/contact/inbound/route.ts`）も使う。CONTACT の領域が範囲に入る時は、この頁の `DD-ADMIN-013`・`014` を `（範囲外）` で指し、同じ単位に別の `DD-` を作らない
- 窓口の TSDoc に、メソッドの宣言の形（書き出しの語と関数の名前を並べた文）を書かない。`tests/unit/docs/delivery-status-traceability.test.ts` と `tests/unit/docs/order-status-traceability.test.ts` が `src/app/api` の全部の route.ts をコメントごと読み、その形の数を固定している

## 管理の窓口に共通の動き

`DD-ADMIN-002`〜`012` の全部の方法が、最初に `authorizeAdminPermission(<権限>, request)` を呼び、`ok` でなければその応答をそのまま返す（強制失効だけは返す前に監査を書く。DD-ADMIN-003）。認可の部品は `src/lib/auth/admin-rbac.ts` の `authorizeAdminPermission` で、応答は次のとおり。

| 条件 | 応答 |
| --- | --- |
| token の検証に失敗 | 401 `{error:'Unauthorized'}` |
| session の生存を確かめられない | 503 `{error:'Service temporarily unavailable'}`、`Retry-After: 30` |
| session が有効でない | 401 `{error:'Unauthorized'}` |
| DB の ACL に権限が無い | 403 `{error:'Forbidden', permission, role}` |
| `aal` が `aal2` でない | 403 `{error:'Forbidden', reason:'MFA required', permission, role}` |
| 認可の中の例外 | 500 `{error:'Internal server error'}` |
| 通った | `{ok:true, userId, role, actorEmail}`（メールは JWT に無ければ空） |

- 権限: 作成・強制失効・2要素のリセットは `admin.users.manage`、監査ログは `admin.audit.read`、問い合わせの読みは `admin.contact.read`・書きは `admin.contact.manage`、色見本の読みは `admin.items.read`・書きは `admin.items.manage`（DATA-ADMIN-006）
- DB: 認可の後に `createServiceRoleClient()` を作る。RLS を通らないので、守りは窓口の認可1つになる（ARC-ADMIN-001、DATA-ADMIN-002）
- 例外: どの方法も外側の try/catch で 500 `{error:'Internal server error'}` を返し、例外を `console.error` にそのまま渡す
- 回数の制限は無い（SEC-ADMIN-006 を参照。TM-ADMIN-36）。CSRF は proxy の Origin の検査だけで、窓口は `requireCsrfOrDeny` を呼ばない（ARC-ADMIN-002）
- テストの共通の形: `@/lib/auth/admin-rbac`・`@/lib/supabase/server`・`@/lib/audit` を差し替え、認可が `ok:false` を返す時は認可の応答をそのまま返して DB を作らないこと、外側の catch に落ちる例外（`createServiceRoleClient` が投げる等）で 500 になることを、方法ごとに1件ずつ確かめる

## 詳細設計

### DD-ADMIN-001 利用者の作成の画面

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-ADMIN-001、ARC-ADMIN-002 |
| 根拠 | 店長がその場でアカウントを用意する画面（SCR-ADMIN-001）。会員登録と同じ 16 文字の決まりを送る前に見せて、短い入力を早く直せるようにする（窓口の下限は 8 文字で、画面の方が厳しい）。画面は守りを持たず、作れるかは窓口の認可で決まる。送る時は CSRF の印を付けず、proxy の Origin の照合に任せる（ARC-ADMIN-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/create-user/page.tsx`）、`docs/03_BasicDesign/ui/screen-list.md` |

**対応要件 ID:** SCR-ADMIN-001、ARC-ADMIN-002（その上は DRV-ADMIN-001、FREQ-402-REQ-02（範囲外）、SEC-ADMIN-005、FREQ-327-REQ-01（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | props なし。欄 NAME（表示名）・EMAIL（メールの型）・PASSWORD（伏せ字） |
| 出力 | `POST /api/admin/create-user` に JSON `{email, password, display_name}`（DD-ADMIN-002）。画面の下に1行の知らせ |

**正常フロー:**（`src/app/admin/create-user/page.tsx`）

1. 送る時に知らせを消す
2. メールとパスワードが入っていて、パスワードが 16 文字以上なら、送っている印を立てて素の `fetch` で JSON を送る。送っている間は「作成」のボタンを押せない
3. 応答の本文を JSON で読む。読めなければ空とみなす
4. 201 なら「ユーザ作成しました: 」と応答のメール（無ければ空の字）を出し、3つの欄を空にする。同じ画面に留まる
5. 終わったら成否にかかわらず送っている印を下ろす

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| メールが空、またはパスワードが空 | 「メールとパスワードを入力してください」を出し、送らない |
| パスワードが 16 文字未満 | 「パスワードは16文字以上にしてください」を出し、送らない。窓口は 8 文字から通すので、窓口を直に呼べば 8〜15 文字でも作れる（SEC-ADMIN-012 を参照） |
| 201 でない | 応答の `error`（英語の固定の文。例 `Email already registered`・`Forbidden`）を出す。本文が読めない・`error` が無ければ「作成に失敗しました」（TM-ADMIN-28） |
| 通信の例外 | 記録して「ネットワークエラーが発生しました」 |

**状態・永続化:** 部品の state（`email`・`password`・`displayName`・`loading`・`message`）だけを持つ。知らせがある時だけ段落を描く。保存は窓口が行う。

**認証認可:** 画面はログイン・役割・2要素を見ず、URL を直に打てば誰でも開ける。入口のリンクは無い。窓口が `admin.users.manage` と aal2 を確かめる。素の `fetch` なので CSRF の印（`x-csrf-token`）を付けず、401 の後の session の更新もしない（ARC-ADMIN-002。TM-ADMIN-33）。背景のパネルは範囲外の `src/app/admin/layout.tsx` が `/admin` だけに出すので、この画面には出ない。

**テスト観点:**（`tests/unit/app/admin/create-user/create-user-page.test.tsx`。`fetch` を差し替える）

- 3つの欄と「作成」のボタンが出て、初めは知らせが無い
- メールが空の時、パスワードが空の時に「メールとパスワードを入力してください」が出て `fetch` を呼ばない
- 15 文字のパスワードで「パスワードは16文字以上にしてください」が出て `fetch` を呼ばない
- 16 文字のパスワードで `POST /api/admin/create-user` に3つの値の JSON を送り、送っている間はボタンが押せない
- 201 で応答にメールがある時は「ユーザ作成しました: <メール>」が出て欄が空になる。応答が読めない時は「ユーザ作成しました: 」だけになる
- 201 でなく `error` がある時はその文、`error` が無い時と本文が読めない時は「作成に失敗しました」が出る
- `fetch` が例外を投げた時は「ネットワークエラーが発生しました」が出て、ボタンがまた押せる

### DD-ADMIN-002 利用者の作成の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-001、ARC-ADMIN-001、ARC-ADMIN-003、DATA-ADMIN-006、SEC-ADMIN-001 |
| 根拠 | Auth の利用者を作る機能は service role でしか呼べないので、店長に固定した `admin.users.manage` と aal2 を確かめてから呼ぶ（API-ADMIN-001、ARC-ADMIN-001、DATA-ADMIN-006、SEC-ADMIN-001）。作れた・重なった・失敗したを監査に分けて残し、誰がいつ誰を作ったかをたどれるようにする（ARC-ADMIN-003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/create-user/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-001、ARC-ADMIN-001、ARC-ADMIN-003、DATA-ADMIN-006、SEC-ADMIN-001（その上は DRV-ADMIN-001、ADR-0450、ADR-0451）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | POST。JSON `{email, password, display_name?}`。`email` はメールの形、`password` は 8 文字以上、`display_name` は任意の文字（長さの上限なし） |
| 出力 | 201 `{id, email}`、400 `{error:'Invalid request'}`、409 `{error:'Email already registered'}`、500 `{error:'Failed to create user'}` か `{error:'Internal server error'}` |

**正常フロー:**（`src/app/api/admin/create-user/route.ts`）

1. `admin.users.manage` で認可し、操作した人の id とメールを控える
2. 本文を JSON で読み、形を確かめる
3. service role の client で Auth の管理の機能に利用者を作らせる。表示名は利用者の付帯の情報（`user_metadata.display_name`）に入れる。確認済みの印は渡さず、役割も付けない
4. 監査に結果 `success` と作った利用者の id を書き、201 で id とメールを返す。作った結果に利用者が無ければ id とメールは空になる（結果の利用者への省略可能な参照）

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 認可の応答をそのまま返す。監査は書かない |
| 本文の JSON が壊れている | 外側の catch で 500 `Internal server error`。監査は書かない（SEC-ADMIN-013 を参照） |
| 形が合わない | 監査に結果 `failure`・`Invalid request body` を書き、400 |
| 作成の誤りで、誤りの文に `already` か `duplicate` を含む（大文字小文字を問わない） | 監査に結果 `conflict` と誤りの文のまま、409 |
| 作成のほかの誤り（誤りの文が空の時も） | 監査に結果 `error` と誤りの文のまま、500 `Failed to create user`（SEC-ADMIN-008 を参照） |
| 例外 | 500 `Internal server error` |

**状態・永続化:** 書くのは Supabase Auth の利用者（`auth.users`）と `audit_logs` の1行。監査には操作した人のメールを入れ、IP とブラウザの情報は入れない（ARC-ADMIN-003。SEC-ADMIN-022 を参照）。

**認証認可:** `admin.users.manage`（店長に固定。DATA-ADMIN-006）と aal2。CSRF は proxy の Origin の照合だけ。パスワードは 8 文字から通し、漏洩の照合もしない（SEC-ADMIN-012 を参照）。

**テスト観点:**（`tests/unit/api/admin/create-user-route.test.ts`）

- 認可が `ok:false` の時は認可の応答を返し、Auth の機能も監査も呼ばない
- 本文が JSON でない時は 500 `Internal server error`
- メールの形でない・パスワードが 7 文字の時は 400 で、監査に `failure`
- 作成が成功した時は 201 `{id, email}` で、監査に `success` と id。作成の結果に利用者が無い時も 201 で id とメールが空
- 表示名を渡すと `user_metadata.display_name` に入る
- 誤りの文が `User already registered` の時と `duplicate key` の時は 409 で、監査に `conflict`
- 誤りの文がほかの時と空の時は 500 `Failed to create user` で、監査に `error`
- `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-003 セッションの強制失効の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-002、ARC-ADMIN-001、ARC-ADMIN-003、DATA-ADMIN-004、SEC-ADMIN-001 |
| 根拠 | 自前の表だけを直しても Auth の session と出した token が生き残るので、自前の `sessions` の行には失効の時刻を入れ（行は消さない）、service role だけが呼べる関数で Auth の session も消す（API-ADMIN-002、DATA-ADMIN-004）。人の session を切る操作は悪用もできるので、権限の無い試みも IP とブラウザの情報付きで監査に残す（ARC-ADMIN-003）。認可は共有の部品に任せる（ARC-ADMIN-001、SEC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/revoke-user-sessions/route.ts`）、`tests/integration/api/admin/revoke-user-sessions.test.ts` |

**対応要件 ID:** API-ADMIN-002、ARC-ADMIN-001、ARC-ADMIN-003、DATA-ADMIN-004、SEC-ADMIN-001（その上は FREQ-316-REQ-03（範囲外）、DRV-ADMIN-007、ADR-0454、SEC-ADMIN-004）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | POST。JSON `{user_id}`（1 字以上の文字。UUID かは見ない）。見出し `x-forwarded-for`・`user-agent` |
| 出力 | 200 `{ok:true}`、400 `{error:'Invalid request'}`、500 `{error:'Failed to revoke sessions'}` か `{error:'Internal server error'}`、認可の応答 |

**正常フロー:**（`src/app/api/admin/revoke-user-sessions/route.ts`）

1. 監査のために、`x-forwarded-for` の左端（前後の空白を除く）と `user-agent` を控える。どちらも無ければ空
2. `admin.users.manage` で認可する
3. 本文を JSON で読み、形を確かめる
4. service role の client で、自前の `sessions` のその利用者の行に今の時刻の失効を入れる。この更新の誤りは見ない
5. 関数 `revoke_auth_sessions_for_user` に利用者の id を渡し、Auth の session を消させる
6. 監査に結果 `success` と消した Auth の session の数（返りが空なら 0）を書き、200 `{ok:true}`

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 監査に操作した人を空にして結果 `unauthorized` を IP とブラウザの情報付きで書き、認可の応答を返す。認可の部品の 503・500 も同じ記録になる（SEC-ADMIN-007 を参照。TM-ADMIN-27） |
| 本文の JSON が壊れている | 外側の catch で 500 `Internal server error`。監査は書かない（SEC-ADMIN-013 を参照） |
| 形が合わない | 監査に結果 `failure` を IP とブラウザの情報付きで書き、400 |
| 自前の表の更新が誤りを返す | 見ずに進む。Auth の側が消せれば 200（SEC-ADMIN-016 を参照） |
| 関数が誤りを返す | 監査に結果 `error`・`auth_session_revocation_failed` を書き、500 `Failed to revoke sessions` |
| DB の client の作成・更新・関数の呼び出しで例外 | 内側の catch で監査に結果 `error` と例外の文のまま書き、500 `Failed to revoke sessions` |
| そのほかの例外 | 500 `Internal server error` |

- 自分自身・存在しない利用者を断らない（SEC-ADMIN-015 を参照）。存在しない利用者でも関数は 0 を返し 200 になる（推定）

**状態・永続化:** `sessions.revoked_at` を書き、`auth.sessions` の行を消し（DATA-ADMIN-004）、`audit_logs` に1行書く。成功・関数の誤り・例外の監査には IP とブラウザの情報を入れない（ARC-ADMIN-003。SEC-ADMIN-022 を参照）。

**認証認可:** `admin.users.manage` と aal2。関数は postgres と service_role にだけ実行を付けてある（DATA-ADMIN-004）ので、この窓口の service role の道だけが呼べる。画面から呼ぶ所は無い。

**テスト観点:**（`tests/unit/api/admin/revoke-user-sessions-route.test.ts`。既存の `tests/integration/api/admin/revoke-user-sessions.test.ts` の4件は網羅に数えない）

- 認可が `ok:false` の時は、操作した人が空の `unauthorized` の監査を書いてから認可の応答を返す。`x-forwarded-for` が `"1.1.1.1, 2.2.2.2"` なら IP は `1.1.1.1`、見出しが無ければ IP とブラウザの情報は空
- 本文が JSON でない時は 500 `Internal server error`
- `user_id` が無い・空の時は 400 で、監査に `failure`
- 成功の時は `sessions` を `user_id` で更新し、関数に `{p_user_id}` を渡し、200 `{ok:true}` で、監査の付帯の情報に消した数。関数の返りが空の時は数が 0
- 関数が誤りを返した時は 500 `Failed to revoke sessions` で、監査に `auth_session_revocation_failed`
- 更新か関数の呼び出しが例外を投げた時は 500 `Failed to revoke sessions` で、監査に例外の文
- 認可の部品が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-004 監査ログの読み出しの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-003、ARC-ADMIN-001、DATA-ADMIN-002、DATA-ADMIN-003、SEC-ADMIN-011 |
| 根拠 | `audit_logs` は authenticated の直接の読みを方針で断るので、`admin.audit.read` を確かめた後に service role で読む（API-ADMIN-003、ARC-ADMIN-001、DATA-ADMIN-002）。操作した人のメール・IP・ブラウザの情報・付帯の情報は読める人にも返さず、列を名指しした8列だけを返す（SEC-ADMIN-011、DATA-ADMIN-003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/audit-logs/route.ts`）、`tests/integration/api/admin/audit-logs.test.ts` |

**対応要件 ID:** API-ADMIN-003、ARC-ADMIN-001、DATA-ADMIN-002、DATA-ADMIN-003、SEC-ADMIN-011（その上は FREQ-508-REQ-01、DRV-ADMIN-005、ADR-0452、ADR-0453）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | GET。クエリも本文も読まない |
| 出力 | 200 `{data}`（行の配列）、500 `{error:'Failed to fetch audit logs'}` か `{error:'Internal server error'}`、認可の応答 |

**正常フロー:**（`src/app/api/admin/audit-logs/route.ts`）

1. `admin.audit.read` で認可する
2. service role の client で、`id`・`created_at`・`action`・`actor_id`・`resource`・`resource_id`・`outcome`・`detail` の8列だけを、作った時刻の新しい順に 100 件まで読む
3. 200 `{data}` で返す。ページ送りは無い

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 認可の応答をそのまま返し、DB を作らない |
| 読みの誤り | 記録して 500 `Failed to fetch audit logs` |
| 例外 | 500 `Internal server error` |

**状態・永続化:** 読むだけ。監査は書かない（SEC-ADMIN-023 を参照）。

**認証認可:** `admin.audit.read`（初めは店長だけ。DATA-ADMIN-006）と aal2。画面から呼ぶ所は無い（FREQ-508-AC-01 の画面は無い）。

**テスト観点:**（`tests/unit/api/admin/audit-logs-route.test.ts`。既存の `tests/integration/api/admin/audit-logs.test.ts` の3件は網羅に数えない）

- 認可が `ok:false` の時は認可の応答を返し、`createServiceRoleClient` を呼ばない
- 成功の時は8列の文字で `select` し、`created_at` の降順・100 件で読み、200 `{data}`
- 読みが誤りを返した時は 500 `Failed to fetch audit logs`
- `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-005 特権の利用者の2要素のリセットの窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-004、ARC-ADMIN-001、ARC-ADMIN-003、SEC-ADMIN-001 |
| 根拠 | 2要素の登録を消す機能は Auth の管理の機能で service role でしか呼べないので、`admin.users.manage` と aal2 を確かめてから呼ぶ（API-ADMIN-004、ARC-ADMIN-001、SEC-ADMIN-001）。取り返しがつかないので、確認の語と理由の文を求め、自分自身と一般の利用者を断り、判定の結果は IP とブラウザの情報付きで監査に残す（認可の失敗と外側の例外は監査を書かない）。理由の文を書くのは、対象を引いた後の結果（対象なし・特権でない・一覧の誤り・消せない・成功）だけで、形の誤りと自分自身の行には無い。対象の役割は特権でない時と成功、対象のメールは成功だけに入る（ARC-ADMIN-003） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/users/mfa/reset/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-004、ARC-ADMIN-001、ARC-ADMIN-003、SEC-ADMIN-001（その上は DRV-ADMIN-002、ADR-0457）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | POST。JSON `{userId, reason, confirm}`。`userId` は UUID、`reason` は前後の空白を除き 10〜500 字、`confirm` は `RESET_MFA` だけ。見出し `x-forwarded-for`・`user-agent` |
| 出力 | 200 `{success:true, deletedFactorCount, message}`、400 `{error:'Invalid request', details}`・`{error:'Self-reset is not allowed'}`・`{error:'MFA reset is available only for privileged users'}`、404 `{error:'User not found'}`、500 `{error:'Failed to list target MFA factors'}`・`{error:'Failed to delete one or more MFA factors'}`・`{error:'Internal server error'}`、認可の応答 |

**正常フロー:**（`src/app/api/admin/users/mfa/reset/route.ts`）

1. `admin.users.manage` で認可する
2. 監査のために `x-forwarded-for` の左端と `user-agent` を控える
3. 本文を JSON で読み（壊れていれば空の物）、形を確かめる。監査のため、本文の `userId` が文字ならそれを控える
4. service role の client で対象を Auth の管理の機能で引く
5. 対象の役割を Auth の付帯の情報（`app_metadata.role`）で決める。付帯の情報が物でない時と、役割が `admin`・`supporter`・`user` の外の時は `user` とみなす
6. 店長かサポーターなら、2要素の登録を全部引く。返りの一覧が配列で、全部の要素が物で空でない文字の `id` を持つ時だけその一覧を使い、ほかは空の一覧にする
7. 1つずつ消し、誤りがあれば要素の id と誤りの文（無ければ `failed_to_delete_factor`）を控える
8. 誤りが無ければ、監査に結果 `success`・理由・対象の役割・対象のメール（無ければ空）・消した数を書き、200 で消した数と「もう一度サインインして登録し直す」旨の英語の文を返す

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 認可の応答をそのまま返す。監査は書かない |
| 本文の JSON が壊れている | 空の物として形の誤りに進む |
| 形が合わない | 監査に結果 `failure`・控えた `userId`（文字でなければ空）を書き、400 で zod の誤りの内訳を返す |
| 対象が自分自身 | 監査に結果 `failure`・`Self-reset is not allowed` を書き、400 |
| 対象を引けない・対象が無い | 監査に結果 `failure`・理由を書き、404 |
| 対象が店長でもサポーターでもない | 監査に結果 `failure`・理由・対象の役割を書き、400 |
| 一覧の誤り | 監査に結果 `error`・理由・誤りの文を書き、500 |
| 一覧の形が合わない（配列でない・要素が物でない・`id` が無いか空） | 空の一覧として消さずに成功へ進み、消した数 0 で 200 を返す（推定。TM-ADMIN-26） |
| 1つでも消せない | 監査に結果 `error`・理由・全部の数・誤りの一覧を書き、500。消せた分は戻さない |
| 例外 | 500 `Internal server error` |

**状態・永続化:** 消すのは Auth の2要素の登録（`auth.mfa_factors`）だけ。対象の session は失効させない（SEC-ADMIN-014 を参照）。`audit_logs` に1行書き、付帯の情報の理由と対象のメールは伏せずに残る（SEC-ADMIN-008 を参照）。

**認証認可:** `admin.users.manage` と aal2。対象の役割を DB の ACL でなく `app_metadata` で決める（SEC-ADMIN-014 を参照）。画面から呼ぶ所は無い。

**テスト観点:**（`tests/unit/api/admin/mfa-reset-route.test.ts`。Auth の管理の機能 `getUserById`・`mfa.listFactors`・`mfa.deleteFactor` を差し替える）

- 認可が `ok:false` の時は認可の応答を返し、監査を書かない
- 本文が JSON でない時、`confirm` が違う時、理由が 9 字の時、`userId` が UUID でない時は 400 で `details` を返し、監査に `failure`。`userId` が文字の時はそれを、数の時は空を控える
- `x-forwarded-for` と `user-agent` が無い時は監査の IP とブラウザの情報が空
- `userId` が認可の利用者と同じ時は 400 `Self-reset is not allowed`
- `getUserById` が誤りを返した時と、利用者が空の時は 404
- `app_metadata` が空の時・役割が `user` の時・役割が知らない値の時は 400（特権でない）
- 役割が `admin` の時と `supporter` の時に一覧を引く。一覧が誤りを返した時は 500 `Failed to list target MFA factors`
- 一覧が2件で両方消せた時は 200 で消した数 2、監査に対象のメール。対象のメールが無い時は空
- 一覧が配列でない時・要素が空の時・要素の `id` が空の文字の時は消さずに 200 で消した数 0
- 1件の削除が誤りの文付きで失敗した時と、誤りの文が無い時（`failed_to_delete_factor`）は 500 `Failed to delete one or more MFA factors`
- `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-006 問い合わせの一覧の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-005、ARC-ADMIN-001、DATA-ADMIN-001、SEC-ADMIN-019 |
| 根拠 | 問い合わせを状態・種別・検索語で絞り、最後のやり取りの新しい順にページで返す（API-ADMIN-005）。表は直接の読みを断るので、`admin.contact.read` の後に service role で読む（ARC-ADMIN-001、DATA-ADMIN-001）。検索語は PostgREST の or の条件に字で埋め込むので、区切りの字を空白にし長さを切ってから入れる（SEC-ADMIN-019） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/contact/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-005、ARC-ADMIN-001、DATA-ADMIN-001、SEC-ADMIN-019（その上は FR-ADMIN-009、FREQ-25-REQ-01、ADR-0458）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | GET。クエリ `page`・`pageSize`・`status`・`type`・`q` |
| 出力 | 200 `{data, page, pageSize, totalPages, totalCount}`。行は `id`・`created_at`・`updated_at`・`last_message_at`・`name`・`email`・`inquiry_type`・`subject`・`status`・`order_id`・`user_id`。500 `{error:'Failed to fetch inquiries'}` か `{error:'Internal server error'}`、認可の応答 |

**正常フロー:**（`src/app/api/admin/contact/route.ts`）

1. `admin.contact.read` で認可する
2. `page` を 10 進の整数で読む。無ければ 1、数でない・0 なら 1、1 より小さければ 1
3. `pageSize` を読む。無ければ 20、数でない・0 なら 20、1 より小さければ 1、100 より大きければ 100（0 が 20 になるのは TM-ADMIN-29）
4. 11 列を総数付きで選ぶ
5. `status` が open・pending・answered・closed のどれかなら状態で絞る。ほかの値と無い時は絞らない
6. `type` が product・order・other のどれかなら種別で絞る。ほかの値と無い時は絞らない
7. `q`（無ければ空）の `,`・`(`・`)`・`%`・`\` を空白にし、前後を除き、100 字で切る。残りがあれば名前・メール・件名の部分一致の or の条件にする
8. 最後のやり取りの時刻の新しい順に、ページの幅だけ取る
9. 総数（無ければ 0）から総ページ（最低 1）を出し、行（無ければ空の配列）と一緒に 200 で返す

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 認可の応答をそのまま返す |
| 読みの誤り | 記録して 500 `Failed to fetch inquiries` |
| 例外 | 500 `Internal server error` |

- `_`・`*` は残り、部分一致の字として効く（推定）

**状態・永続化:** 読むだけ。監査は書かない（SEC-ADMIN-023 を参照）。

**認証認可:** `admin.contact.read`（初めは店長とサポーター。DATA-ADMIN-006）と aal2。呼ぶのは使われない `src/components/ContactSection.tsx` だけ。

**テスト観点:**（`tests/unit/api/admin/admin-contact-route.test.ts`。PostgREST の組み立ての鎖を差し替える）

- 認可が `ok:false` の時は認可の応答を返す
- クエリが無い時は 1 ページ目・20 件（`range(0, 19)`）で、絞りも or も付けない
- `page=3&pageSize=10` で `range(20, 29)`。`page=abc`・`page=0`・`page=-2` で 1 ページ目。`pageSize=0`・`pageSize=abc` で 20、`pageSize=-5` で 1、`pageSize=500` で 100
- `status=open` で状態の絞りが付き、`status=bogus` では付かない。`type=order` で種別の絞りが付き、`type=bogus` では付かない
- `q=a,b(c)%d\e` で区切りの字が空白になった語で or が付く。`q=` と区切りの字だけの `q` では or が付かない。101 字の `q` は 100 字に切られる
- 総数 45・幅 20 で総ページ 3。総数が空の時は総数 0・総ページ 1。行が空の時は空の配列
- 読みが誤りを返した時は 500 `Failed to fetch inquiries`
- `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-007 問い合わせの詳細と状態の変更の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-006、API-ADMIN-007、ARC-ADMIN-001、ARC-ADMIN-003、STATE-ADMIN-001 |
| 根拠 | 返信の前に経緯をつかめるよう、問い合わせ1件とやり取りを古い順に返し、注文に結んだ物は注文番号を添える（API-ADMIN-006）。状態は表の CHECK と同じ4つの値だけを入口で受け、どの値からどの値へも移せる形にする（API-ADMIN-007、STATE-ADMIN-001）。状態の変更は監査に残す（ARC-ADMIN-003）。どちらも認可の後に service role で読み書きする（ARC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/contact/[id]/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-006、API-ADMIN-007、ARC-ADMIN-001、ARC-ADMIN-003、STATE-ADMIN-001（その上は FR-ADMIN-009、FREQ-25-REQ-01、DRV-ADMIN-008、FR-CONTACT-012（範囲外））

**入出力:**

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| GET | 道の `id`（形を確かめない） | 200 `{data:{…問い合わせの14列, orderNumber, messages}}`、404 `{error:'Inquiry not found'}`、500 `{error:'Failed to fetch messages'}` か `{error:'Internal server error'}` |
| PATCH | 道の `id`、JSON `{status}`（open・pending・answered・closed） | 200 `{success:true}`、400 `{error:'Invalid request', details}`、500 `{error:'Failed to update status'}` か `{error:'Internal server error'}` |

**正常フロー:**（`src/app/api/admin/contact/[id]/route.ts`）

GET:

1. 道の `id` を読み、`admin.contact.read` で認可する
2. 問い合わせを `id` で1件読む。列は本文・会員の id・送った時の IP（`submitted_ip`）・ブラウザの情報を含む14列
3. やり取り（`id`・送り手の役・書いた人・本文・経路・時刻）を作った時刻の古い順に読む
4. 注文の id があれば注文番号の形にし、無ければ空にする
5. 問い合わせの列に注文番号とやり取り（無ければ空の配列）を足して 200 で返す

PATCH:

1. 道の `id` を読み、`admin.contact.manage` で認可する
2. 本文を JSON で読み（壊れていれば空の物）、形を確かめる
3. 状態と直した時刻を書き換える。最後のやり取りの時刻は変えない
4. 監査に `admin.contact.status_update`・結果 `success`・`status=<新しい状態>`・ブラウザの情報を書き、200

**異常フロー:**

| 方法 | 条件 | 動き |
| --- | --- | --- |
| GET・PATCH | 認可の失敗 | 認可の応答をそのまま返す |
| GET | 問い合わせの読みが誤り（id の形が違う時も）・行が無い | 404 `Inquiry not found` |
| GET | やり取りの読みの誤り | 記録して 500 `Failed to fetch messages` |
| PATCH | 本文の JSON が壊れている・状態が4つの外 | 400 で zod の誤りの内訳を返す |
| PATCH | 更新の誤り | 記録して 500 `Failed to update status` |
| PATCH | 対象の行が無い | 行の数を見ないので 200 `{success:true}` で、成功を監査に残す（SEC-ADMIN-021 を参照） |
| GET・PATCH | 例外 | 500 `Internal server error` |

**状態・永続化:** GET は読むだけで、監査は書かない（SEC-ADMIN-023 を参照）。PATCH は `contact_inquiries.status`・`updated_at` を書き（STATE-ADMIN-001）、`audit_logs` に1行書く。監査には操作した人のメールと IP を入れない（SEC-ADMIN-022 を参照）。割当の作業の移行が注文との結び付きを外した問い合わせは、注文番号が空になる（TM-ADMIN-19）。

**認証認可:** GET は `admin.contact.read`、PATCH は `admin.contact.manage`（どちらも初めは店長とサポーター）と aal2。サポーターにも IP とブラウザの情報を返す（SEC-ADMIN-020 を参照）。呼ぶのは使われない `src/components/ContactSection.tsx` だけ。

**テスト観点:**（`tests/unit/api/admin/admin-contact-id-route.test.ts`。`toOrderNumber` は本物か差し替え）

- GET: 認可が `ok:false` の時は認可の応答を返す
- GET: 問い合わせの読みが誤りの時と、行が空の時は 404
- GET: やり取りの読みが誤りの時は 500 `Failed to fetch messages`
- GET: 注文の id がある時は注文番号が入り、無い時は空。やり取りが空の時は空の配列
- GET: やり取りを `created_at` の昇順で読む
- PATCH: 認可が `ok:false` の時は認可の応答を返す
- PATCH: 本文が JSON でない時と、`status=done` の時は 400 で `details`
- PATCH: `status=closed` で状態と直した時刻を更新し、200 で、監査の詳しい文が `status=closed`
- PATCH: 更新が誤りを返した時は 500 `Failed to update status` で、監査を書かない
- GET・PATCH: `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-008 管理の返信の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-008、ARC-ADMIN-001、ARC-ADMIN-003、ARC-ADMIN-004、STATE-ADMIN-001 |
| 根拠 | 店の答えを失わないよう保存を先にし、メールが送れなくても保存を取り消さず、結果を `mailSent` と監査で分ける（API-ADMIN-008、ARC-ADMIN-003）。返したら状態を answered にそろえる（STATE-ADMIN-001）。お客様がメールで返せるよう、Reply-To にスレッドの印付きの宛先を入れ、設定が無ければ Reply-To を付けずに送る（ARC-ADMIN-004）。読み書きは認可の後に service role で行う（ARC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/contact/[id]/reply/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-008、ARC-ADMIN-001、ARC-ADMIN-003、ARC-ADMIN-004、STATE-ADMIN-001（その上は FREQ-25-REQ-01、FR-ADMIN-009、DRV-ADMIN-006、SEC-ADMIN-017、ADR-0455、ADR-0456）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | POST。道の `id`、JSON `{body}`（前後の空白を除き 1〜5000 字）。環境変数 `MAIL_FROM_ADDRESS` |
| 出力 | 201 `{success:true, mailSent}`、400 `{error:'Invalid request', details}`、404 `{error:'Inquiry not found'}`、500 `{error:'Failed to save reply'}` か `{error:'Internal server error'}`、認可の応答。お客様へのメール1通 |

**正常フロー:**（`src/app/api/admin/contact/[id]/reply/route.ts`）

1. 道の `id` を読み、`admin.contact.manage` で認可する
2. 本文を JSON で読み（壊れていれば空の物）、形を確かめる
3. 問い合わせの `id`・メール・件名を読む
4. やり取りに、送り手の役 `admin`・書いた人に操作した人・本文・経路 `web` で1行足す
5. 問い合わせの状態を answered にし、最後のやり取りの時刻と直した時刻を今にする。この更新の誤りは見ない
6. `MAIL_FROM_ADDRESS` があれば、件名が `Re:` で始まればそのまま、ほかは頭に `Re:` と空白を付け、本文の後に空行・`---`・店の名前を足して送る。Reply-To は返信の宛先（DD-ADMIN-013）で、作れなければ付けない
7. 監査に `admin.contact.reply`、メールが通れば結果 `success`・`reply_sent`、失敗なら結果 `error`・`reply_saved_mail_failed` を、ブラウザの情報付きで書く
8. 201 `{success:true, mailSent}` を返す。`mailSent` はメールが失敗した時だけ偽

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 認可の応答をそのまま返す |
| 本文の JSON が壊れている・本文が空か 5000 字を超える | 400 で zod の誤りの内訳を返す |
| 問い合わせの読みが誤り・行が無い | 404 `Inquiry not found` |
| やり取りの保存の誤り | 記録して 500 `Failed to save reply`。状態もメールも監査も触らない |
| 状態の更新の誤り | 見ずに進む |
| `MAIL_FROM_ADDRESS` が無い | メールを送らずに `mailSent` を真で返し、監査も `reply_sent`（SEC-ADMIN-021 を参照） |
| メールの送り手が例外を投げる（送り手の名前が不正な設定の時も） | 警告を出し、保存は残し、`mailSent` を偽にする |
| 例外 | 500 `Internal server error` |

- 件名の改行を消さずに送り手に渡す（SEC-ADMIN-018 を参照）

**状態・永続化:** `contact_messages` に1行足し、`contact_inquiries` の状態と時刻を書き、`audit_logs` に1行書く。保存の後にメールが失敗しても保存は戻さない。監査には操作した人のメールと IP を入れない（SEC-ADMIN-022 を参照）。

**認証認可:** `admin.contact.manage`（初めは店長とサポーター）と aal2。呼ぶのは使われない `src/components/ContactSection.tsx` だけ。

**テスト観点:**（`tests/unit/api/admin/admin-contact-reply-route.test.ts`。`@/lib/mail`・`@/lib/contact/reply-address` を差し替え、`MAIL_FROM_ADDRESS` を出し入れする）

- 認可が `ok:false` の時は認可の応答を返す
- 本文が JSON でない時、`body` が空白だけの時、5001 字の時は 400 で `details`
- 問い合わせの読みが誤りの時と、行が空の時は 404
- 保存が誤りを返した時は 500 `Failed to save reply` で、メールを送らず監査を書かない
- `MAIL_FROM_ADDRESS` がある時、件名が `質問` なら `Re: 質問`、`Re: 質問` ならそのままで送り、本文の後に店の名前が付く。201 で `mailSent` が真、監査が `reply_sent`
- 返信の宛先が作れる時は Reply-To にその宛先、作れない時は Reply-To が無い
- メールが例外を投げた時は 201 で `mailSent` が偽、監査が `error`・`reply_saved_mail_failed`
- `MAIL_FROM_ADDRESS` が無い時はメールを送らずに 201 で `mailSent` が真
- 状態の更新に answered と時刻を渡す
- `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-009 返信のテンプレートの一覧と作成の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-009、API-ADMIN-010、ARC-ADMIN-001、ARC-ADMIN-003、DATA-ADMIN-001 |
| 根拠 | よく使う答えを選べるよう、並び順の小さい順・同じなら作った順で全部を返す（API-ADMIN-009）。店が自分で増やせるよう作成を受け、題・本文の長さと分類を入口で決めて表の CHECK とそろえる（API-ADMIN-010、DATA-ADMIN-001）。作った事は監査に残す（ARC-ADMIN-003）。表は直接の読み書きを断るので、認可の後に service role で扱う（ARC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/contact/templates/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-009、API-ADMIN-010、ARC-ADMIN-001、ARC-ADMIN-003、DATA-ADMIN-001（その上は FR-ADMIN-009、FREQ-25-REQ-01）

**入出力:**

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| GET | なし | 200 `{data}`（`id`・`title`・`category`・`body`・`sort_order`・`created_at`・`updated_at`）、500 `{error:'Failed to fetch templates'}` か `{error:'Internal server error'}` |
| POST | JSON `{title, category?, body, sortOrder?}`。題は前後を除き 1〜120 字、分類は product・order・other・general か空、本文は前後を除き 1〜5000 字、並び順は 0〜9999 の整数 | 201 `{success:true, id}`、400 `{error:'Invalid request', details}`、500 `{error:'Failed to create template'}` か `{error:'Internal server error'}` |

**正常フロー:**（`src/app/api/admin/contact/templates/route.ts`）

GET:

1. `admin.contact.read` で認可する
2. 7列を並び順の昇順、同じなら作った時刻の昇順で全部読み、200 で返す（行が無ければ空の配列）

POST:

1. `admin.contact.manage` で認可する
2. 本文を JSON で読み（壊れていれば空の物）、形を確かめる
3. 題・分類（無ければ空）・本文・並び順（無ければ 0）で1行作り、作った `id` を読む
4. 監査に `admin.contact.template.create`・結果 `success`・`created`・ブラウザの情報を書き、201 で `id` を返す

**異常フロー:**

| 方法 | 条件 | 動き |
| --- | --- | --- |
| GET・POST | 認可の失敗 | 認可の応答をそのまま返す |
| GET | 読みの誤り | 記録して 500 `Failed to fetch templates` |
| POST | 本文の JSON が壊れている・形が合わない | 400 で zod の誤りの内訳を返す |
| POST | 作成の誤り・作った行が返らない | 記録して 500 `Failed to create template`。監査は書かない |
| GET・POST | 例外 | 500 `Internal server error` |

**状態・永続化:** POST は `contact_reply_templates` に1行足し、`audit_logs` に1行書く。監査には操作した人のメールと IP を入れない（SEC-ADMIN-022 を参照）。

**認証認可:** GET は `admin.contact.read`、POST は `admin.contact.manage` と aal2。呼ぶのは使われない `src/components/ContactSection.tsx` だけ。

**テスト観点:**（`tests/unit/api/admin/admin-contact-templates-route.test.ts`）

- GET: 認可が `ok:false` の時は認可の応答を返す
- GET: `sort_order` と `created_at` の昇順で読み、200 `{data}`。行が空の時は空の配列
- GET: 読みが誤りを返した時は 500 `Failed to fetch templates`
- POST: 認可が `ok:false` の時は認可の応答を返す
- POST: 本文が JSON でない時、題が空白だけの時、分類が `bogus` の時、並び順が 10000 の時は 400
- POST: 分類と並び順が無い時は分類が空・並び順 0 で作り、ある時はその値で作る。201 `{success:true, id}` で、監査が `admin.contact.template.create`
- POST: 作成が誤りを返した時と、作った行が空の時は 500 `Failed to create template`
- GET・POST: `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-010 返信のテンプレートの更新と削除の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-011、API-ADMIN-012、ARC-ADMIN-001、ARC-ADMIN-003 |
| 根拠 | 答えの言い方が変わった時に直せるよう、作成と同じ入力の形で更新を受け、並び順を渡さなければ並び順を変えない（API-ADMIN-011）。使わなくなった答えを外せるよう削除を受ける（API-ADMIN-012）。どちらも誰が変えたかを監査に残し（ARC-ADMIN-003）、認可の後に service role で書く（ARC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/contact/templates/[id]/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-011、API-ADMIN-012、ARC-ADMIN-001、ARC-ADMIN-003（その上は FR-ADMIN-009、FREQ-25-REQ-01）

**入出力:**

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| PUT | 道の `id`、JSON は作成と同じ形 | 200 `{success:true}`、400 `{error:'Invalid request', details}`、500 `{error:'Failed to update template'}` か `{error:'Internal server error'}` |
| DELETE | 道の `id` | 200 `{success:true}`、500 `{error:'Failed to delete template'}` か `{error:'Internal server error'}` |

**正常フロー:**（`src/app/api/admin/contact/templates/[id]/route.ts`）

PUT:

1. 道の `id` を読み、`admin.contact.manage` で認可する
2. 本文を JSON で読み（壊れていれば空の物）、形を確かめる
3. 題・分類（無ければ空にする）・本文・直した時刻を書き、並び順は渡された時だけ書く
4. 監査に `admin.contact.template.update`・結果 `success`・`updated`・ブラウザの情報を書き、200

DELETE:

1. 道の `id` を読み、`admin.contact.manage` で認可する
2. 行を消す
3. 監査に `admin.contact.template.delete`・結果 `success`・`deleted`・ブラウザの情報を書き、200

**異常フロー:**

| 方法 | 条件 | 動き |
| --- | --- | --- |
| PUT・DELETE | 認可の失敗 | 認可の応答をそのまま返す |
| PUT | 本文の JSON が壊れている・形が合わない | 400 で zod の誤りの内訳を返す |
| PUT | 更新の誤り | 記録して 500 `Failed to update template` |
| DELETE | 削除の誤り | 記録して 500 `Failed to delete template` |
| PUT・DELETE | 対象の行が無い | 行の数を見ないので 200 で、成功を監査に残す（SEC-ADMIN-021 を参照） |
| PUT・DELETE | 例外 | 500 `Internal server error` |

**状態・永続化:** PUT は `contact_reply_templates` の1行を書き換え、DELETE は1行を消す（戻せない）。どちらも `audit_logs` に1行書き、操作した人のメールと IP を入れない（SEC-ADMIN-022 を参照）。

**認証認可:** `admin.contact.manage`（初めは店長とサポーター）と aal2。呼ぶのは使われない `src/components/ContactSection.tsx` だけ。

**テスト観点:**（`tests/unit/api/admin/admin-contact-templates-id-route.test.ts`）

- PUT・DELETE: 認可が `ok:false` の時は認可の応答を返す
- PUT: 本文が JSON でない時と、本文が 5001 字の時は 400
- PUT: 並び順がある時は `sort_order` を含めて書き、無い時は含めない。分類が無い時は空で書く。200 で、監査が `admin.contact.template.update`
- PUT: 更新が誤りを返した時は 500 `Failed to update template` で、監査を書かない
- DELETE: `id` で消して 200 で、監査が `admin.contact.template.delete`
- DELETE: 削除が誤りを返した時は 500 `Failed to delete template`
- PUT・DELETE: `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-011 色見本の一覧と保存の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-013、API-ADMIN-014、ARC-ADMIN-001、DATA-ADMIN-005 |
| 根拠 | 商品の編集で前に使った色を選び直せるよう、新しい順に全部を返す（API-ADMIN-013）。同じ名前と色の値の組は何度保存しても1行にし、既にあればそれを返して、画面が重なりの誤りを扱わずに済むようにする（API-ADMIN-014、DATA-ADMIN-005）。読み書きは商品の権限で認可した後に service role で行う（ARC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/item-color-presets/route.ts`）、`docs/03_BasicDesign/api/api-spec.md`、`docs/04_DetailDesign/pages/16_admin.md` |
| 旧番号 | IMPL-ADMIN-COLOR-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-002 の行（道は `src/app/api/admin/color-presets/route.ts` と書くが、その道は無い） |

**対応要件 ID:** API-ADMIN-013、API-ADMIN-014、ARC-ADMIN-001、DATA-ADMIN-005（その上は DRV-ADMIN-004、ADR-0451、ADR-0459）

**入出力:**

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| GET | なし | 200 `{data}`（全部の列）、500 `{error:'Failed to fetch color presets'}` か `{error:'Internal server error'}` |
| POST | JSON `{name, hex}`。名前は前後を除き 1〜40 字、色の値は `#` と 16 進の 6 桁 | 200 `{data}`（既にある行の `id`・`name`・`hex`・`created_at`）、201 `{data}`（作った行の全部の列）、400 `{error:'Invalid request', details}`、500 `{error:'Failed to save color preset'}` か `{error:'Internal server error'}` |

**正常フロー:**（`src/app/api/admin/item-color-presets/route.ts`）

GET:

1. `admin.items.read` で認可する
2. 全部の列を作った時刻の新しい順に全部読み、200 で返す

POST:

1. `admin.items.manage` で認可する
2. 本文を JSON で読み、形を確かめる
3. 同じ名前と色の値の行を0か1件で引く。引く時の誤りは見ない
4. あれば 200 でその行を返す
5. 無ければ1行作り、全部の列を読んで 201 で返す

**異常フロー:**

| 方法 | 条件 | 動き |
| --- | --- | --- |
| GET・POST | 認可の失敗 | 認可の応答をそのまま返す |
| GET | 読みの誤り | 記録して 500 `Failed to fetch color presets` |
| POST | 本文の JSON が壊れている | 外側の catch で 500 `Internal server error`（SEC-ADMIN-013 を参照） |
| POST | 形が合わない | 400 で zod の誤りの内訳を返す |
| POST | 既にあるかを引く時の誤り | 見ずに作りへ進む。一意の制約に当たれば作成の誤りで 500（SEC-ADMIN-021 を参照） |
| POST | 作成の誤り | 記録して 500 `Failed to save color preset` |
| GET・POST | 例外 | 500 `Internal server error` |

**状態・永続化:** POST は `item_color_presets` に1行足すか、何も書かない。監査は書かない（SEC-ADMIN-022 を参照）。

**認証認可:** GET は `admin.items.read`、POST は `admin.items.manage`（どちらも初めは店長だけ）と aal2。呼ぶのは範囲外の商品の編集 `src/app/admin/item/ItemForm.tsx`。

**テスト観点:**（`tests/unit/api/admin/item-color-presets-route.test.ts`）

- GET: 認可が `ok:false` の時は認可の応答を返す
- GET: `created_at` の降順で読み、200 `{data}`。読みが誤りを返した時は 500 `Failed to fetch color presets`
- POST: 認可が `ok:false` の時は認可の応答を返す
- POST: 本文が JSON でない時は 500 `Internal server error`
- POST: 名前が空白だけの時、41 字の時、色の値が `#12345` の時は 400 で `details`
- POST: 同じ組の行がある時は 200 でその行を返し、作らない
- POST: 行が無い時は作って 201。引く時に誤りが返っても作りに進む
- POST: 作成が誤りを返した時は 500 `Failed to save color preset`
- GET・POST: `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-012 色見本の削除の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-ADMIN-015、ARC-ADMIN-001、DATA-ADMIN-005 |
| 根拠 | 誤って保存した色や使わなくなった色を一覧から外し、選び間違いを減らす（API-ADMIN-015、DATA-ADMIN-005）。消せるのは商品を管理できる人だけにし、認可の後に service role で消す（ARC-ADMIN-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/item-color-presets/[id]/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |

**対応要件 ID:** API-ADMIN-015、ARC-ADMIN-001、DATA-ADMIN-005（その上は DRV-ADMIN-004、ADR-0451）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | DELETE。道の `id`（数の形を確かめない） |
| 出力 | 200 `{success:true}`、500 `{error:'Failed to delete color preset'}` か `{error:'Internal server error'}`、認可の応答 |

**正常フロー:**（`src/app/api/admin/item-color-presets/[id]/route.ts`）

1. 道の `id` を読み、`admin.items.manage` で認可する
2. `id` の行を消し、200 を返す

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 認可の失敗 | 認可の応答をそのまま返す |
| 削除の誤り（数でない `id` で型の誤りになる時も、推定） | 記録して 500 `Failed to delete color preset` |
| 対象の行が無い | 行の数を見ないので 200（SEC-ADMIN-021 を参照） |
| 例外 | 500 `Internal server error` |

**状態・永続化:** `item_color_presets` の1行を消す（戻せない）。監査は書かない（SEC-ADMIN-022 を参照）。

**認証認可:** `admin.items.manage`（初めは店長だけ）と aal2。呼ぶのは範囲外の `src/app/admin/item/ItemForm.tsx`。

**テスト観点:**（`tests/unit/api/admin/item-color-presets-id-route.test.ts`）

- 認可が `ok:false` の時は認可の応答を返す
- `id` で消して 200 `{success:true}`
- 削除が誤りを返した時は 500 `Failed to delete color preset`
- `createServiceRoleClient` が例外を投げた時は 500 `Internal server error`

### DD-ADMIN-013 返信の宛先を作る

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-ADMIN-004、SEC-ADMIN-017 |
| 根拠 | 問い合わせの id だけの宛先では id を知る第三者が他人のスレッドに書き込めるので、秘密の鍵で作った印を添えて推測できなくする（ARC-ADMIN-004、SEC-ADMIN-017）。受信の設定が整う前でもメールを送れるよう、設定が無ければ空を返して呼ぶ側に Reply-To を省かせる |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/lib/contact/reply-address.ts`）、`docs/superpowers/plans/legacy-contact-feature-remaining-tasks.md` |

**対応要件 ID:** ARC-ADMIN-004、SEC-ADMIN-017（その上は FREQ-25-REQ-01、FREQ-24-REQ-01（範囲外）、FR-CONTACT-011（範囲外）、ADR-0455）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 問い合わせの id（文字）。環境変数 `CONTACT_INBOUND_DOMAIN`・`CONTACT_REPLY_SECRET` |
| 出力 | `reply+<id>.<印>@<ドメイン>` の文字か、空 |

**正常フロー:**（`src/lib/contact/reply-address.ts`）

1. ドメインと鍵を環境変数から読む
2. 鍵で id の HMAC-SHA256 を取り、base64url にした先頭 16 字を印にする
3. `reply+<id>.<印>@<ドメイン>` を返す。id はそのまま入れ、小文字にそろえない

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| ドメインが無い（空の字も） | 空を返す |
| 鍵が無い（空の字も） | 空を返す |

**状態・永続化:** 持たない。同じ id と鍵からは毎回同じ宛先になる。

**認証認可:** 持たない。鍵は環境変数だけにあり、宛先には印の先頭 16 字だけが出る。本番の2つの値は未設定（開店の準備で入れる予定）。

**テスト観点:**（`tests/unit/lib/contact/reply-address.test.ts`。環境変数を出し入れする）

- ドメインと鍵がある時は `reply+<id>.<16 字>@<ドメイン>` の形を返し、印は base64url の字だけ
- 同じ id では同じ印、違う id と違う鍵では違う印になる
- ドメインが無い時、鍵が無い時は空を返す

### DD-ADMIN-014 返信の宛先を確かめる

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-ADMIN-004、SEC-ADMIN-017 |
| 根拠 | 受信したメールの宛先から元のスレッドを決める時に、印を作り直して比べ、偽の宛先でのスレッドへの書き込みを見分ける（ARC-ADMIN-004、SEC-ADMIN-017）。比べるのに一定の時間の比較を使い、比べる時間の差から印を推し量られないようにする。名前付きの宛先の形も受けられるよう、宛先の中から形を探す |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/lib/contact/reply-address.ts`） |

**対応要件 ID:** ARC-ADMIN-004、SEC-ADMIN-017（その上は FREQ-25-REQ-01、FR-CONTACT-013（範囲外）、ADR-0455）

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 宛先の文字（素の宛先か、名前と山括弧の宛先）。環境変数 `CONTACT_REPLY_SECRET` |
| 出力 | `{inquiryId, valid}` か空 |

**正常フロー:**（`src/lib/contact/reply-address.ts`）

1. 鍵を環境変数から読む
2. 宛先の中から `reply+` の後に 16 進の字とハイフンの 36 字、`.`、英数字と `_`・`-` の印、`@` が続く所を探す
3. id を小文字にそろえ、印を取り出す
4. 鍵で小文字の id の印を作り直し、長さが違えば偽、同じなら一定の時間の比較の結果を `valid` にして返す

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| 鍵が無い（空の字も） | 空を返す |
| 形が合わない（`reply+` が無い・id が 36 字でない・印が無い・`@` が無い） | 空を返す |
| 印の長さが違う | `valid` を偽で返す |
| 印の長さが同じで中身が違う | `valid` を偽で返す |

- id の 36 字は字の種類と長さだけを見て、ハイフンの位置は見ない（UUID の形でなくても通る。推定。TM-ADMIN-30）
- 大文字の id で作った宛先は、作る側（DD-ADMIN-013）が小文字にそろえないので、ここで小文字にしてから作り直すと印が合わない（推定。TM-ADMIN-31。DB の uuid は小文字で返るので、今の使い方では起きない）

**状態・永続化:** 持たない。

**認証認可:** 持たない。合否を見てスレッドに取り込むかを決めるのは呼ぶ側（範囲外の受信の窓口）。

**テスト観点:**（`tests/unit/lib/contact/reply-address.test.ts`。DD-ADMIN-013 で作った宛先を使う）

- 鍵が無い時は空を返す
- `reply+` の形が無い宛先、id が 35 字の宛先、`@` の無い宛先は空を返す
- 作った宛先を素のまま渡すと、小文字の id と `valid` 真を返す。`"Shop <reply+…@…>"` の形でも同じ
- 印を1字変えた宛先は `valid` 偽、印を短くした宛先も `valid` 偽
- 大文字の id の宛先は id を小文字で返す

### DD-ADMIN-015 古い監査ログを消す（未使用（削除の判断待ち））

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-ADMIN-005、DATA-ADMIN-003 |
| 根拠 | 未使用（削除の判断待ち）。監査ログが増え続けないよう、指定の日数より前の行を消す道を1つの関数に置く（ARC-ADMIN-005）。`audit_logs` は authenticated から消せないので service role で消す（DATA-ADMIN-003）。呼ぶ所が無く、写しを残さずに消すので、使うか消すかが決まるまで単位として残し、動きを見落とさないようにする |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/lib/auditCleanup.ts`）、`tests/unit/lib/auditCleanup.test.ts` |

**対応要件 ID:** ARC-ADMIN-005、DATA-ADMIN-003（その上は DRV-ADMIN-003、FREQ-508-REQ-01、DRV-ADMIN-005、NFR-SEC-005（範囲外））

**入出力:**

| 向き | 中身 |
| --- | --- |
| 入力 | 任意の物 `{retentionDays?}`。物も日数も無ければ 365 日 |
| 出力 | `{deleted, data}`。`deleted` は消した数（数が返らなければ 0）、`data` は DB の返り |

**正常フロー:**（`src/lib/auditCleanup.ts`）

1. service role の client を作る
2. 今から日数分を引いた時刻を境にする
3. `audit_logs` の作った時刻が境より前の行を、数を数えて消す
4. 消した数と返りを返す

**異常フロー:**

| 条件 | 動き |
| --- | --- |
| DB の誤り | 誤りをそのまま投げる |
| 数が返らない | 消した数を 0 にする |
| 日数が数でない | 境の時刻を作る所で例外になり、そのまま投げる（推定。TM-ADMIN-32） |

**状態・永続化:** `audit_logs` の行を写しを残さずに消す（SEC-ADMIN-010 を参照。TM-ADMIN-06）。

**認証認可:** 関数は権限を見ず、service role で消す。src・scripts・定時の仕事のどこからも呼ばれない。

**テスト観点:**（既存の `tests/unit/lib/auditCleanup.test.ts` に足す）

- 日数 1 で、`audit_logs` から数え付きで消し、境の時刻で絞り、消した数を返す（既存）
- DB が誤りを返した時はその誤りを投げる（既存）
- 引数を渡さない時は 365 日前を境にする（時刻を固定して確かめる）
- 数が返らない時は消した数が 0

## 未確認事項

- `MAIL_FROM_ADDRESS`・`CONTACT_INBOUND_DOMAIN`・`CONTACT_REPLY_SECRET` と許可のオリジンの本番の設定（本番アプリは未デプロイ）
- 作った利用者が確認済みになるか（Supabase の既定の設定次第）
- 2要素のリセットの一覧が、Supabase の返りで形の合わない要素を含むことがあるか（含むと消さずに成功を返す）
- 存在しない利用者の強制失効で関数が 0 を返すか（動かして確かめていない）
- 色見本の削除で、数でない `id` が DB の型の誤りになるか
- この文書の項目は全部「推定」。ユーザーの確認を受けたら「現行」にする
