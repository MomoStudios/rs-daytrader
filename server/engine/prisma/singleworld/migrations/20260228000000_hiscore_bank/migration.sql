-- CreateTable
CREATE TABLE "hiscore_bank" (
    "profile" TEXT NOT NULL DEFAULT 'main',
    "account_id" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,
    "items" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profile", "account_id")
);
