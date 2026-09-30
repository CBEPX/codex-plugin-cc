// Job status vocabulary. A job is active while a worker may still write it.
export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

export function isActiveJobStatus(status) {
  return status === JOB_STATUS.QUEUED || status === JOB_STATUS.RUNNING;
}

// A stored record that no worker will write again; null/undefined is not terminal.
export function isTerminalRecord(record) {
  return Boolean(record) && !isActiveJobStatus(record.status);
}
