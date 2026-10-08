import type { BatchModule } from '@prisma/client';

export interface ParsedRow {
  customerId: string;
  amount: number;
  rowNumber: number;
}

export interface InvalidRow {
  rowNumber: number;
  customerId?: string;
  amount?: string;
  reason: string;
}

export interface ValidationResult {
  totalRecords: number;
  validRecords: number;
  duplicateCount: number;
  invalidCount: number;
  duplicates: string[];
  invalidRows: InvalidRow[];
  validRows: ParsedRow[];
  originalFilename: string;
  contentType: string;
  originalBuffer: Buffer;
}

export interface ConfirmUploadInput {
  module: BatchModule;
  uploadedBy: string;
  validation: ValidationResult;
}

export type DownloadType = 'original' | 'processed' | 'failed' | 'success';
