import { jsonResponse, looksLikeHtml, postToAppsScript, validAppsScriptUrl } from '../_shared.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization'
};
const UPSTREAM_TIMEOUT_MS = 55000;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return jsonResponse({ success: false, message: 'Method Not Allowed' }, 405, CORS_HEADERS);

  const target = env.APPS_SCRIPT_URL;
  if (!target) {
    return jsonResponse({ success: false, message: 'APPS_SCRIPT_URL is not configured in Cloudflare Pages.' }, 500, CORS_HEADERS);
  }
  if (!validAppsScriptUrl(target)) {
    return jsonResponse({ success: false, message: 'APPS_SCRIPT_URL must be the deployed https://script.google.com/macros/s/.../exec URL.' }, 500, CORS_HEADERS);
  }

  try {
    const body = await request.text();
    if (!body) return jsonResponse({ success: false, message: 'Request body is empty.' }, 400, CORS_HEADERS);

    const upstream = await postToAppsScript(target, body, 'text/plain;charset=utf-8', UPSTREAM_TIMEOUT_MS);
    const text = await upstream.text();
    const isHtml = looksLikeHtml(upstream, text);

    if (isHtml) {
      const message = upstream.status >= 400
        ? `Apps Script returned HTTP ${upstream.status} HTML instead of JSON. Confirm the deployment URL and Web App access settings.`
        : 'Apps Script returned an HTML login or error page instead of JSON. Confirm the Web App access settings and deployment URL.';
      return jsonResponse({ success: false, message }, 502, CORS_HEADERS);
    }

    return new Response(text, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    const timeout = error && error.name === 'AbortError';
    console.error('Apps Script proxy error:', error);
    return jsonResponse({
      success: false,
      message: timeout
        ? 'The Apps Script server is taking longer than expected to respond. Please try again in a moment.'
        : 'Could not reach the Google Apps Script backend: ' + (error.message || String(error))
    }, timeout ? 504 : 502, CORS_HEADERS);
  }
}