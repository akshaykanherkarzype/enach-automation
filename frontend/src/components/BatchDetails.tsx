import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import {
  cancelBatch,
  downloadReport,
  getBatch,
  getBatchItems,
  getBatchLogs,
  retryDlq,
  retryFailed,
  type BatchItem,
} from '../api/batchApi';
import { useAuth } from '../auth/AuthContext';
import {
  apiMessage,
  completionPercent,
  formatCount,
  formatDuration,
  formatIst,
  isBatchLive,
  SOCKET_FALLBACK_MS,
} from '../lib/batch';
import { useSocketStatus } from '../realtime/batchSocket';
import { StatusChip } from './StatusChip';

interface Props {
  batchId: string;
  moduleKey: string;
}

const ITEM_PAGE_SIZE = 50;

export function BatchDetails({ batchId, moduleKey }: Props) {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState(0);
  const [itemPage, setItemPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [downloadAnchor, setDownloadAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTab(0);
    setItemPage(1);
    setError(null);
  }, [batchId]);

  const connected = useSocketStatus() === 'open';
  const batchQuery = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => getBatch(batchId),
    placeholderData: keepPreviousData,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      connected || !isBatchLive(query.state.data?.status) ? false : SOCKET_FALLBACK_MS,
  });

  const live = isBatchLive(batchQuery.data?.status);
  const itemStatus = tab === 1 ? 'FAILED' : undefined;
  const detailFallback = connected || !live ? false : SOCKET_FALLBACK_MS;

  const itemsQuery = useQuery({
    queryKey: ['batch-items', batchId, itemStatus ?? 'ALL', itemPage],
    queryFn: () =>
      getBatchItems(batchId, {
        status: itemStatus,
        page: itemPage,
        pageSize: ITEM_PAGE_SIZE,
      }),
    enabled: tab === 0 || tab === 1,
    placeholderData: keepPreviousData,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: tab === 0 || tab === 1 ? detailFallback : false,
  });

  const logsQuery = useQuery({
    queryKey: ['batch-logs', batchId],
    queryFn: () => getBatchLogs(batchId),
    enabled: tab === 2,
    placeholderData: keepPreviousData,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: tab === 2 ? detailFallback : false,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['batch', batchId] });
    await queryClient.invalidateQueries({ queryKey: ['batches', moduleKey] });
    await queryClient.invalidateQueries({ queryKey: ['batch-items', batchId] });
    await queryClient.invalidateQueries({ queryKey: ['batch-logs', batchId] });
  };

  const retryMut = useMutation({
    mutationFn: () => retryFailed(batchId),
    onSuccess: async () => {
      setNotice('Failed customers were queued again.');
      await invalidate();
    },
    onError: (err: unknown) => setError(apiMessage(err, 'Retry could not be started.')),
  });

  const dlqMut = useMutation({
    mutationFn: () => retryDlq(batchId),
    onSuccess: async () => {
      setNotice('Dead-letter customers were queued again.');
      await invalidate();
    },
    onError: (err: unknown) => setError(apiMessage(err, 'Dead-letter retry could not be started.')),
  });

  const cancelMut = useMutation({
    mutationFn: () => cancelBatch(batchId),
    onSuccess: async () => {
      setConfirmCancel(false);
      setNotice('The batch was cancelled. Customers already accepted stay accepted.');
      await invalidate();
    },
    onError: (err: unknown) => {
      setConfirmCancel(false);
      setError(apiMessage(err, 'The batch could not be cancelled.'));
    },
  });

  const openDownload = async (type: 'original' | 'processed' | 'failed' | 'success') => {
    setDownloadAnchor(null);
    try {
      const report = await downloadReport(batchId, type);
      window.open(report.url, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      setError(apiMessage(err, 'That file is not available yet.'));
    }
  };

  const itemCols = useMemo<ColDef<BatchItem>[]>(
    () => [
      { field: 'customerId', headerName: 'Customer', flex: 1, minWidth: 140 },
      { field: 'amount', headerName: 'Amount', width: 130 },
      {
        field: 'status',
        headerName: 'Status',
        width: 150,
        cellRenderer: (params: ICellRendererParams<BatchItem, string>) =>
          params.value ? <StatusChip status={params.value} /> : null,
      },
      { field: 'retryCount', headerName: 'Retries', width: 110 },
      { field: 'responseCode', headerName: 'Code', width: 180 },
      { field: 'failureReason', headerName: 'Reason', flex: 1.4, minWidth: 180 },
    ],
    [],
  );

  const batch = batchQuery.data;
  if (batchQuery.isLoading && !batch) return <LinearProgress />;
  if (batchQuery.isError && !batch) {
    return (
      <Alert severity="error" action={<Button onClick={() => void batchQuery.refetch()}>Retry</Button>}>
        This batch could not be loaded.
      </Alert>
    );
  }
  if (!batch) return <Alert severity="warning">Batch not found.</Alert>;

  const done = batch.successCount + batch.failedCount;
  const progress = completionPercent(done, batch.totalRecords);
  const itemTotal = itemsQuery.data?.total ?? 0;
  const itemFrom = itemTotal === 0 ? 0 : (itemPage - 1) * ITEM_PAGE_SIZE + 1;
  const itemTo = Math.min(itemPage * ITEM_PAGE_SIZE, itemTotal);

  return (
    <Stack spacing={2.5}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'flex-start' }} spacing={2}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="h6">Batch #{batch.id}</Typography>
            <Box className={live ? 'live-dot' : 'idle-dot'} />
            <Typography variant="caption" color="text.secondary">
              {connected ? (live ? 'Live' : 'Finished') : 'Reconnecting'}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
            <StatusChip status={batch.status} />
            <Typography variant="body2" color="text.secondary">
              {batch.uploadedBy} · {formatIst(batch.uploadedAt)}
            </Typography>
          </Stack>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {hasRole('RETRY') && (
            <>
              <Button variant="outlined" disabled={retryMut.isPending || !batch.failedCount} onClick={() => retryMut.mutate()}>
                Retry failed
              </Button>
              <Button
                variant="outlined"
                color="secondary"
                disabled={dlqMut.isPending || !batch.failedCount}
                onClick={() => dlqMut.mutate()}
              >
                Retry dead letter
              </Button>
            </>
          )}
          <Button variant="outlined" onClick={(event) => setDownloadAnchor(event.currentTarget)}>
            Download
          </Button>
          <Menu anchorEl={downloadAnchor} open={Boolean(downloadAnchor)} onClose={() => setDownloadAnchor(null)}>
            <MenuItem onClick={() => void openDownload('original')}>Original file</MenuItem>
            <MenuItem onClick={() => void openDownload('failed')}>Failed customers</MenuItem>
            <MenuItem onClick={() => void openDownload('success')}>Accepted customers</MenuItem>
            <MenuItem onClick={() => void openDownload('processed')}>Processed file</MenuItem>
          </Menu>
          {hasRole('UPLOAD') && live && (
            <Button color="error" variant="text" onClick={() => setConfirmCancel(true)}>
              Cancel
            </Button>
          )}
        </Stack>
      </Stack>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Box className="progress-card">
        <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
          <Typography variant="subtitle2">Progress</Typography>
          <Typography variant="h5" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {progress}%
          </Typography>
        </Stack>
        <LinearProgress variant="determinate" value={progress} sx={{ height: 10, mb: 2 }} />
        <Box className="metric-grid">
          <Metric label="Remaining" value={formatCount(batch.remaining ?? 0)} />
          <Metric label="In flight" value={formatCount(batch.workersRunning ?? 0)} />
          <Metric label="Customers / min" value={formatCount(batch.recordsPerMin ?? 0)} />
          <Metric label="Time left" value={batch.etaMs != null ? formatDuration(batch.etaMs) : '—'} />
          <Metric label={live ? 'Running' : 'Elapsed'} value={formatDuration(batch.durationMs)} />
          <Metric label="Accepted" value={formatCount(batch.successCount)} tone="success" />
          <Metric label="Failed" value={formatCount(batch.failedCount)} tone={batch.failedCount ? 'error' : undefined} />
          <Metric label="Duplicates" value={formatCount(batch.duplicateCount)} />
        </Box>
      </Box>

      <Tabs value={tab} onChange={(_event, value: number) => { setTab(value); setItemPage(1); }}>
        <Tab label="All customers" />
        <Tab label={`Failed${batch.failedCount ? ` (${formatCount(batch.failedCount)})` : ''}`} />
        <Tab label="Call log" />
      </Tabs>

      {(tab === 0 || tab === 1) && (
        <Stack spacing={1}>
          <Box className="ag-theme-quartz grid-frame" sx={{ height: 440, width: '100%' }}>
            <AgGridReact
              theme="legacy"
              rowData={itemsQuery.data?.items || []}
              columnDefs={itemCols}
              getRowId={(params) => params.data.id}
              defaultColDef={{ sortable: true, filter: true, resizable: true }}
              overlayNoRowsTemplate={itemsQuery.isLoading ? 'Loading customers…' : 'No customers in this view.'}
            />
          </Box>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="caption" color="text.secondary">
              {itemTotal ? `${formatCount(itemFrom)}–${formatCount(itemTo)} of ${formatCount(itemTotal)}` : 'No rows'}
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" disabled={itemPage <= 1} onClick={() => setItemPage((current) => current - 1)}>
                Previous
              </Button>
              <Button
                size="small"
                disabled={itemPage * ITEM_PAGE_SIZE >= itemTotal}
                onClick={() => setItemPage((current) => current + 1)}
              >
                Next
              </Button>
            </Stack>
          </Stack>
        </Stack>
      )}

      {tab === 2 && (
        <Box className="ag-theme-quartz grid-frame" sx={{ height: 440, width: '100%' }}>
          <AgGridReact
            theme="legacy"
            rowData={(logsQuery.data?.logs as Record<string, unknown>[]) || []}
            columnDefs={[
              { field: 'apiName', headerName: 'Call', flex: 1.2, minWidth: 180 },
              { field: 'statusCode', headerName: 'HTTP', width: 110 },
              { field: 'latency', headerName: 'Latency', width: 120 },
              { field: 'retryNo', headerName: 'Retry', width: 100 },
              { field: 'traceId', headerName: 'Trace', flex: 1, minWidth: 160 },
              {
                field: 'createdAt',
                headerName: 'Time',
                flex: 1,
                minWidth: 180,
                valueFormatter: (params) => formatIst(typeof params.value === 'string' ? params.value : null),
              },
            ]}
            defaultColDef={{ sortable: true, resizable: true }}
            overlayNoRowsTemplate={logsQuery.isLoading ? 'Loading calls…' : 'No calls recorded yet.'}
          />
        </Box>
      )}

      <Dialog open={confirmCancel} onClose={() => setConfirmCancel(false)}>
        <DialogTitle>Cancel batch #{batch.id}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Customers still waiting will be marked failed. Customers already accepted are left as they are.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmCancel(false)}>Keep running</Button>
          <Button color="error" variant="contained" disabled={cancelMut.isPending} onClick={() => cancelMut.mutate()}>
            {cancelMut.isPending ? 'Cancelling…' : 'Cancel batch'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        message={notice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Stack>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'error' }) {
  return (
    <Box className="metric">
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography
        variant="h6"
        sx={{
          fontVariantNumeric: 'tabular-nums',
          color: tone === 'success' ? 'success.dark' : tone === 'error' ? 'error.main' : 'text.primary',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}
