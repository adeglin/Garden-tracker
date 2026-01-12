const DATA_URL = `garden_master_full.json?v=${Date.now()}`;

function $(sel, root = document) { return root.querySelector(sel); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showTab(tabName) {
  document.querySelectorAll("main section").forEach(section => {
    section.classList.toggle("active", section.id === `tab-${tabName}`);
  });

  document.querySelectorAll("nav button[data-tab]").forEach(button => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
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

  return { date, title, plant: plantName, template: task.template || task.type, raw: task };
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getPlantPlanDefaults(plant) {
  const methodsSupported = plant?.planting?.methods_supported || [];
  const hasDirectSowTask = (plant.task_plan || []).some(t => t.template === "direct_sow");
  const hasTransplantTask = (plant.task_plan || []).some(t => t.template === "transplant");
  const availableMethods = new Set(methodsSupported);
  if (hasDirectSowTask) availableMethods.add("direct_sow");
  if (hasTransplantTask) availableMethods.add("transplant");
  if (!availableMethods.size) availableMethods.add("direct_sow");

  const seasons = new Set();
  if (plant?.planting?.spring || plant?.planting?.spring_direct_sow_window || plant?.planting?.spring_transplant_window) {
    seasons.add("spring");
  }
  if (plant?.planting?.fall || plant?.planting?.fall_direct_sow_window || plant?.planting?.fall_transplant_window) {
    seasons.add("fall");
  }
  if (!seasons.size) seasons.add("spring");

  const methods = [...availableMethods];
  return {
    methods: Object.fromEntries(methods.map(m => [m, m === methods[0]])),
    seasons: Object.fromEntries([...seasons].map(s => [s, s === "spring"])),
    cycles: { 1: true, 2: false, 3: false },
  };
}

function getSuccessionIntervalDays(plant) {
  const interval = (plant.task_plan || []).find(t => t.succession_interval_days)?.succession_interval_days;
  if (interval) return interval;
  return 21;
}

function getPlantingWindowStart(plant, method, season) {
  const planting = plant.planting || {};
  if (planting[season]) {
    if (method === "direct_sow" && planting[season].direct_sow_window?.start) {
      return planting[season].direct_sow_window.start;
    }
    if (method === "transplant" && planting[season].transplant_window?.start) {
      return planting[season].transplant_window.start;
    }
  }
  const fallbackKey = `${season}_${method}_window`;
  if (planting[fallbackKey]?.start) return planting[fallbackKey].start;
  const simpleKey = `${season}_direct_sow_window`;
  if (method === "direct_sow" && planting[simpleKey]?.start) return planting[simpleKey].start;
  return null;
}

function getBasePlanAnchor(plant, method) {
  const plan = plant.task_plan || [];
  if (method === "direct_sow") {
    const direct = plan.find(t => t.template === "direct_sow");
    if (direct?.date_target) return direct.date_target;
  }
  if (method === "transplant") {
    const transplant = plan.find(t => t.template === "transplant");
    if (transplant?.date_target) return transplant.date_target;
    const seedStart = plan.find(t => t.template === "seed_start_indoor");
    if (seedStart?.date_target) return seedStart.date_target;
  }
  const dated = plan.map(t => parseDate(t.date_target || t.start_date || t.date)).filter(Boolean);
  if (dated.length) {
    dated.sort((a, b) => a - b);
    return formatDate(dated[0]);
  }
  return null;
}

function buildScheduleForPlan(plant, method, season, cycleIndex) {
  const plan = plant.task_plan || [];
  const baseAnchor = getBasePlanAnchor(plant, method);
  const seasonAnchor = getPlantingWindowStart(plant, method, season) || baseAnchor;
  const baseDate = parseDate(baseAnchor);
  const targetDate = parseDate(seasonAnchor);
  const successionOffset = (cycleIndex - 1) * getSuccessionIntervalDays(plant);
  const shiftDays = baseDate && targetDate ? Math.round((targetDate - baseDate) / 86400000) : 0;
  const totalShift = shiftDays + successionOffset;

  const excludeForDirect = new Set(["seed_start_indoor", "harden_off", "transplant"]);
  const excludeForTransplant = new Set(["direct_sow"]);

  return plan
    .filter(task => {
      if (method === "direct_sow") return !excludeForDirect.has(task.template);
      if (method === "transplant") return !excludeForTransplant.has(task.template);
      return true;
    })
    .map(task => {
      const base = normalizeTask(task, plant.name);
      const date = parseDate(base.date);
      if (!date) return null;
      const adjusted = addDays(date, totalShift);
      return {
        ...base,
        date: formatDate(adjusted),
        dt: adjusted,
        method,
        season,
        cycle: cycleIndex,
      };
    })
    .filter(Boolean);
}

function collectPlannedTasks(data, state) {
  const tasks = [];
  (data.plants || []).forEach(plant => {
    const plan = state.plantPlans.get(plant.name) || getPlantPlanDefaults(plant);
    state.plantPlans.set(plant.name, plan);
    const selectedMethods = Object.entries(plan.methods).filter(([, v]) => v).map(([k]) => k);
    const selectedSeasons = Object.entries(plan.seasons).filter(([, v]) => v).map(([k]) => k);
    const selectedCycles = Object.entries(plan.cycles).filter(([, v]) => v).map(([k]) => Number(k));
    if (!selectedMethods.length || !selectedSeasons.length || !selectedCycles.length) return;

    selectedMethods.forEach(method => {
      selectedSeasons.forEach(season => {
        selectedCycles.forEach(cycleIndex => {
          tasks.push(...buildScheduleForPlan(plant, method, season, cycleIndex));
        });
      });
    });
  });
  return tasks;
}

function renderPlantList(data, state, main) {
  const root = $("#plants-list", main);
  const query = state.search?.toLowerCase() || "";
  root.innerHTML = "";

  const plants = (data.plants || []).filter(p => {
    if (!query) return true;
    const haystack = `${p.name} ${p.category || ""} ${p.species || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  plants.forEach(p => {
    const row = el("div", "row");
    row.dataset.plant = p.name;
    row.tabIndex = 0;
    if (state.selectedPlant === p.name) row.style.borderColor = "rgba(52,211,153,0.5)";

    const top = el("div", "row-top");
    const info = el("div");
    info.appendChild(el("div", "row-title", p.name));
    info.appendChild(el("div", "row-meta", `${p.category || "Plant"} · ${p.species || "Unknown"}`));
    top.appendChild(info);
    top.appendChild(el("span", "badge", p?.planting?.methods_supported?.join(" / ") || "plan"));
    row.appendChild(top);

    row.addEventListener("click", () => {
      state.selectedPlant = p.name;
      renderPlantDetail(p, state, main);
      renderPlantList(data, state, main);
      renderTodayTasks(data, state, main);
      renderCalendar(data, state, main);
    });
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        row.click();
      }
    });

    root.appendChild(row);
  });
}

function renderPlantDetail(plant, state, main) {
  const title = $("#plant-title", main);
  const detail = $("#plant-detail", main);
  if (!plant) {
    title.textContent = "Select a plant";
    detail.textContent = "Pick a plant on the left.";
    detail.className = "muted";
    return;
  }

  const plan = state.plantPlans.get(plant.name) || getPlantPlanDefaults(plant);
  state.plantPlans.set(plant.name, plan);
  title.textContent = plant.name;
  detail.className = "detail";
  detail.innerHTML = "";

  const summary = el("div");
  summary.appendChild(el("div", "row-meta", `${plant.category || "Plant"} · ${plant.species || "Unknown"}`));
  if (plant.site_requirements?.sun) {
    summary.appendChild(el("div", "small", `Sun: ${plant.site_requirements.sun}`));
  }
  if (plant.site_requirements?.soil_ph) {
    summary.appendChild(el("div", "small", `Soil pH: ${plant.site_requirements.soil_ph}`));
  }
  detail.appendChild(summary);

  detail.appendChild(el("hr", "sep"));

  const planSection = el("div");
  planSection.appendChild(el("h3", null, "Plan controls"));

  const methodRow = el("div", "row");
  methodRow.appendChild(el("div", "row-title", "Method"));
  const methodOptions = el("div", "row-actions");
  ["direct_sow", "transplant"].forEach(method => {
    if (plant?.planting?.methods_supported && !plant.planting.methods_supported.includes(method)) return;
    const label = el("label", "toggle");
    const input = el("input");
    input.type = "checkbox";
    input.checked = Boolean(plan.methods[method]);
    input.addEventListener("change", () => {
      plan.methods[method] = input.checked;
      state.plantPlans.set(plant.name, { ...plan });
      renderPlantDetail(plant, state, main);
      renderTodayTasks(window.__gardenData, state, main);
      renderCalendar(window.__gardenData, state, main);
    });
    label.appendChild(input);
    label.appendChild(el("span", null, method.replace("_", " ")));
    methodOptions.appendChild(label);
  });
  methodRow.appendChild(methodOptions);
  planSection.appendChild(methodRow);

  const seasonRow = el("div", "row");
  seasonRow.appendChild(el("div", "row-title", "Season"));
  const seasonOptions = el("div", "row-actions");
  ["spring", "fall"].forEach(season => {
    const hasSeason = plant?.planting?.[season] || plant?.planting?.[`${season}_direct_sow_window`] || plant?.planting?.[`${season}_transplant_window`];
    if (!hasSeason) return;
    const label = el("label", "toggle");
    const input = el("input");
    input.type = "checkbox";
    input.checked = Boolean(plan.seasons[season]);
    input.addEventListener("change", () => {
      plan.seasons[season] = input.checked;
      state.plantPlans.set(plant.name, { ...plan });
      renderPlantDetail(plant, state, main);
      renderTodayTasks(window.__gardenData, state, main);
      renderCalendar(window.__gardenData, state, main);
    });
    label.appendChild(input);
    label.appendChild(el("span", null, season));
    seasonOptions.appendChild(label);
  });
  seasonRow.appendChild(seasonOptions);
  planSection.appendChild(seasonRow);

  const cycleRow = el("div", "row");
  cycleRow.appendChild(el("div", "row-title", "Cycles"));
  const cycleOptions = el("div", "row-actions");
  [1, 2, 3].forEach(cycle => {
    const label = el("label", "toggle");
    const input = el("input");
    input.type = "checkbox";
    input.checked = Boolean(plan.cycles[cycle]);
    input.addEventListener("change", () => {
      plan.cycles[cycle] = input.checked;
      state.plantPlans.set(plant.name, { ...plan });
      renderPlantDetail(plant, state, main);
      renderTodayTasks(window.__gardenData, state, main);
      renderCalendar(window.__gardenData, state, main);
    });
    label.appendChild(input);
    label.appendChild(el("span", null, `Cycle ${cycle}`));
    cycleOptions.appendChild(label);
  });
  cycleRow.appendChild(cycleOptions);
  planSection.appendChild(cycleRow);

  const interval = getSuccessionIntervalDays(plant);
  planSection.appendChild(el("div", "muted", `Succession offset: ${interval} days between cycles.`));
  detail.appendChild(planSection);

  detail.appendChild(el("hr", "sep"));

  const tasksPreview = el("div");
  tasksPreview.appendChild(el("h3", null, "Next tasks"));
  const previewList = el("div", "list");
  const tasks = collectPlannedTasks({ plants: [plant] }, state)
    .filter(t => t.dt)
    .sort((a, b) => a.dt - b.dt)
    .slice(0, 5);
  if (!tasks.length) {
    previewList.appendChild(el("div", "muted", "No tasks match the current plan selections."));
  } else {
    tasks.forEach(task => {
      const row = el("div", "row");
      const top = el("div", "row-top");
      const info = el("div");
      info.appendChild(el("div", "row-title", task.title));
      info.appendChild(el("div", "row-meta", `${task.date} · ${task.season} · ${task.method.replace("_", " ")} · Cycle ${task.cycle}`));
      top.appendChild(info);
      row.appendChild(top);
      previewList.appendChild(row);
    });
  }
  tasksPreview.appendChild(previewList);
  detail.appendChild(tasksPreview);
}

function renderTodayTasks(data, state, main) {
  const root = $("#today-tasks", main);
  if (!root) return;
  root.innerHTML = "";
  const tasks = collectPlannedTasks(data, state);
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const horizon = addDays(now, 7);
  const dueTasks = tasks
    .filter(t => t.dt)
    .filter(t => t.dt <= horizon)
    .sort((a, b) => a.dt - b.dt);

  if (!dueTasks.length) {
    root.appendChild(el("div", "muted", "No tasks due in the next week based on your plan selections."));
    return;
  }

  dueTasks.forEach(task => {
    const row = el("div", "row");
    const top = el("div", "row-top");
    const info = el("div");
    info.appendChild(el("div", "row-title", task.title));
    info.appendChild(el("div", "row-meta", `${task.plant} · ${task.season} · ${task.method.replace("_", " ")} · Cycle ${task.cycle}`));
    top.appendChild(info);

    const badge = el("span", "badge", task.date);
    if (task.dt < startOfToday) {
      badge.classList.add("overdue");
    } else {
      badge.classList.add("due");
    }
    top.appendChild(badge);
    row.appendChild(top);
    root.appendChild(row);
  });
}

function renderCalendar(data, state, main) {
  const yearSel = $("#cal-year", main);
  const grid = $("#calendar-grid", main);
  if (!yearSel || !grid) return;

  function rerender() {
    grid.innerHTML = "";
    const year = parseInt(yearSel.value, 10);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const tasks = collectPlannedTasks(data, state).filter(t => t.dt && t.dt.getFullYear() === year);

    if (!tasks.length) {
      grid.appendChild(el("div", "muted", "No tasks scheduled for this year with the current plan selections."));
      return;
    }

    const table = el("table");
    table.style.width = "100%";
    table.style.borderCollapse = "collapse";

    const headerRow = el("tr");
    headerRow.appendChild(el("th", "muted", "Plant"));
    months.forEach(month => {
      headerRow.appendChild(el("th", "muted", month));
    });
    table.appendChild(headerRow);

    (data.plants || []).forEach(plant => {
      const row = el("tr");
      const label = el("td");
      label.textContent = plant.name;
      label.style.fontSize = "12px";
      row.appendChild(label);

      const plantTasks = tasks.filter(t => t.plant === plant.name);
      const counts = Array(12).fill(0);
      plantTasks.forEach(task => {
        counts[task.dt.getMonth()] += 1;
      });

      counts.forEach(count => {
        const cell = el("td");
        cell.style.textAlign = "center";
        cell.style.fontSize = "12px";
        cell.textContent = count ? String(count) : "–";
        row.appendChild(cell);
      });
      table.appendChild(row);
    });

    grid.appendChild(table);
  }

  if (!yearSel.dataset.ready) {
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

    yearSel.value = String(new Date().getFullYear());
    yearSel.onchange = rerender;
    yearSel.dataset.ready = "true";
  }
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
    window.__gardenData = data;
    const main = document.querySelector("main");
    const state = {
      selectedPlant: null,
      plantPlans: new Map(),
      search: "",
    };
    const status = $("#data-status", main) || $("#data-status");
    if (status) status.textContent = `Loaded ${data.plants?.length || 0} plants`;
    const subtitle = $("#subtitle");
    if (subtitle) {
      const region = data?.meta?.region;
      const regionName = [region?.city, region?.state].filter(Boolean).join(", ");
      const zone = region?.usda_zone_estimate ? `USDA Zone ${region.usda_zone_estimate}` : null;
      const updated = data?.meta?.created_on ? `Updated ${data.meta.created_on}` : null;
      const summary = [regionName, zone, updated].filter(Boolean).join(" · ");
      subtitle.textContent = summary || "Garden data loaded";
    }

    const search = $("#plant-search", main);
    if (search) {
      search.addEventListener("input", () => {
        state.search = search.value;
        renderPlantList(data, state, main);
      });
    }

    renderPlantList(data, state, main);
    renderPlantDetail(null, state, main);
    renderTodayTasks(data, state, main);
    renderCalendar(data, state, main);
  } catch (e) {
    console.error(e);
    const status = $("#data-status", document.querySelector("main")) || $("#data-status");
    if (status) status.textContent = `Failed to load data: ${e.message}`;
  }
});
