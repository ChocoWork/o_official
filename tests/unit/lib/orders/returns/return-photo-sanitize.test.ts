/** @jest-environment node */

import {
  RETURN_PHOTO_MAX_BYTES,
  sanitizeReturnPhoto,
  type SanitizeReturnPhotoResult,
} from '@/lib/orders/returns/return-photo-sanitize';
import {
  APP0_JFIF,
  APP14_ADOBE,
  COMMENT,
  DHT,
  DQT,
  EOI,
  EXIF_CHUNK,
  EXIF_WITH_GPS,
  GAMA,
  ICC,
  ICCP,
  IDAT,
  IEND,
  IHDR,
  ITXT_CHUNK,
  PHOTOSHOP,
  PHYS,
  PLAIN_JPEG,
  PLAIN_PNG,
  PNG_MAGIC,
  SCAN,
  SOF0,
  SOI,
  SOS_HEADER,
  TEXT_CHUNK,
  TIME_CHUNK,
  XMP,
  ZTXT_CHUNK,
  concat,
  containsText,
  hex,
  jpegSegment,
  pngChunk,
  text,
  withBrokenCrc,
} from './return-photo-fixtures';

/** ok のはずの結果を取り出す。ok でなければ、理由を書いて失敗させる */
function expectOk(result: SanitizeReturnPhotoResult) {
  if (!result.ok) throw new Error(`ok のはずが ${result.reason}`);
  return result;
}

const BROKEN = { ok: false, reason: 'broken' };
const UNSUPPORTED = { ok: false, reason: 'unsupported_type' };

describe('sanitizeReturnPhoto: JPEG', () => {
  it('APP1（Exif と XMP）・APP2・APP13・COM を外し、APP0・APP14・画像の中身は1バイトも変えずに残す', () => {
    const input = concat(SOI, APP0_JFIF, EXIF_WITH_GPS, XMP, ICC, PHOTOSHOP, COMMENT, APP14_ADOBE, DQT, SOF0, DHT, SCAN);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.contentType).toBe('image/jpeg');
    expect(result.changed).toBe(true);
    expect(hex(result.bytes)).toBe(hex(concat(SOI, APP0_JFIF, APP14_ADOBE, DQT, SOF0, DHT, SCAN)));
    for (const removed of ['Exif', 'GPSLatitude', 'ns.adobe.com/xap', 'owner=Taro', 'ICC_PROFILE', 'Photoshop', 'shot at home']) {
      expect(containsText(result.bytes, removed)).toBe(false);
    }
    expect(containsText(result.bytes, 'JFIF')).toBe(true);
    expect(containsText(result.bytes, 'Adobe')).toBe(true);
  });

  it.each(
    Array.from({ length: 15 }, (_, index) => index + 1)
      .filter((number) => number !== 14)
      .map((number): [string, number] => [`APP${number}`, 0xe0 + number]),
  )('%s の区切りも外す', (_name, marker) => {
    const input = concat(SOI, APP0_JFIF, jpegSegment(marker, text('SECRET')), DQT, SOF0, DHT, SCAN);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.changed).toBe(true);
    expect(hex(result.bytes)).toBe(hex(PLAIN_JPEG));
  });

  it('外す区切りが無ければ changed: false で、バイトをそのまま返す', () => {
    const input = concat(SOI, APP0_JFIF, APP14_ADOBE, DQT, SOF0, DHT, SCAN);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.contentType).toBe('image/jpeg');
    expect(result.changed).toBe(false);
    expect(hex(result.bytes)).toBe(hex(input));
  });

  it('2回通しても同じになる（消した写しをもう一度通すと changed: false。送り直しで置き直しが起きない）', () => {
    const once = expectOk(sanitizeReturnPhoto(concat(SOI, APP0_JFIF, EXIF_WITH_GPS, COMMENT, DQT, SOF0, DHT, SCAN)));

    const twice = expectOk(sanitizeReturnPhoto(once.bytes));

    expect(twice.changed).toBe(false);
    expect(hex(twice.bytes)).toBe(hex(once.bytes));
  });

  it('JFIF の無い JPEG（最初の区切りが APP1）でも外せる', () => {
    const input = concat(SOI, EXIF_WITH_GPS, DQT, SOF0, DHT, SCAN);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.changed).toBe(true);
    expect(hex(result.bytes)).toBe(hex(concat(SOI, DQT, SOF0, DHT, SCAN)));
  });

  it('区切りの前の詰め物の FF も、外す区切りと一緒に外す', () => {
    const input = concat(SOI, APP0_JFIF, Uint8Array.from([0xff, 0xff]), EXIF_WITH_GPS, DQT, SOF0, DHT, SCAN);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(hex(result.bytes)).toBe(hex(PLAIN_JPEG));
  });

  it('SOS の後ろは読まない（画像の中身に APP1 のように見えるバイトがあっても、そのまま残す）', () => {
    const lookalike = jpegSegment(0xe1, text('Exif'));
    const input = concat(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS_HEADER, Uint8Array.from([0x12]), lookalike, Uint8Array.from([0x34]), EOI);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.changed).toBe(false);
    expect(hex(result.bytes)).toBe(hex(input));
  });
});

