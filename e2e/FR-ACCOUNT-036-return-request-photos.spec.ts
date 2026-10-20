import { randomUUID } from 'node:crypto';
import { insertReturnReceipt } from '../tests/integration/db/helpers/order-fixtures';
import {
  test, expect, viewports, shipped, openRequest, pick, photoFiles, directUpload, directUploadWithUrl, putToSignedUrl,
  uploadedObject, imageDimensions, appJson, line, counts, seedAgedPhoto, purge, expectPurged, noOverflow,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-036 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('写真の必須・種類・10MB・6枚目を画面で止める', async ({ page, rr }) => {
      // FREQ-476-AC-01, FREQ-476-AC-02
      const fx = await shipped(rr);
      await openRequest(page, rr, fx.orderId);
      const row = await pick(page, 'E2Eシャツ', 'defective');
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      await expect(row.getByText('写真を1枚以上選んでください。', { exact: true })).toBeVisible();
      const files = await photoFiles(page);
      const input = row.getByTestId('return-photo-input');
      await input.setInputFiles(files.invalid);
      await expect(row.getByText('JPEG か PNG の写真を選んでください。', { exact: true })).toBeVisible();
      await input.setInputFiles({ name: 'large.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(10_000_001) });
      await expect(row.getByText('1枚 10MB までの写真を選んでください。', { exact: true })).toBeVisible();
      await input.setInputFiles(Array.from({ length: 6 }, (_, index) => ({ ...files.png, name: 'photo-' + index + '.png' })));
      await expect(row.getByRole('button', { name: 'この写真を外す', exact: true })).toHaveCount(5, { timeout: 20_000 });
      await expect(row.getByText('写真は5枚までです。', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '写真を選ぶ', exact: true })).toBeDisabled();
      await row.getByRole('button', { name: 'この写真を外す', exact: true }).first().click();
      await expect(row.getByRole('button', { name: 'この写真を外す', exact: true })).toHaveCount(4);
      await expect(row.getByRole('button', { name: '写真を選ぶ', exact: true })).toBeEnabled();
      expect(Number((await rr.db.query('select count(*) from public.order_returns where order_id=$1', [fx.orderId])).rows[0].count)).toBe(0);
      await noOverflow(page);
    });

    test('画面で選んだ写真を2000pxまで縮め、実際の署名つき送り先へ JPEG で送り、受付に付ける', async ({ page, rr }) => {
      // FREQ-475-AC-04, FREQ-476-AC-01, FREQ-476-AC-02, FREQ-476-AC-03
      const fx = await shipped(rr);
      await openRequest(page, rr, fx.orderId);
      const row = await pick(page, 'E2Eシャツ', 'defective');
      const files = await photoFiles(page);
      const issued = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/api/orders/' + fx.orderId + '/return-request/photos' &&
        response.request().method() === 'POST');
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route((url) => url.pathname.startsWith('/storage/v1/object/upload/sign/'), async (route) => {
        const headers = route.request().headers();
        expect(headers['x-forwarded-for'] === undefined).toBe(true);
        expect(headers['content-type']).toBe('image/jpeg');
        await gate;
        await route.continue();
      });
      await row.getByTestId('return-photo-input').setInputFiles(files.gps);
      await expect(row.getByText('写真を送っています…', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '内容を確かめる', exact: true })).toBeDisabled();
      release?.();
      const issuedBody = await (await issued).json() as { data: { uploadId: string } };
      await expect(row.getByRole('button', { name: 'この写真を外す', exact: true })).toHaveCount(1);
      expect(await row.locator('img').evaluateAll((nodes) => nodes.every((node) => node.getAttribute('src')?.startsWith('data:')))).toBe(true);
      const object = await uploadedObject(rr, issuedBody.data.uploadId);
      const size = await imageDimensions(page, object.bytes);
      expect(size).toEqual({ width: 2000, height: 923 });
      expect(object.bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
      await page.getByRole('button', { name: '内容を確かめる', exact: true }).click();
      await expect(page.getByRole('region', { name: 'お申し込みの内容' })).toContainText('写真 1枚');
      await page.getByRole('button', { name: '申し込む', exact: true }).click();
      await expect(page.getByTestId('return-request-accepted')).toBeVisible();
      const saved = (await rr.db.query('select attached_at is not null as attached from public.order_return_photo_uploads where id=$1', [issuedBody.data.uploadId])).rows[0];
      expect(saved.attached).toBe(true);
    });

    test('Review Focus 2 直接置いた位置情報入り JPEG と tEXt 入り PNG をサーバーが消した写しにし、不正画像を写真の番号付きで断る', async ({ page, rr }) => {
      // FREQ-476-AC-03, FREQ-476-AC-04, FREQ-476-AC-05
      await rr.login();
      const files = await photoFiles(page);
      expect(files.gps.buffer.includes(Buffer.from('Exif\0\0'))).toBe(true);
      expect(files.png.buffer.includes(Buffer.from('E2E_LOCATION_35_139'))).toBe(true);
      for (const [file, invalid] of [
        [files.gps, false], [files.png, false],
        [{ ...files.invalid, mimeType: 'image/jpeg' }, true], [files.broken, true],
      ] as const) {
        const fx = await shipped(rr);
        const { uploadId, signedUrl } = await directUploadWithUrl(page, fx.orderId, file);
        const before = await uploadedObject(rr, uploadId);
        expect(before.bytes.equals(file.buffer)).toBe(true);
        const url = '/api/orders/' + fx.orderId + '/return-request';
        const requestBody = { requestKey: randomUUID(), lines: [line(fx, 0, { photoUploadIds: [uploadId] })] };
        const result = await appJson<{ data?: { returnId: string }; code?: string; invalidPhotoUploadIds?: string[] }>(page, url, requestBody);
        if (invalid) {
          expect(result.status).toBe(400);
          expect(result.body.code).toBe('RETURN_PHOTO_INVALID');
          expect(result.body.invalidPhotoUploadIds).toEqual([uploadId]);
          expect(Number((await rr.db.query('select count(*) from public.order_returns where order_id=$1', [fx.orderId])).rows[0].count)).toBe(0);
        } else {
          expect(result.status).toBe(200);
          const after = await uploadedObject(rr, uploadId);
          expect(after.bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
          expect(after.bytes.includes(Buffer.from('E2E_LOCATION_35_139'))).toBe(false);
          expect(after.bytes.equals(file.buffer)).toBe(false);
          const size = await imageDimensions(page, after.bytes);
          expect(size.width > 0 && size.height > 0).toBe(true);
          expect(await counts(rr, result.body.data!.returnId)).toEqual({ returns: 1, photos: 1, customer: 1, shop: 1 });
          const photo = (await rr.db.query('select size_bytes from public.order_return_photos where upload_id=$1', [uploadId])).rows[0];
          expect(photo.size_bytes).toBe(after.bytes.length);
          // 同じ番号で送り直しても、消した写しの確かめは通り、返品・写真・予定は増えない（Review Focus 1）
          const replay = await appJson<{ data?: { returnId: string; replayed: boolean } }>(page, url, requestBody);
          expect(replay.status).toBe(200);
          expect(replay.body.data).toMatchObject({ returnId: result.body.data!.returnId, replayed: true });
          expect(await counts(rr, result.body.data!.returnId)).toEqual({ returns: 1, photos: 1, customer: 1, shop: 1 });
          // 申し込みの後に、もらった同じ送り先へ元の写真をもう一度置いても、置き場が断り、写真は消した写しのままである
          // （「上書きできない形」は送り先の側で決まる。単体の試験の偽の置き場では確かめられない前提を、本物の置き場で確かめる唯一の試験）
          const again = await putToSignedUrl(page, signedUrl, file);
          expect(again >= 400 && again < 500).toBe(true);
          expect((await uploadedObject(rr, uploadId)).bytes.equals(after.bytes)).toBe(true);
        }
      }
    });

    test('1日を過ぎた使っていない送り先は定期処理が実物を消し、新しい送り先は残す', async ({ page, request, rr }) => {
      // FREQ-476-AC-07
      await rr.login();
      const files = await photoFiles(page);
      const fx = await shipped(rr);
      const old = await seedAgedPhoto(rr, fx, 'upload', files.jpeg.buffer);
      const fresh = await directUpload(page, fx.orderId, files.jpeg);
      const result = await purge(request);
      expect(result.data.uploads).toBeGreaterThanOrEqual(1);
      await expectPurged(rr, old);
      const remaining = await uploadedObject(rr, fresh);
      expect(remaining.purged_at === null).toBe(true);
      expect(remaining.bytes.length > 0).toBe(true);
      expect((await rr.db.query("select last_succeeded_at is not null as ok from public.ops_job_heartbeats where job='return_photo_purge'")).rows[0].ok).toBe(true);
      const unauthorized = await request.post('/api/cron/purge-return-photos');
      expect(unauthorized.status()).toBe(401);
    });

    test('完了・取消・お断りから90日を過ぎた写真は消し、開き直した返品の写真は残す', async ({ page, request, rr }) => {
      // FREQ-476-AC-07
      const files = await photoFiles(page);
      const targets = [];
      for (const status of ['closed', 'cancelled', 'declined'] as const) {
        targets.push(await seedAgedPhoto(rr, await shipped(rr), status, files.jpeg.buffer));
      }
      const reopenedOrder = await shipped(rr);
      const reopened = await seedAgedPhoto(rr, reopenedOrder, 'closed', files.jpeg.buffer);
      const returnLineId = (await rr.db.query('select id from public.order_return_lines where return_id=$1', [reopened.returnId])).rows[0].id as string;
      await insertReturnReceipt(rr.db, {
        returnId: reopened.returnId!, kind: 'close_missing',
        lines: [{ returnLineId, disposition: 'missing', quantity: 1 }],
      });
      await rr.db.query('select * from public.admin_reopen_return($1::uuid,$2::uuid,$3::uuid)',
        [reopened.returnId, reopenedOrder.actorId, randomUUID()]);
      const result = await purge(request);
      expect(result.data.photos).toBeGreaterThanOrEqual(3);
      for (const target of targets) await expectPurged(rr, target);
      const kept = await uploadedObject(rr, reopened.uploadId);
      expect(kept.purged_at === null).toBe(true);
      expect(kept.bytes.equals(files.jpeg.buffer)).toBe(true);
      const second = await purge(request);
      expect(second.data.photos).toBe(0);
    });
  });
}
