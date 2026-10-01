import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, type ErrorCode } from '@mediaradar/core';

const TITLES: Record<number, string> = {
  400: 'Некорректный запрос',
  401: 'Требуется вход',
  403: 'Доступ запрещён',
  404: 'Не найдено',
  409: 'Конфликт',
  413: 'Слишком большой запрос',
  415: 'Неподдерживаемый тип',
  422: 'Ошибка валидации',
  423: 'Заблокировано',
  429: 'Слишком много запросов',
  500: 'Внутренняя ошибка',
  501: 'Не реализовано',
};

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/** Ошибки PostgreSQL → понятные HTTP-ответы (RLS, уникальность, неверные данные). */
function fromPg(err: PgError): { status: number; code: ErrorCode; detail: string } | null {
  switch (err.code) {
    case '42501':
      return { status: 403, code: 'forbidden', detail: 'Недостаточно прав на это действие' };
    case '23505':
      return { status: 409, code: 'conflict', detail: 'Такая запись уже существует' };
    case '23503':
      return { status: 400, code: 'bad_request', detail: 'Связанный объект не найден' };
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22003':
      return { status: 400, code: 'bad_request', detail: 'Некорректные данные' };
    default:
      return null;
  }
}

export function registerErrors(app: FastifyInstance): void {
  const send = (
    reply: FastifyReply,
    status: number,
    code: string,
    detail: string,
    extra: Record<string, unknown> = {},
  ) =>
    reply
      .status(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: TITLES[status] ?? 'Ошибка',
        status,
        code,
        detail,
        requestId: reply.request.id,
        ...extra,
      });

  app.setErrorHandler((err: FastifyError | AppError | PgError, req, reply) => {
    if (err instanceof AppError) {
      return send(
        reply,
        err.status,
        err.code,
        err.message,
        err.details === undefined ? {} : { details: err.details },
      );
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const errors = err.validation.map((v) => ({
        path: (v.instancePath || '/').replace(/^\//, '').replace(/\//g, '.') || '(тело запроса)',
        message: v.message ?? 'некорректное значение',
      }));
      return send(reply, 422, 'validation_failed', 'Проверьте введённые данные', { errors });
    }
    const status = (err as FastifyError).statusCode;
    if (status === 429) return send(reply, 429, 'rate_limited', 'Слишком много запросов. Попробуйте позже.');
    if (status && status >= 400 && status < 500) return send(reply, status, 'bad_request', err.message);
    const pg = fromPg(err as PgError);
    if (pg) {
      req.log.warn(
        { pgCode: (err as PgError).code, constraint: (err as PgError).constraint },
        'database constraint',
      );
      return send(reply, pg.status, pg.code, pg.detail);
    }
    req.log.error({ err }, 'unhandled error');
    return send(reply, 500, 'internal', 'Внутренняя ошибка. Сообщите код запроса администратору.');
  });

  app.setNotFoundHandler((_req, reply) => send(reply, 404, 'not_found', 'Маршрут не найден'));
}
