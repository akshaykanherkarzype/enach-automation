export const ROLES = {
  VIEW: 'VIEW',
  UPLOAD: 'UPLOAD',
  RETRY: 'RETRY',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const MODULES = {
  INVOICE_GENERATION: 'INVOICE_GENERATION',
  INVOICE_CHARGE: 'INVOICE_CHARGE',
} as const;

export type ModuleName = (typeof MODULES)[keyof typeof MODULES];

export const REQUIRED_HEADERS = ['customer_id', 'final_nach_amount'] as const;

export const API_NAMES = {
  INVOICE_GENERATE: 'POST /upi/autopay/invoice',
  INVOICE_CHARGE: 'POST /upi/autopay/charge',
} as const;

export const LOCK_KEYS = {
  INVOICE_GENERATION: 'lock:batch:invoice-generation',
  INVOICE_CHARGE: 'lock:batch:invoice-charge',
} as const;

export const TERMINAL_BATCH_STATUSES = [
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED',
] as const;
