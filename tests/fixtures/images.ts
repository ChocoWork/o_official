/** 試験の画像の見本。先頭の印だけが本物で、画像として開けるとは限らない最小の物。 */

export function minimalPng(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
    'hex',
  );
}

export function minimalJpeg(): Buffer {
  return Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
}

export function minimalGif(): Buffer {
  return Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
}

export function minimalWebp(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8L', 'ascii'),
    Buffer.from([0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]),
  ]);
}

/** 先頭の印が無い文字列 */
export function textAsImage(): Buffer {
  return Buffer.from('this is plain text, not an image', 'utf8');
}

export function fileOf(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}
