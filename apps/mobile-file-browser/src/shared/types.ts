export type EntryKind = 'directory' | 'image' | 'other';

export type AccessMode = 'local' | 'lan' | 'remote';

export type ErrorCode =
  | 'unauthorized'
  | 'invalid-credentials'
  | 'forbidden-path'
  | 'not-found'
  | 'not-directory'
  | 'unsupported-image'
  | 'rate-limited'
  | 'method-not-allowed'
  | 'bad-request'
  | 'internal';

export interface RootInfo {
  id: string;
  name: string;
}

export interface Entry {
  name: string;
  kind: EntryKind;
  size?: number;
  mtime?: string;
  thumbUrl?: string;
  imageUrl?: string;
  previewUrl?: string;
  note?: string;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export interface DirectoryResponse {
  root: RootInfo;
  path: string;
  breadcrumb: Breadcrumb[];
  entries: Entry[];
  truncated: boolean;
  sort: 'name';
}

export interface SessionResponse {
  authenticated: boolean;
  mode: AccessMode;
  passwordConfigured: boolean;
  pairingAvailable: boolean;
  expiresAt?: string;
}

export interface HealthResponse {
  ok: true;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export interface PairRequest {
  token: string;
}

export interface LoginRequest {
  password: string;
}
