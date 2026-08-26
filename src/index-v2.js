const APP_VERSION = "2.2.0-fast-vacations";
const TIMEZONE = "Europe/Madrid";
const MAX_OFFSET_SECONDS = 299;
const MAX_DAILY_DEVIATION_SECONDS = 180;
const DAILY_TARGET_SECONDS = 8 * 60 * 60;
const MIN_BREAK_SECONDS = 60 * 60;

const EVENTS = [
  { event: "ENTRY_AM", field: "entry_am", label: "Entrada mañana" },
  { event: "LUNCH_OUT", field: "lunch_out", label: "Salida mediodía" },
  { event: "LUNCH_IN", field: "lunch_in", label: "Entrada mediodía" },
  { event: "EXIT_PM", field: "exit_pm", label: "Salida tarde" },
];

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

    try {
      await ensureSchema(env);

      if (!isAuthorized(request, env)) {
        return new Response("Authentication required", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Woffu Clock"',
            "X-Woffu-Clock-Version": APP_VERSION,
            "Cache-Control": "no-store",
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return renderPanel(request, env);
      }

      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) {
          return textResponse("Forbidden", 403);
        }

        if (url.pathname === "/save") return saveConfiguration(request, env);
        if (url.pathname === "/enable") return setActive(env, true);
        if (url.pathname === "/disable") return setActive(env, false);
        if (url.pathname === "/save-vacations") return saveVacations(request, env);

        if (url.pathname === "/regenerate") {
          const today = getMadridParts(new Date()).date;
          const weekStart = getWeekStart(today);
          await invalidateWeek(env, weekStart);
          await generateWeekPlan(env, weekStart);
          return redirect("/");
        }
      }

      return textResponse("Not found", 404);
    } catch (error) {
      console.error(error);
      return textResponse(
        `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller.scheduledTime);
    const actualNow = new Date();
    ctx.waitUntil(runScheduler(env, scheduledAt, actualNow));
  },
};

// ==================================================
// DATABASE
// ==================================================

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
  ]);
}

async function getConfig(env) {
  return env.DB.prepare(`
    SELECT active, entry_am, lunch_out, lunch_in, exit_pm, updated_at
    FROM config
    WHERE id = 1
  `).first();
}

async function setActive(env, active) {
  await env.DB.prepare(`
    UPDATE config
    SET active = ?1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `)
    .bind(active ? 1 : 0)
    .run();

  return redirect("/");
}

// ==================================================
// SCHEDULER
// ==================================================

async function runScheduler(env, scheduledAt, actualNow) {
  await ensureSchema(env);

  const config = await getConfig(env);
  if (!config || !config.active) return;

  const scheduledLocal = getMadridParts(scheduledAt);
  if (scheduledLocal.weekday === 0 || scheduledLocal.weekday === 6) return;
  if (await isVacation(env, scheduledLocal.date)) return;

  const weekStart = getWeekStart(scheduledLocal.date);
  await ensureWeekPlan(env, weekStart);

  const plan = await env.DB.prepare(`
    SELECT event, planned_time
    FROM test_plan
    WHERE week_start = ?1 AND day = ?2
  `)
    .bind(weekStart, scheduledLocal.date)
    .all();

  const scheduledMinute = scheduledLocal.hour * 60 + scheduledLocal.minute;
  const actualLocal = getMadridParts(actualNow);

  for (const row of plan.results || []) {
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
  `)
    .bind(day, event)
    .first();

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

async function clockWoffu(env, event, now) {
  const mode = String(env.MODE || "TEST").toUpperCase();

  if (mode !== "LIVE") {
    console.log(`[TEST] ${event} - ${now.toISOString()}`);
    return;
  }

  throw new Error("WOFFU_ADAPTER_NOT_CONFIGURED");
}

// ==================================================
// WEEKLY TEST PLAN
// ==================================================

async function ensureWeekPlan(env, weekStart) {
  const existing = await env.DB.prepare(`
    SELECT week_start
    FROM test_week_meta
    WHERE week_start = ?1
  `)
    .bind(weekStart)
    .first();

  if (!existing) await generateWeekPlan(env, weekStart);
}

async function generateWeekPlan(env, weekStart) {
  const config = await getConfig(env);
  if (!config) throw new Error("Configuration not found");

  validateBaseSchedule(config);
  await invalidateWeek(env, weekStart);

  const weekdays = Array.from({ length: 5 }, (_, index) =>
    addDays(weekStart, index)
  );

  const vacationRows = await env.DB.prepare(`
    SELECT date
    FROM vacations
    WHERE date >= ?1 AND date <= ?2
  `)
    .bind(weekdays[0], weekdays[4])
    .all();

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

    const actualBreak =
      timeToSeconds(planned.LUNCH_IN) - timeToSeconds(planned.LUNCH_OUT);

    if (actualBreak < MIN_BREAK_SECONDS) {
      throw new Error("Generated lunch break is shorter than one hour");
    }

    const workedSeconds =
      timeToSeconds(planned.LUNCH_OUT) - timeToSeconds(planned.ENTRY_AM) +
      timeToSeconds(planned.EXIT_PM) - timeToSeconds(planned.LUNCH_IN);

    if (workedSeconds !== DAILY_TARGET_SECONDS + deviation) {
      throw new Error("Generated daily total does not match deviation");
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
      `Weekly total mismatch: ${weeklySeconds} !== ${targetSeconds}`
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
    const deviations = [];

    for (let i = 0; i < workdays - 1; i++) {
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

  throw new Error("Could not generate balanced weekly deviations");
}

function generateOffsetsForDeviation(base, targetDeviation) {
  const baseLunchOut = timeToSeconds(base.LUNCH_OUT);
  const baseLunchIn = timeToSeconds(base.LUNCH_IN);

  for (let attempt = 0; attempt < 20000; attempt++) {
    const entryAM = randomInt(0, MAX_OFFSET_SECONDS);
    const lunchIn = randomInt(0, MAX_OFFSET_SECONDS);
    const exitPM = randomInt(0, MAX_OFFSET_SECONDS);

    const lunchOut =
      targetDeviation - exitPM + lunchIn + entryAM;

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
    `Could not generate valid offsets for deviation ${targetDeviation}`
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
// CONFIG + VACATIONS
// ==================================================

async function saveConfiguration(request, env) {
  const form = await request.formData();

  const entryAM = normalizeTime(form.get("entry_am"));
  const lunchOut = normalizeTime(form.get("lunch_out"));
  const lunchIn = normalizeTime(form.get("lunch_in"));
  const exitPM = normalizeTime(form.get("exit_pm"));

  if (!entryAM || !lunchOut || !lunchIn || !exitPM) {
    return textResponse("Formato horario incorrecto.", 400);
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
    return textResponse(error.message, 400);
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

  if (lunchIn - lunchOut < MIN_BREAK_SECONDS) {
    throw new Error("El descanso de mediodía debe ser como mínimo de 1 hora.");
  }

  const workedSeconds = lunchOut - entry + exit - lunchIn;
  if (workedSeconds !== DAILY_TARGET_SECONDS) {
    throw new Error(
      `El horario base suma ${formatDuration(workedSeconds)}. Debe sumar exactamente 8:00:00.`
    );
  }
}

async function saveVacations(request, env) {
  const form = await request.formData();
  const month = String(form.get("month") || "");
  const rawDates = String(form.get("dates") || "");

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return textResponse("Mes inválido", 400);
  }

  const selectedDates = Array.from(
    new Set(
      rawDates
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .filter((date) => date.startsWith(`${month}-`))
    .filter((date) => {
      const weekday = parseDate(date).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    })
    .sort();

  const existingRows = await env.DB.prepare(`
    SELECT date
    FROM vacations
    WHERE date >= ?1 AND date <= ?2
  `)
    .bind(`${month}-01`, `${month}-31`)
    .all();

  const existingDates = (existingRows.results || []).map((row) => row.date);
  const affectedWeeks = new Set(
    [...existingDates, ...selectedDates].map((date) => getWeekStart(date))
  );

  const statements = [
    env.DB.prepare(`
      DELETE FROM vacations
      WHERE date >= ?1 AND date <= ?2
    `).bind(`${month}-01`, `${month}-31`),
  ];

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
// PANEL
// ==================================================

async function renderPanel(request, env) {
  const config = await getConfig(env);
  if (!config) return textResponse("Configuration not found", 500);

  const today = getMadridParts(new Date()).date;
  const weekStart = getWeekStart(today);
  await ensureWeekPlan(env, weekStart);

  const [weekMeta, summaries, planRows, logs] = await Promise.all([
    env.DB.prepare(`
      SELECT workdays, target_seconds
      FROM test_week_meta
      WHERE week_start = ?1
    `).bind(weekStart).first(),
    env.DB.prepare(`
      SELECT day, worked_seconds, deviation_seconds
      FROM test_day_summary
      WHERE week_start = ?1
      ORDER BY day
    `).bind(weekStart).all(),
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
    `).bind(weekStart).all(),
    env.DB.prepare(`
      SELECT day, event, scheduled_time, status
      FROM punch_log
      ORDER BY day DESC, executed_at DESC
      LIMIT 20
    `).all(),
  ]);

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

  const currentWeekVacationRows = await env.DB.prepare(`
    SELECT date
    FROM vacations
    WHERE date >= ?1 AND date <= ?2
  `)
    .bind(weekStart, addDays(weekStart, 4))
    .all();

  const currentWeekVacations = new Set(
    (currentWeekVacationRows.results || []).map((row) => row.date)
  );

  const summaryMap = new Map(
    (summaries.results || []).map((row) => [row.day, row])
  );

  const planMap = new Map();
  for (const row of planRows.results || []) {
    if (!planMap.has(row.day)) planMap.set(row.day, []);
    planMap.get(row.day).push(row);
  }

  const generatedSeconds = (summaries.results || []).reduce(
    (sum, row) => sum + Number(row.worked_seconds || 0),
    0
  );

  const weekCards = Array.from({ length: 5 }, (_, index) => {
    const day = addDays(weekStart, index);

    if (currentWeekVacations.has(day)) {
      return `
        <div class="day vacation">
          <strong>${weekdayName(day)} · ${formatDate(day)}</strong>
          <div class="vacationText">🏖 Vacaciones</div>
        </div>
      `;
    }

    const rows = planMap.get(day) || [];
    const summary = summaryMap.get(day);

    const eventHtml = rows.map((row) => `
      <div class="event">
        <span>${escapeHtml(eventLabel(row.event))}</span>
        <strong>${escapeHtml(row.planned_time)}</strong>
      </div>
    `).join("");

    return `
      <div class="day">
        <strong>${weekdayName(day)} · ${formatDate(day)}</strong>
        ${eventHtml || '<div class="muted">Sin plan</div>'}
        ${summary ? `
          <div class="total">
            Total: ${formatDuration(summary.worked_seconds)}
            <span>${formatSignedDeviation(summary.deviation_seconds)}</span>
          </div>
        ` : ""}
      </div>
    `;
  }).join("");

  const logRows = (logs.results || []).map((row) => `
    <tr>
      <td>${escapeHtml(row.day || "")}</td>
      <td>${escapeHtml(eventLabel(row.event))}</td>
      <td>${escapeHtml(row.scheduled_time || "")}</td>
      <td>${escapeHtml(row.status || "")}</td>
    </tr>
  `).join("");

  const active = Boolean(config.active);
  const mode = String(env.MODE || "TEST").toUpperCase();
  const initialVacationDates = [...vacationSet].sort().join(",");

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Woffu Clock Cloud</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#171717;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:860px;margin:auto;padding:18px}.card{background:#fff;border-radius:18px;padding:22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1,h2{margin:0 0 14px}.version{color:#777;font-size:12px;margin-top:-8px;margin-bottom:16px}.status{font-size:28px;font-weight:800}.active{color:#157a2d}.paused{color:#b42318}.test{background:#fff3cd;border-radius:10px;padding:11px 13px;margin-top:12px}.muted,.hint{color:#666;font-size:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.day{border:1px solid #e5e5e5;border-radius:13px;padding:13px}.vacation{background:#fff7e9}.vacationText{margin-top:10px;font-weight:700}.event{display:flex;justify-content:space-between;gap:12px;padding-top:8px}.total{border-top:1px solid #eee;margin-top:10px;padding-top:10px;font-weight:700;display:flex;justify-content:space-between;gap:8px}.total span{color:#666;font-weight:500}label{display:block;font-weight:650;margin-top:14px}input[type=time]{width:100%;font-size:17px;padding:11px;margin-top:5px}button{width:100%;border:0;border-radius:10px;padding:13px;margin-top:12px;font-size:16px;cursor:pointer}.enable{background:#157a2d;color:#fff}.disable{background:#b42318;color:#fff}.save{background:#171717;color:#fff}.secondary{background:#ececec;color:#171717}.weekly{font-size:20px;font-weight:800;margin-top:15px}.calendarHead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.calendarHead a{text-decoration:none;color:#171717;background:#eee;padding:8px 12px;border-radius:9px}.calendar{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}.calLabel{text-align:center;color:#777;font-size:12px;font-weight:700;padding:5px}.calDay{width:100%;min-height:42px;padding:4px;margin:0;background:#f1f1f1;color:#171717;transition:transform .08s ease,background .12s ease}.calDay:active{transform:scale(.94)}.calDay.selected{background:#f4bd5d;font-weight:800}.calDay.weekend{opacity:.38}.empty{min-height:42px}.vacActions{display:flex;gap:10px;align-items:center;margin-top:14px}.vacActions button{margin:0;flex:1}.vacStatus{font-size:13px;color:#666;flex:1}.saveVac{background:#171717;color:#fff}.saveVac:disabled{opacity:.4;cursor:default}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 5px;border-bottom:1px solid #eee;font-size:13px}@media(max-width:620px){.wrap{padding:10px}.card{padding:16px}.grid{grid-template-columns:1fr}.calDay{min-height:38px;font-size:13px}.vacActions{display:block}.vacStatus{margin-bottom:10px}}
</style>
</head>
<body>
<div class="wrap">
  <section class="card">
    <h1>Woffu Clock Cloud</h1>
    <div class="version">${APP_VERSION}</div>
    <div class="status ${active ? "active" : "paused"}">${active ? "ACTIVA" : "PAUSADA"}</div>
    ${mode !== "LIVE" ? '<div class="test">🧪 MODE = TEST · no se envía nada a Woffu.</div>' : ""}
    <p class="hint">Random por marca: 0–4:59 · variación diaria: ±3:00 · descanso real mínimo: 1:00:00</p>
    ${active
      ? '<form method="POST" action="/disable"><button class="disable">Pausar automatización</button></form>'
      : '<form method="POST" action="/enable"><button class="enable">Activar automatización</button></form>'}
  </section>

  <section class="card">
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
    <p class="hint">El horario base debe sumar 8:00:00 y tener al menos una hora de descanso.</p>
  </section>

  <section class="card">
    <h2>Vacaciones</h2>
    <p class="hint">Marca todos los días que quieras. Los clics son instantáneos; Cloudflare solo guarda cuando pulsas el botón.</p>
    <form id="vacationForm" method="POST" action="/save-vacations">
      <input type="hidden" name="month" value="${month}">
      <input id="vacationDates" type="hidden" name="dates" value="${escapeHtml(initialVacationDates)}">
      ${renderCalendar(month, vacationSet)}
      <div class="vacActions">
        <div id="vacationStatus" class="vacStatus">Sin cambios pendientes</div>
        <button id="saveVacations" class="saveVac" disabled>Guardar vacaciones</button>
      </div>
    </form>
  </section>

  <section class="card">
    <h2>Plan TEST · semana ${formatDate(weekStart)}</h2>
    <div class="grid">${weekCards}</div>
    <div class="weekly">Generado: ${formatDuration(generatedSeconds)} / Objetivo: ${formatDuration(weekMeta?.target_seconds || 0)}</div>
    <p class="hint">${weekMeta?.workdays || 0} día(s) de trabajo · objetivo = 8 h × días laborables no marcados como vacaciones.</p>
    <form method="POST" action="/regenerate">
      <button class="secondary">Regenerar plan aleatorio de esta semana</button>
    </form>
  </section>

  <section class="card">
    <h2>Últimas ejecuciones</h2>
    <table>
      <thead><tr><th>Fecha</th><th>Evento</th><th>Hora</th><th>Estado</th></tr></thead>
      <tbody>${logRows || '<tr><td colspan="4">Todavía no hay ejecuciones.</td></tr>'}</tbody>
    </table>
  </section>
</div>
<script>
(() => {
  const input = document.getElementById('vacationDates');
  const status = document.getElementById('vacationStatus');
  const saveButton = document.getElementById('saveVacations');
  const buttons = Array.from(document.querySelectorAll('[data-vacation-date]'));
  if (!input || !status || !saveButton) return;

  const initial = new Set((input.value || '').split(',').filter(Boolean));
  const selected = new Set(initial);

  function differenceCount() {
    let count = 0;
    for (const value of initial) if (!selected.has(value)) count++;
    for (const value of selected) if (!initial.has(value)) count++;
    return count;
  }

  function sync() {
    input.value = Array.from(selected).sort().join(',');
    const changes = differenceCount();
    saveButton.disabled = changes === 0;
    status.textContent = changes === 0
      ? 'Sin cambios pendientes'
      : changes + (changes === 1 ? ' cambio sin guardar' : ' cambios sin guardar');
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const date = button.dataset.vacationDate;
      if (!date) return;

      if (selected.has(date)) selected.delete(date);
      else selected.add(date);

      const isSelected = selected.has(date);
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      sync();
    });
  }

  sync();
})();
</script>
</body>
</html>`;

  return htmlResponse(html);
}

function renderCalendar(month, vacationSet) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayIndex = (first.getUTCDay() + 6) % 7;
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  const labels = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"]
    .map((label) => `<div class="calLabel">${label}</div>`)
    .join("");

  let cells = "";
  for (let i = 0; i < mondayIndex; i++) {
    cells += '<div class="empty"></div>';
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const selected = vacationSet.has(date);

    if (weekend) {
      cells += `<button type="button" class="calDay weekend" disabled>${day}</button>`;
    } else {
      cells += `
        <button
          type="button"
          class="calDay ${selected ? "selected" : ""}"
          data-vacation-date="${date}"
          aria-pressed="${selected ? "true" : "false"}"
          title="${selected ? "Quitar vacaciones" : "Marcar vacaciones"}"
        >${day}</button>
      `;
    }
  }

  return `
    <div class="calendarHead">
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

  const weekdays = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
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
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
  ][month];
}

function formatDuration(totalSeconds) {
  const value = Number(totalSeconds || 0);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  return `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSignedDeviation(seconds) {
  const value = Number(seconds || 0);
  if (value === 0) return "±0:00";
  const sign = value > 0 ? "+" : "-";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

// ==================================================
// UTIL
// ==================================================

function randomInt(min, max) {
  const range = max - min + 1;
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return min + (buffer[0] % range);
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

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
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
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: responseHeaders("application/json; charset=utf-8"),
  });
}

function redirect(path) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: path,
      "Cache-Control": "no-store",
      "X-Woffu-Clock-Version": APP_VERSION,
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
