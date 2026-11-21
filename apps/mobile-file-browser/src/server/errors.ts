import type { ApiErrorBody, ErrorCode } from '../shared/types';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  'invalid-credentials': 401,
  'forbidden-path': 403,
  'not-found': 404,
  'not-directory': 400,
  'unsupported-image': 415,
  'rate-limited': 429,
  'method-not-allowed': 405,
  'bad-request': 400,
  internal: 500,
};

const MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  unauthorized: '请先登录',
  'invalid-credentials': '密码不正确或已锁定',
  'forbidden-path': '无法访问该位置',
  'not-found': '文件夹可能已被移动或删除',
  'not-directory': '该位置不是文件夹',
  'unsupported-image': '此格式暂不支持预览',
  'rate-limited': '尝试次数过多，请稍后再试',
  'method-not-allowed': '不支持该请求方法',
  'bad-request': '请求格式不正确',
  internal: '服务暂时不可用',
};

/** A handled error whose message is safe to show to the client. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, retryAfterSeconds?: number) {
    super(MESSAGE_BY_CODE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function toApiErrorBody(code: ErrorCode): ApiErrorBody {
  return { error: { code, message: MESSAGE_BY_CODE[code] } };
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
