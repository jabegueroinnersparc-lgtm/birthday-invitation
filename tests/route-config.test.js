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
  assert.ok(config.routes.some((route) => route.handle === 'filesystem'), 'Missing filesystem handler before custom 404');
  assert.ok(config.routes.some((route) => route.src === '/.*' && route.status === 404 && route.dest === '/404.html'), 'Missing custom 404 route');
});

test('a catch-all API route exists to avoid raw API 404s', () => {
  const catchAllPath = path.join(projectRoot, 'api', '[...slug].js');
  assert.ok(fs.existsSync(catchAllPath), 'Missing catch-all API route file');
});

test('Cloudflare Pages has static hosting and API function routes', () => {
  const config = fs.readFileSync(path.join(projectRoot, 'wrangler.toml'), 'utf8');
  const functionFiles = [
    'functions/api/proxy.js',
    'functions/api/admin.js',
    'functions/api/[[path]].js',
    'functions/_shared.js'
  ];

  assert.match(config, /pages_build_output_dir\s*=\s*"\."/);
  assert.ok(fs.existsSync(path.join(projectRoot, 'admin.html')), 'Missing admin page for Cloudflare clean URLs');
  for (const file of functionFiles) {
    assert.ok(fs.existsSync(path.join(projectRoot, file)), `Missing Cloudflare Pages file: ${file}`);
  }
});

test('countdown and event metadata use the same event start instant', () => {
  const page = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const schemaStart = page.match(/"startDate":\s*"([^"]+)"/);
  const countdownStart = page.match(/const EVENT_DATE = new Date\('([^']+)'\)/);

  assert.ok(schemaStart, 'Missing structured event start date');
  assert.ok(countdownStart, 'Missing countdown start date');
  assert.equal(new Date(countdownStart[1]).toISOString(), new Date(schemaStart[1]).toISOString());
});

test('API timeout messages do not blame video uploads for unrelated requests', () => {
  const page = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  assert.match(page, /res\.status === 502 \|\| res\.status === 504\) throw new Error\('The server took too long to respond\. Please try again in a moment\.'\)/);
  assert.doesNotMatch(page, /res\.status === 502 \|\| res\.status === 504\)[^\n]*shorter video/i);
});
