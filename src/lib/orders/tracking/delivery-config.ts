import 'server-only';

const DEFAULT_BASE_URL = 'https://api.17track.net/track/v2.4';

export function readDeliveryTrackingConfig(env: NodeJS.ProcessEnv): { apiKey: string | null; baseUrl: string } {
  const baseUrl = (env.TRACKING_17TRACK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return { apiKey: null, baseUrl: DEFAULT_BASE_URL };
  } catch {
    return { apiKey: null, baseUrl: DEFAULT_BASE_URL };
  }
  return {
    apiKey: env.TRACKING_17TRACK_API_KEY?.trim() || null,
    baseUrl,
  };
}

export function isDeliveryTrackingKeyConfigured(env: NodeJS.ProcessEnv): boolean {
  return readDeliveryTrackingConfig(env).apiKey !== null;
}
