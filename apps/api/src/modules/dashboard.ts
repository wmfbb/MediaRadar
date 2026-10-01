import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SENTIMENT_KEYS, SENTIMENTS, type SentimentLabel } from '@mediaradar/core';
import { ARTICLE_FROM, buildArticleWhere, tenantTz } from '../lib/content';
import { camelAll, rangeBounds, rangeSchema } from '../lib/http';
import { detectSpikes } from '../lib/spikes';
import { periodQuery, topWords } from '../lib/stats';
import { requireAuth, tctx, type Access } from '../plugins/auth';

/** Изменение к прошлому периоду. Если в прошлом периоде мало данных (сбор только начался), сравнение не показываем. */
const MIN_PREV_FOR_DELTA = 30;
const pct = (cur: number, prev: number): number | null =>
  prev < MIN_PREV_FOR_DELTA ? null : Math.round(((cur - prev) / prev) * 1000) / 10;
/** Цвета рядов, когда график строится по источникам (тем у материалов ещё нет). */
const SERIES_COLORS = ['#3363ff', '#059669', '#f59e0b', '#8b5cf6', '#e11d48', '#94a3b8'];
export async function dashboardRoutes(app: FastifyInstance, access: Access): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, queues } = app.deps;

  // ------------------------------------------------------------------------------------------------
  r.get(
    '/dashboard',
    { ...access.tenant('dashboard:read'), schema: { querystring: z.object({ range: rangeSchema }) } },
    async (req) => {
      const a = requireAuth(req);
      const { from, to, prevFrom, bucket, days } = rangeBounds(req.query.range);
      const tz = tenantTz(a);
      const stepSec = Math.max(1, Math.floor((to.getTime() - from.getTime()) / 1000 / 12));

      const data = await db.tenant(
        tctx(req),
        async (q) => {
          // KPI: текущий и предыдущий период
          const w = buildArticleWhere({ from: prevFrom, to }, a);
          const k = (
            await q.query<{ cur: number; prev: number; neg_cur: number; neg_prev: number }>(
              `SELECT count(*) FILTER (WHERE a.published_at >= $${w.params.length + 1})::int AS cur,
                count(*) FILTER (WHERE a.published_at < $${w.params.length + 1})::int AS prev,
                count(*) FILTER (WHERE a.published_at >= $${w.params.length + 1} AND a.sentiment_label IN ('NG','VN'))::int AS neg_cur,
                count(*) FILTER (WHERE a.published_at < $${w.params.length + 1} AND a.sentiment_label IN ('NG','VN'))::int AS neg_prev
           ${ARTICLE_FROM} WHERE ${w.sql}`,
              [...w.params, from],
            )
          ).rows[0]!;
          const spark = async (negOnly: boolean) => {
            const rows = await periodQuery<{ k: number; n: number }>(
              q,
              a,
              from,
              to,
              `floor(extract(epoch FROM (a.published_at - {1}::timestamptz)) / {2})::int AS k, count(*)::int AS n`,
              `${negOnly ? "AND a.sentiment_label IN ('NG','VN')" : ''} GROUP BY k`,
              [from, stepSec],
            );
            const out = Array.from({ length: 12 }, () => 0);
            for (const row of rows) if (row.k >= 0 && row.k < 12) out[row.k] = row.n;
            return out;
          };
          const sparkAll = await spark(false);
          const sparkNeg = await spark(true);
          const src = (
            await q.query<{ active: number; total: number }>(
              `SELECT count(*) FILTER (WHERE s.status = 'active')::int AS active, count(*)::int AS total FROM tenant_sources ts JOIN sources s ON s.id = ts.source_id WHERE ts.enabled`,
            )
          ).rows[0]!;
          const alerts = (
            await q.query<{ n: number }>(
              'SELECT coalesce(sum(fired_count), 0)::int AS n FROM alert_rules WHERE enabled',
            )
          ).rows[0]!.n;

          // тональность
          const sentRows = await periodQuery<{ label: SentimentLabel; n: number }>(
            q,
            a,
            from,
            to,
            'a.sentiment_label AS label, count(*)::int AS n',
            'AND a.sentiment_label IS NOT NULL GROUP BY a.sentiment_label',
          );
          const sentCounts = Object.fromEntries(
            SENTIMENT_KEYS.map((key) => [key, sentRows.find((x) => x.label === key)?.n ?? 0]),
          ) as Record<SentimentLabel, number>;

          // динамика по темам (границы суток/часов — в часовом поясе тенанта)
          const labels = (
            await q.query<{ label: string }>(
              `SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS label FROM generate_series(date_trunc('${bucket}', $1::timestamptz AT TIME ZONE $3), date_trunc('${bucket}', $2::timestamptz AT TIME ZONE $3), '1 ${bucket}'::interval) AS b ORDER BY b`,
              [from, to, tz],
            )
          ).rows.map((x) => x.label);
          const vol = await periodQuery<{ label: string; key: string; n: number }>(
            q,
            a,
            from,
            to,
            `to_char(date_trunc('${bucket}', a.published_at AT TIME ZONE {1}), 'YYYY-MM-DD"T"HH24:MI') AS label, t.key, count(*)::int AS n`,
            'AND t.key IS NOT NULL GROUP BY 1, 2',
            [tz],
          );
          const topics = (
            await q.query<{ key: string; name: string; color: string }>(
              'SELECT key, name, color FROM topics ORDER BY sort, name',
            )
          ).rows;
          const idx = new Map(labels.map((l, i) => [l, i]));
          const series = topics
            .map((t) => {
              const data = labels.map(() => 0);
              for (const v of vol)
                if (v.key === t.key) {
                  const i = idx.get(v.label);
                  if (i !== undefined) data[i] = v.n;
                }
              return { ...t, data };
            })
            .filter((s) => s.data.some((x) => x > 0));

          // темы определяет Фаза 3; пока их нет, показываем динамику по самым крупным источникам, остальные — «Прочие»
          let volumeBy: 'topic' | 'source' = 'topic';
          if (!series.length) {
            volumeBy = 'source';
            const bySource = await periodQuery<{ label: string; id: string; name: string; n: number }>(
              q,
              a,
              from,
              to,
              `to_char(date_trunc('${bucket}', a.published_at AT TIME ZONE {1}), 'YYYY-MM-DD"T"HH24:MI') AS label, s.id, s.name, count(*)::int AS n`,
              'GROUP BY 1, 2, 3',
              [tz],
            );
            const totals = new Map<string, { name: string; n: number }>();
            for (const v of bySource) {
              const t = totals.get(v.id) ?? totals.set(v.id, { name: v.name, n: 0 }).get(v.id)!;
              t.n += v.n;
            }
            const top = [...totals].sort((x, y) => y[1].n - x[1].n).slice(0, 5);
            const rows = top.map(([id, t], i) => ({
              key: id,
              name: t.name,
              color: SERIES_COLORS[i]!,
              data: labels.map(() => 0),
            }));
            const other = {
              key: 'other',
              name: 'Прочие',
              color: SERIES_COLORS[5]!,
              data: labels.map(() => 0),
            };
            for (const v of bySource) {
              const i = idx.get(v.label);
              if (i === undefined) continue;
              (rows.find((r) => r.key === v.id) ?? other).data[i]! += v.n;
            }
            series.push(...rows);
            if (other.data.some((x) => x > 0)) series.push(other);
          }

          const topSources = await periodQuery(
            q,
            a,
            from,
            to,
            's.id, s.name, s.domain, s.kind, count(*)::int AS count',
            'GROUP BY s.id, s.name, s.domain, s.kind ORDER BY count DESC LIMIT 8',
          );
          const places = await periodQuery(
            q,
            a,
            from,
            to,
            'g.id, g.name, g.level, count(*)::int AS count',
            'AND g.id IS NOT NULL GROUP BY g.id, g.name, g.level ORDER BY count DESC',
          );
          const pw = buildArticleWhere({ from, to }, a);
          const persons = (
            await q.query<{ id: string; name: string; count: number }>(
              `SELECT e.id, e.canonical_name AS name, count(DISTINCT a.id)::int AS count ${ARTICLE_FROM} JOIN article_entities ae ON ae.article_id = a.id JOIN entities e ON e.id = ae.entity_id AND e.type = 'person'
          WHERE ${pw.sql} GROUP BY e.id, e.canonical_name ORDER BY count DESC, name LIMIT 7`,
              pw.params,
            )
          ).rows;
          const personsTotal = (
            await q.query<{ n: number }>(
              `SELECT count(DISTINCT e.id)::int AS n ${ARTICLE_FROM} JOIN article_entities ae ON ae.article_id = a.id JOIN entities e ON e.id = ae.entity_id AND e.type = 'person' WHERE ${pw.sql}`,
              pw.params,
            )
          ).rows[0]!.n;

          const health = (
            await q.query(
              `SELECT s.parser, count(*)::int AS sources, count(*) FILTER (WHERE s.status = 'error')::int AS errors, count(*) FILTER (WHERE s.status = 'paused')::int AS paused,
                min(s.domain) FILTER (WHERE s.status = 'error') AS failing_domain, max(s.error_count)::int AS max_errors
           FROM tenant_sources ts JOIN sources s ON s.id = ts.source_id WHERE ts.enabled GROUP BY s.parser ORDER BY sources DESC`,
            )
          ).rows;

          return {
            k,
            sparkAll,
            sparkNeg,
            src,
            alerts,
            sentCounts,
            labels,
            series,
            volumeBy,
            topSources,
            places,
            persons,
            personsTotal,
            health,
          };
        },
        { readOnly: true },
      );

      const queue = await queues.counts();
      const sentTotal = Object.values(data.sentCounts).reduce((s, x) => s + x, 0);
      return {
        range: req.query.range,
        from,
        to,
        timezone: tz,
        bucket,
        days,
        kpis: [
          {
            key: 'articles',
            label: 'Материалов за период',
            value: data.k.cur,
            delta: pct(data.k.cur, data.k.prev),
            goodWhenUp: true,
            spark: data.sparkAll,
          },
          {
            key: 'sources',
            label: 'Активных источников',
            value: data.src.active,
            hint: `из ${data.src.total} подключённых`,
            delta: null,
            goodWhenUp: true,
            spark: null,
          },
          {
            key: 'negative',
            label: 'Негативных упоминаний',
            value: data.k.neg_cur,
            delta: pct(data.k.neg_cur, data.k.neg_prev),
            goodWhenUp: false,
            spark: data.sparkNeg,
          },
          {
            key: 'alerts',
            label: 'Сработавших алертов',
            value: data.alerts,
            hint: 'за всё время, по активным правилам',
            delta: null,
            goodWhenUp: false,
            spark: null,
          },
        ],
        sentiment: {
          total: sentTotal,
          items: SENTIMENT_KEYS.map((key) => ({
            key,
            label: SENTIMENTS[key].label,
            short: SENTIMENTS[key].short,
            color: SENTIMENTS[key].hex,
            count: data.sentCounts[key],
            share: sentTotal ? Math.round((data.sentCounts[key] / sentTotal) * 1000) / 10 : 0,
          })),
        },
        volume: { by: data.volumeBy, labels: data.labels, series: data.series },
        topSources: data.topSources,
        geo: { places: data.places, total: data.places.reduce((s, p) => s + (p.count as number), 0) },
        persons: { top: data.persons, total: data.personsTotal },
        health: {
          parsers: camelAll(data.health),
          sources: {
            active: data.src.active,
            errors: data.health.reduce((s, h) => s + (h.errors as number), 0),
            paused: data.health.reduce((s, h) => s + (h.paused as number), 0),
          },
          queue,
        },
      };
    },
  );

  // ------------------------------------------------------------------------------------------------
  r.get(
    '/analytics/overview',
    { ...access.tenant('dashboard:read'), schema: { querystring: z.object({ range: rangeSchema }) } },
    async (req) => {
      const a = requireAuth(req);
      const { from, to, prevFrom } = rangeBounds(req.query.range === '24h' ? '7d' : req.query.range); // аналитика — минимум неделя
      const tz = tenantTz(a);

      return db.tenant(
        tctx(req),
        async (q) => {
          const kpiRows = await periodQuery<{
            articles: number;
            avg_score: number | null;
            critical: number;
            sources: number;
            last24h: number;
          }>(
            q,
            a,
            from,
            to,
            "count(*)::int AS articles, avg(a.sentiment_score)::float AS avg_score, count(*) FILTER (WHERE a.sentiment_label = 'VN')::int AS critical, count(DISTINCT a.source_id)::int AS sources, count(*) FILTER (WHERE a.published_at >= {1})::int AS last24h",
            '',
            [new Date(to.getTime() - 864e5)],
          );
          const pw = buildArticleWhere({ from, to }, a);
          const uniquePersons = (
            await q.query<{ n: number }>(
              `SELECT count(DISTINCT e.id)::int AS n ${ARTICLE_FROM} JOIN article_entities ae ON ae.article_id = a.id JOIN entities e ON e.id = ae.entity_id AND e.type = 'person' WHERE ${pw.sql}`,
              pw.params,
            )
          ).rows[0]!.n;

          // публикации по суткам (часовой пояс тенанта) и всплески. До начала сбора лента источника отдаёт лишь последние записи,
          // поэтому сутки до первого сбора неполные: они не служат эталоном и в «среднем в сутки» не участвуют.
          const dayLabels = (
            await q.query<{ d: string }>(
              `SELECT to_char(b, 'YYYY-MM-DD') AS d FROM generate_series(date_trunc('day', $1::timestamptz AT TIME ZONE $3), date_trunc('day', $2::timestamptz AT TIME ZONE $3), '1 day'::interval) AS b ORDER BY b`,
              [from, to, tz],
            )
          ).rows.map((x) => x.d);
          const dayRows = await periodQuery<{ d: string; n: number }>(
            q,
            a,
            from,
            to,
            "to_char(date_trunc('day', a.published_at AT TIME ZONE {1}), 'YYYY-MM-DD') AS d, count(*)::int AS n",
            'GROUP BY 1',
            [tz],
          );
          const dayCount = new Map(dayRows.map((x) => [x.d, x.n]));
          const dayCounts = dayLabels.map((d) => dayCount.get(d) ?? 0);
          const cw = buildArticleWhere({}, a);
          const firstFetch = (
            await q.query<{ d: string | null }>(
              `SELECT to_char(min(a.fetched_at) AT TIME ZONE $${cw.params.length + 1}, 'YYYY-MM-DD') AS d ${ARTICLE_FROM} WHERE ${cw.sql}`,
              [...cw.params, tz],
            )
          ).rows[0]!.d;
          // сутки сбора с полными данными начинаются со следующего дня после первого сбора
          const reliableFrom = firstFetch ? dayLabels.findIndex((d) => d > firstFetch) : -1;
          const todayIdx = dayLabels.length - 1;
          const spikes = detectSpikes(
            dayCounts,
            reliableFrom < 0 ? dayCounts.length : reliableFrom,
            todayIdx,
          );
          const fullDays = reliableFrom < 0 ? [] : dayCounts.slice(reliableFrom, todayIdx);
          const perDay = fullDays.length
            ? Math.round(fullDays.reduce((s, x) => s + x, 0) / fullDays.length)
            : null;
          const dailyVolume = dayLabels.map((date, i) => ({
            date,
            count: dayCounts[i]!,
            complete: reliableFrom >= 0 && i >= reliableFrom && i < todayIdx,
            spike: spikes.some((sp) => sp.index === i),
          }));

          // индекс тональности по дням (+ скользящее среднее за 3 дня)
          const daily = await periodQuery<{ d: string; score: number; n: number }>(
            q,
            a,
            from,
            to,
            "to_char(date_trunc('day', a.published_at AT TIME ZONE {1}), 'YYYY-MM-DD') AS d, avg(a.sentiment_score)::float AS score, count(*)::int AS n",
            'AND a.sentiment_score IS NOT NULL GROUP BY 1 ORDER BY 1',
            [tz],
          );
          const round = (x: number) => Math.round(x * 1000) / 1000;
          const sentimentIndex = daily.map((row, i) => {
            const win = daily.slice(Math.max(0, i - 2), i + 1);
            return {
              date: row.d,
              score: round(row.score),
              average: round(win.reduce((s, x) => s + x.score, 0) / win.length),
            };
          });

          // сравнение источников
          const sources = await periodQuery<{
            id: string;
            name: string;
            domain: string;
            count: number;
            negative_share: number | null;
            trust: number;
          }>(
            q,
            a,
            from,
            to,
            "s.id, s.name, s.domain, count(*)::int AS count, round(100.0 * count(*) FILTER (WHERE a.sentiment_label IN ('NG','VN')) / nullif(count(*) FILTER (WHERE a.sentiment_label IS NOT NULL), 0), 1)::float AS negative_share, s.trust_score AS trust",
            'GROUP BY s.id, s.name, s.domain, s.trust_score ORDER BY count DESC LIMIT 9',
          );

          // тепловая карта «тема × источник»
          const topCols = sources.slice(0, 9);
          const heat = await periodQuery<{ topic: string; source_id: string; n: number }>(
            q,
            a,
            from,
            to,
            't.key AS topic, s.id AS source_id, count(*)::int AS n',
            'AND t.key IS NOT NULL AND s.id = ANY({1}::uuid[]) GROUP BY 1, 2',
            [topCols.map((c) => c.id)],
          );
          const topics = (
            await q.query<{ key: string; name: string; color: string }>(
              'SELECT key, name, color FROM topics ORDER BY sort, name',
            )
          ).rows;

          // активность по часам суток (часовой пояс тенанта)
          const hourRows = await periodQuery<{ h: number; n: number }>(
            q,
            a,
            from,
            to,
            'extract(hour FROM a.published_at AT TIME ZONE {1})::int AS h, count(*)::int AS n',
            'GROUP BY 1',
            [tz],
          );
          const hours = Array.from({ length: 24 }, (_, h) => hourRows.find((x) => x.h === h)?.n ?? 0);

          // облако тем: частотный анализ заголовков (группировка словоформ по основе из 5 букв)
          const titles = await periodQuery<{ title: string }>(
            q,
            a,
            from,
            to,
            'a.title',
            'ORDER BY a.published_at DESC LIMIT 4000',
          );
          const words = topWords(titles.map((t) => t.title));

          // автоматические наблюдения (правила, не LLM): числа считает код
          const topicNow = await periodQuery<{ key: string; name: string; n: number; neg: number }>(
            q,
            a,
            from,
            to,
            "t.key, t.name, count(*)::int AS n, count(*) FILTER (WHERE a.sentiment_label IN ('NG','VN'))::int AS neg",
            'AND t.key IS NOT NULL GROUP BY t.key, t.name',
          );
          const topicPrev = await periodQuery<{ key: string; n: number }>(
            q,
            a,
            prevFrom,
            from,
            't.key, count(*)::int AS n',
            'AND t.key IS NOT NULL GROUP BY t.key',
          );
          const sentNow = await periodQuery<{ label: string; n: number }>(
            q,
            a,
            from,
            to,
            'a.sentiment_label AS label, count(*)::int AS n',
            'AND a.sentiment_label IS NOT NULL GROUP BY 1',
          );
          const sentPrev = await periodQuery<{ label: string; n: number }>(
            q,
            a,
            prevFrom,
            from,
            'a.sentiment_label AS label, count(*)::int AS n',
            'AND a.sentiment_label IS NOT NULL GROUP BY 1',
          );
          const insights: Array<{ kind: string; color: string; title: string; text: string }> = [];
          const growth = topicNow
            .map((t) => ({ t, prev: topicPrev.find((p) => p.key === t.key)?.n ?? 0 }))
            .filter((x) => x.t.n >= 10 && x.prev >= 5)
            .map((x) => ({ ...x, g: (x.t.n - x.prev) / x.prev }))
            .sort((x, y) => y.g - x.g)[0];
          if (growth && growth.g > 0.1)
            insights.push({
              kind: 'тренд',
              color: '#059669',
              title: `Рост освещения темы «${growth.t.name}»`,
              text: `Материалов выросло на ${Math.round(growth.g * 100)}% к предыдущему периоду (${growth.prev} → ${growth.t.n}).`,
            });
          const neg = topicNow
            .filter((t) => t.n >= 10)
            .map((t) => ({ t, share: t.neg / t.n }))
            .sort((x, y) => y.share - x.share)[0];
          if (neg && neg.share >= 0.2)
            insights.push({
              kind: 'риск',
              color: '#e11d48',
              title: `Негативный фон по теме «${neg.t.name}»`,
              text: `Доля негатива — ${Math.round(neg.share * 100)}% (${neg.t.neg} из ${neg.t.n} материалов). Рассмотрите алерт по этой теме.`,
            });
          const lastSpike = spikes[spikes.length - 1];
          if (lastSpike)
            insights.push({
              kind: 'всплеск',
              color: '#e11d48',
              title: `Всплеск публикаций: ${new Date(`${dayLabels[lastSpike.index]}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`,
              text: `Вышло ${lastSpike.count} материалов при обычных около ${lastSpike.baseline} в сутки. Откройте ленту за этот день, чтобы увидеть, что стало поводом.`,
            });
          const lead = sources[0];
          if (lead)
            insights.push({
              kind: 'источник',
              color: '#f59e0b',
              title: `Лидер по объёму: ${lead.name}`,
              text: `${lead.count} материалов за период; доверие к источнику — ${lead.trust}%${lead.trust < 65 ? ' (ниже среднего: проверяйте факты)' : ''}.`,
            });
          const share = (rows: Array<{ label: string; n: number }>) => {
            const t = rows.reduce((s, x) => s + x.n, 0);
            return t ? (rows.find((x) => x.label === 'N')?.n ?? 0) / t : null;
          };
          const [nNow, nPrev] = [share(sentNow), share(sentPrev)];
          if (nNow !== null && nPrev !== null && Math.abs(nNow - nPrev) >= 0.03)
            insights.push({
              kind: 'сигнал',
              color: '#3363ff',
              title:
                nNow < nPrev ? 'Снижение доли нейтральных материалов' : 'Рост доли нейтральных материалов',
              text: `Доля нейтральной тональности изменилась с ${Math.round(nPrev * 100)}% до ${Math.round(nNow * 100)}% — контент становится ${nNow < nPrev ? 'более оценочным' : 'более нейтральным'}.`,
            });

          const kp = kpiRows[0]!;
          return {
            from,
            to,
            timezone: tz,
            kpis: {
              articles: kp.articles,
              avgSentiment: kp.avg_score === null ? null : round(kp.avg_score),
              uniquePersons,
              critical: kp.critical,
              sources: kp.sources,
              last24h: kp.last24h,
              perDay,
            },
            dailyVolume,
            sentimentIndex,
            sourceComparison: camelAll(
              sources.map((x) => ({
                ...x,
                share: kp.articles ? Math.round((x.count / kp.articles) * 1000) / 10 : 0,
              })),
            ),
            heatmap: {
              rows: topics,
              cols: topCols.map((c) => ({ id: c.id, domain: c.domain, name: c.name })),
              cells: heat.map((h) => ({ topic: h.topic, sourceId: h.source_id, count: h.n })),
            },
            hours,
            words,
            insights,
          };
        },
        { readOnly: true },
      );
    },
  );
}
