const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const pageSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const apiStart = pageSource.indexOf('const RETRYABLE_API_ACTIONS');
const apiEnd = pageSource.indexOf('/* STATE */', apiStart);
const apiSource = pageSource.slice(apiStart, apiEnd);

function createApi(fetch) {
  const context = vm.createContext({
    APPS_SCRIPT_URL: '/api/proxy',
    AbortController,
    clearTimeout,
    fetch,
    setTimeout
  });
  vm.runInContext(apiSource, context, { filename: 'index.html API client' });
  return context.api;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload)
  };
}

test('read-only API requests retry once after a network timeout', async () => {
  let calls = 0;
  const api = createApi(async () => {
    calls++;
    if (calls === 1) {
      const error = new Error('request timed out');
      error.name = 'AbortError';
      throw error;
    }
    return jsonResponse({ success: true });
  });

  const result = await api('getAllAttendees');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true });
  assert.equal(calls, 2);
});

test('write API requests are not retried after a timeout', async () => {
  let calls = 0;
  const api = createApi(async () => {
    calls++;
    const error = new Error('request timed out');
    error.name = 'AbortError';
    throw error;
  });

  await assert.rejects(api('reactToWallOfLove', { rowIndex: 2, delta: 1 }), /taking longer than expected/i);
  assert.equal(calls, 1);
});

test('API request timeout remains active until the response body is read', () => {
  assert.match(apiSource, /const text = await res\.text\(\);[\s\S]*?finally\s*\{\s*clearTimeout\(timeoutId\);\s*\}/);
  assert.doesNotMatch(apiSource, /await fetch\(APPS_SCRIPT_URL,[\s\S]*?clearTimeout\(timeoutId\);\s*const text = await res\.text\(\)/);
});
