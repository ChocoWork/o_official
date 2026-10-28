# 1.16-1 管理画面のニュース（ADMIN NEWS）詳細設計

> 状態: 推定 | 確認日: 2026-10-28 | 対象: 管理画面の NEWS タブ・記事の作成と編集の画面・管理のニュースの窓口・画像の署名・使われていない Server Action | 基準コミット: `a03beaff`

## 概要

管理画面でニュースの記事を一覧・作成・編集・公開の切り替え・削除する部品と窓口、記事の画像を署名つき URL にする関数、公開済みの記事を3件返す Server Action、画像の中身の確かめ・保存名・後始末の関数を、詳細設計の項目（`DD-NEWS-060`〜`068`・`071`）で書く。
中身は 2026-10-24 の作業ツリーのコードを読んで起こした今の動きで、ユーザーの確認を受けていないので全部「推定」にした。文書・要件とコードが食い違う所は決めずに今のコードの動きを書き、食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節に載せる。

| ID | 題 | 単位 |
| --- | --- | --- |
| `DD-NEWS-060` | 管理の NEWS タブの一覧・公開の切り替え・削除 | `src/components/NewsSection.tsx` |
| `DD-NEWS-061` | 記事の作成・編集のフォーム | `src/app/admin/news/NewsForm.tsx` |
| `DD-NEWS-062` | 記事の作成のページ | `src/app/admin/news/create/page.tsx` |
| `DD-NEWS-063` | 記事の編集のページ | `src/app/admin/news/edit/[id]/page.tsx` |
| `DD-NEWS-064` | 管理の記事の一覧と作成の窓口 | `src/app/api/admin/news/route.ts` |
| `DD-NEWS-065` | 管理の記事1件の読み・更新・切り替え・削除の窓口 | `src/app/api/admin/news/[id]/route.ts` |
| `DD-NEWS-066` | 最新の公開済みの記事3件の Server Action — 未使用（削除の判断待ち） | `src/app/actions/news.ts` の `getLatestNews` |
| `DD-NEWS-067` | 画像の値から置き場の中の道を取り出す | `src/lib/storage/news-images.ts` の `extractNewsImageObjectPath` |
| `DD-NEWS-068` | 画像の値を署名つき URL に置き換える | `src/lib/storage/news-images.ts` の `signNewsImageUrl`・`signNewsImageFields` |
| `DD-NEWS-071` | 管理のニュースの画像の確かめ・保存名・後始末 | `src/features/news/services/admin-images.ts` の `prepareNewsImage`・`buildNewsImagePath`・`isOwnNewsImagePath`・`removeNewsImages` |

- 結論: 管理の画面は全部が利用者の端末で動く部品で、画面では権限を確かめない。守りは窓口（`DD-NEWS-064`・`065`）の `authorizeAdminPermission`（session・DB の ACL の権限・aal2）に置く。DB の読みは利用者の JWT で RLS に通し、書き込みは認可の後に service role で行う（ADR-0026）
- 署名に失敗した時の戻り値は `null`（2026-10-28 から。以前は元の値を返し、SEC-NEWS-008 の項目に現状との差を書いていた）。存在しない記事への PUT・PATCH・DELETE の応答、画像の中身の確かめ、置き場の画像の後始末は 2026-10-26 に直した（SEC-NEWS-016・017・018。DD-NEWS-071）
- 単体テストは `NewsForm`・`NewsSection`・`news-images`（`news-images.test.ts` は 2026-10-28 に書き直し、20 本余り）・管理の窓口などに限られる。分岐を全部通すのに要るテストを各項目の「テスト観点」に挙げた

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 上位の文書 | [NEWS の構造設計](../../03_BasicDesign/areas/news.md)（`ARC-`・`SCR-`・`FLOW-`・`STATE-`・`API-`・`DATA-NEWS-`）、[NEWS の要件](../../02_Requirements/areas/news.md)（`SEC-NEWS-`） |
| 対象のコード | 「実装の単位」の表の単位（`src/features/news/services/admin-images.ts` の4つを含む） |
| 引き継いだ文書 | [1.16 管理画面（ADMIN）詳細設計](16_admin.md) の `IMPL-ADMIN-003`（機能要件対応表の FR-ADMIN-003 の行）と `IMPL-ADMIN-NEWS-01`（実装タスク管理の ADMIN-01-004 の行）。元の文書は変えていない |
| 調べた時点 | 2026-10-24 の作業ツリー。コードは読んだだけで、動かしての確かめはしていない |

範囲外の共有部品は ID を持たないので、上位に書かず本文にファイルの道で書く。

| 共有部品 | 道 | ここでの使われ方 |
| --- | --- | --- |
| 管理の認可 | `src/lib/auth/admin-rbac.ts` の `authorizeAdminPermission` | 窓口ごとに token・session・DB の ACL の権限・aal2 を確かめる |
| 書き換えの送り方 | `src/lib/client-fetch.ts` の `clientFetch` | 画面から窓口へ送る。書き換えに `x-csrf-token` を付け、GET だけ 401 の後に session を更新して1回送り直す |
| Origin の検査 | `src/proxy.ts` | `/api` の書き換えの Origin・Referer を照合する（ARC-NEWS-004） |
| 監査 | `src/lib/audit.ts` の `logAudit` | 書き換えの成功と失敗を `audit_logs` に残す。書き込みの失敗は警告だけで握りつぶす |
| Supabase の client | `src/lib/supabase/server.ts` の `createClient`・`createServiceRoleClient` | 読みは利用者の JWT の client、書き込み（表と置き場）は認可の後に service role の client で扱う（ADR-0026） |
| 管理画面の親 | `src/app/admin/page.tsx` | NEWS タブの中身と「新規作成」を店長の役の時だけ描く |

## 実装の単位

`scripts/trace/parse-code.ts` の `parseCodeUnits` で数えた範囲内の単位と、つなぐ詳細設計。1つの単位は1つの `DD-` にだけつなぐ。`@impl`・`@design` のコメントはこの表から付ける。

| ファイル | 単位（symbol） | DD |
| --- | --- | --- |
| `src/components/NewsSection.tsx` | `<file>` | DD-NEWS-060 |
| `src/app/admin/news/NewsForm.tsx` | `<file>` | DD-NEWS-061 |
| `src/app/admin/news/create/page.tsx` | `<file>` | DD-NEWS-062 |
| `src/app/admin/news/edit/[id]/page.tsx` | `<file>` | DD-NEWS-063 |
| `src/app/api/admin/news/route.ts` | `<file>` | DD-NEWS-064 |
| `src/app/api/admin/news/[id]/route.ts` | `<file>` | DD-NEWS-065 |
| `src/app/actions/news.ts` | `getLatestNews` | DD-NEWS-066 |
| `src/lib/storage/news-images.ts` | `extractNewsImageObjectPath` | DD-NEWS-067 |
| `src/lib/storage/news-images.ts` | `signNewsImageUrl` | DD-NEWS-068 |
| `src/lib/storage/news-images.ts` | `signNewsImageFields` | DD-NEWS-068 |
| `src/features/news/services/admin-images.ts` | `prepareNewsImage`・`buildNewsImagePath`・`isOwnNewsImagePath`・`removeNewsImages` | DD-NEWS-071 |

- 窓口のファイルは、中の GET・POST などが別々の契約でも、単位がファイルなので1つの `DD-` にまとめた。項目の本文で方法ごとに分けて書く
- `news-images.ts` の3つは検索（`src/features/search/services/search.service.ts`、範囲外）も使う。公開の一覧・詳細（`src/features/news/services/public.ts`）は 2026-10-26 から署名しない。公開側の詳細設計は、この頁の `DD-NEWS-067`・`068` を参照し、同じ単位に別の `DD-` を作らない
- 単位にならない物: `src/types/news.ts`（型だけ）、`src/app/actions/news.ts` の `export type NewsArticle`（型だけ）、窓口の中の `logNewsAudit`（`getRequestUserAgent` は 2026-10-28 に共有の `getAuditRequestContext` へ替えて消した）と `news-images.ts` の `normalizeObjectPath`・`createSignedUrlByPath`（export しない関数。それぞれの項目に含める）

## 管理の窓口に共通の動き

`DD-NEWS-064`・`065` の全部の方法が、最初に `authorizeAdminPermission(<権限>, request)` を呼び、`ok` でなければその応答をそのまま返す。

