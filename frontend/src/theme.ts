import { createTheme, alpha } from '@mui/material/styles';

const primary = '#0A6B4E';
const secondary = '#E85D04';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: primary, dark: '#064E3B', light: '#10B981' },
    secondary: { main: secondary, dark: '#C2410C' },
    background: {
      default: '#EEF3F0',
      paper: '#FFFFFF',
    },
    success: { main: '#059669' },
    error: { main: '#DC2626' },
    warning: { main: '#D97706' },
    info: { main: '#0284C7' },
    divider: '#D5E3DB',
  },
  typography: {
    fontFamily: '"IBM Plex Sans", sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.03em' },
    h5: { fontWeight: 700, letterSpacing: '-0.02em' },
    h6: { fontWeight: 650 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundImage:
            'radial-gradient(900px 420px at 8% -8%, rgba(10,107,78,0.14), transparent 55%), radial-gradient(700px 360px at 96% 0%, rgba(232,93,4,0.12), transparent 50%)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          boxShadow: 'none',
          '&:hover': { boxShadow: 'none' },
        },
        containedPrimary: {
          background: `linear-gradient(135deg, ${primary} 0%, #047857 100%)`,
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          paddingInline: 16,
          borderColor: '#D5E3DB',
          '&.Mui-selected': {
            color: '#064E3B',
            backgroundColor: alpha(primary, 0.1),
            '&:hover': { backgroundColor: alpha(primary, 0.16) },
          },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 48,
          fontWeight: 600,
          color: '#5B7168',
          borderRadius: '10px 10px 0 0',
          transition: 'color 160ms ease, background 160ms ease',
          '&.Mui-selected': {
            color: primary,
            background: alpha(primary, 0.08),
          },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 3,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${primary}, ${secondary})`,
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          fontWeight: 600,
          fontSize: 12,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: '#3d5248',
          background: '#f4f8f6',
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          transition: 'background 140ms ease',
          '&.Mui-selected': {
            backgroundColor: `${alpha(primary, 0.1)} !important`,
            boxShadow: `inset 3px 0 0 ${primary}`,
          },
          '&.Mui-selected:hover': {
            backgroundColor: `${alpha(primary, 0.14)} !important`,
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 999, height: 8 },
        bar: { borderRadius: 999 },
      },
    },
  },
});
