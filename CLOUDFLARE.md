# Cloudflare Pages Deployment

This project is a static site with Cloudflare Pages Functions for `/api/proxy` and `/api/admin`. The Google Apps Script remains the data backend.

## Connect the repository

1. Create a Pages project in Cloudflare and connect the `birthday-invitation` GitHub repository.
2. Set the production branch to `main`, the build command to empty, and the build output directory to `.`.
3. Add `APPS_SCRIPT_URL` as an environment variable for production and preview deployments. Use the deployed Apps Script Web App URL ending in `/exec`; do not commit it to the repository.
4. Deploy and test the `*.pages.dev` URL first, including `/admin`, account recovery, RSVP submission, and the admin scanner.
5. After the Pages deployment works, add the custom domain in Cloudflare Pages and move DNS only when Cloudflare reports the domain is ready. Keep the Vercel deployment available until the Cloudflare domain is verified.

`wrangler.toml` sets the static output directory and Functions compatibility date. Cloudflare Pages clean URLs serve `admin.html` at `/admin`; `404.html` is used for missing pages.

For local development, set `APPS_SCRIPT_URL` in a local `.dev.vars` file and run `npx wrangler pages dev .`. `.dev.vars` is ignored by Git.