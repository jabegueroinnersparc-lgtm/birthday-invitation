import { jsonResponse, postToAppsScript, validAppsScriptUrl } from '../_shared.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const UPSTREAM_TIMEOUT_MS = 25000;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return jsonResponse({ success: false, message: 'POST required.' }, 405, CORS_HEADERS);

  const target = env.APPS_SCRIPT_URL;
  if (!target) return jsonResponse({ success: false, message: 'APPS_SCRIPT_URL is not configured in Cloudflare Pages.' }, 500, CORS_HEADERS);
  if (!validAppsScriptUrl(target)) {
    return jsonResponse({ success: false, message: 'APPS_SCRIPT_URL must be the deployed https://script.google.com/macros/s/.../exec URL.' }, 500, CORS_HEADERS);
  }

  try {
    const body = await request.text();
    if (!body) return jsonResponse({ success: false, message: 'Request body is empty.' }, 400, CORS_HEADERS);

    const contentType = request.headers.get('content-type') || 'application/x-www-form-urlencoded;charset=UTF-8';
    const upstream = await postToAppsScript(target, body, contentType, UPSTREAM_TIMEOUT_MS);
    const text = await upstream.text();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      console.error('Unexpected Apps Script response:', upstream.status, text.slice(0, 500));
      return jsonResponse({
        success: false,
        message: 'Apps Script returned HTML instead of JSON. Check the deployment access setting and confirm the current Code.gs version is deployed.'
      }, 502, CORS_HEADERS);
    }

    return jsonResponse(payload, upstream.ok ? 200 : upstream.status, CORS_HEADERS);
  } catch (error) {
    console.error('Apps Script admin proxy error:', error);
    const timeout = error && error.name === 'AbortError';
    return jsonResponse({
      success: false,
      message: timeout
        ? 'Apps Script timed out after 25 seconds. Check that the web app is deployed and accessible.'
        : 'Could not reach the Google Apps Script backend: ' + (error.message || String(error))
    }, timeout ? 504 : 502, CORS_HEADERS);
  }
}