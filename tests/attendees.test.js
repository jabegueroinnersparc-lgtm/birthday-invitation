const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createBackend(sheet, cachedAttendees) {
  const cacheValues = new Map();
  if (cachedAttendees) cacheValues.set('birthday_attendees_v1', JSON.stringify(cachedAttendees));

  const context = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: key => cacheValues.get(key) || null,
        put: (key, value) => cacheValues.set(key, value)
      })
    },
    Logger: { log: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: name => name === 'Responses' ? sheet : null
      })
    }
  });

  vm.runInContext(source, context, { filename: 'Code.gs' });
  return context;
}

test('attendee reads return current response rows when bypassing cache', () => {
  const columns = {
    2: [['Alice Example'], ['Bob Guest']],
    8: [[2], [1]],
    12: [['going'], ['not_going']]
  };
  const sheet = {
    getLastRow: () => 3,
    getRange: (row, column, count) => ({
      getValues: () => columns[column].slice(row - 2, row - 2 + count)
    })
  };
  const backend = createBackend(sheet, {
    success: true,
    attendees: [{ name: 'Stale Name', guests: 1, attendance: 'going' }],
    totalGuests: 1,
    totalParties: 1
  });

  const result = backend.getAllAttendees(true);

  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.attendees)), [
    { name: 'Bob G.', guests: 1, attendance: 'not_going' },
    { name: 'Alice E.', guests: 2, attendance: 'going' }
  ]);
  assert.equal(result.totalGuests, 2);
  assert.equal(result.totalParties, 2);
});

test('a missing Responses sheet is reported as an error, not an empty attendee list', () => {
  const backend = createBackend(null);

  const result = backend.getAllAttendees();

  assert.equal(result.success, false);
  assert.match(result.message, /Responses sheet was not found/i);
});