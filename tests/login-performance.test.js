const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function createBackend() {
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
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },
    Logger: { log: () => {} }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
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
