/**
 * 管理の記事の書き込みの窓口（POST /api/admin/news、PUT・PATCH・DELETE /api/admin/news/[id]）の振る舞い（NEWS 領域）。
 * 受け入れ条件: SEC-NEWS-016-AC-01・AC-02（監査の記録）、017-AC-01・AC-02・AC-03（画像の中身・保存の名前・大きさ）、
 * 018-AC-01・AC-02（使わなくなった画像を置き場から消す）。
 *
 * 道: 本番ビルドの窓口へ Playwright の request で直に要求する（画面は開かない。画面幅は応答に関係しないので、3つの幅には繰り返さない）。
 * 管理者は手元の Supabase の本物の JWT（店長・aal2。e2e/admin-session-test-utils.ts。aal2 は auth.mfa_amr_claims に totp の行を足して refresh して得る）を Authorization: Bearer で送る。Cookie を送らないので
 * CSRF の token は要らない。変更の要求には許可のオリジン（Origin）を付ける。記事の行・監査の行・置き場の物は手元の DB と
 * service role の Storage で作る・読む（置き場 news-images は非公開で、手元の Supabase の物だけを触る）。
 *
 * 場面は withPermissionScenario の lock の中で流す。置き場のファイル数（017-AC-01）を数える間、同じ lock を使う別の試験の
 * 書き込みと混ざらないようにするため。記事は status='private' で作り、公開の画面には出さない。
 *
 * 現行のコードが満たさない AC（文のとおりに書いてあり、緩めない。コードが直るまで赤）:
 * 016-AC-02（無い id でも 200 と成功の監査）、017-AC-01（type の申告だけで通す）、017-AC-02（PUT の拡張子を送られた名前から作る）、
 * 018-AC-01・AC-02（記事を消しても・画像を替えても前の画像を置き場に残す）。016-AC-01・017-AC-03 は満たす見込み。
 *
 * 店長（aal2）は worker ごとに 1 人だけ作り（Auth のログインの回数の制限を使い切らない）、worker の終わりに消す。監査の行は消さない（db reset で消える）。記事の行と、置き場に入った物は終わりに消す。
 */
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

// 管理者の JWT を通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });
test.describe.configure({ timeout: 120_000 });

