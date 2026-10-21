import 'server-only';

const DEFAULT_BASE_URL = 'https://api.17track.net/track/v2.4';

export function readDeliveryTrackingConfig(env: NodeJS.ProcessEnv): { apiKey: string | null; baseUrl: string } {
  return {
    apiKey: env.TRACKING_17TRACK_API_KEY?.trim() || null,
    baseUrl: (env.TRACKING_17TRACK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

export function isDeliveryTrackingKeyConfigured(env: NodeJS.ProcessEnv): boolean {
  return readDeliveryTrackingConfig(env).apiKey !== null;
}
