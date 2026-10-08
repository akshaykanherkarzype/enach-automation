import aws from 'aws-sdk';
import nodemailer from 'nodemailer';
import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';
import {
  buildCompletionMail,
  buildProgressMail,
  buildSmtpTransportOptions,
  type BatchCompletionEmail,
  type BatchProgressEmail,
  type CompletionMail,
} from './content.js';

export type { BatchCompletionEmail, BatchProgressEmail } from './content.js';

export interface EmailClient {
  sendBatchCompletion(payload: BatchCompletionEmail): Promise<void>;
  sendFailureReport(payload: BatchCompletionEmail): Promise<void>;
  sendBatchProgress(payload: BatchProgressEmail): Promise<void>;
}

function createSesTransporter() {
  aws.config.update({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID_SES,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY_SES,
    },
    apiVersion: '2010-12-01',
  });

  // Same SES transport pattern as events-management-service
  return nodemailer.createTransport({
    SES: new aws.SES(),
  } as never);
}

function createSmtpTransporter() {
  return nodemailer.createTransport(
    buildSmtpTransportOptions({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.EMAIL_ADDRESS,
      pass: env.EMAIL_PASSWORD,
    }),
  );
}

class NodemailerEmailClient implements EmailClient {
  constructor(private readonly mode: 'smtp' | 'ses') {}

  async sendBatchCompletion(payload: BatchCompletionEmail): Promise<void> {
    await this.send(payload);
  }

  async sendFailureReport(payload: BatchCompletionEmail): Promise<void> {
    await this.send(payload);
  }

  async sendBatchProgress(payload: BatchProgressEmail): Promise<void> {
    await this.deliver(payload.to, buildProgressMail(payload), {
      batchId: payload.batchId,
      kind: payload.kind,
      remaining: payload.remaining,
    });
  }

  private async send(payload: BatchCompletionEmail): Promise<void> {
    await this.deliver(payload.to, buildCompletionMail(payload), {
      batchId: payload.batchId,
      failed: payload.failed,
    });
  }

  private async deliver(
    to: string,
    mail: CompletionMail,
    context: Record<string, unknown>,
  ): Promise<void> {
    const recipients = reportRecipients(to, env.BATCH_REPORT_EMAIL);

    if (!recipients.length) {
      logger.warn('No email recipients configured for batch report');
      return;
    }
    // Outlook rejects a From address that is not the authenticated mailbox.
    const from =
      this.mode === 'smtp'
        ? env.EMAIL_ADDRESS || env.FROM_EMAIL_ADDRESS || env.EMAIL_FROM
        : env.FROM_EMAIL_ADDRESS || env.EMAIL_ADDRESS || env.EMAIL_FROM;
    const transporter = this.mode === 'smtp' ? createSmtpTransporter() : createSesTransporter();

    await transporter.sendMail({
      from,
      to: recipients.join(','),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: mail.attachments,
    });

    logger.info(
      {
        to: recipients,
        ...context,
        transport: this.mode,
        hasAttachment: mail.attachments.length > 0,
      },
      'Batch email sent',
    );
  }
}

class StubEmailClient implements EmailClient {
  async sendBatchCompletion(payload: BatchCompletionEmail): Promise<void> {
    logger.info({ ...payload, failedCsv: undefined }, 'Email stub: batch completion');
  }

  async sendFailureReport(payload: BatchCompletionEmail): Promise<void> {
    logger.info({ ...payload, failedCsv: undefined }, 'Email stub: failure report');
  }

  async sendBatchProgress(payload: BatchProgressEmail): Promise<void> {
    logger.info(payload, 'Email stub: batch progress');
  }
}

/** Dev login is not a mailbox. Reports still go to BATCH_REPORT_EMAIL. */
export function reportRecipients(
  uploader: string | undefined,
  reportEmail: string | undefined,
): string[] {
  return Array.from(
    new Set(
      [uploader, reportEmail]
        .map((email) => email?.trim())
        .filter((email): email is string => Boolean(email))
        .filter((email) => email.toLowerCase() !== 'admin@zype.local'),
    ),
  );
}

export function resolveEmailTransport(): 'smtp' | 'ses' | 'stub' {
  if (!env.emailEnabled) return 'stub';
  if (env.SMTP_HOST && env.EMAIL_ADDRESS && env.EMAIL_PASSWORD) return 'smtp';
  if (env.AWS_ACCESS_KEY_ID_SES && env.AWS_SECRET_ACCESS_KEY_SES && env.AWS_REGION) return 'ses';
  return 'stub';
}

function createEmailClient(): EmailClient {
  const transport = resolveEmailTransport();
  if (transport === 'stub') return new StubEmailClient();
  logger.info({ transport }, 'Batch completion email transport ready');
  return new NodemailerEmailClient(transport);
}

export const emailClient: EmailClient = createEmailClient();

export function isEmailEnabled(): boolean {
  return env.emailEnabled && resolveEmailTransport() !== 'stub';
}
