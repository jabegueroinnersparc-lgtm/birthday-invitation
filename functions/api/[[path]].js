import { jsonResponse } from '../_shared.js';

export async function onRequest({ request }) {
  const pathname = new URL(request.url).pathname;
  return jsonResponse({
    success: false,
    message: 'API route not found: ' + pathname
  }, 404);
}