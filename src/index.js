const TIMEZONE = "Europe/Madrid";
const MAX_OFFSET_SECONDS = 299;
const MAX_DAILY_DEVIATION_SECONDS = 180;
const DAILY_TARGET_SECONDS = 8 * 60 * 60;
const MIN_BREAK_SECONDS = 60 * 60;

const EVENTS = [
  { event: "ENTRY_AM", field: "entry_am", label: "Entrada mañana", order: 1 },
  { event: "LUNCH_OUT", field: "lunch_out", label: "Salida mediodía", order: 2 },
  { event: "LUNCH_IN", field: "lunch_in", label: "Entrada mediodía", order: 3 },
  { event: "EXIT_PM", field: "exit_pm", label: "Salida tarde", order: 4 },
];

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);

      if (!isAuthorized(request, env)) {
        return new Response("Authentication required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Woffu Clock"',
          },
        });
      }

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        const today = getMadridParts(new Date()).date;
        await ensureWeekPlan(env, getWeekStart(today));
        return renderPanel(request, env);
      }

      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) {
          return new Response("Forbidden", { status: 403 });
        }

        if (url.pathname === "/save") {
          return saveConfiguration(request, env);
        }

        if (url.pathname === "/enable") {
          await env.DB.prepare(`
            UPDATE config
            SET active = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
          `).run();
          return redirect("/");
        }

        if (url.pathname === "/disable") {
          await env.DB.prepare(`
            UPDATE config
            SET active = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
          `).run();
          return redirect("/");
        }

        if (url.pathname === "/toggle-vacation") {
          return toggleVacation(request, env);
        }

        if (url.pathname === "/regenerate") {
          const today = getMadridParts(new Date()).date;
          const weekStart = getWeekStart(today);
          await invalidateWeek(env, weekStart);
          await generateWeekPlan(env, weekStart);
          return redirect("/");
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return new Response(
        `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        { status: 500 }
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduler(env, new Date()));
  },
};

// ==================================================
// DATABASE
// ==================================================

async function ensureSchema(env) {
  await env.DB.batch([
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
  ]);
}

// ==================================================
// SCHEDULER
// ==================================================

async function runScheduler(env, now) {
  await ensureSchema(env);

  const config = await getConfig(env);
  if (!config || !config.active) return;

  const local = getMadridParts(now);
  if (local.weekday === 0 || local.weekday === 6) return;
  if (await isVacation(env, local.date)) return;

  const weekStart = getWeekStart(local.date);
  await ensureWeekPlan(env, weekStart);

  const plan = await env.DB.prepare(`
    SELECT event, planned_time
    FROM test_plan
    WHERE week_start = ?1
      AND day = ?2
  `)
    .bind(weekStart, local.date)
    .all();

  const currentSeconds =
    local.hour * 3600 + local.minute * 60 + local.second;

  for (const row of plan.results || []) {
    const plannedSeconds = timeToSeconds(row.planned_time);
    const delta = currentSeconds - plannedSeconds;

    // Ejecuta desde el mismo minuto hasta 4 minutos tarde.
    if (delta < -59 || delta > 240) continue;

    if (delta < 0) {
      await sleep(Math.abs(delta) * 1000);
    }

    await processEvent(
      env,
      local.date,
      row.event,
      row.planned_time,
      new Date()
    );
  }
}

async function processEvent(env, day, event, scheduledTime, now) {
  const mode = String(env.MODE || "TEST").toUpperCase();

  const existing = await env.DB.prepare(`
    SELECT status
    FROM punch_log
    WHERE day = ?1 AND event = ?2
  `)
    .bind(day, event)
    .first();

  if (existing?.status === "SUCCESS") return;
  if (mode !== "LIVE" && existing?.status === "TEST") return;
  if (existing?.status === "PENDING") return;

  if (!existing) {
    await env.DB.prepare(`
      INSERT INTO punch_log (
        day, event, scheduled_time, status, attempts
      ) VALUES (?1, ?2, ?3, 'PENDING', 1)
    `)
      .bind(day, event, scheduledTime)
      .run();
  } else {
    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'PENDING',
          scheduled_time = ?3,
          attempts = attempts + 1,
          error = NULL
      WHERE day = ?1 AND event = ?2
    `)
      .bind(day, event, scheduledTime)
      .run();
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
    `)
      .bind(day, event, finalStatus)
      .run();

    console.log(`${day} ${event}: ${finalStatus}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'FAILED',
          executed_at = CURRENT_TIMESTAMP,
          error = ?3
      WHERE day = ?1 AND event = ?2
    `)
      .bind(day, event, message.substring(0, 500))
      .run();

    console.error(`${day} ${event}: ${message}`);
  }
}

// ==================================================
// TEST PLAN GENERATOR
// ==================================================

async function ensureWeekPlan(env, weekStart) {
  const existing = await env.DB.prepare(`
    SELECT week_start
    FROM test_week_meta
    WHERE week_start = ?1
  `)
    .bind(weekStart)
    .first();

  if (!existing) {
    await generateWeekPlan(env, weekStart);
  }
}

async function generateWeekPlan(env, weekStart) {
  const config = await getConfig(env);
  if (!config) throw new Error("Configuration not found");

  validateBaseSchedule(config);
  await invalidateWeek(env, weekStart);

  const dates = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));

  const vacationRows = await env.DB.prepare(`
    SELECT date
    FROM vacations
    WHERE date >= ?1 AND date <= ?2
  `)
    .bind(dates[0], dates[4])
    .all();

  const vacations = new Set((vacationRows.results || []).map((row) => row.date));
  const workDates = dates.filter((date) => !vacations.has(date));
  const deviations = generateDailyDeviations(workDates.length);

  const base = {
    ENTRY_AM: config.entry_am,
    LUNCH_OUT: config.lunch_out,
    LUNCH_IN: config.lunch_in,
    EXIT_PM: config.exit_pm,
  };

  let weeklySeconds = 0;

  for (let i = 0; i < workDates.length; i++) {
    const day = workDates[i];
    const deviation = deviations[i];
    const offsets = generateOffsetsForDeviation(base, deviation);

    const planned = {
      ENTRY_AM: addSecondsToTime(base.ENTRY_AM, offsets.ENTRY_AM),
      LUNCH_OUT: addSecondsToTime(base.LUNCH_OUT, offsets.LUNCH_OUT),
      LUNCH_IN: addSecondsToTime(base.LUNCH_IN, offsets.LUNCH_IN),
      EXIT_PM: addSecondsToTime(base.EXIT_PM, offsets.EXIT_PM),
    };

    const breakSeconds =
      timeToSeconds(planned.LUNCH_IN) - timeToSeconds(planned.LUNCH_OUT);

    if (breakSeconds < MIN_BREAK_SECONDS) {
      throw new Error("Generated lunch break is shorter than one hour");
    }

    const workedSeconds =
      timeToSeconds(planned.LUNCH_OUT) - timeToSeconds(planned.ENTRY_AM) +
      timeToSeconds(planned.EXIT_PM) - timeToSeconds(planned.LUNCH_IN);

    if (workedSeconds !== DAILY_TARGET_SECONDS + deviation) {
      throw new Error("Generated daily total does not match its deviation");
    }

    weeklySeconds += workedSeconds;

    for (const definition of EVENTS) {
      await env.DB.prepare(`
        INSERT INTO test_plan (
          week_start, day, event, base_time, planned_time, offset_seconds
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `)
        .bind(
          weekStart,
          day,
          definition.event,
          base[definition.event],
          planned[definition.event],
          offsets[definition.event]
        )
        .run();
    }

    await env.DB.prepare(`
      INSERT INTO test_day_summary (
        week_start, day, worked_seconds, deviation_seconds
      ) VALUES (?1, ?2, ?3, ?4)
    `)
      .bind(weekStart, day, workedSeconds, deviation)
      .run();
  }

  const targetSeconds = workDates.length * DAILY_TARGET_SECONDS;

  if (weeklySeconds !== targetSeconds) {
    throw new Error(
      `Weekly total mismatch: generated ${weeklySeconds}, target ${targetSeconds}`
    );
  }

  await env.DB.prepare(`
    INSERT INTO test_week_meta (
      week_start, workdays, target_seconds
    ) VALUES (?1, ?2, ?3)
  `)
    .bind(weekStart, workDates.length, targetSeconds)
    .run();
}

function generateDailyDeviations(workdays) {
  if (workdays === 0) return [];
  if (workdays === 1) return [0];

  for (let attempt = 0; attempt < 10000; attempt++) {
    const values = [];

    for (let i = 0; i < workdays - 1; i++) {
      values.push(
        randomInt(
          -MAX_DAILY_DEVIATION_SECONDS,
          MAX_DAILY_DEVIATION_SECONDS
        )
      );
    }

    const last = -values.reduce((sum, value) => sum + value, 0);

    if (
      last >= -MAX_DAILY_DEVIATION_SECONDS &&
      last <= MAX_DAILY_DEVIATION_SECONDS
    ) {
      values.push(last);
      shuffle(values);
      return values;
    }
  }

  throw new Error("Could not generate balanced daily deviations");
}

function generateOffsetsForDeviation(base, targetDeviation) {
  const baseLunchOut = timeToSeconds(base.LUNCH_OUT);
  const baseLunchIn = timeToSeconds(base.LUNCH_IN);

  for (let attempt = 0; attempt < 20000; attempt++) {
    const entryAM = randomInt(0, MAX_OFFSET_SECONDS);
    const lunchIn = randomInt(0, MAX_OFFSET_SECONDS);
    const exitPM = randomInt(0, MAX_OFFSET_SECONDS);

    // target = (lunchOut-entryAM) + (exitPM-lunchIn)
    const lunchOut =
      targetDeviation - exitPM + lunchIn + entryAM;

    if (lunchOut < 0 || lunchOut > MAX_OFFSET_SECONDS) continue;

    const plannedBreak =
      baseLunchIn + lunchIn - (baseLunchOut + lunchOut);

    if (plannedBreak < MIN_BREAK_SECONDS) continue;

    return {
      ENTRY_AM: entryAM,
      LUNCH_OUT: lunchOut,
      LUNCH_IN: lunchIn,
      EXIT_PM: exitPM,
    };
  }

  throw new Error(
    `Could not generate valid random offsets for deviation ${targetDeviation}`
  );
}

async function invalidateWeek(env, weekStart) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM test_plan WHERE week_start = ?1`).bind(weekStart),
    env.DB.prepare(`DELETE FROM test_day_summary WHERE week_start = ?1`).bind(weekStart),
    env.DB.prepare(`DELETE FROM test_week_meta WHERE week_start = ?1`).bind(weekStart),
  ]);
}

