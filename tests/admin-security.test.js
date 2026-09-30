const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createBackend() {
  const cacheValues = new Map();
  const context = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: (key) => cacheValues.get(key) || null,
        put: (key, value) => cacheValues.set(key, value)
      })
    },
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => 'test-password' })
    },
    Utilities: { getUuid: () => 'test-session-token' }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  return context;
}

test('admin operations reject requests without a valid session token', () => {
  const backend = createBackend();
  const denied = [
    backend.getAdminAttendees(),
    backend.updateAttendee({}),
    backend.deleteAttendee(2),
    backend.verifyTicket('ticket-code'),
    backend.checkInTicket('ticket-code')
  ];

  for (const result of denied) {
    assert.equal(result.success, false);
    assert.match(result.message, /session expired/i);
  }
});

test('admin login issues a session accepted by the protected API', () => {
  const backend = createBackend();
  const result = backend.adminLogin('test-password');

  assert.equal(result.success, true);
  assert.equal(result.token, 'test-session-token');
  assert.equal(backend.isAdminSessionValid(result.token), true);
  assert.equal(backend.isAdminSessionValid('invalid-token'), false);
});