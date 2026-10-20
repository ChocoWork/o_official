// 申し込みの写真の見本を、バイトから組み立てる道具（グループ E-3 段2）。画像のファイルは置かない。
// 何が外れて何が残るかを、並びで確かめるために、区切り・かたまりを1つずつ作ってつなぐ。
// return-photo-sanitize の試験と return-photo-storage の試験が使う。

export const text = (value: string): number[] => Array.from(value, (char) => char.charCodeAt(0));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export const containsText = (bytes: Uint8Array, value: string): boolean =>
  Buffer.from(bytes).toString('latin1').includes(value);

const zeros = (count: number): number[] => new Array<number>(count).fill(0);

// ---- JPEG ----

/** 区切り: FF + 種類 + 長さ（大きい方が先。長さの2バイト自身を含む）+ 中身 */
export function jpegSegment(marker: number, payload: number[]): Uint8Array {
  const length = payload.length + 2;
  return Uint8Array.from([0xff, marker, length >> 8, length & 0xff, ...payload]);
}

export const SOI = Uint8Array.from([0xff, 0xd8]);
export const EOI = Uint8Array.from([0xff, 0xd9]);

export const APP0_JFIF = jpegSegment(0xe0, [...text('JFIF'), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
export const APP14_ADOBE = jpegSegment(0xee, [...text('Adobe'), 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]);
export const DQT = jpegSegment(0xdb, [0x00, ...new Array<number>(64).fill(8)]);
export const SOF0 = jpegSegment(0xc0, [0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
export const DHT = jpegSegment(0xc4, [0x00, 0x01, ...zeros(15), 0x00]);
export const SOS_HEADER = jpegSegment(0xda, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
/** 画像の中身（FF 00 の詰め込みを含む）と終わりの印 */
export const SCAN = concat(SOS_HEADER, Uint8Array.from([0x12, 0x34, 0xff, 0x00, 0x56, 0x78]), EOI);

export const EXIF_WITH_GPS = jpegSegment(0xe1, [...text('Exif'), 0x00, 0x00, ...text('GPSLatitude=35.68 GPSLongitude=139.76')]);
export const XMP = jpegSegment(0xe1, [...text('http://ns.adobe.com/xap/1.0/'), 0x00, ...text('<x:xmpmeta>owner=Taro</x:xmpmeta>')]);
export const ICC = jpegSegment(0xe2, [...text('ICC_PROFILE'), 0x00, 0x01, 0x01, ...text('profile')]);
export const PHOTOSHOP = jpegSegment(0xed, [...text('Photoshop 3.0'), 0x00, ...text('8BIM caption')]);
export const COMMENT = jpegSegment(0xfe, text('shot at home'));

/** 外す物が無い、いちばん小さい JPEG */
export const PLAIN_JPEG = concat(SOI, APP0_JFIF, DQT, SOF0, DHT, SCAN);
/** 撮影の位置の情報（APP1 の Exif）が入った JPEG。外すと PLAIN_JPEG と同じバイトになる */
export const JPEG_WITH_LOCATION = concat(SOI, APP0_JFIF, EXIF_WITH_GPS, DQT, SOF0, DHT, SCAN);

// ---- PNG ----

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** かたまり: 長さ（4バイト。中身だけの長さ）+ 種類（4文字）+ 中身 + CRC（種類と中身の CRC32） */
export function pngChunk(type: string, data: number[] = []): Uint8Array {
  const body = Uint8Array.from([...text(type), ...data]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return chunk;
}

/** CRC の最後の1バイトを変えて、CRC が合わない物にする */
export function withBrokenCrc(chunk: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(chunk);
  copy[copy.length - 1] ^= 0xff;
  return copy;
}

export const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const IHDR = pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
export const IDAT = pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]);
export const IEND = pngChunk('IEND');

export const EXIF_CHUNK = pngChunk('eXIf', [...text('MM'), 0x00, 0x2a, ...text('GPSLatitude')]);
export const TEXT_CHUNK = pngChunk('tEXt', [...text('Author'), 0x00, ...text('Taro')]);
export const ZTXT_CHUNK = pngChunk('zTXt', [...text('Comment'), 0x00, 0x00, 0x78, 0x9c, 0x03, 0x00]);
export const ITXT_CHUNK = pngChunk('iTXt', [...text('XML:com.adobe.xmp'), 0x00, 0x00, 0x00, 0x00, 0x00, ...text('<x:xmpmeta/>')]);
export const TIME_CHUNK = pngChunk('tIME', [0x07, 0xea, 0x0a, 0x0d, 0x09, 0x1e, 0x00]);

export const PHYS = pngChunk('pHYs', [0x00, 0x00, 0x0b, 0x13, 0x00, 0x00, 0x0b, 0x13, 0x01]);
export const GAMA = pngChunk('gAMA', [0x00, 0x00, 0xb1, 0x8f]);
export const ICCP = pngChunk('iCCP', [...text('icc'), 0x00, 0x00, 0x78, 0x9c, 0x03, 0x00]);

/** 外す物が無い、いちばん小さい PNG */
export const PLAIN_PNG = concat(PNG_MAGIC, IHDR, IDAT, IEND);
/** 文字（tEXt）と時刻（tIME）が入った PNG。外すと PLAIN_PNG と同じバイトになる */
export const PNG_WITH_TEXT = concat(PNG_MAGIC, IHDR, TEXT_CHUNK, TIME_CHUNK, IDAT, IEND);
