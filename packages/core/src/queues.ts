/** Every pg-boss queue LUME uses. The migrate step creates these as lume_owner (pg-boss partitions need the table owner). */
export const QUEUE_NAMES = ["ops.backup", "ops.restore-test"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
