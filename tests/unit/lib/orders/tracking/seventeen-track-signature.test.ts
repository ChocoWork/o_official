/** @jest-environment node */
import { createHash } from 'node:crypto';
import {
  parseTrackingSignals,
  verifySeventeenTrackSignature,
} from '@/lib/orders/tracking/seventeen-track-signature';
import fixture from '../../../../fixtures/17track/v2.4.json';

jest.mock('server-only', () => ({}), { virtual: true });

const fakeKey = 'fake-signature-key-日本語';
const raw = Buffer.from('{"event":"TRACKING_UPDATED","文":"配達中"}\n', 'utf8');
const validSign = createHash('sha256').update(Buffer.concat([raw, Buffer.from(`/${fakeKey}`)])).digest('hex');

describe('17TRACKの署名', () => {
  test('本文を1字変えた署名は通さない', () => {
    const changedRaw = Buffer.from('{"event":"TRACKING_UPDATED","文":"配達済"}\n', 'utf8');
    expect(verifySeventeenTrackSignature(raw, validSign, fakeKey)).toBe(true);
    expect(verifySeventeenTrackSignature(changedRaw, validSign, fakeKey)).toBe(false);
  });

  test('署名なし・非hex・違う長さは例外を出さずfalse', () => {
    expect(verifySeventeenTrackSignature(raw, null, fakeKey)).toBe(false);
    for (const sign of ['', 'x'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}\n`]) {
      expect(verifySeventeenTrackSignature(raw, sign, fakeKey)).toBe(false);
    }
  });

  test('大文字hexも同じbytesとして照合する', () => {
    expect(verifySeventeenTrackSignature(raw, validSign.toUpperCase(), fakeKey)).toBe(true);
    expect(verifySeventeenTrackSignature(raw, validSign, 'different-fake-key')).toBe(false);
  });

  test.each(['日本語', '{\n  "文": "日本語"\n}\n', '{\r\n  "文": "日本語"\r\n}\r\n'])('元のUTF-8 bytesを照合する: %j', (body) => {
    const bytes = Buffer.from(body);
    const sign = createHash('sha256').update(bytes).update('/').update(fakeKey).digest('hex');
    expect(verifySeventeenTrackSignature(new Uint8Array(bytes), sign, fakeKey)).toBe(true);
    expect(verifySeventeenTrackSignature(Buffer.from(`${body} `), sign, fakeKey)).toBe(false);
  });

  test('JSONの作り直しやCRLFの置換を署名前にしない', () => {
    const bytes = Buffer.from('{\r\n "文": "日本語"\r\n}\r\n');
    const sign = createHash('sha256').update(bytes).update('/').update(fakeKey).digest('hex');
    expect(verifySeventeenTrackSignature(Buffer.from(JSON.stringify(JSON.parse(bytes.toString()))), sign, fakeKey)).toBe(false);
    expect(verifySeventeenTrackSignature(Buffer.from(bytes.toString().replace(/\r\n/g, '\n')), sign, fakeKey)).toBe(false);
  });

  test('Uint8Arrayの範囲だけを署名し前後のbytesを含めない', () => {
    const bytes = Buffer.concat([Buffer.from('前'), raw, Buffer.from('後')]);
    expect(verifySeventeenTrackSignature(bytes.subarray(3, 3 + raw.length), validSign, fakeKey)).toBe(true);
  });
});

describe('17TRACKの知らせを読み直しの合図へ変える', () => {
  test('知らせのtrack_infoを配送の結果へ使わない', () => {
    expect(parseTrackingSignals(fixture.webhooks.updated)).toEqual([{ carrier: 100062, number: 'AB-1', event: 'TRACKING_UPDATED' }]);
  });

  test('停止の知らせを返す', () => {
    expect(parseTrackingSignals(fixture.webhooks.stopped)).toEqual([{ carrier: 100062, number: 'AB-1', event: 'TRACKING_STOPPED' }]);
  });

  test('配列の知らせを処理し未知eventと未知carrierだけを無視する', () => {
    expect(parseTrackingSignals([
      fixture.webhooks.updated,
      { event: 'FUTURE_EVENT', data: null },
      { event: 'TRACKING_UPDATED', data: { carrier: 999, number: 'IGNORE' } },
      { event: 'TRACKING_STOPPED', data: { carrier: 100040, number: 'Ab-2' } },
      { event: 'TRACKING_UPDATED', data: { carrier: 10021, number: 'JP-3' } },
    ])).toEqual([
      { carrier: 100062, number: 'AB-1', event: 'TRACKING_UPDATED' },
      { carrier: 100040, number: 'Ab-2', event: 'TRACKING_STOPPED' },
      { carrier: 10021, number: 'JP-3', event: 'TRACKING_UPDATED' },
    ]);
  });

  test('空配列を受け取る', () => {
    expect(parseTrackingSignals([])).toEqual([]);
  });

  test.each([
    null, true, 'json text', 42, {}, { event: 5 }, { event: 'TRACKING_UPDATED' },
    { event: 'TRACKING_UPDATED', data: null }, { event: 'TRACKING_UPDATED', data: [] },
    { event: 'TRACKING_UPDATED', data: { number: 'AB-1' } },
    { event: 'TRACKING_UPDATED', data: { carrier: '100062', number: 'AB-1' } },
    { event: 'TRACKING_UPDATED', data: { carrier: 100062, number: 123 } },
    { event: 'TRACKING_UPDATED', data: { carrier: 100062, number: '   ' } },
    [fixture.webhooks.updated, null],
  ])('壊れたJSON構造はTypeError: %j', (value) => {
    expect(() => parseTrackingSignals(value)).toThrow(TypeError);
  });
});
