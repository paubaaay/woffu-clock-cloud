const TIMEZONE = "Europe/Madrid";

const EVENTS = [
  { event: "ENTRY_AM", field: "entry_am", label: "Entrada mañana" },
  { event: "LUNCH_OUT", field: "lunch_out", label: "Salida mediodía" },
  { event: "LUNCH_IN", field: "lunch_in", label: "Entrada mediodía" },
  { event: "EXIT_PM", field: "exit_pm", label: "Salida tarde" },
];

export default {
  async fetch(request, env) {
    try {
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
        return renderPanel(env);
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
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);

      return new Response("Internal server error", {
        status: 500,
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduler(
        env,
        new Date(controller.scheduledTime)
      )
    );
  },
};


// ==================================================
// SCHEDULER
// ==================================================

async function runScheduler(env, now) {
  const config = await getConfig(env);

  if (!config || !config.active) {
    return;
  }

  const local = getMadridParts(now);

  // sábado / domingo
  if (local.weekday === 0 || local.weekday === 6) {
    return;
  }

  const currentMinutes =
    local.hour * 60 + local.minute;

  for (const definition of EVENTS) {
    const scheduledTime =
      config[definition.field];

    const scheduledMinutes =
      timeToMinutes(scheduledTime);

    /*
      Ventana de tolerancia de 5 minutos.

      NO genera una hora aleatoria.
      Solo evita perder el evento si el cron
      se retrasa ligeramente.
    */

    if (
      currentMinutes < scheduledMinutes ||
      currentMinutes > scheduledMinutes + 4
    ) {
      continue;
    }

    await processEvent(
      env,
      local.date,
      definition.event,
      scheduledTime,
      now
    );
  }
}


async function processEvent(
  env,
  day,
  event,
  scheduledTime,
  now
) {
  const mode =
    String(env.MODE || "TEST").toUpperCase();

  const existing = await env.DB.prepare(`
    SELECT status
    FROM punch_log
    WHERE day = ?1
      AND event = ?2
  `)
    .bind(day, event)
    .first();

  // Ya fichado realmente
  if (existing?.status === "SUCCESS") {
    return;
  }

  // Ya simulado hoy en TEST
  if (
    mode !== "LIVE" &&
    existing?.status === "TEST"
  ) {
    return;
  }

  // Otra ejecución ya lo está procesando
  if (existing?.status === "PENDING") {
    return;
  }

  if (!existing) {
    await env.DB.prepare(`
      INSERT INTO punch_log (
        day,
        event,
        scheduled_time,
        status,
        attempts
      )
      VALUES (
        ?1,
        ?2,
        ?3,
        'PENDING',
        1
      )
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
      WHERE day = ?1
        AND event = ?2
    `)
      .bind(day, event, scheduledTime)
      .run();
  }

  try {
    await clockWoffu(env, event, now);

    const finalStatus =
      mode === "LIVE"
        ? "SUCCESS"
        : "TEST";

    await env.DB.prepare(`
      UPDATE punch_log
      SET status = ?3,
          executed_at = CURRENT_TIMESTAMP,
          error = NULL
      WHERE day = ?1
        AND event = ?2
    `)
      .bind(day, event, finalStatus)
      .run();

    console.log(
      `${day} ${event}: ${finalStatus}`
    );

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await env.DB.prepare(`
      UPDATE punch_log
      SET status = 'FAILED',
          executed_at = CURRENT_TIMESTAMP,
          error = ?3
      WHERE day = ?1
        AND event = ?2
    `)
      .bind(
        day,
        event,
        message.substring(0, 500)
      )
      .run();

    console.error(
      `${day} ${event}: ${message}`
    );
  }
}


// ==================================================
// WOFFU
// ==================================================

async function clockWoffu(env, event, now) {
  const mode =
    String(env.MODE || "TEST").toUpperCase();

  /*
    Mientras MODE = TEST:
    NO se realiza ninguna petición a Woffu.
  */

  if (mode !== "LIVE") {
    console.log(
      `[TEST] ${event} - ${now.toISOString()}`
    );

    return;
  }

  /*
    Más adelante sustituiremos esto por
    la integración verificada con Woffu.
  */

  throw new Error(
    "WOFFU_ADAPTER_NOT_CONFIGURED"
  );
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


async function saveConfiguration(
  request,
  env
) {
  const form =
    await request.formData();

  const entryAM =
    normalizeTime(form.get("entry_am"));

  const lunchOut =
    normalizeTime(form.get("lunch_out"));

  const lunchIn =
    normalizeTime(form.get("lunch_in"));

  const exitPM =
    normalizeTime(form.get("exit_pm"));

  if (
    !entryAM ||
    !lunchOut ||
    !lunchIn ||
    !exitPM
  ) {
    return new Response(
      "Formato horario incorrecto.",
      { status: 400 }
    );
  }

  const entry =
    timeToMinutes(entryAM);

  const out =
    timeToMinutes(lunchOut);

  const inside =
    timeToMinutes(lunchIn);

  const exit =
    timeToMinutes(exitPM);

  if (
    !(
      entry < out &&
      out < inside &&
      inside < exit
    )
  ) {
    return new Response(
      "Las cuatro horas deben estar en orden cronológico.",
      { status: 400 }
    );
  }

  const total =
    (out - entry) +
    (exit - inside);

  if (total !== 480) {
    return new Response(
      `El horario suma ${formatMinutes(total)}. Debe sumar exactamente 8 h.`,
      { status: 400 }
    );
  }

  await env.DB.prepare(`
    UPDATE config
    SET
      entry_am = ?1,
      lunch_out = ?2,
      lunch_in = ?3,
      exit_pm = ?4,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `)
    .bind(
      entryAM,
      lunchOut,
      lunchIn,
      exitPM
    )
    .run();

  return redirect("/");
}


// ==================================================
// PANEL
// ==================================================

async function renderPanel(env) {
  const config = await getConfig(env);

  if (!config) {
    return new Response(
      "Configuration not found",
      { status: 500 }
    );
  }

  const logs = await env.DB.prepare(`
    SELECT
      day,
      event,
      scheduled_time,
      status,
      attempts,
      executed_at,
      error
    FROM punch_log
    ORDER BY day DESC, executed_at DESC
    LIMIT 20
  `).all();

  const active =
    Boolean(config.active);

  const mode =
    String(env.MODE || "TEST").toUpperCase();

  const total =
    calculateTotalMinutes(config);

  const rows =
    (logs.results || [])
      .map((row) => `
        <tr>
          <td>${escapeHtml(row.day || "")}</td>
          <td>${escapeHtml(eventLabel(row.event))}</td>
          <td>${escapeHtml(row.scheduled_time || "")}</td>
          <td>${escapeHtml(row.status || "")}</td>
        </tr>
      `)
      .join("");

  const html = `
<!DOCTYPE html>
<html lang="es">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Woffu Clock Cloud</title>

<style>

* {
  box-sizing: border-box;
}

body {
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  max-width: 720px;
  margin: auto;
  padding: 24px;

  background: #f5f5f7;
  color: #161616;
}

.card {
  background: white;

  border-radius: 18px;

  padding: 24px;

  margin-bottom: 18px;

  box-shadow:
    0 1px 3px rgba(0,0,0,.08);
}

h1 {
  margin-top: 0;
}

.status {
  font-size: 28px;
  font-weight: 700;
}

.active {
  color: #147a28;
}

.paused {
  color: #b42318;
}

.test {
  background: #fff3cd;
  padding: 10px 14px;
  border-radius: 10px;
  margin-top: 14px;
}

label {
  display: block;
  margin-top: 18px;
  font-weight: 600;
}

input[type="time"] {
  width: 100%;
  padding: 12px;
  margin-top: 6px;
  font-size: 18px;
}

button {
  width: 100%;
  padding: 14px;

  margin-top: 14px;

  border: 0;
  border-radius: 10px;

  font-size: 17px;
  cursor: pointer;
}

.enable {
  background: #147a28;
  color: white;
}

.disable {
  background: #b42318;
  color: white;
}

.save {
  background: #161616;
  color: white;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  text-align: left;
  padding: 9px 5px;
  border-bottom: 1px solid #eee;
  font-size: 13px;
}

.small {
  color: #666;
  font-size: 14px;
}

</style>

</head>

<body>

<div class="card">

<h1>Woffu Clock Cloud</h1>

<div class="status ${
  active ? "active" : "paused"
}">
  ${
    active
      ? "ACTIVA"
      : "PAUSADA"
  }
</div>

${
  mode !== "LIVE"
    ? `
      <div class="test">
        🧪 MODE = TEST<br>
        No se enviará ningún fichaje a Woffu.
      </div>
    `
    : ""
}

<p>
Horas de trabajo:
<strong>${formatMinutes(total)}</strong>
</p>

${
  active
    ? `
<form method="POST" action="/disable">
  <button class="disable">
    Pausar automatización
  </button>
</form>
`
    : `
<form method="POST" action="/enable">
  <button class="enable">
    Activar automatización
  </button>
</form>
`
}

</div>


<div class="card">

<h2>Horario</h2>

<form method="POST" action="/save">

<label>
Entrada mañana
</label>

<input
  type="time"
  name="entry_am"
  value="${escapeHtml(config.entry_am)}"
  required
>


<label>
Salida mediodía
</label>

<input
  type="time"
  name="lunch_out"
  value="${escapeHtml(config.lunch_out)}"
  required
>


<label>
Entrada después de comer
</label>

<input
  type="time"
  name="lunch_in"
  value="${escapeHtml(config.lunch_in)}"
  required
>


<label>
Salida tarde
</label>

<input
  type="time"
  name="exit_pm"
  value="${escapeHtml(config.exit_pm)}"
  required
>


<button class="save">
Guardar horario
</button>

</form>

<p class="small">
El horario debe sumar exactamente 8 horas.
</p>

</div>


<div class="card">

<h2>Últimas ejecuciones</h2>

<table>

<thead>
<tr>
<th>Fecha</th>
<th>Evento</th>
<th>Hora</th>
<th>Estado</th>
</tr>
</thead>

<tbody>

${
  rows ||
  `
  <tr>
    <td colspan="4">
      Todavía no hay ejecuciones.
    </td>
  </tr>
  `
}

</tbody>

</table>

</div>

</body>
</html>
`;

  return new Response(html, {
    headers: {
      "Content-Type":
        "text/html; charset=utf-8",

      "Cache-Control":
        "no-store",

      "X-Frame-Options":
        "DENY",

      "X-Content-Type-Options":
        "nosniff",
    },
  });
}


// ==================================================
// AUTH
// ==================================================

function isAuthorized(request, env) {
  const header =
    request.headers.get(
      "Authorization"
    );

  if (
    !header ||
    !header.startsWith("Basic ")
  ) {
    return false;
  }

  try {
    const decoded =
      atob(header.substring(6));

    const separator =
      decoded.indexOf(":");

    if (separator === -1) {
      return false;
    }

    const username =
      decoded.substring(0, separator);

    const password =
      decoded.substring(separator + 1);

    return (
      username === "admin" &&
      password === env.ADMIN_PASSWORD
    );

  } catch {
    return false;
  }
}


// ==================================================
// TIME
// ==================================================

function getMadridParts(date) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
        hourCycle: "h23",
      }
    );

  const parts =
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .map((part) => [
          part.type,
          part.value,
        ])
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
    date:
      `${parts.year}-${parts.month}-${parts.day}`,

    hour:
      Number(parts.hour),

    minute:
      Number(parts.minute),

    weekday:
      weekdays[parts.weekday],
  };
}


function normalizeTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{2}:\d{2}$/.test(value)
  ) {
    return null;
  }

  const [hour, minute] =
    value.split(":").map(Number);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return value;
}


function timeToMinutes(value) {
  const [hour, minute] =
    value.split(":").map(Number);

  return hour * 60 + minute;
}


function calculateTotalMinutes(config) {
  return (
    timeToMinutes(config.lunch_out) -
      timeToMinutes(config.entry_am) +

    timeToMinutes(config.exit_pm) -
      timeToMinutes(config.lunch_in)
  );
}


function formatMinutes(minutes) {
  const hours =
    Math.floor(minutes / 60);

  const mins =
    minutes % 60;

  return `${hours} h ${String(mins).padStart(2, "0")} min`;
}


function eventLabel(event) {
  return (
    EVENTS.find(
      (item) => item.event === event
    )?.label || event
  );
}


// ==================================================
// UTIL
// ==================================================

function redirect(path) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: path,
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
