export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'mfa_required'
  | 'mfa_setup_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'locked'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  mfa_required: 401,
  mfa_setup_required: 403,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  locked: 423,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Объект') => new AppError('not_found', `${what} не найден`);
export const forbidden = (msg = 'Недостаточно прав') => new AppError('forbidden', msg);
export const unauthorized = (msg = 'Требуется вход в систему') => new AppError('unauthorized', msg);
export const badRequest = (msg: string, details?: unknown) => new AppError('bad_request', msg, details);
export const conflict = (msg: string) => new AppError('conflict', msg);
