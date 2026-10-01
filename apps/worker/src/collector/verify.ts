import type { Logger } from '../jobs';
import type { Run } from './collect';
import { safeFetch, type Fetcher } from './http';

/** Расписание проверок наличия материала после сбора: через 1 ч, 6 ч, 1 сутки, 3 суток, 7 суток. Дальше не проверяем. */
export const CHECK_DELAYS_MS = [1, 6, 24, 72, 168].map((h) => h * 3600_000);
const RETRY_AFTER_INCONCLUSIVE_MS = 30 * 60_000;
const BATCH = 40;

export type Verdict =
  | { kind: 'alive' }
  | { kind: 'gone'; reason: 'http_404' | 'http_410' | 'http_451' | 'redirect_to_root' }
  | { kind: 'unknown'; reason: string };

/**
 * Удалением считаем только прямое «страница не найдена» (404/410/451) или перенаправление с глубокого адреса на главную.
 * Пропажа из RSS-ленты ничего не доказывает (лента прокручивается), сбои сети и 5xx — «не уверены, проверим позже».
 */
export function judge(
  originalUrl: string,
  res: { status: number; url: string; redirected: boolean },
): Verdict {
  if (res.status === 404 || res.status === 410 || res.status === 451)
    return { kind: 'gone', reason: `http_${res.status}` as 'http_404' };
  if (res.status >= 200 && res.status < 300) {
    if (res.redirected) {
      const was = new URL(originalUrl);
      const now = new URL(res.url);
      if (was.pathname.length > 1 && now.pathname.replace(/\/+$/, '') === '' && now.hostname === was.hostname)
        return { kind: 'gone', reason: 'redirect_to_root' };
    }
    return { kind: 'alive' };
  }
  return { kind: 'unknown', reason: `HTTP ${res.status}` };
}

export interface VerifyDeps {
  run: Run;
  log: Logger;
  fetch?: Fetcher;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

async function probe(get: Fetcher, url: string) {
  const head = await get(url, { method: 'HEAD', timeoutMs: 15_000 });
  // часть сайтов не отвечает на HEAD — повторяем обычным GET
  if ([400, 403, 405, 501].includes(head.status))
    return get(url, { timeoutMs: 15_000, maxBytes: 256 * 1024 });
  return head;
}

/** Проверка наличия материалов на источнике: фиксирует удаление (с временем и доказательством) и возвращение. */
export async function verifyArticles(
  deps: VerifyDeps,
): Promise<{ checked: number; removed: number; restored: number }> {
  const { run, log } = deps;
  const get = deps.fetch ?? safeFetch;
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const due = await run(async (q) => {
    const r = await q.query<{
      id: string;
      url: string;
      fetched_at: Date;
      check_count: number;
      source_state: string;
    }>(
      `SELECT id, url, fetched_at, check_count, source_state FROM articles
        WHERE next_check_at IS NOT NULL AND next_check_at <= $1 ORDER BY next_check_at LIMIT ${BATCH}`,
      [now],
    );
    return r.rows;
  });

  let removed = 0;
  let restored = 0;
  for (const a of due) {
    let verdict: Verdict;
    let evidence: Record<string, unknown>;
    try {
      const res = await probe(get, a.url);
      verdict = judge(a.url, res);
      evidence = { status: res.status, finalUrl: res.url, checkedAt: now.toISOString() };
    } catch (e) {
      verdict = { kind: 'unknown', reason: (e as Error).message };
      evidence = { error: (e as Error).message.slice(0, 200), checkedAt: now.toISOString() };
    }

    if (verdict.kind === 'unknown') {
      await run((q) =>
        q.query('UPDATE articles SET last_checked_at = $2, next_check_at = $3 WHERE id = $1', [
          a.id,
          now,
          new Date(now.getTime() + RETRY_AFTER_INCONCLUSIVE_MS),
        ]),
      );
    } else {
      const count = a.check_count + 1;
      const next =
        count < CHECK_DELAYS_MS.length ? new Date(a.fetched_at.getTime() + CHECK_DELAYS_MS[count]!) : null;
      const nextAt =
        next && next.getTime() > now.getTime()
          ? next
          : next
            ? new Date(now.getTime() + RETRY_AFTER_INCONCLUSIVE_MS)
            : null;
      if (verdict.kind === 'gone') {
        await run((q) =>
          q.query(
            `UPDATE articles SET source_state = 'removed', removed_at = COALESCE(removed_at, $2), removal_evidence = $3,
                    last_checked_at = $2, check_count = $4, next_check_at = $5 WHERE id = $1`,
            [a.id, now, JSON.stringify({ ...evidence, reason: verdict.reason }), count, nextAt],
          ),
        );
        if (a.source_state !== 'removed') removed++;
      } else {
        await run((q) =>
          q.query(
            `UPDATE articles SET source_state = 'available',
                    restored_at = CASE WHEN source_state = 'removed' THEN $2 ELSE restored_at END,
                    removal_evidence = CASE WHEN source_state = 'removed' THEN $3 ELSE removal_evidence END,
                    last_checked_at = $2, check_count = $4, next_check_at = $5 WHERE id = $1`,
            [a.id, now, JSON.stringify({ ...evidence, reason: 'restored' }), count, nextAt],
          ),
        );
        if (a.source_state === 'removed') restored++;
      }
    }
    await sleep(250);
  }
  if (due.length) log.info({ checked: due.length, removed, restored }, 'verify: проверка наличия завершена');
  return { checked: due.length, removed, restored };
}