async function invalidateAllPlans(env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM test_plan`),
    env.DB.prepare(`DELETE FROM test_day_summary`),
    env.DB.prepare(`DELETE FROM test_week_meta`),
  ]);
}

// ==================================================
// VACATIONS
// ==================================================

async function toggleVacation(request, env) {
  const form = await request.formData();
  const date = String(form.get("date") || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response("Invalid date", { status: 400 });
  }

  const existing = await env.DB.prepare(`
    SELECT date FROM vacations WHERE date = ?1
  `)
    .bind(date)
    .first();

  if (existing) {
    await env.DB.prepare(`DELETE FROM vacations WHERE date = ?1`)
      .bind(date)
      .run();
  } else {
    await env.DB.prepare(`INSERT INTO vacations (date) VALUES (?1)`)
      .bind(date)
      .run();
  }

  const weekStart = getWeekStart(date);
  await invalidateWeek(env, weekStart);

  const month = date.slice(0, 7);
  return redirect(`/?month=${month}`);
}

async function isVacation(env, date) {
  const row = await env.DB.prepare(`
    SELECT date FROM vacations WHERE date = ?1
  `)
    .bind(date)
    .first();

  return Boolean(row);
}

// ==================================================
// WOFFU ADAPTER
// ==================================================

async function clockWoffu(env, event, now) {
  const mode = String(env.MODE || "TEST").toUpperCase();

  if (mode !== "LIVE") {
    console.log(`[TEST] ${event} - ${now.toISOString()}`);
    return;
  }

  throw new Error("WOFFU_ADAPTER_NOT_CONFIGURED");
}

// ==================================================
// CONFIG
// ==================================================

async function getConfig(env) {
  return env.DB.prepare(`
    SELECT
      active,
      entry_am,
      lunch_out,
      lunch_in,
      exit_pm,
      updated_at
    FROM config
    WHERE id = 1
  `).first();
}

async function saveConfiguration(request, env) {
  const form = await request.formData();

  const entryAM = normalizeTime(form.get("entry_am"));
  const lunchOut = normalizeTime(form.get("lunch_out"));
  const lunchIn = normalizeTime(form.get("lunch_in"));
  const exitPM = normalizeTime(form.get("exit_pm"));

  if (!entryAM || !lunchOut || !lunchIn || !exitPM) {
    return new Response("Formato horario incorrecto.", { status: 400 });
  }

  const config = {
    entry_am: entryAM,
    lunch_out: lunchOut,
    lunch_in: lunchIn,
    exit_pm: exitPM,
  };

  try {
    validateBaseSchedule(config);
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }

  await env.DB.prepare(`
    UPDATE config
    SET entry_am = ?1,
        lunch_out = ?2,
        lunch_in = ?3,
        exit_pm = ?4,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `)
    .bind(entryAM, lunchOut, lunchIn, exitPM)
    .run();

  await invalidateAllPlans(env);
  return redirect("/");
}

function validateBaseSchedule(config) {
  const entry = timeToSeconds(config.entry_am);
  const lunchOut = timeToSeconds(config.lunch_out);
  const lunchIn = timeToSeconds(config.lunch_in);
  const exit = timeToSeconds(config.exit_pm);

  if (!(entry < lunchOut && lunchOut < lunchIn && lunchIn < exit)) {
    throw new Error("Las cuatro horas deben estar en orden cronológico.");
  }

  const lunchBreak = lunchIn - lunchOut;
  if (lunchBreak < MIN_BREAK_SECONDS) {
    throw new Error("El descanso de mediodía debe ser como mínimo de 1 hora.");
  }

  const total = lunchOut - entry + exit - lunchIn;
  if (total !== DAILY_TARGET_SECONDS) {
    throw new Error(
      `El horario base suma ${formatSeconds(total)}. Debe sumar exactamente 8 h.`
    );
  }
}

// ==================================================
// PANEL
// ==================================================

async function renderPanel(request, env) {
  const config = await getConfig(env);
  if (!config) {
    return new Response("Configuration not found", { status: 500 });
  }

  const now = new Date();
  const today = getMadridParts(now).date;
  const weekStart = getWeekStart(today);
  await ensureWeekPlan(env, weekStart);

  const weekMeta = await env.DB.prepare(`
    SELECT workdays, target_seconds, generated_at
    FROM test_week_meta
    WHERE week_start = ?1
  `)
    .bind(weekStart)
    .first();

  const summaries = await env.DB.prepare(`
    SELECT day, worked_seconds, deviation_seconds
    FROM test_day_summary
    WHERE week_start = ?1
    ORDER BY day
  `)
    .bind(weekStart)
    .all();

  const planRows = await env.DB.prepare(`
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
  `)
    .bind(weekStart)
    .all();

  const logs = await env.DB.prepare(`
    SELECT day, event, scheduled_time, status, attempts, executed_at, error
    FROM punch_log
    ORDER BY day DESC, executed_at DESC
    LIMIT 20
  `).all();

  const url = new URL(request.url);
  const requestedMonth = url.searchParams.get("month");
  const month = /^\d{4}-\d{2}$/.test(requestedMonth || "")
    ? requestedMonth
    : today.slice(0, 7);

  const monthVacations = await env.DB.prepare(`
    SELECT date
    FROM vacations
    WHERE date >= ?1 AND date <= ?2
  `)
    .bind(`${month}-01`, `${month}-31`)
    .all();

  const vacationSet = new Set(
    (monthVacations.results || []).map((row) => row.date)
  );

  const currentWeekVacations = new Set();
  for (let i = 0; i < 5; i++) {
    const date = addDays(weekStart, i);
    if (await isVacation(env, date)) currentWeekVacations.add(date);
  }

  const summaryMap = new Map(
    (summaries.results || []).map((row) => [row.day, row])
  );

  const planMap = new Map();
  for (const row of planRows.results || []) {
    if (!planMap.has(row.day)) planMap.set(row.day, []);
    planMap.get(row.day).push(row);
  }

  const generatedWeeklySeconds = (summaries.results || []).reduce(
    (sum, row) => sum + Number(row.worked_seconds || 0),
    0
  );

  const mode = String(env.MODE || "TEST").toUpperCase();
  const active = Boolean(config.active);

  const weekCards = Array.from({ length: 5 }, (_, index) => {
    const day = addDays(weekStart, index);
    const vacation = currentWeekVacations.has(day);
    const summary = summaryMap.get(day);
    const rows = planMap.get(day) || [];

    if (vacation) {
      return `
        <div class="day-card vacation-card">
          <div class="day-title">${weekdayName(day)} · ${formatDate(day)}</div>
          <div class="vacation-label">🏖 Vacaciones</div>
        </div>
      `;
    }

    const eventLines = rows
      .map(
        (row) => `
          <div class="event-row">
            <span>${escapeHtml(eventLabel(row.event))}</span>
            <strong>${escapeHtml(row.planned_time)}</strong>
          </div>
        `
      )
      .join("");

    return `
      <div class="day-card">
        <div class="day-title">${weekdayName(day)} · ${formatDate(day)}</div>
        ${eventLines || '<div class="muted">Sin plan</div>'}
        ${
          summary
            ? `<div class="day-total">Total: ${formatSeconds(summary.worked_seconds)} <span class="deviation">(${formatSignedSeconds(summary.deviation_seconds)})</span></div>`
            : ""
        }
      </div>
    `;
  }).join("");

  const logRows = (logs.results || [])
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.day || "")}</td>
          <td>${escapeHtml(eventLabel(row.event))}</td>
          <td>${escapeHtml(row.scheduled_time || "")}</td>
          <td>${escapeHtml(row.status || "")}</td>
        </tr>
      `
    )
    .join("");

  const calendar = renderCalendar(month, vacationSet);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Woffu Clock Cloud</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:auto;padding:20px;background:#f5f5f7;color:#161616}.card{background:#fff;border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1,h2{margin-top:0}.status{font-size:28px;font-weight:750}.active{color:#147a28}.paused{color:#b42318}.test{background:#fff3cd;padding:11px 14px;border-radius:10px;margin-top:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.day-card{border:1px solid #e5e5e5;border-radius:14px;padding:14px}.vacation-card{background:#fff8ed}.day-title{font-weight:700;margin-bottom:10px}.vacation-label{font-weight:700}.event-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0}.day-total{margin-top:10px;padding-top:9px;border-top:1px solid #eee;font-weight:700}.deviation{font-weight:500;color:#666}.weekly-total{font-size:20px;font-weight:750;margin-top:16px}.muted,.small{color:#666;font-size:14px}label{display:block;margin-top:16px;font-weight:650}input[type="time"]{width:100%;padding:12px;margin-top:6px;font-size:17px}button,.button-link{width:100%;padding:13px;border:0;border-radius:10px;margin-top:12px;font-size:16px;cursor:pointer;text-decoration:none;text-align:center;display:block}.enable{background:#147a28;color:#fff}.disable{background:#b42318;color:#fff}.save{background:#161616;color:#fff}.secondary{background:#ececec;color:#111}.calendar-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px}.calendar-head a{text-decoration:none;color:inherit;padding:8px 12px;background:#eee;border-radius:9px}.calendar{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}.cal-label{text-align:center;font-size:12px;font-weight:700;color:#666;padding:6px 0}.cal-empty{min-height:42px}.cal-form{margin:0}.cal-day{width:100%;min-height:42px;margin:0;padding:5px;border-radius:9px;background:#f3f3f3;color:#111}.cal-day.vacation{background:#f7c46c}.cal-day.weekend{opacity:.4;cursor:not-allowed}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 5px;border-bottom:1px solid #eee;font-size:13px}@media(max-width:620px){body{padding:12px}.grid{grid-template-columns:1fr}.card{padding:17px}.calendar{gap:3px}.cal-day{min-height:38px;font-size:13px}}
