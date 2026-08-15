-- CreateTable
CREATE TABLE `hiscore_outfit` (
    `account_id` INTEGER NOT NULL,
    `profile` VARCHAR(191) NOT NULL DEFAULT 'main',
    `value` INTEGER NOT NULL,
    `items` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`account_id`, `profile`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
