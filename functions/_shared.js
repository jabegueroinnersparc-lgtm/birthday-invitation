export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

export function validAppsScriptUrl(value) {
  return typeof value === 'string' &&
    /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(value);
}

export async function postToAppsScript(target, body, contentType, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const initial = await fetch(target, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': contentType
      },
      body,
      signal: controller.signal
    });

    if (![301, 302, 303, 307, 308].includes(initial.status)) return initial;

    const location = initial.headers.get('location');
    if (!location) return initial;

    return fetch(new URL(location, target).toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function looksLikeHtml(response, text) {
  const contentType = response.headers.get('content-type') || '';
  const preview = text.slice(0, 500).trim();
  return /text\/html|application\/xhtml\+xml|<!doctype html|<html/i.test(`${contentType} ${preview}`) || preview.startsWith('<');
}