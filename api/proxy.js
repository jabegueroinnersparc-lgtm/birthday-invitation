// api/proxy.js
// Serverless proxy that forwards requests to Google Apps Script.
// This keeps the browser same-origin, so no CORS issues.

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzzoNUCRIwXKbndf9QWsalqq5jn026zRc3DUfzCW6dihq8p4fol6GyX2MWp2FkGQz_0/exec';

export default async function handler(req, res) {
  // Allow your site + dev previews
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    // Vercel may give req.body as an object or a string depending on the content type.
    // We always want the raw URL-encoded string.
    let body = req.body;
    if (body && typeof body === 'object') {
      body = new URLSearchParams(body).toString();
    }
    if (!body) body = '';

    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        // Apps Script expects form-encoded / text body
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body,
      redirect: 'follow',
    });

    const text = await upstream.text();

    // Apps Script returns an HTML login page if the deployment isn't public.
    if (text.trim().startsWith('<')) {
      return res.status(502).json({
        success: false,
        message: 'Apps Script returned HTML. Make sure the Web App is deployed with "Anyone" access and the URL ends in /exec.',
      });
    }

    // Pass through as JSON
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(upstream.status).send(text);
  } catch (err) {
    console.error('proxy error:', err);
    return res.status(500).json({
      success: false,
      message: 'Proxy error: ' + (err && err.message ? err.message : String(err)),
    });
  }
}
