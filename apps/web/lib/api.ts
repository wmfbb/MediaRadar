/** Клиент API: same-origin (/api → Fastify), CSRF-заголовок для небезопасных методов, разбор problem+json. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly errors?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const readCookie = (name: string): string | undefined =>
  typeof document === 'undefined'
    ? undefined
    : document.cookie
        .split('; ')
        .find((c) => c.startsWith(`${name}=`))
        ?.split('=')[1];

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('mr_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
    credentials: 'same-origin',
  });
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  let problem: {
    code?: string;
    detail?: string;
    details?: unknown;
    errors?: Array<{ path: string; message: string }>;
  } = {};
  try {
    problem = await res.json();
  } catch {
    /* тело не JSON */
  }
  throw new ApiError(
    res.status,
    problem.code ?? 'error',
    problem.detail ?? `Ошибка ${res.status}`,
    problem.details,
    problem.errors,
  );
}

export const fetcher = <T>(path: string) => api<T>(path);
export const errorMessage = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Неизвестная ошибка';
/** Сообщение об ошибке конкретного поля формы (если сервер вернул разбор валидации). */
export const fieldError = (e: unknown, path: string): string | null =>
  e instanceof ApiError ? (e.errors?.find((x) => x.path === path)?.message ?? null) : null;
