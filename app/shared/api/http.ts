export interface ApiError extends Error {
  code?: string;
  status?: number;
}

export function toApiError(payload: any, response: Response): ApiError {
  const error = new Error(
    payload?.error_description ||
      payload?.error?.message ||
      response.statusText
  ) as ApiError;
  error.code = payload?.error?.code || payload?.error;
  error.status = response.status;
  return error;
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) throw toApiError(payload, response);
  return payload as T;
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  });
  return parseJsonResponse<T>(response);
}

export async function formRequest<T>(
  url: string,
  values: Record<string, string>
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(values).toString(),
  });
  return parseJsonResponse<T>(response);
}
