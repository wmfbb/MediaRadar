'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Avatar, Badge, Button, Icon, Modal, Progress, cn, useToast, type IconName } from '@mediaradar/ui';
import { SENTIMENTS } from '@mediaradar/core/domain';
import { api, errorMessage } from '@/lib/api';
import { num, timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useMe } from '@/lib/me';
import { setTheme, useThemeMode, type ThemeMode } from '@/lib/theme';
import type { ArticlePage } from '@/lib/types';

interface NavItem { href: string; label: string; icon: IconName; perm: string }
const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: 'Аналитика', items: [
    { href: '/', label: 'Дашборд', icon: 'dashboard', perm: 'dashboard:read' },
    { href: '/feed', label: 'Лента', icon: 'feed', perm: 'feed:read' },
    { href: '/analytics', label: 'Отчёты и графики', icon: 'chart', perm: 'dashboard:read' },
  ] },
  { group: 'Сбор данных', items: [
    { href: '/sources', label: 'Источники', icon: 'source', perm: 'source:read' },
    { href: '/alerts', label: 'Алерты', icon: 'bell', perm: 'alert:manage_own' },
  ] },
  { group: 'Управление', items: [
    { href: '/reports', label: 'Конструктор отчётов', icon: 'report', perm: 'report:read' },
    { href: '/users', label: 'Пользователи и роли', icon: 'users', perm: 'user:read' },
    { href: '/settings', label: 'Настройки', icon: 'settings', perm: 'tenant:settings_basic' },
    { href: '/billing', label: 'Тарифы и оплата', icon: 'card', perm: 'tenant:read' },
  ] },
  { group: 'Платформа', items: [
    { href: '/admin/tenants', label: 'Тенанты', icon: 'building', perm: 'platform:tenants' },
    { href: '/admin/settings', label: 'Настройки платформы', icon: 'settings', perm: 'platform:settings' },
    { href: '/admin/flags', label: 'Флаги функций', icon: 'flag', perm: 'platform:flags' },
    { href: '/admin/audit', label: 'Журнал аудита', icon: 'list', perm: 'platform:audit' },
  ] },
];

function useNav() {
  const { can, me } = useMe();
  return useMemo(
    () => NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(i.perm) && (me.tenant || i.perm.startsWith('platform:'))) })).filter((g) => g.items.length),
    [can, me.tenant],
  );
}

