import app from "./index-v7.js";

const APP_VERSION = "3.2.1-live-isolation";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const mode = String(env.MODE || "TEST").toUpperCase();
      const writeEnabled =
        String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true";

      return new Response(
        JSON.stringify(
          {
            ok: true,
            app: "woffu-clock-cloud",
            version: APP_VERSION,
            mode,
            woffuCredentialsConfigured: Boolean(
              String(env.WOFFU_EMAIL || "").trim() &&
              String(env.WOFFU_PASSWORD || "")
            ),
            woffuWriteEnabled: writeEnabled,
            liveManualPunchReady: mode === "LIVE" && writeEnabled,
            syntheticSchedulerEnabled: mode !== "LIVE",
          },
          null,
          2
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            Pragma: "no-cache",
            "X-Woffu-Clock-Version": APP_VERSION,
            "X-Content-Type-Options": "nosniff",
          },
        }
      );
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const mode = String(env.MODE || "TEST").toUpperCase();

    // In LIVE, synthetic/random planning must never execute.
    // Real Woffu writes remain available only through the explicitly
    // confirmed /woffu/punch flow implemented in index-v7.js.
    if (mode === "LIVE") {
      console.log("[LIVE] Synthetic scheduler skipped by design.");
      return;
    }

    return app.scheduled(controller, env, ctx);
  },
};
