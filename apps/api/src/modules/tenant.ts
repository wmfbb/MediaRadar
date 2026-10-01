import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, TENANT_ROLE_KEYS, randomToken, sha256, type TenantRoleKey } from '@mediaradar/core';
import { TENANT_ROLE_META, TENANT_ROLE_PERMISSIONS } from '@mediaradar/rbac';
import type { Queryable } from '@mediaradar/db';
import { audit } from '../lib/audit';
import { assertWithinLimit, loadEntitlements } from '../lib/entitlements';
import { camel, camelAll, uuidParam } from '../lib/http';
import { tctx, requireAuth, type Access } from '../plugins/auth';

const roleKey = z.enum(TENANT_ROLE_KEYS);

export async function tenantRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, config, mailer } = app.deps;

  const findRole = async (q: Queryable, key: string) => {
    const row = (await q.query<{ id: string; key: string }>('SELECT id, key FROM roles WHERE key = $1 AND tenant_id IS NULL', [key])).rows[0];
    if (!row) throw new AppError('not_found', 'Роль не найдена');
    return row;
  };
  const activeOwners = async (q: Queryable) =>
    (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships m JOIN roles r ON r.id = m.role_id WHERE r.key = 'OWNER' AND m.status = 'active'`)).rows[0]!.n;

  r.get('/tenant', access.tenant('tenant:read'), async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const t = (await q.query('SELECT id, slug, name, status, region_profile, legal_profile, branding, created_at FROM tenants WHERE id = $1', [a.tenantId])).rows[0]!;
      const counts = (await q.query<{ members: number; sources: number }>(`SELECT (SELECT count(*)::int FROM memberships WHERE status = 'active') AS members, (SELECT count(*)::int FROM tenant_sources WHERE enabled) AS sources`)).rows[0]!;
      return { ...camel(t), counts };
    }, { readOnly: true });
  });

  r.patch('/tenant', {
    ...access.tenant('tenant:settings_basic'),
    schema: { body: z.object({ name: z.string().trim().min(2).max(120).optional(), branding: z.object({ productName: z.string().trim().min(2).max(60).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional() }) },
  }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const before = (await q.query('SELECT name, branding FROM tenants WHERE id = $1', [a.tenantId])).rows[0]!;
      const res = await q.query(`UPDATE tenants SET name = coalesce($2, name), branding = branding || coalesce($3::jsonb, '{}'::jsonb) WHERE id = $1 RETURNING name, branding`, [a.tenantId, req.body.name ?? null, req.body.branding ? JSON.stringify(req.body.branding) : null]);
      await audit(q, req, { action: 'tenant.updated', objectType: 'tenant', objectId: a.tenantId, before, after: res.rows[0] });
      return camel(res.rows[0]!);
    });
  });

  // --- участники --------------------------------------------------------------------------------
  r.get('/tenant/members', access.tenant('user:read'), async (req) => {
    return db.tenant(tctx(req), async (q) => {
      const res = await q.query(
        `SELECT m.id, m.user_id, u.display_name AS name, u.email, u.last_login_at, u.totp_enabled, m.status, m.scope, m.created_at, r.key AS role_key, r.name AS role_name
           FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id ORDER BY m.created_at, u.display_name`);
      return { items: camelAll(res.rows) };
    }, { readOnly: true });
  });

  r.patch('/tenant/members/:id', {
    ...access.tenant('user:manage'),
    schema: { params: uuidParam, body: z.object({ roleKey: roleKey.optional(), status: z.enum(['active', 'blocked']).optional() }).refine((b) => b.roleKey || b.status, 'Нечего менять') },
  }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const m = (await q.query<{ id: string; user_id: string; status: string; role_key: TenantRoleKey }>(
        'SELECT m.id, m.user_id, m.status, r.key AS role_key FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.id = $1 FOR UPDATE OF m', [req.params.id])).rows[0];
      if (!m) throw new AppError('not_found', 'Участник не найден');
      if (m.user_id === a.userId) throw new AppError('forbidden', 'Нельзя изменить собственную роль или статус');
      const callerIsOwner = a.tenantRole === 'OWNER';
      if ((m.role_key === 'OWNER' || req.body.roleKey === 'OWNER') && !callerIsOwner) throw new AppError('forbidden', 'Роль владельца могут менять только владельцы');
      const losingOwner = m.role_key === 'OWNER' && ((req.body.roleKey && req.body.roleKey !== 'OWNER') || req.body.status === 'blocked');
      if (losingOwner && (await activeOwners(q)) <= 1) throw new AppError('conflict', 'В тенанте должен остаться хотя бы один активный владелец');
      if (req.body.roleKey) {
        const role = await findRole(q, req.body.roleKey);
        await q.query('UPDATE memberships SET role_id = $2 WHERE id = $1', [m.id, role.id]);
      }
      if (req.body.status) await q.query('UPDATE memberships SET status = $2 WHERE id = $1', [m.id, req.body.status]);
      await audit(q, req, { action: 'tenant.member_updated', objectType: 'membership', objectId: m.id, before: { role: m.role_key, status: m.status }, after: req.body });
      return { status: 'ok' };
    });
  });

  r.delete('/tenant/members/:id', { ...access.tenant('user:manage'), schema: { params: uuidParam } }, async (req) => {
    const a = requireAuth(req);
    return db.tenant(tctx(req), async (q) => {
      const m = (await q.query<{ user_id: string; role_key: TenantRoleKey }>('SELECT m.user_id, r.key AS role_key FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.id = $1 FOR UPDATE OF m', [req.params.id])).rows[0];
      if (!m) throw new AppError('not_found', 'Участник не найден');
      if (m.user_id === a.userId) throw new AppError('forbidden', 'Нельзя удалить самого себя');
      if (m.role_key === 'OWNER' && (a.tenantRole !== 'OWNER' || (await activeOwners(q)) <= 1)) throw new AppError('forbidden', 'Владельца нельзя удалить');
      await q.query('DELETE FROM memberships WHERE id = $1', [req.params.id]);
      await audit(q, req, { action: 'tenant.member_removed', objectType: 'membership', objectId: req.params.id, before: { role: m.role_key } });
      return { status: 'ok' };
    });
  });

  r.get('/tenant/roles', access.tenant('tenant:read'), async () => ({
    items: TENANT_ROLE_KEYS.map((key) => ({ key, ...TENANT_ROLE_META[key], permissions: [...TENANT_ROLE_PERMISSIONS[key]] })),
  }));

  // --- приглашения ------------------------------------------------------------------------------
  r.get('/tenant/invitations', access.tenant('user:read'), async (req) =>
    db.tenant(tctx(req), async (q) => ({
      items: camelAll((await q.query(`SELECT i.id, i.email, i.expires_at, i.created_at, r.key AS role_key, r.name AS role_name FROM invitations i JOIN roles r ON r.id = i.role_id WHERE i.accepted_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`)).rows),
    }), { readOnly: true }));

  r.post('/tenant/invitations', {
    ...access.tenant('user:manage'),
    schema: { body: z.object({ email: z.string().trim().toLowerCase().email().max(254), roleKey: roleKey }) },
  }, async (req, reply) => {
    const a = requireAuth(req);
    if (req.body.roleKey === 'OWNER' && a.tenantRole !== 'OWNER') throw new AppError('forbidden', 'Приглашать владельцев могут только владельцы');
    const token = randomToken(32);
    const info = await db.tenant(tctx(req), async (q) => {
      const ent = await loadEntitlements(q);
      const used = (await q.query<{ n: number }>(`SELECT ((SELECT count(*) FROM memberships WHERE status = 'active') + (SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND expires_at > now()))::int AS n`)).rows[0]!.n;
      assertWithinLimit(ent, 'seats', used, 'пользователи');
      if ((await q.query('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1', [req.body.email])).rowCount)
        throw new AppError('conflict', 'Этот пользователь уже состоит в тенанте');
      const role = await findRole(q, req.body.roleKey);
      const inv = (await q.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days') RETURNING id`,
        [a.tenantId, req.body.email, role.id, sha256(token), a.userId])).rows[0]!;
      await audit(q, req, { action: 'tenant.invitation_created', objectType: 'invitation', objectId: inv.id, after: { email: req.body.email, role: req.body.roleKey } });
      return { id: inv.id, tenantName: a.tenant!.name };
    });
    await mailer.send({
      to: req.body.email,
      subject: `Приглашение в МедиаРадар: ${info.tenantName}`,
      text: `${a.name} приглашает вас в рабочее пространство «${info.tenantName}» (роль: ${TENANT_ROLE_META[req.body.roleKey].name}).\n\nПринять приглашение (действует 7 дней):\n${config.APP_BASE_URL}/accept-invite?token=${token}`,
    });
    return reply.status(201).send({ id: info.id });
  });

  r.delete('/tenant/invitations/:id', { ...access.tenant('user:manage'), schema: { params: uuidParam } }, async (req) =>
    db.tenant(tctx(req), async (q) => {
      const res = await q.query<{ email: string }>('DELETE FROM invitations WHERE id = $1 AND accepted_at IS NULL RETURNING email', [req.params.id]);
      const gone = res.rows[0];
      if (!gone) throw new AppError('not_found', 'Приглашение не найдено');
      await audit(q, req, { action: 'tenant.invitation_revoked', objectType: 'invitation', objectId: req.params.id, before: { email: gone.email } });
      return { status: 'ok' };
    }));

  // --- аудит ------------------------------------------------------------------------------------
  r.get('/tenant/audit', {
    ...access.tenant('audit:read'),
    schema: { querystring: z.object({ action: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.date().optional() }) },
  }, async (req) =>
    db.tenant(tctx(req), async (q) => {
      const { action, limit, before } = req.query;
      const res = await q.query(
        `SELECT l.id, l.ts, l.actor_id, u.display_name AS actor_name, l.actor_type, l.action, l.object_type, l.object_id, l.after, l.ip
           FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
          WHERE ($1::text IS NULL OR l.action LIKE $1 || '%') AND ($2::timestamptz IS NULL OR l.ts < $2) ORDER BY l.ts DESC, l.id DESC LIMIT $3`,
        [action ?? null, before ?? null, limit]);
      const items = camelAll(res.rows);
      return { items, nextBefore: items.length === limit ? (items[items.length - 1] as { ts: Date }).ts : null };
    }, { readOnly: true }));
}
