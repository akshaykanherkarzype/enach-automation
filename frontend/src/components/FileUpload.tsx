import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { BatchModuleSlug, ValidationSummary } from '../api/batchApi';
import { confirmUpload, uploadFile } from '../api/batchApi';
import { useAuth } from '../auth/AuthContext';
import { apiMessage, formatCount, isBatchLive } from '../lib/batch';
import { useBatchList } from './BatchHistory';

interface Props {
  module: BatchModuleSlug;
  onBatchCreated: (batchId: string) => void;
}

export function FileUpload({ module, onBatchCreated }: Props) {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [dragActive, setDragActive] = useState(false);
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canUpload = hasRole('UPLOAD');
  const running = useBatchList(module, 1);
  const openBatch =
    running.data?.openBatch === undefined
      ? running.data?.items.find((batch) => isBatchLive(batch.status))
      : running.data.openBatch;
  const uploadBlocked = Boolean(openBatch);

  useEffect(() => {
    setSummary(null);
    setError(null);
  }, [module]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!canUpload || uploadBlocked) return;
      setError(null);
      setBusy(true);
      try {
        setSummary(await uploadFile(module, file));
      } catch (err: unknown) {
        setError(apiMessage(err, 'The file could not be checked. Confirm the columns and try again.'));
        setSummary(null);
      } finally {
        setBusy(false);
      }
    },
    [canUpload, module, uploadBlocked],
  );

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const onConfirm = async () => {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await confirmUpload(module, summary.uploadToken);
      setSummary(null);
      await queryClient.invalidateQueries({ queryKey: ['batches', module] });
      onBatchCreated(batch.id);
    } catch (err: unknown) {
      setError(apiMessage(err, 'The batch could not be started.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={2}>
      {!canUpload && <Alert severity="info">This login can review batches. Uploading needs the upload role.</Alert>}
      {canUpload && openBatch && (
        <Alert severity="warning">
          Batch #{openBatch.id} is still {openBatch.status.replaceAll('_', ' ').toLowerCase()}. Another file can be
          uploaded after it finishes.
        </Alert>
      )}

      <Box
        className={`dropzone ${dragActive ? 'active' : ''} ${!canUpload || busy || uploadBlocked ? 'disabled' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (canUpload && !busy && !uploadBlocked) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={canUpload && !busy && !uploadBlocked ? onDrop : undefined}
        onClick={() => {
          if (!canUpload || busy || uploadBlocked) return;
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.csv,.xlsx,.xls';
          input.onchange = () => {
            const file = input.files?.[0];
            if (file) void handleFile(file);
          };
          input.click();
        }}
        role="button"
        tabIndex={canUpload ? 0 : -1}
        aria-disabled={!canUpload || busy}
      >
        <CloudUploadOutlinedIcon sx={{ fontSize: 36, color: 'primary.main', mb: 1 }} />
        <Typography variant="h6">{busy ? 'Checking file…' : 'Upload a customer file'}</Typography>
        <Typography color="text.secondary">
          CSV or Excel with <code>customer_id</code> and <code>final_nach_amount</code>
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Drop the file here, or click to browse
        </Typography>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {summary && (
        <Box className="summary-card">
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={650}>
              Ready to start
            </Typography>
            <Chip size="small" label={summary.originalFilename} variant="outlined" />
          </Stack>
          <Box className="stat-row">
            <Stat label="Rows" value={summary.totalRecords} />
            <Stat label="Will run" value={summary.validRecords} tone="success" />
            <Stat label="Duplicates" value={summary.duplicateCount} />
            <Stat label="Invalid" value={summary.invalidCount} tone={summary.invalidCount ? 'error' : undefined} />
          </Box>
          {summary.invalidRows.length > 0 && (
            <Stack spacing={0.5} sx={{ my: 1.5 }}>
              {summary.invalidRows.slice(0, 5).map((row) => (
                <Typography key={`${row.rowNumber}-${row.reason}`} variant="body2" color="error.main">
                  Row {row.rowNumber}
                  {row.customerId ? ` · ${row.customerId}` : ''}: {row.reason}
                </Typography>
              ))}
              {summary.invalidRows.length > 5 && (
                <Typography variant="caption" color="text.secondary">
                  {summary.invalidRows.length - 5} more invalid rows are not listed.
                </Typography>
              )}
            </Stack>
          )}
          {summary.validRecords === 0 && (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              Nothing in this file can be sent. Fix the rows and upload it again.
            </Alert>
          )}
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={busy || summary.validRecords === 0} onClick={() => void onConfirm()}>
              {busy ? 'Starting…' : `Start ${formatCount(summary.validRecords)} customers`}
            </Button>
            <Button variant="text" disabled={busy} onClick={() => setSummary(null)}>
              Discard
            </Button>
          </Stack>
        </Box>
      )}
    </Stack>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'error';
}) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography
        variant="h5"
        sx={{ fontVariantNumeric: 'tabular-nums', color: tone === 'success' ? 'success.dark' : tone === 'error' ? 'error.main' : 'text.primary' }}
      >
        {formatCount(value)}
      </Typography>
    </Box>
  );
}
