import { istParts } from '../../common/time/ist.js';

export interface BatchCompletionEmail {
  to: string;
  module: string;
  batchId: string;
  total: number;
  success: number;
  failed: number;
  duplicates: number;
  executionTimeMs: number;
  failedCsv?: Buffer;
  status: string;
}

export interface CompletionMail {
  subject: string;
  text: string;
  html: string;
  attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }>;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

interface StatusTone {
  label: string;
  color: string;
  background: string;
  accent: string;
  intro: string;
}

export function moduleLabel(module: string): string {
  return module === 'INVOICE_GENERATION' ? 'Invoice Generation' : 'Invoice Charge';
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCount(value: number): string {
  return value.toLocaleString('en-IN');
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatIstTimestamp(date: Date): string {
  const p = istParts(date);
  const day = String(p.day).padStart(2, '0');
  const hour = String(p.hour).padStart(2, '0');
  const minute = String(p.minute).padStart(2, '0');
  return `${day} ${MONTHS[p.month - 1]} ${p.year}, ${hour}:${minute} IST`;
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case 'COMPLETED':
      return {
        label: 'Completed',
        color: '#0f6b4c',
        background: '#e8f6ef',
        accent: '#0A6B4E',
        intro: 'Every customer in this batch was accepted by payment-service.',
      };
    case 'PARTIAL_SUCCESS':
      return {
        label: 'Partial success',
        color: '#9a6700',
        background: '#fff6e0',
        accent: '#C2410C',
        intro: 'The batch finished. Some customers were accepted, and the rest need a review.',
      };
    case 'FAILED':
      return {
        label: 'Failed',
        color: '#9b1c1c',
        background: '#fdecec',
        accent: '#9b1c1c',
        intro: 'Payment-service did not accept the customers in this batch.',
      };
    case 'CANCELLED':
      return {
        label: 'Cancelled',
        color: '#3f3f46',
        background: '#f4f4f5',
        accent: '#52525b',
        intro: 'This batch was cancelled before every customer finished.',
      };
    default:
      return {
        label: status,
        color: '#0f6b4c',
        background: '#e8f6ef',
        accent: '#0A6B4E',
        intro: 'The batch has reached a final status.',
      };
  }
}

function successNote(module: string): string {
  if (module === 'INVOICE_GENERATION') {
    return 'Success means payment-service created the UPI invoice, or an unpaid invoice already existed (HTTP 200, status success).';
  }
  return 'Success means payment-service created the UPI charge (HTTP 200, status success).';
}

function attachmentNote(payload: BatchCompletionEmail, filename: string): string {
  return payload.failed > 0
    ? `failed.csv is attached as ${filename} with customer-level failure reasons.`
    : 'No failed records for this batch.';
}

function metricCell(label: string, value: string, color: string): string {
  return `
    <td width="25%" valign="top" style="padding:0 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7faf8;border:1px solid #e2ebe6;border-radius:8px;">
        <tr>
          <td style="padding:14px 12px 12px 12px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#5b7168;">
              ${escapeHtml(label)}
            </div>
            <div style="margin-top:6px;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;color:${color};">
              ${escapeHtml(value)}
            </div>
          </td>
        </tr>
      </table>
    </td>`;
}

function detailRow(label: string, value: string, shaded: boolean): string {
  const bg = shaded ? '#f7faf8' : '#ffffff';
  return `
    <tr>
      <td bgcolor="${bg}" style="width:42%;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5b7168;background-color:${bg};border-bottom:1px solid #e2ebe6;">
        ${escapeHtml(label)}
      </td>
      <td bgcolor="${bg}" style="padding:12px 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#12261e;background-color:${bg};border-bottom:1px solid #e2ebe6;">
        ${escapeHtml(value)}
      </td>
    </tr>`;
}

function buildHtml(input: {
  payload: BatchCompletionEmail;
  label: string;
  tone: StatusTone;
  duration: string;
  generatedAt: string;
  filename: string;
  note: string;
  attachment: string;
}): string {
  const { payload, label, tone, duration, generatedAt, filename, note, attachment } = input;
  const accepted =
    payload.total > 0 ? `${Math.round((payload.success / payload.total) * 1000) / 10}%` : '—';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UPI Batch report</title>
</head>
<body style="margin:0;padding:0;background-color:#eef3f0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef3f0;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background-color:#064e3b;padding:28px 32px 24px 32px;border-bottom:3px solid ${tone.accent};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a7f3d0;">
                    Zype &nbsp;·&nbsp; UPI Autopay
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:6px 12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${tone.color};background-color:${tone.background};border-radius:999px;">
                      ${escapeHtml(tone.label)}
                    </span>
                  </td>
                </tr>
              </table>
              <div style="margin-top:18px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.25;color:#f7faf8;">
                ${escapeHtml(label)}
              </div>
              <div style="margin-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d1fae5;">
                Batch #${escapeHtml(payload.batchId)} &nbsp;·&nbsp; ${escapeHtml(generatedAt)}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.55;color:#12261e;">
                ${escapeHtml(tone.intro)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 26px 8px 26px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${metricCell('Total', formatCount(payload.total), '#12261e')}
                  ${metricCell('Accepted', formatCount(payload.success), '#0A6B4E')}
                  ${metricCell('Failed', formatCount(payload.failed), payload.failed > 0 ? '#9b1c1c' : '#12261e')}
                  ${metricCell('Duplicates', formatCount(payload.duplicates), '#12261e')}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px 32px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#5b7168;margin-bottom:10px;">
                Batch details
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2ebe6;border-radius:8px;">
                ${detailRow('Module', label, true)}
                ${detailRow('Batch ID', payload.batchId, false)}
                ${detailRow('Status', tone.label, true)}
                ${detailRow('Acceptance rate', accepted, false)}
                ${detailRow('Execution time', duration, true)}
                ${detailRow('Completed', generatedAt, false)}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7faf8;border-left:3px solid #0A6B4E;border-radius:4px;">
                <tr>
                  <td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#3f564c;">
                    ${escapeHtml(note)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 8px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${payload.failed > 0 ? '#fff6e0' : '#e8f6ef'};border-radius:8px;">
                <tr>
                  <td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#12261e;">
                    <strong style="font-family:Arial,Helvetica,sans-serif;">${payload.failed > 0 ? 'Failure file' : 'No failures'}</strong><br>
                    ${escapeHtml(attachment)}
                    ${payload.failed > 0 ? `<div style="margin-top:6px;font-family:Consolas,Menlo,monospace;font-size:12px;color:#5b7168;">${escapeHtml(filename)}</div>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 28px 32px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#5b7168;">
                This is an internal operations report from the UPI batch platform. Please do not reply to this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#064e3b;padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#a7f3d0;">
              Zype &nbsp;·&nbsp; UPI Autopay &nbsp;·&nbsp; Confidential
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export type ProgressNoticeKind =
  | 'payment_paused'
  | 'payment_resumed'
  | 'peak_paused'
  | 'peak_resumed'
  | 'host_paused'
  | 'host_resumed';

export interface BatchProgressEmail {
  to: string;
  module: string;
  batchId: string;
  kind: ProgressNoticeKind;
  total: number;
  success: number;
  failed: number;
  remaining: number;
  /** HTTP cause, for example HTTP_502. */
  cause?: string;
  /** When a peak pause is scheduled to lift. */
  resumesAt?: string;
}

interface ProgressCopy {
  subjectEvent: string;
  badge: string;
  title: string;
  tone: StatusTone;
  intro: string;
  next: string;
}

function progressCopy(payload: BatchProgressEmail): ProgressCopy {
  const label = moduleLabel(payload.module);
  switch (payload.kind) {
    case 'payment_paused':
      return {
        subjectEvent: 'Paused — payment-service unavailable',
        badge: 'Service unavailable',
        title: `${label} is paused`,
        tone: {
          label: 'Paused',
          color: '#9b1c1c',
          background: '#fdecec',
          accent: '#9b1c1c',
          intro: '',
        },
        intro:
          'Payment-service stopped responding while this batch was running. Its health check is not UP, which covers a restart or an outage. Calls are held. Customers already accepted are unchanged, and waiting customers are not marked failed.',
        next: 'This notice is sent once for this outage. A separate email is sent when processing resumes. The completion report is sent when the batch finishes.',
      };
    case 'payment_resumed':
      return {
        subjectEvent: 'Resumed — payment-service is back',
        badge: 'Service available',
        title: `${label} has resumed`,
        tone: {
          label: 'Resumed',
          color: '#0f6b4c',
          background: '#e8f6ef',
          accent: '#0A6B4E',
          intro: '',
        },
        intro:
          'Payment-service is responding again. Calls for the customers still waiting have resumed automatically.',
        next: 'This notice is sent once for this recovery. The completion report is sent when the batch finishes.',
      };
    case 'peak_paused':
      return {
        subjectEvent: 'Paused — peak hours',
        badge: 'Peak hours',
        title: `${label} is paused for peak hours`,
        tone: {
          label: 'Peak hours',
          color: '#9a6700',
          background: '#fff6e0',
          accent: '#C2410C',
          intro: '',
        },
        intro:
          'New payment calls are held during the configured IST peak window. Work already accepted is unchanged. Remaining customers stay queued and are sent when the window ends.',
        next: 'This notice is sent once for this window. A separate email is sent when processing resumes.',
      };
    case 'peak_resumed':
      return {
        subjectEvent: 'Resumed — peak hours ended',
        badge: 'Processing resumed',
        title: `${label} has resumed`,
        tone: {
          label: 'Resumed',
          color: '#0f6b4c',
          background: '#e8f6ef',
          accent: '#0A6B4E',
          intro: '',
        },
        intro:
          'The peak window has ended. Calls have resumed for the customers still waiting.',
        next: 'This notice is sent once for this window. The completion report is sent when the batch finishes.',
      };
    case 'host_paused':
      return {
        subjectEvent: 'Paused — host under pressure',
        badge: 'Host pressure',
        title: `${label} is paused`,
        tone: {
          label: 'Paused',
          color: '#9a6700',
          background: '#fff6e0',
          accent: '#C2410C',
          intro: '',
        },
        intro:
          'New payment calls are held because the payment host is above its memory, disk, CPU, or event-loop limit. Customers already accepted are unchanged, and waiting customers are not marked failed.',
        next: 'This notice is sent once for this pause. Calls are checked again shortly and resume on their own when the host is back in range. A separate email is sent when processing resumes.',
      };
    case 'host_resumed':
      return {
        subjectEvent: 'Resumed — host pressure cleared',
        badge: 'Host recovered',
        title: `${label} has resumed`,
        tone: {
          label: 'Resumed',
          color: '#0f6b4c',
          background: '#e8f6ef',
          accent: '#0A6B4E',
          intro: '',
        },
        intro:
          'Memory, disk, CPU, and the payment-service event loop are back in range. Calls have resumed for the customers still waiting.',
        next: 'This notice is sent once for this recovery. The completion report is sent when the batch finishes.',
      };
  }
}

export function buildProgressMail(
  payload: BatchProgressEmail,
  now: Date = new Date(),
): CompletionMail {
  const label = moduleLabel(payload.module);
  const copy = progressCopy(payload);
  const generatedAt = formatIstTimestamp(now);
  const cause = payload.cause?.trim();
  const resumesAt = payload.resumesAt?.trim();
  const subject = `[UPI Batch] ${copy.subjectEvent} — ${label} #${payload.batchId}`;

  const lines = [
    'UPI Batch progress notice',
    '',
    `Module: ${label}`,
    `Batch ID: ${payload.batchId}`,
    `Event: ${copy.badge}`,
    `Total: ${payload.total}`,
    `Accepted: ${payload.success}`,
    `Failed: ${payload.failed}`,
    `Remaining: ${payload.remaining}`,
    ...(cause ? [`Signal: ${cause}`] : []),
    ...(resumesAt ? [`Resumes: ${resumesAt}`] : []),
    `Reported: ${generatedAt}`,
    '',
    copy.intro,
    '',
    copy.next,
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UPI Batch notice</title>
</head>
<body style="margin:0;padding:0;background-color:#eef3f0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef3f0;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background-color:#064e3b;padding:28px 32px 24px 32px;border-bottom:3px solid ${copy.tone.accent};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#a7f3d0;">
                    Zype &nbsp;·&nbsp; UPI Autopay
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:6px 12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${copy.tone.color};background-color:${copy.tone.background};border-radius:999px;">
                      ${escapeHtml(copy.badge)}
                    </span>
                  </td>
                </tr>
              </table>
              <div style="margin-top:18px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.25;color:#f7faf8;">
                ${escapeHtml(copy.title)}
              </div>
              <div style="margin-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d1fae5;">
                Batch #${escapeHtml(payload.batchId)} &nbsp;·&nbsp; ${escapeHtml(generatedAt)}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.55;color:#12261e;">
                ${escapeHtml(copy.intro)}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 26px 8px 26px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  ${metricCell('Total', formatCount(payload.total), '#12261e')}
                  ${metricCell('Accepted', formatCount(payload.success), '#0A6B4E')}
                  ${metricCell('Failed', formatCount(payload.failed), payload.failed > 0 ? '#9b1c1c' : '#12261e')}
                  ${metricCell('Remaining', formatCount(payload.remaining), '#12261e')}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px 32px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#5b7168;margin-bottom:10px;">
                Batch position
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2ebe6;border-radius:8px;">
                ${detailRow('Module', label, true)}
                ${detailRow('Batch ID', payload.batchId, false)}
                ${detailRow('Event', copy.badge, true)}
                ${cause ? detailRow('Signal', cause, false) : ''}
                ${resumesAt ? detailRow('Resumes', resumesAt, Boolean(cause)) : ''}
                ${detailRow('Reported', generatedAt, true)}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 8px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7faf8;border-left:3px solid ${copy.tone.accent};border-radius:4px;">
                <tr>
                  <td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#3f564c;">
                    ${escapeHtml(copy.next)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 28px 32px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#5b7168;">
                This is an internal operations notice from the UPI batch platform. It is sent once per pause, not once per customer. Please do not reply to this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#064e3b;padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#a7f3d0;">
              Zype &nbsp;·&nbsp; UPI Autopay &nbsp;·&nbsp; Confidential
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject,
    text: lines.join('\n'),
    html,
    attachments: [],
  };
}

export function buildCompletionMail(
  payload: BatchCompletionEmail,
  now: Date = new Date(),
): CompletionMail {
  const label = moduleLabel(payload.module);
  const tone = statusTone(payload.status);
  const duration = formatDuration(payload.executionTimeMs);
  const generatedAt = formatIstTimestamp(now);
  const filename = `batch_${payload.batchId}_failed.csv`;
  const note = successNote(payload.module);
  const attachment = attachmentNote(payload, filename);
  const subject = `[UPI Batch] ${payload.status} — ${label} #${payload.batchId}`;

  const lines = [
    'UPI Batch completion report',
    '',
    `Module: ${label}`,
    `Batch ID: ${payload.batchId}`,
    `Status: ${payload.status}`,
    `Total: ${payload.total}`,
    `Success: ${payload.success}`,
    `Failed: ${payload.failed}`,
    `Duplicates: ${payload.duplicates}`,
    `Execution time: ${duration}`,
    `Completed: ${generatedAt}`,
    '',
    note,
    '',
    attachment,
  ];

  const attachments =
    payload.failed > 0 && payload.failedCsv?.length
      ? [
          {
            filename,
            content: payload.failedCsv,
            contentType: 'text/csv',
          },
        ]
      : [];

  return {
    subject,
    text: lines.join('\n'),
    html: buildHtml({
      payload,
      label,
      tone,
      duration,
      generatedAt,
      filename,
      note,
      attachment,
    }),
    attachments,
  };
}

/** Same SMTP shape as loan-service `createSmtpTransport`. */
export function buildSmtpTransportOptions(input: {
  host: string;
  port: number;
  user: string;
  pass: string;
}): {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
} {
  return {
    host: input.host,
    port: input.port,
    secure: input.port === 465,
    auth: { user: input.user, pass: input.pass },
  };
}
