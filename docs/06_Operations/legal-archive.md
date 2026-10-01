# オンライン注文の法定アーカイブ運用

## 概要

オンライン注文は注文DBを電子証憑として保存し、利用者による証憑添付を不要とする。毎日、対象暦年の全件CSVとDBバックアップを非公開Storageへ保存し、毎月、隔離DBへの復元確認を行う。初期保存先はSupabase Storage、外部S3互換ストレージ設定後は二重保存とする。

| 項目 | 方針 |
| --- | --- |
| 会計期間 | 1月1日から12月31日 |
| 日次保存 | 02:30 JST、対象年の全件スナップショット |
| 復元確認 | 毎月2日 03:00 JST |
| 年次確定 | 1月2日に前年12月31日版を不変キーへ複製 |
| 保存期間 | 原則7年、対象年度は環境設定で10年へ延長 |

## 1. 必須設定

GitHub ActionsのEnvironment Secretsへ次を登録する。

| Secret | 用途 |
| --- | --- |
| `APP_BASE_URL` | 本番アプリケーションURL |
| `LEGAL_ARCHIVE_CRON_SECRET` | アーカイブAPIのBearer認証 |
| `NEXT_PUBLIC_SUPABASE_URL` | SupabaseプロジェクトURL |
| `SUPABASE_SERVICE_ROLE_KEY` | 非公開Storageと状態テーブルの操作 |
| `SUPABASE_DB_URL` | `pg_dump`専用のDB接続 |

外部保存先を有効化する場合は `S3_ARCHIVE_BUCKET`、`S3_ARCHIVE_REGION` を追加し、必要に応じて `S3_ARCHIVE_ENDPOINT` と `S3_ARCHIVE_FORCE_PATH_STYLE` を設定する。秘密値をリポジトリ、Actions成果物、ログへ出力しない。

## 2. 初期適用の確認

1. マイグレーション081を適用する。
2. Supabase Dashboardで `legal-archive` バケットが非公開であることを確認する。
3. `orders` と `order_items` の削除がDBトリガーで拒否されることをステージング環境で確認する。
4. GitHub Actionsの `Legal archive daily` を手動実行する。
5. 管理画面が「保存要件整備中」から、日次保存・復元確認後に「注文データ保存済み」へ変わることを確認する。

## 3. 日次障害への対応

- Actionsが失敗した場合はログの安定エラーコードを確認し、同日のWorkflow Dispatchを再実行する。
- 最終キーは上書きしない。同日分が一部存在する場合は、内容を確認してから別途承認された手順で復旧する。
- CSV、DBバックアップ、マニフェストのいずれかだけを手動で差し替えない。
- 外部保存先だけ失敗した場合も実行全体を失敗として扱い、二重保存の整合性を回復する。

## 4. 月次復元確認

復元確認は一時PostgreSQLへ `pg_restore --exit-on-error` で復元し、次を照合する。

- 注文、明細、変更履歴テーブルと保護トリガー
- 孤児明細が0件であること
- 対象暦年の注文・明細・変更履歴件数
- 総額、返金額、純額
- 全CSVとDBバックアップのSHA-256

失敗時は本番DBを変更せず、`RESTORE_VERIFY_FAILED` などの安定コードだけを記録する。

## 5. 保存期間と削除

原則7年保存とし、10年保存が必要な年度は `LEGAL_ARCHIVE_RETENTION_YEARS_<YEAR>=10` を設定する。オブジェクトストレージのライフサイクル削除は、この年度別保存期間と年次確定の完了を確認してから設定する。削除操作は通常運用へ組み込まず、責任者承認と対象キー一覧の保存を必須とする。
