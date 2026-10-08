import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { REQUIRED_HEADERS } from '../../../common/constants/index.js';
import { ValidationError } from '../../../common/exceptions/app-error.js';
import type { InvalidRow, ParsedRow, ValidationResult } from '../dto/types.js';

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, '_');
}

function validateAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

async function parseXlsx(buffer: Buffer): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs types expect Buffer-like; cast for Node Buffer
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, col) => {
    headers[col - 1] = normalizeHeader(String(cell.value ?? ''));
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      const cell = row.getCell(idx + 1).value;
      obj[h] = cell === null || cell === undefined ? '' : String(cell);
    });
    rows.push(obj);
  });
  return rows;
}

function parseCsv(buffer: Buffer): Record<string, string>[] {
  const records = parse(buffer, {
    columns: (headers: string[]) => headers.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];
  return records;
}

export async function validateUploadFile(
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<ValidationResult> {
  const lower = filename.toLowerCase();
  const isCsv = lower.endsWith('.csv') || contentType.includes('csv');
  const isXlsx =
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    contentType.includes('spreadsheet') ||
    contentType.includes('excel');

  if (!isCsv && !isXlsx) {
    throw new ValidationError('Only CSV or XLSX files are supported');
  }

  if (!buffer.length) {
    throw new ValidationError('Empty file');
  }

  let rawRows: Record<string, string>[];
  try {
    rawRows = isCsv ? parseCsv(buffer) : await parseXlsx(buffer);
  } catch (err) {
    throw new ValidationError('Failed to parse file', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (!rawRows.length) {
    throw new ValidationError('Empty file — no data rows found');
  }

  const headers = Object.keys(rawRows[0] ?? {});
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new ValidationError(`Invalid headers. Required: ${REQUIRED_HEADERS.join(', ')}`, {
      missing,
      found: headers,
    });
  }

  const validRows: ParsedRow[] = [];
  const invalidRows: InvalidRow[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  rawRows.forEach((row, idx) => {
    const rowNumber = idx + 2; // header is row 1
    const customerId = String(row.customer_id ?? '').trim();
    const amountRaw = row.final_nach_amount;
    const amount = validateAmount(amountRaw);

    if (!customerId) {
      invalidRows.push({
        rowNumber,
        amount: amountRaw,
        reason: 'Missing customer ID',
      });
      return;
    }

    if (amount === null) {
      invalidRows.push({
        rowNumber,
        customerId,
        amount: String(amountRaw ?? ''),
        reason: 'Invalid amount',
      });
      return;
    }

    if (seen.has(customerId)) {
      duplicates.push(customerId);
      return;
    }

    seen.add(customerId);
    validRows.push({ customerId, amount, rowNumber });
  });

  return {
    totalRecords: rawRows.length,
    validRecords: validRows.length,
    duplicateCount: duplicates.length,
    invalidCount: invalidRows.length,
    duplicates: [...new Set(duplicates)],
    invalidRows,
    validRows,
    originalFilename: filename,
    contentType: isCsv ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    originalBuffer: buffer,
  };
}
