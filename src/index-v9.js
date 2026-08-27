import app from "./index-v7.js";

const APP_VERSION = "3.3.0-scheduled-woffu-test";
const WOFFU_BASE_URL = "https://app.woffu.com";
const TIMEZONE = "Europe/Madrid";

const EVENTS = [
  { event: "ENTRY_AM", order: 1 },
  { event: "LUNCH_OUT", order: 2 },
  { event: "LUNCH_IN", order: 3 },
  { event: "EXIT_PM", order: 4 },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const mode = String(env.MODE || "TEST").toUpperCase();
      const writeEnabled =
        String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true";

      return jsonResponse({
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
        scheduledWoffuWritesEnabled: mode === "LIVE" && writeEnabled,
      });
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const mode = String(env.MODE || "TEST").toUpperCase();
    const writeEnabled =
      String(env.WOFFU_WRITE_ENABLED || "false").toLowerCase() === "true";

    if (mode !== "LIVE" || !writeEnabled) {
      return app.scheduled(controller, env, ctx);
    }

    ctx.waitUntil(runLiveScheduledWoffu(controller, env));
  },
};

async function runLiveScheduledWoffu(controller, env) {
  // Reuse the existing scheduler in TEST mode first so schema and the
  // weekly randomized plan are created exactly as in the webapp, but
  // without sending anything to Woffu.
  let preparationPromise = Promise.resolve();
  const preparationCtx = {
    waitUntil(promise) {
      preparationPromise = Promise.resolve(promise);
    },
  };

  app.scheduled(controller, { ...env, MODE: "TEST" }, preparationCtx);
  await preparationPromise;

  const scheduledAt = new Date(controller.scheduledTime);
  const local = getMadridParts(scheduledAt);

  if (local.weekday === 0 || local.weekday === 6) return;

  const config = await env.DB.prepare(`
    SELECT active FROM config WHERE id = 1
  `).first();
  if (!config || !Boolean(config.active)) return;

  const vacation = await env.DB.prepare(`
    SELECT date FROM vacations WHERE date = ?1
  `).bind(local.date).first();
  if (vacation) return;

  const weekStart = getWeekStart(local.date);
  const [planRows, pause, manualRows] = await Promise.all([
    env.DB.prepare(`
      SELECT event, planned_time
      FROM test_plan
      WHERE week_start = ?1 AND day = ?2
    `).bind(weekStart, local.date).all(),
    env.DB.prepare(`
      SELECT paused_from_order
      FROM day_pauses
      WHERE day = ?1
    `).bind(local.date).first(),
    env.DB.prepare(`
      SELECT event
      FROM manual_events
      WHERE day = ?1
    `).bind(local.date).all(),
  ]);

  const manualEvents = new Set(
    (manualRows.results || []).map((row) => row.event)
  );
  const scheduledMinute = local.hour * 60 + local.minute;

  for (const row of planRows.results || []) {
    const definition = EVENTS.find((item) => item.event === row.event);
    if (!definition) continue;
    if (pause && definition.order >= Number(pause.paused_from_order)) continue;
    if (manualEvents.has(row.event)) continue;

    const plannedMinute = Math.floor(timeToSeconds(row.planned_time) / 60);
    if (plannedMinute !== scheduledMinute) continue;

    await processLiveScheduledEvent(
      env,
      local.date,
      row.event,
      row.planned_time
    );
  }
}

