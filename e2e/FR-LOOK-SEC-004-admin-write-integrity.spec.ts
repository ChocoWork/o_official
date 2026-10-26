/**
 * 管理の LOOK の書き込みの窓口（POST /api/admin/looks、PUT・PATCH・DELETE /api/admin/looks/[id]、GET /api/admin/looks/[id]）の
 * 書き込みの保全（LOOK 領域）。
 * 受け入れ条件: SEC-LOOK-012-AC-01・AC-02・AC-03（大きさ・枚数・1時間の量）、013-AC-01・AC-02（画像の中身・保存の名前）、
 * 014-AC-01・AC-02（消した・差し替えた画像を置き場から消す）、015-AC-01（更新が失敗しても前の LOOK が残る）、
 * 020-AC-01・AC-02（監査の行と送り元）。021-AC-01・022-AC-02（置き場・looks の読みを全体で壊す試験）は FR-LOOK-SEC-005（isolated-global の project）にある。
 *
 * 道: 本番ビルドの窓口へ Playwright の request で直に要求する（画面幅は応答に関係しないので1回だけ流す。70MB 級の送信と行の見える時間を3倍にしない）。
 * 015-AC-01 だけは、失敗した更新の後の公開の頁 /look/<id> を3つの幅のブラウザで開いて確かめる。
 * 管理者は手元の Supabase の本物の JWT（店長・aal2。e2e/admin-session-test-utils.ts）を Authorization: Bearer で送る。
 * Cookie を送らないので CSRF の token は要らない。変更の要求には許可のオリジン（Origin）を付ける。
 * LOOK の行・監査の行・置き場の物は、手元の DB と service role の Storage で作る・読む（手元の Supabase の物だけを触る）。
 *
 * 場面ごとに新しい店長（aal2）と送り元（x-forwarded-for）を作る。回数の制限と1時間の量は操作者・送り元ごとに数えるので、
 * 試験どうしで数えが混ざらない。場面は withPermissionScenario の lock の中で流し、置き場の物の数（012-AC-01・013-AC-01）を
 * 数える間、同じ lock を使う別の試験の書き込みと混ざらないようにする。
 * describe を serial にしないのは、赤になる試験の後ろの試験を飛ばさないため（直列にするのは lock の役目）。
 *
 * 作る LOOK は status='private' で作り、公開の頁に出す試験（015-AC-01）と状態の変更を送る試験（020）だけ、
 * created_at を 2000-01-01 に直してから公開にして、ほかの試験が「先頭の LOOK」を選ぶ並びに入らないようにする。
 * LOOK の行（look_items ごと）と、行が指していた置き場の物は、終わりに必ず消す（赤の時に残った物も含む）。
 * 作った利用者・session・監査の行は消さない（db reset で消える）。
 *
 * 現行のコードが満たさない AC（文のとおりに書いてあり、緩めない。コードが直るまで赤）:
 * 012-AC-03（作成と更新を別々に数える）、015-AC-01（更新が1つのまとまりでない）、020-AC-02（送り元を監査に渡さない）。
 * 013-AC-01・AC-02（画像の中身で種類を確かめ、保存名を自分で作る）と 014-AC-01・AC-02（消した・差し替えた画像を置き場から消す）は直した。
 * 012-AC-01・AC-02、013-AC-01・AC-02、014-AC-01・AC-02、020-AC-01 は満たす見込み。
 *
 * 置き場の物の数（012-AC-01・013-AC-01）は、ほかの spec（管理画面の作成など）が同時に上げる物と混ざらないよう、
 * 断られた画像と同じ大きさ（バイト数）の物だけを数える。
 */
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { bearerHeaders, createAdminSessionActor, type AdminSessionActor } from './admin-session-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import { withPermissionScenario } from './permission-settings-test-utils';

// 管理者の JWT を通信記録に残さないため、ファイルの先頭で無効にする。
test.use({ trace: 'off' });
// lock の待ち時間と、70MB 級の送信（012-AC-03）を含めた時間
test.describe.configure({ timeout: 600_000 });

const LIST_PATH = '/api/admin/looks';
const one = (id: number | string): string => `/api/admin/looks/${id}`;
const BUCKET = 'look-images';
const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * MIB;
const REQUEST_TIMEOUT = 300_000;

type Scenario = {
  db: PgClient;
  actor: AdminSessionActor;
  /** service role の Storage（手元の Supabase だけ） */
  storage: SupabaseClient;
  origin: string;
  /** この場面だけの送り元（x-forwarded-for） */
  ip: string;
  /** LOOK の theme の頭。この頭で始まる行が、この場面が作った行 */
  themePrefix: string;
  /** この場面が使う公開の商品の id（2件） */
  itemIds: [number, number];
  /** この場面で作られた置き場の道筋（行を消す・差し替えると行から辿れなくなるので、覚えておく） */
  paths: Set<string>;
};

