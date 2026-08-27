import app from "./index-v6.js";

const APP_VERSION = "3.2.0-woffu-manual-punch";
const WOFFU_BASE_URL = "https://app.woffu.com";
const TIMEZONE = "Europe/Madrid";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        app: "woffu-clock-cloud",
        version: APP_VERSION,
        mode: String(env.MODE || "TEST").toUpperCase(),
        woffuCredentialsConfigured: Boolean(
          String(env.WOFFU_EMAIL || "").trim() &&
          String(env.WOFFU_PASSWORD || "")
        ),
        woffuWriteEnabled:
          String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true",
        liveManualPunchReady:
          String(env.MODE || "TEST").toUpperCase() === "LIVE" &&
          String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true",
      });
    }

    if (request.method === "GET" && url.pathname === "/woffu/punch") {
      if (!isAuthorized(request, env)) return unauthorizedResponse();
      return htmlResponse(punchPage(env));
    }

    if (request.method === "POST" && url.pathname === "/api/woffu/punch-now") {
      if (!isAuthorized(request, env)) return unauthorizedResponse();
      assertSameOrigin(request, url);

      const mode = String(env.MODE || "TEST").toUpperCase();
      const writeEnabled =
        String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true";

      if (mode !== "LIVE" || !writeEnabled) {
        return jsonResponse(
          {
            ok: false,
            version: APP_VERSION,
            error:
              "Escritura real desactivada. Se requiere MODE=LIVE y WOFFU_WRITE_ENABLED=true.",
          },
          409
        );
      }

      try {
        const body = await request.json().catch(() => ({}));
        if (body?.confirm !== "PUNCH_NOW") {
          return jsonResponse(
            {
              ok: false,
              error: "Confirmación inválida.",
            },
            400
          );
        }

        const result = await createWoffuPunchNow(env);
        return jsonResponse({
          ok: true,
          version: APP_VERSION,
          message: "Fichaje enviado a Woffu.",
          timestamp: result.timestamp,
          status: result.status,
        });
      } catch (error) {
        console.error("Woffu punch failed:", safeErrorForLog(error));
        return jsonResponse(
          {
            ok: false,
            version: APP_VERSION,
            error: publicErrorMessage(error),
          },
          error instanceof WoffuError ? error.status : 500
        );
      }
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Scheduled/test planning remains delegated to the existing app.
    // Real Woffu writes are intentionally not triggered from synthetic/random plans.
    return app.scheduled(controller, env, ctx);
  },
};

class WoffuError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function createWoffuPunchNow(env) {
  const context = await getWoffuContext(env);
  const timestamp = toZonedIso8601(new Date(), TIMEZONE);
  const targetUrl = `https://${context.domain}/api/svc/signs/signs`;

  const response = await fetchWithTimeout(targetUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${context.accessToken}`,
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify({
      StartDate: timestamp,
      EndDate: timestamp,
      UserId: numericIfSafe(context.userId),
    }),
  });

  const data = await readJsonSafely(response);

  if (!response.ok) {
    throw new WoffuError(
      normalizeUpstreamStatus(response.status),
      "PUNCH_REQUEST_FAILED",
      upstreamMessage(
        data,
        `Woffu ha rechazado el fichaje (${response.status}).`
      )
    );
  }

  return {
    status: response.status,
    timestamp,
  };
}

async function getWoffuContext(env) {
  const email = String(env.WOFFU_EMAIL || "").trim();
  const password = String(env.WOFFU_PASSWORD || "");

  if (!email || !password) {
    throw new WoffuError(
      503,
      "MISSING_CREDENTIALS",
      "Faltan WOFFU_EMAIL o WOFFU_PASSWORD en Cloudflare."
    );
  }

  const tokenBody = new URLSearchParams({
    grant_type: "password",
    username: email,
    password,
  });

  const tokenResponse = await fetchWithTimeout(`${WOFFU_BASE_URL}/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: tokenBody.toString(),
  });

  const tokenData = await readJsonSafely(tokenResponse);
  if (!tokenResponse.ok) {
    throw new WoffuError(
      normalizeUpstreamStatus(tokenResponse.status),
      "TOKEN_REQUEST_FAILED",
      upstreamMessage(tokenData, "Woffu ha rechazado el inicio de sesión.")
    );
  }

  const accessToken = firstNonEmpty(
    tokenData?.access_token,
    tokenData?.accessToken,
    tokenData?.AccessToken
  );
  if (!accessToken) {
    throw new WoffuError(502, "TOKEN_MISSING", "Woffu no devolvió access_token.");
  }

  const authHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };

  const usersResponse = await fetchWithTimeout(`${WOFFU_BASE_URL}/api/users`, {
    method: "GET",
    headers: authHeaders,
  });
  const usersData = await readJsonSafely(usersResponse);
  if (!usersResponse.ok) {
    throw new WoffuError(
      normalizeUpstreamStatus(usersResponse.status),
      "USERS_REQUEST_FAILED",
      upstreamMessage(usersData, "No se ha podido consultar /api/users.")
    );
  }

  const user = findUserRecord(usersData);
  const userId = firstNonEmpty(user?.UserId, user?.userId, user?.Id, user?.id);
  const companyId = firstNonEmpty(
    user?.CompanyId,
    user?.companyId,
    user?.Company?.CompanyId,
    user?.company?.companyId,
    tokenData?.CompanyId,
    tokenData?.companyId
  );

  if (!userId || !companyId) {
    throw new WoffuError(
      502,
      "USER_CONTEXT_MISSING",
      "No se han encontrado UserId y CompanyId en la respuesta de Woffu."
    );
  }

  const companyResponse = await fetchWithTimeout(
    `${WOFFU_BASE_URL}/api/companies/${encodeURIComponent(String(companyId))}`,
    { method: "GET", headers: authHeaders }
  );
  const companyData = await readJsonSafely(companyResponse);
  if (!companyResponse.ok) {
    throw new WoffuError(
      normalizeUpstreamStatus(companyResponse.status),
      "COMPANY_REQUEST_FAILED",
      upstreamMessage(companyData, "No se ha podido consultar la empresa.")
    );
  }

  const company = findCompanyRecord(companyData);
  const domain = firstNonEmpty(
    company?.Domain,
    company?.domain,
    companyData?.Domain,
    companyData?.domain
  );

  if (!domain) {
    throw new WoffuError(502, "DOMAIN_MISSING", "Woffu no ha devuelto el dominio de empresa.");
  }

  return {
    accessToken: String(accessToken),
    userId: String(userId),
    companyId: String(companyId),
    domain: String(domain).replace(/^https?:\/\//i, "").replace(/\/$/, ""),
  };
}

