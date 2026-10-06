# テスト仕様

## 概要

この文書は、要件からテストへの追跡方法、実行するテストの層、判定と記録の方法を定める。下表のテストファイルはリポジトリで確認した例であり、ここに列挙したことは実行・成功を意味しない。

## 記録形式と追跡

要件の原本は `docs/02_Requirements/requirements.md` とし、関連する詳細設計は `docs/04_DetailDesign/` で確認する。テスト記録には要件 ID、受け入れ条件 ID、対象ファイルとテスト名、対象リビジョン、環境、実行コマンド、日時、結果、失敗時の証拠を残す。`FR-*` のような画面要件と `FREQ-*-AC-*` の受け入れ条件を混同しない。対応テストが見つからない要件は「未対応」、テストが検出されただけなら「未実行」と記録する。

| 要件・受け入れ条件の例 | テストの例 | 確認する振る舞い |
| --- | --- | --- |
| `FR-ABOUT-001` | `e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts` | ブランド哲学セクションの表示 |
| `FREQ-257-AC-10` | `e2e/FR-ADMIN-043-transaction-workbench.spec.ts`、`tests/unit/components/CostProfitSection.test.tsx` | 手動取引の操作列、編集・削除の確認。受け入れ条件への完全な対応はテスト内容と実行結果を個別に確認する |
| `FREQ-106-AC-01` | `e2e/FR-LEGAL-004-konbini-deadline.spec.ts`、`tests/unit/api/checkout/create-session-route.test.ts` | コンビニ決済期限の表示とセッション設定。受け入れ条件への完全な対応はテスト内容と実行結果を個別に確認する |
| `FREQ-321-AC-01` | `.github/workflows/db-migrations.yml` の構成確認 | PR の dry run と push 時の適用。実際の本番適用履歴は別途確認する |

## テストの層と範囲

| 層 | 構成と目的 | 実行の例 |
| --- | --- | --- |
| 静的検査 | ESLint と TypeScript の構文・型の確認 | `npm run lint`、`npm run typecheck` |
| Jest | `jest.config.cjs` の `tests/**/*.test.(ts\|tsx\|js)`。関数、コンポーネント、API、SQL マイグレーションの契約を確認 | `npm test -- --runTestsByPath tests/unit/components/CostProfitSection.test.tsx` |
| Playwright E2E | `playwright.config.ts` の `e2e/`、Chromium。画面・API を通る利用者の流れを確認 | `npm run test:e2e -- e2e/FR-ABOUT-001-brand-philosophy-section.spec.ts` |
| 運用確認 | DB 適用、外部 Webhook、アーカイブ復元等の実環境での結果を確認 | 対象の運用手順と実行記録を参照 |

Playwright は `http://localhost:3000` を使い、手元の Supabase に対して流す。3000番のアプリは、E2E が手元の設定で起動したもの（印が一致するもの）だけをビルドし直さずに使い回し、それ以外は止まる。`E2E_STRICT=1` では使い回さず、3000番が空いていなければ止まる。CI では再試行が設定されている。ファイル発見や `--list` は実行結果に含めない。

## リスクに応じた優先順位

決済・注文状態・在庫、認証・権限、マイグレーション・RLS、証憑アーカイブを優先する。これらは単体テストに加え、必要な API/E2E と実環境の運用確認を選ぶ。外部サービスのモックを使うテストは契約の一部を確認するだけであり、Webhook 配信や本番 DB の状態を証明しない。

## 開始・終了条件

開始前に変更範囲、対応要件、対象リビジョン、必要な環境変数とテストデータ、ポート 3000 の実サーバーを確認する。終了時は対象テストを実行し、失敗を分類して修正または未解決として記録する。要件ごとの判定には実行ログと環境を添える。対象外テストや未実施の本番確認を成功扱いしない。