describe('sanitizeReturnPhoto: 壊れた JPEG', () => {
  it.each([
    ['印だけで終わる', Uint8Array.from([0xff, 0xd8, 0xff])],
    ['区切りの種類と長さの途中で終わる', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ['区切りの長さが残りのバイトより大きい（途中で切れた）', concat(SOI, Uint8Array.from([0xff, 0xe1, 0xff, 0xff, 0x45, 0x78]))],
    ['APP1 の途中で切れた', concat(SOI, APP0_JFIF, EXIF_WITH_GPS.subarray(0, 20))],
    ['SOS が無いまま終わる', concat(SOI, APP0_JFIF, DQT, SOF0, DHT)],
    ['区切りの長さが2に満たない', concat(SOI, Uint8Array.from([0xff, 0xe1, 0x00, 0x01, 0x00]))],
    ['区切りの位置が FF でない', concat(SOI, APP0_JFIF, Uint8Array.from([0x00, 0x01, 0x02, 0x03]))],
    ['フレームの見出し（SOF）が無いまま SOS が来る', concat(SOI, APP0_JFIF, DQT, DHT, SCAN)],
    ['SOS の見出しの後ろに画像の中身が1バイトも無い', concat(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS_HEADER)],
  ])('%s物は broken', (_name, input) => {
    expect(sanitizeReturnPhoto(input)).toEqual(BROKEN);
  });

  it.each([
    ['00（詰め込み）', 0x00],
    ['01（TEM）', 0x01],
    ['D0（RST0）', 0xd0],
    ['D8（SOI）', 0xd8],
    ['D9（EOI）', 0xd9],
  ])('SOS の前に、長さを持たない区切り %s が来る物は broken', (_name, marker) => {
    const input = concat(SOI, APP0_JFIF, Uint8Array.from([0xff, marker, 0x00, 0x04, 0x00, 0x00]), DQT, SOF0, DHT, SCAN);

    expect(sanitizeReturnPhoto(input)).toEqual(BROKEN);
  });

  it('外す区切りが多すぎる物（空の APP1 を 5000 個）は broken（外す範囲を数百万個持たせてメモリを使い切らせない）', () => {
    const empties = new Uint8Array(5000 * 4);
    for (let index = 0; index < 5000; index += 1) empties.set([0xff, 0xe1, 0x00, 0x02], index * 4);

    expect(sanitizeReturnPhoto(concat(SOI, APP0_JFIF, empties, DQT, SOF0, DHT, SCAN))).toEqual(BROKEN);
  });
});

describe('sanitizeReturnPhoto: PNG', () => {
  it('見本の組み立て: 空の IEND は、よく知られたバイト列（CRC を含む）と同じ', () => {
    expect(hex(IEND)).toBe('0000000049454e44ae426082');
  });

  it('eXIf・tEXt・zTXt・iTXt・tIME を外し、IHDR・IDAT・IEND とほかのかたまりは CRC まで1バイトも変えずに残す', () => {
    const input = concat(
      PNG_MAGIC, IHDR, EXIF_CHUNK, GAMA, TEXT_CHUNK, PHYS, ZTXT_CHUNK, ICCP, ITXT_CHUNK, TIME_CHUNK, IDAT, IEND,
    );

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.contentType).toBe('image/png');
    expect(result.changed).toBe(true);
    expect(hex(result.bytes)).toBe(hex(concat(PNG_MAGIC, IHDR, GAMA, PHYS, ICCP, IDAT, IEND)));
    for (const removed of ['GPSLatitude', 'Author', 'Taro', 'xmpmeta', 'Comment']) {
      expect(containsText(result.bytes, removed)).toBe(false);
    }
  });

  it('外すかたまりが無ければ changed: false で、バイトをそのまま返す', () => {
    const input = concat(PNG_MAGIC, IHDR, GAMA, PHYS, ICCP, IDAT, IEND);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.changed).toBe(false);
    expect(hex(result.bytes)).toBe(hex(input));
  });

  it('2回通しても同じになる（消した写しをもう一度通すと changed: false）', () => {
    const once = expectOk(sanitizeReturnPhoto(concat(PNG_MAGIC, IHDR, TEXT_CHUNK, TIME_CHUNK, IDAT, IEND)));

    const twice = expectOk(sanitizeReturnPhoto(once.bytes));

    expect(twice.changed).toBe(false);
    expect(hex(twice.bytes)).toBe(hex(PLAIN_PNG));
  });

  it('IEND の後ろに付け足された物は残さない（changed: true）', () => {
    const input = concat(PNG_MAGIC, IHDR, IDAT, IEND, Uint8Array.from(text('PK appended payload')));

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.changed).toBe(true);
    expect(hex(result.bytes)).toBe(hex(PLAIN_PNG));
  });

  it('CRC は確かめない（残す物の CRC が合わなくてもそのまま残し、外す物の CRC が合わなくても外す）', () => {
    const input = concat(PNG_MAGIC, IHDR, withBrokenCrc(TEXT_CHUNK), withBrokenCrc(IDAT), IEND);

    const result = expectOk(sanitizeReturnPhoto(input));

    expect(result.changed).toBe(true);
    expect(hex(result.bytes)).toBe(hex(concat(PNG_MAGIC, IHDR, withBrokenCrc(IDAT), IEND)));
  });
});

