/*
  Cuck Factory runtime config.

  IMPORTANT:
  - On GitHub Pages, same-origin /api/* endpoints do not exist.
  - When your Cloudflare Worker is ready, set apiBase to its public API root, e.g.
      https://api.cucks.money/api
    or
      https://your-worker.workers.dev/api
  - If you later serve the whole site behind Cloudflare with /api routed to the Worker,
    you can leave apiBase as "/api".
*/
window.CUCK_FACTORY_CONFIG = {
  apiBase: "/api"
};
