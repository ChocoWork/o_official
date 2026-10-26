import {
  IMAGE_EXTENSION_BY_TYPE,
  detectImageType,
  resolveUploadImageType,
} from '@/lib/storage/image-signature';
import {
  minimalGif,
  minimalJpeg,
  minimalPng,
  minimalWebp,
  textAsImage,
} from '../../../fixtures/images';

const bytesOf = (...values: number[]) => new Uint8Array(values);
const asciiBytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));
const gifWith = (header: string) =>
  new Uint8Array(Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from([1, 0, 1, 0])]));
const riffWith = (form: string) =>
  new Uint8Array(
    Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([4, 0, 0, 0]), Buffer.from(form, 'ascii')]),
  );

describe('DD-LOOK-063 detectImageType', () => {
  it.each([
    ['PNG', new Uint8Array(minimalPng()), 'image/png'],
    ['JPEG', new Uint8Array(minimalJpeg()), 'image/jpeg'],
    ['JPEG (FF D8 FF E0)', bytesOf(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['GIF89a', new Uint8Array(minimalGif()), 'image/gif'],
    ['GIF87a', gifWith('GIF87a'), 'image/gif'],
    ['WebP', new Uint8Array(minimalWebp()), 'image/webp'],
    ['WebP (RIFF + 4 バイト + WEBP)', riffWith('WEBP'), 'image/webp'],
  ])('DD-LOOK-063 %s は %s と判定する', (_label, bytes, expected) => {
    expect(detectImageType(bytes)).toBe(expected);
  });

  it.each([
    ['空', new Uint8Array(0)],
    ['7 バイトの PNG の印', bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a)],
    ['HTML', asciiBytes('<!doctype html>')],
    ['SVG', asciiBytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['BMP', asciiBytes('BM......')],
    ['RIFF....WAVE', riffWith('WAVE')],
    ['GIF88a', gifWith('GIF88a')],
    ['文字列', asciiBytes('this is plain text')],
    ['先頭の印の無い文字列の見本', new Uint8Array(textAsImage())],
    ['RIFF で長さが足りない', asciiBytes('RIFF....WEB')],
  ])('DD-LOOK-063 %s は null になる', (_label, bytes) => {
    expect(detectImageType(bytes)).toBeNull();
  });
});

describe('DD-LOOK-063 resolveUploadImageType', () => {
  it('DD-LOOK-063 申告と検出が同じ時だけ type と extension を返す', () => {
    expect(resolveUploadImageType('image/png', new Uint8Array(minimalPng()))).toEqual({
      type: 'image/png',
      extension: 'png',
    });
  });

  it('DD-LOOK-063 申告と検出が違えば null（PNG と申告した JPEG）', () => {
    expect(resolveUploadImageType('image/png', new Uint8Array(minimalJpeg()))).toBeNull();
  });

  it('DD-LOOK-063 知らない申告（image/jpg）は null', () => {
    expect(resolveUploadImageType('image/jpg', new Uint8Array(minimalJpeg()))).toBeNull();
  });

  it('DD-LOOK-063 印の無い中身は null', () => {
    expect(resolveUploadImageType('image/png', new Uint8Array(textAsImage()))).toBeNull();
  });

  it('DD-LOOK-063 拡張子の対応は jpeg→jpg を含む 4 件', () => {
    expect(IMAGE_EXTENSION_BY_TYPE).toEqual({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    });
  });
});
