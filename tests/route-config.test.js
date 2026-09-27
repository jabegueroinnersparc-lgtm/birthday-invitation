const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectRoot = path.join(__dirname, '..');

test('vercel config includes the admin route and custom 404 fallback', () => {
  const configPath = path.join(projectRoot, 'vercel.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.ok(Array.isArray(config.routes), 'Expected routes array in vercel.json');
  assert.ok(config.routes.some((route) => route.src === '/admin' && route.dest === '/admin.html'), 'Missing /admin rewrite');
  assert.ok(config.routes.some((route) => route.src === '/.*' && route.status === 404 && route.dest === '/404.html'), 'Missing custom 404 route');
});

test('a catch-all API route exists to avoid raw API 404s', () => {
  const catchAllPath = path.join(projectRoot, 'api', '[...slug].js');
  assert.ok(fs.existsSync(catchAllPath), 'Missing catch-all API route file');
});
