---
title: シークレット管理方針
---

# シークレット管理方針（暫定: 手動運用）

## 概要
このドキュメントは `SUPABASE_SERVICE_ROLE_KEY` 等の運用上重要なシークレットの**初期運用手順（手動）**を定めます。事業成長に合わせて自動ローテーション（`docs/seq/supabase-service-role-key-rotation-diagrams.md`）へ移行する計画です。

## 適用範囲
- SUPABASE_SERVICE_ROLE_KEY
- JWT_SECRET（アプリの共通鍵）
- AWS_SES_* 等送信に必要なシークレット

## 初期（手動）運用プロセス
1. 発行・変更
   - シークレットの発行は運用担当（Ops）または認可された管理者が行う。
   - 新しいキーを発行したら、Secrets Manager（または Vercel/環境に応じた安全なストア）に手動で登録する。
2. 公開手順
   - 登録後、デプロイ手順（CI）を通じてアプリに反映する。手順書を `docs/ops/secrets-rotation.md` に記載する。
3. 承認と記録
   - すべてのローテーション操作は PR ではなく運用チケット（Ops のチケットトラッカー）で記録し、少なくとも 1 名の別人による承認を得ること。
   - 変更時には監査ログを記録（who/when/why）する。`src/lib/audit.ts` に該当イベントを吐くことを推奨。
4. 検証
   - 新キー適用後は影響範囲の smoke tests（簡単なヘルスチェック）を実行し、問題がないことを確認する。
5. ロールバック
   - 問題発生時は直ちに旧キーへロールバックする手順を実行し、影響を最小化する。詳細は `docs/ops/secrets-rotation.md` に記載。

## セキュリティ注意点
- シークレットは平文で保存しない。コミット禁止（`.gitignore` 有効）。
- 誰がアクセスできるかは最小権限の原則に従い、必要な人のみアクセスを許可する。
- 漏洩疑いがある場合は即座に暫定値を投入し、緊急ローテーションフローを開始する（`docs/seq/supabase-service-role-key-rotation-diagrams.md` を参照）。

## 将来的な自動化（移行計画）
- 事業拡大に伴い、`docs/seq/supabase-service-role-key-rotation-diagrams.md` に記載された自動ローテーションフローを採用する予定です。
- 自動化のための TODO:
  - CI/CD の secret rotation playbook の用意（` .github/workflows/rotate-secrets.yml`）
  - 確認テスト自動化（デプロイ直後の smoke tests）
  - 監査・アラートの自動化（CloudTrail / SNS 通知）

---
*作成: SDD Agent (追記) — 現行は手動運用、将来的に自動運用へ移行予定*