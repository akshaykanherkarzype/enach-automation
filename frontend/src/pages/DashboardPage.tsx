import { useEffect, useRef, useState } from 'react';
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Container,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Typography,
} from '@mui/material';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import { useAuth } from '../auth/AuthContext';
import { FileUpload } from '../components/FileUpload';
import { BatchHistory } from '../components/BatchHistory';
import { BatchDetails } from '../components/BatchDetails';
import type { BatchModuleSlug } from '../api/batchApi';

const MODULES: Array<{ slug: BatchModuleSlug; label: string; hint: string }> = [
  {
    slug: 'invoice-generation',
    label: 'Invoice generation',
    hint: 'Create UPI autopay invoices for the customers in the file.',
  },
  {
    slug: 'invoice-charge',
    label: 'Invoice charge',
    hint: 'Charge unpaid UPI invoices for the customers in the file.',
  },
];

export function DashboardPage() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState<Record<BatchModuleSlug, string | null>>({
    'invoice-generation': null,
    'invoice-charge': null,
  });
  const detailsRef = useRef<HTMLDivElement>(null);
  const current = MODULES[tab];
  const selectedId = selected[current.slug];

  useEffect(() => {
    if (!selectedId) return;
    detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

  return (
    <Box className="app-shell">
      <AppBar
        position="sticky"
        elevation={0}
        sx={{
          bgcolor: 'rgba(255,255,255,0.9)',
          color: 'text.primary',
          borderBottom: '1px solid',
          borderColor: 'divider',
          backdropFilter: 'blur(16px)',
        }}
      >
        <Toolbar sx={{ gap: 2, minHeight: 68 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="overline" sx={{ color: 'primary.main', lineHeight: 1, fontWeight: 700, letterSpacing: '0.14em' }}>
              Zype
            </Typography>
            <Typography variant="h5" color="primary.dark" noWrap>
              UPI Autopay
            </Typography>
          </Box>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box sx={{ textAlign: 'right', display: { xs: 'none', sm: 'block' } }}>
              <Typography variant="body2" fontWeight={600}>
                {user?.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {user?.roles.join(' · ')}
              </Typography>
            </Box>
            <Avatar sx={{ bgcolor: 'primary.main', width: 36, height: 36, fontSize: 14, fontWeight: 700 }}>
              {(user?.name || 'U').slice(0, 1).toUpperCase()}
            </Avatar>
            <Button onClick={logout} variant="outlined" size="small" startIcon={<LogoutRoundedIcon />}>
              Sign out
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg" sx={{ py: { xs: 2, md: 3 } }}>
        <Stack spacing={2.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'flex-end' }} spacing={1.5}>
            <Box>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={current.slug}
                onChange={(_event, value: BatchModuleSlug | null) => {
                  if (!value) return;
                  setTab(MODULES.findIndex((module) => module.slug === value));
                }}
              >
                {MODULES.map((module) => (
                  <ToggleButton key={module.slug} value={module.slug}>
                    {module.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25 }}>
                {current.hint}
              </Typography>
            </Box>
          </Stack>

          <Box className="panel">
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              New batch
            </Typography>
            <FileUpload
              module={current.slug}
              onBatchCreated={(id) => setSelected((prev) => ({ ...prev, [current.slug]: id }))}
            />
          </Box>

          <Box className="panel">
            <BatchHistory
              module={current.slug}
              selectedId={selectedId}
              onSelect={(id) =>
                setSelected((prev) => ({
                  ...prev,
                  [current.slug]: prev[current.slug] === id ? null : id,
                }))
              }
            />
          </Box>

          {selectedId && (
            <Box className="panel" ref={detailsRef} key={selectedId}>
              <BatchDetails batchId={selectedId} moduleKey={current.slug} />
            </Box>
          )}
        </Stack>
      </Container>
    </Box>
  );
}

