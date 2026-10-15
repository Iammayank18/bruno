export const up = (): string => {
  return `
    CREATE TABLE scheduled_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      schedule_name TEXT NOT NULL,
      collection_path TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration INTEGER,
      status TEXT,
      total_requests INTEGER NOT NULL DEFAULT 0,
      passed_requests INTEGER NOT NULL DEFAULT 0,
      failed_requests INTEGER NOT NULL DEFAULT 0,
      error_requests INTEGER NOT NULL DEFAULT 0,
      skipped_requests INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_scheduled_runs_schedule_started ON scheduled_runs (schedule_id, started_at DESC);
    CREATE INDEX idx_scheduled_runs_status ON scheduled_runs (status);

    CREATE TABLE scheduled_run_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES scheduled_runs(id) ON DELETE CASCADE,
      request_name TEXT,
      request_path TEXT,
      status TEXT,
      status_code INTEGER,
      duration INTEGER,
      error_message TEXT,
      request_method TEXT,
      request_url TEXT,
      request_headers TEXT,
      request_body TEXT,
      response_headers TEXT,
      response_body TEXT,
      test_results TEXT,
      assertion_results TEXT
    );
    CREATE INDEX idx_scheduled_run_requests_run ON scheduled_run_requests (run_id);
  `;
};

export const down = (): string => {
  return `
    DROP TABLE IF EXISTS scheduled_run_requests;
    DROP TABLE IF EXISTS scheduled_runs;
  `;
};
