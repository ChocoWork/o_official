import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { SEED_IMAGE_PNG_BASE64 } from '../scripts/e2e/seed-storage';
import { isLocalUrl } from '../scripts/e2e/environment';
import type {
  ApproveReturnInput, ShopReturnSettings, ShopReturnSettingsUpdate,
} from '@/lib/orders/returns/return-types';
import type { CustomerReturnRequestMaterials, CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';
import { listOrderReturns, loadReturnCreateMaterials } from '@/lib/orders/returns/return-store';
import { listOrderCancelRequests } from '@/lib/orders/returns/cancel-request-store';
import { buildShopReturnSettings } from '../tests/unit/components/shop-return-settings-test-fixtures';
import { createTestMember, loginAsMember, type TestMember } from './member-session-helpers';
import {
  withLocalDb, createOrderWithLines, createActor, mailBodies,
  runWorkerUntil, runWorkerOnce, recordRefundResult, type E2eOrderLine,
} from './order-email-test-utils';
import { fulfillJson, openOrderTab, orderNumberOf, orderLine, viewports } from './order-fulfillment-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import {
  createShippedOrder, receiveReturnInDb, returnLabelOf, SHOP_ALERT_TO,
  newReturnRouteState, mockReturnRoutes, orderWithReturns, returnSummaryOf,
  type ReturnFixture,
} from './return-test-utils';

export { expect, viewports };
export type JsonBody = Record<string, unknown>;
export type RequestLine = {
  fulfillmentId: string; orderItemId: string; quantity: number; reason: string;
  customerNote: string | null; requestedResolution: 'refund' | 'exchange';
  requestedExchangeVariantId: number | null; photoUploadIds: string[];
};
export type RR = {
  db: PgClient; member: TestMember; ip: string; client: ReturnType<typeof storageClient>;
  login: () => Promise<void>;
  setItem: (id: number, value: boolean) => Promise<void>;
};

function storageClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('手元の Storage だけを使う');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// アプリが画面から出す /api/orders/** の要求の分。ログインの要求は page.request から出るので loginAsMember の第3引数で付ける。
export async function isolateOrderApiIp(page: Page): Promise<string> {
  const bits = randomUUID().replaceAll('-', '');
  const ip = '2001:db8:' + (bits.match(/.{4}/g) ?? []).slice(0, 6).join(':');
  await page.route('**/api/orders/**', async (route) => {
    const target = new URL(route.request().url());
    const origin = new URL(page.url()).origin;
    if (!isLocalUrl(target.origin) || target.origin !== origin) {
      await route.fallback();
      return;
    }
    await route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': ip } });
  });
  return ip;
}

export const test = base.extend<{ rr: RR }>({
  rr: [async ({ page }, provide, info) => {
    // ロックの待ちは下の fixture の timeout が持つ。試験の時間は、メールの待ち（最大90秒）を含めて3分。
    info.setTimeout(180_000);
    await withLocalDb(async (db) => {
      // 設定の1行を読む顧客試験どうしで、受付オンとオフを混ぜないため。
      await db.query('select pg_advisory_lock(14314, 2)');
      const saved = (await db.query(
        'select requests_enabled, request_types, notice_text from public.shop_return_settings where id = 1',
      )).rows[0];
      const changedItems = new Map<number, boolean>();
      try {
        const member = await createTestMember('e3s2');
        const ip = await isolateOrderApiIp(page);
        await db.query(
          "update public.shop_return_settings set requests_enabled = true, request_types = 'returns_only', notice_text = '' where id = 1",
        );
        let loggedIn = false;
        await provide({
          db, member, ip, client: storageClient(),
          login: async () => {
            // ログインの要求は page.request から出て page.route を通らないので、同じ ip を第3引数で渡す。
            if (!loggedIn) { await loginAsMember(page, member, ip); loggedIn = true; }
          },
          setItem: async (id, value) => {
            if (!changedItems.has(id)) {
              const row = (await db.query('select return_ineligible from public.items where id = $1', [id])).rows[0];
              if (!row) throw new Error('試験の商品が無い');
              changedItems.set(id, row.return_ineligible as boolean);
            }
            await db.query('update public.items set return_ineligible = $2 where id = $1', [id, value]);
          },
        });
      } finally {
        for (const [id, value] of changedItems) {
          await db.query('update public.items set return_ineligible = $2 where id = $1', [id, value]);
        }
        await db.query(
          'update public.shop_return_settings set requests_enabled = $1, request_types = $2, notice_text = $3 where id = 1',
          [saved.requests_enabled, saved.request_types, saved.notice_text],
        );
        await db.query('select pg_advisory_unlock(14314, 2)');
      }
    });
  }, { auto: true, timeout: 600_000 }],
});

