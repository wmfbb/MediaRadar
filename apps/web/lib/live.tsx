'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface LiveArticle {
  id: string;
  title: string;
  publishedAt: string;
  topic: string;
  geo: string | null;
  source: { id: string; name: string; domain: string; kind: string };
  sentiment: { label: 'VP' | 'P' | 'N' | 'NG' | 'VN'; score: number };
}
type Status = 'connecting' | 'live' | 'offline';
interface LiveValue {
  status: Status;
  subscribe: (fn: (a: LiveArticle) => void) => () => void;
}
const Ctx = createContext<LiveValue>({ status: 'offline', subscribe: () => () => {} });
export const useLive = () => useContext(Ctx);

const wsUrl = () => {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`;
};

/** Одно WebSocket-соединение на приложение: переподключение с нарастающей паузой, подписчики получают материалы тенанта. */
export function LiveProvider({ children, tenantId }: { children: ReactNode; tenantId: string }) {
  const [status, setStatus] = useState<Status>('connecting');
  const handlers = useRef(new Set<(a: LiveArticle) => void>());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    const connect = () => {
      setStatus(attempt === 0 ? 'connecting' : 'offline');
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as { type: string; data?: LiveArticle };
        if (msg.type === 'hello') setStatus('live');
        if (msg.type === 'article' && msg.data) handlers.current.forEach((h) => h(msg.data!));
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus('offline');
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [tenantId]);

  const value = useRef<LiveValue>({
    status,
    subscribe: (fn) => (handlers.current.add(fn), () => void handlers.current.delete(fn)),
  });
  value.current = { ...value.current, status };
  return <Ctx.Provider value={{ status, subscribe: value.current.subscribe }}>{children}</Ctx.Provider>;
}
