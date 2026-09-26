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
const UPSTREAM_TIMEOUT_MS = 90000;

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: {
          Accept: req.headers.accept || 'application/json, text/plain, */*',
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: outgoingBody,
        redirect: 'follow',
        signal: controller.signal
      });

      const text = await upstream.text();
      const responsePreview = text.slice(0, 500).replace(/\s+/g, ' ').trim();
      const contentType = upstream.headers.get('content-type') || '';
      const looksLikeHtml = /text\/html|application\/xhtml\+xml|<!doctype html|<html/i.test(`${contentType} ${responsePreview}`) || responsePreview.startsWith('<');

      if ((upstream.status === 404 || upstream.status >= 400) && looksLikeHtml) {
        return res.status(502).json({
          success: false,
          message: 'Apps Script returned an HTML redirect or login page. Check that APPS_SCRIPT_URL ends with /exec and that the Web App is published with "Anyone" access.'
        });
      }

      if (!upstream.ok && !looksLikeHtml) {
        return res.status(upstream.status).send(text);
      }

      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json;charset=utf-8');
      return res.status(upstream.status).send(text);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({
        success: false,
        message: 'The Apps Script server is taking longer than expected to respond. Please wait a moment and try again.'
      });
    }

    console.error('Proxy error:', err);
    return res.status(502).json({
      success: false,
      message: 'Proxy error: ' + (err && err.message ? err.message : String(err))
    });
  }
}
