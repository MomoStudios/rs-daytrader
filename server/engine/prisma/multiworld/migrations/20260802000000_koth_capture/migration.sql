-- CreateTable
CREATE TABLE `koth_capture` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `timestamp` DATETIME(3) NOT NULL,
    `profile` VARCHAR(191) NOT NULL DEFAULT 'main',
    `username` VARCHAR(191) NOT NULL,
    `combat_level` INTEGER NOT NULL,
    `contenders` INTEGER NOT NULL,
    `loadout` TEXT NOT NULL,

    INDEX `koth_capture_username_timestamp_idx`(`username`, `timestamp`),
    INDEX `koth_capture_timestamp_idx`(`timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
