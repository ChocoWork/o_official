/**
 * DB 結合テストの共通の入口。
 *
 * 試験用の注文は削除禁止トリガーで消せないので、使い捨てのローカル DB でだけ動かす。
 * DATABASE_URL が無ければ skip、localhost 以外なら失敗させる（既存の DB 結合テストと同じ規則）。
 */
const { Client } = require('pg');

export type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  end: () => Promise<void>;
};

export const LOCAL_DATABASE_URL = process.env.DATABASE_URL;

export function isLocalDatabase(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function connectLocalDb(): Promise<PgClient> {
  const client = new Client({ connectionString: LOCAL_DATABASE_URL });
  await client.connect();
  return client as PgClient;
}

export function describeLocalDb(name: string, body: (getClient: () => PgClient) => void): void {
  describe(name, () => {
    const url = LOCAL_DATABASE_URL;
    if (!url) {
      test.skip('DATABASE_URL 未設定のためスキップ', () => {});
      return;
    }
    if (!isLocalDatabase(url)) {
      test('使い捨ての DB 以外では実行しない', () => {
        throw new Error('消せない試験注文が残るため、localhost 以外の DATABASE_URL では実行しない');
      });
      return;
    }

    let client: PgClient;
    beforeAll(async () => {
      client = await connectLocalDb();
    });
    afterAll(async () => {
      if (client) await client.end();
    });

    body(() => client);
  });
}
