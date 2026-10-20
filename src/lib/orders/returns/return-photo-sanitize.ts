/**
 * 申し込みの写真から、撮影の情報（位置・日時・機種・サムネイル・コメント）を外す（グループ E-3 段2）。
 * 外の部品（sharp・exifr など）を使わず、JPEG の区切りと PNG のかたまりを読んで、決まった物だけを外す。
 * 画面でも縮め直して送るが、画面だけでは守りにならない（署名つきの送り先へ直接置けるため）ので、サーバーが必ずこれを通す。
 * サーバーと試験から使う（画面から読まない）。
 *
 * - JPEG（先頭 FF D8 FF）: SOI の次から SOS（FF DA）の見出しまで、区切りを順に読む。APP0（JFIF）と APP14（Adobe。色の向きを決める）
 *   以外の APP1〜APP15 と COM（FF FE）を外す。SOS の後（画像の中身）は読まずにそのまま残す。
 * - PNG（先頭 89 50 4E 47 0D 0A 1A 0A）: かたまり（長さ4・種類4・中身・CRC4）を IEND まで順に読み、
 *   eXIf・tEXt・zTXt・iTXt・tIME を外す。残す物は CRC を含めて1バイトも変えない（CRC は確かめない）。IEND の後ろは残さない。
 * 外す物が無ければ changed: false で、渡されたバイトをそのまま返す。
 */
export const RETURN_PHOTO_MAX_BYTES = 10_485_760;

export type SanitizeReturnPhotoResult =
  | { ok: true; contentType: 'image/jpeg' | 'image/png'; bytes: Uint8Array; changed: boolean }
  | { ok: false; reason: 'unsupported_type' | 'too_large' | 'broken' };

const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 外す PNG のかたまり。撮影の情報（eXIf）・文字（tEXt・zTXt・iTXt。XMP も iTXt に入る）・時刻（tIME） */
const PNG_STRIPPED_CHUNK_TYPES: ReadonlySet<string> = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

const BROKEN = { ok: false, reason: 'broken' } as const;

/**
 * 外す区切り・かたまりの数の上限。ふつうの写真は 10 個に届かない。上限が無いと、空の区切りで埋めた入力
 * （10MiB に 260 万個）が外す範囲を数百万個持たせ、サーバーのメモリを使い切る
 */
const MAX_STRIPPED_RANGES = 4096;

/** 外す範囲（始まりを含み、終わりを含まない） */
type Range = readonly [start: number, end: number];

function hasSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

/** 外す範囲を除いて、残りをつなぐ。範囲は先頭に近い順で、重ならない */
function withoutRanges(bytes: Uint8Array, ranges: readonly Range[]): Uint8Array {
  let keptLength = bytes.length;
  for (const [start, end] of ranges) keptLength -= end - start;
  const kept = new Uint8Array(keptLength);
  let readFrom = 0;
  let writeAt = 0;
  for (const [start, end] of ranges) {
    kept.set(bytes.subarray(readFrom, start), writeAt);
    writeAt += start - readFrom;
    readFrom = end;
  }
  kept.set(bytes.subarray(readFrom), writeAt);
  return kept;
}

function finish(
  contentType: 'image/jpeg' | 'image/png',
  bytes: Uint8Array,
  ranges: readonly Range[],
): SanitizeReturnPhotoResult {
  return ranges.length === 0
    ? { ok: true, contentType, bytes, changed: false }
    : { ok: true, contentType, bytes: withoutRanges(bytes, ranges), changed: true };
}

