const APP_VERSION = "3.0.0-mobile-fast";
const TIMEZONE = "Europe/Madrid";
const MAX_OFFSET_SECONDS = 299;
const MAX_DAILY_DEVIATION_SECONDS = 180;
const DAILY_TARGET_SECONDS = 8 * 60 * 60;
const MIN_BREAK_SECONDS = 60 * 60;

const EVENTS = [
  { event: "ENTRY_AM", field: "entry_am", label: "Entrada mañana", shortLabel: "Entrada", order: 1 },
  { event: "LUNCH_OUT", field: "lunch_out", label: "Salida mediodía", shortLabel: "Pausa", order: 2 },
  { event: "LUNCH_IN", field: "lunch_in", label: "Entrada mediodía", shortLabel: "Vuelta", order: 3 },
  { event: "EXIT_PM", field: "exit_pm", label: "Salida tarde", shortLabel: "Salida", order: 4 },
];

let schemaPromise;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        app: "woffu-clock-cloud",
        version: APP_VERSION,
        mode: String(env.MODE || "TEST").toUpperCase(),
      });
    }

    if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
      return manifestResponse();
    }

    if (request.method === "GET" && url.pathname === "/icon.svg") {
      return iconResponse();
    }

    if (!isAuthorized(request, env)) {
      return new Response("Authentication required", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Woffu Clock"',
          "Cache-Control": "no-store",
          "X-Woffu-Clock-Version": APP_VERSION,
        },
      });
    }

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(appShell());
      }

      if (url.pathname.startsWith("/api/")) {
        await ensureSchemaOnce(env);
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        return bootstrapResponse(request, env);
      }

      if (request.method === "POST") {
        assertSameOrigin(request, url);

        if (url.pathname === "/api/active") return updateActive(request, env);
        if (url.pathname === "/api/config") return updateConfig(request, env);
        if (url.pathname === "/api/vacations") return updateVacations(request, env);
        if (url.pathname === "/api/manual") return upsertManualEvent(request, env);
        if (url.pathname === "/api/manual/delete") return removeManualEvent(request, env);
        if (url.pathname === "/api/pause") return upsertDayPause(request, env);
        if (url.pathname === "/api/pause/clear") return clearDayPause(request, env);
        if (url.pathname === "/api/regenerate") return regenerateWeek(request, env);
      }

      return textResponse("Not found", 404);
    } catch (error) {
      console.error(error);
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        error instanceof HttpError ? error.status : 500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller.scheduledTime);
    const actualNow = new Date();
    ctx.waitUntil(runScheduler(env, scheduledAt, actualNow));
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ==================================================
// SCHEMA
// ==================================================

