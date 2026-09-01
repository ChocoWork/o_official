import '@testing-library/jest-dom';
import { webcrypto } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';

// Polyfill Web Crypto API for Jest (Node.js environment)
if (!(globalThis as any).crypto || !(globalThis as any).crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...webcrypto,
      subtle: webcrypto.subtle,
      getRandomValues: (arr: Uint8Array) => {
        return webcrypto.getRandomValues(arr);
      },
      randomUUID: () => webcrypto.randomUUID(),
    },
    writable: true,
  });
} else if (!(globalThis as any).crypto.randomUUID) {
  // jsdom 環境で randomUUID だけ不足している場合の補完
  const existingCrypto = (globalThis as any).crypto;
  Object.defineProperty(existingCrypto, 'randomUUID', {
    value: () => webcrypto.randomUUID(),
    writable: true,
    configurable: true,
  });
}

// Polyfill TextEncoder/TextDecoder for Jest
if (!(globalThis as any).TextEncoder) {
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: TextEncoder,
    writable: true,
  });
}

if (!(globalThis as any).TextDecoder) {
  Object.defineProperty(globalThis, 'TextDecoder', {
    value: TextDecoder,
    writable: true,
  });
}

// jsdom は IntersectionObserver を実装していない。
// ScrollReveal など useEffect の中でこの API を使うコンポーネントは、
// polyfill が無いと render 時に ReferenceError を投げてテストが落ちる。
// コールバックは発火しない最小のスタブ。交差を再現したいテストが出てきたら、
// そのテスト側で observe を差し替えること。
if (!(globalThis as any).IntersectionObserver) {
  class IntersectionObserverStub implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '0px';
    readonly thresholds: ReadonlyArray<number> = [0];

    // コールバックもオプションも使わないので受け取らない（余分な引数は無視される）。

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(globalThis, 'IntersectionObserver', {
    value: IntersectionObserverStub,
    writable: true,
  });
}
