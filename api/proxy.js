export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb'
    }
  }
};

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const UPSTREAM_TIMEOUT_MS = 55000;

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

  if (!APPS_SCRIPT_URL) {
    return res.status(500).json({
      success: false,
      message: 'APPS_SCRIPT_URL is not configured in Vercel. Set it to the current deployed Apps Script Web App URL ending in /exec.'
    });
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(APPS_SCRIPT_URL)) {
    return res.status(500).json({
      success: false,
      message: 'APPS_SCRIPT_URL must be the current deployed https://script.google.com/macros/s/.../exec URL.'
    });
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
          message: `Apps Script returned HTTP ${upstream.status} HTML instead of JSON. Confirm APPS_SCRIPT_URL is the current /exec deployment and the Web App access is set to Anyone.`
        });
      }

      if (looksLikeHtml) {
        return res.status(502).json({
          success: false,
          message: 'Apps Script returned an HTML login or error page instead of JSON. Confirm the Web App is deployed with access set to Anyone and that APPS_SCRIPT_URL points to the current /exec deployment.'
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
