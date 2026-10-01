import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client, createTestApp, loginAs, tenantIds, type TestCtx } from './helpers';

let ctx: TestCtx;
let base: string;
let tenants: { A: string; B: string };

beforeAll(async () => {
  ctx = await createTestApp();
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}/v1/ws`;
  tenants = await tenantIds();
});
afterAll(() => ctx.close());

const cookieOf = (c: Client) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

interface Conn { ws: WebSocket; messages: Array<{ type: string; data?: { title?: string } }>; closed: Promise<number> }
function connect(c: Client | null, origin: string | null = 'http://localhost:3000'): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (c) headers.cookie = cookieOf(c);
    if (origin) headers.origin = origin;
    const ws = new WebSocket(base, { headers });
    const messages: Conn['messages'] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.once('open', () => setTimeout(() => resolve({ ws, messages, closed }), 100)); // hello приходит сразу после подписки
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', () => {});
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const article = (title: string, topic = 'gov') => ({ id: title, title, topic });

describe('WebSocket: поток материалов в реальном времени', () => {
  it('без входа подключение отклоняется (401)', async () => {
    await expect(connect(null)).rejects.toMatchObject({ status: 401 });
  });

  it('клиент получает приветствие и события своего тенанта, но не чужого', async () => {
    const owner = await loginAs(ctx, 'a.prokhorov@altai.media');
    const conn = await connect(owner);
    expect(conn.messages[0]).toMatchObject({ type: 'hello', tenantId: tenants.A });
    await ctx.bus.publish(`tenant:${tenants.A}:feed`, article('Для тенанта A'));
    await ctx.bus.publish(`tenant:${tenants.B}:feed`, article('Для тенанта B'));
    await wait(150);
    const titles = conn.messages.filter((m) => m.type === 'article').map((m) => m.data!.title);
    expect(titles).toEqual(['Для тенанта A']);
    conn.ws.close();
    await conn.closed;
  });

  it('пользователь с ограничением по темам не получает события других тем', async () => {
    const irina = await loginAs(ctx, 'i.lapteva@agro22.ru'); // область: agro, food
    const conn = await connect(irina);
    await ctx.bus.publish(`tenant:${tenants.A}:feed`, article('Госуправление', 'gov'));
    await ctx.bus.publish(`tenant:${tenants.A}:feed`, article('Агро', 'agro'));
    await wait(150);
    expect(conn.messages.filter((m) => m.type === 'article').map((m) => m.data!.title)).toEqual(['Агро']);
    conn.ws.close();
    await conn.closed;
  });

  it('чужой Origin закрывается (CSWSH); число соединений на пользователя ограничено', async () => {
    const owner = await loginAs(ctx, 'd.esin@altai.media');
    const evil = await connect(owner, 'https://evil.example');
    expect(await evil.closed).toBe(1008);
    const conns: Conn[] = [];
    for (let i = 0; i < 5; i++) conns.push(await connect(owner));
    const sixth = await connect(owner);
    expect(await sixth.closed).toBe(1008);
    for (const c of conns) { c.ws.close(); await c.closed; }
  });

  it('после выхода из системы новое подключение невозможно', async () => {
    const c = await loginAs(ctx, 'o.timoshina@altai.media');
    const cookie = cookieOf(c);
    await c.post('/v1/auth/logout');
    const stale = new Client(ctx.app);
    cookie.split('; ').forEach((kv) => stale.cookies.set(kv.split('=')[0]!, kv.split('=')[1]!));
    await expect(connect(stale)).rejects.toMatchObject({ status: 401 });
  });
});
