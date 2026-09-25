// api/proxy.js
// Vercel serverless proxy for Google Apps Script Web App.
// Raises the body size limit and forwards JSON payloads.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb'   // ⭐ raise from default 4.5MB (Hobby: still capped ~4.5MB)
    }
  }
};

const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';   // ⭐ replace

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    // Vercel may give us an object (parsed) or a string depending on content-type.
    // Normalize to a string body.
    const outgoingBody =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});

    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: outgoingBody,
      redirect: 'follow'
    });

    const text = await upstream.text();

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(upstream.status).send(text);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({
      success: false,
      message: 'Proxy error: ' + (err && err.message ? err.message : String(err))
    });
  }
}
