-- Invoice generation is anchored to the IST day the batch starts.
-- A later createInvoice call would cancel the previous day's unpaid invoices.
ALTER TABLE `batch_execution` ADD COLUMN `processing_day` VARCHAR(10) NULL;
