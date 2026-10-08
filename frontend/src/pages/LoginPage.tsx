import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useAuth } from '../auth/AuthContext';
import { apiMessage } from '../lib/batch';

interface FormValues {
  email: string;
  password: string;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<FormValues>({
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await login(values.email.trim(), values.password);
      navigate('/');
    } catch (err: unknown) {
      setError(apiMessage(err, 'Sign-in failed. Check the email and password.'));
    }
  });

  return (
    <Box className="login-shell">
      <Box className="login-brand">
        <Typography variant="overline" sx={{ letterSpacing: '0.18em', fontWeight: 700, opacity: 0.8 }}>
          Zype Collections
        </Typography>
        <Typography variant="h3" sx={{ mt: 1, maxWidth: 420, fontWeight: 700, letterSpacing: '-0.03em' }}>
          UPI Autopay batches
        </Typography>
        <Typography sx={{ mt: 2, maxWidth: 420, opacity: 0.88, lineHeight: 1.6 }}>
          Upload a customer file, watch invoices and charges move, and download the result when the batch finishes.
        </Typography>
      </Box>

      <Box className="login-panel">
        <Stack spacing={2.5} component="form" onSubmit={onSubmit}>
          <Box>
            <Typography variant="h5">Sign in</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              Use the account issued for this console.
            </Typography>
          </Box>

          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            fullWidth
            {...register('email', { required: true })}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            fullWidth
            {...register('password', { required: true })}
          />
          <Button type="submit" variant="contained" size="large" disabled={formState.isSubmitting}>
            {formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
