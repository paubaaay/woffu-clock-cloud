import app from "./index-v7.js";

const APP_VERSION = "3.3.1-scheduler-resilient";
const WOFFU_BASE_URL = "https://app.woffu.com";
const TIMEZONE = "Europe/Madrid";
const RECOVERY_WINDOW_SECONDS = 10 * 60;
const SAFE_CLAIM_STALE_SECONDS = 70;
const MAX_EVENT_ATTEMPTS = 5;
const D1_MAX_ATTEMPTS = 5;

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
        schedulerRecoveryWindowMinutes: RECOVERY_WINDOW_SECONDS / 60,
        d1RetryAttempts: D1_MAX_ATTEMPTS,
        ambiguousPostSafeguard: true,
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

    ctx.waitUntil(runResilientLiveScheduler(controller, env));
  },
};

async function runResilientLiveScheduler(controller, env) {
  try {
    const actualNow = new Date();
    const local = getMadridParts(actualNow);
    if (local.weekday === 0 || local.weekday === 6) return;

    const prepared = await ensureBaseSchemaAndPlan(controller, env, local.date);
    if (!prepared) return;

    const weekStart = getWeekStart(local.date);
    const snapshot = await readSchedulerSnapshot(env, weekStart, local.date);
    if (!snapshot.active || snapshot.vacation) return;

    const manualEvents = new Set(snapshot.manualEvents);
    const nowSeconds = local.hour * 3600 + local.minute * 60 + local.second;

    for (const row of snapshot.plan) {
      const definition = EVENTS.find((item) => item.event === row.event);
      if (!definition) continue;
      if (
        snapshot.pauseFromOrder &&
        definition.order >= snapshot.pauseFromOrder
      ) {
        continue;
      }
      if (manualEvents.has(row.event)) continue;

      const plannedSeconds = timeToSeconds(row.planned_time);
      const deltaSeconds = nowSeconds - plannedSeconds;

      if (deltaSeconds < -59) continue;
      if (deltaSeconds > RECOVERY_WINDOW_SECONDS) continue;

      if (deltaSeconds < 0) {
        await sleep(Math.min(-deltaSeconds, 59) * 1000);
      }

      await processResilientScheduledEvent(
        env,
        local.date,
        row.event,
        row.planned_time
      );
    }
  } catch (error) {
    console.error(
      "[LIVE-SCHEDULED] scheduler failure",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function ensureBaseSchemaAndPlan(controller, env, day) {
  let config;

  try {
    config = await d1Read(
      () =>
        env.DB.prepare(`
          SELECT active FROM config WHERE id = 1
        `).first(),
      "config lookup"
    );
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    await prepareThroughLegacyTestScheduler(controller, env);
    config = await d1Read(
      () =>
        env.DB.prepare(`
          SELECT active FROM config WHERE id = 1
        `).first(),
      "config lookup after schema init"
    );
  }

  if (!config || !Boolean(config.active)) return false;

  const weekStart = getWeekStart(day);
  const weekMeta = await d1Read(
    () =>
      env.DB.prepare(`
        SELECT week_start
        FROM test_week_meta
        WHERE week_start = ?1
      `).bind(weekStart).first(),
    "weekly plan lookup"
  );

  if (!weekMeta) {
    await prepareThroughLegacyTestScheduler(controller, env);
  }

  return true;
}

async function prepareThroughLegacyTestScheduler(controller, env) {
  console.log("[LIVE-SCHEDULED] preparing missing weekly plan once");

  let preparationPromise = Promise.resolve();
  const preparationCtx = {
    waitUntil(promise) {
      preparationPromise = Promise.resolve(promise);
    },
  };

  await app.scheduled(controller, { ...env, MODE: "TEST" }, preparationCtx);
  await preparationPromise;
}

async function readSchedulerSnapshot(env, weekStart, day) {
  const results = await d1Read(
    () =>
      env.DB.batch([
        env.DB.prepare(`SELECT active FROM config WHERE id = 1`),
        env.DB.prepare(`SELECT date FROM vacations WHERE date = ?1`).bind(day),
        env.DB.prepare(`
          SELECT event, planned_time
          FROM test_plan
          WHERE week_start = ?1 AND day = ?2
        `).bind(weekStart, day),
        env.DB.prepare(`
          SELECT paused_from_order
          FROM day_pauses
          WHERE day = ?1
        `).bind(day),
        env.DB.prepare(`
          SELECT event
          FROM manual_events
          WHERE day = ?1
        `).bind(day),
      ]),
    "scheduler snapshot"
  );

  const [configResult, vacationResult, planResult, pauseResult, manualResult] = results;

  return {
    active: Boolean(configResult?.results?.[0]?.active),
    vacation: Boolean(vacationResult?.results?.length),
    plan: planResult?.results || [],
    pauseFromOrder: pauseResult?.results?.[0]
      ? Number(pauseResult.results[0].paused_from_order)
      : null,
    manualEvents: (manualResult?.results || []).map((row) => row.event),
  };
}

async function processResilientScheduledEvent(env, day, event, scheduledTime) {
  const existing = await d1Read(
    () =>
      env.DB.prepare(`
        SELECT status, scheduled_time, attempts, executed_at, error
        FROM punch_log
        WHERE day = ?1 AND event = ?2
      `).bind(day, event).first(),
    `${event} existing log`
  );

  if (existing?.status === "SUCCESS") return;

  if (existing?.status === "PENDING") {
    await setAmbiguousState(
      env,
      day,
      event,
      "Legacy PENDING detected. Automatic resend blocked to avoid a duplicate."
    );
    return;
  }

  if (existing?.status === "POSTING" || existing?.status === "UNKNOWN") {
    if (existing.status === "POSTING") {
      await setAmbiguousState(
        env,
        day,
        event,
        "Previous run reached the Woffu POST boundary. Verify Woffu before retrying."
      );
    }
    return;
  }

  if (existing?.status === "FAILED") return;

  if (
    existing?.status === "FAILED_RETRYABLE" &&
    Number(existing.attempts || 0) >= MAX_EVENT_ATTEMPTS
  ) {
    await d1Write(
      () =>
        env.DB.prepare(`
          UPDATE punch_log
          SET status = 'FAILED',
              executed_at = CURRENT_TIMESTAMP,
              error = 'Retry limit reached after transient failures.'
          WHERE day = ?1 AND event = ?2
        `).bind(day, event).run(),
      `${event} retry limit`
    );
    return;
  }

  const claimed = await acquireSafeClaim(env, day, event, scheduledTime, existing);
  if (!claimed) return;

  console.log(`[LIVE-SCHEDULED] ${event} ${scheduledTime} CLAIMED`);

  let context;
  try {
    context = await getWoffuContext(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permanent =
      error instanceof WoffuHttpError && [400, 401, 403].includes(error.status);

    await markPrePostFailure(
      env,
      day,
      event,
      permanent ? "FAILED" : "FAILED_RETRYABLE",
      message
    );

    console.error(
      `[LIVE-SCHEDULED] ${event} ${permanent ? "FAILED" : "SAFE_RETRY"}`,
      message
    );
    return;
  }

  const postingReady = await transitionToPosting(env, day, event);
  if (!postingReady) return;

  const timestamp = localScheduleToIso8601(day, scheduledTime, TIMEZONE);
  console.log(`[LIVE-SCHEDULED] ${event} ${timestamp} POSTING`);

  let postAccepted = false;
  try {
    await createScheduledWoffuPunch(env, context, timestamp);
    postAccepted = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof WoffuSignError && !error.ambiguous) {
      await d1Write(
        () =>
          env.DB.prepare(`
            UPDATE punch_log
            SET status = 'FAILED',
                executed_at = CURRENT_TIMESTAMP,
                error = ?3
            WHERE day = ?1 AND event = ?2
          `).bind(day, event, message.slice(0, 500)).run(),
        `${event} definitive Woffu failure`
      );
      console.error(`[LIVE-SCHEDULED] ${event} FAILED`, message);
      return;
    }

    await setAmbiguousState(env, day, event, message);
    console.error(`[LIVE-SCHEDULED] ${event} UNKNOWN`, message);
    return;
  }

  if (postAccepted) {
    try {
      await d1Write(
        () =>
          env.DB.prepare(`
            UPDATE punch_log
            SET status = 'SUCCESS',
                executed_at = CURRENT_TIMESTAMP,
                error = NULL
            WHERE day = ?1 AND event = ?2
          `).bind(day, event).run(),
        `${event} success confirmation`
      );
      console.log(`[LIVE-SCHEDULED] ${event} ${timestamp} SUCCESS`);
    } catch (error) {
      console.error(
        `[LIVE-SCHEDULED] ${event} WOFFU_ACCEPTED_D1_CONFIRMATION_FAILED`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

async function acquireSafeClaim(env, day, event, scheduledTime, existing) {
  if (!existing) {
    const result = await d1Write(
      () =>
        env.DB.prepare(`
          INSERT OR IGNORE INTO punch_log (
            day, event, scheduled_time, status, attempts, executed_at, error
          ) VALUES (?1, ?2, ?3, 'PENDING_SAFE', 1, CURRENT_TIMESTAMP, NULL)
        `).bind(day, event, scheduledTime).run(),
      `${event} initial claim`
    );
    return Number(result?.meta?.changes ?? 0) > 0;
  }

  if (existing.status === "PENDING_SAFE") {
    const result = await d1Write(
      () =>
        env.DB.prepare(`
          UPDATE punch_log
          SET attempts = attempts + 1,
              executed_at = CURRENT_TIMESTAMP,
              error = NULL
          WHERE day = ?1
            AND event = ?2
            AND status = 'PENDING_SAFE'
            AND (
              executed_at IS NULL OR
              datetime(executed_at) <= datetime('now', ?3)
            )
        `).bind(day, event, `-${SAFE_CLAIM_STALE_SECONDS} seconds`).run(),
      `${event} stale safe claim recovery`
    );
    return Number(result?.meta?.changes ?? 0) > 0;
  }

  if (existing.status === "FAILED_RETRYABLE" || existing.status === "TEST") {
    const result = await d1Write(
      () =>
        env.DB.prepare(`
          UPDATE punch_log
          SET status = 'PENDING_SAFE',
              scheduled_time = ?3,
              attempts = attempts + 1,
              executed_at = CURRENT_TIMESTAMP,
              error = NULL
          WHERE day = ?1
            AND event = ?2
            AND status = ?4
        `).bind(day, event, scheduledTime, existing.status).run(),
      `${event} retry claim`
    );
    return Number(result?.meta?.changes ?? 0) > 0;
  }

  return false;
}

async function transitionToPosting(env, day, event) {
  try {
    const result = await d1Write(
      () =>
        env.DB.prepare(`
          UPDATE punch_log
          SET status = 'POSTING',
              executed_at = CURRENT_TIMESTAMP,
              error = NULL
          WHERE day = ?1
            AND event = ?2
            AND status = 'PENDING_SAFE'
        `).bind(day, event).run(),
      `${event} posting boundary`
    );

    if (Number(result?.meta?.changes ?? 0) > 0) return true;

    const current = await d1Read(
      () =>
        env.DB.prepare(`
          SELECT status FROM punch_log
          WHERE day = ?1 AND event = ?2
        `).bind(day, event).first(),
      `${event} posting boundary verification`
    );
    return current?.status === "POSTING";
  } catch (error) {
    console.error(
      `[LIVE-SCHEDULED] ${event} D1_POSTING_BOUNDARY_FAILED_SAFE`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

async function markPrePostFailure(env, day, event, status, message) {
  await d1Write(
    () =>
      env.DB.prepare(`
        UPDATE punch_log
        SET status = ?3,
            executed_at = CURRENT_TIMESTAMP,
            error = ?4
        WHERE day = ?1 AND event = ?2
      `).bind(day, event, status, message.slice(0, 500)).run(),
    `${event} pre-post failure`
  );
}

async function setAmbiguousState(env, day, event, message) {
  try {
    await d1Write(
      () =>
        env.DB.prepare(`
          UPDATE punch_log
          SET status = 'UNKNOWN',
              executed_at = CURRENT_TIMESTAMP,
              error = ?3
          WHERE day = ?1 AND event = ?2
        `).bind(day, event, String(message).slice(0, 500)).run(),
      `${event} ambiguous safeguard`
    );
  } catch (error) {
    console.error(
      `[LIVE-SCHEDULED] ${event} could not persist UNKNOWN`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function createScheduledWoffuPunch(env, context, timestamp) {
  const targetUrl = `https://${context.domain}/api/svc/signs/signs`;
  let response;

  try {
    response = await fetchWithTimeout(targetUrl, {
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
  } catch (error) {
    throw new WoffuSignError(
      null,
      error instanceof Error ? error.message : String(error),
      true
    );
  }

  const data = await readJsonSafely(response);
  if (!response.ok) {
    const message = upstreamMessage(
      data,
      `Woffu ha rechazado el fichaje programado (${response.status}).`
    );
    const ambiguous = response.status === 429 || response.status >= 500;
    throw new WoffuSignError(response.status, message, ambiguous);
  }
}

class WoffuHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class WoffuSignError extends Error {
  constructor(status, message, ambiguous) {
    super(message);
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

async function getWoffuContext(env) {
  const email = String(env.WOFFU_EMAIL || "").trim();
  const password = String(env.WOFFU_PASSWORD || "");
  if (!email || !password) {
    throw new WoffuHttpError(503, "Faltan WOFFU_EMAIL o WOFFU_PASSWORD.");
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
    throw new WoffuHttpError(
      tokenResponse.status,
      upstreamMessage(tokenData, "Woffu ha rechazado el inicio de sesión.")
    );
  }

  const accessToken = firstNonEmpty(
    tokenData?.access_token,
    tokenData?.accessToken,
    tokenData?.AccessToken
  );
  if (!accessToken) {
    throw new WoffuHttpError(502, "Woffu no devolvió access_token.");
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
    throw new WoffuHttpError(
      usersResponse.status,
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
    throw new WoffuHttpError(502, "No se han encontrado UserId y CompanyId.");
  }

  const companyResponse = await fetchWithTimeout(
    `${WOFFU_BASE_URL}/api/companies/${encodeURIComponent(String(companyId))}`,
    { method: "GET", headers: authHeaders }
  );
  const companyData = await readJsonSafely(companyResponse);
  if (!companyResponse.ok) {
    throw new WoffuHttpError(
      companyResponse.status,
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
  if (!rawDomain) {
    throw new WoffuHttpError(502, "Woffu no ha devuelto el dominio de empresa.");
  }

  const domain = String(rawDomain)
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  if (!/^[a-z0-9.-]+\.woffu\.com$/i.test(domain)) {
    throw new WoffuHttpError(502, "Dominio Woffu no válido.");
  }

  return {
    accessToken: String(accessToken),
    userId: String(userId),
    domain,
  };
}

async function d1Read(operation, label) {
  return d1WithRetry(operation, label, D1_MAX_ATTEMPTS);
}

async function d1Write(operation, label) {
  return d1WithRetry(operation, label, D1_MAX_ATTEMPTS);
}

async function d1WithRetry(operation, label, maxAttempts) {
  let delayMs = 100;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableD1Error(error) || attempt === maxAttempts) {
        throw error;
      }

      const waitMs = Math.round(delayMs * (1 + Math.random()));
      console.warn(
        `[D1-RETRY] ${label} attempt ${attempt}/${maxAttempts} after ${waitMs}ms`,
        error instanceof Error ? error.message : String(error)
      );
      await sleep(waitMs);
      delayMs = Math.min(delayMs * 2, 2000);
    }
  }

  throw lastError;
}

function isRetryableD1Error(error) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("network connection lost") ||
    message.includes("replica disconnected from primary") ||
    message.includes("storage caused object to be reset") ||
    message.includes("storage operation exceeded timeout") ||
    message.includes("object to be reset") ||
    message.includes("reset because its code was updated") ||
    message.includes("transient issue on remote node")
  );
}

function isMissingTableError(error) {
  return String(error instanceof Error ? error.message : error)
    .toLowerCase()
    .includes("no such table");
}

function localScheduleToIso8601(day, time, timeZone) {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, date, hour, minute, second || 0));
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
  const offsetMinutes = Math.round((representedLocalAsUtc - utcGuess.getTime()) / 60000);
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
  const candidates = [data, data.value, data.Value, data.user, data.User, data.users, data.Users, data.data, data.Data, data.results, data.Results];
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
    if (controller.signal.aborted) {
      throw new Error("Woffu request timed out.");
    }
    throw error;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
