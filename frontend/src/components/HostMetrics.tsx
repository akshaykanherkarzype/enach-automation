import { Box, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { getHostMetrics, type HostReading } from '../api/batchApi';

const TONE: Record<HostReading['status'], string> = {
  Usual: 'success.main',
  Elevated: 'warning.main',
  Pause: 'error.main',
};

export function HostMetrics() {
  const query = useQuery({
    queryKey: ['host-metrics'],
    queryFn: getHostMetrics,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });

  const snapshot = query.data;
  const readings = snapshot?.readings ?? [];

  return (
    <Box className="progress-card">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <Box className="live-dot" />
        <Typography variant="subtitle2">Payment host</Typography>
        <Typography variant="caption" color="text.secondary">
          {snapshot?.instance || 'respo-prod'} · live
        </Typography>
      </Stack>
      <Box className="metric-grid">
        {(readings.length ? readings : placeholderReadings()).map((reading) => (
          <Box key={reading.label} className="metric">
            <Typography variant="caption" color="text.secondary">
              {reading.label}
            </Typography>
            <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {query.isLoading && !snapshot ? '…' : reading.value}
            </Typography>
            <Typography variant="caption" sx={{ color: TONE[reading.status], fontWeight: 700 }}>
              {reading.status}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function placeholderReadings(): HostReading[] {
  return [
    { label: 'Memory', value: '—', status: 'Usual' },
    { label: 'Disk', value: '—', status: 'Usual' },
    { label: 'CPU', value: '—', status: 'Usual' },
    { label: 'Event loop', value: '—', status: 'Usual' },
    { label: 'Payment service', value: '—', status: 'Usual' },
  ];
}
