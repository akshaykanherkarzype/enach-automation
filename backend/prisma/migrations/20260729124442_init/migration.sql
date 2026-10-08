-- CreateTable
CREATE TABLE `batch_execution` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `module` ENUM('INVOICE_GENERATION', 'INVOICE_CHARGE') NOT NULL,
    `status` ENUM('UPLOADED', 'VALIDATING', 'READY', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'UPLOADED',
    `uploadedBy` VARCHAR(255) NOT NULL,
    `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `totalRecords` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `duplicateCount` INTEGER NOT NULL DEFAULT 0,
    `processingCount` INTEGER NOT NULL DEFAULT 0,
    `originalFile` VARCHAR(1024) NULL,
    `processedFile` VARCHAR(1024) NULL,
    `failureReport` VARCHAR(1024) NULL,
    `successReport` VARCHAR(1024) NULL,
    `remarks` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `batch_execution_module_status_idx`(`module`, `status`),
    INDEX `batch_execution_uploadedAt_idx`(`uploadedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `batch_execution_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `batchId` BIGINT NOT NULL,
    `customerId` VARCHAR(64) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'RETRYING') NOT NULL DEFAULT 'PENDING',
    `retryCount` INTEGER NOT NULL DEFAULT 0,
    `failureReason` TEXT NULL,
    `responseCode` VARCHAR(64) NULL,
    `responseBody` TEXT NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `batch_execution_items_idempotencyKey_key`(`idempotencyKey`),
    INDEX `batch_execution_items_batchId_status_idx`(`batchId`, `status`),
    INDEX `batch_execution_items_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `batch_execution_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `batchItemId` BIGINT NOT NULL,
    `apiName` VARCHAR(128) NOT NULL,
    `request` TEXT NULL,
    `response` TEXT NULL,
    `statusCode` INTEGER NULL,
    `latency` INTEGER NULL,
    `retryNo` INTEGER NOT NULL DEFAULT 0,
    `traceId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `batch_execution_logs_batchItemId_idx`(`batchItemId`),
    INDEX `batch_execution_logs_traceId_idx`(`traceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `action` VARCHAR(64) NOT NULL,
    `entityType` VARCHAR(64) NOT NULL,
    `entityId` VARCHAR(64) NULL,
    `actor` VARCHAR(255) NOT NULL,
    `details` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `batch_execution_items` ADD CONSTRAINT `batch_execution_items_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `batch_execution`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `batch_execution_logs` ADD CONSTRAINT `batch_execution_logs_batchItemId_fkey` FOREIGN KEY (`batchItemId`) REFERENCES `batch_execution_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