async function processLiveScheduledEvent(env, day, event, scheduledTime) {
  const existing = await env.DB.prepare(`
    SELECT status, scheduled_time
    FROM punch_log
    WHERE day = ?1 AND event = ?2
  `).bind(day, event).first();

  if (
    existing?.status === "SUCCESS" &&
    existing?.scheduled_time === scheduledTime
  ) {
    return;
  }

  if (!existing) {
    await env.DB.prepare(`
      INSERT INTO punch_log (
        day, event, scheduled_time, status, attempts
      ) VALUES (?1, ?2, ?3, 'PENDING', 1)
    `).bind(day, event, scheduledTime).run();
  } else {
    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'PENDING',
          scheduled_time = ?3,
          attempts = attempts + 1,
          error = NULL
      WHERE day = ?1 AND event = ?2
    `).bind(day, event, scheduledTime).run();
  }

  try {
    const timestamp = localScheduleToIso8601(day, scheduledTime, TIMEZONE);
    await createScheduledWoffuPunch(env, timestamp);

    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'SUCCESS',
          executed_at = CURRENT_TIMESTAMP,
          error = NULL
      WHERE day = ?1 AND event = ?2
    `).bind(day, event).run();

    console.log(`[LIVE-SCHEDULED] ${event} ${timestamp} SUCCESS`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'FAILED',
          executed_at = CURRENT_TIMESTAMP,
          error = ?3
      WHERE day = ?1 AND event = ?2
    `).bind(day, event, message.slice(0, 500)).run();

    console.error(`[LIVE-SCHEDULED] ${event} FAILED`, message);
  }
}

async function createScheduledWoffuPunch(env, timestamp) {
  const context = await getWoffuContext(env);
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
    throw new Error(
      upstreamMessage(
        data,
        `Woffu ha rechazado el fichaje programado (${response.status}).`
      )
    );
  }
}

async function getWoffuContext(env) {
  const email = String(env.WOFFU_EMAIL || "").trim();
  const password = String(env.WOFFU_PASSWORD || "");
  if (!email || !password) {
    throw new Error("Faltan WOFFU_EMAIL o WOFFU_PASSWORD.");
  }

  const tokenResponse = await fetchWithTimeout(`${WOFFU_BASE_URL}/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: email,
      password,
    }).toString(),
  });

  const tokenData = await readJsonSafely(tokenResponse);
  if (!tokenResponse.ok) {
    throw new Error(
      upstreamMessage(tokenData, "Woffu ha rechazado el inicio de sesión.")
    );
  }

  const accessToken = firstNonEmpty(
    tokenData?.access_token,
    tokenData?.accessToken,
    tokenData?.AccessToken
  );
  if (!accessToken) throw new Error("Woffu no devolvió access_token.");

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
    throw new Error(
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
    throw new Error("No se han encontrado UserId y CompanyId.");
  }

  const companyResponse = await fetchWithTimeout(
    `${WOFFU_BASE_URL}/api/companies/${encodeURIComponent(String(companyId))}`,
    { method: "GET", headers: authHeaders }
  );
  const companyData = await readJsonSafely(companyResponse);
  if (!companyResponse.ok) {
    throw new Error(
      upstreamMessage(companyData, "No se ha podido consultar la empresa.")
    );
  }

  const company = findCompanyRecord(companyData);
  const rawDomain = firstNonEmpty(
    company?.Domain,
    company?.domain,
    companyData?.Domain,
    companyData?.domain
  );
  if (!rawDomain) throw new Error("Woffu no ha devuelto el dominio de empresa.");

  const domain = String(rawDomain)
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  if (!/^[a-z0-9.-]+\.woffu\.com$/i.test(domain)) {
    throw new Error("Dominio Woffu no válido.");
  }

  return {
    accessToken: String(accessToken),
    userId: String(userId),
    domain,
  };
}

function localScheduleToIso8601(day, time, timeZone) {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);

  const utcGuess = new Date(
    Date.UTC(year, month - 1, date, hour, minute, second || 0)
  );
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
    formatter.formatToParts(utcGuess).map((part) => [part.type, part.value])
  );

  const representedLocalAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round(
    (representedLocalAsUtc - utcGuess.getTime()) / 60000
  );
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;

  return `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second || 0).padStart(2, "0")}${offset}`;
}

function getMadridParts(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday],
  };
}

function getWeekStart(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const weekday = date.getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function timeToSeconds(time) {
  const [hour, minute, second = "0"] = String(time).split(":");
  return Number(hour) * 3600 + Number(minute) * 60 + Number(second);
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
    return await fetch(url, { ...options, signal: controller.signal });
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

function firstNonEmpty(...values) {
  return values.find(
    (value) => value !== undefined && value !== null && String(value).trim() !== ""
  );
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