describe('sanitizeReturnPhoto: 壊れた PNG', () => {
  const hugeLengthIdat = Uint8Array.from([0x00, 0x10, 0x00, 0x00, ...text('IDAT'), 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  const over2GiBIdat = Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...text('IDAT'), 0x00, 0x00, 0x00, 0x00]);
  const nonLetterType = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x00, 0x00, 0x00, 0x00]);
  const shortIhdr = pngChunk('IHDR', [0, 0, 0, 1]);

  it.each([
    ['印だけで終わる', PNG_MAGIC],
    ['IEND が無いまま終わる（途中で切れた）', concat(PNG_MAGIC, IHDR, IDAT)],
    ['かたまりの途中（長さ・種類・CRC の12バイトに満たない所）で終わる', concat(PNG_MAGIC, IHDR, Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x44]))],
    ['かたまりの長さが残りのバイトより大きい', concat(PNG_MAGIC, IHDR, hugeLengthIdat)],
    ['かたまりの長さが 2^31 以上', concat(PNG_MAGIC, IHDR, over2GiBIdat)],
    ['最初のかたまりが IHDR でない', concat(PNG_MAGIC, IDAT, IEND)],
    ['IHDR の長さが 13 でない', concat(PNG_MAGIC, shortIhdr, IDAT, IEND)],
    ['かたまりの種類が英字でない', concat(PNG_MAGIC, IHDR, nonLetterType, IDAT, IEND)],
    ['画像のデータ（IDAT）が無い', concat(PNG_MAGIC, IHDR, IEND)],
    ['IEND に中身がある', concat(PNG_MAGIC, IHDR, IDAT, pngChunk('IEND', text('hidden')))],
  ])('%s物は broken', (_name, input) => {
    expect(sanitizeReturnPhoto(input)).toEqual(BROKEN);
  });

  it('外すかたまりが多すぎる物（空の tEXt を 5000 個）は broken', () => {
    const chunks = Array.from({ length: 5000 }, () => pngChunk('tEXt'));

    expect(sanitizeReturnPhoto(concat(PNG_MAGIC, IHDR, ...chunks, IDAT, IEND))).toEqual(BROKEN);
  });
});

describe('sanitizeReturnPhoto: 種類と大きさ', () => {
  it.each([
    ['空', new Uint8Array(0)],
    ['GIF', Uint8Array.from([...text('GIF89a'), 0x01, 0x00, 0x01, 0x00])],
    ['WebP', Uint8Array.from([...text('RIFF'), 0x24, 0x00, 0x00, 0x00, ...text('WEBP')])],
    ['文字', Uint8Array.from(text('<html>not an image</html>'))],
    ['JPEG の印に1バイト足りない', Uint8Array.from([0xff, 0xd8, 0x00, 0x10])],
    ['PNG の印の途中まで', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
  ])('先頭の印が JPEG でも PNG でもない物（%s）は unsupported_type', (_name, input) => {
    expect(sanitizeReturnPhoto(input)).toEqual(UNSUPPORTED);
  });

  it('10MiB ちょうどは通り、1バイトでも超えれば too_large（種類を見る前に断る）', () => {
    const header = concat(SOI, APP0_JFIF, DQT, SOF0, DHT, SOS_HEADER);
    const exact = concat(header, new Uint8Array(RETURN_PHOTO_MAX_BYTES - header.length - EOI.length).fill(0x11), EOI);
    expect(exact.length).toBe(RETURN_PHOTO_MAX_BYTES);

    expect(expectOk(sanitizeReturnPhoto(exact)).changed).toBe(false);
    expect(sanitizeReturnPhoto(concat(exact, Uint8Array.from([0x00])))).toEqual({ ok: false, reason: 'too_large' });
    expect(sanitizeReturnPhoto(new Uint8Array(RETURN_PHOTO_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('PNG も 10MiB を超えれば too_large', () => {
    const padding = new Uint8Array(RETURN_PHOTO_MAX_BYTES - PLAIN_PNG.length + 1);

    expect(sanitizeReturnPhoto(concat(PLAIN_PNG, padding))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('上限の定数は 10MiB', () => {
    expect(RETURN_PHOTO_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
