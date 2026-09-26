export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb'
    }
  }
};

const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbzzoNUCRIwXKbndf9QWsalqq5jn026zRc3DUfzCW6dihq8p4fol6GyX2MWp2FkGQz_0/exec';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const outgoingBody =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});

    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        Accept: req.headers.accept || 'application/json, text/plain, */*',
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: outgoingBody,
      redirect: 'follow'
    });

    const text = await upstream.text();

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json;charset=utf-8');
    return res.status(upstream.status).send(text);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({
      success: false,
      message: 'Proxy error: ' + (err && err.message ? err.message : String(err))
    });
  }
}
