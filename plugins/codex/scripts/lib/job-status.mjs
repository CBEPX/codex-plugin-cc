// A job is active ("queued" or "running") while a worker may still write it.
export function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

// A stored record that no worker will write again; null/undefined is not terminal.
export function isTerminalRecord(record) {
  return Boolean(record) && !isActiveJobStatus(record.status);
}
