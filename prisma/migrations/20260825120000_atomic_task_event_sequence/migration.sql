-- Existing event sequences came from provider-local stream IDs and application
-- constants, so normalize them before enforcing one durable per-task sequence.
WITH "ranked_events" AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "taskId"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS "newSeq"
    FROM "TaskEvent"
)
UPDATE "TaskEvent"
SET "seq" = (
    SELECT "newSeq"
    FROM "ranked_events"
    WHERE "ranked_events"."id" = "TaskEvent"."id"
);

UPDATE "Task"
SET "lastSeq" = COALESCE(
    (SELECT MAX("seq") FROM "TaskEvent" WHERE "TaskEvent"."taskId" = "Task"."id"),
    0
);

DROP INDEX "TaskEvent_taskId_seq_idx";
CREATE UNIQUE INDEX "TaskEvent_taskId_seq_key" ON "TaskEvent"("taskId", "seq");