const LIST_PATH = '/api/admin/news';
const one = (id: number | string): string => `/api/admin/news/${id}`;
const BUCKET = 'news-images';
/** 必ず無い id（bigint の範囲で、連番がここまで進まない値） */
const MISSING_ID = 9_000_000_000_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type Scenario = {
  db: PgClient;
  request: APIRequestContext;
  actor: AdminSessionActor;
  /** service role の Storage（手元の Supabase だけ） */
  storage: SupabaseClient;
  origin: string;
  /** この試験だけの送り元（x-forwarded-for） */
  ip: string;
  /** 記事の題の頭。この頭で始まる行が、この試験が作った行 */
  titlePrefix: string;
  /** 試験が置き場に直に置く物のフォルダ（news/<tag>） */
  folder: string;
};

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 本物の PNG（1x1 の赤。signature・IHDR・tEXt・IDAT・IEND が全部正しい）。padBytes は tEXt の詰め物で、全体の大きさを増やす */
function makePng(padBytes = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8); // 深さ
  ihdr.writeUInt8(2, 9); // RGB
  const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
  const text = Buffer.concat([Buffer.from('e2e\0', 'latin1'), Buffer.alloc(padBytes, 0x61)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', text),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function uniqueIp(): string {
  const groups = randomBytes(8).toString('hex').match(/.{4}/g) ?? [];
  return `2001:db8:${groups.join(':')}`;
}

function storageClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey || !isLocalUrl(url)) throw new Error('置き場を直に触れるのは手元の Supabase だけ');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 置き場の物を、フォルダの一覧（service role）から探す */
async function objectExists(s: Scenario, path: string): Promise<boolean> {
  const cut = path.lastIndexOf('/');
  const dir = path.slice(0, cut);
  const name = path.slice(cut + 1);
  const { data, error } = await s.storage.storage.from(BUCKET).list(dir, { search: name, limit: 100 });
  if (error) throw new Error(`置き場の一覧を読めない: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === name);
}

/**
 * 置き場 news-images の物の数。ほかの試験が自分の用意に使う news/e2e-・other/e2e- の頭の物（FR-NEWS-SEC-001 の見本など）は数えない。
 * 同時に流れる別の試験の置き場への書き込みで、数が増減して false の赤・青にならないようにするため。
 */
async function bucketObjectCount(db: PgClient): Promise<number> {
  const res = await db.query(
    `select count(*)::int as n from storage.objects
      where bucket_id = $1 and name not like 'news/e2e-%' and name not like 'other/e2e-%'`,
    [BUCKET],
  );
  return res.rows[0].n as number;
}

/** 試験が直に置き場へ置く PNG（記事の「前の画像」にする） */
async function seedObject(s: Scenario, name: string): Promise<string> {
  const path = `${s.folder}/${name}`;
  const { error } = await s.storage.storage.from(BUCKET).upload(path, makePng(), { contentType: 'image/png', upsert: false });
  if (error) throw new Error(`置き場へ置けない: ${error.message}`);
  return path;
}

/** 非公開の記事の行を DB に直に作り、id を返す */
async function seedArticle(s: Scenario, label: string, imagePath: string): Promise<number> {
  const res = await s.db.query(
    `insert into public.news_articles (title, category, published_date, image_url, content, detailed_content, status)
     values ($1, 'EVENT', '2026-01-01', $2, 'E2E content', 'E2E detailed content', 'private')
     returning id`,
    [`${s.titlePrefix} ${label}`, imagePath],
  );
  return Number(res.rows[0].id);
}

async function readImageUrl(db: PgClient, id: number): Promise<string | null> {
  const res = await db.query('select image_url from public.news_articles where id = $1::bigint', [id]);
  return (res.rows[0]?.image_url as string | undefined) ?? null;
}

/** この試験の記事の行と、行が指す置き場の物、試験のフォルダの物を消す（赤の時に作られた物も含む） */
async function cleanup(s: Scenario): Promise<void> {
  const rows = await s.db.query('select image_url from public.news_articles where title like $1', [`${s.titlePrefix}%`]);
  const paths = new Set<string>(
    (rows.rows as Array<{ image_url: string | null }>)
      .map((row) => row.image_url)
      .filter((value): value is string => typeof value === 'string' && value.startsWith('news/')),
  );
  const folder = await s.storage.storage.from(BUCKET).list(s.folder, { limit: 100 });
  for (const entry of folder.data ?? []) paths.add(`${s.folder}/${entry.name}`);
  if (paths.size > 0) await s.storage.storage.from(BUCKET).remove([...paths]);
  await s.db.query('delete from public.news_articles where title like $1', [`${s.titlePrefix}%`]);
}

// aal2 の店長は worker ごとに 1 回だけ作る（試験ごとに作るとログインの回数の制限を使い切る）
let actorPromise: Promise<AdminSessionActor> | null = null;
const createdUserIds: string[] = [];

function sharedAal2Actor(db: PgClient): Promise<AdminSessionActor> {
  actorPromise ??= createAdminSessionActor(db, 'admin', 'aal2').then((actor) => {
    createdUserIds.push(actor.userId);
    return actor;
  });
  return actorPromise;
}

// afterAll は組の終わりごとに走る。消した利用者の JWT を同じ worker の次の組で使い回さないよう、作り置きも捨てる
test.afterAll(async () => {
  actorPromise = null;
  if (createdUserIds.length === 0) return;
  const admin = storageClient();
  for (const userId of createdUserIds.splice(0)) {
    // 監査の行が残っていて消せなくても db reset で消える
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

/** 店長（aal2）・試験ごとの題の頭・フォルダ・送り元で場面を作り、終わりに記事の行と置き場の物を消す */
async function withScenario(
  request: APIRequestContext,
  baseURL: string | undefined,
  run: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  await withPermissionScenario(async (db) => {
    const actor = await sharedAal2Actor(db);
    const tag = randomBytes(4).toString('hex');
    const scenario: Scenario = {
      db,
      request,
      actor,
      storage: storageClient(),
      origin: new URL(baseURL).origin,
      ip: uniqueIp(),
      titlePrefix: `E2E-NEWS-SEC005-${tag}`,
      folder: `news/e2e-sec005-${tag}`,
    };
    try {
      await run(scenario);
    } finally {
      await cleanup(scenario);
    }
  });
}

function writeHeaders(s: Scenario): Record<string, string> {
  return { ...bearerHeaders(s.actor), 'x-forwarded-for': s.ip, origin: s.origin };
}

type ImagePart = { name: string; mimeType: string; buffer: Buffer };

/** 作成・更新の本文（multipart）。image が無ければ画像の部分を付けない */
function articleForm(s: Scenario, label: string, image?: ImagePart): Record<string, string | ImagePart> {
  return {
    title: `${s.titlePrefix} ${label}`,
    category: 'EVENT',
    date: '2026-01-02',
    content: 'E2E content',
    detailedContent: 'E2E detailed content',
    status: 'private',
    ...(image ? { image } : {}),
  };
}

async function countSuccessAudits(db: PgClient, actorId: string, actions: readonly string[]): Promise<number> {
  const res = await db.query(
    `select count(*)::int as n from public.audit_logs
      where actor_id = $1::uuid and outcome = 'success' and action = any($2::text[])`,
    [actorId, actions],
  );
  return res.rows[0].n as number;
}

test.describe('FR-NEWS-SEC-005 管理の記事の書き込みの窓口', () => {
  test('SEC-NEWS-016-AC-01 記事を作ると、audit_logs に action が admin.news.create・resource_id が新しい記事の id の行が1件でき、IP の値が入っていない', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      const created = await request.post(LIST_PATH, {
        headers: writeHeaders(s),
        multipart: articleForm(s, 'create', { name: 'e2e.png', mimeType: 'image/png', buffer: makePng() }),
      });
      expect(created.status()).toBe(201);
      const id = String(((await created.json()) as { id: number | string }).id);

      const audits = await s.db.query(
        `select resource_id, ip from public.audit_logs where action = 'admin.news.create' and resource_id = $1`,
        [id],
      );
      expect(audits.rows).toHaveLength(1);
      // 送り元（x-forwarded-for）を付けて送っても、IP は記録しない（null か空）
      expect((audits.rows[0].ip as string | null) ?? '').toBe('');
    });
  });

  test('SEC-NEWS-016-AC-02 存在しない id への PUT・PATCH・DELETE はどれも 404 で、update・status_update・delete の成功の監査の行が増えない', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-NEWS-016 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    await withScenario(request, baseURL, async (s) => {
      const actions = ['admin.news.update', 'admin.news.status_update', 'admin.news.delete'] as const;
      const before = await countSuccessAudits(s.db, s.actor.userId, actions);

      const put = await request.put(one(MISSING_ID), { headers: writeHeaders(s), multipart: articleForm(s, 'missing-put') });
      const patch = await request.patch(one(MISSING_ID), { headers: writeHeaders(s), data: { status: 'published' } });
      const del = await request.delete(one(MISSING_ID), { headers: writeHeaders(s) });

      expect({ put: put.status(), patch: patch.status(), delete: del.status() }).toEqual({ put: 404, patch: 404, delete: 404 });
      expect(await countSuccessAudits(s.db, s.actor.userId, actions)).toBe(before);
    });
  });

  test('SEC-NEWS-017-AC-01 中身が HTML で type を image/png と付けたファイルの POST は 400 になり、置き場にファイルが増えない', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-NEWS-017 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    await withScenario(request, baseURL, async (s) => {
      const before = await bucketObjectCount(s.db);

      const res = await request.post(LIST_PATH, {
        headers: writeHeaders(s),
        multipart: articleForm(s, 'html-as-png', {
          name: 'fake.png',
          mimeType: 'image/png',
          buffer: Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>', 'utf8'),
        }),
      });

      expect(res.status()).toBe(400);
      expect(await bucketObjectCount(s.db)).toBe(before);
    });
  });

  test('SEC-NEWS-017-AC-02 名前が x.html の PNG の画像で PUT した後、記事の image_url の道筋が .png で終わる', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-NEWS-017 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    await withScenario(request, baseURL, async (s) => {
      const id = await seedArticle(s, 'put-ext', `${s.folder}/before.png`);

      const res = await request.put(one(id), {
        headers: writeHeaders(s),
        multipart: articleForm(s, 'put-ext', { name: 'x.html', mimeType: 'image/png', buffer: makePng() }),
      });
      expect(res.status()).toBe(200);

      const imageUrl = await readImageUrl(s.db, id);
      expect(imageUrl, '記事の image_url').not.toBeNull();
      expect(imageUrl as string).toMatch(/\.png$/);
    });
  });

  test('SEC-NEWS-017-AC-03 5MB を超える PNG の POST は 400 になり、応答の error が Image size must be 5MB or less である', async ({ request, baseURL }) => {
    await withScenario(request, baseURL, async (s) => {
      // PNG の signature・各 chunk は正しく、大きさだけが上限を 1 バイト超える
      const base = makePng().length;
      const big = makePng(MAX_IMAGE_BYTES + 1 - base);
      expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES);

      const res = await request.post(LIST_PATH, {
        headers: writeHeaders(s),
        multipart: articleForm(s, 'too-big', { name: 'big.png', mimeType: 'image/png', buffer: big }),
      });

      expect(res.status()).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('Image size must be 5MB or less');
    });
  });

  test('SEC-NEWS-018-AC-01 記事の DELETE が 200 になった後、その記事の画像の道筋が置き場の一覧に無い', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-NEWS-018 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    await withScenario(request, baseURL, async (s) => {
      const imagePath = await seedObject(s, 'delete-target.png');
      const id = await seedArticle(s, 'delete', imagePath);
      // 前提: 消す前は、画像が置き場の一覧にある
      expect(await objectExists(s, imagePath)).toBe(true);

      const res = await request.delete(one(id), { headers: writeHeaders(s) });
      expect(res.status()).toBe(200);

      expect(await objectExists(s, imagePath)).toBe(false);
    });
  });

  test('SEC-NEWS-018-AC-02 新しい画像を付けた PUT が 200 になった後、前の画像の道筋が置き場の一覧に無い', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-NEWS-018 今のコードは満たさない（docs/02_Requirements/areas/news.md）');
    await withScenario(request, baseURL, async (s) => {
      const previousPath = await seedObject(s, 'previous.png');
      const id = await seedArticle(s, 'replace', previousPath);
      // 前提: 差し替える前は、前の画像が置き場の一覧にある
      expect(await objectExists(s, previousPath)).toBe(true);

      const res = await request.put(one(id), {
        headers: writeHeaders(s),
        multipart: articleForm(s, 'replace', { name: 'next.png', mimeType: 'image/png', buffer: makePng() }),
      });
      expect(res.status()).toBe(200);
      // 差し替わったこと（記事が新しい道筋を指す）
      expect(await readImageUrl(s.db, id)).not.toBe(previousPath);

      expect(await objectExists(s, previousPath)).toBe(false);
    });
  });
});
