-- AlterTable
ALTER TABLE "hiscore" ADD COLUMN "playtime" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "hiscore_large" ADD COLUMN "playtime" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "hiscore_outfit" (
    "profile" TEXT NOT NULL DEFAULT 'main',
    "account_id" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "items" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profile", "account_id")
);
