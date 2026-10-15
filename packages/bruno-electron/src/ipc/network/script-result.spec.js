const { appendScriptErrorResult } = require('./script-result');

describe('appendScriptErrorResult', () => {
  it('returns the script result untouched when there is no error', () => {
    const scriptResult = { results: [{ status: 'pass', description: 'ok' }] };
    expect(appendScriptErrorResult('test', scriptResult, null)).toBe(scriptResult);
  });

  it('keeps the rows that ran before the error and appends a failing row', () => {
    const scriptResult = { nextRequestName: 'B', results: [{ status: 'pass', description: 'first' }] };
    const out = appendScriptErrorResult('post-response', scriptResult, new Error('boom'));

    expect(out.nextRequestName).toBe('B');
    expect(out.results).toEqual([
      { status: 'pass', description: 'first' },
      { status: 'fail', description: 'Post-Response Script Error', error: 'boom', isScriptError: true }
    ]);
    // input is not mutated
    expect(scriptResult.results).toHaveLength(1);
  });

  it('builds a result from scratch when the script produced none', () => {
    const out = appendScriptErrorResult('pre-request', undefined, new Error('bad'));
    expect(out).toEqual({
      results: [{ status: 'fail', description: 'Pre-Request Script Error', error: 'bad', isScriptError: true }]
    });
  });

  it('falls back to the per-type message when the error has no message', () => {
    const out = appendScriptErrorResult('test', {}, {});
    expect(out.results[0]).toMatchObject({
      description: 'Test Script Error',
      error: 'An error occurred while executing the test script.'
    });
  });

  it('uses generic labels for an unknown script type', () => {
    const out = appendScriptErrorResult('other', {}, {});
    expect(out.results[0]).toMatchObject({
      description: 'Script Error',
      error: 'An error occurred while executing the script.'
    });
  });
});
