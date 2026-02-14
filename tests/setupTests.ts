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
    },
    writable: true,
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