</style>
</head>
<body>

<div class="card">
  <h1>Woffu Clock Cloud</h1>
  <div class="status ${active ? "active" : "paused"}">${active ? "ACTIVA" : "PAUSADA"}</div>
  ${
    mode !== "LIVE"
      ? '<div class="test">🧪 MODE = TEST<br>No se enviará ningún fichaje a Woffu.</div>'
      : ""
  }
  <p class="small">Random por marca: 0–4:59 · Variación diaria máxima: ±3:00 · Descanso mínimo: 1:00:00</p>
  ${
    active
      ? '<form method="POST" action="/disable"><button class="disable">Pausar automatización</button></form>'
      : '<form method="POST" action="/enable"><button class="enable">Activar automatización</button></form>'
  }
</div>

<div class="card">
  <h2>Horario base</h2>
  <form method="POST" action="/save">
    <label>Entrada mañana</label>
    <input type="time" name="entry_am" value="${escapeHtml(config.entry_am)}" required>
    <label>Salida mediodía</label>
    <input type="time" name="lunch_out" value="${escapeHtml(config.lunch_out)}" required>
    <label>Entrada después de comer</label>
    <input type="time" name="lunch_in" value="${escapeHtml(config.lunch_in)}" required>
    <label>Salida tarde</label>
    <input type="time" name="exit_pm" value="${escapeHtml(config.exit_pm)}" required>
    <button class="save">Guardar horario</button>
  </form>
  <p class="small">El horario base debe sumar 8 h y tener al menos 1 h de descanso. Las marcas TEST se generan después con minutos y segundos aleatorios.</p>
