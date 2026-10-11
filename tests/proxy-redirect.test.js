const test = require('node:test');
const assert = require('node:assert/strict');

async function assertRedirectUsesGet(modulePath) {
  const previousUrl = process.env.APPS_SCRIPT_URL;
  const previousFetch = globalThis.fetch;
  const calls = [];
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://script.googleusercontent.com/macros/echo?key=test' }
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const { default: handler } = await import(modulePath + '?redirect-test=' + Date.now());
    const response = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
      send(value) { this.body = value; return this; }
    };

    await handler({
      method: 'POST',
      headers: {},
      body: { action: 'bootstrap' }
    }, response);

    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].body, undefined);
    assert.equal(response.statusCode, 200);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.APPS_SCRIPT_URL;
    else process.env.APPS_SCRIPT_URL = previousUrl;
  }
}

test('public proxy reads the JSON body from the Apps Script redirect with GET', async () => {
  await assertRedirectUsesGet('../api/proxy.js');
});

test('admin proxy reads the JSON body from the Apps Script redirect with GET', async () => {
  await assertRedirectUsesGet('../api/admin.js');
});