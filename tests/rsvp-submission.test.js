const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

test('a duplicate RSVP returns the ticket created by the earlier submission', () => {
  const savedTicket = {
    code: 'SJG-ABC234',
    qrCodeUrl: 'https://example.test/qr',
    name: 'Guest Name',
    guests: 2,
    qrData: 'ticket-data',
    attendance: 'going'
  };
  const context = vm.createContext({
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => '' }) },
    Utilities: { getUuid: () => 'test-session-token' }
  });

  vm.runInContext(source, context, { filename: 'Code.gs' });
  context.getSettings = () => ({});
  context.findWhitelistAccount = () => ({ name: 'Guest Name', mobile: '09123456789' });
  context.findResponseByName = () => ({ row: 2, name: 'Guest Name', code: savedTicket.code });
  context.checkExistingRSVP = () => ({ success: true, ticket: savedTicket });

  const result = context.submitForm({
    name: 'Guest Name',
    mobile: '09123456789',
    address: 'Sample address',
    greetings: 'Happy birthday',
    attendance: 'going',
    selfie: { data: 'data:image/jpeg;base64,AA==' },
    guests: 2
  });

  assert.equal(result.success, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.ticket.code, savedTicket.code);
  assert.equal(result.ticket.qrData, savedTicket.qrData);
});