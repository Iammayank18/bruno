/**
 * Folds a script error into a script-run result so the failed run still shows
 * the pass/fail rows that ran before the error.
 */

const appendScriptErrorResult = (scriptType, scriptResult, error) => {
  if (!error) {
    return scriptResult;
  }

  const descriptionMap = {
    'test': 'Test Script Error',
    'post-response': 'Post-Response Script Error',
    'pre-request': 'Pre-Request Script Error'
  };

  const messageMap = {
    'test': 'An error occurred while executing the test script.',
    'post-response': 'An error occurred while executing the post-response script.',
    'pre-request': 'An error occurred while executing the pre-request script.'
  };

  const results = [
    ...(scriptResult?.results || []),
    {
      status: 'fail',
      description: descriptionMap[scriptType] || 'Script Error',
      error: error.message || messageMap[scriptType] || 'An error occurred while executing the script.',
      isScriptError: true
    }
  ];

  return {
    ...(scriptResult || {}),
    results
  };
};

module.exports = { appendScriptErrorResult };
