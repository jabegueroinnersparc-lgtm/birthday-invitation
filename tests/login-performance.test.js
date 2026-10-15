const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createBackend() {
  let lockWaits = 0;
  const context = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: () => null,
        put: () => {},
        remove: () => {},
        removeAll: () => {}
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { lockWaits++; },
        releaseLock: () => {}
      })
    },
    Logger: { log: () => {} }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  context.getLockWaits = () => lockWaits;
  return context;
}

test('returning guest login defers the RSVP lookup until after sign-in', () => {
  const backend = createBackend();
  backend.allowRateLimit = () => true;
  backend.findWhitelistAccount = () => ({
    name: 'Alice Example',
    email: '',
    mobile: '09171234567'
  });
  backend.checkExistingRSVP = () => {
    throw new Error('RSVP lookup should not block login');
  };

  const result = backend.simpleLogin('Alice Example', '09171234567');

  assert.equal(result.success, true);
  assert.equal(result.user.name, 'Alice Example');
  assert.equal(result.ticket, null);
  assert.equal(backend.getLockWaits(), 0, 'Existing account login should not wait for the shared script lock');
});

test('mobile account recovery defers the RSVP lookup until after sign-in', () => {
  const backend = createBackend();
  backend.allowRateLimit = () => true;
  backend.findWhitelistMobile = () => ({
    name: 'Alice Example',
    email: '',
    mobile: '09171234567'
  });
  backend.checkExistingRSVP = () => {
    throw new Error('RSVP lookup should not block login');
  };

  const result = backend.loginByMobile('09171234567');

  assert.equal(result.success, true);
  assert.equal(result.user.name, 'Alice Example');
  assert.equal(result.ticket, null);
});

test('Wall of Love reads do not rewrite an already-correct sheet header', () => {
  const backend = createBackend();
  const headers = ['Timestamp', 'Name', 'Message', 'Avatar URL', 'Hearts'];
  let headerWrites = 0;
  const sheet = {
    getLastRow: () => 2,
    getRange: () => ({
      getValues: () => [headers],
      setValues: () => { headerWrites++; }
    })
  };
  backend.getSheet = () => sheet;

  assert.equal(backend.getWallOfLoveSheet(), sheet);
  assert.equal(headerWrites, 0);
});

test('mobile recovery reads only mobile numbers and caches a matching account', () => {
  const cacheValues = new Map();
  const rangesRead = [];
  const sheet = {
    getLastRow: () => 3,
    getRange: (row, column, count, width) => {
      rangesRead.push([row, column, count, width]);
      return {
        getValues: () => {
          if (row === 2 && column === 3) return [['09123456789'], ['09933481102']];
          if (row === 3 && column === 1) return [['alice@example.test', 'Alice Example']];
          throw new Error('Unexpected whitelist range read');
        }
      };
    }
  };
  const backend = vm.createContext({
    CacheService: {
      getScriptCache: () => ({
        get: key => cacheValues.get(key) || null,
        put: (key, value) => cacheValues.set(key, value)
      })
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: () => sheet })
    },
    Logger: { log: () => {} }
  });
  vm.runInContext(source, backend, { filename: 'Code.gs' });

  const first = backend.findWhitelistMobile('09933481102');
  const second = backend.findWhitelistMobile('09933481102');

  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    row: 3,
    email: 'alice@example.test',
    name: 'Alice Example',
    mobile: '09933481102'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  assert.deepEqual(rangesRead, [[2, 3, 2, 1], [3, 1, 1, 2]]);
});
