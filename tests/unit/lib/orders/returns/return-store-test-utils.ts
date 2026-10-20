import fs from 'node:fs';
import path from 'node:path';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { ReturnStoreError, type ReturnStore } from '@/lib/orders/returns/return-store';

/**
 * 返品の DB の呼び出し（return-store.ts の兄弟のファイル）の単体テストが共有する道具（グループ E-3 段2 Task 4）。
 * return-store.test.ts は段1の作りのまま自分の物を持つ。新しい試験（customer-return-store・cancel-request-store）はここから使う。
 */

export type RpcAnswer = { data?: unknown; error?: { message?: string; code?: string } | null };

/** rpc だけを持つ入れ物。関数の名前ごとに答えを決める。決めていない関数は空の行を返す（null を決めた時は null のまま返す） */
export function storeWith(answers: Record<string, RpcAnswer>) {
  const rpc = jest.fn(async (...call: [name: string, args?: Record<string, unknown>]) => {
    const answer = answers[call[0]];
    return { data: answer && 'data' in answer ? answer.data : [], error: answer?.error ?? null };
  });
  return { store: { rpc } as unknown as ReturnStore, rpc };
}

/** 版の頭の数字は本番に当てる時に付け替わるので、移行のファイルは名前の後ろで探す */
export function migrationText(suffix: string): string {
  const directory = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(directory, files[0]), 'utf8');
}

/** CREATE FUNCTION public.{name}( … ) の引数の名前。DEFAULT のある引数は省略できる物として返す */
export function declaredParams(sql: string, name: string): Array<{ name: string; optional: boolean }> {
  // SQL のコメント（-- から行末まで）は、括弧や引用符を含みうるので、先に捨てる
  const text = sql.replace(/--.*$/gm, '');
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`).exec(text);
  expect(head).not.toBeNull();

  // 対応する ) までを、括弧・角括弧・引用符の外のカンマで引数に分ける
  const pieces: string[] = [];
  let current = '';
  let depth = 1;
  let quoted = false;
  for (let index = (head?.index ?? 0) + (head?.[0].length ?? 0); index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    if (!quoted && (char === '(' || char === '[')) depth += 1;
    if (!quoted && (char === ')' || char === ']')) depth -= 1;
    if (depth === 0) break;
    if (!quoted && depth === 1 && char === ',') {
      pieces.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  pieces.push(current);

  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => ({ name: piece.split(/\s+/)[0], optional: /\bDEFAULT\b/i.test(piece) }));
}

/** DB が word で断った時に、run が ReturnStoreError（記号 code）で止まること */
export async function expectRefusal(
  rpcName: string,
  word: string,
  code: string,
  run: (store: ReturnStore) => Promise<unknown>,
): Promise<void> {
  const { store } = storeWith({ [rpcName]: { error: { message: word, code: 'P0001' } } });

  const error = await run(store).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ReturnStoreError);
  expect(error).not.toBeInstanceOf(RefundStoreError);
  expect(error).toMatchObject({ code });
}
