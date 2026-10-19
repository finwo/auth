export interface RealmInfo {
  slug: string;
  display_name: string;
  branding: Record<string, string>;
}

export interface LoginResolution {
  realm: RealmInfo;
  next: 'password' | 'oidc';
  provider?: {
    slug: string;
    display_name: string;
  };
}

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: {
      'content-type': 'application/json',
    },
    ...options,
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || response.statusText) as ApiError;
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }

  return payload as T;
}

export function getRealm(realm?: string | null): Promise<RealmInfo> {
  const query = realm ? `?realm=${encodeURIComponent(realm)}` : '';
  return request<RealmInfo>(`/api/v1/realm${query}`);
}

export function resolveLogin(realm: string | null, identifier: string): Promise<LoginResolution> {
  return request<LoginResolution>('/api/v1/login/resolve', {
    method: 'POST',
    body: JSON.stringify({ realm: realm || undefined, identifier }),
  });
}

export function signInPassword(
  realm: string | null,
  identifier: string,
  password: string
): Promise<Record<string, unknown>> {
  return request('/api/v1/login/password', {
    method: 'POST',
    body: JSON.stringify({ realm: realm || undefined, identifier, password }),
  });
}