/** フレームの見出し（SOF0〜SOF15）。C4（DHT）・C8（JPG）・CC（DAC）は別の区切り */
function isJpegFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** 外す区切り。APP1〜APP15（Exif・XMP・ICC・Photoshop など）と COM。APP0（JFIF）と APP14（Adobe）は残す */
function isJpegStrippedMarker(marker: number): boolean {
  return (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
}

function sanitizeJpeg(bytes: Uint8Array): SanitizeReturnPhotoResult {
  const ranges: Range[] = [];
  let sawFrame = false;
  let offset = 2; // SOI（FF D8）の次
  for (;;) {
    // 区切りは FF で始まる。区切りの前に、詰め物の FF が何個あってもよい
    if (offset >= bytes.length || bytes[offset] !== 0xff) return BROKEN;
    let markerAt = offset + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    // 区切りの種類（1バイト）と長さ（2バイト）が読めること
    if (markerAt + 2 >= bytes.length) return BROKEN;
    const marker = bytes[markerAt];
    // 00（詰め込み）・01（TEM）・D0〜D9（RSTn・SOI・EOI）は長さを持たず、SOS の前には来ない
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return BROKEN;
    // 長さは大きい方が先で、長さの2バイト自身を含む
    const length = (bytes[markerAt + 1] << 8) | bytes[markerAt + 2];
    const end = markerAt + 1 + length;
    if (length < 2 || end > bytes.length) return BROKEN;
    if (isJpegFrameMarker(marker)) sawFrame = true;
    if (marker === 0xda) {
      // SOS: ここから先は画像の中身なので読まずに残す。フレームの見出しが無い物・中身が1バイトも無い物は壊れている
      if (!sawFrame || end >= bytes.length) return BROKEN;
      break;
    }
    if (isJpegStrippedMarker(marker)) {
      if (ranges.length >= MAX_STRIPPED_RANGES) return BROKEN;
      ranges.push([offset, end]);
    }
    offset = end;
  }
  return finish('image/jpeg', bytes, ranges);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function sanitizePng(bytes: Uint8Array): SanitizeReturnPhotoResult {
  const ranges: Range[] = [];
  let offset = PNG_SIGNATURE.length;
  let isFirst = true;
  let sawImageData = false;
  let endOfImage = -1;
  while (offset < bytes.length) {
    // 長さ4・種類4・CRC4 の12バイトが読めること
    if (offset + 12 > bytes.length) return BROKEN;
    const length = readUint32(bytes, offset);
    const end = offset + 12 + length;
    // 中身の長さは 2^31-1 まで。残りのバイトより長い長さは、途中で切れたか長さが壊れている
    if (length > 0x7fffffff || end > bytes.length) return BROKEN;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!typeBytes.every(isAsciiLetter)) return BROKEN;
    const type = String.fromCharCode(...typeBytes);
    if (isFirst && (type !== 'IHDR' || length !== 13)) return BROKEN;
    // IEND は中身を持たない決まり。中身のある IEND は付け足しを隠せるので、写真として合わない物にする
    if (type === 'IEND' && length !== 0) return BROKEN;
    isFirst = false;
    if (type === 'IDAT') sawImageData = true;
    if (PNG_STRIPPED_CHUNK_TYPES.has(type)) {
      if (ranges.length >= MAX_STRIPPED_RANGES) return BROKEN;
      ranges.push([offset, end]);
    }
    offset = end;
    if (type === 'IEND') {
      endOfImage = end;
      break;
    }
  }
  if (endOfImage < 0 || !sawImageData) return BROKEN;
  // IEND の後ろは画像の一部ではない（読む側は無視する）。付け足された物は残さない
  if (endOfImage < bytes.length) ranges.push([endOfImage, bytes.length]);
  return finish('image/png', bytes, ranges);
}

export function sanitizeReturnPhoto(bytes: Uint8Array): SanitizeReturnPhotoResult {
  if (bytes.length > RETURN_PHOTO_MAX_BYTES) return { ok: false, reason: 'too_large' };
  if (hasSignature(bytes, JPEG_SIGNATURE)) return sanitizeJpeg(bytes);
  if (hasSignature(bytes, PNG_SIGNATURE)) return sanitizePng(bytes);
  return { ok: false, reason: 'unsupported_type' };
}
