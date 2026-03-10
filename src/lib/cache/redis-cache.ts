interface UpstashRedisResponse<T> {
  result?: T;
}

function getRedisConfig() {
  const url = process.env.REDIS_REST_URL;
  const token = process.env.REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return { url, token };
}

export async function getRedisJson<T>(key: string): Promise<T | null> {
  const config = getRedisConfig();
  if (!config) {
    return null;
  }

  try {
    const response = await fetch(`${config.url}/get/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as UpstashRedisResponse<string | null>;
    if (!data.result) {
      return null;
    }

    return JSON.parse(data.result) as T;
  } catch {
    return null;
  }
}

export async function setRedisJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const config = getRedisConfig();
  if (!config) {
    return;
  }

  try {
    const payload = encodeURIComponent(JSON.stringify(value));
    const response = await fetch(`${config.url}/setex/${encodeURIComponent(key)}/${ttlSeconds}/${payload}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return;
    }
  } catch {
    return;
  }
}
