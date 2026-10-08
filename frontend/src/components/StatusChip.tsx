import { Chip } from '@mui/material';

const colorMap: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary'> = {
  UPLOADED: 'default',
  VALIDATING: 'info',
  READY: 'info',
  QUEUED: 'primary',
  PROCESSING: 'warning',
  COMPLETED: 'success',
  PARTIAL_SUCCESS: 'warning',
  FAILED: 'error',
  CANCELLED: 'default',
  PENDING: 'default',
  SUCCESS: 'success',
  RETRYING: 'warning',
};

export function StatusChip({ status }: { status: string }) {
  const color = colorMap[status] || 'default';
  return (
    <Chip
      size="small"
      label={status.replaceAll('_', ' ')}
      color={color}
        variant="filled"
        sx={{
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.04em',
          height: 24,
          ...(status === 'PROCESSING' || status === 'RETRYING' || status === 'QUEUED'
            ? { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)' }
            : {}),
        }}
    />
  );
}
