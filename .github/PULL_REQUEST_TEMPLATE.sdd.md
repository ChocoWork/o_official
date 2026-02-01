## 概要
<!-- SDD の変更点を簡潔に記載してください（構造設計 / 詳細設計 のどちらが含まれるかを明記） -->

**タスク / チケット:** <TASK_ID>
**関連仕様:** <参照した仕様ファイル>

### この PR で何をしたか
- 構造設計: `docs/ArchitectureDesign/<feature>-structure.md` を追加（含む: 要求ID→アーキテクチャID マッピング、Mermaid 図）
- 詳細設計: `src/features/<feature>/design.md` を追加（含む: OpenAPI, DB マイグレーション草案, 型定義, テスト計画）

---
### チェックリスト ✅
- [ ] トレーサビリティマトリクス（仕様の要求ID と 設計成果物）が含まれている
- [ ] 構造設計に「要求ID → アーキテクチャID」マッピング表が含まれている
- [ ] DB 変更がある場合、マイグレーション案とロールバック手順を追加した
- [ ] TypeScript 型と Zod バリデーションが含まれている
- [ ] 単体/結合/契約/E2E テスト計画が追加されている
- [ ] `npm run validate-docs` によるドキュメント検証が成功している（Markdown Preview Enhanced 描画エラーなし）
- [ ] `docs/ArchitectureDesign/coverage-report.md`（`npm run check-coverage`）を添付し、漏れがないことを確認した
- [ ] tasks/roadmap.md の該当チェックボックスを更新した
- [ ] BREAKING CHANGE がある場合、影響範囲と承認者を明記した

---
### レビュア向けメモ
- 重点確認箇所: 構造設計の要求→アーキテクチャの対応、DB マイグレーションの安全性、セキュリティ設計
- ステージでの検証手順: <手順を記載>

レビューお願いします。