import { useState } from 'react';
import { Box, Tooltip } from '@mui/material';

export function CopyableText({ value }: { value?: string | null }) {
  const text = value?.trim() ?? '';
  const [copied, setCopied] = useState(false);
  if (!text) return <span>—</span>;

  return (
    <Tooltip title={copied ? 'Copied' : 'Copy'}>
      <Box
        component="button"
        type="button"
        aria-label={`Copy ${text}`}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            },
            () => undefined,
          );
        }}
        sx={{
          border: 0,
          p: 0,
          m: 0,
          maxWidth: '100%',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'copy',
          userSelect: 'text',
          textAlign: 'inherit',
        }}
      >
        {text}
      </Box>
    </Tooltip>
  );
}
