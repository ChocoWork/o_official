# 要求からコード・テストまでのトレーサビリティの設計

> 状態: 設計（承認待ち） | 作成日: 2026-10-24 | 対象: `docs/`、`src/`、`tests/`、`e2e/`、`scripts/`、`.claude/skills/documentation-guide/`、`.claude/CLAUDE.md`

## 概要

要求から始まる全部の文書・コード・テストについて、「どの要求から来たか」「なぜそうなっているか」「どこで確かめているか」がたどれる状態を作る。土台は航空機ソフトの基準 DO-178C の最も厳しい水準（DAL A）とし、ほかの基準でさらに厳しい点を足す。

最初は、開店までの残り作業（G・H・会計・直し・開店の準備）が触らない領域だけで行う。並行して進んでいる G-1 の作業には影響を出さない。

| 項目 | 決めたこと |
| --- | --- |
| 目的 | 調査で抜け漏れを出さない・二重の実装をしない・セキュリティの穴を作らない（ユーザー） |
| つなぎ方 | 下の段が上の段の ID を書く。逆の向きはスクリプトが作る |
| コード | まとまった単位ごとに TSDoc で `@impl`（実装 ID）と `@design`（詳細設計 ID）と「なぜ」を書く（ユーザー） |
| テスト | E2E → 受け入れ条件、結合 → 構造設計、単体 → 詳細設計（ユーザー） |
| テストの穴 | つないだ時に無ければ、その場で書き足す（ユーザー） |
| 使われていないコード | 消さずに一覧表にまとめ、後でユーザーが判断する（ユーザー） |
| 文書の書式 | 業界の定番に合わせて統一し、書き直してよい。書式は `documentation-guide` スキルを正本にし、CLAUDE.md から指す（ユーザー） |
| 要件の置き場 | 領域ごとのファイル `docs/02_Requirements/areas/<area>.md`。`requirements.md` は G-1 が落ち着いてから目次にする（ユーザー） |

---

## 1. 目的と背景

ユーザーが答えられるようにしたい問いの例（ユーザーの言葉）:

- このコードはどの仕様と紐づいているか
- この実装はなぜこのアーキテクチャになっているか
- この実装の影響範囲はどこか
- この詳細設計・構造設計に紐づくテストはどれか

ゴール（ユーザーの言葉）: 要求仕様・アーキテクチャ設計・画面設計・画面遷移・状態遷移・詳細設計・API 設計・単体テスト・結合テスト・実装・その他の文書の内容が、どこの要求から来て、なぜそうなっているかの根拠がすべて分かること。

今の状態（2026-10-24 に調べた結果）:

| 段 | 穴 |
| --- | --- |
| 要件 `requirements.md`（525 行） | 同じ FREQ 番号の重複が5つ。書式の違う受け入れ条件 ID（`FREQ-AC-01-01-01`）が1つ |
| 設計 | 要件 ID 1536 個のうち、設計から参照されるのは 161 個 |
| 過去の仕様（`docs/superpowers/specs` 37本・`plans` 38本） | 決めた内容が要件・設計に戻っていない |
| 実装 `src/` | 要件・設計の ID がどこにもない |
| 一覧表 `traceability-report.md` | ID の文字の出現を数えるだけ（`scripts/generate-coverage-report.js`） |

## 2. 目標・しないこと・失敗とみなすこと

**目標**

1. 範囲内の全部の項目（要求〜テスト）が ID を持ち、上下どちらにもたどれる
2. 範囲内の全部のコードのまとまりが `@impl` を持ち、どの要求にもつながらないコードが一覧に出る
3. 範囲内の全部の要件・設計・テストに「根拠（なぜ）」が書かれている
4. セキュリティ要件は脅威から来ていて、設計とテストまでつながっている
5. 切れ・重複・存在しない ID への参照を、スクリプトが検査で止める
6. 1つの ID を渡すと、上（要求まで）と下（テストまで）を出すコマンドがある
7. 今後の文書が同じ書式になる仕組み（スキル＋CLAUDE.md）がある

**しないこと**

