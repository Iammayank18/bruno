import { createTestDatabase } from '../utils';
import type { TestDatabase } from '../utils';

describe('scheduled_runs statements', () => {
  let database: TestDatabase;
  let execute: (name: string, params?: Record<string, unknown>) => any;

  const insertRun = (scheduleId: string, startedAt: number): number => {
    const result = execute('insert_scheduled_run', {
      schedule_id: scheduleId,
      schedule_name: 'Nightly',
      collection_path: '/collections/api',
      trigger_type: 'schedule',
      started_at: startedAt
    });
    return Number(result.lastInsertRowid);
  };

  const insertRequest = (runId: number) =>
    execute('insert_scheduled_run_request', {
      run_id: runId,
      request_name: 'Get users',
      request_path: 'users/get.bru',
      status: 'pass',
      status_code: 200,
      duration: 12,
      error_message: null,
      request_method: 'GET',
      request_url: 'https://example.com/users',
      request_headers: null,
      request_body: null,
      response_headers: null,
      response_body: null,
      test_results: null,
      assertion_results: null
    });

  beforeEach(() => {
    database = createTestDatabase();
    execute = (name, params = {}) => database.statements!.execute(name as any, params as any);
  });

  afterEach(() => database.cleanup());

  it('records a run as running and finishes it with its counts', () => {
    const id = insertRun('s1', 1000);
    expect(execute('list_running_scheduled_runs')).toEqual([{ id }]);

    execute('finish_scheduled_run', {
      id,
      finished_at: 2000,
      duration: 1000,
      status: 'fail',
      total_requests: 3,
      passed_requests: 1,
      failed_requests: 1,
      error_requests: 1,
      skipped_requests: 0,
      message: null
    });

    expect(execute('list_running_scheduled_runs')).toEqual([]);
    expect(execute('list_scheduled_runs_for_schedule', { schedule_id: 's1', limit: 10 })[0]).toMatchObject({
      status: 'fail',
      total_requests: 3,
      failed_requests: 1,
      error_requests: 1
    });
  });

  it('lists a schedule\'s runs newest first, up to the limit', () => {
    insertRun('s1', 1000);
    insertRun('s1', 3000);
    insertRun('s1', 2000);
    insertRun('s2', 4000);

    const runs = execute('list_scheduled_runs_for_schedule', { schedule_id: 's1', limit: 2 });
    expect(runs.map((run: any) => run.started_at)).toEqual([3000, 2000]);
  });

  it('prunes all but the newest runs and their request rows', () => {
    const oldest = insertRun('s1', 1000);
    insertRequest(oldest);
    insertRun('s1', 2000);
    const newest = insertRun('s1', 3000);
    insertRequest(newest);
    insertRun('s2', 500);

    execute('prune_scheduled_runs_keep', { schedule_id: 's1', keep: 2 });

    expect(execute('list_scheduled_runs_for_schedule', { schedule_id: 's1', limit: 10 })).toHaveLength(2);
    expect(execute('list_scheduled_run_requests', { run_id: oldest })).toEqual([]);
    expect(execute('list_scheduled_run_requests', { run_id: newest })).toHaveLength(1);
    expect(execute('list_scheduled_runs_for_schedule', { schedule_id: 's2', limit: 10 })).toHaveLength(1);
  });

  it('deletes a schedule\'s history including its request rows', () => {
    const id = insertRun('s1', 1000);
    insertRequest(id);

    execute('delete_scheduled_runs_for_schedule', { schedule_id: 's1' });

    expect(execute('list_scheduled_runs_for_schedule', { schedule_id: 's1', limit: 10 })).toEqual([]);
    expect(execute('list_scheduled_run_requests', { run_id: id })).toEqual([]);
  });
});