| 条件 | 応答 |
| --- | --- |
| token の検証に失敗 | 401 `{error:'Unauthorized'}` |
| session の生存を確かめられない | 503 `{error:'Service temporarily unavailable'}`、`Retry-After: 30` |
| session が有効でない | 401 `{error:'Unauthorized'}` |
| DB の ACL に権限が無い | 403 `{error:'Forbidden', permission, role}` |
| `aal` が `aal2` でない | 403 `{error:'Forbidden', reason:'MFA required', permission, role}` |
| 認可の中の例外 | 500 `{error:'Internal server error'}` |

- 権限: 読む方法（GET）は `admin.news.read`、変える方法（POST・PUT・PATCH・DELETE）は `admin.news.manage`
- 監査: 窓口のファイルの中の `logNewsAudit` が `logAudit` を呼ぶ。`resource` は `news_article`、`ip` と `user_agent` は共有の `getAuditRequestContext(request)` から取る（`user_agent` は見出し `user-agent`、無い・空なら `null`。`ip` は `getClientIp` の値で、Vercel の見出し、または `CLIENT_IP_HEADER` を立てた配置の `x-real-ip` だけ。`x-forwarded-for` は読まず、取れなければ `null`。SEC-NEWS-016-AC-03、ADR-0462。以前の「IP は残さない」は置き換えた）（`src/app/api/admin/news/route.ts`、`src/app/api/admin/news/[id]/route.ts`）。GET は監査しない
- 失敗の記録: DB・置き場の `error` と例外は、`describeErrorForLog`（`src/lib/logging/safe-error.ts`）で誤りの名前と符号だけにして `console.error` に渡す。`message`・詳細・ヒントは残さない（SEC-NEWS-019。2026-10-26）
- 回数の制限は無い（SEC-NEWS-021）。CSRF は proxy の Origin の検査だけで、窓口は `requireCsrfOrDeny` を呼ばない（ARC-NEWS-004）

## 詳細設計