- 範囲外（3章）のコード・文書・テストには手を入れない
- 使われていないコードは消さない（一覧に載せるだけ）
- 新しい要件管理ツール（Doorstop・Sphinx-Needs など）は入れない。Markdown と Node のスクリプトのまま
- 動きを変える直しはしない。直すべき不具合や穴を見つけたら、一覧に載せて報告する（台帳に足すかはユーザーが決める）

**失敗とみなすこと**

- G-1 など並行の作業のファイルに手が入る・そのコミットに混ざる
- コメントを足したことで、ソースを文字として読む試験が落ちる
- 形だけの ID（上の段と中身が食い違う、根拠が「仕様のため」だけ）
- 実装から推定した内容を、確かめた事実のように書く

## 3. 範囲

### 3-1 手を付ける領域

開店までの残り作業が触らない領域（2026-10-24 の調査）。

| 領域 | 画面・API | コード | E2E |
| --- | --- | --- | --- |
| HOME | `app/page.tsx` | `features/home` | FR-HOME（19） |
| NEWS | `app/news/**`、`api/news`、`api/admin/news`、管理のニュース | `features/news`、`components/NewsSection`、`lib/news-data` | FR-NEWS-ALL（18）・FR-NEWS-DETAIL（8） |
| LOOK | `app/look/**`、`api/admin/looks`、管理のルック（`LookForm.tsx` を除く） | `features/look`、`lib/look`、`components/LookSection` | FR-LOOK-ALL（40）・FR-LOOK-DETAIL（18） |
| ABOUT | `app/about` | — | FR-ABOUT（8） |
| STOCKIST | `app/stockist`、`api/admin/stockists`、管理の取扱店 | `features/stockist`、`components/StockistSection` | FR-STOCKIST（10） |
| SEARCH | `app/search`、`api/search`、`api/suggest` | `features/search` | FR-SEARCH（17） |
| LOGIN・AUTH | `app/login`、`app/auth`、`api/auth`、`api/profile` | `components/{Header,LoginModal,RegisterModal,AuthTabs,AuthResultScreen}` | FR-LOGIN（25）・FR-HEADER（8） |
| PRIVACY | `app/privacy` | — | FR-PRIVACY（4） |
| 管理のそのほか | `api/admin/{users,create-user,revoke-user-sessions,audit-logs,legal-archive,contact,item-color-presets}`、`app/admin/create-user` | `lib/{meta,storage,contact}`、`lib` 直下の小物（`auditCleanup`・`hash`・`mask-email`・`pwned-password`・`redirect`・`social`・`turnstile`・`utils` など） | 該当する FR-ADMIN（G-1 の Task 18 の 90 本を除く） |

### 3-2 手を付けない所

- G（注文・在庫・返金・返品・発送）、H（決済・カート・割引）、会計（KPI・帳簿）、直しの残り（お問い合わせの画面・お気に入り・フッター・`SingleSelect`・`Card` など）が触るコード
- 両方の側が使う共有部品: `lib/auth/*`、`lib/csrf*`、`features/auth/**`（回数の制限）、`lib/audit.ts`、`lib/supabase/*`、`lib/client-fetch.ts`、`lib/stripe/*`、`lib/ops/*`、`components/ui/*`、`contexts/*`、`proxy.ts`、`app/layout.tsx`、`app/admin/page.tsx`・`AdminTabs`・`AdminSideNav`
- `supabase/migrations/`・`supabase/pending/`（当てた移行は直さない決まり）
- ソースを文字として読む試験の対象のファイル（調査で挙がった `lib/orders/**`・`webhook-processor.ts`・`api/cron/*`・`ui/Dialog/Dialog.css` など。範囲内にあれば作業の前に `tests/` を検索して確かめる）
- 今 G-1 が書き換えている文書: `requirements.md`・`api-spec.md`・`route-inventory.md`・`16_admin.md`・`er.md`、および `tests/unit/docs/*-traceability.test.ts` が文言を固定している文書

共有部品は範囲内のコードから参照されるが、今回はつなぎ先（`DD-` の ID）を設計の文書に書くだけにし、共有部品のファイル自体にはコメントを入れない。共有部品へのコメントは G・H の後の段に回す。

## 4. 土台にする基準と、足した厳しい点

