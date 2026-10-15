const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createBackend() {
  const sheets = new Map();
  const cacheValues = new Map();
  const spreadsheet = {
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => {
      const rows = [];
      const sheet = {
        appendRow: row => rows.push(row),
        getLastRow: () => rows.length,
        getRange: (startRow, startColumn, rowCount, columnCount) => ({
          getValues: () => Array.from({ length: rowCount }, (_, rowOffset) =>
            Array.from({ length: columnCount }, (_, columnOffset) =>
              ((rows[startRow + rowOffset - 1] || [])[startColumn + columnOffset - 1] ?? '')
            )
          ),
          setValues: values => values.forEach((row, rowOffset) => {
            rows[startRow + rowOffset - 1] = row.slice();
          })
        })
      };
      sheets.set(name, sheet);
      return sheet;
    }
  };
  const context = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: key => cacheValues.get(key) || null,
        put: (key, value) => cacheValues.set(key, value),
        remove: key => cacheValues.delete(key),
        removeAll: keys => keys.forEach(key => cacheValues.delete(key))
      })
    },
    Logger: { log: () => {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => 'test-password' })
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    Utilities: {
      getUuid: () => 'test-admin-token',
      computeDigest: () => []
    }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  context.allowRateLimit = () => true;
  context.findWhitelistAccount = () => ({
    name: 'Alice Example',
    email: '',
    mobile: '09171234567'
  });
  context.findWhitelistMobile = () => ({
    name: 'Alice Example',
    email: '',
    mobile: '09171234567'
  });
  return context;
}

test('successful guest sign-ins are recorded and history is admin-protected', () => {
  const backend = createBackend();

  assert.equal(backend.simpleLogin('Alice Example', '09171234567').success, true);
  assert.equal(backend.loginByMobile('09171234567').success, true);

  const denied = backend.getAdminLoginHistory('invalid-token');
  assert.equal(denied.success, false);
  assert.match(denied.message, /session expired/i);

  const adminLogin = backend.adminLogin('test-password');
  assert.equal(adminLogin.success, true);
  const result = backend.getAdminLoginHistory(adminLogin.token);
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.entries)).map(entry => [
    entry.name,
    entry.mobile,
    entry.method,
    entry.status
  ]), [
    ['Alice Example', '09171234567', 'loginByMobile', 'success'],
    ['Alice Example', '09171234567', 'simpleLogin', 'existing']
  ]);
});
