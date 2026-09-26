// Vercel Serverless Function
// Set APPS_SCRIPT_URL in Vercel Project Settings to the deployed Apps Script /exec URL.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST required.' });

  const target = process.env.APPS_SCRIPT_URL;
  if (!target) {
    return res.status(500).json({
      success: false,
      message: 'APPS_SCRIPT_URL is not configured in Vercel.'
    });
  }

  try {
    const body = typeof req.body === 'string'
      ? req.body
      : new URLSearchParams(req.body || {}).toString();

    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body
    });

    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch (e) { payload = { success: false, message: 'Invalid response from Apps Script.' }; }

    return res.status(upstream.ok ? 200 : upstream.status).json(payload);
  } catch (error) {
    console.error('Apps Script proxy error:', error);
    return res.status(502).json({
      success: false,
      message: 'Could not reach the Google Apps Script backend.'
    });
  }
}
