-- History is listed by module, newest first.
CREATE INDEX `batch_execution_module_uploadedAt_idx` ON `batch_execution`(`module`, `uploadedAt`);

-- Item pages and keyset scans. (batchId, status, id) also covers status counts.
CREATE INDEX `batch_execution_items_batchId_id_idx` ON `batch_execution_items`(`batchId`, `id`);
CREATE INDEX `batch_execution_items_batchId_status_id_idx` ON `batch_execution_items`(`batchId`, `status`, `id`);
DROP INDEX `batch_execution_items_batchId_status_idx` ON `batch_execution_items`;

-- Call logs are read by batch, not by joining every item.
ALTER TABLE `batch_execution_logs` ADD COLUMN `batchId` BIGINT NULL;

UPDATE `batch_execution_logs` AS log_row
INNER JOIN `batch_execution_items` AS item_row ON item_row.`id` = log_row.`batchItemId`
SET log_row.`batchId` = item_row.`batchId`
WHERE log_row.`batchId` IS NULL;

DELETE FROM `batch_execution_logs` WHERE `batchId` IS NULL;

ALTER TABLE `batch_execution_logs` MODIFY `batchId` BIGINT NOT NULL;

CREATE INDEX `batch_execution_logs_batchId_createdAt_idx` ON `batch_execution_logs`(`batchId`, `createdAt`);

ALTER TABLE `batch_execution_logs`
  ADD CONSTRAINT `batch_execution_logs_batchId_fkey`
  FOREIGN KEY (`batchId`) REFERENCES `batch_execution`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