### DD-NEWS-060 管理の NEWS タブの一覧・公開の切り替え・削除

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-NEWS-003、FLOW-NEWS-002、STATE-NEWS-001 |
| 根拠 | 店長が記事の一覧の上で公開の切り替えと削除まで終えられるよう、一覧・切り替え・削除を1つの部品に置く（SCR-NEWS-003）。消した記事は戻せないので、送る前に確かめのダイアログを挟む（FLOW-NEWS-002）。切り替えは今の状態を反転して送るだけにし、2つの値の行き来を状態遷移（STATE-NEWS-001）とそろえる |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/components/NewsSection.tsx`）、`docs/04_DetailDesign/pages/16_admin.md` |
| 旧番号 | IMPL-ADMIN-003 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「機能要件対応表」の FR-ADMIN-003 の行 |

#### 対応要件

SCR-NEWS-003、FLOW-NEWS-002、STATE-NEWS-001（その上は FR-ADMIN-003、DRV-NEWS-013・014）

#### 入出力

| 向き | 中身 |
| --- | --- |
| 入力 | props なし。`GET /api/admin/news` の応答 `{data: 記事の配列}`（DD-NEWS-064） |
| 出力 | 画面。`PATCH /api/admin/news/<id>` に JSON `{status}`、`DELETE /api/admin/news/<id>`（DD-NEWS-065） |

#### 正常フロー

1. 初めは「読み込み中...」を出し、描いた後に `clientFetch('/api/admin/news')` で一覧を取る（`src/components/NewsSection.tsx`）
2. 1件以上あれば行を並べる: 画像（署名つき URL を `next/image` に渡す）、状態のバッジ（`published` は「公開中」の positive、ほかは「非公開」の neutral）、分類の `TagLabel`（outline）、題、公開日、ボタン（公開中なら「非公開」、ほかは「公開」）・編集（`/admin/news/edit/<id>`）・削除
3. 切り替え: 今が `published` なら `private`、ほかは `published` を JSON で PATCH し、成功したら一覧を全部読み直す
4. 削除: `confirm('この記事を削除してもよろしいですか？')` に同意した時だけ DELETE し、成功したら一覧を読み直す

#### 異常フロー

| 条件 | 動き |
| --- | --- |
| 一覧の応答が OK でない | 本文を JSON で読み（読めなければ `{}`）、記録して例外にし、catch で記録して失敗の印（`loadFailed`）を立てる。一覧が空なら `role="alert"` の「ニュース記事の取得に失敗しました」と「再読み込み」のボタンを出し、「ニュース記事がありません」は出さない（取得の失敗と0件を分ける。SEC-NEWS-020） |
| 一覧の取り出しで例外 | 同上 |
| 応答に `data` が無い | 空の配列にする |
| PATCH が OK でない・例外 | 記録して `alert('ステータスの更新に失敗しました')`。読み直さない |
| 削除の確かめで取り消す | 何も送らない |
| DELETE が OK でない・例外 | 記録して `alert('記事の削除に失敗しました')`。読み直さない |
| 記事の `image_url` が `null`（画像の署名ができない） | 空の `src` を `next/image` に渡さず、`/placeholder.png` を出す。他の行は今のまま（波 3 の Task 2。署名の関数が元の値でなく `null` を返す形に変わる前の受け手の直し） |
| 切り替え・削除の後の読み直しに失敗 | 前の一覧のまま残し、その上に同じ失敗の知らせ（`role="alert"` と「再読み込み」）を出す（変えたのに表示が変わらないことを知らせる） |
| 「再読み込み」を押す | 「読み込み中...」にして取り直す。成功すれば失敗の印を消して一覧を出す |

- 画像の出し方: 行の画像は署名つき URL を `next/image` に渡し、最適化の中継を通す。中継は `next.config.ts` の `remotePatterns` で、本番は自分の Supabase の host 1 つの `sign/**` だけを通し（SEC-NEWS-023、`DD-HOME-004`）、最適化した画像のキャッシュの長さ（`minimumCacheTTL`）は 3600 秒にしている（SEC-NEWS-004 の AC-02、`DD-HOME-004`）。`next.config.ts` は範囲外の共有の設定

#### 状態・永続化

部品の state（`newsItems`・`loading`・`loadFailed`）だけを持つ。保存は窓口が行い、部品は先に表示を変えない（成功の後に読み直す）。

#### 認証認可

部品は権限を確かめず、親（`src/app/admin/page.tsx`、範囲外）が店長の役の時だけ描く。窓口が `admin.news.read`・`admin.news.manage` と aal2 を確かめる。`admin.news.read` だけの人にも切り替えと削除のボタンが出て、押すと窓口の 403 で `alert` になる（推定）。`clientFetch` が書き換えに `x-csrf-token` を付ける。

#### テスト観点

置き場と差し替える物: `tests/unit/components/NewsSection.test.tsx`。`clientFetch`・`confirm`・`alert` を差し替える

- 取り出しの間は「読み込み中...」が出る
- 公開中の行と非公開の行で、バッジの文字・tone とボタンの文字（「非公開」「公開」）が変わる
- 応答が OK でない時（本文が JSON の時と読めない時の両方）は `role="alert"` の「ニュース記事の取得に失敗しました」が出て、「ニュース記事がありません」は出ない
- `clientFetch` が例外を投げた時も同じ失敗の知らせが出る
- 応答に `data` が無い時と、成功して 0 件の時は「ニュース記事がありません」が出て、失敗の知らせは出ない
- 失敗の後に「再読み込み」を押すと取り直し、成功すれば一覧が出て失敗の知らせが消える
- 切り替えの後の読み直しに失敗しても前の一覧は残り、その上に失敗の知らせが出る
- 公開中の行の切り替えで `{status:'private'}`、非公開の行で `{status:'published'}` を PATCH し、成功で一覧を読み直す
- PATCH が OK でない時と例外の時に「ステータスの更新に失敗しました」の `alert` が出る
- 削除の確かめを取り消すと DELETE を送らない
- 削除に同意すると DELETE を送り、成功で一覧を読み直す
- DELETE が OK でない時に「記事の削除に失敗しました」の `alert` が出る
- 編集のボタンの行き先が `/admin/news/edit/<id>`
- 記事の `image_url` が `null` の行は `/placeholder.png` を出し、他の行の画像は今のまま

### DD-NEWS-061 記事の作成・編集のフォーム

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-NEWS-004、SCR-NEWS-005、FLOW-NEWS-002 |
| 根拠 | 作成と編集で欄と画像の決まりを1つにするため、1つのフォームを送り方（POST か PUT）で切り替える（SCR-NEWS-004・005）。窓口と同じ種類・5MB の確かめを送る前にも行い、断られるだけの大きな送信を減らす（SCR-NEWS-004）。保存できたことを文で見せてから一覧へ戻す（FLOW-NEWS-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/news/NewsForm.tsx`） |
| 旧番号 | IMPL-ADMIN-NEWS-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-004 の行 |

#### 対応要件

SCR-NEWS-004、SCR-NEWS-005、FLOW-NEWS-002（その上は FREQ-252-REQ-01〜03、FREQ-515-REQ-01（範囲外）、DRV-NEWS-011・012）

#### 入出力

| 向き | 中身 |
| --- | --- |
| 入力 | props `submitUrl`、`submitMethod`（`'POST'` か `'PUT'`）、`initialValues?`（`NewsFormData`）、`existingImageUrl?`（初めの値 `null`） |
| 出力 | `submitUrl` へ `submitMethod` で multipart（`title`・`category`・`date`・`content`・`detailedContent`・`status`、選んだ時だけ `image`）。成功の後に `/admin?tab=NEWS` へ移る |

#### 正常フロー

1. `submitMethod` が `POST` なら作成、ほかは編集として扱う
2. 初めの値は `initialValues`、無ければ題・概要・本文が空、分類 `COLLECTION`、公開日は端末の今日、状態 `private`。`initialValues` が後から変わるとフォームを上書きする
3. 画像の欄を押す・Enter か Space・ドラッグで選ぶ。種類（JPEG・PNG・WebP・GIF）と 5MB 以下を確かめて持ち、FileReader の data URL で見本を出す
4. 見本があれば見本、無ければ `existingImageUrl` を出す。新しく選んだ時は「<ファイル名> (新規)」、既にある画像は「現在の画像」と書く
5. 分類は `SingleSelect`（dropdown）の `onValueChange`、状態はラジオ（非公開・公開）で受ける
6. 送ると、送る間はボタンを止めて「保存中...」か「更新中...」にする。成功は「保存しました」か「更新しました」を出し、500ms 後に `/admin?tab=NEWS` へ移る
7. キャンセルは `/admin?tab=NEWS` へ移る

#### 異常フロー

| 条件 | 動き |
| --- | --- |
| 選んだ画像の種類が4つの外 | 「画像は JPEG / PNG / WebP / GIF を選択してください」。持っている画像は変えない |
| 選んだ画像が 5MB を超える | 「画像サイズは5MB以下にしてください」。持っている画像は変えない |
| ファイルの選択を空にした・落とした物にファイルが無い | 持っている画像を外し、見本を消す |
| 見本の読み込みに失敗 | 「画像プレビューの読み込みに失敗しました」、見本を消す |
| 読み込みの結果が文字でない | 見本を出さない（文は出さない） |
| 作成で画像を選んでいない | 「画像を添付してください」で送らない（編集は画像なしで送る） |
| 応答が OK でない | 応答の `error` の文、無ければ（JSON で読めない時を含む）作成は「保存に失敗しました」、編集は「更新に失敗しました」 |
| 送る途中の例外 | 「通信エラーが発生しました」 |

- 長さの上限（200・2000・10000 字）はフォームに無く `required` だけなので、超えると窓口の 400 の英語の文 `Invalid request` が出る（推定）
- 成功の後の 500ms の間、送るボタンは元に戻り、もう一度押せる（推定）
- 画像の出し方: 既にある画像（署名つき URL）は `next/image` で最適化の中継を通して出す（選んだ画像の見本は `unoptimized`）。中継の設定は DD-NEWS-060 と同じで、SEC-NEWS-023 と SEC-NEWS-004 の AC-02 に関わる

#### 状態・永続化

欄の値・選んだ画像・見本・送信中・失敗と成功の文を部品の state に持つ。保存は窓口（DD-NEWS-064・065）が行う。

#### 認証認可

部品は権限を確かめない。`clientFetch` が `x-csrf-token` を付け、窓口が `admin.news.manage` と aal2 を確かめる。

#### テスト観点

置き場と差し替える物: `tests/unit/components/NewsForm.test.tsx`。`clientFetch`・`useRouter`・`FileReader` を差し替える

- `initialValues` が無い時は分類 `COLLECTION`・状態「非公開」・公開日が端末の今日になる
- `initialValues` を渡すと欄に入り、後から別の `initialValues` を渡すと上書きされる
- 画像の欄を押す・Enter・Space で file の入力が開き、ほかのキーでは開かない
- ドラッグの間は枠の見た目が変わり、離れると戻る。落とした画像を受ける
- 落とした物にファイルが無い時と、選択を空にした時は画像を外す
- 4つの外の種類・5MB 超の画像で、それぞれの文が出る
- 選んだ画像の見本と「<名前> (新規)」が出る。FileReader の失敗で文が出る。結果が文字でない時は見本が出ない
- 画像を選ばず `existingImageUrl` がある時は「現在の画像」、どちらも無い時は「画像をドラッグ&ドロップ」が出る
- 作成で画像が無いと「画像を添付してください」で送らない
- 作成で画像を付けると POST の multipart に6つの欄と `image` が入る。編集で画像が無いと `image` を入れずに PUT する
- 分類の選択と状態のラジオの値が送られる（FREQ-515-AC-03（範囲外）の形）
- 送る間は「保存中...」（作成）・「更新中...」（編集）でボタンが止まる
- 成功で「保存しました」・「更新しました」が出て、500ms 後に `/admin?tab=NEWS` へ移る
- 応答が OK でない時、`error` があればその文、無い時と JSON で読めない時は作成・編集それぞれの文が出る
- `clientFetch` の例外で「通信エラーが発生しました」が出る
- キャンセルで `/admin?tab=NEWS` へ移る

### DD-NEWS-062 記事の作成のページ

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-NEWS-004 |
| 根拠 | 作成の画面は送り先と送り方が決まっているので、ページは固定の値でフォームを包むだけにし、欄と画像の決まりをフォーム（DD-NEWS-061）の1か所に置く（SCR-NEWS-004） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/news/create/page.tsx`） |
| 旧番号 | IMPL-ADMIN-NEWS-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-004 の行 |

#### 対応要件

SCR-NEWS-004（その上は FR-ADMIN-003、FREQ-252-REQ-02）

#### 入出力

入力なし。出力は `<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />`（`src/app/admin/news/create/page.tsx`）。

#### 正常フロー

`/admin/news/create` を開くとフォームを作成の形で描く。呼び元は NEWS タブの「新規作成」（`src/app/admin/page.tsx`、範囲外）。

#### 異常フロー

分岐は無い。送った後の失敗はフォーム（DD-NEWS-061）が扱う。

#### 状態・永続化

持たない。

#### 認証認可

client のページで、サーバーでも proxy でも画面を守らない。殻は誰でも開け、送った時に窓口が 401・403 で断る（推定）。

#### テスト観点

置き場と差し替える物: `tests/unit/app/admin/news/create-page.test.tsx`

- `NewsForm` に `submitUrl="/api/admin/news"`・`submitMethod="POST"` を渡し、`initialValues` を渡さない

### DD-NEWS-063 記事の編集のページ

| 属性 | 値 |
| --- | --- |
| 上位 | SCR-NEWS-005、FLOW-NEWS-002 |
| 根拠 | 編集の画面は URL の記事の今の値を窓口から読んでフォームに詰め、送り方を PUT にするだけにして、欄の決まりをフォーム（DD-NEWS-061）と共有する（SCR-NEWS-005）。読めない時はフォームを出さずに文を出し、空のフォームで上書きさせない（FLOW-NEWS-002） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/admin/news/edit/[id]/page.tsx`） |
| 旧番号 | IMPL-ADMIN-NEWS-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「実装タスク管理 (ADMIN-01)」の ADMIN-01-004 の行 |

#### 対応要件

SCR-NEWS-005、FLOW-NEWS-002（その上は FR-ADMIN-003、FREQ-252-REQ-02）

#### 入出力

| 向き | 中身 |
| --- | --- |
| 入力 | URL の `id`（`useParams`）、`GET /api/admin/news/<id>` の `{data}`（DD-NEWS-065） |
| 出力 | `<NewsForm submitUrl="/api/admin/news/<id>" submitMethod="PUT" initialValues existingImageUrl>` |

#### 正常フロー

1. 「読み込み中...」を出し、`clientFetch('/api/admin/news/<id>')` で記事を取る
2. `title`・`category`・`published_date`・`content`・`detailed_content`・`status` を `NewsFormData` に詰め、`image_url`（署名つき URL）を既にある画像にする
3. フォームを編集の形で描く

#### 異常フロー

| 条件 | 動き |
| --- | --- |
| URL に `id` が無い | 「記事IDの取得に失敗しました」を赤い文で出す |
| URL の `id` が記事の id の形（`isNewsId`。先頭が 0 でない 18 桁以下の数字）でない（`..%2F..%2F<道>`・`abc`・`0` など） | 窓口へ要求を送らず、フォームも出さず、「記事の読み込みに失敗しました」を赤い文で出す。通った `id` も `encodeURIComponent` を通して道に入れる（SEC-NEWS-012。THR-NEWS-024。2026-10-26） |
| 応答が OK でない | 応答の `error` の文、無ければ（JSON で読めない時を含む）「記事の読み込みに失敗しました」 |
| 取り出しの例外・応答の `data` が無い | 記録して「記事の読み込みに失敗しました」 |
| 読み終えて値が無い | 何も描かない（今の流れでは通らない。食い違いは `docs/05_Quality/reports/trace-matrix.md` の「食い違い」節） |

- `category` は型の断言だけで入れ、5つの値かを確かめない

#### 状態・永続化

読み込み中・失敗の文・初めの値・既にある画像の URL を部品の state に持つ。保存はフォームと窓口が行う。

#### 認証認可

client のページで、画面は守らない。読み出しは窓口が `admin.news.read` と aal2 で守る。読めない人には窓口の `error`（例: `Forbidden`）がそのまま出る。

#### テスト観点

置き場と差し替える物: `tests/unit/app/admin/news/edit-page.test.tsx`。`useParams`・`clientFetch` を差し替える

- 取り出しの間は「読み込み中...」が出る
- `useParams` が `id` を返さない時（`params` が無い時を含む）は「記事IDの取得に失敗しました」が出て、取り出しを呼ばない
- 成功すると、取り出した値と `image_url` を `NewsForm` に渡し、`submitUrl` が `/api/admin/news/<id>`、`submitMethod` が `PUT`
- 応答が OK でない時、`error` があればその文、無い時と JSON で読めない時は「記事の読み込みに失敗しました」が出る
- `clientFetch` の例外と、OK の応答に `data` が無い時に「記事の読み込みに失敗しました」が出る
- `useParams` が記事の id の形でない値（`abc`・`..%2F..%2Fadmin%2Fusers`・`../../admin`・`0`・`007`・19 桁・`12/../13`・`12?x=1`）を返す時は、`clientFetch` を呼ばず、フォームも出さず、「記事の読み込みに失敗しました」が出る
- 18 桁の数字の `id` は取り出しを送る

### DD-NEWS-064 管理の記事の一覧と作成の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-NEWS-002、API-NEWS-003、ARC-NEWS-002、ARC-NEWS-003、ARC-NEWS-004、DATA-NEWS-001、DATA-NEWS-002、DATA-NEWS-004、DATA-NEWS-005、SEC-NEWS-015、SEC-NEWS-016、SEC-NEWS-017、SEC-NEWS-018、SEC-NEWS-020 |
| 根拠 | 非公開を含む一覧と記事の作成は、窓口で `admin.news.read`・`admin.news.manage` と aal2 を確かめ、一覧の読みは利用者の JWT で RLS に通し、書き込みは認可の後に service role で行う（SEC-NEWS-015、ARC-NEWS-002、DATA-NEWS-002、ADR-0026）。求める権限は DB の ACL の `admin.news.read`・`admin.news.manage` で、初めは店長だけが持つ（DATA-NEWS-005）。書き換えの送り元は、窓口に届く前に proxy の Origin の検査が確かめる（ARC-NEWS-004）。作成は表と置き場の両方を変えるので、成功も失敗も監査に残す（SEC-NEWS-016）。表に長さの制約が無いので入口で形を確かめ、画像は申告の種類と 5MB を確かめた上で中身の先頭の印を見て、拡張子を検出した種類から決める（API-NEWS-003、SEC-NEWS-017）。作成の保存が失敗したら、上げた画像を置き場から消して孤児を残さない（SEC-NEWS-018）。一覧の取り出しの失敗は固定の文の 500 にする（SEC-NEWS-020）。置き場は非公開なので、一覧の画像は署名つき URL に置き換えて返す（ARC-NEWS-003、DATA-NEWS-004） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/news/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |
| 旧番号 | IMPL-ADMIN-003、IMPL-ADMIN-NEWS-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「機能要件対応表」の FR-ADMIN-003 の行と、「実装タスク管理 (ADMIN-01)」の ADMIN-01-004 の行 |

#### 対応要件

API-NEWS-002、API-NEWS-003、ARC-NEWS-002、ARC-NEWS-003、ARC-NEWS-004、DATA-NEWS-001・002・004・005、SEC-NEWS-015・016・017・018・020

#### 入出力

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| `GET /api/admin/news` | なし | 200 `{data}`。全部の列、非公開を含む、`published_date` の新しい順、`image_url` は署名つき URL（DD-NEWS-068）。件数の上限とページ分けは無い |
| `POST /api/admin/news` | multipart。`title`（前後の空白を除いて1〜200字）・`category`（COLLECTION・EVENT・COLLABORATION・SUSTAINABILITY・STORE）・`date`（`^\d{4}-\d{2}-\d{2}$`、実在の日付は確かめない）・`content`（1〜2000字）・`detailedContent`（1〜10000字）・`status`（private・published）・`image`（必須） | 201 `{success:true, id}` |

#### 正常フロー（GET）

1. `admin.news.read` で認可する（`src/app/api/admin/news/route.ts`）
2. 利用者の JWT の client（表の読み）と service role の client（署名）を作り、`news_articles` を `select('*')`・`published_date` の降順で読む
3. 行ごとに `signNewsImageFields` で `image_url` を署名つき URL に置き換え、200 で返す

#### 正常フロー（POST）

1. `admin.news.manage` で認可する
2. multipart を読み、zod で6つの欄を確かめる
3. `image` が File で、種類が4つの中、5MB 以下かを確かめ、`prepareNewsImage`（DD-NEWS-071）で中身の先頭の印が申告と同じかを確かめる（置き場に書く前）
4. service role の client を1つ作り（表と置き場の書き込みに使う。ADR-0026）、置き場 `news-images` へ `buildNewsImagePath` の `news/<UTC の YYYY-MM-DD>/<uuid>.<検出した種類の拡張子>` に、`contentType` は検出した種類、`cacheControl:'3600'`・`upsert:false` で上げる
5. 手順 4 と同じ service role の client で、`image_url` に署名前の道を入れて1行を insert し、`id` を取る
6. 監査 `admin.news.create`（success、`resource_id` は新しい `id` の文字、metadata は道・状態・分類）を残し、201 を返す

#### 異常フロー

| 方法 | 条件 | 応答と監査 |
| --- | --- | --- |
| 両方 | 認可に失敗 | 「管理の窓口に共通の動き」の 401・403・503・500 |
| POST | 欄の形が合わない（欄が無い時を含む） | 400 `{error:'Invalid request', details}`（zod の `flatten()`） |
| POST | `image` が File でない | 400 `Image file is required` |
| POST | 種類が4つの外、または中身の先頭の印が申告と違う（HTML を `image/png` と付けた物など。SEC-NEWS-017） | 400 `Unsupported image type`。置き場にも表にも触らず、service role の client も作らない |
| POST | 5MB を超える | 400 `Image size must be 5MB or less` |
| POST | 置き場への書き込みに失敗 | 監査 `admin.news.create.upload_failed`（failure、`resource_id` なし）、500 `Failed to upload image` |
| POST | 表への insert に失敗 | 上げた画像を service role で置き場から消し（`removeNewsImages`）、監査 `admin.news.create.db_insert_failed`（failure、metadata に `imageCleanup`＝`ok`・`failed`）、500 `Failed to save news article`。消すのに失敗しても応答は変わらない（SEC-NEWS-018） |
| POST | insert の結果に `id` が無い | 監査の `resource_id` を `null` にして続ける |
| POST | insert が `data=null`・`error=null` を返す（隠れた不具合。`.single()` は0行で error を返すので実際は起きない、推定） | 先に監査 `admin.news.create`（success、`resource_id` なし）を残し、その後の `data.id` の読みで例外になり 500 `Internal server error` を返す。成功の監査と 500 が食い違う。試験が今の動きを固定している |
| POST | multipart を読めないなどの例外 | 500 `Internal server error`（multipart でない要求も 400 ではなく 500、推定）。画像を上げた後で行がまだ指していない時は、その画像を消す |
| GET | 表の読み出しに失敗 | 500 `Failed to fetch news articles`。記録は誤りの名前と符号だけ（SEC-NEWS-020） |
| GET | 結果が `null` | 空の配列として返す |
| GET | 例外 | 500 `Internal server error` |

#### 状態・永続化

`news_articles` に1行を足す（DATA-NEWS-001）。状態は送られた値をそのまま入れ、作成で `published` にもできる（STATE-NEWS-001）。画像は置き場 `news-images` に足す（DATA-NEWS-004）。監査は `audit_logs`。GET は何も変えない。

#### 認証認可

GET は `admin.news.read`、POST は `admin.news.manage`、どちらも有効な session と aal2。GET の表は利用者の JWT の client で RLS（DATA-NEWS-002）を通し、POST の表と置き場の書き込みは認可の後に service role で行い（ADR-0026）、署名も service role を使う。CSRF は proxy の Origin の検査（ARC-NEWS-004）。

#### テスト観点

置き場と差し替える物: `tests/unit/api/admin/news/route.test.ts`。`authorizeAdminPermission`・`createClient`・`createServiceRoleClient`・`logAudit`・`signNewsImageFields` を差し替える

- POST・GET とも、認可が `ok:false` の時はその応答をそのまま返し、表も置き場も触らない。求める権限が POST は `admin.news.manage`、GET は `admin.news.read`
- POST で欄が1つでも形に合わない時（例: 題が空白だけ・201字、分類が BLOG、日付が `2026/10/24`、状態が draft）は 400 `Invalid request` と `details`
- POST で `image` が無い時と文字の時に 400 `Image file is required`
- POST で `image/svg+xml` の時に 400 `Unsupported image type`
- POST で HTML を `image/png` と申告した時、PNG の中身を `image/jpeg` と申告した時に 400 `Unsupported image type` で、`upload` も `createServiceRoleClient` も呼ばない
- POST で 5MB を1バイト超える時に 400、ちょうど 5MB は通る
- POST で4つの種類それぞれ（本物の先頭の印の見本）の拡張子（jpg・png・webp・gif）の道 `news/<日付>/<uuid>.<拡張子>` で、`upsert:false`・`cacheControl:'3600'`・`contentType` は検出した種類で上げる
- POST で置き場の失敗の時に監査 `admin.news.create.upload_failed` と 500、insert を呼ばない
- POST で insert の失敗の時に監査 `admin.news.create.db_insert_failed`（`imageCleanup:'ok'`）と 500 で、上げた道筋を `news-images` から 1 回だけ `remove` する。`remove` が失敗しても応答は 500 のままで監査は `imageCleanup:'failed'`、記録に誤りの文が出ない。insert が例外を投げた時も上げた画像を `remove` する。成功では `remove` しない
- POST の成功で、insert の `image_url` が署名前の道、監査 `admin.news.create` の `resource_id` が新しい `id` の文字、201 `{success:true, id}`
- POST の insert の結果の `id` が `null` の時、監査の `resource_id` が `null`
- 監査の `user_agent` が、見出し `user-agent` がある時はその値、無い時は `null`
- 監査の `ip` が、信頼する見出し `x-real-ip` の値（試験は `CLIENT_IP_HEADER` を立てる）で、偽の `x-forwarded-for` の値は入らず、見出しが無ければ `null`（SEC-NEWS-016-AC-03）
- POST で `request.formData()` が例外を投げた時に 500 `Internal server error`
- GET の成功で行ごとに `signNewsImageFields` を呼び、`published_date` の降順の指定で読む
- GET で `data` が `null` の時に 200 `{data:[]}`
- GET で表の失敗の時に 500 `Failed to fetch news articles`（記録は名前と符号だけ）、例外の時に 500 `Internal server error`

### DD-NEWS-065 管理の記事1件の読み・更新・切り替え・削除の窓口

| 属性 | 値 |
| --- | --- |
| 上位 | API-NEWS-004、API-NEWS-005、API-NEWS-006、API-NEWS-007、ARC-NEWS-002、ARC-NEWS-003、ARC-NEWS-004、STATE-NEWS-001、DATA-NEWS-001、DATA-NEWS-002、DATA-NEWS-004、DATA-NEWS-005、SEC-NEWS-012、SEC-NEWS-015、SEC-NEWS-016、SEC-NEWS-017、SEC-NEWS-018、SEC-NEWS-020 |
| 根拠 | 編集の画面に非公開の記事の中身を渡す読みと、記事を変える3つの操作は、窓口で権限と aal2 を確かめ、1件の読みは利用者の JWT で RLS に通し、書き込みは認可の後に service role で行う（SEC-NEWS-015、ARC-NEWS-002、DATA-NEWS-002、ADR-0026）。一覧のボタン1つで公開を切り替えられるよう、状態だけを変える PATCH を全体の更新（PUT）と分ける（API-NEWS-006、STATE-NEWS-001）。直すたびに画像を付け直させないよう PUT の画像は任意にする（API-NEWS-005）。変える操作は成功も失敗も監査に残し、誰が何をしたかを追えるようにする。変えた行が0件（無い）の時は成功と偽らず、404 と失敗の監査にする（SEC-NEWS-016）。求める権限は DB の ACL の `admin.news.read`・`admin.news.manage`（DATA-NEWS-005）。書き換えの送り元は、窓口に届く前に proxy の Origin の検査が確かめる（ARC-NEWS-004）。道の `id` は `isNewsId` で確かめ、外れた値を DB に渡さない（SEC-NEWS-012）。1件の読みは「無い」（404）と「DB の失敗」（500）を分ける（SEC-NEWS-020）。画像は中身の先頭の印を確かめ、PUT は上げる前に古い `image_url` を読み、使わなくなった画像を行を変えた後に置き場から消す。行の削除と置き場の削除は同じ service role の client で行う（SEC-NEWS-017・018、ADR-0025、ADR-0026） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/api/admin/news/[id]/route.ts`）、`docs/03_BasicDesign/api/api-spec.md` |
| 旧番号 | IMPL-ADMIN-003、IMPL-ADMIN-NEWS-01 |
| 旧所在 | `docs/04_DetailDesign/pages/16_admin.md` の「機能要件対応表」の FR-ADMIN-003 の行と、「実装タスク管理 (ADMIN-01)」の ADMIN-01-004 の行 |

#### 対応要件

API-NEWS-004〜007、ARC-NEWS-002、ARC-NEWS-003、ARC-NEWS-004、STATE-NEWS-001、DATA-NEWS-001・002・004・005、SEC-NEWS-012・015・016・017・018・020

#### 入出力

| 方法 | 入力 | 出力 |
| --- | --- | --- |
| `GET /api/admin/news/<id>` | 道の `id`（`isNewsId`） | 200 `{data}`。全部の列、`image_url` は署名つき URL。無い記事・形の悪い id は 404、DB の失敗は 500 |
| `PUT /api/admin/news/<id>` | 道の `id`（`isNewsId`）、multipart（作成と同じ6つの欄、`image` は任意） | 200 `{success:true}`。無い記事・形の悪い id は 404 |
| `PATCH /api/admin/news/<id>` | 道の `id`（同上）、JSON `{status}`（private・published） | 200 `{success:true}`。無い記事・形の悪い id は 404 |
| `DELETE /api/admin/news/<id>` | 道の `id`（同上）、本文なし | 200 `{success:true}`。無い記事・形の悪い id は 404 |

#### 正常フロー

- GET: 道の `id` を読み、`admin.news.read` で認可し、`isNewsId` で確かめ（外れていれば DB を呼ばず 404）、`select('*').eq('id', id).maybeSingle()` で1行を読み、`signNewsImageFields` で署名して返す（`src/app/api/admin/news/[id]/route.ts`）
- PUT: `admin.news.manage` で認可し、`id` の形（`isNewsId`）を確かめ、外れていれば DB にも置き場にも触らず 404 にする。zod で欄を確かめる。`image` が File なら種類と 5MB を確かめ、`prepareNewsImage` で中身の先頭の印を確かめ（違えば 400）、service role の client で `select('image_url').eq('id', id).maybeSingle()` により古い `image_url` を読み（無ければ 404 で何も上げない）、`buildNewsImagePath` の `news/<UTC の日付>/<uuid>.<検出した種類の拡張子>` に同じ client で上げる。6つの欄と、上げた時だけ `image_url` を `update().eq('id', id).select('id')` で書き、1行以上が返れば古い画像を `removeNewsImages(…, [古い image_url], [新しい道筋])` で消し、監査 `admin.news.update`（画像を替えた時は metadata に `imageCleanup`）を残す
- PATCH: `admin.news.manage` で認可し、`id` の形を確かめ（外れていれば 404）、JSON を zod で確かめ、`status` だけを `update().eq('id', id).select('id')` で書き、1行以上が返れば監査 `admin.news.status_update` を残す。前の状態は読まない
- DELETE: `admin.news.manage` で認可し、`id` の形を確かめ（外れていれば 404）、`delete().eq('id', id).select('id, image_url')` で行を消し、1行以上が返れば同じ service role の client で消した行の `image_url` を `removeNewsImages` で消し（消すのに失敗しても例外にせず `failed`）、監査 `admin.news.delete`（metadata に `imageCleanup`）を残す

#### 異常フロー

| 方法 | 条件 | 応答と監査 |
| --- | --- | --- |
| 全部 | 認可に失敗 | 「管理の窓口に共通の動き」の 401・403・503・500 |
| GET | 行が無い | 404 `Article not found` |
| GET | 読み出しの `error` | 500 `Failed to fetch news article`。記録は誤りの名前と符号だけ（SEC-NEWS-020） |
| GET | `id` が `isNewsId` でない | 404 `Article not found`。DB も service role の client も呼ばない（SEC-NEWS-012） |
| PUT | 欄の形が合わない | 400 `{error:'Invalid request', details}` |
| PUT | 画像の種類が4つの外、または中身の先頭の印が申告と違う | 400 `Unsupported image type`。古い値の読みも置き場も更新もしない（SEC-NEWS-017） |
| PUT | 画像ありで古い値の読みが失敗 | 監査 `admin.news.update.failed`（failure）、500 `Failed to update news article`。何も上げない |
| PUT | 画像ありで記事が無い（古い値の読みが `null`） | 404 `Article not found`、監査 `admin.news.update.not_found`。何も上げない（SEC-NEWS-018） |
| PUT | 画像が 5MB を超える | 400 `Image size must be 5MB or less` |
| PUT | 置き場への書き込みに失敗 | 監査 `admin.news.update.upload_failed`（failure）、500 `Failed to upload image` |
| PUT | 表の更新に失敗 | その要求で上げた新しい画像を置き場から消す（古い画像は消さない）。監査 `admin.news.update.failed`（failure）、500 `Failed to update news article` |
| PATCH | 本文を JSON として読めない | catch で 500 `Internal server error`（400 ではない） |
| PATCH | 値が private・published でない | 400 `{error:'Invalid request', details}` |
| PATCH | 表の更新に失敗 | 監査 `admin.news.status_update.failed`（failure）、500 `Failed to update status` |
| DELETE | 表の削除に失敗 | 監査 `admin.news.delete.failed`（failure）、500 `Failed to delete article`。置き場は消さない |
| DELETE | service role の client を作れない（行を消す前に作るので、行にも置き場にも触らない） | 500 `Internal server error`。監査なし |
| DELETE | 行を消した後に置き場の削除が失敗 | 200 `{success:true}` のまま。監査 `admin.news.delete` の metadata に `imageCleanup:'failed'`。記録は名前と符号だけ |
| PUT・PATCH・DELETE | 対象の行が0件 | 404 `{error:'Article not found'}`。監査は失敗 `admin.news.update.not_found`・`admin.news.status_update.not_found`・`admin.news.delete.not_found`（`detail='News article not found'`、`metadata.articleId`）で、成功の監査は書かない（SEC-NEWS-016）。画像ありの PUT が更新の 0 行だった時は、その要求で上げた画像を消す（SEC-NEWS-018） |
| PUT・PATCH・DELETE | `id` が `isNewsId`（先頭が 0 でない 18桁以下の数字）でない | 404 `Article not found`。DB にも置き場にも触らない。監査は同じ `.not_found` の失敗で、`resource_id` は `null`、`metadata` は生の id でなく長さ `articleIdLength` だけ |
| 全部 | 例外（multipart を読めない時を含む） | 500 `Internal server error` |

- PUT の拡張子は作成と同じく検出した種類の対応表から作り、送られたファイル名は使わない。名前が `x.html` の PNG は `.png` の道になる（SEC-NEWS-017）
- 新旧の画像が同じ道筋なら消さない。古い画像が見本・外の URL・`news/` の外の道筋なら消さない（`isOwnNewsImagePath`）。置き場の削除の失敗は応答を失敗にしない（SEC-NEWS-018）

#### 状態・永続化

PUT は記事の行の6つの列（画像を上げた時は `image_url` も）、PATCH は `status`、DELETE は行そのものを変える（DATA-NEWS-001、STATE-NEWS-001）。`updated_at` は表のトリガーが変える。削除は物理削除で戻せない。画像は置き場に足し、使わなくなった画像（差し替え前・削除した行の物・失敗した要求で上げた物）は行を変えた後に消す（DATA-NEWS-004）。監査は `audit_logs` に `resource_id` を記事の `id` で残す。

#### 認証認可

GET は `admin.news.read`、PUT・PATCH・DELETE は `admin.news.manage`、どれも有効な session と aal2。GET の表は利用者の JWT の client（RLS）、書き込み（表と置き場）・後始末の削除・署名は service role（ADR-0026。書き込みの 0 行は「その id の記事が無い」だけを表し 404 で返る）。CSRF は proxy の Origin の検査（ARC-NEWS-004）。

#### テスト観点

置き場と差し替える物: `tests/unit/api/admin/news/id-route.test.ts`。差し替える物は DD-NEWS-064 と同じ

- 4つの方法とも、認可が `ok:false` の時はその応答を返し、表を触らない。求める権限が GET は `admin.news.read`、ほかは `admin.news.manage`
- GET で `error` がある時は 500 `Failed to fetch news article`（記録に誤りの文が出ない）、行が無い時は 404 `Article not found`。`abc`・`0`・`007`・19 桁・負・小数の `id` は DB も service role の client も呼ばず 404
- GET の成功で `eq('id', <道の id>)` で読み、`signNewsImageFields` の結果を返す
- GET で `params` が例外を投げた時に 500
- PUT で欄の形が合わない時に 400
- PUT で `image` が無い時は置き場を呼ばず、更新に `image_url` を入れない
- PUT で種類が4つの外の時と 5MB 超の時にそれぞれ 400。HTML を `image/png` と申告した画像も 400 で、古い値の読みも上げも更新もしない
- PUT で名前が `x.html`・`photo.final.PNG`・`noextension`・`a.exe` の画像は、送られた名前でなく検出した種類（png・jpg・webp・gif）の拡張子の道で上げ、更新に `image_url` を入れる
- PUT で画像あり・記事なし（古い値の読みが `null`）は 404 で `upload` を呼ばない。古い値の読みの失敗は 500 で何も上げない。画像なしの PUT は古い値を読まず `remove` も呼ばない
- PUT で更新が成功したら古い道筋を service role の `remove` で 1 回消し（新しい道筋は消さない）、監査の metadata に `imageCleanup`。`remove` の失敗は 200 のままで `failed`。古い値が `null`・外の URL・古い見本の道筋なら何も消さない
- PUT で更新が `error` の時・0 行の時・例外の時は、その要求で上げた新しい道筋を `remove` する（古い画像は消さない）
- PUT で置き場の失敗の時に監査 `admin.news.update.upload_failed`（`resource_id` が `id`）と 500
- PUT で表の失敗の時に監査 `admin.news.update.failed` と 500
- PUT の成功で監査 `admin.news.update` と 200
- PUT で `request.formData()` が例外を投げた時に 500
- PATCH で本文が JSON でない時に 500、値が draft の時に 400
- PATCH で表の失敗の時に監査 `admin.news.status_update.failed` と 500、成功で監査 `admin.news.status_update` と 200
- DELETE で表の失敗の時に監査 `admin.news.delete.failed` と 500（`remove` も `createServiceRoleClient` も呼ばない）、成功で監査 `admin.news.delete`（`imageCleanup:'ok'`）と 200
- DELETE の成功で消した行の `image_url` を service role の client で `remove` し、利用者の session の client は作らず `storage` も呼ばない。`remove` の失敗でも 200 で `imageCleanup:'failed'`。見本・外の URL・`null` の行は何も消さない
- DELETE で `createServiceRoleClient` が例外を投げた時に 500（行も置き場も触らず、監査も書かない）
- 監査の `user_agent` が、見出しがある時はその値、無い時は `null`
- 監査の `ip` が、信頼する見出し `x-real-ip` の値で、偽の `x-forwarded-for` の値は入らず、見出しが無ければ `null`（SEC-NEWS-016-AC-03）
- 対象の行が0件の PUT・PATCH・DELETE が 404 になり、失敗の監査（`.not_found`）が 1 件だけで成功の監査が 0 件であること。1 行が返れば 200 と成功の監査
- `id` が数字でない・19桁以上・負・小数・空・`0`・`007` の PUT・PATCH・DELETE が、表も置き場も触らず 404 になり、監査の `metadata` が長さだけであること。18桁ちょうどは DB に渡る

### DD-NEWS-066 最新の公開済みの記事3件の Server Action — 未使用（削除の判断待ち）

| 属性 | 値 |
| --- | --- |
| 上位 | API-NEWS-008、SEC-NEWS-001 |
| 根拠 | 未使用（削除の判断待ち）の関数。ホームに最新の公開済みの記事を3件出すために作られた取り出し（`src/app/actions/news.ts` のコメント、API-NEWS-008）。公開済みだけに絞る条件は呼ぶ先の `getPublishedNews` に任せて自分では書かず、絞りの決まりを公開の取り出しの1か所に残す（SEC-NEWS-001） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/app/actions/news.ts`） |

#### 対応要件

API-NEWS-008、SEC-NEWS-001

#### 入出力

入力なし。出力は公開済みの記事（`PublicNewsArticle`）の配列で、最大3件、公開日の新しい順（`src/app/actions/news.ts`）。

#### 正常フロー

`getPublishedNews({limit:3})`（`src/features/news/services/public.ts`）の結果をそのまま返す。

#### 異常フロー

自分では分岐しない。DB の失敗は呼ぶ先が空の配列にする（ARC-NEWS-001）。呼ぶ先の例外はそのまま投げる。

#### 状態・永続化

何も変えない。

#### 認証認可

認可は無い。`'use server'` のファイルで export しているので、呼ぶ所が無くても外から POST で呼べる窓口になる（推定）。返すのは公開済みだけ（anon の client と `status='published'`）。どこからも import されていない（`src`・`tests`・`e2e`）。使われない Server Action を残さない SEC-NEWS-009。

#### テスト観点

置き場と差し替える物: `tests/unit/app/actions/news.test.ts`。`getPublishedNews` を差し替える

- `getPublishedNews` を `{limit:3}` で1回呼び、その結果をそのまま返す

### DD-NEWS-067 画像の値から置き場の中の道を取り出す

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-NEWS-003、DATA-NEWS-004 |
| 根拠 | 表の `image_url` には保存の道のほか、置き場を公開にしていた頃の public の URL や署名つき URL の形が残りうるので、どの形からも置き場 `news-images` の中の道を取り出してから署名する（ARC-NEWS-003、DATA-NEWS-004）。取り出せない値は `null` にして、署名する物と分ける |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/lib/storage/news-images.ts`） |

#### 対応要件

ARC-NEWS-003、DATA-NEWS-004

#### 入出力

入力は `rawUrl: string | null | undefined`。出力は置き場の中の道（`string`）か `null`。

#### 正常フロー

1. 前後の空白を除く（`src/lib/storage/news-images.ts`）
2. `http://`・`https://` で始まらなければ道とみなし、先頭の `/` を全部と、先頭の `news-images/` を外して返す
3. URL なら、道の部分で `/storage/v1/object/public/news-images/`・`/sign/news-images/`・`/authenticated/news-images/` の印を順に探し、最初に合った印の後ろを decode して2と同じに整えて返す

#### 異常フロー

| 条件 | 戻り値 |
| --- | --- |
| 文字でない・空・空白だけ | `null` |
| 印の後ろが空 | `null` |
| URL として読めない・decode できない | `null` |
| どの印にも合わない URL（外のホストを含む） | `null` |

- ホストが自分の Supabase のプロジェクトか、道が `news/` の下か、`..` を含むかは、この関数では確かめない。署名の前の確かめは `signNewsImageUrl` が共有の `parseOwnObjectPath` で行う（DD-NEWS-068、SEC-NEWS-007）。この関数は管理の後始末（`removeNewsImages`、DD-NEWS-071）が使い、後始末の側が `isOwnNewsImagePath` で絞る
- URL の検索の部分（署名つき URL の `token`）は捨て、道だけを返す

#### 状態・永続化

持たない（文字の変換だけ）。

#### 認証認可

無い。

#### テスト観点

置き場と差し替える物: `tests/unit/lib/storage/news-images.test.ts`

- `null`・`undefined`・数・空の文字・空白だけで `null`
- `news/2026-04-26/a.jpg` はそのまま、`/news-images/news/a.jpg` と `//news/a.jpg` は `news/a.jpg`、前後の空白は除く
- public・sign（`?token=` 付き）・authenticated の URL から `news/a.jpg` を取り出す
- 道の中の `%20` などを decode する
- 印の後ろが空の URL で `null`
- `http://` だけ（URL として読めない）と、`%E0%A4%A` を含む URL（decode できない）で `null`
- 印の無い外の URL で `null`

### DD-NEWS-068 画像の値を署名つき URL に置き換える

| 属性 | 値 |
| --- | --- |
| 上位 | ARC-NEWS-003、DATA-NEWS-004、SEC-NEWS-004、SEC-NEWS-007、SEC-NEWS-008 |
| 根拠 | 置き場を非公開のまま画像を見せるため、読むたびに service role で期限1時間の署名つき URL に置き換え、非公開にした後に画像を開ける時間を期限で区切る（ARC-NEWS-003、DATA-NEWS-004、SEC-NEWS-004）。署名は service role で行い置き場の方針が効かないので、署名の前に共有の `parseOwnObjectPath` で自分の置き場の `news/` の下の安全な道筋かを確かめ、確かめに通らない値と署名の失敗は `null` にして元の値を呼び元へ渡さない（SEC-NEWS-007・008、ADR-0316）。行の置き換えを1つの関数にまとめ、管理・公開・検索の全部で同じ取り出しと期限を使う。検索の関数 `search_news` が返す記事の `image_url` も、検索の側（範囲外）がこの関数で署名してから返す |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装から推定（`src/lib/storage/news-images.ts`） |

#### 対応要件

ARC-NEWS-003、DATA-NEWS-004、SEC-NEWS-004（AC-01 の期限1時間以下）、SEC-NEWS-007、SEC-NEWS-008

#### 入出力

| 関数 | 入力 | 出力 |
| --- | --- | --- |
| `signNewsImageUrl` | Supabase の client（service role）、`rawUrl: string \| null \| undefined`、`expiresIn`（初めの値 3600 秒） | 署名つき URL、または `null` |
| `signNewsImageFields` | Supabase の client、`image_url` を持つ行 | 行の写しで、`image_url` を `signNewsImageUrl` の結果（署名つき URL か `null`）に置き換えた物（ほかの列はそのまま） |

#### 正常フロー

1. `rawUrl` から、共有の `parseOwnObjectPath(rawUrl, { bucket: 'news-images', prefix: 'news' })`（DD-SEARCH-011）で置き場の中の道を取り出す（`src/lib/storage/news-images.ts`）。自分のプロジェクトの origin 1 つの URL か素の道筋で、`news/` の下の安全な文字の時だけ道になる
2. 置き場 `news-images` で `createSignedUrl(道, expiresIn)` を呼び、`signedUrl` を返す
3. `signNewsImageFields` は行の `image_url`（無ければ `null`）を1と2で置き換えた写しを返す

#### 異常フロー

| 条件 | 戻り値 |
| --- | --- |
| `rawUrl` が空・`null`・`undefined` | `null` |
| 道にできない（外のホスト・別の置き場・`news/` の外・`..`・空白・壊れた `%` など） | `null`（署名を呼ばない。`[news-images] invalid_path` だけ記録する） |
| 署名の `error` がある・`signedUrl` が無い | `null`（`[news-images] sign_failed` だけ記録する） |
| `createSignedUrl` が例外を投げる | 例外をそのまま投げる（呼び元の窓口では 500） |

- 失敗の時は元の値を返さず `null` にし、失敗の種類だけを記録する。道筋・URL・Supabase の誤りの文は記録しない（SEC-NEWS-007・008。2026-10-28）。管理の画面は `null` の記事を `/placeholder.png` で描く（`NewsSection`）
- 出した署名つき URL は、記事を非公開にしても期限まで開ける（STATE-NEWS-001）

#### 状態・永続化

表も置き場も変えない。署名は Supabase の Storage が作る。

#### 認証認可

呼び元が渡す client の権限で署名する。管理・公開・検索は service role の client を渡すので RLS は効かず、署名してよいかは呼び元が先に RLS か `status` で行を絞ったことに頼る。

#### テスト観点

置き場と差し替える物: `tests/unit/lib/storage/news-images.test.ts`。client の `storage.from().createSignedUrl` を差し替える

- 道から期限 3600 秒の署名つき URL を作る（`expiresIn` を渡さない時）
- `expiresIn` を渡すとその値で署名する
- `null`・`undefined`・空の文字で `null`、署名を呼ばない
- 道にできない値（外のホスト・別の置き場・`news/` の外・`..`・二重の `/`・空白）で `null`、署名を呼ばない
- 自分のプロジェクトの public の URL（本番の形）は道に直して署名する
- 署名の `error` がある時と、`data` に `signedUrl` が無い時に `null`（元の値を返さない）
- 失敗の記録が `[news-images] invalid_path`・`[news-images] sign_failed` の固定の語だけで、道筋・URL・誤りの文を含まない
- `createSignedUrl` が例外を投げると、その例外が出る
- `signNewsImageFields` が `image_url` だけを置き換え、ほかの列を残す
- `signNewsImageFields` で `image_url` が無い行は `image_url: null` になり、署名を呼ばない
- `signNewsImageFields` で外の URL・署名の失敗の行は `image_url: null` になり、ほかの列は残る

### DD-NEWS-071 管理のニュースの画像の確かめ・保存名・後始末 admin-images

| 属性 | 値 |
| --- | --- |
| 上位 | API-NEWS-003、API-NEWS-005、API-NEWS-007、ARC-NEWS-003、SEC-NEWS-017、SEC-NEWS-018 |
| 根拠 | 置き場は service role で書くので、申告の種類を鵜呑みにせず、保存名も送られた名前から作らず、後始末で消す道筋は自分の置き場の自分の接頭辞の下だけにする（SEC-NEWS-017・018）。作成・更新・削除の3つの窓口で同じ決まりにそろえるため、窓口の外の1か所にまとめる（ADR-0025） |
| 状態 | 推定 |
| 確かめ方 | 単体テスト |
| 出どころ | 実装（`src/features/news/services/admin-images.ts`）。波 1-C の計画（Task 7） |

#### 対応要件

SEC-NEWS-017・018。

#### 入出力

| 関数 | 入力 | 出力 |
| --- | --- | --- |
| `prepareNewsImage` | `File` | `{buffer, contentType, extension}`。申告の type と中身の先頭の印が同じ時だけ。違えば `null` |
| `buildNewsImagePath` | 拡張子、時刻（試験用） | `news/<UTC の日付>/<uuid>.<拡張子>` |
| `isOwnNewsImagePath` | 道筋の文字 | `news/` の下の安全な文字（先頭は英数字、続きは英数字と `._-`、区切りは1つの `/`）だけなら true |
| `removeNewsImages` | service role の client、行の `image_url` の配列（古い公開 URL の形も可・`null` も可）、残す道筋 | `'ok'` か `'failed'`。消す物が無ければ置き場を呼ばず `'ok'`。投げない |

- 先頭の印の判定は共有の `src/lib/storage/image-signature.ts`（JPEG・PNG・GIF・WebP）。置き場の名前は `news-images`
- 値を道筋に直すのは `extractNewsImageObjectPath`（`src/lib/storage/news-images.ts`。DD-NEWS-067。呼ぶだけ）

#### 正常フロー

1. 窓口が `prepareNewsImage` で偽の画像を弾く（置き場に書く前）
2. 窓口が `buildNewsImagePath(prepared.extension)` で保存名を作って上げる
3. 行を変えた後に、窓口が `removeNewsImages` で使わなくなった画像を消す。道筋に直し、`isOwnNewsImagePath` を通り、`keep` に無く、重複しない物だけを 1 回の `remove` に渡す

#### 異常フロー

| 場合 | 動き | 道 |
| --- | --- | --- |
| 申告と検出が違う・印が無い | `prepareNewsImage` が `null`（窓口が 400） | `admin-images.ts` |
| `..`・先頭の `/`・`//`・別の接頭辞・URL・空白・`%` を含む道筋 | 消す対象にしない | `admin-images.ts` |
| 古い見本の道筋（`e2e/news-1.png` など。接頭辞が違う。波 2 で見本は `news/e2e/` に移った。この行は移行前の形の確認） | 消さない側に倒れる | `admin-images.ts` |
| 別の置き場の URL | 道筋にできないので消さない | `admin-images.ts` |
| 置き場の削除が `error`・例外 | 名前と符号だけ記録して `'failed'`。投げない | `admin-images.ts` |

- `isOwnNewsImagePath` は 2026-10-28 から共有の `isSafeObjectPath(path, 'news')`（`src/lib/storage/safe-object-path.ts`、DD-SEARCH-011）に委譲する。式は同じで動きは変わらない（判断は ADR-0025、ADR-0316）

#### 状態・永続化

なし（置き場の削除は呼び手の窓口が行い、結果を監査に残す）。

#### 認証認可

なし。呼び元の窓口が認可の後に使う。

#### テスト観点

置き場と差し替える物: `tests/unit/features/news/services/admin-images.test.ts`。client の `storage.from().remove` を差し替える

| # | 観点 | 入力 | 期待 |
| --- | --- | --- | --- |
| 1 | 本物の PNG | 名前 `x.html`、`image/png` | `png`、名前を使わない |
| 2 | 偽の画像 | 文字を `image/png`、PNG を `image/jpeg` | `null` |
| 3 | 保存名 | 固定の時刻 | `news/2026-10-26/<uuid>.png`。呼ぶ度に違う |
| 4 | 自分の道筋 | `news/…` の形、`../`・`//`・`looks/`・URL・`e2e/…`・`%2e%2e`・空文字 | 真は `news/` の下だけ |
| 5 | 消す道筋の選び方 | 見本・`null`・`keep`・重複・古い公開 URL・別の置き場の URL・外の URL・`..` | 自分の道筋だけ、重複なし、`keep` なし、古い URL は置き場の中の道筋に直る。消す物が無ければ置き場を呼ばない |
| 6 | 置き場の削除 | 成功・`error`・例外 | 失敗は `'failed'` で投げず、記録は名前と符号だけ |

## 未確認事項

- 本番の置き場 `news-images` の公開の設定と `storage.objects` の方針（移行に無い。DATA-NEWS-004）
- 管理の作成・編集のページ（`/admin/news/create`・`/admin/news/edit/[id]`）にサーバーの守りを置くか
- 対象0件の PUT・PATCH・DELETE（SEC-NEWS-016）、置き場の画像の後始末と PUT の拡張子の取り方（SEC-NEWS-017・018）は 2026-10-26 に直した。本番に既に残っている孤児の画像の掃除は別の運用作業
- `getLatestNews` を消すか残すか（SEC-NEWS-009、API-NEWS-008）
- 各項目の「テスト観点」のテストのファイルの多くはまだ無い。分岐を全部通せるかは、書いて `npm run test:trace-coverage` で確かめていない
- この頁の項目は全部「推定」。ユーザーの確認を受けたら「現行」にする
