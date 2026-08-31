import app from "./index-v10.js";

const APP_VERSION = "3.4.1-ui-version-sync";
const LEGACY_UI_VERSION = "3.0.0-mobile-fast";
const PREVIOUS_BACKEND_VERSION = "3.4.0-weekly-compensation";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const response = await app.fetch(request, env, ctx);
      return replaceVersion(response);
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/api/bootstrap")
    ) {
      const response = await app.fetch(request, env, ctx);
      return replaceVersion(response);
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return app.scheduled(controller, env, ctx);
  },
};

async function replaceVersion(response) {
  const text = await response.text();
  const updated = text
    .replaceAll(LEGACY_UI_VERSION, APP_VERSION)
    .replaceAll(PREVIOUS_BACKEND_VERSION, APP_VERSION);

  const headers = new Headers(response.headers);
  headers.set("X-Woffu-Clock-Version", APP_VERSION);
  headers.delete("Content-Length");

  return new Response(updated, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
