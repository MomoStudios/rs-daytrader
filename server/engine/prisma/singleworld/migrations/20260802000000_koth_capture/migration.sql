-- CreateTable
CREATE TABLE "koth_capture" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "username" TEXT NOT NULL,
    "combat_level" INTEGER NOT NULL,
    "contenders" INTEGER NOT NULL,
    "loadout" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "koth_capture_username_timestamp_idx" ON "koth_capture"("username", "timestamp");

-- CreateIndex
CREATE INDEX "koth_capture_timestamp_idx" ON "koth_capture"("timestamp");
