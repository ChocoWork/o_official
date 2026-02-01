# SUPABASE_SERVICE_ROLE_KEY — 運用フロー図

このファイルは `SUPABASE_SERVICE_ROLE_KEY` の日常運用・ローテーション・緊急対応をイメージできる Mermaid 図を収めた Markdown ドキュメントです。

注: Markdown Preview Enhanced (MPE) で表示する場合、Mermaid のコードフェンスは次の形式で記述してください: \`\`\`mermaid

---

## 1) 秘密作成と利用フロー

```mermaid
flowchart TD
  A[管理者: Supabase 管理画面] -->|Create service_role key| B[Supabase Service Role Key]
  B -->|Store| C[AWS Secrets Manager]
  C -->|GetSecretValue（IAM Role）| D[アプリ（API / Server）]
  D -->|Server-side calls| E[Supabase Postgres/Auth]
  D -->|ログ: audit event| F[監査ログ / SIEM]
  style B fill:#f9f,stroke:#333,stroke-width:1px
  style C fill:#fffbcc
  style D fill:#ccf5ff
  style E fill:#e6ffe6
  style F fill:#fff0f0
```

---

## 2) 正常ローテーションフロー

```mermaid
flowchart TD
  subgraph Admin
    A1[管理者: Key 発行要求]
    A2[Supabase: 新規 service_role key 生成]
  end
  subgraph Secrets
    S1[Secrets Manager: 新バージョン登録]
  end
  subgraph Deploy
    R1[CI/CD: 新 Secret を取得]
    R2[App: ローリングデプロイ/設定差し替え]
    R3[Health Check]
  end
  subgraph Finalize
    F1[Supabase: 古い key を無効化/削除]
    F2[Audit: 変更イベント記録]
  end

  A1 --> A2 --> S1 --> R1 --> R2 --> R3 --> F1 --> F2
```

---

## 3) 緊急ローテーション（漏洩疑い）

```mermaid
flowchart TD
  I[漏洩検知/疑い] --> M[即時: Secrets Manager に暫定値投入]
  M --> D1[アプリ: 接続遮断（短時間）]
  D1 --> A[管理者: 新キー発行（Supabase）]
  A --> S2[Secrets Manager: 新値登録]
  S2 --> R[アプリ: 新キーでリロード/復旧]
  R --> V[検証: セッション整合性・監査]
  V --> For[フォレンジック: CloudTrail/監査ログ解析]
```

---

## 4) 開発 / CI の扱い

```mermaid
flowchart TD
  Dev[開発者のローカル] -->|aws secretsmanager get-secret-value| LocalEnv[.env.local（ローカルのみ）]
  CI[CI/CD（GitHub Actions）] -->|一時的に取得| Deploy[デプロイ実行]
  Deploy -->|利用| ProdApp[本番アプリ];

  N_LocalEnv[.env.local は .gitignore に必須]
  N_CI[CI は最小権限のサービスロールを使用]

  LocalEnv -.-> N_LocalEnv
  CI -.-> N_CI
```

---

## 5) 監査・アラート設計

```mermaid
flowchart LR
  SecretsManager -->|ChangeEvent| CloudTrail
  CloudTrail -->|Send| SNS
  SNS --> Ops[運用チーム通知]
  CloudTrail -->|GetSecretValue events| SIEM[監査ダッシュボード]
```

---

## ファイル場所
- `docs/seq/supabase-service-role-key-rotation-diagrams.md`

---

## 備考
- MPE (Markdown Preview Enhanced) はコードフェンスで `mermaid` をサポートしています。上記ファイルは MPE で読み込んで表示してください。
- 図の色やノードは運用チームの好みに合わせて調整可能です。