| 取り入れる点 | 出どころ | 防げること |
| --- | --- | --- |
| 上位要件 → 下位要件 → コード → テストを全部、上下どちらにもたどれる | DO-178C（DAL A）6.5・表 A-3〜A-7 | 見落とし |
| どの要件にもつながらないコード（意図しない機能）を置かない | DO-178C 6.4.4.3 | 余計なもの・二重の実装 |
| 要求の外で足したもの（派生要件）は印を付け、理由を書き、安全・セキュリティの評価に回す | DO-178C 5.1.2・5.2.2 | 根拠のない作り |
| 要件ごとに出どころ・根拠・優先度・確かめ方を持たせる | ISO/IEC/IEEE 29148:2018 5.2.8・9.6 | 「なぜ」が分からない状態 |
| つながっているかだけでなく、上の段と中身が一致しているかを見る | Automotive SPICE 4.0（SWE.1〜SWE.6 の BP「一貫性と双方向トレーサビリティ」） | 形だけのつながり |
| 変える前に影響範囲を分析する | ISO 26262-8:2018 8 章（変更管理） | 思わぬ壊れ |
| 脅威 → セキュリティ要件 → 設計 → テストをつなぐ | ISO/SAE 21434:2021 15 章（TARA）・10 章 | セキュリティの穴 |
| セキュリティ要件の中身は ASVS の項目を出どころにする | OWASP ASVS 4.0.3 | 確かめの抜け |
| 設計判断ごとに、背景・決定・退けた案・結果を残す | Nygard の ADR | 「なぜこの作り」が分からない状態 |
| コメントは「何を」ではなく「なぜ」を書く | Google TypeScript Style Guide（Comments）、TSDoc | 読めば分かることの重複 |
| コードの通り道の網羅 | DO-178C 6.4.4.2（DAL A は MC/DC） | 試されていない分岐 |

出典:

