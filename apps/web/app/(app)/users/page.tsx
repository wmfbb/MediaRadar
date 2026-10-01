'use client';
import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Avatar, Badge, Button, Card, Field, Input, Modal, Select, Skeleton, Table, Td, Th, useToast } from '@mediaradar/ui';
import { ErrorBox, PageHeader } from '@/components/page';
import { api, errorMessage, fieldError } from '@/lib/api';
import { PERMISSION_LABELS } from '@/lib/permissions';
import { timeAgo } from '@/lib/format';
import { useMe } from '@/lib/me';

interface Member { id: string; userId: string; name: string; email: string; lastLoginAt: string | null; totpEnabled: boolean; status: 'active' | 'blocked'; scope: { topics?: string[] }; roleKey: string; roleName: string }
interface Role { key: string; name: string; description: string; permissions: string[] }
interface Invitation { id: string; email: string; expiresAt: string; roleKey: string; roleName: string }

function InviteModal({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const { me } = useMe();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('VIEWER');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/v1/tenant/invitations', { method: 'POST', body: { email, roleKey } });
      toast(`Приглашение отправлено на ${email}`, 'ok');
      setEmail('');
      await mutate('/v1/tenant/invitations');
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Пригласить пользователя" size="sm" footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!email}>Отправить приглашение</Button></>}>
      <div className="space-y-4">
        {!!err && !fieldError(err, 'email') && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{errorMessage(err)}</p>}
        <Field label="Email" error={fieldError(err, 'email')}>{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.ru" />}</Field>
        <Field label="Роль" hint={roles.find((r) => r.key === roleKey)?.description}>{(id) => <Select id={id} value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>{roles.filter((r) => r.key !== 'OWNER' || me.role?.key === 'OWNER').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select>}</Field>
        <p className="text-[12px] text-muted">Письмо со ссылкой действует 7 дней. Почтовый канал подключается в Фазе 5; до этого ссылка пишется в журнал сервера.</p>
      </div>
    </Modal>
  );
}

export default function Page() {
  const { me, can } = useMe();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const members = useSWR<{ items: Member[] }>('/v1/tenant/members');
  const roles = useSWR<{ items: Role[] }>('/v1/tenant/roles');
  const invites = useSWR<{ items: Invitation[] }>(can('user:read') ? '/v1/tenant/invitations' : null);
  const [invite, setInvite] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const manage = can('user:manage');

  const patch = async (m: Member, body: object, ok: string) => {
    try { await api(`/v1/tenant/members/${m.id}`, { method: 'PATCH', body }); toast(ok, 'ok'); await mutate('/v1/tenant/members'); } catch (e) { toast(errorMessage(e), 'err'); await mutate('/v1/tenant/members'); }
  };
  const remove = async (m: Member) => {
    if (!window.confirm(`Удалить ${m.name} из тенанта?`)) return;
    try { await api(`/v1/tenant/members/${m.id}`, { method: 'DELETE' }); toast('Участник удалён', 'ok'); await mutate('/v1/tenant/members'); } catch (e) { toast(errorMessage(e), 'err'); }
  };
  const revoke = async (i: Invitation) => {
    try { await api(`/v1/tenant/invitations/${i.id}`, { method: 'DELETE' }); toast('Приглашение отозвано', 'ok'); await mutate('/v1/tenant/invitations'); } catch (e) { toast(errorMessage(e), 'err'); }
  };

  return (
    <div className="mr-fade-up">
      <PageHeader eyebrow="Доступ" title="Пользователи и роли" actions={manage ? <Button variant="primary" onClick={() => setInvite(true)}>+ Пригласить</Button> : undefined} />
      {members.error && <ErrorBox message={errorMessage(members.error)} onRetry={() => void members.mutate()} />}
      <div className="mb-4 space-y-4">
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <thead><tr><Th>Пользователь</Th><Th>Роль</Th><Th>Область</Th><Th>Последний вход</Th><Th>Статус</Th>{manage && <Th align="right">Действия</Th>}</tr></thead>
              <tbody>
                {!members.data && <tr><td colSpan={6} className="p-4"><Skeleton className="h-24" /></td></tr>}
                {members.data?.items.map((m) => {
                  const self = m.userId === me.user.id;
                  const locked = self || (m.roleKey === 'OWNER' && me.role?.key !== 'OWNER');
                  return (
                    <tr key={m.id} className="border-t border-line">
                      <Td><div className="flex items-center gap-2.5"><Avatar name={m.name} /><div className="min-w-0"><div className="font-semibold">{m.name}{self && <span className="ml-1.5 text-[11px] font-normal text-muted">(вы)</span>}</div><div className="truncate font-mono text-[11px] text-faint">{m.email}</div></div></div></Td>
                      <Td>{manage && !locked ? <Select aria-label={`Роль: ${m.name}`} value={m.roleKey} onChange={(e) => void patch(m, { roleKey: e.target.value }, 'Роль изменена')} className="!w-40 !py-1 !text-[12px] font-semibold">{(roles.data?.items ?? []).filter((r) => r.key !== 'OWNER' || me.role?.key === 'OWNER').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select> : <Badge tone={m.roleKey === 'OWNER' ? 'accent' : 'neutral'}>{m.roleName}</Badge>}</Td>
                      <Td className="text-[12px] text-muted">{m.scope.topics?.length ? `Темы: ${m.scope.topics.join(', ')}` : 'Без ограничений'}</Td>
                      <Td className="text-[12px] text-muted">{m.lastLoginAt ? timeAgo(m.lastLoginAt) : '—'}{m.totpEnabled && <Badge tone="ok" className="ml-2" title="Двухфакторная защита включена">2FA</Badge>}</Td>
                      <Td><Badge tone={m.status === 'active' ? 'ok' : 'bad'}>{m.status === 'active' ? 'активен' : 'заблокирован'}</Badge></Td>
                      {manage && <Td className="whitespace-nowrap text-right">{!locked && <><Button size="sm" className="mr-1" onClick={() => void patch(m, { status: m.status === 'active' ? 'blocked' : 'active' }, m.status === 'active' ? 'Участник заблокирован' : 'Участник разблокирован')}>{m.status === 'active' ? 'Заблокировать' : 'Разблокировать'}</Button><Button size="sm" variant="ghost" onClick={() => void remove(m)}>Удалить</Button></>}</Td>}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="text-[15px] font-bold">Матрица ролей</h2><p className="mb-4 text-[12px] text-muted">Права проверяются на сервере; область доступа ограничивает темы</p>
          <ul className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {roles.data?.items.map((r) => (
              <li key={r.key} className="self-start rounded-xl border border-line p-3">
                <button type="button" className="flex w-full items-start justify-between gap-2 text-left" aria-expanded={expanded === r.key} onClick={() => setExpanded(expanded === r.key ? null : r.key)}>
                  <span><Badge className="mb-1">{r.key}</Badge><span className="block text-[12px] text-muted">{r.description}</span></span><span className="flex-none font-mono text-[11px] text-faint">{r.permissions.length} прав</span>
                </button>
                {expanded === r.key && <ul className="mt-2 space-y-1 border-t border-line pt-2">{r.permissions.map((p) => <li key={p} className="flex gap-1.5 text-[12px] text-muted"><span className="flex-none text-ok" aria-hidden>✓</span>{PERMISSION_LABELS[p] ?? p}</li>)}</ul>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {(invites.data?.items.length ?? 0) > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-line px-5 py-4 text-[15px] font-bold">Ожидают принятия</div>
          <Table><thead><tr><Th>Email</Th><Th>Роль</Th><Th>Действует до</Th>{manage && <Th align="right" />}</tr></thead>
            <tbody>{invites.data?.items.map((i) => <tr key={i.id} className="border-t border-line"><Td className="font-mono text-[12px]">{i.email}</Td><Td>{i.roleName}</Td><Td className="text-[12px] text-muted">{new Date(i.expiresAt).toLocaleDateString('ru-RU')}</Td>{manage && <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => void revoke(i)}>Отозвать</Button></Td>}</tr>)}</tbody></Table>
        </Card>
      )}
      <InviteModal open={invite} onClose={() => setInvite(false)} roles={roles.data?.items ?? []} />
    </div>
  );
}