type Img = { name: string; type: string; buffer: Buffer };

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

/** ちょうど bytes バイトの本物の PNG */
function pngOfSize(bytes: number): Buffer {
  const png = makePng(bytes - makePng().length);
  if (png.length !== bytes) throw new Error(`PNG の大きさが合わない（${png.length} / ${bytes}）`);
  return png;
}

function png(name: string, buffer: Buffer = makePng()): Img {
  return { name, type: 'image/png', buffer };
}

function uniqueIp(): string {
  const groups = randomBytes(12).toString('hex').match(/.{4}/g) ?? [];
  return `2001:db8:${groups.join(':')}`;
}

function storageClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey || !isLocalUrl(url)) throw new Error('置き場を直に触れるのは手元の Supabase だけ');
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** 置き場の物を、フォルダの一覧（service role の Storage API）から探す */
async function objectExists(s: Scenario, path: string): Promise<boolean> {
  const cut = path.lastIndexOf('/');
  const dir = path.slice(0, cut);
  const name = path.slice(cut + 1);
  const { data, error } = await s.storage.storage.from(BUCKET).list(dir, { search: name, limit: 100 });
  if (error) throw new Error(`置き場の一覧を読めない: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === name);
}

/**
 * 置き場 look-images の `looks/` の下で、ちょうど sizeBytes バイトの物の数。
 * 大きさが他と重ならない画像を送った試験が、その画像が置かれていないことを確かめるのに使う（ほかの spec の上げた物を数えない）。
 */
async function looksObjectCountOfSize(db: PgClient, sizeBytes: number): Promise<number> {
  const res = await db.query(
    `select count(*)::int as n from storage.objects where bucket_id = $1 and name like 'looks/%' and (metadata->>'size')::bigint = $2::bigint`,
    [BUCKET, sizeBytes],
  );
  return res.rows[0].n as number;
}

async function readImageUrls(db: PgClient, id: number): Promise<string[]> {
  const res = await db.query('select image_urls from public.looks where id = $1::bigint', [id]);
  return (res.rows[0]?.image_urls as string[] | undefined) ?? [];
}

/** LOOK の今の image_urls を、この場面の「置き場の道筋」に覚えさせ、その道筋を返す */
async function track(s: Scenario, id: number): Promise<string[]> {
  const urls = await readImageUrls(s.db, id);
  for (const url of urls) s.paths.add(url);
  return urls;
}

/** この場面の LOOK の行（look_items ごと）と、行・覚えた道筋が指す置き場の物を消す（赤の時に残った物も含む） */
async function cleanup(s: Scenario): Promise<void> {
  const rows = await s.db.query('select id, image_urls from public.looks where theme like $1', [`${s.themePrefix}%`]);
  const ids: number[] = [];
  for (const row of rows.rows as Array<{ id: number | string; image_urls: string[] | null }>) {
    ids.push(Number(row.id));
    for (const url of row.image_urls ?? []) s.paths.add(url);
  }
  if (s.paths.size > 0) await s.storage.storage.from(BUCKET).remove([...s.paths]);
  if (ids.length > 0) {
    await s.db.query('delete from public.look_items where look_id = any($1::bigint[])', [ids]);
    await s.db.query('delete from public.looks where id = any($1::bigint[])', [ids]);
  }
}

/** 新しい店長（aal2）・場面ごとの theme の頭・送り元で場面を作り、終わりに LOOK の行と置き場の物を消す */
async function withScenario(baseURL: string | undefined, run: (scenario: Scenario) => Promise<void>): Promise<void> {
  if (!baseURL) throw new Error('baseURL が無い（playwright.config.ts）');
  await withPermissionScenario(async (db) => {
    const actor = await createAdminSessionActor(db, 'admin', 'aal2');
    const items = await db.query(`select id from public.items where status = 'published' order by id limit 2`);
    if (items.rows.length < 2) throw new Error('手元の DB に公開の商品が2件無い（supabase/seed.sql）');
    const scenario: Scenario = {
      db,
      actor,
      storage: storageClient(),
      origin: new URL(baseURL).origin,
      ip: uniqueIp(),
      themePrefix: `E2E-LOOK-SEC004-${randomBytes(4).toString('hex')}`,
      itemIds: [Number(items.rows[0].id), Number(items.rows[1].id)],
      paths: new Set<string>(),
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

/** 作成・更新の本文（multipart）。images が空なら画像の部分を付けない */
function lookForm(
  s: Scenario,
  label: string,
  options: { images?: Img[]; status?: 'private' | 'published'; itemIds?: number[] } = {},
): FormData {
  const form = new FormData();
  form.append('seasonYear', '2099');
  form.append('seasonType', 'SS');
  form.append('theme', `${s.themePrefix} ${label}`);
  form.append('themeDescription', 'E2E description');
  form.append('status', options.status ?? 'private');
  form.append('linkedItemIds', JSON.stringify(options.itemIds ?? [s.itemIds[0]]));
  for (const image of options.images ?? []) {
    form.append('images', new Blob([new Uint8Array(image.buffer)], { type: image.type }), image.name);
  }
  return form;
}

async function postLook(
  request: APIRequestContext,
  s: Scenario,
  label: string,
  options: Parameters<typeof lookForm>[2] = {},
) {
  return request.post(LIST_PATH, { headers: writeHeaders(s), multipart: lookForm(s, label, options), timeout: REQUEST_TIMEOUT });
}

async function putLook(
  request: APIRequestContext,
  s: Scenario,
  id: number,
  label: string,
  options: Parameters<typeof lookForm>[2] = {},
) {
  return request.put(one(id), { headers: writeHeaders(s), multipart: lookForm(s, label, options), timeout: REQUEST_TIMEOUT });
}

/** 画像1枚つきの LOOK を窓口で作り（201 を前提にする）、id を返す。作った画像の道筋は場面に覚えさせる */
async function createLook(
  request: APIRequestContext,
  s: Scenario,
  label: string,
  options: Parameters<typeof lookForm>[2] = {},
): Promise<number> {
  const res = await postLook(request, s, label, { images: [png('seed.png')], ...options });
  expect(res.status(), '前提: 作成が 201').toBe(201);
  const id = Number(((await res.json()) as { id: number | string }).id);
  await track(s, id);
  return id;
}

/** 公開の頁に出す LOOK は、ほかの試験が「先頭の LOOK」に選ばない並びの最後へ送ってから公開にする */
async function publishAtTheEnd(s: Scenario, id: number): Promise<void> {
  await s.db.query(`update public.looks set created_at = '2000-01-01', status = 'published' where id = $1::bigint`, [id]);
}

test.describe('FR-LOOK-SEC-004 管理の LOOK の書き込みの保全（窓口への直接の要求）', () => {
  test('SEC-LOOK-012-AC-01 5MB を超える画像を1枚含む作成は 400 になり、置き場の looks/ の下のオブジェクトの数が増えない', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      const tooBig = pngOfSize(MAX_IMAGE_BYTES + 1);
      const before = await looksObjectCountOfSize(s.db, tooBig.length);

      const res = await postLook(request, s, 'too-big', { images: [png('big.png', tooBig)] });

      expect(res.status()).toBe(400);
      expect(await looksObjectCountOfSize(s.db, tooBig.length), '5MB+1 バイトの物が置き場に増えない').toBe(before);
    });
  });

  test('SEC-LOOK-012-AC-02 画像を7枚含む作成と更新が、どちらも 400 になる', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      const sevenImages = Array.from({ length: 7 }, (_, index) => png(`seven-${index}.png`));
      const id = await createLook(request, s, 'seven-target');

      const created = await postLook(request, s, 'seven-create', { images: sevenImages });
      const updated = await putLook(request, s, id, 'seven-update', { images: sevenImages });

      expect({ create: created.status(), update: updated.status() }).toEqual({ create: 400, update: 400 });
    });
  });

  test('SEC-LOOK-012-AC-03 同じ操作者が1時間に作成で40MB・更新で30MB を送ると、合計が60MB を超えた要求が 429 になる', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-LOOK-012-AC-03 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
    await withScenario(baseURL, async (s) => {
      // 1回の要求は 10MB 未満にする。proxy.ts が全部の要求に掛かり、Next の proxyClientMaxBodySize（既定 10MB）を超えた本文は
      // 先頭の 10MB で切られて formData() が投げるため、20MB の1回では量の上限まで届かない（SEC-LOOK-012 の「1回 20MB」とは別に記録した食い違い）
      const big = png('five-mib.png', pngOfSize(MAX_IMAGE_BYTES));
      const small = png('three-mib.png', pngOfSize(3 * MIB));
      const half = png('two-and-half-mib.png', pngOfSize(2.5 * MIB));

      // 作成は 8MB（5MB + 3MB）を5回 = 40MB
      const firstId = await createLook(request, s, 'quota-create-1', { images: [big, small] });
      for (let n = 2; n <= 5; n += 1) {
        const created = await postLook(request, s, `quota-create-${n}`, { images: [big, small] });
        expect(created.status(), `作成の${n}回目（累計 ${n * 8}MB）`).toBe(201);
        await track(s, Number(((await created.json()) as { id: number | string }).id));
      }

      // 更新は 7.5MB（5MB + 2.5MB）。1回目で累計 47.5MB、2回目で 55MB は 60MB の内
      for (let n = 1; n <= 2; n += 1) {
        const updated = await putLook(request, s, firstId, `quota-update-${n}`, { images: [big, half] });
        await track(s, firstId);
        expect(updated.status(), `更新の${n}回目（累計 ${40 + n * 7.5}MB）`).toBe(200);
      }

      // 3回目で累計 62.5MB（作成 40MB + 更新 22.5MB）は 1 時間の 60MB を超える。作成と更新を別々に数えると 429 にならない
      const updateThird = await putLook(request, s, firstId, 'quota-update-3', { images: [big, half] });
      await track(s, firstId);
      expect(updateThird.status(), '更新の3回目（累計 62.5MB で 60MB を超える）').toBe(429);
    });
  });

  test('SEC-LOOK-013-AC-01 type を image/png と申告した、中身が文字のファイルの作成は 400 になり、置き場にオブジェクトが増えない', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      // 他の spec の画像と大きさが重ならない文字の列（毎回違う長さ）
      const text = Buffer.from(`this is plain text, not an image ${'x'.repeat(1000 + randomBytes(1)[0])}`, 'utf8');
      const before = await looksObjectCountOfSize(s.db, text.length);

      const res = await postLook(request, s, 'text-as-png', { images: [{ name: 'x.png', type: 'image/png', buffer: text }] });

      expect(res.status()).toBe(400);
      expect(await looksObjectCountOfSize(s.db, text.length), '文字のファイルが置き場に増えない').toBe(before);
    });
  });

  test('SEC-LOOK-013-AC-02 名前を a/b.html にした PNG で作った LOOK の image_urls の道筋が looks/<日付>/<uuid>.png の形で、/ が2つで .html を含まない', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      const res = await postLook(request, s, 'name-a-b-html', { images: [png('a/b.html')] });
      expect(res.status(), '前提: 作成が 201').toBe(201);
      const id = Number(((await res.json()) as { id: number | string }).id);

      const urls = await track(s, id);
      expect(urls, 'image_urls の件数').toHaveLength(1);
      const path = urls[0];
      expect(path).toMatch(/^looks\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
      expect(path.split('/').length - 1, '道筋の / の数').toBe(2);
      expect(path).not.toContain('.html');
    });
  });

  test('SEC-LOOK-014-AC-01 LOOK を作って DELETE した後、その LOOK の image_urls の道筋のオブジェクトが置き場に無い', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      const id = await createLook(request, s, 'delete-target');
      const urls = await readImageUrls(s.db, id);
      expect(urls, '前提: 画像が1枚').toHaveLength(1);
      expect(await objectExists(s, urls[0]), '前提: 消す前は置き場にある').toBe(true);

      const res = await request.delete(one(id), { headers: writeHeaders(s) });
      expect(res.status()).toBe(200);

      expect(await objectExists(s, urls[0])).toBe(false);
    });
  });

  test('SEC-LOOK-014-AC-02 画像を差し替えた PUT の後、前の image_urls の道筋のオブジェクトが置き場に無い', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      const id = await createLook(request, s, 'replace-target');
      const previous = await readImageUrls(s.db, id);
      expect(previous, '前提: 画像が1枚').toHaveLength(1);
      expect(await objectExists(s, previous[0]), '前提: 差し替える前は置き場にある').toBe(true);

      const res = await putLook(request, s, id, 'replace-target', { images: [png('next.png')] });
      expect(res.status()).toBe(200);
      const next = await track(s, id);
      expect(next, '差し替わったこと（別の道筋を指す）').not.toEqual(previous);

      expect(await objectExists(s, previous[0])).toBe(false);
    });
  });

  /** 作成・更新・状態の変更・削除を1回ずつ送り、LOOK の id を返す（4回とも成功を前提にする） */
  async function runFourMutations(request: APIRequestContext, s: Scenario): Promise<number> {
    const id = await createLook(request, s, 'audit-create');
    const put = await putLook(request, s, id, 'audit-update');
    expect(put.status(), '前提: 更新が 200').toBe(200);
    await s.db.query(`update public.looks set created_at = '2000-01-01' where id = $1::bigint`, [id]);
    const patch = await request.patch(one(id), { headers: writeHeaders(s), data: { status: 'published' } });
    expect(patch.status(), '前提: 状態の変更が 200').toBe(200);
    const del = await request.delete(one(id), { headers: writeHeaders(s) });
    expect(del.status(), '前提: 削除が 200').toBe(200);
    return id;
  }

  type AuditRow = { action: string | null; actor_id: string | null; outcome: string | null; ip: string | null };

  async function readLookAudits(s: Scenario): Promise<AuditRow[]> {
    const res = await s.db.query(
      `select action, actor_id, outcome, ip from public.audit_logs where resource = 'look' and actor_id = $1::uuid order by created_at`,
      [s.actor.userId],
    );
    return res.rows as AuditRow[];
  }

  test('SEC-LOOK-020-AC-01 作成・更新・状態の変更・削除を1回ずつ送ると、audit_logs に resource が look の行が4つ増え、それぞれに操作者の ID・操作の名前・結果が入っている', async ({ request, baseURL }) => {
    await withScenario(baseURL, async (s) => {
      const before = await readLookAudits(s);

      await runFourMutations(request, s);

      const rows = (await readLookAudits(s)).slice(before.length);
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.actor_id, '操作者の ID').toBe(s.actor.userId);
        expect((row.action ?? '').trim(), '操作の名前').not.toBe('');
        expect((row.outcome ?? '').trim(), '結果').not.toBe('');
      }
      // 4つの変更の道それぞれが別の操作の名前で残っている
      expect(new Set(rows.map((row) => row.action)).size).toBe(4);
    });
  });

  test('SEC-LOOK-020-AC-02 作成・更新・状態の変更・削除の監査の行の ip の列が、4つとも空でない', async ({ request, baseURL }) => {
    test.fail(true, 'SEC-LOOK-020-AC-02 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
    await withScenario(baseURL, async (s) => {
      const before = await readLookAudits(s);

      await runFourMutations(request, s);

      const rows = (await readLookAudits(s)).slice(before.length);
      expect(rows, '前提: 監査の行が4つ').toHaveLength(4);
      for (const row of rows) {
        expect((row.ip ?? '').trim(), `${row.action} の ip`).not.toBe('');
      }
    });
  });
});

// 015-AC-01 だけは公開の頁をブラウザで開いて確かめるので、3つの幅で流す（上の窓口への直接の要求は幅に関係しないので1回）
for (const viewport of viewports) {
  test.describe(`FR-LOOK-SEC-004 更新の失敗の後の公開の頁 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`SEC-LOOK-015-AC-01 ${viewport.name}: 関連の追加が失敗した更新の後に /look/<id> を開くと、前のテーマと前の関連商品が表示される`, async ({ page, request, baseURL }) => {
      test.fail(true, 'SEC-LOOK-015-AC-01 今のコードは満たさない（docs/02_Requirements/areas/look.md）');
      await withScenario(baseURL, async (s) => {
        const [oldItem, newItem] = s.itemIds;
        const oldTheme = `${s.themePrefix} before-update`;
        const newTheme = `${s.themePrefix} after-update`;
        const id = await createLook(request, s, 'before-update', { itemIds: [oldItem] });
        await publishAtTheEnd(s, id);
        expect(
          (await s.db.query('select item_id from public.look_items where look_id = $1::bigint', [id])).rows.map((row) => Number(row.item_id)),
          '前提: 前の関連商品',
        ).toEqual([oldItem]);

        // この LOOK の look_items への追加だけを失敗させる（ほかの LOOK・試験には効かない）
        const name = `e2e_fail_look_items_${randomBytes(4).toString('hex')}`;
        await s.db.query(
          `create function public.${name}() returns trigger language plpgsql as $$ begin raise exception 'e2e forced look_items failure'; end $$;
           create trigger ${name} before insert on public.look_items for each row when (new.look_id = ${Number(id)}) execute function public.${name}();`,
        );
        try {
          const res = await putLook(request, s, id, 'after-update', { status: 'published', itemIds: [newItem] });
          expect(res.status(), '関連の追加が失敗した更新は 500').toBe(500);
          expect(((await res.json()) as { error?: unknown }).error, '失敗は関連の追加の段（look_items の insert）で起きた').toBe('Failed to update linked items');
        } finally {
          await s.db.query(`drop trigger if exists ${name} on public.look_items; drop function if exists public.${name}();`);
        }

        await page.goto(`/look/${id}`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(oldTheme);
        await expect(page.getByText(newTheme)).toHaveCount(0);
        await expect(page.locator(`a[href="/item/${oldItem}"]`).first()).toBeVisible();
        await expect(page.locator(`a[href="/item/${newItem}"]`)).toHaveCount(0);
      });
    });
  });
}