</div>

<div class="card">
  <h2>Vacaciones</h2>
  <p class="small">Pulsa un día laborable para marcarlo o desmarcarlo. La semana afectada se recalcula automáticamente.</p>
  ${calendar}
</div>

<div class="card">
  <h2>Plan TEST · semana ${formatDate(weekStart)}</h2>
  <div class="grid">${weekCards}</div>
  <div class="weekly-total">Generado: ${formatSeconds(generatedWeeklySeconds)} / Objetivo: ${formatSeconds(weekMeta?.target_seconds || 0)}</div>
  <p class="small">${weekMeta?.workdays || 0} día(s) laborable(s) · objetivo = 8 h × días no marcados como vacaciones.</p>
  <form method="POST" action="/regenerate">
    <button class="secondary">Regenerar plan aleatorio de esta semana</button>
  </form>
</div>

<div class="card">
  <h2>Últimas ejecuciones</h2>
  <table>
    <thead><tr><th>Fecha</th><th>Evento</th><th>Hora</th><th>Estado</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="4">Todavía no hay ejecuciones.</td></tr>'}</tbody>
  </table>
</div>

</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function renderCalendar(month, vacationSet) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayIndex = (first.getUTCDay() + 6) % 7;
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  const labels = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"]
    .map((label) => `<div class="cal-label">${label}</div>`)
    .join("");

  let cells = "";
  for (let i = 0; i < mondayIndex; i++) {
    cells += '<div class="cal-empty"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const vacation = vacationSet.has(date);

    if (weekend) {
      cells += `<button type="button" class="cal-day weekend" disabled>${day}</button>`;
    } else {
      cells += `
        <form class="cal-form" method="POST" action="/toggle-vacation">
          <input type="hidden" name="date" value="${date}">
          <button class="cal-day ${vacation ? "vacation" : ""}" title="${vacation ? "Quitar vacaciones" : "Marcar vacaciones"}">${day}</button>
        </form>
      `;
    }
  }

  return `
    <div class="calendar-head">
      <a href="/?month=${previous}">←</a>
      <strong>${monthName(monthNumber)} ${year}</strong>
      <a href="/?month=${next}">→</a>
    </div>
    <div class="calendar">${labels}${cells}</div>
  `;
}

