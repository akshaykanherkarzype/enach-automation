import {
  invoiceCallGate,
  peakDeferDelayMs,
  type PeakWindow,
} from '../../../common/time/processing-window.js';
import { terminalFailureReason } from '../../../infrastructure/payment/retry-policy.js';
import type { PaymentResponse } from '../../../infrastructure/payment/types.js';

export type BatchModuleName = 'INVOICE_GENERATION' | 'INVOICE_CHARGE';

export type BeforeCallPlan =
  | { action: 'call' }
  | { action: 'defer'; delayMs: number; reason: string }
  | { action: 'fail'; reason: string };

export type AfterResponsePlan =
  | { action: 'success' }
  | { action: 'defer'; delayMs: number; reason: string }
  | { action: 'retry'; delayMs: number; reason: string }
  | { action: 'fail'; reason: string };

export type AttemptPlan = BeforeCallPlan | AfterResponsePlan;

export interface BeforeCallInput {
  now: Date;
  module: BatchModuleName;
  anchorDay: string;
  enforcePeak: boolean;
  enforceSameDay: boolean;
  peakWindows: PeakWindow[];
  dayEndBufferMs: number;
}

export function planBeforeCall(input: BeforeCallInput): BeforeCallPlan {
  if (input.enforceSameDay && input.module === 'INVOICE_GENERATION') {
    const gate = invoiceCallGate(input.now, input.anchorDay, input.dayEndBufferMs);
    if (!gate.ok) return { action: 'fail', reason: gate.reason };
  }

  if (input.enforcePeak) {
    const delayMs = peakDeferDelayMs(input.now, input.peakWindows);
    if (delayMs > 0) {
      const resumeAt = new Date(input.now.getTime() + delayMs);
      if (input.enforceSameDay && input.module === 'INVOICE_GENERATION') {
        const gate = invoiceCallGate(resumeAt, input.anchorDay, input.dayEndBufferMs);
        if (!gate.ok) return { action: 'fail', reason: gate.reason };
      }
      return {
        action: 'defer',
        delayMs,
        reason: 'PEAK_HOURS',
      };
    }
  }

  return { action: 'call' };
}

export interface AfterResponseInput {
  now: Date;
  module: BatchModuleName;
  anchorDay: string;
  enforceSameDay: boolean;
  dayEndBufferMs: number;
  response: Pick<
    PaymentResponse,
    'success' | 'retryable' | 'deferred' | 'deferDelayMs' | 'responseCode' | 'body'
  >;
  retryCount: number;
  maxRetry: number;
  retryDelaysMs: number[];
}

export function planAfterResponse(input: AfterResponseInput): AfterResponsePlan {
  if (input.response.deferred) {
    return {
      action: 'defer',
      delayMs: input.response.deferDelayMs ?? 5_000,
      reason: input.response.responseCode,
    };
  }

  if (input.response.success) return { action: 'success' };

  const bodyMessage =
    typeof input.response.body.message === 'string' ? input.response.body.message : '';
  const reason = bodyMessage || input.response.responseCode || 'PAYMENT_FAILED';
  const fail = (text: string): AfterResponsePlan => ({
    action: 'fail',
    reason: terminalFailureReason(input.response.body, text),
  });

  if (!input.response.retryable) {
    return fail(reason);
  }

  const nextRetry = input.retryCount + 1;
  if (nextRetry > input.maxRetry) {
    return fail(reason);
  }

  const delays = input.retryDelaysMs.length ? input.retryDelaysMs : [5_000, 30_000, 120_000];
  const delayMs = delays[Math.min(nextRetry - 1, delays.length - 1)] ?? 5_000;

  if (input.enforceSameDay && input.module === 'INVOICE_GENERATION') {
    const fireAt = new Date(input.now.getTime() + delayMs);
    const gate = invoiceCallGate(fireAt, input.anchorDay, input.dayEndBufferMs);
    if (!gate.ok) {
      return fail(`${reason}; ${gate.reason}`);
    }
  }

  return { action: 'retry', delayMs, reason };
}
