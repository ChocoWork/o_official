export type DetectedImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export const IMAGE_EXTENSION_BY_TYPE: Readonly<Record<DetectedImageType, 'jpg' | 'png' | 'webp' | 'gif'>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** 先頭の印で判定: JPEG FF D8 FF / PNG 89 50 4E 47 0D 0A 1A 0A / GIF "GIF87a"・"GIF89a" / WebP "RIFF"....."WEBP"。足りない長さ・知らない印は null。 */
export function detectImageType(bytes: Uint8Array): DetectedImageType | null {
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, GIF87A) || startsWith(bytes, GIF89A)) return 'image/gif';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}

/** 申告の種類と検出した種類が同じ時だけ { type, extension } を返す。違えば null（保存名は送られた名前からでなく、この対応表から作る）。 */
export function resolveUploadImageType(
  declaredType: string,
  bytes: Uint8Array,
): { type: DetectedImageType; extension: string } | null {
  const detected = detectImageType(bytes);
  if (!detected || detected !== declaredType) return null;
  return { type: detected, extension: IMAGE_EXTENSION_BY_TYPE[detected] };
}
