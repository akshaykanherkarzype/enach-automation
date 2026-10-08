import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { parsePeakWindows } from '../time/processing-window.js';

loadEnv();

function parseSizeToBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid size: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  };
  return Math.floor(amount * multipliers[unit]);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),

  INVOICE_GENERATION_QUEUE: z.string().default('invoice-generation-queue'),
  INVOICE_CHARGE_QUEUE: z.string().default('invoice-charge-queue'),
  INVOICE_GENERATION_DLQ: z.string().default('invoice-generation-dlq'),
  INVOICE_CHARGE_DLQ: z.string().default('invoice-charge-dlq'),

  QUEUE_CONCURRENCY: z.coerce.number().default(12),
  QUEUE_CONSUMERS: z.coerce.number().default(2),
  MAX_RETRY: z.coerce.number().default(3),
  RETRY_DELAYS_MS: z.string().default('5000,30000,120000'),
  BATCH_SIZE: z.coerce.number().default(500),
  API_TIMEOUT: z.coerce.number().default(120000),

  UPLOAD_MAX_SIZE: z.string().default('20MB'),
  S3_BUCKET: z.string().default('batch-files'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().default(3600),

  JWT_SECRET: z.string().min(8),
  JWT_EXPIRES_IN: z.string().default('8h'),

  EMAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  EMAIL_FROM: z.string().default('noreply@getzype.com'),
  FROM_EMAIL_ADDRESS: z.string().default('noreply@getzype.com'),
  BATCH_REPORT_EMAIL: z.string().default('akshay.kanherkar@getzype.com'),
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID_SES: z.string().optional().default(''),
  AWS_SECRET_ACCESS_KEY_SES: z.string().optional().default(''),

  PAYMENT_CLIENT: z.enum(['mock', 'http']).default('mock'),
  PAYMENT_SERVICE_BASE_URL: z.string().default(''),
  PAYMENT_REQUEST_GAP_MS: z.coerce.number().min(0).default(125),
  PAYMENT_MAX_IN_FLIGHT: z.coerce.number().int().min(1).default(8),
  PAYMENT_ADAPTIVE: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === '' || v === 'true' || v === '1'),
  PAYMENT_SLOT_WAIT_MS: z.coerce.number().min(1000).default(600_000),
  PAYMENT_CALL_BUDGET_MS: z.coerce.number().min(0).default(2500),
  PEAK_WINDOWS_IST: z.string().default('10:00-13:00,17:00-22:00'),
  INVOICE_SAME_DAY_GUARD: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === '' || v === 'true' || v === '1'),
  INVOICE_DAY_END_BUFFER_MS: z.coerce.number().min(0).default(300_000),
  MOCK_PAYMENT_SUCCESS_RATE: z.coerce.number().min(0).max(1).default(0.9),
  MOCK_PAYMENT_LATENCY_MS: z.coerce.number().default(200),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  EMAIL_ADDRESS: z.string().optional().default(''),
  EMAIL_PASSWORD: z.string().optional().default(''),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  DEV_USER_VIEW: z.string().default('viewer@zype.local'),
  DEV_USER_UPLOAD: z.string().default('uploader@zype.local'),
  DEV_USER_ADMIN: z.string().default('admin@zype.local'),
}).superRefine((data, ctx) => {
  if (data.PAYMENT_CLIENT === 'http' && !data.PAYMENT_SERVICE_BASE_URL.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PAYMENT_SERVICE_BASE_URL is required when PAYMENT_CLIENT=http',
      path: ['PAYMENT_SERVICE_BASE_URL'],
    });
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;

let peakWindows: ReturnType<typeof parsePeakWindows>;
try {
  peakWindows = parsePeakWindows(raw.PEAK_WINDOWS_IST);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

export const env = {
  ...raw,
  uploadMaxBytes: parseSizeToBytes(raw.UPLOAD_MAX_SIZE),
  retryDelaysMs: raw.RETRY_DELAYS_MS.split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0),
  emailEnabled: Boolean(raw.EMAIL_ENABLED),
  s3ForcePathStyle: Boolean(raw.S3_FORCE_PATH_STYLE),
  peakWindows,
  invoiceSameDayGuard: Boolean(raw.INVOICE_SAME_DAY_GUARD),
  paymentAdaptive: Boolean(raw.PAYMENT_ADAPTIVE),
};

export type Env = typeof env;
