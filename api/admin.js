// Vercel Serverless Function
// Set APPS_SCRIPT_URL in Vercel Project Settings to the deployed Apps Script /exec URL.

function normalizeBody(body) {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') return new URLSearchParams(body).toString();
  return '';
}

async function postToAppsScript(target, body) {
  const initial = await fetch(target, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Vercel-Apps-Script-Proxy/1.0'
    },
    body
  });

  if (![301, 302, 303, 307, 308].includes(initial.status)) return initial;

  const location = initial.headers.get('location');
  if (!location) return initial;
  const redirectedUrl = new URL(location, target).toString();

  // Apps Script ContentService processes the POST first, then redirects
  // the generated response to a temporary URL. Retrieve that response with GET.
  return fetch(redirectedUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': 'Vercel-Apps-Script-Proxy/1.0' }
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST required.' });

  const target = process.env.APPS_SCRIPT_URL;
  if (!target) {
    return res.status(500).json({ success: false, message: 'APPS_SCRIPT_URL is not configured in Vercel.' });
  }

  try {
    const body = normalizeBody(req.body);
    if (!body) return res.status(400).json({ success: false, message: 'Request body is empty.' });

    const upstream = await postToAppsScript(target, body);
    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      console.error('Unexpected Apps Script response:', upstream.status, text.slice(0, 1000));
      return res.status(502).json({
        success: false,
        message: 'Apps Script returned HTML instead of JSON. Confirm APPS_SCRIPT_URL is the deployed /exec URL, the deployment is accessible, and the latest Code.gs version is deployed.'
      });
    }

    return res.status(upstream.ok ? 200 : upstream.status).json(payload);
  } catch (error) {
    console.error('Apps Script proxy error:', error);
    return res.status(502).json({
      success: false,
      message: 'Could not reach the Google Apps Script backend: ' + error.message
    });
  }
}