function PlanWidget() {
  const { me, can } = useMe();
  const { data } = useSWR<{ plan: { name: string }; status: string; meters: Array<{ key: string; limit: number | null; used: number }> }>(me.tenant && can('tenant:read') ? '/v1/billing/subscription' : null);
  if (!data) return null;
  const meter = (k: string) => data.meters.find((m) => m.key === k);
  const rows: Array<[string, string]> = [['sources.active', 'Источники'], ['ai.tokens_per_month', 'AI-токены']];
  return (
    <div className="rounded-xl bg-white/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-white">Тариф {data.plan.name}</span>
        <Badge tone={data.status === 'active' ? 'ok' : 'warn'}>{data.status === 'active' ? 'активен' : data.status}</Badge>
      </div>
      <div className="space-y-2">
        {rows.map(([k, label]) => {
          const m = meter(k);
          if (!m) return null;
          return (
            <div key={k}>
              <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                <span>{label}</span>
                <span className="font-mono">{num(m.used)}/{m.limit === null ? '∞' : num(m.limit)}</span>
              </div>
              <Progress value={m.used} max={m.limit} />
            </div>
          );
        })}
      </div>
      <Link href="/billing" className="mt-3 block rounded-lg bg-accent py-1.5 text-center text-[12px] font-semibold text-on-accent transition hover:bg-accent-strong">
        Управление подпиской
      </Link>
    </div>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const path = usePathname();
  const { me, switchTenant } = useMe();
  const nav = useNav();
  const [switcher, setSwitcher] = useState(false);
  const toast = useToast();
  const isActive = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  const product = me.tenant?.branding.productName ?? 'МедиаРадар';

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={onClose} aria-hidden />}
      <aside className={cn('fixed inset-y-0 z-40 flex w-[248px] flex-col overflow-y-auto bg-nav text-slate-400 transition-transform lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')} aria-label="Боковая панель">
        <div className="flex items-center gap-3 border-b border-white/5 px-5 py-5">
          <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-[15px] font-extrabold text-white shadow-lg">{product[0]}</div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold leading-tight tracking-tight text-white">{product}</div>
            <div className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-500">МедиаРадар</div>
          </div>
        </div>

        {me.tenant && (
          <div className="px-3 pb-2 pt-4">
            <button type="button" onClick={() => setSwitcher(true)} className="flex w-full items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-left transition hover:bg-white/10" aria-label="Сменить рабочий тенант">
              <Icon name="pin" className="text-brand-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-white">{me.tenant.name}</span>
                <span className="block truncate text-[11px] text-slate-500">{me.tenant.regionProfile.core ? `Ядро: ${me.tenant.regionProfile.core}` : me.role?.name}</span>
              </span>
              <Icon name="updown" size={14} className="text-slate-500" />
            </button>
          </div>
        )}

        <nav className="space-y-0.5 px-3 py-2 text-[13px] font-medium" aria-label="Главная навигация">
          {nav.map((g) => (
            <div key={g.group}>
              <div className="px-3 pb-1.5 pt-3 text-[11px] font-bold uppercase tracking-[.14em] text-slate-500">{g.group}</div>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} onClick={onClose} aria-current={isActive(i.href) ? 'page' : undefined}
                  className={cn('flex items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-white/5 hover:text-white', isActive(i.href) ? 'bg-white/10 text-white' : 'text-slate-400')}>
                  <span className={cn('grid size-7 flex-none place-items-center rounded-lg', isActive(i.href) ? 'bg-accent text-on-accent' : 'bg-white/5')}>
                    <Icon name={i.icon} />
                  </span>
                  <span className="truncate">{i.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-white/5 p-4">
          <PlanWidget />
        </div>
      </aside>

      <Modal open={switcher} onClose={() => setSwitcher(false)} title="Рабочий тенант" size="sm">
        <div className="space-y-2">
          {me.tenants.map((t) => (
            <button key={t.id} type="button" disabled={t.id === me.tenant?.id}
              onClick={() => switchTenant(t.id).catch((e) => toast(errorMessage(e), 'err'))}
              className={cn('flex w-full items-center gap-3 rounded-xl border p-3 text-left transition', t.id === me.tenant?.id ? 'border-accent bg-accent-soft' : 'border-line-strong hover:bg-surface-2')}>
              <span className="grid size-8 flex-none place-items-center rounded-lg bg-accent text-[11px] font-bold text-on-accent">{t.name.slice(0, 2).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-bold">{t.name}</span>
                <span className="block text-[12px] text-muted">{t.roleName}</span>
              </span>
              {t.id === me.tenant?.id && <Badge tone="accent">активен</Badge>}
            </button>
          ))}
          {!me.tenants.length && <p className="text-[13px] text-muted">У вас нет доступных тенантов.</p>}
        </div>
      </Modal>
    </>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOut();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onOut();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [ref, onOut, active]);
}

function UserMenu() {
  const { me, logout } = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mode = useThemeMode();
  const router = useRouter();
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, close, open);
  const [current, setCurrent] = useState<ThemeMode>(mode);
  useEffect(() => setCurrent(mode), [mode]);
  const themes: Array<[ThemeMode, string, IconName]> = [['light', 'Светлая', 'sun'], ['dark', 'Тёмная', 'moon'], ['system', 'Авто', 'settings']];
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className="flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 transition hover:bg-surface-2">
        <Avatar name={me.user.name} />
        <span className="hidden text-left md:block">
          <span className="block text-[12px] font-semibold leading-tight">{me.user.name}</span>
          <span className="block text-[11px] text-muted">{me.role?.name ?? me.user.platformRole ?? '—'}{me.tenant ? ` · ${me.tenant.name}` : ''}</span>
        </span>
        <Icon name="chevronDown" size={14} className="text-faint" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="border-b border-line px-4 py-3">
            <div className="text-[13px] font-bold">{me.user.name}</div>
            <div className="truncate font-mono text-[11px] text-muted">{me.user.email}</div>
          </div>
          <div className="border-b border-line p-3">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">Тема</div>
            <div className="grid grid-cols-3 gap-1">
              {themes.map(([m, label, icon]) => (
                <button key={m} type="button" role="menuitemradio" aria-checked={current === m} onClick={() => { setCurrent(m); void setTheme(m); }}
                  className={cn('flex flex-col items-center gap-1 rounded-lg border py-2 text-[11px] font-semibold transition', current === m ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2')}>
                  <Icon name={icon} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" role="menuitem" onClick={() => { close(); router.push('/account'); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-surface-2"><Icon name="shield" /> Профиль и безопасность</button>
          <button type="button" role="menuitem" onClick={() => void logout()} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-bad hover:bg-surface-2"><Icon name="logout" /> Выйти</button>
        </div>
      )}
    </div>
  );
}

interface Notification { id: string; level: 'crit' | 'warn' | 'info'; title: string; body: string | null; createdAt: string; readAt: string | null }

function Notifications() {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data } = useSWR<{ items: Notification[]; unread: number }>(can('notification:read') ? '/v1/notifications' : null, { refreshInterval: 60_000 });
  const readAll = async () => {
    try {
      await api('/v1/notifications/read-all', { method: 'POST' });
      await mutate('/v1/notifications');
    } catch (e) {
      toast(errorMessage(e), 'err');
    }
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Уведомления${data?.unread ? `: ${data.unread} непрочитанных` : ''}`} className="relative grid size-9 place-items-center rounded-lg text-muted transition hover:bg-surface-2">
        <Icon name="bell" size={18} />
        {!!data?.unread && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-bold text-white">{Math.min(99, data.unread)}</span>}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Уведомления" size="sm"
        footer={<><Button onClick={() => setOpen(false)}>Закрыть</Button><Button variant="primary" onClick={readAll} disabled={!data?.unread}>Прочитать все</Button></>}>
        <div className="space-y-2">
          {data?.items.map((n) => (
            <div key={n.id} className={cn('flex gap-3 rounded-xl border border-line p-3', !n.readAt && 'bg-accent-soft/50')}>
              <span className={cn('mt-1.5 size-2 flex-none rounded-full', n.level === 'crit' ? 'bg-bad' : n.level === 'warn' ? 'bg-warn' : 'bg-accent')} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold leading-snug">{n.title}</div>
                {n.body && <div className="mt-0.5 text-[12px] text-muted">{n.body}</div>}
              </div>
              <span className="flex-none font-mono text-[11px] text-faint">{timeAgo(n.createdAt)}</span>
            </div>
          ))}
          {data && !data.items.length && <p className="py-6 text-center text-[13px] text-muted">Уведомлений нет</p>}
        </div>
      </Modal>
    </>
  );
}

function LiveBadge() {
  const { status } = useLive();
  const m = { live: ['ok', 'Live', 'подключено'], connecting: ['warn', 'Live', 'подключение…'], offline: ['bad', 'Offline', 'нет связи'] } as const;
  const [tone, label, hint] = m[status];
  return (
    <div className={cn('hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 lg:flex', tone === 'ok' ? 'border-ok/30 bg-ok-soft text-ok' : tone === 'warn' ? 'border-warn/30 bg-warn-soft text-warn' : 'border-bad/30 bg-bad-soft text-bad')} role="status" aria-label={`Поток в реальном времени: ${hint}`}>
      <span className={cn('size-1.5 rounded-full bg-current', status !== 'offline' && 'mr-pulse')} />
      <span className="text-[12px] font-semibold">{label}</span>
      <span className="font-mono text-[11px] opacity-70">{hint}</span>
    </div>
  );
}

interface Command { id: string; label: string; hint?: string; icon: IconName; run: () => void }

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const nav = useNav();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [articles, setArticles] = useState<ArticlePage['items']>([]);
  const { can } = useMe();

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    setArticles([]);
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2 || !can('feed:read')) return setArticles([]);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<ArticlePage>(`/v1/articles?limit=5&q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal }).then((r) => setArticles(r.items)).catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open, can]);

  const go = useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);
  const commands: Command[] = useMemo(() => {
    const items: Command[] = nav.flatMap((g) => g.items).map((i) => ({ id: i.href, label: i.label, hint: 'Перейти', icon: i.icon, run: () => go(i.href) }));
    const t = q.trim();
    const filtered = t ? items.filter((c) => c.label.toLowerCase().includes(t.toLowerCase())) : items;
    const search: Command[] = t && can('feed:read') ? [{ id: 'search', label: `Искать «${t}» в ленте`, hint: 'Поиск', icon: 'search', run: () => go(`/feed?q=${encodeURIComponent(t)}`) }] : [];
    // Если запрос совпал с названием раздела — Enter ведёт в раздел; иначе первым идёт поиск по ленте.
    return filtered.length ? [...filtered, ...search] : search;
  }, [nav, q, go, can]);
  const total = commands.length + articles.length;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % Math.max(total, 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + total) % Math.max(total, 1)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (idx < commands.length) commands[idx]?.run();
      else if (articles[idx - commands.length]) go(`/feed?q=${encodeURIComponent(articles[idx - commands.length]!.title)}`);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Быстрый поиск и переходы" size="sm">
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey} placeholder="Куда перейти или что найти…" aria-label="Команда или поисковый запрос"
        className="mb-3 w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-[14px] outline-none focus:border-accent" />
      <ul className="max-h-80 space-y-0.5 overflow-y-auto" role="listbox">
        {commands.map((c, i) => (
          <li key={c.id} role="option" aria-selected={idx === i}>
            <button type="button" onClick={c.run} onMouseEnter={() => setIdx(i)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px]', idx === i ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2')}>
              <Icon name={c.icon} /> <span className="flex-1 font-medium">{c.label}</span> <span className="text-[11px] text-faint">{c.hint}</span>
            </button>
          </li>
        ))}
        {articles.length > 0 && <li className="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-muted">Материалы</li>}
        {articles.map((a, j) => {
          const i = commands.length + j;
          return (
            <li key={a.id} role="option" aria-selected={idx === i}>
              <button type="button" onClick={() => go(`/feed?q=${encodeURIComponent(a.title)}`)} onMouseEnter={() => setIdx(i)} className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-[13px]', idx === i ? 'bg-accent-soft' : 'hover:bg-surface-2')}>
                <span className="mt-1.5 size-2 flex-none rounded-full" style={{ background: a.sentiment ? SENTIMENTS[a.sentiment.label].hex : '#94a3b8' }} />
                <span className="min-w-0"><span className="line-clamp-2 font-medium">{a.title}</span><span className="text-[11px] text-muted">{a.source.name} · {timeAgo(a.publishedAt)}</span></span>
              </button>
            </li>
          );
        })}
        {!total && <li className="px-3 py-6 text-center text-[13px] text-muted">Ничего не найдено</li>}
      </ul>
    </Modal>
  );
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const router = useRouter();
  const { can } = useMe();
  const [palette, setPalette] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur lg:px-6">
      <button type="button" onClick={onMenu} aria-label="Открыть меню" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 lg:hidden"><Icon name="menu" size={20} /></button>
      {can('feed:read') ? (
        <form className="relative max-w-xl flex-1" onSubmit={(e) => { e.preventDefault(); router.push(`/feed?q=${encodeURIComponent(q)}`); }} role="search">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск по материалам" placeholder="Поиск по материалам, источникам, персонам…"
            className="w-full rounded-lg border border-transparent bg-surface-2 py-2 pl-9 pr-16 text-[13px] outline-none transition focus:border-accent focus:bg-surface" />
          <button type="button" onClick={() => setPalette(true)} aria-label="Быстрые команды (Ctrl+K)" className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] text-faint">Ctrl K</button>
        </form>
      ) : <div className="flex-1" />}
      <div className="ml-auto flex flex-none items-center gap-2">
        <LiveBadge />
        <Notifications />
        <div className="mx-1 h-7 w-px bg-line-strong" />
        <UserMenu />
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const demo = process.env.NEXT_PUBLIC_DEMO_BANNER === 'true';
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-on-accent">К содержимому</a>
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <div className="flex min-h-screen min-w-0 flex-col lg:ml-[248px]">
        <Topbar onMenu={() => setMenu(true)} />
        {demo && <div className="border-b border-warn/30 bg-warn-soft px-4 py-1.5 text-center text-[12px] font-medium text-warn">Демо-режим: источники и материалы синтетические, реальный сбор данных подключается в Фазе 1</div>}
        <main id="main" className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
