-- name: insert_scheduled_run :exec
INSERT INTO scheduled_runs (
  schedule_id, schedule_name, collection_path, trigger_type, started_at, status
) VALUES (
  @schedule_id, @schedule_name, @collection_path, @trigger_type, @started_at, 'running'
);

-- name: finish_scheduled_run :exec
UPDATE scheduled_runs SET
  finished_at = @finished_at,
  duration = @duration,
  status = @status,
  total_requests = @total_requests,
  passed_requests = @passed_requests,
  failed_requests = @failed_requests,
  error_requests = @error_requests,
  skipped_requests = @skipped_requests,
  message = @message,
  updated_at = unixepoch()
WHERE id = @id;

-- name: insert_scheduled_run_request :exec
INSERT INTO scheduled_run_requests (
  run_id, request_name, request_path, status, status_code, duration, error_message,
  request_method, request_url, request_headers, request_body, response_headers, response_body,
  test_results, assertion_results
) VALUES (
  @run_id, @request_name, @request_path, @status, @status_code, @duration, @error_message,
  @request_method, @request_url, @request_headers, @request_body, @response_headers, @response_body,
  @test_results, @assertion_results
);

-- name: list_scheduled_runs_for_schedule :many
SELECT * FROM scheduled_runs
WHERE schedule_id = @schedule_id
ORDER BY started_at DESC
LIMIT @limit;

-- name: list_scheduled_run_requests :many
SELECT * FROM scheduled_run_requests WHERE run_id = @run_id ORDER BY id;

-- name: delete_scheduled_runs_for_schedule :exec
DELETE FROM scheduled_runs WHERE schedule_id = @schedule_id;

-- name: list_running_scheduled_runs :many
SELECT id FROM scheduled_runs WHERE status = 'running';

-- name: prune_scheduled_runs_keep :exec
DELETE FROM scheduled_runs
WHERE schedule_id = @schedule_id
  AND id NOT IN (
    SELECT id FROM scheduled_runs WHERE schedule_id = @schedule_id ORDER BY started_at DESC LIMIT @keep
  );