function ensureSchemaOnce(env) {
  if (!schemaPromise) {
    schemaPromise = ensureSchema(env).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER NOT NULL DEFAULT 0,
        entry_am TEXT NOT NULL DEFAULT '09:00',
        lunch_out TEXT NOT NULL DEFAULT '13:00',
        lunch_in TEXT NOT NULL DEFAULT '14:00',
        exit_pm TEXT NOT NULL DEFAULT '18:00',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      INSERT OR IGNORE INTO config (
        id, active, entry_am, lunch_out, lunch_in, exit_pm
      ) VALUES (1, 0, '09:00', '13:00', '14:00', '18:00')
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS punch_log (
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        executed_at TEXT,
        error TEXT,
        PRIMARY KEY (day, event)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS vacations (
        date TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS test_plan (
        week_start TEXT NOT NULL,
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        base_time TEXT NOT NULL,
        planned_time TEXT NOT NULL,
        offset_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (week_start, day, event)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS test_day_summary (
        week_start TEXT NOT NULL,
        day TEXT NOT NULL,
        worked_seconds INTEGER NOT NULL,
        deviation_seconds INTEGER NOT NULL,
        PRIMARY KEY (week_start, day)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS test_week_meta (
        week_start TEXT PRIMARY KEY,
        workdays INTEGER NOT NULL,
        target_seconds INTEGER NOT NULL,
        generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS manual_events (
        day TEXT NOT NULL,
        event TEXT NOT NULL,
        manual_time TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (day, event)
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS day_pauses (
        day TEXT PRIMARY KEY,
        paused_from_order INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_plan_day ON test_plan(day)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_manual_day ON manual_events(day)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_logs_day ON punch_log(day)`),
  ]);
}

async function getConfig(env) {
  return env.DB.prepare(`
    SELECT active, entry_am, lunch_out, lunch_in, exit_pm, updated_at
    FROM config
    WHERE id = 1
  `).first();
}

// ==================================================
// API
// ==================================================

async function bootstrapResponse(request, env) {
  const url = new URL(request.url);
  const now = new Date();
  const today = getMadridParts(now).date;
  const currentWeekStart = getWeekStart(today);
  const requestedManualDay = url.searchParams.get("manual_day");
  const manualDay = isDateString(requestedManualDay) ? requestedManualDay : today;
  const manualWeekStart = getWeekStart(manualDay);

  const config = await getConfig(env);
  if (!config) throw new HttpError(500, "No se ha encontrado la configuración.");

  await Promise.all([
    ensureWeekPlan(env, currentWeekStart, config),
    manualWeekStart === currentWeekStart
      ? Promise.resolve()
      : ensureWeekPlan(env, manualWeekStart, config),
  ]);

  const weekEnd = addDays(currentWeekStart, 4);

  const [
    meta,
    summaries,
    plans,
    weekVacations,
    weekManual,
    weekPauses,
    allVacations,
    logs,
    manualPlans,
    manualOverrides,
    manualPause,
  ] = await Promise.all([
    env.DB.prepare(`
      SELECT workdays, target_seconds, generated_at
      FROM test_week_meta
      WHERE week_start = ?1
    `).bind(currentWeekStart).first(),
    env.DB.prepare(`
      SELECT day, worked_seconds, deviation_seconds
      FROM test_day_summary
      WHERE week_start = ?1
      ORDER BY day
    `).bind(currentWeekStart).all(),
    env.DB.prepare(`
      SELECT day, event, planned_time, offset_seconds
      FROM test_plan
      WHERE week_start = ?1
      ORDER BY day,
        CASE event
          WHEN 'ENTRY_AM' THEN 1
          WHEN 'LUNCH_OUT' THEN 2
          WHEN 'LUNCH_IN' THEN 3
          WHEN 'EXIT_PM' THEN 4
          ELSE 9
        END
    `).bind(currentWeekStart).all(),
    env.DB.prepare(`
      SELECT date FROM vacations
      WHERE date >= ?1 AND date <= ?2
    `).bind(currentWeekStart, weekEnd).all(),
    env.DB.prepare(`
      SELECT day, event, manual_time
      FROM manual_events
      WHERE day >= ?1 AND day <= ?2
    `).bind(currentWeekStart, weekEnd).all(),
    env.DB.prepare(`
      SELECT day, paused_from_order
      FROM day_pauses
      WHERE day >= ?1 AND day <= ?2
    `).bind(currentWeekStart, weekEnd).all(),
    env.DB.prepare(`SELECT date FROM vacations ORDER BY date`).all(),
    env.DB.prepare(`
      SELECT day, event, scheduled_time, status, executed_at, error
      FROM punch_log
      ORDER BY day DESC, executed_at DESC
      LIMIT 20
    `).all(),
    env.DB.prepare(`
      SELECT event, planned_time
      FROM test_plan
      WHERE week_start = ?1 AND day = ?2
    `).bind(manualWeekStart, manualDay).all(),
    env.DB.prepare(`
      SELECT event, manual_time
      FROM manual_events
      WHERE day = ?1
    `).bind(manualDay).all(),
    env.DB.prepare(`
      SELECT paused_from_order
      FROM day_pauses
      WHERE day = ?1
    `).bind(manualDay).first(),
  ]);

  const week = buildWeekState({
    weekStart: currentWeekStart,
    meta,
    summaries: summaries.results || [],
    plans: plans.results || [],
    vacations: weekVacations.results || [],
    manualRows: weekManual.results || [],
    pauses: weekPauses.results || [],
  });

  const manualState = buildManualDayState({
    day: manualDay,
    planRows: manualPlans.results || [],
    manualRows: manualOverrides.results || [],
    pause: manualPause,
    vacationDates: new Set((allVacations.results || []).map((row) => row.date)),
  });

  return jsonResponse({
    ok: true,
    version: APP_VERSION,
    mode: String(env.MODE || "TEST").toUpperCase(),
    generatedAt: now.toISOString(),
    today,
    config: {
      active: Boolean(config.active),
      entry_am: config.entry_am,
      lunch_out: config.lunch_out,
      lunch_in: config.lunch_in,
      exit_pm: config.exit_pm,
    },
    vacations: (allVacations.results || []).map((row) => row.date),
    week,
    manualDay: manualState,
    logs: (logs.results || []).map((row) => ({
      day: row.day,
      event: row.event,
      label: eventLabel(row.event),
      scheduledTime: row.scheduled_time,
      status: row.status,
      executedAt: row.executed_at,
      error: row.error,
    })),
  });
}

async function updateActive(request, env) {
  const body = await readJson(request);
  const active = Boolean(body.active);

  await env.DB.prepare(`
    UPDATE config
    SET active = ?1, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).bind(active ? 1 : 0).run();

  return jsonResponse({ ok: true, active });
}

async function updateConfig(request, env) {
  const body = await readJson(request);
  const config = {
    entry_am: normalizeTime(body.entry_am),
    lunch_out: normalizeTime(body.lunch_out),
    lunch_in: normalizeTime(body.lunch_in),
    exit_pm: normalizeTime(body.exit_pm),
  };

  if (Object.values(config).some((value) => !value)) {
    throw new HttpError(400, "Formato horario incorrecto.");
  }

  validateBaseSchedule(config);

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE config
      SET entry_am = ?1,
          lunch_out = ?2,
          lunch_in = ?3,
          exit_pm = ?4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).bind(config.entry_am, config.lunch_out, config.lunch_in, config.exit_pm),
    env.DB.prepare(`DELETE FROM test_plan`),
    env.DB.prepare(`DELETE FROM test_day_summary`),
    env.DB.prepare(`DELETE FROM test_week_meta`),
  ]);

  return jsonResponse({ ok: true });
}

async function updateVacations(request, env) {
  const body = await readJson(request);
  const selectedDates = Array.from(new Set(Array.isArray(body.dates) ? body.dates : []))
    .filter(isDateString)
    .filter(isWeekdayDate)
    .sort();

  const existingRows = await env.DB.prepare(`SELECT date FROM vacations`).all();
  const existingDates = (existingRows.results || []).map((row) => row.date);
  const affectedWeeks = new Set(
    [...existingDates, ...selectedDates].map((date) => getWeekStart(date))
  );

  const statements = [env.DB.prepare(`DELETE FROM vacations`)];

  for (const date of selectedDates) {
    statements.push(
      env.DB.prepare(`INSERT INTO vacations (date) VALUES (?1)`).bind(date)
    );
  }

  for (const weekStart of affectedWeeks) {
    statements.push(
      env.DB.prepare(`DELETE FROM test_plan WHERE week_start = ?1`).bind(weekStart),
      env.DB.prepare(`DELETE FROM test_day_summary WHERE week_start = ?1`).bind(weekStart),
      env.DB.prepare(`DELETE FROM test_week_meta WHERE week_start = ?1`).bind(weekStart)
    );
  }

  await env.DB.batch(statements);
  return jsonResponse({ ok: true, dates: selectedDates });
}

async function upsertManualEvent(request, env) {
  const body = await readJson(request);
  const day = String(body.day || "");
  const event = String(body.event || "");
  const manualTime = normalizeTimeWithSeconds(body.manual_time);
  const definition = EVENTS.find((item) => item.event === event);

  if (!isDateString(day)) throw new HttpError(400, "Fecha inválida.");
  if (!isWeekdayDate(day)) throw new HttpError(400, "Solo se admiten días laborables.");
  if (!definition) throw new HttpError(400, "Evento inválido.");
  if (!manualTime) throw new HttpError(400, "Hora manual inválida.");
  if (await isVacation(env, day)) {
    throw new HttpError(400, "El día está marcado como vacaciones.");
  }

  const weekStart = getWeekStart(day);
  const config = await getConfig(env);
  await ensureWeekPlan(env, weekStart, config);

  const effective = await getEffectiveDayTimes(env, weekStart, day, {
    [event]: manualTime,
  });
  const validationError = validateEffectiveTimes(effective);
  if (validationError) throw new HttpError(400, validationError);

  await env.DB.prepare(`
    INSERT INTO manual_events (day, event, manual_time)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(day, event) DO UPDATE SET
      manual_time = excluded.manual_time,
      updated_at = CURRENT_TIMESTAMP
  `).bind(day, event, manualTime).run();

  return jsonResponse({ ok: true });
}

async function removeManualEvent(request, env) {
  const body = await readJson(request);
  const day = String(body.day || "");
  const event = String(body.event || "");
  if (!isDateString(day) || !EVENTS.some((item) => item.event === event)) {
    throw new HttpError(400, "Datos manuales inválidos.");
  }

  await env.DB.prepare(`
    DELETE FROM manual_events
    WHERE day = ?1 AND event = ?2
  `).bind(day, event).run();

  return jsonResponse({ ok: true });
}

async function upsertDayPause(request, env) {
  const body = await readJson(request);
  const day = String(body.day || "");
  const fromEvent = String(body.from_event || "");
  const definition = EVENTS.find((item) => item.event === fromEvent);

  if (!isDateString(day) || !definition) {
    throw new HttpError(400, "Datos de pausa inválidos.");
  }
  if (!isWeekdayDate(day)) throw new HttpError(400, "Solo se admiten días laborables.");
  if (await isVacation(env, day)) {
    throw new HttpError(400, "El día está marcado como vacaciones.");
  }

  await env.DB.prepare(`
    INSERT INTO day_pauses (day, paused_from_order)
    VALUES (?1, ?2)
    ON CONFLICT(day) DO UPDATE SET
      paused_from_order = excluded.paused_from_order,
      updated_at = CURRENT_TIMESTAMP
  `).bind(day, definition.order).run();

  return jsonResponse({ ok: true });
}

async function clearDayPause(request, env) {
  const body = await readJson(request);
  const day = String(body.day || "");
  if (!isDateString(day)) throw new HttpError(400, "Fecha inválida.");

  await env.DB.prepare(`DELETE FROM day_pauses WHERE day = ?1`).bind(day).run();
  return jsonResponse({ ok: true });
}

async function regenerateWeek(request, env) {
  const body = await readJson(request);
  const day = isDateString(body.day) ? body.day : getMadridParts(new Date()).date;
  const weekStart = getWeekStart(day);
  const config = await getConfig(env);
  await generateWeekPlan(env, weekStart, config);
  return jsonResponse({ ok: true, weekStart });
}

// ==================================================
// WEEK PLAN
// ==================================================

async function ensureWeekPlan(env, weekStart, config = null) {
  const existing = await env.DB.prepare(`
    SELECT week_start FROM test_week_meta WHERE week_start = ?1
  `).bind(weekStart).first();

  if (!existing) {
    await generateWeekPlan(env, weekStart, config || (await getConfig(env)));
  }
}

async function generateWeekPlan(env, weekStart, config) {
  if (!config) throw new HttpError(500, "No se ha encontrado la configuración.");
  validateBaseSchedule(config);

  const weekdays = Array.from({ length: 5 }, (_, index) =>
    addDays(weekStart, index)
  );

  const vacationRows = await env.DB.prepare(`
    SELECT date FROM vacations
    WHERE date >= ?1 AND date <= ?2
  `).bind(weekdays[0], weekdays[4]).all();

  const vacationSet = new Set(
    (vacationRows.results || []).map((row) => row.date)
  );
  const workDates = weekdays.filter((date) => !vacationSet.has(date));
  const deviations = generateDailyDeviations(workDates.length);

  const base = {
    ENTRY_AM: config.entry_am,
    LUNCH_OUT: config.lunch_out,
    LUNCH_IN: config.lunch_in,
    EXIT_PM: config.exit_pm,
  };

  const statements = [
    env.DB.prepare(`DELETE FROM test_plan WHERE week_start = ?1`).bind(weekStart),
    env.DB.prepare(`DELETE FROM test_day_summary WHERE week_start = ?1`).bind(weekStart),
    env.DB.prepare(`DELETE FROM test_week_meta WHERE week_start = ?1`).bind(weekStart),
  ];

  let weeklySeconds = 0;

  for (let index = 0; index < workDates.length; index++) {
    const day = workDates[index];
    const deviation = deviations[index];
    const offsets = generateOffsetsForDeviation(base, deviation);
    const planned = {
      ENTRY_AM: addSecondsToTime(base.ENTRY_AM, offsets.ENTRY_AM),
      LUNCH_OUT: addSecondsToTime(base.LUNCH_OUT, offsets.LUNCH_OUT),
      LUNCH_IN: addSecondsToTime(base.LUNCH_IN, offsets.LUNCH_IN),
      EXIT_PM: addSecondsToTime(base.EXIT_PM, offsets.EXIT_PM),
    };

    const actualBreak =
      timeToSeconds(planned.LUNCH_IN) - timeToSeconds(planned.LUNCH_OUT);
    if (actualBreak < MIN_BREAK_SECONDS) {
      throw new Error("El generador ha producido un descanso inferior a una hora.");
    }

    const workedSeconds =
      timeToSeconds(planned.LUNCH_OUT) - timeToSeconds(planned.ENTRY_AM) +
      timeToSeconds(planned.EXIT_PM) - timeToSeconds(planned.LUNCH_IN);

    if (workedSeconds !== DAILY_TARGET_SECONDS + deviation) {
      throw new Error("El total diario generado no coincide con su desviación.");
    }

    weeklySeconds += workedSeconds;

    for (const definition of EVENTS) {
      statements.push(
        env.DB.prepare(`
          INSERT INTO test_plan (
            week_start, day, event, base_time, planned_time, offset_seconds
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `).bind(
          weekStart,
          day,
          definition.event,
          base[definition.event],
          planned[definition.event],
          offsets[definition.event]
        )
      );
    }

    statements.push(
      env.DB.prepare(`
        INSERT INTO test_day_summary (
          week_start, day, worked_seconds, deviation_seconds
        ) VALUES (?1, ?2, ?3, ?4)
      `).bind(weekStart, day, workedSeconds, deviation)
    );
  }

  const targetSeconds = workDates.length * DAILY_TARGET_SECONDS;
  if (weeklySeconds !== targetSeconds) {
    throw new Error(
      `El total semanal generado (${weeklySeconds}) no coincide con el objetivo (${targetSeconds}).`
    );
  }

  statements.push(
    env.DB.prepare(`
      INSERT INTO test_week_meta (
        week_start, workdays, target_seconds
      ) VALUES (?1, ?2, ?3)
    `).bind(weekStart, workDates.length, targetSeconds)
  );

  await env.DB.batch(statements);
}

function generateDailyDeviations(workdays) {
  if (workdays === 0) return [];
  if (workdays === 1) return [0];

  for (let attempt = 0; attempt < 10000; attempt++) {
    const deviations = [];

    for (let index = 0; index < workdays - 1; index++) {
      deviations.push(
        randomInt(
          -MAX_DAILY_DEVIATION_SECONDS,
          MAX_DAILY_DEVIATION_SECONDS
        )
      );
    }

    const finalDeviation = -deviations.reduce(
      (sum, value) => sum + value,
      0
    );

    if (
      finalDeviation >= -MAX_DAILY_DEVIATION_SECONDS &&
      finalDeviation <= MAX_DAILY_DEVIATION_SECONDS
    ) {
      deviations.push(finalDeviation);
      shuffle(deviations);
      return deviations;
    }
  }

  throw new Error("No se ha podido generar una semana equilibrada.");
}

function generateOffsetsForDeviation(base, targetDeviation) {
  const baseLunchOut = timeToSeconds(base.LUNCH_OUT);
  const baseLunchIn = timeToSeconds(base.LUNCH_IN);

  for (let attempt = 0; attempt < 20000; attempt++) {
    const entryAM = randomInt(0, MAX_OFFSET_SECONDS);
    const lunchIn = randomInt(0, MAX_OFFSET_SECONDS);
    const exitPM = randomInt(0, MAX_OFFSET_SECONDS);
    const lunchOut = targetDeviation - exitPM + lunchIn + entryAM;

    if (lunchOut < 0 || lunchOut > MAX_OFFSET_SECONDS) continue;

    const actualBreak =
      baseLunchIn + lunchIn - (baseLunchOut + lunchOut);
    if (actualBreak < MIN_BREAK_SECONDS) continue;

    return {
      ENTRY_AM: entryAM,
      LUNCH_OUT: lunchOut,
      LUNCH_IN: lunchIn,
      EXIT_PM: exitPM,
    };
  }

  throw new Error(
    `No se han podido generar offsets válidos para ${targetDeviation} segundos.`
  );
}

// ==================================================
// STATE BUILDERS
// ==================================================

function buildWeekState({
  weekStart,
  meta,
  summaries,
  plans,
  vacations,
  manualRows,
  pauses,
}) {
  const vacationSet = new Set(vacations.map((row) => row.date));
  const summaryMap = new Map(summaries.map((row) => [row.day, row]));
  const pauseMap = new Map(
    pauses.map((row) => [row.day, Number(row.paused_from_order)])
  );

  const planMap = new Map();
  for (const row of plans) {
    if (!planMap.has(row.day)) planMap.set(row.day, {});
    planMap.get(row.day)[row.event] = row.planned_time;
  }

  const manualMap = new Map();
  for (const row of manualRows) {
    if (!manualMap.has(row.day)) manualMap.set(row.day, {});
    manualMap.get(row.day)[row.event] = row.manual_time;
  }

  let effectiveTotal = 0;
  let complete = true;

  const days = Array.from({ length: 5 }, (_, index) => {
    const date = addDays(weekStart, index);
    const vacation = vacationSet.has(date);

    if (vacation) {
      return {
        date,
        label: weekdayName(date),
        vacation: true,
        plan: {},
        manual: {},
        pauseFromOrder: null,
        baseSeconds: 0,
        deviationSeconds: 0,
        effectiveSeconds: 0,
        effectiveComplete: true,
      };
    }

    const plan = planMap.get(date) || {};
    const manual = manualMap.get(date) || {};
    const pauseFromOrder = pauseMap.get(date) || null;
    const summary = summaryMap.get(date);
    const effectiveTimes = { ...plan, ...manual };
    let effectiveComplete = true;

    if (pauseFromOrder) {
      for (const definition of EVENTS) {
        if (
          definition.order >= pauseFromOrder &&
          !Object.prototype.hasOwnProperty.call(manual, definition.event)
        ) {
          effectiveComplete = false;
        }
      }
    }

    const validationError = validateEffectiveTimes(effectiveTimes);
    if (validationError || !hasAllEvents(effectiveTimes)) {
      effectiveComplete = false;
    }

    let effectiveSeconds = null;
    if (effectiveComplete) {
      effectiveSeconds = calculateWorkedSeconds(effectiveTimes);
      effectiveTotal += effectiveSeconds;
    } else {
      complete = false;
    }

    return {
      date,
      label: weekdayName(date),
      vacation: false,
      plan,
      manual,
      pauseFromOrder,
      baseSeconds: Number(summary?.worked_seconds || 0),
      deviationSeconds: Number(summary?.deviation_seconds || 0),
      effectiveSeconds,
      effectiveComplete,
    };
  });

  const targetSeconds = Number(meta?.target_seconds || 0);

  return {
    start: weekStart,
    end: addDays(weekStart, 4),
    workdays: Number(meta?.workdays || 0),
    targetSeconds,
    effectiveTotal: complete ? effectiveTotal : null,
    adjustmentSeconds: complete ? effectiveTotal - targetSeconds : null,
    complete,
    days,
  };
}

function buildManualDayState({
  day,
  planRows,
  manualRows,
  pause,
  vacationDates,
}) {
  const plan = Object.fromEntries(
    planRows.map((row) => [row.event, row.planned_time])
  );
  const manual = Object.fromEntries(
    manualRows.map((row) => [row.event, row.manual_time])
  );
  const effective = { ...plan, ...manual };
  const validationError = validateEffectiveTimes(effective);
  const complete = !validationError && hasAllEvents(effective);

  return {
    date: day,
    vacation: vacationDates.has(day),
    plan,
    manual,
    effective,
    pauseFromOrder: pause ? Number(pause.paused_from_order) : null,
    complete,
    error: validationError,
    workedSeconds: complete ? calculateWorkedSeconds(effective) : null,
    adjustmentSeconds: complete
      ? calculateWorkedSeconds(effective) - DAILY_TARGET_SECONDS
      : null,
  };
}

async function getEffectiveDayTimes(env, weekStart, day, overrides = {}) {
  const [planRows, manualRows] = await Promise.all([
    env.DB.prepare(`
      SELECT event, planned_time FROM test_plan
      WHERE week_start = ?1 AND day = ?2
    `).bind(weekStart, day).all(),
    env.DB.prepare(`
      SELECT event, manual_time FROM manual_events
      WHERE day = ?1
    `).bind(day).all(),
  ]);

  const result = {};
  for (const row of planRows.results || []) result[row.event] = row.planned_time;
  for (const row of manualRows.results || []) result[row.event] = row.manual_time;
  for (const [event, time] of Object.entries(overrides)) result[event] = time;
  return result;
}

function validateBaseSchedule(config) {
  const entry = timeToSeconds(config.entry_am);
  const lunchOut = timeToSeconds(config.lunch_out);
  const lunchIn = timeToSeconds(config.lunch_in);
  const exit = timeToSeconds(config.exit_pm);

  if (!(entry < lunchOut && lunchOut < lunchIn && lunchIn < exit)) {
    throw new HttpError(400, "Las cuatro horas deben estar en orden cronológico.");
  }

  if (lunchIn - lunchOut < MIN_BREAK_SECONDS) {
    throw new HttpError(400, "El descanso de mediodía debe ser como mínimo de una hora.");
  }

  const workedSeconds = lunchOut - entry + exit - lunchIn;
  if (workedSeconds !== DAILY_TARGET_SECONDS) {
    throw new HttpError(
      400,
      `El horario base suma ${formatDuration(workedSeconds)}; debe sumar 8:00:00.`
    );
  }
}

function validateEffectiveTimes(times) {
  if (!hasAllEvents(times)) return null;

  const entry = timeToSeconds(times.ENTRY_AM);
  const lunchOut = timeToSeconds(times.LUNCH_OUT);
  const lunchIn = timeToSeconds(times.LUNCH_IN);
  const exit = timeToSeconds(times.EXIT_PM);

  if (!(entry < lunchOut && lunchOut < lunchIn && lunchIn < exit)) {
    return "Las marcas deben mantener el orden cronológico del día.";
  }

  if (lunchIn - lunchOut < MIN_BREAK_SECONDS) {
    return "El descanso real debe seguir siendo de al menos una hora.";
  }

  return null;
}

function calculateWorkedSeconds(times) {
  return (
    timeToSeconds(times.LUNCH_OUT) - timeToSeconds(times.ENTRY_AM) +
    timeToSeconds(times.EXIT_PM) - timeToSeconds(times.LUNCH_IN)
  );
}

function hasAllEvents(times) {
  return EVENTS.every((definition) => Boolean(times[definition.event]));
}

// ==================================================
// SCHEDULER
// ==================================================

async function runScheduler(env, scheduledAt, actualNow) {
  await ensureSchemaOnce(env);
  const config = await getConfig(env);
  if (!config || !config.active) return;

  const scheduledLocal = getMadridParts(scheduledAt);
  if (scheduledLocal.weekday === 0 || scheduledLocal.weekday === 6) return;
  if (await isVacation(env, scheduledLocal.date)) return;

  const weekStart = getWeekStart(scheduledLocal.date);
  await ensureWeekPlan(env, weekStart, config);

  const [plan, pause, manualRows] = await Promise.all([
    env.DB.prepare(`
      SELECT event, planned_time
      FROM test_plan
      WHERE week_start = ?1 AND day = ?2
    `).bind(weekStart, scheduledLocal.date).all(),
    env.DB.prepare(`
      SELECT paused_from_order
      FROM day_pauses
      WHERE day = ?1
    `).bind(scheduledLocal.date).first(),
    env.DB.prepare(`
      SELECT event FROM manual_events WHERE day = ?1
    `).bind(scheduledLocal.date).all(),
  ]);

  const manualEvents = new Set(
    (manualRows.results || []).map((row) => row.event)
  );
  const scheduledMinute = scheduledLocal.hour * 60 + scheduledLocal.minute;
  const actualLocal = getMadridParts(actualNow);

  for (const row of plan.results || []) {
    const definition = EVENTS.find((item) => item.event === row.event);
    if (!definition) continue;
    if (pause && definition.order >= Number(pause.paused_from_order)) continue;
    if (manualEvents.has(row.event)) continue;

    const plannedSeconds = timeToSeconds(row.planned_time);
    const plannedMinute = Math.floor(plannedSeconds / 60);
    if (plannedMinute !== scheduledMinute) continue;
    if (actualLocal.date !== scheduledLocal.date) continue;

    const actualSeconds =
      actualLocal.hour * 3600 + actualLocal.minute * 60 + actualLocal.second;
    const waitSeconds = plannedSeconds - actualSeconds;
    const latenessSeconds = actualSeconds - plannedSeconds;

    if (latenessSeconds > 240) continue;
    if (waitSeconds > 0) {
      await sleep(Math.min(waitSeconds, 59) * 1000);
    }

    await processEvent(
      env,
      scheduledLocal.date,
      row.event,
      row.planned_time,
      new Date()
    );
  }
}

async function processEvent(env, day, event, scheduledTime, now) {
  const mode = String(env.MODE || "TEST").toUpperCase();
  const existing = await env.DB.prepare(`
    SELECT status, scheduled_time
    FROM punch_log
    WHERE day = ?1 AND event = ?2
  `).bind(day, event).first();

  if (existing?.status === "SUCCESS") return;
  if (existing?.status === "PENDING") return;
  if (
    mode !== "LIVE" &&
    existing?.status === "TEST" &&
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
    await clockWoffu(env, event, now);
    const finalStatus = mode === "LIVE" ? "SUCCESS" : "TEST";

    await env.DB.prepare(`
      UPDATE punch_log
      SET status = ?3,
          executed_at = CURRENT_TIMESTAMP,
          error = NULL
      WHERE day = ?1 AND event = ?2
    `).bind(day, event, finalStatus).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'FAILED',
          executed_at = CURRENT_TIMESTAMP,
          error = ?3
      WHERE day = ?1 AND event = ?2
    `).bind(day, event, message.substring(0, 500)).run();
  }
}

async function clockWoffu(env, event, now) {
  const mode = String(env.MODE || "TEST").toUpperCase();

  if (mode !== "LIVE") {
    console.log(`[TEST] ${event} - ${now.toISOString()}`);
    return;
  }

  throw new Error("WOFFU_ADAPTER_NOT_CONFIGURED");
}

async function isVacation(env, date) {
  const row = await env.DB.prepare(`
    SELECT date FROM vacations WHERE date = ?1
  `).bind(date).first();
  return Boolean(row);
}

// ==================================================
// STATIC APP SHELL
// ==================================================

function appShell() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0b0d12">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Woffu Clock">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <title>Woffu Clock</title>
  <style>
    :root {
      color-scheme: light;
      --bg:#f4f5f7;
      --surface:#ffffff;
      --surface-2:#f8f8fa;
      --text:#13151a;
      --muted:#6e7480;
      --line:#e7e8ec;
      --brand:#151922;
      --green:#137a3b;
      --green-soft:#eaf7ef;
      --red:#b42318;
      --red-soft:#fff0ee;
      --amber:#a45d00;
      --amber-soft:#fff5df;
      --blue:#2457d6;
      --radius:18px;
      --shadow:0 1px 2px rgba(13,18,28,.05),0 8px 24px rgba(13,18,28,.04);
      --tap:48px;
    }

    *{box-sizing:border-box}
    html{background:var(--bg);scroll-behavior:smooth}
    body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    button,input,select{font:inherit}
    button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    .app{min-height:100dvh}
    .topbar{position:sticky;top:0;z-index:30;padding:calc(12px + env(safe-area-inset-top)) 16px 12px;background:rgba(244,245,247,.9);backdrop-filter:blur(18px);border-bottom:1px solid rgba(231,232,236,.75)}
    .topbarInner{max-width:980px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .brand{display:flex;align-items:center;gap:10px;min-width:0}
    .logo{width:38px;height:38px;border-radius:12px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:850;letter-spacing:-.04em;box-shadow:var(--shadow)}
    .brandText{min-width:0}.brandText strong{display:block;font-size:16px;line-height:1.1}.brandText span{display:block;color:var(--muted);font-size:11px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .statusPill{height:36px;padding:0 12px;border-radius:999px;display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--line);font-size:13px;font-weight:750;box-shadow:0 1px 2px rgba(0,0,0,.03)}
    .statusDot{width:8px;height:8px;border-radius:50%;background:#9ba0aa}.statusPill.on .statusDot{background:var(--green);box-shadow:0 0 0 4px rgba(19,122,59,.12)}.statusPill.off .statusDot{background:var(--red)}
    .layout{max-width:980px;margin:auto;padding:14px 14px calc(92px + env(safe-area-inset-bottom))}
    .view{display:none;animation:fade .16s ease}.view.active{display:block}
    @keyframes fade{from{opacity:.4;transform:translateY(3px)}to{opacity:1;transform:none}}
    .hero{border-radius:24px;padding:22px;background:linear-gradient(145deg,#11151d,#242b39);color:#fff;box-shadow:0 14px 40px rgba(19,24,34,.18);margin-bottom:14px;position:relative;overflow:hidden}
    .hero:after{content:"";position:absolute;width:180px;height:180px;border-radius:50%;right:-80px;top:-90px;background:rgba(255,255,255,.07)}
    .eyebrow{font-size:12px;color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.08em;font-weight:750}
    .heroValue{font-size:34px;line-height:1;font-weight:850;letter-spacing:-.04em;margin:8px 0 7px}.heroSub{font-size:14px;color:rgba(255,255,255,.72)}
    .heroActions{display:flex;gap:9px;margin-top:18px;position:relative;z-index:1}.heroActions button{flex:1}
    .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:14px}
    .metric{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:13px;min-width:0}.metricLabel{color:var(--muted);font-size:11px;font-weight:700}.metricValue{font-size:18px;font-weight:820;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metricValue.positive{color:var(--green)}.metricValue.negative{color:var(--red)}
    .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:17px;margin-bottom:12px;box-shadow:var(--shadow)}
    .cardHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:13px}.cardTitle{margin:0;font-size:18px;letter-spacing:-.02em}.cardHint{margin:4px 0 0;color:var(--muted);font-size:13px;line-height:1.4}
    .weekStrip{display:grid;gap:8px}.dayCard{border:1px solid var(--line);background:var(--surface-2);border-radius:15px;padding:13px}.dayCard.vacation{background:var(--amber-soft);border-color:#f1d49d}.dayHead{display:flex;align-items:center;justify-content:space-between;gap:10px}.dayName{font-weight:800}.dayDate{color:var(--muted);font-size:12px}.dayTotal{font-weight:820;font-size:14px}.eventGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:11px}.eventChip{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:8px 6px;text-align:center;min-width:0}.eventChip span{display:block;font-size:10px;color:var(--muted);margin-bottom:3px}.eventChip strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eventChip.manual{border-color:#9db5f8;background:#f3f6ff}
    .sectionTitle{font-size:24px;letter-spacing:-.035em;margin:4px 2px 5px}.sectionLead{color:var(--muted);font-size:14px;margin:0 2px 16px;line-height:1.45}
    .calendarToolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.calendarTitle{font-size:17px;font-weight:820;text-align:center}.iconButton{width:var(--tap);height:var(--tap);border:1px solid var(--line);background:var(--surface-2);border-radius:14px;font-size:19px;margin:0;padding:0;color:var(--text)}
    .calendarGrid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}.weekday{text-align:center;color:var(--muted);font-size:11px;font-weight:750;padding:7px 0}.calBlank{aspect-ratio:1}.calDay{aspect-ratio:1;border:0;border-radius:12px;background:var(--surface-2);color:var(--text);margin:0;padding:0;display:grid;place-items:center;position:relative;font-weight:680;transition:transform .08s ease,background .12s ease}.calDay:active{transform:scale(.92)}.calDay.selected{background:var(--brand);color:#fff}.calDay.today:after{content:"";position:absolute;bottom:5px;width:4px;height:4px;border-radius:50%;background:var(--blue)}.calDay.selected.today:after{background:#fff}.calDay.weekend{opacity:.28}.calendarSave{position:sticky;bottom:calc(76px + env(safe-area-inset-bottom));z-index:10;margin-top:14px;padding:10px;background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:16px;backdrop-filter:blur(14px);display:flex;align-items:center;gap:10px}.calendarSave span{font-size:12px;color:var(--muted);flex:1}.calendarSave button{width:auto;min-width:130px}
    .formGrid{display:grid;gap:12px}.field label{display:block;font-size:12px;font-weight:760;margin-bottom:6px;color:#4f5560}.input{width:100%;height:var(--tap);border:1px solid var(--line);border-radius:13px;background:var(--surface-2);padding:0 13px;color:var(--text);outline:none}.input:focus{border-color:#839cea;box-shadow:0 0 0 3px rgba(36,87,214,.1)}
    .button{min-height:var(--tap);border:0;border-radius:13px;padding:0 15px;font-weight:780;margin:0;cursor:pointer}.button.primary{background:var(--brand);color:#fff}.button.secondary{background:var(--surface-2);color:var(--text);border:1px solid var(--line)}.button.success{background:var(--green);color:#fff}.button.danger{background:var(--red);color:#fff}.button.ghost{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.18)}.button:disabled{opacity:.42;cursor:default}.button.loading{pointer-events:none;opacity:.65}
    .rowActions{display:flex;gap:9px}.rowActions .button{flex:1}
    .manualList{display:grid;gap:8px;margin-top:13px}.manualItem{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:13px;padding:11px}.manualMain{min-width:0}.manualMain strong{display:block;font-size:14px}.manualMain span{display:block;color:var(--muted);font-size:12px;margin-top:3px}.smallButton{border:0;border-radius:10px;padding:8px 10px;background:var(--red-soft);color:var(--red);font-size:12px;font-weight:750;margin:0;width:auto}
    .notice{border-radius:13px;padding:12px 13px;font-size:13px;line-height:1.4}.notice.test{background:var(--amber-soft);color:#704300}.notice.ok{background:var(--green-soft);color:#095c2a}.notice.pending{background:var(--red-soft);color:#842018}
    .logs{display:grid;gap:7px}.log{display:grid;grid-template-columns:1fr auto;gap:8px;border-bottom:1px solid var(--line);padding:9px 0}.log:last-child{border-bottom:0}.log strong{font-size:13px}.log span{font-size:12px;color:var(--muted)}.logStatus{font-size:11px;font-weight:800;padding:5px 8px;border-radius:999px;background:var(--surface-2);align-self:center}
    .bottomNav{position:fixed;z-index:40;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));height:64px;background:rgba(20,23,30,.94);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.09);border-radius:20px;padding:6px;display:grid;grid-template-columns:repeat(4,1fr);gap:3px;box-shadow:0 12px 34px rgba(0,0,0,.24)}.navButton{border:0;background:transparent;color:rgba(255,255,255,.58);border-radius:15px;margin:0;padding:5px 2px;font-size:10px;font-weight:700;display:grid;place-items:center;gap:2px}.navButton .navIcon{font-size:19px;line-height:1}.navButton.active{background:rgba(255,255,255,.13);color:#fff}
    .toast{position:fixed;z-index:70;left:50%;bottom:calc(86px + env(safe-area-inset-bottom));transform:translate(-50%,20px);max-width:calc(100vw - 28px);padding:11px 14px;border-radius:13px;background:#151922;color:#fff;font-size:13px;font-weight:680;opacity:0;pointer-events:none;transition:.2s ease;box-shadow:0 12px 30px rgba(0,0,0,.28)}.toast.show{opacity:1;transform:translate(-50%,0)}.toast.error{background:#8e1c15}
    .skeleton{position:relative;overflow:hidden;background:#eceef2!important;color:transparent!important;border-color:transparent!important}.skeleton:after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.62),transparent);animation:shine 1.15s infinite}@keyframes shine{to{transform:translateX(100%)}}
    .loadingScreen{display:grid;gap:10px}.loadingBlock{height:98px;border-radius:18px}
    .desktopNav{display:none}
    @media(min-width:760px){.layout{padding:22px 22px 40px}.app{display:grid;grid-template-columns:210px minmax(0,1fr);max-width:1200px;margin:auto}.topbar{grid-column:1/-1}.desktopNav{display:block;position:sticky;top:90px;align-self:start;padding:18px 10px}.desktopNav .navButton{color:var(--muted);height:50px;display:flex;justify-content:flex-start;padding:0 14px;font-size:14px;margin-bottom:5px}.desktopNav .navButton.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}.desktopNav .navIcon{width:24px;text-align:center}.bottomNav{display:none}.metrics{grid-template-columns:repeat(3,1fr)}.weekStrip{grid-template-columns:repeat(2,minmax(0,1fr))}.formGrid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.calendarSave{bottom:16px}.toast{bottom:24px}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
  </style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="topbarInner">
      <div class="brand">
        <div class="logo">W</div>
        <div class="brandText"><strong>Woffu Clock</strong><span id="versionText">${APP_VERSION}</span></div>
      </div>
      <button id="quickToggle" class="statusPill off" type="button" aria-label="Cambiar estado">
        <span class="statusDot"></span><span id="statusText">Cargando</span>
      </button>
    </div>
  </header>

  <aside class="desktopNav" aria-label="Navegación principal">
    ${navButtons("desktop")}
  </aside>

  <main class="layout">
    <section id="view-home" class="view active">
      <div id="homeContent" class="loadingScreen">
        <div class="loadingBlock skeleton"></div>
        <div class="metrics"><div class="metric skeleton">.</div><div class="metric skeleton">.</div><div class="metric skeleton">.</div></div>
        <div class="loadingBlock skeleton"></div>
      </div>
    </section>

    <section id="view-calendar" class="view">
      <h1 class="sectionTitle">Vacaciones</h1>
      <p class="sectionLead">Selecciona días de distintos meses sin recargar la pantalla. Se guardan todos juntos.</p>
      <div class="card">
        <div class="calendarToolbar">
          <button id="calendarPrev" class="iconButton" type="button">←</button>
          <div id="calendarTitle" class="calendarTitle"></div>
          <button id="calendarNext" class="iconButton" type="button">→</button>
        </div>
        <div id="calendarGrid" class="calendarGrid"></div>
        <div class="calendarSave">
          <span id="calendarStatus">Sin cambios pendientes</span>
          <button id="saveVacations" class="button primary" type="button" disabled>Guardar</button>
        </div>
      </div>
    </section>

    <section id="view-manual" class="view">
      <h1 class="sectionTitle">Control manual</h1>
      <p class="sectionLead">Pausa una parte del día, registra una marca manual y conserva el resto del plan.</p>
      <div id="manualContent"></div>
    </section>

    <section id="view-settings" class="view">
      <h1 class="sectionTitle">Configuración</h1>
      <p class="sectionLead">Horario base, estado global y diagnóstico de la automatización.</p>
      <div id="settingsContent"></div>
    </section>
  </main>

  <nav class="bottomNav" aria-label="Navegación principal">
    ${navButtons("mobile")}
  </nav>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${clientScript()}
</script>
</body>
</html>`;
}

function navButtons(scope) {
  return [
    ["home", "⌂", "Resumen"],
    ["calendar", "□", "Vacaciones"],
    ["manual", "◷", "Manual"],
    ["settings", "⚙", "Ajustes"],
  ].map(([view, icon, label], index) => `
    <button type="button" class="navButton ${index === 0 ? "active" : ""}" data-view="${view}" data-scope="${scope}">
      <span class="navIcon">${icon}</span><span>${label}</span>
    </button>
  `).join("");
}

function clientScript() {
  return `(${clientApp.toString()})();`;
}

function clientApp() {
  "use strict";

  const EVENTS = [
    { event: "ENTRY_AM", label: "Entrada mañana", shortLabel: "Entrada", order: 1 },
    { event: "LUNCH_OUT", label: "Salida mediodía", shortLabel: "Pausa", order: 2 },
    { event: "LUNCH_IN", label: "Entrada mediodía", shortLabel: "Vuelta", order: 3 },
    { event: "EXIT_PM", label: "Salida tarde", shortLabel: "Salida", order: 4 },
  ];

  const CACHE_KEY = "woffu-clock-dashboard-v3";
  const state = {
    data: null,
    currentView: "home",
    calendarMonth: null,
    vacationSelected: new Set(),
    vacationBaseline: new Set(),
    manualDay: null,
    busy: false,
  };

  const els = {
    toast: document.getElementById("toast"),
    statusText: document.getElementById("statusText"),
    quickToggle: document.getElementById("quickToggle"),
    home: document.getElementById("homeContent"),
    manual: document.getElementById("manualContent"),
    settings: document.getElementById("settingsContent"),
    calendarGrid: document.getElementById("calendarGrid"),
    calendarTitle: document.getElementById("calendarTitle"),
    calendarStatus: document.getElementById("calendarStatus"),
    saveVacations: document.getElementById("saveVacations"),
  };

  bindNavigation();
  bindGlobalActions();
  restoreCache();
  loadData({ silent: Boolean(state.data) });

  function bindNavigation() {
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });

    document.getElementById("calendarPrev").addEventListener("click", () => {
      state.calendarMonth = shiftMonth(state.calendarMonth, -1);
      renderCalendar();
    });

    document.getElementById("calendarNext").addEventListener("click", () => {
      state.calendarMonth = shiftMonth(state.calendarMonth, 1);
      renderCalendar();
    });

    els.saveVacations.addEventListener("click", saveVacations);
    els.quickToggle.addEventListener("click", toggleActive);
  }

  function bindGlobalActions() {
    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;

      const action = button.dataset.action;
      if (action === "toggle-active") return toggleActive(button);
      if (action === "regenerate") return regenerateWeek(button);
      if (action === "remove-manual") return removeManual(button);
      if (action === "clear-pause") return clearPause(button);
      if (action === "go-manual") {
        state.manualDay = button.dataset.day;
        setView("manual");
        return loadData({ manualDay: state.manualDay });
      }
    });

    document.addEventListener("submit", async (event) => {
      if (event.target.id === "configForm") {
        event.preventDefault();
        return saveConfig(event.target);
      }

      if (event.target.id === "manualForm") {
        event.preventDefault();
        return saveManual(event.target);
      }

      if (event.target.id === "pauseForm") {
        event.preventDefault();
        return savePause(event.target);
      }

      if (event.target.id === "manualDateForm") {
        event.preventDefault();
        const form = new FormData(event.target);
        state.manualDay = String(form.get("manual_day") || "");
        return loadData({ manualDay: state.manualDay });
      }
    });

    document.addEventListener("change", (event) => {
      if (event.target.id === "manualDayInput") {
        state.manualDay = event.target.value;
        loadData({ manualDay: state.manualDay, silent: true });
      }
    });
  }

  function setView(view) {
    state.currentView = view;
    document.querySelectorAll(".view").forEach((section) => {
      section.classList.toggle("active", section.id === "view-" + view);
    });
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function restoreCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!cached || !cached.version || !cached.week) return;
      state.data = cached;
      state.manualDay = cached.manualDay?.date || cached.today;
      state.calendarMonth = String(cached.today || "").slice(0, 7);
      resetVacations(cached.vacations || []);
      renderAll(true);
    } catch {
      localStorage.removeItem(CACHE_KEY);
    }
  }

  async function loadData(options = {}) {
    const manualDay = options.manualDay || state.manualDay || "";
    const params = new URLSearchParams();
    if (manualDay) params.set("manual_day", manualDay);
    params.set("_", String(Date.now()));

    try {
      if (!options.silent && !state.data) showLoading();
      const data = await api("/api/bootstrap?" + params.toString());
      state.data = data;
      state.manualDay = data.manualDay?.date || data.today;
      if (!state.calendarMonth) state.calendarMonth = String(data.today).slice(0, 7);

      const vacationDirty = vacationDifferenceCount() > 0;
      if (!vacationDirty) resetVacations(data.vacations || []);

      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      renderAll(false);
    } catch (error) {
      toast(error.message || "No se han podido cargar los datos.", true);
      if (!state.data) showFatal(error.message);
    }
  }

  async function api(path, options = {}) {
    const init = {
      method: options.method || "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    };

    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, init);
    const contentType = response.headers.get("Content-Type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : { error: await response.text() };

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || "La operación no ha podido completarse.");
    }

    return payload;
  }

  function renderAll(fromCache) {
    if (!state.data) return;
    renderHeader(fromCache);
    renderHome();
    renderCalendar();
    renderManual();
    renderSettings();
  }

  function renderHeader(fromCache) {
    const active = Boolean(state.data.config?.active);
    els.quickToggle.classList.toggle("on", active);
    els.quickToggle.classList.toggle("off", !active);
    els.statusText.textContent = active ? "Activa" : "Pausada";
    els.quickToggle.title = active ? "Pausar automatización" : "Activar automatización";
    document.getElementById("versionText").textContent =
      state.data.version + (fromCache ? " · actualizando" : "");
  }

  function renderHome() {
    const data = state.data;
    const week = data.week;
    const total = week.complete ? formatDuration(week.effectiveTotal) : "Pendiente";
    const adjustment = week.complete
      ? formatSignedDuration(week.adjustmentSeconds)
      : "Pendiente";
    const adjustmentClass = week.complete
      ? week.adjustmentSeconds > 0
        ? "positive"
        : week.adjustmentSeconds < 0
          ? "negative"
          : ""
      : "";

    const dayCards = week.days.map((day) => {
      if (day.vacation) {
        return '<article class="dayCard vacation">' +
          '<div class="dayHead"><div><div class="dayName">' + escapeHtml(day.label) +
          '</div><div class="dayDate">' + formatDate(day.date) +
          '</div></div><div class="dayTotal">🏖 Vacaciones</div></div></article>';
      }

      const effective = Object.assign({}, day.plan || {}, day.manual || {});
      const chips = EVENTS.map((definition) => {
        const manual = Object.prototype.hasOwnProperty.call(day.manual || {}, definition.event);
        const time = effective[definition.event] || "—";
        return '<div class="eventChip ' + (manual ? "manual" : "") + '">' +
          '<span>' + escapeHtml(definition.shortLabel) + '</span>' +
          '<strong>' + escapeHtml(time) + '</strong></div>';
      }).join("");

      const effectiveLabel = day.effectiveComplete
        ? formatDuration(day.effectiveSeconds)
        : "Pendiente";
      const pauseLabel = day.pauseFromOrder
        ? '<div class="notice pending" style="margin-top:9px">Pausada desde ' +
          escapeHtml(eventByOrder(day.pauseFromOrder)?.label || "una marca") + '</div>'
        : "";

      return '<article class="dayCard">' +
        '<div class="dayHead"><div><div class="dayName">' + escapeHtml(day.label) +
        '</div><div class="dayDate">' + formatDate(day.date) +
        '</div></div><div class="dayTotal">' + effectiveLabel + '</div></div>' +
        '<div class="eventGrid">' + chips + '</div>' + pauseLabel +
        '<button class="button secondary" style="width:100%;margin-top:10px" data-action="go-manual" data-day="' +
        escapeHtml(day.date) + '">Gestionar este día</button></article>';
    }).join("");

    els.home.innerHTML =
      '<section class="hero">' +
        '<div class="eyebrow">Total semanal previsto</div>' +
        '<div class="heroValue">' + total + '</div>' +
        '<div class="heroSub">Objetivo base: ' + formatDuration(week.targetSeconds) +
        ' · ' + week.workdays + ' día(s) de trabajo</div>' +
        '<div class="heroActions">' +
          '<button class="button ghost" data-action="toggle-active">' +
          (data.config.active ? "Pausar" : "Activar") + '</button>' +
          '<button class="button ghost" data-action="regenerate">Regenerar semana</button>' +
        '</div>' +
      '</section>' +
      '<div class="metrics">' +
        metricHtml("Base", formatDuration(week.targetSeconds), "") +
        metricHtml("Ajuste", adjustment, adjustmentClass) +
        metricHtml("Días", String(week.workdays), "") +
      '</div>' +
      (data.mode !== "LIVE"
        ? '<div class="notice test" style="margin-bottom:12px">🧪 Modo TEST: no se envía ningún fichaje a Woffu.</div>'
        : "") +
      '<section class="card"><div class="cardHeader"><div><h2 class="cardTitle">Esta semana</h2>' +
        '<p class="cardHint">Las horas azules son marcas manuales.</p></div></div>' +
        '<div class="weekStrip">' + dayCards + '</div></section>';
  }

  function renderCalendar() {
    if (!state.data || !state.calendarMonth) return;
    const parts = state.calendarMonth.split("-").map(Number);
    const year = parts[0];
    const month = parts[1];
    const names = [
      "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
      "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
    ];
    els.calendarTitle.textContent = names[month - 1] + " " + year;
    els.calendarGrid.replaceChildren();

    ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"].forEach((label) => {
      const element = document.createElement("div");
      element.className = "weekday";
      element.textContent = label;
      els.calendarGrid.appendChild(element);
    });

    const first = new Date(Date.UTC(year, month - 1, 1));
    const firstIndex = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();

    for (let index = 0; index < firstIndex; index++) {
      const blank = document.createElement("div");
      blank.className = "calBlank";
      els.calendarGrid.appendChild(blank);
    }

    for (let day = 1; day <= days; day++) {
      const date = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "calDay";
      button.textContent = String(day);
      button.disabled = weekend;
      button.classList.toggle("weekend", weekend);
      button.classList.toggle("selected", state.vacationSelected.has(date));
      button.classList.toggle("today", state.data.today === date);
      button.setAttribute("aria-pressed", state.vacationSelected.has(date) ? "true" : "false");

      if (!weekend) {
        button.addEventListener("click", () => {
          if (state.vacationSelected.has(date)) state.vacationSelected.delete(date);
          else state.vacationSelected.add(date);
          renderCalendar();
        });
      }

      els.calendarGrid.appendChild(button);
    }

    const changes = vacationDifferenceCount();
    els.saveVacations.disabled = changes === 0;
    els.calendarStatus.textContent = changes === 0
      ? state.vacationSelected.size + " día(s) guardado(s)"
      : changes + (changes === 1 ? " cambio pendiente" : " cambios pendientes");
  }

  function renderManual() {
    const data = state.data;
    const manual = data.manualDay;
    if (!manual) return;

    const eventRows = EVENTS.map((definition) => {
      const manualValue = manual.manual?.[definition.event];
      const effective = manual.effective?.[definition.event] || "—";
      return '<div class="manualItem"><div class="manualMain"><strong>' +
        escapeHtml(definition.label) + '</strong><span>' +
        (manualValue ? "Manual · " : "Plan · ") + escapeHtml(effective) +
        '</span></div>' +
        (manualValue
          ? '<button type="button" class="smallButton" data-action="remove-manual" data-event="' +
            escapeHtml(definition.event) + '">Quitar</button>'
          : "") + '</div>';
    }).join("");

    const totalNotice = manual.vacation
      ? '<div class="notice test">Este día está marcado como vacaciones.</div>'
      : manual.complete
        ? '<div class="notice ok">Total efectivo: <strong>' +
          formatDuration(manual.workedSeconds) + '</strong> · ajuste: <strong>' +
          formatSignedDuration(manual.adjustmentSeconds) + '</strong></div>'
        : '<div class="notice pending">Día pendiente: completa las marcas manuales que hayas pausado.</div>';

    const pauseInfo = manual.pauseFromOrder
      ? '<div class="notice pending" style="margin-top:10px">Pausada desde <strong>' +
        escapeHtml(eventByOrder(manual.pauseFromOrder)?.label || "una marca") +
        '</strong><button type="button" class="button secondary" style="width:100%;margin-top:9px" data-action="clear-pause">Reanudar este día</button></div>'
      : "";

    els.manual.innerHTML =
      '<section class="card"><div class="cardHeader"><div><h2 class="cardTitle">Día seleccionado</h2>' +
      '<p class="cardHint">Puedes cambiarlo sin recargar toda la app.</p></div></div>' +
      '<form id="manualDateForm"><div class="field"><label for="manualDayInput">Fecha</label>' +
      '<input id="manualDayInput" class="input" type="date" name="manual_day" value="' +
      escapeHtml(manual.date) + '"></div></form></section>' +

      '<section class="card"><h2 class="cardTitle">Pausar parcialmente</h2>' +
      '<p class="cardHint">Elige la primera marca que harás manualmente. Las anteriores continúan automáticas.</p>' +
      '<form id="pauseForm"><div class="field"><label>Desde</label><select class="input" name="from_event">' +
      EVENTS.map((definition) => '<option value="' + definition.event + '">' + escapeHtml(definition.label) + '</option>').join("") +
      '</select></div><button class="button danger" style="width:100%;margin-top:12px">Pausar resto del día</button></form>' + pauseInfo + '</section>' +

      '<section class="card"><h2 class="cardTitle">Registrar marca manual</h2>' +
      '<form id="manualForm" class="formGrid two"><div class="field"><label>Evento</label><select class="input" name="event">' +
      EVENTS.map((definition) => '<option value="' + definition.event + '">' + escapeHtml(definition.label) + '</option>').join("") +
      '</select></div><div class="field"><label>Hora real</label><input class="input" type="time" step="1" name="manual_time" required></div>' +
      '<button class="button primary" style="width:100%;grid-column:1/-1">Guardar marca manual</button></form>' +
      '<div class="manualList">' + eventRows + '</div><div style="margin-top:12px">' + totalNotice + '</div></section>';
  }

  function renderSettings() {
    const data = state.data;
    const config = data.config;
    const logs = data.logs || [];

    const logHtml = logs.length
      ? logs.map((log) => '<div class="log"><div><strong>' + escapeHtml(log.label) +
        ' · ' + escapeHtml(log.scheduledTime || "") + '</strong><span>' +
        formatDate(log.day) + (log.error ? " · " + escapeHtml(log.error) : "") +
        '</span></div><div class="logStatus">' + escapeHtml(log.status) + '</div></div>').join("")
      : '<div class="muted">Todavía no hay ejecuciones.</div>';

    els.settings.innerHTML =
      '<section class="card"><h2 class="cardTitle">Horario base</h2><p class="cardHint">Debe sumar 8 horas y mantener al menos una hora de descanso.</p>' +
      '<form id="configForm" class="formGrid two">' +
      timeField("Entrada mañana", "entry_am", config.entry_am) +
      timeField("Salida mediodía", "lunch_out", config.lunch_out) +
      timeField("Entrada mediodía", "lunch_in", config.lunch_in) +
      timeField("Salida tarde", "exit_pm", config.exit_pm) +
      '<button class="button primary" style="width:100%;grid-column:1/-1">Guardar horario</button></form></section>' +
      '<section class="card"><h2 class="cardTitle">Automatización</h2><p class="cardHint">Estado global del cron.</p>' +
      '<button class="button ' + (config.active ? "danger" : "success") + '" style="width:100%" data-action="toggle-active">' +
      (config.active ? "Pausar automatización" : "Activar automatización") + '</button></section>' +
      '<section class="card"><h2 class="cardTitle">Diagnóstico</h2>' +
      '<div class="manualList"><div class="manualItem"><div class="manualMain"><strong>Versión</strong><span>' +
      escapeHtml(data.version) + '</span></div></div><div class="manualItem"><div class="manualMain"><strong>Modo</strong><span>' +
      escapeHtml(data.mode) + '</span></div></div><div class="manualItem"><div class="manualMain"><strong>Actualizado</strong><span>' +
      escapeHtml(new Date(data.generatedAt).toLocaleString("es-ES")) + '</span></div></div></div></section>' +
      '<section class="card"><h2 class="cardTitle">Últimas ejecuciones</h2><div class="logs">' + logHtml + '</div></section>';
  }

  async function toggleActive(button = els.quickToggle) {
    if (!state.data || state.busy) return;
    const next = !state.data.config.active;
    await runMutation(button, async () => {
      await api("/api/active", { method: "POST", body: { active: next } });
      state.data.config.active = next;
      localStorage.setItem(CACHE_KEY, JSON.stringify(state.data));
      renderAll(false);
      toast(next ? "Automatización activada" : "Automatización pausada");
    });
  }

  async function regenerateWeek(button) {
    await runMutation(button, async () => {
      await api("/api/regenerate", { method: "POST", body: { day: state.data.today } });
      await loadData({ silent: true });
      toast("Plan semanal regenerado");
    });
  }

  async function saveVacations() {
    await runMutation(els.saveVacations, async () => {
      await api("/api/vacations", {
        method: "POST",
        body: { dates: Array.from(state.vacationSelected).sort() },
      });
      state.vacationBaseline = new Set(state.vacationSelected);
      await loadData({ silent: true });
      toast("Vacaciones guardadas");
    });
  }

  async function saveConfig(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    await runMutation(form.querySelector("button"), async () => {
      await api("/api/config", { method: "POST", body: values });
      await loadData({ silent: true });
      toast("Horario actualizado");
    });
  }

  async function saveManual(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    values.day = state.manualDay;
    await runMutation(form.querySelector("button"), async () => {
      await api("/api/manual", { method: "POST", body: values });
      await loadData({ manualDay: state.manualDay, silent: true });
      toast("Marca manual guardada");
    });
  }

  async function removeManual(button) {
    await runMutation(button, async () => {
      await api("/api/manual/delete", {
        method: "POST",
        body: { day: state.manualDay, event: button.dataset.event },
      });
      await loadData({ manualDay: state.manualDay, silent: true });
      toast("Marca manual eliminada");
    });
  }

  async function savePause(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    values.day = state.manualDay;
    await runMutation(form.querySelector("button"), async () => {
      await api("/api/pause", { method: "POST", body: values });
      await loadData({ manualDay: state.manualDay, silent: true });
      toast("Automatización parcial pausada");
    });
  }

  async function clearPause(button) {
    await runMutation(button, async () => {
      await api("/api/pause/clear", {
        method: "POST",
        body: { day: state.manualDay },
      });
      await loadData({ manualDay: state.manualDay, silent: true });
      toast("Automatización del día reanudada");
    });
  }

  async function runMutation(button, task) {
    if (state.busy) return;
    state.busy = true;
    if (button) button.classList.add("loading");
    try {
      await task();
    } catch (error) {
      toast(error.message || "La operación ha fallado.", true);
    } finally {
      state.busy = false;
      if (button) button.classList.remove("loading");
    }
  }

  function resetVacations(dates) {
    state.vacationSelected = new Set(dates);
    state.vacationBaseline = new Set(dates);
  }

  function vacationDifferenceCount() {
    let count = 0;
    for (const date of state.vacationBaseline) {
      if (!state.vacationSelected.has(date)) count++;
    }
    for (const date of state.vacationSelected) {
      if (!state.vacationBaseline.has(date)) count++;
    }
    return count;
  }

  function showLoading() {
    els.home.innerHTML = '<div class="loadingScreen"><div class="loadingBlock skeleton"></div>' +
      '<div class="metrics"><div class="metric skeleton">.</div><div class="metric skeleton">.</div><div class="metric skeleton">.</div></div>' +
      '<div class="loadingBlock skeleton"></div></div>';
  }

  function showFatal(message) {
    els.home.innerHTML = '<div class="card"><h2 class="cardTitle">No se ha podido cargar</h2>' +
      '<p class="cardHint">' + escapeHtml(message || "Error desconocido") + '</p>' +
      '<button class="button primary" style="width:100%" onclick="location.reload()">Reintentar</button></div>';
  }

  function toast(message, error = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle("error", error);
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }

  function metricHtml(label, value, extraClass) {
    return '<div class="metric"><div class="metricLabel">' + escapeHtml(label) +
      '</div><div class="metricValue ' + extraClass + '">' + escapeHtml(value) + '</div></div>';
  }

  function timeField(label, name, value) {
    return '<div class="field"><label>' + escapeHtml(label) + '</label><input class="input" type="time" name="' +
      escapeHtml(name) + '" value="' + escapeHtml(value) + '" required></div>';
  }

  function eventByOrder(order) {
    return EVENTS.find((event) => event.order === Number(order));
  }

  function formatDuration(totalSeconds) {
    const value = Number(totalSeconds || 0);
    const sign = value < 0 ? "-" : "";
    const absolute = Math.abs(value);
    return sign + Math.floor(absolute / 3600) + ":" +
      String(Math.floor((absolute % 3600) / 60)).padStart(2, "0") + ":" +
      String(absolute % 60).padStart(2, "0");
  }

  function formatSignedDuration(seconds) {
    const value = Number(seconds || 0);
    if (value === 0) return "±0:00:00";
    return (value > 0 ? "+" : "-") + formatDuration(Math.abs(value));
  }

  function formatDate(date) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || "";
    const parts = date.split("-");
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function shiftMonth(value, delta) {
    const parts = String(value).split("-").map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1 + delta, 1));
    return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
}

