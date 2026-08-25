-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'artifact',
    "missionId" TEXT,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Document_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("authorRole", "content", "createdAt", "id", "missionId", "taskId", "title", "updatedAt") SELECT "authorRole", "content", "createdAt", "id", "missionId", "taskId", "title", "updatedAt" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE INDEX "Document_missionId_idx" ON "Document"("missionId");
CREATE INDEX "Document_taskId_idx" ON "Document"("taskId");
CREATE INDEX "Document_kind_idx" ON "Document"("kind");
CREATE INDEX "Document_updatedAt_idx" ON "Document"("updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
