import v3 from "./index-v3.js";

const APP_VERSION = "2.4.0-fluid-calendar";
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
      });
    }

    if (request.method === "POST" && url.pathname === "/save-vacations-all") {
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

      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) {
        return textResponse("Forbidden", 403);
      }

      return saveAllVacations(request, env);
    }

    const response = await v3.fetch(request, env, ctx);

    if (
      request.method !== "GET" ||
      url.pathname !== "/" ||
      response.status !== 200 ||
      !(response.headers.get("Content-Type") || "").includes("text/html")
    ) {
      return response;
    }

    const existingRows = await env.DB.prepare(`
      SELECT date
      FROM vacations
      ORDER BY date
    `).all();

    const vacationDates = (existingRows.results || [])
      .map((row) => String(row.date || ""))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

    let html = await response.text();
    html = html.replace("2.3.0-manual-overtime", APP_VERSION);

    const sectionStart = html.indexOf('<section class="card"><h2>Vacaciones</h2>');
    const nextSection = '<section class="card"><h2>Control manual / horas extra</h2>';
    const sectionEnd = html.indexOf(nextSection);

    if (sectionStart !== -1 && sectionEnd !== -1 && sectionEnd > sectionStart) {
      const requestedMonth = url.searchParams.get("month");
      const today = getMadridDateParts(new Date());
      const initialMonth = /^\d{4}-\d{2}$/.test(requestedMonth || "")
        ? requestedMonth
        : `${today.year}-${today.month}`;

      const replacement = buildFluidCalendarSection(vacationDates, initialMonth);
      html = html.slice(0, sectionStart) + replacement + html.slice(sectionEnd);
    }

    return new Response(html, {
      status: response.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Woffu-Clock-Version": APP_VERSION,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  },

  async scheduled(controller, env, ctx) {
    return v3.scheduled(controller, env, ctx);
  },
};

async function saveAllVacations(request, env) {
  const form = await request.formData();
  const rawDates = String(form.get("dates") || "");
  const displayMonth = String(form.get("display_month") || "");

  const selectedDates = Array.from(
    new Set(
      rawDates
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .filter(isWeekdayDate)
    .sort();

  const existingRows = await env.DB.prepare(`
    SELECT date FROM vacations
  `).all();

  const existingDates = (existingRows.results || [])
    .map((row) => String(row.date || ""))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));

  const affectedWeeks = new Set(
    [...existingDates, ...selectedDates].map(getWeekStart)
  );

  const statements = [
    env.DB.prepare(`DELETE FROM vacations`),
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

  const safeMonth = /^\d{4}-\d{2}$/.test(displayMonth)
    ? displayMonth
    : "";

  return new Response(null, {
    status: 303,
    headers: {
      Location: safeMonth ? `/?month=${safeMonth}` : "/",
      "Cache-Control": "no-store",
      "X-Woffu-Clock-Version": APP_VERSION,
    },
  });
}

function buildFluidCalendarSection(vacationDates, initialMonth) {
  const datesJson = JSON.stringify(vacationDates);
  const monthJson = JSON.stringify(initialMonth);

  return `<section class="card" id="fluidVacationCard">
    <h2>Vacaciones</h2>
    <p class="hint">Navega entre meses sin recargar. Puedes marcar días de varios meses y guardarlos todos de una sola vez.</p>

    <form id="fluidVacationForm" method="POST" action="/save-vacations-all">
      <input id="fluidVacationDates" type="hidden" name="dates" value="">
      <input id="fluidDisplayMonth" type="hidden" name="display_month" value="${escapeHtml(initialMonth)}">

      <div class="calendarHead">
        <button id="fluidPrevMonth" class="calendarNav" type="button" aria-label="Mes anterior">←</button>
        <strong id="fluidMonthTitle"></strong>
        <button id="fluidNextMonth" class="calendarNav" type="button" aria-label="Mes siguiente">→</button>
      </div>

      <div id="fluidCalendar" class="calendar" aria-live="polite"></div>

      <div class="fluidCalendarTools">
        <button id="fluidToday" type="button" class="secondary compact">Mes actual</button>
        <span id="fluidVacationStatus" class="vacStatus">Sin cambios pendientes</span>
      </div>

      <button id="fluidSaveVacations" class="saveVac" disabled>Guardar vacaciones</button>
    </form>

    <script>
    (() => {
      const root = document.getElementById('fluidVacationCard');
      if (!root || root.dataset.initialized === '1') return;
      root.dataset.initialized = '1';

      const initialDates = ${datesJson};
      const selected = new Set(initialDates);
      const baseline = new Set(initialDates);
      let currentMonth = ${monthJson};

      const calendar = document.getElementById('fluidCalendar');
      const title = document.getElementById('fluidMonthTitle');
      const hiddenDates = document.getElementById('fluidVacationDates');
      const hiddenMonth = document.getElementById('fluidDisplayMonth');
      const status = document.getElementById('fluidVacationStatus');
      const save = document.getElementById('fluidSaveVacations');
      const prev = document.getElementById('fluidPrevMonth');
      const next = document.getElementById('fluidNextMonth');
      const todayButton = document.getElementById('fluidToday');

      const monthNames = [
        'Enero','Febrero','Marzo','Abril','Mayo','Junio',
        'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
      ];
      const labels = ['Lu','Ma','Mi','Ju','Vi','Sá','Do'];

      function parseMonth(value) {
        const [year, month] = value.split('-').map(Number);
        return { year, month };
      }

      function formatMonth(year, month) {
        return year + '-' + String(month).padStart(2, '0');
      }

      function shiftMonth(value, delta) {
        const { year, month } = parseMonth(value);
        const d = new Date(Date.UTC(year, month - 1 + delta, 1));
        return formatMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
      }

      function currentMadridMonth() {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit'
        }).formatToParts(new Date());
        const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
        return map.year + '-' + map.month;
      }

      function differenceCount() {
        let count = 0;
        for (const date of baseline) if (!selected.has(date)) count++;
        for (const date of selected) if (!baseline.has(date)) count++;
        return count;
      }

      function syncState() {
        hiddenDates.value = Array.from(selected).sort().join(',');
        hiddenMonth.value = currentMonth;
        const changes = differenceCount();
        save.disabled = changes === 0;

        if (changes === 0) {
          status.textContent = selected.size + ' día(s) guardado(s) · sin cambios pendientes';
        } else {
          status.textContent = selected.size + ' día(s) seleccionado(s) · ' +
            changes + (changes === 1 ? ' cambio pendiente' : ' cambios pendientes');
        }

        const url = new URL(window.location.href);
        url.searchParams.set('month', currentMonth);
        history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
      }

      function render() {
        const { year, month } = parseMonth(currentMonth);
        title.textContent = monthNames[month - 1] + ' ' + year;
        calendar.replaceChildren();

        for (const label of labels) {
          const el = document.createElement('div');
          el.className = 'calLabel';
          el.textContent = label;
          calendar.appendChild(el);
        }

        const first = new Date(Date.UTC(year, month - 1, 1));
        const mondayIndex = (first.getUTCDay() + 6) % 7;
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

        for (let i = 0; i < mondayIndex; i++) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          calendar.appendChild(empty);
        }

        for (let day = 1; day <= daysInMonth; day++) {
          const date = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
          const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
          const weekend = weekday === 0 || weekday === 6;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'calDay' + (weekend ? ' weekend' : '') + (selected.has(date) ? ' selected' : '');
          button.textContent = String(day);
          button.disabled = weekend;
          button.setAttribute('aria-pressed', selected.has(date) ? 'true' : 'false');

          if (!weekend) {
            button.addEventListener('click', () => {
              if (selected.has(date)) selected.delete(date);
              else selected.add(date);
              button.classList.toggle('selected', selected.has(date));
              button.setAttribute('aria-pressed', selected.has(date) ? 'true' : 'false');
              syncState();
            });
          }

          calendar.appendChild(button);
        }

        syncState();
      }

      prev.addEventListener('click', () => {
        currentMonth = shiftMonth(currentMonth, -1);
        render();
      });

      next.addEventListener('click', () => {
        currentMonth = shiftMonth(currentMonth, 1);
        render();
      });

      todayButton.addEventListener('click', () => {
        currentMonth = currentMadridMonth();
        render();
      });

      render();
    })();
    </script>

    <style>
      #fluidVacationCard .calendarHead button.calendarNav {
        width:auto;margin:0;background:#eee;color:#171717;padding:8px 14px;
      }
      #fluidVacationCard .fluidCalendarTools {
        display:flex;gap:12px;align-items:center;margin-top:12px;
      }
      #fluidVacationCard .compact { width:auto;margin:0;padding:9px 12px; }
      #fluidVacationCard .vacStatus { flex:1;text-align:right; }
      @media(max-width:650px){
        #fluidVacationCard .fluidCalendarTools{display:block}
        #fluidVacationCard .compact{width:100%;margin-bottom:9px}
        #fluidVacationCard .vacStatus{display:block;text-align:left}
      }
    </style>
  </section>`;
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

function isWeekdayDate(dateString) {
  const date = parseDate(dateString);
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function getWeekStart(dateString) {
  const date = parseDate(dateString);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return toDateString(date);
}

function parseDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getMadridDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: map.year, month: map.month, day: map.day };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Woffu-Clock-Version": APP_VERSION,
    },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
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