- [DO-178C（RTCA）](https://www.rtca.org/do-178/)
- [ISO/IEC/IEEE 29148:2018](https://www.iso.org/standard/72089.html)
- [Automotive SPICE（VDA QMC）](https://vda-qmc.de/en/automotive-spice/)
- [ISO 26262-8:2018](https://www.iso.org/standard/68390.html)
- [ISO/SAE 21434:2021](https://www.iso.org/standard/70918.html)
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- [ADR（Michael Nygard）](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)、[TSDoc](https://tsdoc.org/)

**MC/DC について（Claude の判断）:** Jest（今の単体テストの道具）は MC/DC（条件の一つ一つが結果を変えることの確かめ）を測れない。MC/DC そのものは測らず、分岐の網羅（`--coverage` の branches）で代える。

**分岐の網羅の対象（ユーザー、2026-10-24）:** 範囲内の全部。`page.tsx`・`layout.tsx` などの画面、Route Handler、Server Action、画面の部品、`lib/`・`features/*/services` を含む。今は Jest で試していない画面や Route Handler も、単体テストを書き足して 100% にする。サーバーで動く画面（Server Component）は、データの取得をモックして描画の結果を確かめる形で単体テストを書く。どうしても届かない分岐（型の上では起きない道など）は、理由を `test-gaps.md` に1件ずつ書く。届かない分岐は例外として扱い、書き足せる物を逃がす先にはしない。

## 5. ID の体系

### 5-1 種類

既にある ID は番号を変えない（`docs/README.md` の決まり、既にある E2E を守る）。`requirements.md` の凡例どおり、`FREQ-NN` は要求、`FREQ-NN-REQ-NN` は要件として扱う。`FR-<AREA>-NNN`（`MUST`・`SHOULD` 付きの画面の要件）・`NFR-…`・`SEC-NNN`（全体のセキュリティ要件）も要件として扱う。

新しい `FREQ-` の番号は振らない。G-1 が同じ `requirements.md` に新しい `FREQ-` を足しているので、番号がぶつかるため。新しい要求は `SR-<AREA>-NNN` で起こす。範囲内の重複した `FREQ-` 番号は、2つ目以降を `SR-<AREA>-NNN` に振り替え、元の番号を「旧番号」の欄に残す。

| 段 | ID | 例 | 上の段（書く先） | 置き場 |
| --- | --- | --- | --- | --- |
| 要求 | 既存 `FREQ-NN`、新規 `SR-<AREA>-NNN` | `FREQ-31`、`SR-NEWS-001` | なし（出どころ: ユーザーの発言・`stakeholder-requirements.md`・ブランド文書・法令） | `docs/02_Requirements/areas/<area>.md` |
| 脅威 | `THR-<AREA>-NNN` | `THR-NEWS-001` | 守るもの（資産） | `docs/05_Quality/security/threats/<area>.md` |
| 要件 | 既存 `FREQ-NN-REQ-NN`・`FR-<AREA>-NNN`・`NFR-…` | `FR-NEWS-ALL-001` | 要求 | 同上の要件ファイル |
| 受け入れ条件 | 既存 `FREQ-NN-AC-NN`、新規 `<要件ID>-AC-NN` | `FREQ-31-AC-01`、`FR-NEWS-ALL-001-AC-01` | 要件 | 同上 |
| セキュリティ要件 | 既存 `SEC-NNN`、新規 `SEC-<AREA>-NNN` | `SEC-NEWS-001` | `THR-`（中身は ASVS の項目番号） | 同上の要件ファイル |
| 派生要件 | `DRV-<AREA>-NNN` | `DRV-NEWS-001` | なし。理由が必須 | 同上の要件ファイル |
| 設計判断 | `ADR-NNNN` | `ADR-0001` | 要件・セキュリティ要件 | `docs/03_BasicDesign/decisions/ADR-NNNN-<slug>.md` |
| 構造設計 | `ARC-`（構成）・`SCR-`（画面）・`FLOW-`（画面遷移）・`STATE-`（状態遷移）・`API-`・`DATA-` ＋ `-<AREA>-NNN` | `API-NEWS-002` | 要件・セキュリティ要件・ADR | `docs/03_BasicDesign/` の該当する文書 |
| 詳細設計 | `DD-<AREA>-NNN` | `DD-NEWS-003` | 構造設計 | `docs/04_DetailDesign/` の該当する文書 |
| 実装 | `IMPL-<AREA>-NNN` | `IMPL-NEWS-003` | `DD-` | コードの TSDoc |
| E2E | テスト名の先頭の受け入れ条件 ID | `FREQ-12-AC-01` | 受け入れ条件 | `e2e/` |
| 結合テスト | テスト名の先頭の構造設計 ID | `API-NEWS-002` | 構造設計 | `tests/integration/` |
| 単体テスト | テスト名の先頭の詳細設計 ID | `DD-NEWS-003` | 詳細設計 | `tests/unit/` |

- 受け入れ条件を持たない `FR-`・`NFR-` の要件には、`<要件ID>-AC-NN` を新しく起こす。E2E のテスト名には受け入れ条件の ID を付ける（要件の ID ではなく）
- 上の要求が見つからない要件は、`stakeholder-requirements.md` やブランド文書から `SR-` を起こしてつなぐ。起こした `SR-` は状態を「推定」にし、ユーザーの確認を受けて「現行」にする
- 構造設計の確かめ方（Claude の判断）: `ARC-`・`API-`・`DATA-`・`STATE-` は `tests/integration/` の結合テスト。`SCR-`・`FLOW-` は、画面単位で部品を組み合わせる React Testing Library の結合テスト（`tests/integration/ui/`、新規）

`<AREA>` は 3-1 の領域の英字名（HOME・NEWS・LOOK・ABOUT・STOCKIST・SEARCH・AUTH・PRIVACY・ADMIN など）。番号は領域ごとの連番で、振ったら変えない。消した項目の番号は再利用しない（「廃止」の状態で残す）。

### 5-2 項目の書き方（文書の中）

1つの項目は1つの見出しと属性の表で書く。スクリプトはこの形だけを読む。

```markdown
### DD-NEWS-003 公開済みニュースの一覧の取得

| 属性 | 値 |
| --- | --- |
| 上位 | API-NEWS-002、SEC-NEWS-001 |
| 根拠 | 下書きを外へ出さない（SEC-NEWS-001）。並びは公開日の新しい順（FREQ-05-AC-02） |
| 状態 | 現行 / 推定 / 廃止 |
| 確かめ方 | 単体テスト |
| 出どころ | `docs/superpowers/specs/2026-xx-xx-…md`、または「実装から推定」 |

本文（入出力・正常・異常・認可・永続化）。
```

- **上位** は必須（`SR-` と `DRV-` を除く）。複数書ける
- **根拠** は必須。「仕様のため」「要件のため」だけの根拠は不可
- **状態** の「推定」は、実装から起こしてユーザーの確認を受けていない内容。ユーザーが確認したら「現行」にする
- 要件には ISO/IEC/IEEE 29148 に合わせて **優先度** と **旧番号** の欄も持たせる

### 5-3 コードのコメント

実装 ID は「まとまった単位」（ユーザー）に付ける。Claude の判断で、単位は次のとおりにする。

| 単位 | 例 |
| --- | --- |
| Route Handler の1ファイル | `src/app/api/news/route.ts` |
| Server Action の1つ | `src/app/actions/*.ts` の export された関数 |
| ページ・レイアウトの1ファイル | `src/app/news/page.tsx` |
| 画面の部品の1ファイル | `src/features/news/components/NewsCard.tsx` |
| export された関数・クラス（`lib/`・`features/*/services`） | `fetchPublishedNews()` |

書き方は TSDoc。

```ts
/**
 * 公開済みのニュースだけを公開日の新しい順に返す。
 *
 * @impl IMPL-NEWS-003
 * @design DD-NEWS-003
 * @remarks 下書きを外へ出さないため、公開の印は DB 側で絞る（SEC-NEWS-001）。
 */
```

- `@impl` と `@design` は必須。`@remarks` には「なぜ」だけを書く（読めば分かる「何を」は書かない）
- 1つの `IMPL-` は1つの `DD-` にだけつなぐ。1つの `DD-` には複数の `IMPL-` がつながってよい
- 関数の中の行コメントは、読んだだけでは分からない理由がある所（セキュリティの判断・外部仕様の癖・順番が大事な所）だけに書く
- コードにはテストの場所を書かない（逆の向きはスクリプトが作る）
- 動きは変えない。コメント以外の変更は入れない

### 5-4 テストのつなぎ方

テスト名（`test()`・`it()`・`describe()` の最初の引数）の先頭に ID を付ける。

```ts
test('FREQ-05-AC-02 ニュースが公開日の新しい順に並ぶ', async ({ page }) => { … });
it('DD-NEWS-003 下書きのニュースを返さない', () => { … });
```

- E2E のファイル名（`FR-NEWS-ALL-001-….spec.ts`）は変えない。ファイル名の `FR-` は受け入れ条件とみなす
- テストを書き足す時は、CLAUDE.md の決まり（E2E は3つの幅・本番ビルド・手元の Supabase）に従う

## 6. 文書の構成と書き直し

### 6-1 置き場

| 段 | 置き場 | 書き直しの方針 |
| --- | --- | --- |
| 要求・要件・受け入れ条件・セキュリティ要件・派生要件 | `docs/02_Requirements/areas/<area>.md`（新規） | 範囲内の行を `requirements.md` から写し、5-2 の形にする。各項目に「旧所在」（`requirements.md` の節）を書く。`requirements.md` の該当行は今回は消さない（G-1 が落ち着いてから目次に置き換える）。範囲内の ID の定義は `areas/` だけとみなし、検査は `requirements.md` を定義として読まない。範囲内と範囲外にまたがる行（例: ヘッダーの虫眼鏡で商品を検索）は丸ごと写し、範囲外の下位は「範囲外」の印で検査を通す |
| 脅威 | `docs/05_Quality/security/threats/<area>.md`（新規） | 既にある `reviews/security/security_review_<page>.md` の指摘から起こす |
| 設計判断 | `docs/03_BasicDesign/decisions/`（新規） | 過去の specs と `architecture/` の文書から、範囲内の判断を拾う |
| 構造設計 | `docs/03_BasicDesign/{architecture,ui,data}`（範囲内の部分）。API は `docs/03_BasicDesign/api/areas/<area>.md`（新規） | `api-spec.md`・`er.md` は G-1 が書き換え中なので触らず、範囲内の分を新しいファイルに書く |
| 詳細設計 | `docs/04_DetailDesign/pages/` の範囲内の頁（01・02・03・06・07・08・10・14・17・19） | 5-2 の形に書き直す |
| テスト仕様 | `docs/05_Quality/tests/` | 範囲内の分を書き直す |
| 生成物 | `docs/05_Quality/reports/trace-matrix.md`・`unused-code.md`・`test-gaps.md`（新規、スクリプトが作る） | 手で直さない |

### 6-2 過去の仕様と実装から起こす順

1. 要件: `requirements.md`・`stakeholder-requirements.md`・`use-cases.md` の範囲内の行
2. 過去の決定: `docs/superpowers/specs`・`plans`、作業と指摘の台帳、レビュー記録のうち範囲内の物
3. 実装: 文書に無い振る舞いはコードから起こし、状態を「推定」にする
4. 食い違い: 文書とコードが違ったら、どちらが正しいかを決めずに一覧（`trace-matrix.md` の「食い違い」節）に載せてユーザーに聞く

### 6-3 書式の統一（今後の文書）

- `.claude/skills/documentation-guide/SKILL.md` を書式の正本にする。中身: `docs/README.md` の共通フォーマット、文書の種類ごとの最小構成、5-2 の項目の書き方、ID の体系、5-3 のコメントの書き方、5-4 のテストのつなぎ方
- 同じスキルの写し `.codex/skills/documentation-guide/SKILL.md`・`.github/skills/documentation-guide/SKILL.md` も同じ中身にする（Codex に任せる時に読まれるため）
- `.claude/CLAUDE.md` の「docs 文書の参照ルール」「docs 文書の更新ルール」に、このスキルに従うことと、ID のつなぎを足す
- `docs/README.md` の共通フォーマットは、スキルと食い違わないように直す

## 7. 自動の検査と道具

`scripts/` に Node のスクリプトを足す（ファイル名とコマンド名は作る人が決める）。

| 検査 | 落とす条件 |
| --- | --- |
| 定義 | 1つの ID が2か所以上で定義されている。書式が違う |
| 上位 | 上位の欄が空（`SR-`・`DRV-` を除く）。存在しない ID を指している |
| 下位 | 要件・受け入れ条件に E2E が無い。構造設計に結合テストが無い。詳細設計に単体テストと `IMPL-` が無い |
| 根拠 | 根拠の欄が空、または決まり文句だけ |
| 派生要件 | 理由が無い |
| コード | 範囲内の単位（5-3）に `@impl` が無い。`@design` の先が無い |
| テスト | テスト名の先頭の ID が存在しない |

- 検査は新しいスクリプトと新しい npm のコマンドにする。既にある `npm run validate-docs`（`scripts/validate-design-docs.js`）は中身を変えない。G-1 が書き換え中の文書を読んでいて、足すとそちらの合否が変わるため（Claude の判断）
- 範囲は領域の一覧で絞れるようにし、範囲外は今は検査しない（範囲外の古い文書の切れで落ちないように）
- 一覧の生成: `trace-matrix.md`（要求から下までの表と、逆の向きの表）、`test-gaps.md`、`unused-code.md`
- 影響範囲のコマンド: 1つの ID（またはファイルの場所）を渡すと、上（要求まで）と下（テストまで）と、同じ `DD-` を共有する `IMPL-` を出す
- 既にある `scripts/generate-coverage-report.js` と `traceability-report.md` は G-1 の試験と関係するかを確かめてから扱う。今回は消さずに残す

## 8. 使われていないコードの一覧

`docs/05_Quality/reports/unused-code.md` に、範囲内で見つけた物を載せる。消さない。

| 列 | 中身 |
| --- | --- |
| 場所 | ファイル（と関数） |
| 見つけ方 | どこからも import されていない／どの要件にもつながらない／画面から呼ばれない |
| 確かめた方法 | 検索の語、graphify の結果、試験の有無 |
| 消した時の影響 | それを試す試験、文書の参照 |
| 判断 | 空欄（ユーザーが書く） |

調査ですでに見つかった候補: `components/ContactSection`、`lib/cache`、`utils/supabase/server.ts`（どこからも使われていない）。範囲外の物も、見つけたら載せる（範囲外の印を付ける）。

## 9. 進め方

1. **仕組み**: スキル・CLAUDE.md・検査のスクリプトを作る
2. **試しの1領域（NEWS）**: 要求からテストまでを全部つなぐ。テストの穴は書き足す。ここでユーザーに見せ、書式と粒度を確かめてもらう
3. **残りの領域**: HOME・LOOK・ABOUT・STOCKIST・SEARCH・PRIVACY・AUTH・管理のそのほかの順に1つずつ行う
4. **最終**: 全体の一覧の生成、使われていないコードの一覧、Opus（エフォート high）による全体のレビュー

領域ごとに、コメントだけのコミットと、文書のコミットと、テストのコミットに分ける。

### 9-1 並行の作業との付き合い方

- G-1 が同じ作業フォルダで並行して進んでいる。コミットには自分が変えたファイルだけを名前を指定して入れる（`git add -A`・`git add .` は使わない）
- 範囲外のファイルの差分は見ても触らない
- 単体テストは範囲内のファイルだけを流す
- DB を使う結合テストと E2E は、手元の Supabase の `db reset` と 3000 番のアプリが G-1 の試験とぶつかる。流す前に 3000 番のアプリと DB の状態を確かめ、G-1 が試験を流している間は流さない
- push と本番の DB への適用はしない（この作業は本番の DB を変えない）。push はユーザーに確かめてから

### 9-2 確かめ（終わりの条件）

- 範囲内で、7章の検査が全部通る
- 範囲内の単体テスト・結合テスト・E2E が通る（書き足した物を含む）。既にある赤（`e2e-login-pwreset-preexisting-failures` の記録）と比べて増えていない。テスト名に ID を付けると前の記録と名前で突き合わせられなくなるので、名前を変える前に範囲内の E2E を流して基準を取り、「古い名前 → 新しい名前」の対応表をスクリプトで作って、ファイルとテスト名の単位で比べる（Claude の判断）
- 範囲内の全部のファイル（画面・Route Handler・Server Action・部品・`lib/`・`features/*/services`）で分岐の網羅 100%（届かない分岐は理由つきで一覧）
- ソースを文字として読む試験を含め、範囲外の試験が落ちていない（`npm test` の全件を前後で比べる）
- `npm run validate-docs` の、今回足した文書での切れが 0

## 10. 作る人に任せる所

- スクリプトのファイル名・コマンド名・作り
- 領域の中の番号の振り方の順
- 文書の中の節の並び（6-3 のスキルに合う範囲で）
- 試しの領域の後で粒度を変える場合の具体（ユーザーの確認を受けてから）

## 11. Claude の判断で決めたこと（ユーザーの確認待ち）

- 実装 ID の単位（5-3 の表）
- MC/DC は測らず、分岐の網羅 100% で代える（対象を範囲内の全部にするのはユーザーの決定）
- 共有部品にはコメントを入れず、G・H の後に回す
- 既存の `FREQ-`・`FR-` は番号を変えない
- 試しの領域を NEWS にする
- 検査は範囲内だけで落とす。既にある `validate-docs` は変えず、別のコマンドにする
- `FR-`・`NFR-` は要件として扱い、受け入れ条件 `<要件ID>-AC-NN` を起こす。新しい `FREQ-` は振らず、新しい要求は `SR-`
- 範囲内の ID の定義は `areas/` だけとみなす（`requirements.md` の写し元は数えない）
- 画面と画面遷移（`SCR-`・`FLOW-`）の結合テストは React Testing Library で画面単位に書く
- E2E の前後の比べ方は、名前の対応表を作ってテスト名の単位で比べる

## 未確認事項

- 範囲内のファイルのうち、ソースを文字として読む試験の対象かどうかは、作業の前にファイルごとに確かめる
- `scripts/generate-coverage-report.js` を G-1 の作業が使っているか
- 範囲内の E2E にある既存の赤（ログインの回数の制限など）を、テストの書き足しの時にどう扱うか
