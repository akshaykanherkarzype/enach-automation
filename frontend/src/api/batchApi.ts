import { api } from './client';

export type BatchModuleSlug = 'invoice-generation' | 'invoice-charge';

export interface ValidationSummary {
  uploadToken: string;
  totalRecords: number;
  validRecords: number;
  duplicateCount: number;
  invalidCount: number;
  duplicates: string[];
  invalidRows: Array<{
    rowNumber: number;
    customerId?: string;
    amount?: string;
    reason: string;
  }>;
  originalFilename: string;
}

export interface BatchExecution {
  id: string;
  module: string;
  status: string;
  uploadedBy: string;
  uploadedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  totalRecords: number;
  successCount: number;
  failedCount: number;
  duplicateCount: number;
  processingCount: number;
  progress?: number;
  remaining?: number;
  recordsPerMin?: number;
  etaMs?: number | null;
  durationMs?: number;
  workersRunning?: number;
  originalFile?: string | null;
  processedFile?: string | null;
  failureReport?: string | null;
  remarks?: string | null;
}

export interface BatchItem {
  id: string;
  batchId: string;
  customerId: string;
  amount: string;
  status: string;
  retryCount: number;
  failureReason?: string | null;
  responseCode?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export async function login(email: string, password: string) {
  const { data } = await api.post('/auth/login', { email, password });
  return data as {
    accessToken: string;
    user: { email: string; name: string; roles: string[] };
  };
}

export async function uploadFile(module: BatchModuleSlug, file: File) {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post(`/batches/${module}/upload`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data as ValidationSummary;
}

export async function confirmUpload(module: BatchModuleSlug, uploadToken: string) {
  const { data } = await api.post(`/batches/${module}/confirm`, { uploadToken });
  return data as BatchExecution;
}

export async function listBatches(module: BatchModuleSlug, page = 1) {
  const { data } = await api.get('/batches', {
    params: { module, page, pageSize: 20 },
  });
  return data as {
    items: BatchExecution[];
    total: number;
    page: number;
    pageSize: number;
    openBatch?: { id: string; status: string } | null;
  };
}

export async function getBatch(id: string) {
  const { data } = await api.get(`/batches/${id}`);
  return data as BatchExecution;
}

export async function getBatchItems(
  id: string,
  params?: { status?: string; page?: number; pageSize?: number },
) {
  const { data } = await api.get(`/batches/${id}/items`, { params });
  return data as { items: BatchItem[]; total: number; page: number; pageSize: number };
}

export async function getBatchLogs(id: string, page = 1) {
  const { data } = await api.get(`/batches/${id}/logs`, { params: { page, pageSize: 50 } });
  return data as { logs: unknown[]; total: number };
}

export async function retryFailed(id: string) {
  const { data } = await api.post(`/batches/${id}/retry-failed`);
  return data as BatchExecution;
}

export async function retryDlq(id: string) {
  const { data } = await api.post(`/batches/${id}/retry-dlq`);
  return data as BatchExecution;
}

export async function cancelBatch(id: string) {
  const { data } = await api.post(`/batches/${id}/cancel`);
  return data as BatchExecution;
}

export async function downloadReport(id: string, type: 'original' | 'processed' | 'failed' | 'success') {
  const { data } = await api.get(`/batches/${id}/download/${type}`);
  return data as { url: string; key: string };
}
