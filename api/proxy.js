import { randomUUID } from 'node:crypto';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb'
    }
  }
};

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const UPSTREAM_TIMEOUT_MS = 59000;
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

function getRequestId(req) {
  const incoming = req.headers['x-request-id'];

  if (typeof incoming === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(incoming)) {
    return incoming;
  }

  return 'req_' + randomUUID();
}

function applyCors(req, res, requestId) {
  const origin = req.headers.origin;
  const normalizedOrigin = typeof origin === 'string'
    ? origin.replace(/\/$/, '')
    : '';

  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Request-ID', requestId);

  // Same-origin requests do not require CORS headers. For cross-origin
  // requests, require an explicit origin in ALLOWED_ORIGINS.
  if (normalizedOrigin && ALLOWED_ORIGINS.has(normalizedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Authorization, X-Request-ID'
    );
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  return !normalizedOrigin || ALLOWED_ORIGINS.has(normalizedOrigin);
}

function jsonError(res, status, code, message, requestId) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      requestId
    },
    requestId
  });
}

function addRequestIdToBody(body, requestId) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return JSON.stringify({ ...body, requestId });
  }

  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify({ ...parsed, requestId });
      }
    } catch (e) {
      // Keep non-JSON bodies unchanged; the request ID is still sent in a header.
    }

    return body;
  }

  return JSON.stringify({ requestId });
}

function logEvent(event, fields) {
  const entry = {
    event,
    timestamp: new Date().toISOString(),
    ...fields
  };

  console.info(JSON.stringify(entry));
}

export default async function handler(req, res) {
  const requestId = getRequestId(req);
  const startedAt = Date.now();
  const originAllowed = applyCors(req, res, requestId);

  if (!originAllowed) {
    logEvent('cors_rejected', {
      requestId,
      origin: req.headers.origin || '',
      method: req.method
    });
    return jsonError(
      res,
      403,
      'CORS_ORIGIN_NOT_ALLOWED',
      'This origin is not allowed to call the API.',
      requestId
    );
  }

  if (req.method === 'OPTIONS') {
    if (req.headers.origin) {
      return res.status(204).end();
    }
    return jsonError(res, 400, 'INVALID_PREFLIGHT', 'Invalid CORS preflight request.', requestId);
  }

  if (req.method !== 'POST') {
    return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method Not Allowed.', requestId);
  }

  if (!APPS_SCRIPT_URL) {
    logEvent('configuration_error', {
      requestId,
      code: 'APPS_SCRIPT_URL_MISSING'
    });
    return jsonError(
      res,
      500,
      'APPS_SCRIPT_URL_MISSING',
      'The Apps Script backend is not configured.',
      requestId
    );
  }

  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(APPS_SCRIPT_URL)) {
    logEvent('configuration_error', {
      requestId,
      code: 'APPS_SCRIPT_URL_INVALID'
    });
    return jsonError(
      res,
      500,
      'APPS_SCRIPT_URL_INVALID',
      'The Apps Script backend URL is invalid.',
      requestId
    );
  }

  const outgoingBody = addRequestIdToBody(req.body, requestId);
  const bodyBytes = Buffer.byteLength(outgoingBody, 'utf8');

  logEvent('apps_script_request_started', {
    requestId,
    method: req.method,
    bodyBytes
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        Accept: req.headers.accept || 'application/json, text/plain, */*',
        'Content-Type': 'text/plain;charset=utf-8',
        'X-Request-ID': requestId
      },
      body: outgoingBody,
      redirect: 'manual',
      signal: controller.signal
    });

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const location = upstream.headers.get('location');
      if (location) {
        // Preserve POST when following Apps Script's redirect. Following
        // with GET invokes doGet() and returns HTML instead of JSON.
        upstream = await fetch(new URL(location, APPS_SCRIPT_URL), {
          method: 'POST',
          headers: {
            Accept:
              req.headers.accept ||
              'application/json, text/plain, */*',
            'Content-Type': 'text/plain;charset=utf-8',
            'X-Request-ID': requestId
          },
          body: outgoingBody,
          redirect: 'follow',
          signal: controller.signal
        });
      }
    }

    const text = await upstream.text();
    const responsePreview = text.slice(0, 500).replace(/\s+/g, ' ').trim();
    const contentType = upstream.headers.get('content-type') || '';
    const looksLikeHtml =
      /text\/html|application\/xhtml\+xml|<!doctype html|<html/i.test(
        `${contentType} ${responsePreview}`
      ) || responsePreview.startsWith('<');

    logEvent('apps_script_response_received', {
      requestId,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      responseBytes: Buffer.byteLength(text, 'utf8'),
      looksLikeHtml
    });

    if (looksLikeHtml) {
      return jsonError(
        res,
        502,
        'APPS_SCRIPT_NON_JSON_RESPONSE',
        'The Apps Script backend returned an unexpected HTML response. Confirm the deployed /exec URL and Web App access setting.',
        requestId
      );
    }

    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/json;charset=utf-8'
    );

    return res.status(upstream.status).send(text);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    const status = timedOut ? 504 : 502;
    const code = timedOut ? 'APPS_SCRIPT_TIMEOUT' : 'APPS_SCRIPT_CONNECTION_FAILED';
    const message = timedOut
      ? 'The Apps Script backend took too long to respond.'
      : 'Could not reach the Apps Script backend.';

    logEvent('apps_script_request_failed', {
      requestId,
      code,
      durationMs: Date.now() - startedAt,
      errorName: error && error.name ? error.name : 'UnknownError',
      errorMessage: error && error.message ? error.message : String(error)
    });

    return jsonError(res, status, code, message, requestId);
  } finally {
    clearTimeout(timeoutId);
  }
}
