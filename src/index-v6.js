import app from "./index-v5.js";

const APP_VERSION = "3.1.0-woffu-auth-test";
const WOFFU_BASE_URL = "https://app.woffu.com";

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
      });
    }

    if (request.method === "GET" && url.pathname === "/api/woffu/test") {
      if (!isAuthorized(request, env)) {
        return unauthorizedResponse();
      }

      try {
        const result = await testWoffuConnection(env);
        return jsonResponse({
          ok: true,
          version: APP_VERSION,
          connection: "success",
          userId: maskIdentifier(result.userId),
          companyId: maskIdentifier(result.companyId),
          domain: result.domain || null,
          writeEnabled:
            String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true",
          message:
            "Autenticación y lecturas verificadas. No se ha creado ningún fichaje.",
        });
      } catch (error) {
        console.error("Woffu connection test failed:", safeErrorForLog(error));
        return jsonResponse(
          {
            ok: false,
            version: APP_VERSION,
            connection: "failed",
            error: publicErrorMessage(error),
            writeEnabled:
              String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true",
          },
          error instanceof WoffuError ? error.status : 500
        );
      }
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
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

async function testWoffuConnection(env) {
  const email = String(env.WOFFU_EMAIL || "").trim();
  const password = String(env.WOFFU_PASSWORD || "");

  if (!email || !password) {
    throw new WoffuError(
      503,
      "MISSING_CREDENTIALS",
      "Faltan los secretos WOFFU_EMAIL o WOFFU_PASSWORD en Cloudflare."
    );
  }

  const tokenPayload = new URLSearchParams({
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
    body: tokenPayload.toString(),
  });

  const tokenData = await readJsonSafely(tokenResponse);

  if (!tokenResponse.ok) {
    throw new WoffuError(
      normalizeUpstreamStatus(tokenResponse.status),
      "TOKEN_REQUEST_FAILED",
      upstreamMessage(
        tokenData,
        `Woffu ha rechazado el inicio de sesión (${tokenResponse.status}).`
      )
    );
  }

  const accessToken = firstNonEmpty(
    tokenData?.access_token,
    tokenData?.accessToken,
    tokenData?.AccessToken
  );

  if (!accessToken) {
    throw new WoffuError(
      502,
      "TOKEN_MISSING",
      "Woffu respondió al login, pero no devolvió access_token."
    );
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
      upstreamMessage(
        usersData,
        `No se ha podido consultar /api/users (${usersResponse.status}).`
      )
    );
  }

  const user = findUserRecord(usersData);
  const userId = firstNonEmpty(
    user?.UserId,
    user?.userId,
    user?.Id,
    user?.id
  );
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
      "La respuesta de /api/users no contiene UserId y CompanyId reconocibles."
    );
  }

  const companyResponse = await fetchWithTimeout(
    `${WOFFU_BASE_URL}/api/companies/${encodeURIComponent(String(companyId))}`,
    {
      method: "GET",
      headers: authHeaders,
    }
  );

  const companyData = await readJsonSafely(companyResponse);

  if (!companyResponse.ok) {
    throw new WoffuError(
      normalizeUpstreamStatus(companyResponse.status),
      "COMPANY_REQUEST_FAILED",
      upstreamMessage(
        companyData,
        `No se ha podido consultar la empresa (${companyResponse.status}).`
      )
    );
  }

  const company = findCompanyRecord(companyData);
  const domain = firstNonEmpty(
    company?.Domain,
    company?.domain,
    companyData?.Domain,
    companyData?.domain
  );

  return {
    userId: String(userId),
    companyId: String(companyId),
    domain: domain ? String(domain) : null,
  };
}

function findUserRecord(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;

  const candidates = [
    data,
    data.value,
    data.Value,
    data.user,
    data.User,
    data.users,
    data.Users,
    data.data,
    data.Data,
    data.results,
    data.Results,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate[0];
    if (
      candidate &&
      typeof candidate === "object" &&
      (candidate.UserId || candidate.userId || candidate.CompanyId || candidate.companyId)
    ) {
      return candidate;
    }
  }

  return null;
}

function findCompanyRecord(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;

  const candidates = [
    data,
    data.value,
    data.Value,
    data.company,
    data.Company,
    data.data,
    data.Data,
  ];

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
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new WoffuError(
        504,
        "WOFFU_TIMEOUT",
        "Woffu no ha respondido dentro del tiempo esperado."
      );
    }

    throw new WoffuError(
      502,
      "WOFFU_NETWORK_ERROR",
      "No se ha podido establecer conexión con Woffu."
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonSafely(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function upstreamMessage(data, fallback) {
  return String(
    firstNonEmpty(
      data?.error_description,
      data?.errorDescription,
      data?.message,
      data?.Message,
      data?.error,
      data?.Error,
      fallback
    )
  ).slice(0, 300);
}

function normalizeUpstreamStatus(status) {
  if (status === 400 || status === 401 || status === 403) return 401;
  if (status === 404) return 502;
  if (status === 429) return 429;
  return status >= 500 ? 502 : 502;
}

function firstNonEmpty(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && String(value).trim() !== ""
  );
}

function maskIdentifier(value) {
  const text = String(value || "");
  if (!text) return null;
  if (text.length <= 4) return "••••";
  return `${"•".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
}

function publicErrorMessage(error) {
  if (error instanceof WoffuError) return error.message;
  return "Se ha producido un error inesperado al probar Woffu.";
}

function safeErrorForLog(error) {
  if (error instanceof WoffuError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
    };
  }

  return {
    name: error?.name,
    message: error?.message,
  };
}

function isAuthorized(request, env) {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Basic ")) return false;

  try {
    const decoded = atob(header.substring(6));
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;

    return (
      decoded.substring(0, separator) === "admin" &&
      decoded.substring(separator + 1) === env.ADMIN_PASSWORD
    );
  } catch {
    return false;
  }
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