// ==================================================
// SERVER UTILITIES
// ==================================================

function assertSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) {
    throw new HttpError(403, "Origen no permitido.");
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "El cuerpo de la petición no es JSON válido.");
  }
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

function getMadridParts(date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
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
  const weekdays = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdays[parts.weekday],
  };
}

function normalizeTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return value;
}

function normalizeTimeWithSeconds(value) {
  if (
    typeof value !== "string" ||
    !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)
  ) {
    return null;
  }

  const [hour, minute, second = 0] = value.split(":").map(Number);
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function timeToSeconds(value) {
  const parts = String(value).split(":").map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function addSecondsToTime(baseTime, offsetSeconds) {
  const total = timeToSeconds(baseTime) + offsetSeconds;
  const hour = Math.floor(total / 3600) % 24;
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function isDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = parseDate(value);
  return toDateString(date) === value;
}

function isWeekdayDate(value) {
  if (!isDateString(value)) return false;
  const weekday = parseDate(value).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function parseDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getWeekStart(dateString) {
  const date = parseDate(dateString);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return toDateString(date);
}

function addDays(dateString, days) {
  const date = parseDate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateString(date);
}

function weekdayName(dateString) {
  return [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
  ][parseDate(dateString).getUTCDay()];
}

function formatDuration(totalSeconds) {
  const value = Number(totalSeconds || 0);
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 3600)}:${String(
    Math.floor((absolute % 3600) / 60)
  ).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function eventLabel(event) {
  return EVENTS.find((item) => item.event === event)?.label || event;
}

function randomInt(min, max) {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return min + (buffer[0] % (max - min + 1));
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index--) {
    const target = randomInt(0, index);
    [values[index], values[target]] = [values[target], values[index]];
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "X-Woffu-Clock-Version": APP_VERSION,
    "X-Content-Type-Options": "nosniff",
  };
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      ...responseHeaders("text/html; charset=utf-8"),
      "X-Frame-Options": "DENY",
    },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: responseHeaders("text/plain; charset=utf-8"),
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders("application/json; charset=utf-8"),
  });
}

function manifestResponse() {
  return new Response(
    JSON.stringify({
      name: "Woffu Clock Cloud",
      short_name: "Woffu Clock",
      start_url: "/",
      display: "standalone",
      background_color: "#f4f5f7",
      theme_color: "#0b0d12",
      icons: [
        {
          src: "/icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
      ],
    }),
    {
      headers: {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

function iconResponse() {
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="120" fill="#151922"/><path d="M106 136h72l42 214 42-164h64l42 164 42-214h72l-72 240h-72l-44-155-44 155h-72z" fill="white"/></svg>`,
    {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
}