export async function appJson<T>(page: Page, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  if (!path.startsWith('/api/orders/')) throw new Error('注文の窓口だけを呼ぶ');
  return page.evaluate(async ({ path, body }) => {
    const token = document.cookie.split('; ').find((entry) => entry.startsWith('sb-csrf-token='))
      ?.split('=').slice(1).join('=');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (body !== undefined) {
      if (!token) throw new Error('CSRF の印が無い');
      headers['x-csrf-token'] = token;
    }
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { path, body }) as Promise<{ status: number; body: T }>;
}

export async function shipped(rr: RR, lines: E2eOrderLine[] = [
  { name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' },
]): Promise<ReturnFixture> {
  return createShippedOrder(rr.db, 'e3s2', lines, { userId: rr.member.userId, email: rr.member.email });
}
export async function unshipped(rr: RR, status: 'pending' | 'paid' = 'paid', quantity = 3) {
  const order = await createOrderWithLines(rr.db, rr.member.email,
    [{ name: 'E2Eシャツ', quantity, fulfillmentType: 'stock' }],
    { status, userId: rr.member.userId, paidAmount: status === 'paid' ? 'total' : undefined,
      paymentIntentId: status === 'paid' ? 'pi_e2e_' + randomUUID().replaceAll('-', '') : undefined });
  return { ...order, actorId: await createActor(rr.db) };
}
export async function expired(rr: RR): Promise<ReturnFixture> {
  const fx = await createOrderWithLines(rr.db, rr.member.email,
    [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }],
    { userId: rr.member.userId, paidAmount: 'total', paymentIntentId: 'pi_e2e_' + randomUUID().replaceAll('-', '') });
  // 発送の時刻は INSERT で古くする。注文の持ち主と発送の記録を書き換えない。
  const shipment = (await rr.db.query(
    'insert into public.order_fulfillments(order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at) ' +
    "values($1,1,gen_random_uuid(),'yamato','E2E-OLD',false,false,now()-interval '40 days') returning id",
    [fx.orderId],
  )).rows[0].id as string;
  await rr.db.query('insert into public.order_fulfillment_lines(fulfillment_id,order_item_id,quantity) values($1,$2,1)',
    [shipment, fx.orderItemIds[0]]);
  return {
    orderId: fx.orderId, orderItemIds: fx.orderItemIds, itemId: fx.itemId, variantId: fx.variantId,
    actorId: await createActor(rr.db), email: rr.member.email, fulfillmentId: shipment, fulfillmentIds: [shipment],
  };
}
/** 同じ商品に、もうある色の別のサイズを足して番号を返す。色の名前は商品ごとに一意なので、addVariant で同じ色を2回は足せない */
export async function addSizeVariant(db: PgClient, itemId: number, colorName: string, size: string, stock = 0): Promise<number> {
  const color = (await db.query('select id from public.item_colors where item_id = $1 and name = $2', [itemId, colorName])).rows[0];
  if (!color) throw new Error('試験の色が無い');
  const label = (await db.query(
    'insert into public.item_sizes (item_id, label, position) values ($1, $2, 1) returning id', [itemId, size],
  )).rows[0];
  const variant = Number((await db.query(
    'insert into public.item_variants (item_id, color_id, size_id, is_active) values ($1, $2, $3, true) returning id',
    [itemId, color.id, label.id],
  )).rows[0].id);
  if (stock > 0) {
    await db.query("insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')", [variant, stock]);
  }
  return variant;
}
export function line(fx: ReturnFixture, index = 0, extra: Partial<RequestLine> = {}): RequestLine {
  return {
    fulfillmentId: fx.fulfillmentId, orderItemId: fx.orderItemIds[index], quantity: 1, reason: 'other',
    customerNote: '試験の詳しい内容', requestedResolution: 'refund',
    requestedExchangeVariantId: null, photoUploadIds: [], ...extra,
  };
}
export async function materials(page: Page, orderId: string): Promise<CustomerReturnRequestMaterials> {
  const response = await appJson<{ data: CustomerReturnRequestMaterials }>(page, '/api/orders/' + orderId + '/return-request');
  expect(response.status).toBe(200);
  return response.body.data;
}
export async function section(page: Page, orderId: string): Promise<CustomerOrderReturns> {
  const response = await appJson<{ returnSection: CustomerOrderReturns }>(page, '/api/orders/' + orderId);
  expect(response.status).toBe(200);
  expect(response.body.returnSection === null).toBe(false);
  return response.body.returnSection;
}
export async function openRequest(page: Page, rr: RR, orderId: string): Promise<void> {
  await rr.login();
  await page.goto('/account/orders/' + orderId + '/return');
  await expect(page.getByRole('heading', { name: '返品・交換のお申し込み', exact: true })).toBeVisible();
}
export function product(page: Page, name = 'E2Eシャツ') {
  return page.getByRole('group', { name: name + '（ホワイト / M）', exact: true });
}
export async function pick(page: Page, name = 'E2Eシャツ', reason = 'other') {
  const row = product(page, name);
  await row.getByRole('checkbox', { name: 'この商品を申し込む', exact: true }).check();
  await row.getByRole('combobox', { name: '理由', exact: true }).selectOption(reason);
  if (reason === 'other' || reason === 'defective') {
    await row.getByRole('textbox', { name: '詳しい内容（必須・300字まで）', exact: true }).fill('試験の詳しい内容');
  }
  return row;
}
export async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
}
export async function requestDb(rr: RR, fx: ReturnFixture, lines = [line(fx)]) {
  const dbLines = [];
  for (const item of lines) {
    const photos = (await rr.db.query(
      'select id, storage_path from public.order_return_photo_uploads where id = any($1::uuid[])',
      [item.photoUploadIds],
    )).rows;
    const metas = [];
    for (const photo of photos) {
      const bytes = await readObject(rr, photo.storage_path as string);
      metas.push({ upload_id: photo.id, content_type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg', size_bytes: bytes.length });
    }
    dbLines.push({
      fulfillment_id: item.fulfillmentId, order_item_id: item.orderItemId, quantity: item.quantity,
      reason: item.reason, customer_note: item.customerNote, requested_resolution: item.requestedResolution,
      requested_exchange_variant_id: item.requestedExchangeVariantId, photos: metas,
    });
  }
  const row = (await rr.db.query(
    'select * from public.customer_request_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
    [fx.orderId, rr.member.userId, randomUUID(), JSON.stringify(dbLines)],
  )).rows[0];
  return { id: row.return_id as string, number: Number(row.number) };
}
export async function approveDb(rr: RR, returnId: string, body: Omit<ApproveReturnInput, 'returnId' | 'actorId'>, actorId: string) {
  const rows = body.lines.map((item) => ({
    return_line_id: item.returnLineId, resolution: item.resolution,
    exchange_variant_id: item.exchangeVariantId ?? null, exchange_method: item.exchangeMethod ?? null,
  }));
  return (await rr.db.query(
    'select * from public.admin_approve_return($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text,$6::text,$7::text,$8::integer,$9::integer,$10::integer,$11::integer,$12::text,$13::boolean)',
    [returnId, actorId, JSON.stringify(rows), body.returnMethod, body.returnShippingPayer,
      body.returnCarrier ?? null, body.returnTrackingNumber ?? null, body.returnShippingFee,
      body.restockingFeePercent, body.exchangeFee, body.exchangeShippingFee, body.shopNote ?? null, body.notifyCustomer],
  )).rows[0];
}
export async function defaultApproval(rr: RR, fx: ReturnFixture, returnId: string) {
  const detail = (await listOrderReturns(rr.client, fx.orderId)).find((item) => item.id === returnId);
  if (!detail) throw new Error('試験の返品が無い');
  return {
    lines: detail.lines.map((item) => ({
      returnLineId: item.id, resolution: item.resolution,
      exchangeVariantId: item.exchange?.variantId ?? null, exchangeMethod: item.exchange?.method ?? null,
    })),
    returnMethod: 'customer_ships' as const, returnShippingPayer: 'customer' as const,
    returnCarrier: null, returnTrackingNumber: null, returnShippingFee: 0, restockingFeePercent: 0,
    exchangeFee: 0, exchangeShippingFee: 0, shopNote: '店の試験メモ', notifyCustomer: false,
  };
}
export async function cancelDb(rr: RR, orderId: string, orderItemId: string, quantity = 1) {
  const row = (await rr.db.query(
    'select * from public.customer_request_cancel($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text)',
    [orderId, rr.member.userId, randomUUID(), JSON.stringify([{ order_item_id: orderItemId, quantity }]), '試験の連絡事項'],
  )).rows[0];
  return row.cancel_request_id as string;
}
export async function counts(rr: RR, returnId: string) {
  const row = (await rr.db.query(
    'select (select count(*)::int from public.order_returns where id=$1) as returns, ' +
    '(select count(*)::int from public.order_return_photos p join public.order_return_lines l on l.id=p.return_line_id where l.return_id=$1) as photos, ' +
    "(select count(*)::int from private.order_email_outbox where return_id=$1 and kind='return_requested') as customer, " +
    "(select count(*)::int from private.order_email_outbox where return_id=$1 and kind='return_request_shop') as shop",
    [returnId],
  )).rows[0];
  return row as { returns: number; photos: number; customer: number; shop: number };
}
export async function expectMails(request: APIRequestContext, email: string, subject: string, fragments: string[]) {
  await runWorkerUntil(request, async () => (await mailBodies(request, email, subject)).length >= 1, '申し込みのメールが届く');
  await runWorkerOnce(request);
  const mails = await mailBodies(request, email, subject);
  expect(mails.length).toBe(1);
  expect(mails[0].Subject).toBe(subject);
  for (const text of fragments) expect(mails[0].Text).toContain(text);
  expect(mails[0].Text.includes('試験の詳しい内容')).toBe(false);
  expect(mails[0].Text.includes('試験の連絡事項')).toBe(false);
}
export async function requestMails(request: APIRequestContext, rr: RR, fx: ReturnFixture, number: number) {
  const order = orderNumberOf(fx.orderId);
  const label = returnLabelOf(fx.orderId, number);
  await expectMails(request, rr.member.email, '【Le Fil des Heures】返品のお申し込みを受け付けました（' + order + '）',
    ['ご注文（' + order + '）の返品のお申し込みを受け付けました（返品番号 ' + label + '）。', '内容を確かめて、ご連絡いたします。']);
  await expectMails(request, SHOP_ALERT_TO, '【要対応】返品の申し込みが届きました（' + order + '）',
    ['お客様から返品の申し込みが届きました（返品番号 ' + label + '）。',
      '管理画面の注文の一覧で「申し込みを確かめる」を押して、承認するかお断りしてください。']);
}

export type PhotoFile = { name: string; mimeType: string; buffer: Buffer };
export async function photoFiles(page: Page) {
  if (page.url() === 'about:blank') await page.goto('/');
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2600; canvas.height = 1200;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像を作れない');
    context.fillStyle = '#8c9aa4'; context.fillRect(0, 0, 2600, 1200);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  }), 'base64');
  // TIFF の GPS IFD に北緯35度・東経139度を入れ、文字の印だけの偽 EXIF にしない。
  const exif = Buffer.alloc(134);
  exif.write('Exif\0\0', 0, 'ascii'); exif.write('II', 6, 'ascii');
  exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14); exif.writeUInt16LE(0x8825, 16);
  exif.writeUInt16LE(4, 18); exif.writeUInt32LE(1, 20); exif.writeUInt32LE(26, 24);
  exif.writeUInt16LE(4, 32);
  for (const [index, tag, type, count, value] of [
    [0, 1, 2, 2, 78], [1, 2, 5, 3, 80], [2, 3, 2, 2, 69], [3, 4, 5, 3, 104],
  ]) {
    const offset = 34 + index * 12;
    exif.writeUInt16LE(tag, offset); exif.writeUInt16LE(type, offset + 2);
    exif.writeUInt32LE(count, offset + 4); exif.writeUInt32LE(value, offset + 8);
  }
  for (const [offset, degrees] of [[86, 35], [110, 139]]) {
    for (let i = 0; i < 3; i += 1) {
      exif.writeUInt32LE(i === 0 ? degrees : 0, offset + i * 8);
      exif.writeUInt32LE(1, offset + i * 8 + 4);
    }
  }
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(exif.length + 2, 2);
  const gps = Buffer.concat([jpeg.subarray(0, 2), app1, exif, jpeg.subarray(2)]);
  const png = Buffer.from(SEED_IMAGE_PNG_BASE64, 'base64');
  const text = Buffer.from('tEXtComment\0E2E_LOCATION_35_139', 'ascii');
  let crc = 0xffffffff;
  for (const byte of text) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(text.length + 8);
  chunk.writeUInt32BE(text.length - 4, 0); text.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const pngText = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  return {
    jpeg: { name: 'return-photo.jpg', mimeType: 'image/jpeg', buffer: jpeg },
    gps: { name: 'return-photo-gps.jpg', mimeType: 'image/jpeg', buffer: gps },
    png: { name: 'return-photo-text.png', mimeType: 'image/png', buffer: pngText },
    invalid: { name: 'return-photo.txt', mimeType: 'text/plain', buffer: Buffer.from('画像ではありません') },
    broken: { name: 'return-photo-broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 225, 0, 255]) },
  } satisfies Record<string, PhotoFile>;
}
export async function directUploadWithUrl(page: Page, orderId: string, file: PhotoFile): Promise<{ uploadId: string; signedUrl: string }> {
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!origin || !isLocalUrl(origin)) throw new Error('手元の送り先だけを使う');
  const result = await page.evaluate(async ({ orderId, encoded, contentType, storageOrigin }) => {
    const token = document.cookie.split('; ').find((entry) => entry.startsWith('sb-csrf-token='))
      ?.split('=').slice(1).join('=');
    if (!token) throw new Error('CSRF の印が無い');
    const issued = await fetch('/api/orders/' + orderId + '/return-request/photos', {
      method: 'POST', headers: { 'x-csrf-token': token }, credentials: 'same-origin',
    });
    if (issued.status !== 200) throw new Error('写真の送り先を出せない');
    const { data } = await issued.json() as { data: { uploadId: string; signedUrl: string } };
    if (new URL(data.signedUrl).origin !== storageOrigin) throw new Error('送り先が手元ではない');
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const uploaded = await fetch(data.signedUrl, {
      method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'false' }, body: bytes,
    });
    return { uploadId: data.uploadId, signedUrl: data.signedUrl, status: uploaded.status };
  }, { orderId, encoded: file.buffer.toString('base64'), contentType: file.mimeType, storageOrigin: new URL(origin).origin });
  expect(result.status >= 200 && result.status < 300).toBe(true);
  return { uploadId: result.uploadId, signedUrl: result.signedUrl };
}
export async function directUpload(page: Page, orderId: string, file: PhotoFile): Promise<string> {
  return (await directUploadWithUrl(page, orderId, file)).uploadId;
}
/** 申し込みの後に、もらった同じ署名つきの送り先へもう一度置く。返すのは HTTP の番号だけ（送り先は出力に出さない） */
export async function putToSignedUrl(page: Page, signedUrl: string, file: PhotoFile): Promise<number> {
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!origin || !isLocalUrl(origin) || new URL(signedUrl).origin !== new URL(origin).origin) throw new Error('手元の送り先だけを使う');
  return page.evaluate(async ({ signedUrl, encoded, contentType }) => {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const response = await fetch(signedUrl, {
      method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'false' }, body: bytes,
    });
    return response.status;
  }, { signedUrl, encoded: file.buffer.toString('base64'), contentType: file.mimeType });
}
export async function readObject(rr: RR, path: string): Promise<Buffer> {
  const result = await rr.client.storage.from('return-photos').download(path).catch(() => {
    throw new Error('写真を読み出せない');
  });
  if (result.error || !result.data) throw new Error('写真を読み出せない');
  return Buffer.from(await result.data.arrayBuffer());
}
export async function uploadedObject(rr: RR, uploadId: string) {
  const row = (await rr.db.query(
    'select storage_path, attached_at, purged_at from public.order_return_photo_uploads where id=$1', [uploadId],
  )).rows[0];
  if (!row) throw new Error('試験の送り先が無い');
  return { ...row, bytes: await readObject(rr, row.storage_path as string) };
}
export async function imageDimensions(page: Page, bytes: Buffer) {
  return page.evaluate(async ({ encoded, contentType }) => {
    const img = new Image(); img.src = 'data:' + contentType + ';base64,' + encoded;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, { encoded: bytes.toString('base64'), contentType: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' });
}
export async function seedAgedPhoto(rr: RR, fx: ReturnFixture, state: 'upload' | 'closed' | 'cancelled' | 'declined', bytes: Buffer) {
  const uploadId = randomUUID();
  const path = 'requests/' + fx.orderId + '/' + uploadId;
  await rr.db.query(
    "insert into public.order_return_photo_uploads(id,order_id,customer_id,storage_path,created_at,attached_at) " +
    "values($1,$2,$3,$4,now()-case when $5 then interval '92 days' else interval '25 hours' end,case when $5 then now()-interval '92 days' end)",
    [uploadId, fx.orderId, rr.member.userId, path, state !== 'upload'],
  );
  let photoId: string | null = null;
  let returnId: string | null = null;
  if (state !== 'upload') {
    const result = await rr.db.query(
      'insert into public.order_returns(order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,' +
      'approved_at,closed_at,cancelled_at,declined_at,decline_reason,decline_message,return_method,return_shipping_payer,notify_customer) ' +
      "values($1,1,'customer_request',$2,gen_random_uuid(),'fixture',now()-interval '92 days',$3," +
      "case when $2<>'declined' then now()-interval '92 days' end," +
      "case when $2='closed' then now()-interval '91 days' end," +
      "case when $2='cancelled' then now()-interval '91 days' end," +
      "case when $2='declined' then now()-interval '91 days' end," +
      "case when $2='declined' then 'other' end,case when $2='declined' then '試験のお断り' end," +
      "'customer_ships','customer',false) returning id",
      [fx.orderId, state, rr.member.userId],
    );
    returnId = result.rows[0].id as string;
    const resultLine = await rr.db.query(
      'insert into public.order_return_lines(return_id,fulfillment_id,order_item_id,quantity,reason,resolution,requested_resolution) ' +
      "values($1,$2,$3,1,'other','refund','refund') returning id",
      [returnId, fx.fulfillmentId, fx.orderItemIds[0]],
    );
    photoId = (await rr.db.query(
      'insert into public.order_return_photos(return_line_id,upload_id,storage_path,content_type,size_bytes,created_at) ' +
      "values($1,$2,$3,'image/jpeg',$4,now()-interval '92 days') returning id",
      [resultLine.rows[0].id, uploadId, path, bytes.length],
    )).rows[0].id as string;
  }
  // 古い時刻は INSERT の時に決める。UPDATE で守りを外さない。
  const result = await rr.client.storage.from('return-photos').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (result.error) throw new Error('古い写真を用意できない');
  return { uploadId, photoId, returnId, path };
}
export async function purge(request: APIRequestContext) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('手元の定期処理の合言葉が無い');
  const result = await request.post('/api/cron/purge-return-photos', {
    headers: { authorization: 'Bearer ' + secret },
  });
  expect(result.status()).toBe(200);
  return await result.json() as { data: { uploads: number; photos: number } };
}
export async function expectPurged(rr: RR, target: Awaited<ReturnType<typeof seedAgedPhoto>>) {
  const row = (await rr.db.query(
    'select purged_at is not null as purged from public.order_return_photo_uploads where id=$1', [target.uploadId],
  )).rows[0];
  expect(row.purged).toBe(true);
  if (target.photoId) {
    expect((await rr.db.query('select purged_at is not null as purged from public.order_return_photos where id=$1', [target.photoId])).rows[0].purged).toBe(true);
  }
  const object = await rr.client.storage.from('return-photos').download(target.path);
  expect(object.error !== null).toBe(true);
}

function refusal(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('AWAITING_REFUND_EXISTS')) return { code: 'awaiting_refund_exists', error: '確かめ中の返金があります。先に確かめてください。' };
  if (message.includes('RETURN_FORBIDDEN')) return { code: 'RETURN_FORBIDDEN', error: 'この操作は店長だけができます。' };
  if (message.includes('RETURN_STATE_CONFLICT')) return { code: 'RETURN_STATE_CONFLICT', error: '返品の状態が変わりました。画面を開き直してください。' };
  throw new Error('手元の DB の操作に失敗した');
}
export async function adminScene(page: Page, rr: RR, fx: ReturnFixture, role: 'admin' | 'supporter' = 'admin') {
  const returns = await listOrderReturns(rr.client, fx.orderId);
  const state = newReturnRouteState({
    orderId: fx.orderId, returns, materials: await loadReturnCreateMaterials(rr.client, fx.orderId),
    canRefund: role === 'admin', returnableUnits: 0, refundableAmount: 100_000,
  });
  const posts = { approve: [] as JsonBody[], decline: [] as JsonBody[] };
  const refresh = async () => { state.returns = await listOrderReturns(rr.client, fx.orderId); };
  await mockAdminSessionAs(page, role);
  await page.route((url) => url.pathname === '/api/admin/orders', (route) => fulfillJson(route, {
    data: [orderWithReturns({ id: fx.orderId, canRefund: role === 'admin',
      summary: returnSummaryOf({ orderId: fx.orderId,
        displayStatus: state.returns.some((item) => item.status === 'requested') ? 'requested' : 'in_progress',
        nextAction: state.returns.some((item) => item.status === 'requested') ? 'review_request' : 'receive',
        hasReturnable: false }),
    })],
    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
  }));
  await mockReturnRoutes(page, fx.orderId, state);
  state.answerAction = async (route, action, post) => {
    if (action !== 'receive') throw new Error('この試験で受け取り以外は使わない');
    const body = post.body;
    try {
      const received = await receiveReturnInDb(rr.db, post.returnId, fx.actorId, {
        requestKey: body.requestKey as string, canRefund: role === 'admin',
        units: (body.units as Array<{ returnLineId: string; disposition: 'restocked' | 'not_restocked' | 'pending_inspection'; quantity: number }>)
          .map((item) => ({ lineId: item.returnLineId, disposition: item.disposition, quantity: item.quantity })),
        choice: body.refundChoice as 'now' | 'consult' | 'none', notify: body.notifyCustomer as boolean,
      });
      if (received.refundId) await recordRefundResult(rr.db, received.refundId);
      await refresh();
      await fulfillJson(route, { data: { ...received, refundStatus: received.refundId ? 'succeeded' : received.refundStatus } });
    } catch (error) {
      const denied = refusal(error);
      await fulfillJson(route, denied, denied.code === 'RETURN_FORBIDDEN' ? 403 : 409);
    }
  };
  await page.route(/\/api\/admin\/returns\/[^/]+\/(approve|decline|photos)$/, async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const returnId = parts[4]; const action = parts[5];
    if (action === 'photos') {
      const photos = (await rr.db.query('select * from public.list_return_photos($1::uuid)', [returnId])).rows;
      const signed = [];
      for (const photo of photos) {
        let url: string | null = null;
        if (!photo.purged) {
          const result = await rr.client.storage.from('return-photos').createSignedUrl(photo.storage_path as string, 600);
          if (result.error || !result.data) throw new Error('写真のリンクを作れない');
          url = result.data.signedUrl;
        }
        signed.push({ photoId: photo.photo_id, returnLineId: photo.return_line_id, url, purged: photo.purged });
      }
      await fulfillJson(route, { data: { photos: signed } });
      return;
    }
    const body = route.request().postDataJSON() as JsonBody;
    if (action === 'approve') {
      posts.approve.push(body);
      await approveDb(rr, returnId, body as unknown as Omit<ApproveReturnInput, 'returnId' | 'actorId'>, fx.actorId);
    } else {
      posts.decline.push(body);
      await rr.db.query('select * from public.admin_decline_return($1::uuid,$2::uuid,$3::text,$4::text)',
        [returnId, fx.actorId, body.declineReason, body.declineMessage]);
    }
    await refresh();
    await fulfillJson(route, { data: { returnStatus: action === 'approve' ? 'open' : 'declined' } });
  });
  await openOrderTab(page);
  return { state, posts };
}
export async function openReview(page: Page, fx: ReturnFixture, number: number) {
  await page.getByRole('row', { name: new RegExp(fx.orderId) })
    .getByRole('button', { name: '申し込みを確かめる', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: '返品の申し込みを確かめる（' + returnLabelOf(fx.orderId, number) + '）', exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
export async function cancelScene(page: Page, rr: RR, fx: Awaited<ReturnType<typeof unshipped>>, role: 'admin' | 'supporter' = 'admin') {
  const state = {
    current: await listOrderCancelRequests(rr.client, fx.orderId),
    urls: [] as string[], posts: [] as Array<{ action: string; body: JsonBody }>, resolveFails: false,
  };
  const totals = async () => {
    const rows = (await rr.db.query('select * from public.list_order_line_fulfillment(array[$1::uuid])', [fx.orderId])).rows;
    return {
      shippedUnits: rows.reduce((sum, row) => sum + Number(row.shipped), 0),
      unshippedUnits: rows.reduce((sum, row) => sum + Number(row.unshipped), 0),
    };
  };
  await mockAdminSessionAs(page, role);
  await page.route((url) => url.pathname === '/api/admin/orders', (route) => {
    state.urls.push(route.request().url());
    const open = state.current.some((item) => item.status === 'requested');
    return fulfillJson(route, {
      data: [orderWithReturns({
        id: fx.orderId, orderStatus: 'paid', canRefund: role === 'admin', cancelRequestOpen: open,
        items: [orderLine({ id: fx.orderItemIds[0], name: 'E2Eシャツ', quantity: 3, readyUnshipped: 2, shipped: 1 })],
        summary: returnSummaryOf({ orderId: fx.orderId, displayStatus: null, hasReturnable: false }),
      })],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }, cancelRequestAttention: open ? 1 : 0,
    });
  });
  await page.route('**/api/admin/orders/' + fx.orderId + '/cancel-requests', async (route) => {
    const status = (await rr.db.query('select status::text from public.orders where id=$1', [fx.orderId])).rows[0].status;
    await fulfillJson(route, { data: { cancelRequests: state.current, orderStatus: status, ...await totals() } });
  });
  await page.route(/\/api\/admin\/cancel-requests\/[^/]+\/(decline|close|resolve)$/, async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const id = parts[4]; const action = parts[5];
    const body = (route.request().postDataJSON() ?? {}) as JsonBody;
    state.posts.push({ action, body });
    if (action === 'resolve' && state.resolveFails) {
      await fulfillJson(route, { error: '返金・キャンセルの記録を確かめられませんでした。画面を開き直してください。', code: 'CANCEL_REQUEST_RESOLUTION_INVALID' }, 409);
      return;
    }
    if (action === 'decline') {
      await rr.db.query('select * from public.admin_decline_cancel_request($1::uuid,$2::uuid,$3::text,$4::text)',
        [id, fx.actorId, body.declineReason, body.declineMessage]);
    } else if (action === 'close') {
      await rr.db.query('select * from public.admin_close_cancel_request($1::uuid,$2::uuid)', [id, fx.actorId]);
    } else {
      await rr.db.query('select * from public.admin_resolve_cancel_request($1::uuid,$2::uuid,$3::uuid,$4::boolean)',
        [id, fx.actorId, body.refundId, body.orderCancelled]);
    }
    state.current = await listOrderCancelRequests(rr.client, fx.orderId);
    await fulfillJson(route, { data: { status: action === 'decline' ? 'declined' : action === 'close' ? 'closed' : 'resolved' } });
  });
  await openOrderTab(page);
  return state;
}
export async function openCancel(page: Page, orderId: string) {
  await page.getByRole('row', { name: new RegExp(orderId) })
    .getByRole('button', { name: 'キャンセルの申し込み', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'キャンセルの申し込み（' + orderNumberOf(orderId) + '）', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

export const SETTINGS_CHANGED = { at: '2026-10-12T02:30:00.000Z', byEmail: 'admin@example.com' };
export function applyReturnSettingsUpdate(current: ShopReturnSettings, update: ShopReturnSettingsUpdate): ShopReturnSettings {
  const reasons = current.reasons.map((row) => {
    const next = update.reasons.find((item) => item.reason === row.reason);
    return next ? {
      ...row, shippingPayer: next.shippingPayer, outOfStockExchange: next.outOfStockExchange,
      shown: next.shown ?? row.shown, resolutions: next.resolutions ?? row.resolutions,
      photo: next.photo ?? row.photo, photoInstructions: next.photoInstructions ?? row.photoInstructions,
    } : row;
  });
  const next = {
    ...current, ...update, requestsEnabled: update.requestsEnabled ?? current.requestsEnabled,
    requestTypes: update.requestTypes ?? current.requestTypes, noticeText: update.noticeText ?? current.noticeText,
    reasons, updated: { ...current.updated },
  };
  const groups = {
    requests: ['requestsEnabled', 'requestTypes', 'noticeText'],
    shipping: ['returnAddress', 'customerPaidMethod', 'shopLabelFee', 'noReturnNeededEnabled'],
    window: ['windowDays', 'windowStart', 'deliveryBufferDays'],
    reasons: ['reasons'],
    fees: ['restockingFeeEnabled', 'restockingFeePercent', 'exchangeFeesEnabled', 'exchangeFee', 'exchangeShippingFee'],
    receiving: ['inspectionEnabled'],
  } as const;
  for (const group of Object.keys(groups) as Array<keyof typeof groups>) {
    if (groups[group].some((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]))) {
      next.updated[group] = SETTINGS_CHANGED;
    }
  }
  return next;
}
export async function settingsScene(page: Page) {
  const state = { settings: buildShopReturnSettings(), puts: [] as ShopReturnSettingsUpdate[] };
  await mockAdminSessionAs(page, 'admin');
  await page.route((url) => url.pathname === '/api/admin/orders', (route) => fulfillJson(route, {
    data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
  }));
  await page.route('**/api/admin/settings/shop', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { returns?: ShopReturnSettingsUpdate };
      if (body.returns) {
        state.puts.push(body.returns);
        state.settings = applyReturnSettingsUpdate(state.settings, body.returns);
      }
    }
    await fulfillJson(route, { data: {
      autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null },
      autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null },
      returns: state.settings,
    } });
  });
  await page.goto('/admin');
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: 'SETTINGS', exact: true }).click();
  await expect(page.getByRole('region', { name: '申し込み', exact: true })).toBeVisible();
  return state;
}