// ==================================================
// AUTH
// ==================================================

function isAuthorized(request, env) {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Basic ")) return false;

  try {
    const decoded = atob(header.substring(6));
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;

    const username = decoded.substring(0, separator);
    const password = decoded.substring(separator + 1);

    return username === "admin" && password === env.ADMIN_PASSWORD;
  } catch {
    return false;
  }
}

// ==================================================
// DATE / TIME
// ==================================================

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

  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

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

function getWeekStart(dateString) {
  const date = parseDate(dateString);
  const weekday = date.getUTCDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + diff);
  return toDateString(date);
}

function addDays(dateString, days) {
  const date = parseDate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateString(date);
}

function parseDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatDate(dateString) {
  const [year, month, day] = dateString.split("-");
  return `${day}/${month}/${year}`;
}

function weekdayName(dateString) {
  const names = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  return names[parseDate(dateString).getUTCDay()];
}

function monthName(month) {
  return [
    "", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ][month];
}

function formatSeconds(totalSeconds) {
  const sign = totalSeconds < 0 ? "-" : "";
  const abs = Math.abs(Number(totalSeconds || 0));
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  return `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSignedSeconds(seconds) {
  const value = Number(seconds || 0);
  if (value === 0) return "±0:00";
  const sign = value > 0 ? "+" : "-";
  const abs = Math.abs(value);
  const minutes = Math.floor(abs / 60);
  const secs = abs % 60;
  return `${sign}${minutes}:${String(secs).padStart(2, "0")}`;
}

// ==================================================
// RANDOM / UTIL
// ==================================================

function randomInt(min, max) {
  const range = max - min + 1;
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return min + (array[0] % range);
}

function shuffle(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [values[i], values[j]] = [values[j], values[i]];
  }
}

function eventLabel(event) {
  return EVENTS.find((item) => item.event === event)?.label || event;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redirect(path) {
  return new Response(null, {
    status: 303,
    headers: { Location: path },
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
