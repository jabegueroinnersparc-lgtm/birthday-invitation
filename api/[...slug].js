export default async function handler(req, res) {
  const path = req.url || '/';
  const isApi = path.startsWith('/api');

  if (isApi) {
    return res.status(404).json({
      success: false,
      message: 'API route not found. Check the request path or the deployed Apps Script endpoint.'
    });
  }

  return res.status(404).type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Page Not Found</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Arial, sans-serif;
        background: #fffaf5;
        color: #1f2937;
      }
      .card {
        max-width: 560px;
        padding: 2rem 2.5rem;
        border-radius: 18px;
        background: white;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
        text-align: center;
      }
      h1 { font-size: 3rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 1.25rem; line-height: 1.6; }
      a {
        display: inline-block;
        padding: 0.8rem 1.2rem;
        border-radius: 999px;
        background: #d97706;
        color: white;
        text-decoration: none;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>404</h1>
      <p>The page you requested could not be found. It may have moved, been renamed, or never existed.</p>
      <a href="/">Go back home</a>
    </div>
  </body>
</html>`);
}
