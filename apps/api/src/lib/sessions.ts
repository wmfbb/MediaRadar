import { randomToken, sha256 } from '@mediaradar/core';
import type { Queryable } from '@mediaradar/db';

export interface NewSession {
  userId: string;
  tenantId: string | null;
  mfaVerified: boolean;
  ip?: string | null;
  userAgent?: string | null;
  ttlDays: number;
}

export async function createSession(q: Queryable, s: NewSession): Promise<{ token: string; id: string }> {
  const token = randomToken(32);
  const r = await q.query<{ id: string }>(
    `INSERT INTO sessions (user_id, tenant_id, token_hash, mfa_verified, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id`,
    [s.userId, s.tenantId, sha256(token), s.mfaVerified, s.ip ?? null, s.userAgent?.slice(0, 300) ?? null, s.ttlDays],
  );
  return { token, id: r.rows[0]!.id };
}

export async function revokeSession(q: Queryable, sessionId: string): Promise<void> {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllUserSessions(q: Queryable, userId: string, exceptSessionId?: string): Promise<void> {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [userId, exceptSessionId ?? null]);
}
