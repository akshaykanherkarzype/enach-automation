import {
  Alert,
  Box,
  IconButton,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { BatchExecution, BatchModuleSlug } from '../api/batchApi';
import { listBatches, RECENT_BATCH_LIMIT } from '../api/batchApi';
import { completionPercent, formatCount, formatIst, isBatchLive, SOCKET_FALLBACK_MS } from '../lib/batch';
import { useSocketStatus } from '../realtime/batchSocket';
import { StatusChip } from './StatusChip';

interface Props {
  module: BatchModuleSlug;
  selectedId?: string | null;
  onSelect: (id: string) => void;
}

export function useBatchList(module: BatchModuleSlug, page: number) {
  const connected = useSocketStatus() === 'open';
  return useQuery({
    queryKey: ['batches', module, page],
    queryFn: () => listBatches(module, page),
    placeholderData: keepPreviousData,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: connected ? false : SOCKET_FALLBACK_MS,
  });
}

export function BatchHistory({ module, selectedId, onSelect }: Props) {
  const query = useBatchList(module, 1);
  return <BatchHistoryView query={query} selectedId={selectedId} onSelect={onSelect} />;
}

function BatchHistoryView({
  query,
  selectedId,
  onSelect,
}: {
  query: UseQueryResult<{ items: BatchExecution[]; total: number; page: number; pageSize: number }>;
  selectedId?: string | null;
  onSelect: (id: string) => void;
}) {
  const connection = useSocketStatus();
  const items = query.data?.items ?? [];
  const live = items.some((batch) => isBatchLive(batch.status));
  const showInitialLoader = query.isLoading && !query.data;
  const focus = items.find((batch) => batch.id === selectedId) ?? items[0];
  const focusRemaining = focus
    ? Math.max(focus.totalRecords - focus.successCount - focus.failedCount, 0)
    : 0;

  return (
    <Stack spacing={2}>
      {focus && (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {selectedId === focus.id ? `Batch #${focus.id}` : `Latest batch #${focus.id}`}
          </Typography>
          <Box className="kpi-grid">
            <Kpi label="Customers" value={formatCount(focus.totalRecords)} />
            <Kpi label="Accepted" value={formatCount(focus.successCount)} />
            <Kpi label="Failed" value={formatCount(focus.failedCount)} />
            <Kpi label="Remaining" value={formatCount(focusRemaining)} />
          </Box>
        </Box>
      )}

      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" spacing={1.25} alignItems="center">
          <Typography variant="h6">Recent batches</Typography>
          <Typography variant="caption" color="text.secondary">
            Latest {RECENT_BATCH_LIMIT}
            {(query.data?.total ?? 0) > RECENT_BATCH_LIMIT ? ` of ${formatCount(query.data?.total ?? 0)}` : ''}
          </Typography>
          <LiveMark live={live} connection={connection} hasData={Boolean(query.data)} />
        </Stack>
        <Tooltip title="Refresh now">
          <span>
            <IconButton
              aria-label="Refresh batches"
              onClick={() => void query.refetch()}
              size="small"
              disabled={query.isFetching}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {showInitialLoader && <LinearProgress />}
      {query.isError && (
        <Alert
          severity="error"
          action={
            <IconButton color="inherit" size="small" onClick={() => void query.refetch()} aria-label="Retry">
              <RefreshIcon fontSize="small" />
            </IconButton>
          }
        >
          Could not load batches. The list will try again shortly.
        </Alert>
      )}

      {!items.length && !showInitialLoader && !query.isError ? (
        <Typography align="center" color="text.secondary" sx={{ py: 6 }}>
          No batches in this module yet. Upload a file to start one.
        </Typography>
      ) : (
      <TableContainer sx={{ mx: -0.5 }}>
        <Table size="small" sx={{ minWidth: 920 }}>
          <TableHead>
            <TableRow>
              <TableCell width={88}>Batch</TableCell>
              <TableCell>Uploaded by</TableCell>
              <TableCell width={200}>Uploaded</TableCell>
              <TableCell width={180}>Status</TableCell>
              <TableCell width={200}>Progress</TableCell>
              <TableCell align="right" width={88}>
                Total
              </TableCell>
              <TableCell align="right" width={88}>
                Accepted
              </TableCell>
              <TableCell align="right" width={80}>
                Failed
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((batch) => {
              const done = batch.successCount + batch.failedCount;
              const progress = completionPercent(done, batch.totalRecords);
              return (
                <TableRow
                  key={batch.id}
                  hover
                  selected={selectedId === batch.id}
                  sx={{ cursor: 'pointer' }}
                  onClick={() => onSelect(batch.id)}
                >
                  <TableCell sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>#{batch.id}</TableCell>
                  <TableCell sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {batch.uploadedBy}
                  </TableCell>
                  <TableCell>{formatIst(batch.uploadedAt)}</TableCell>
                  <TableCell>
                    <StatusChip status={batch.status} />
                  </TableCell>
                  <TableCell>
                    <LinearProgress
                      variant="determinate"
                      value={progress}
                      color={batch.failedCount > 0 && !isBatchLive(batch.status) ? 'warning' : 'primary'}
                      sx={{ mb: 0.5 }}
                    />
                    <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatCount(done)} / {formatCount(batch.totalRecords)} · {progress}%
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatCount(batch.totalRecords)}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'success.dark' }}>
                    {formatCount(batch.successCount)}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      fontVariantNumeric: 'tabular-nums',
                      color: batch.failedCount ? 'error.main' : 'text.secondary',
                    }}
                  >
                    {formatCount(batch.failedCount)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      )}

    </Stack>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Box className="kpi">
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    </Box>
  );
}

function LiveMark({
  live,
  connection,
  hasData,
}: {
  live: boolean;
  connection: 'connecting' | 'open' | 'closed';
  hasData: boolean;
}) {
  if (!hasData) return null;
  const label = connection === 'open' ? (live ? 'Live' : 'Settled') : 'Reconnecting';
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box className={connection === 'open' && live ? 'live-dot' : 'idle-dot'} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}
