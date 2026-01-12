const DATA_URL = `garden_master_full.json?v=${Date.now()}`;

function $(sel) { return document.querySelector(sel); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showTab(tabName) {
  document.querySelectorAll("main section").forEach(s => s.style.display = "none");
  const active = document.getElementById(`tab-${tabName}`);
  if (active) active.style.display = "block";

  document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`nav button[data-tab="${tabName}"]`);
  if (btn) btn.classList.add("active");
}

function normalizeTask(task, plantName) {
  // Accept multiple possible shapes.
  // We only need: date + title + plant
  const date =
    task.date ||
    task.date_target ||
    task.start_date ||
    task.when ||
    null;

  const title =
    task.title ||
    task.task ||
    task.template ||
    task.type ||
    "Task";

  return { date, title, plant: plantName, raw: task };
}

function renderPlants(data) {
  const root = $("#plants-list");
  root.innerHTML = "";

  (data.plants || []).forEach(p => {
    const card = el("div", "card");
    card.appendChild(el("div", "card-title", p.name));

    const meta = el("div", "muted",
      `${p.category || "plant"} · ${p.species || ""}`.trim()
    );
    card.appendChild(meta);

    const notes = [];
    const sun = p?.site_requirements?.sun;
    const ph = p?.site_requirements?.soil_ph;
    if (sun) notes.push(`Sun: ${sun}`);
    if (ph) notes.push(`Soil pH: ${ph}`);
    if (notes.length) card.appendChild(el("div", "small", notes.join(" · ")));

    root.appendChild(card);
  });
}

function renderCalendar(data) {
  const yearSel = $("#cal-year");
  const monthSel = $("#cal-month");
  const view = $("#calendar-view");

  // Build years from meta frost year or created_on or default current year
  const years = new Set();
  const created = data?.meta?.created_on;
  if (created && /^\d{4}/.test(created)) years.add(parseInt(created.slice(0, 4), 10));
  years.add(new Date().getFullYear());

  yearSel.innerHTML = "";
  [...years].sort().forEach(y => {
    const opt = el("option");
    opt.value = String(y);
    opt.textContent = String(y);
    yearSel.appendChild(opt);
  });

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  monthSel.innerHTML = "";
  months.forEach((m, i) => {
    const opt = el("option");
    opt.value = String(i);
    opt.textContent = m;
    monthSel.appendChild(opt);
  });

  const now = new Date();
  yearSel.value = String(now.getFullYear());
  monthSel.value = String(now.getMonth());

  function rerender() {
    view.innerHTML = "";

    const year = parseInt(yearSel.value, 10);
    const month = parseInt(monthSel.value, 10);

    // Collect tasks from all plants
    let tasks = [];
    (data.plants || []).forEach(p => {
      const plan = p.task_plan || p.tasks || [];
      plan.forEach(t => tasks.push(normalizeTask(t, p.name)));
    });

    // Keep only those with parseable dates in the selected month/year
    tasks = tasks
      .map(t => ({...t, dt: t.date ? new Date(t.date) : null}))
      .filter(t => t.dt && !isNaN(t.dt))
      .filter(t => t.dt.getFullYear() === year && t.dt.getMonth() === month)
      .sort((a,b) => a.dt - b.dt);

    if (tasks.length === 0) {
      view.appendChild(el("div", "muted", "No scheduled tasks found for this month (based on task_plan in your JSON)."));
      view.appendChild(el("div", "small",
        "If you expect tasks here, confirm each plant has a task_plan[] with date/date_target fields."
      ));
      return;
    }

    // Group by day
    const byDay = new Map();
    for (const t of tasks) {
      const key = t.dt.toISOString().slice(0,10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(t);
    }

    [...byDay.keys()].sort().forEach(day => {
      const dayBlock = el("div", "day-block");
      dayBlock.appendChild(el("div", "day-title", day));
      byDay.get(day).forEach(t => {
        const item = el("div", "task-row");
        item.appendChild(el("div", "task-main", `${t.title}`));
        item.appendChild(el("div", "muted", t.plant));
        dayBlock.appendChild(item);
      });
      view.appendChild(dayBlock);
    });
  }

  yearSel.addEventListener("change", rerender);
  monthSel.addEventListener("change", rerender);
  rerender();
}

async function loadData() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Data fetch failed: ${res.status}`);
  return res.json();
}

document.addEventListener("DOMContentLoaded", async () => {
  // Wire tabs
  document.querySelectorAll("nav button[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });
  showTab("today");

  try {
    const data = await loadData();
    $("#data-status").textContent = `Loaded ${data.plants?.length || 0} plants`;
    renderPlants(data);
    renderCalendar(data);
  } catch (e) {
    console.error(e);
    $("#data-status").textContent = `Failed to load data: ${e.message}`;
  }
});
