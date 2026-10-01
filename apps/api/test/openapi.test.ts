import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp({ docs: true });
});
afterAll(() => ctx.close());

describe('OpenAPI', () => {
  it('спецификация генерируется из схем Zod и описывает основные маршруты', async () => {
    const res = await ctx.app.inject({ url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/v1/auth/login', '/v1/articles', '/v1/dashboard', '/v1/sources', '/v1/settings/{key}']));
    expect(spec.paths['/v1/auth/login'].post.requestBody).toBeTruthy();
    expect(spec.components.securitySchemes.session).toMatchObject({ type: 'apiKey', in: 'cookie' });
  });
});