function punchPage(env) {
  const mode = String(env.MODE || "TEST").toUpperCase();
  const writeEnabled =
    String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true";
  const ready = mode === "LIVE" && writeEnabled;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Fichar ahora</title>
<style>
:root{color-scheme:light;--bg:#f4f5f7;--card:#fff;--text:#14171d;--muted:#6d7380;--line:#e5e7eb;--green:#137a3b;--red:#b42318}*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text)}main{max-width:520px;margin:auto;padding:24px 16px calc(32px + env(safe-area-inset-bottom))}.card{margin-top:12vh;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 8px 30px rgba(0,0,0,.05)}h1{margin:0 0 8px;font-size:28px}.muted{color:var(--muted);font-size:14px;line-height:1.45}.state{margin:18px 0;padding:12px;border-radius:12px;background:${ready ? "#eaf7ef" : "#fff0ee"};color:${ready ? "#095c2a" : "#842018"};font-weight:700}.button{width:100%;min-height:52px;border:0;border-radius:14px;font-size:17px;font-weight:800;background:${ready ? "#151922" : "#c7c9ce"};color:#fff}.button:disabled{cursor:not-allowed}.result{margin-top:14px;padding:12px;border-radius:12px;display:none}.result.ok{display:block;background:#eaf7ef;color:#095c2a}.result.err{display:block;background:#fff0ee;color:#842018}.back{display:block;text-align:center;margin-top:16px;color:var(--muted);text-decoration:none}
</style>
</head>
<body>
<main>
  <section class="card">
    <h1>Fichar ahora</h1>
    <p class="muted">Envía una única marca a Woffu usando la hora real del momento. No utiliza el horario aleatorio de TEST.</p>
    <div class="state">${ready ? "Escritura real habilitada" : `Escritura real desactivada · MODE=${escapeHtml(mode)} · WOFFU_WRITE_ENABLED=${writeEnabled}`}</div>
    <button id="punch" class="button" ${ready ? "" : "disabled"}>Fichar ahora</button>
    <div id="result" class="result"></div>
    <a class="back" href="/">Volver a la webapp</a>
  </section>
</main>
<script>
const btn=document.getElementById('punch');const out=document.getElementById('result');
btn?.addEventListener('click',async()=>{if(btn.disabled)return;btn.disabled=true;btn.textContent='Enviando…';out.className='result';try{const r=await fetch('/api/woffu/punch-now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'PUNCH_NOW'})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Error al fichar');out.className='result ok';out.textContent='Fichaje enviado: '+(d.timestamp||'OK');}catch(e){out.className='result err';out.textContent=e.message||'Error';btn.disabled=false;btn.textContent='Fichar ahora';}});
</script>
</body>
</html>`;
}

function toZonedIso8601(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function numericIfSafe(value) {
  const text = String(value);
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  return text;
}

function findUserRecord(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  const candidates = [data, data.value, data.Value, data.user, data.User, data.users, data.Users, data.data, data.Data, data.results, data.Results];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate[0];
    if (candidate && typeof candidate === "object" && (candidate.UserId || candidate.userId || candidate.CompanyId || candidate.companyId)) return candidate;
  }
  return null;
}

function findCompanyRecord(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  const candidates = [data, data.value, data.Value, data.company, data.Company, data.data, data.Data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate[0];
    if (candidate && typeof candidate === "object") return candidate;
  }
  return null;
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new WoffuError(504, "WOFFU_TIMEOUT", "Woffu no ha respondido dentro del tiempo esperado.");
    throw new WoffuError(502, "WOFFU_NETWORK_ERROR", "No se ha podido conectar con Woffu.");
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonSafely(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

function upstreamMessage(data, fallback) {
  return String(firstNonEmpty(data?.error_description, data?.errorDescription, data?.message, data?.Message, data?.error, data?.Error, fallback)).slice(0, 300);
}

function normalizeUpstreamStatus(status) {
  if (status === 400 || status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  return 502;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function publicErrorMessage(error) {
  if (error instanceof WoffuError) return error.message;
  return "Se ha producido un error inesperado al comunicarse con Woffu.";
}

function safeErrorForLog(error) {
  if (error instanceof WoffuError) return { code: error.code, status: error.status, message: error.message };
  return { name: error?.name, message: error?.message };
}

function isAuthorized(request, env) {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.substring(6));
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;
    return decoded.substring(0, separator) === "admin" && decoded.substring(separator + 1) === env.ADMIN_PASSWORD;
  } catch { return false; }
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw new WoffuError(403, "BAD_ORIGIN", "Origen no permitido.");
}

function unauthorizedResponse() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Woffu Clock"',
      "Cache-Control": "no-store",
      "X-Woffu-Clock-Version": APP_VERSION,
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      "X-Woffu-Clock-Version": APP_VERSION,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Woffu-Clock-Version": APP_VERSION,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
