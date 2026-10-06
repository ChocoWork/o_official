import { seedLocalStorage } from './seed-storage';

/** E2E の前に、手元の Storage に見本の画像を置く。npx supabase db reset で消えるので毎回置き直す。 */
export default async function globalSetup(): Promise<void> {
  const count = await seedLocalStorage(process.env);
  console.log(`[e2e] 手元の Storage に見本の画像を ${count} 件置いた`);
}
