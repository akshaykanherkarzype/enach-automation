import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { BatchExecution, BatchModuleSlug } from '../api/batchApi';
import { useAuth } from '../auth/AuthContext';
import { isBatchLive } from '../lib/batch';

export type SocketStatus = 'connecting' | 'open' | 'closed';

const listeners = new Set<() => void>();
let socketStatus: SocketStatus = 'closed';

function setSocketStatus(next: SocketStatus) {
  if (socketStatus === next) return;
  socketStatus = next;
  listeners.forEach((listener) => listener());
}

export function getSocketStatus(): SocketStatus {
  return socketStatus;
}

export function subscribeSocketStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSocketStatus(): SocketStatus {
  return useSyncExternalStore(subscribeSocketStatus, getSocketStatus, getSocketStatus);
}

export function moduleSlug(module: string): BatchModuleSlug | null {
  if (module === 'INVOICE_GENERATION' || module === 'invoice-generation') return 'invoice-generation';
  if (module === 'INVOICE_CHARGE' || module === 'invoice-charge') return 'invoice-charge';
  return null;
}

function socketUrl(): string {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1';
  const url = new URL(base, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  url.search = '';
  return url.toString();
}

const detailTimers = new Map<string, number>();

export function applyBatchSnapshot(queryClient: QueryClient, batch: BatchExecution): void {
  const id = String(batch.id);
  queryClient.setQueryData(['batch', id], (current: BatchExecution | undefined) => ({
    ...(current ?? {}),
    ...batch,
    id,
  }));

  const slug = moduleSlug(String(batch.module));
  if (!slug) return;

  let seen = false;
  const lists = queryClient.getQueriesData<{
    items: BatchExecution[];
    openBatch?: { id: string; status: string } | null;
  }>({ queryKey: ['batches', slug] });
  for (const [key, data] of lists) {
    if (!data?.items) continue;
    const onPage = data.items.some((item) => String(item.id) === id);
    const isOpen = data.openBatch && String(data.openBatch.id) === id;
    if (!onPage && !isOpen) continue;
    seen = true;
    const stillOpen = isBatchLive(batch.status);
    queryClient.setQueryData(key, {
      ...data,
      openBatch: isOpen ? (stillOpen ? { id, status: batch.status } : null) : data.openBatch,
      items: data.items.map((item) => (String(item.id) === id ? { ...item, ...batch, id } : item)),
    });
  }
  if (!seen) {
    void queryClient.invalidateQueries({ queryKey: ['batches', slug] });
  }

  const terminal = !isBatchLive(batch.status);
  const existing = detailTimers.get(id);
  if (terminal) {
    if (existing) window.clearTimeout(existing);
    detailTimers.delete(id);
    void queryClient.invalidateQueries({ queryKey: ['batch-items', id] });
    void queryClient.invalidateQueries({ queryKey: ['batch-logs', id] });
    return;
  }
  if (existing) return;
  detailTimers.set(
    id,
    window.setTimeout(() => {
      detailTimers.delete(id);
      void queryClient.invalidateQueries({ queryKey: ['batch-items', id] });
      void queryClient.invalidateQueries({ queryKey: ['batch-logs', id] });
    }, 700),
  );
}

export function BatchRealtime() {
  const { token } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) {
      setSocketStatus('closed');
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let retryMs = 1_000;
    let retryTimer = 0;

    const connect = () => {
      if (stopped) return;
      setSocketStatus('connecting');
      const ws = new WebSocket(socketUrl());
      socket = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        let message: { type?: string; batch?: BatchExecution };
        try {
          message = JSON.parse(String(event.data)) as { type?: string; batch?: BatchExecution };
        } catch {
          return;
        }
        if (message.type === 'ready') {
          retryMs = 1_000;
          setSocketStatus('open');
          void queryClient.invalidateQueries({ queryKey: ['batches'] });
          void queryClient.invalidateQueries({ queryKey: ['batch'] });
          return;
        }
        if (message.type === 'batch.updated' && message.batch) {
          applyBatchSnapshot(queryClient, message.batch);
        }
      };

      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (stopped) return;
        setSocketStatus('closed');
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
    };

    connect();

    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      socket?.close();
      setSocketStatus('closed');
    };
  }, [token, queryClient]);

  return null;
}
