import type {
  DirectoryResponse,
  ErrorCode,
  HealthResponse,
  LoginRequest,
  PairRequest,
  RootInfo,
  SessionResponse,
} from '../shared/types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(message: string, code: ErrorCode, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('与电脑的连接已断开', 'internal', 0);
  }

  if (response.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const parsed = body as { error?: { code?: ErrorCode; message?: string } } | undefined;
    const code = parsed?.error?.code ?? 'internal';
    const message = parsed?.error?.message ?? '请求失败';
    if (response.status === 401 && !url.startsWith('/api/session/pair') && !url.startsWith('/api/session/login')) {
      window.dispatchEvent(new Event('mfb:unauthorized'));
    }
    throw new ApiError(message, code, response.status);
  }
  return body as T;
}

export function getSession(): Promise<SessionResponse> {
  return request<SessionResponse>('/api/session');
}

export function pair(token: string): Promise<void> {
  const body: PairRequest = { token };
  return request<void>('/api/session/pair', { method: 'POST', body: JSON.stringify(body) });
}

export function login(password: string): Promise<void> {
  const body: LoginRequest = { password };
  return request<void>('/api/session/login', { method: 'POST', body: JSON.stringify(body) });
}

export function logout(): Promise<void> {
  return request<void>('/api/session/logout', { method: 'POST' });
}

export function getRoots(): Promise<{ roots: RootInfo[] }> {
  return request<{ roots: RootInfo[] }>('/api/roots');
}

export function getDirectory(root: string, directoryPath: string): Promise<DirectoryResponse> {
  const params = new URLSearchParams({ root });
  if (directoryPath) params.set('path', directoryPath);
  return request<DirectoryResponse>(`/api/directories?${params.toString()}`);
}

export function health(): Promise<HealthResponse> {
  return request<HealthResponse>('/healthz');
}
