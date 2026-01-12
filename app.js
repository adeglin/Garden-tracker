const DATA_URL = `garden_master_full.json?v=${Date.now()}`;
const STORAGE_KEYS = {
  taskNotes: "garden_task_notes_v1",
  scheduleShifts: "garden_schedule_shifts_v1",
  taskCompletion: "garden_task_completion_v1",
  taskDateOverrides: "garden_task_date_overrides_v1",
};

const TEMPLATE_DISPLAY_NAMES = {
  pre_plant_soil_amendment: "Soil Prep",
  seed_start_indoor: "Seed Start",
  direct_sow: "Direct Sow",
  harden_off: "Harden Off",
  transplant: "Transplant",
  thin_seedlings: "Thin Seedlings",
  install_support: "Install Support",
  fertilize: "Fertilize",
  fish_fertilizer: "Fertilize",
  tomato_tone_topdress: "Fertilize",
  irrigation_check: "Irrigation Check",
  pest_scout: "Pest Scout",
  spray: "Spray",
  prune_train: "Prune/Train",
  harvest: "Harvest",
  succession_sow: "Succession Sow",
  end_of_season_cleanup: "End of Season Cleanup",
  cleanup_rotate: "Cleanup & Rotate",
};

const FERTILIZER_TEMPLATES = new Set(["fertilize", "fish_fertilizer", "tomato_tone_topdress"]);
const SOIL_PREP_TEMPLATES = new Set(["pre_plant_soil_amendment"]);
const ICON_EXAMPLE_PLANT = "Waltham 29 Broccoli";

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

function loadStoredJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveStoredJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function makeScheduleKey(plantName, method, season, cycle) {
  return [plantName, method, season, cycle].join("||");
}

function makeTaskKey(task) {
  return task.key || [task.scheduleKey, task.template || task.title, task.baseDate || task.date].join("||");
}

function getTaskDisplayName(template) {
  if (TEMPLATE_DISPLAY_NAMES[template]) return TEMPLATE_DISPLAY_NAMES[template];
  return template ? template.replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase()) : "Task";
}

function getTaskTitle(task) {
  const label = getTaskDisplayName(task.template);
  const plantLabel = task.plant || "Garden";
  return `${label} — ${plantLabel}`;
}

function getPlantIcon(plant, sizeClass) {
  if (!plant?.visual?.icon) return null;
  if (plant.name !== ICON_EXAMPLE_PLANT) return null;
  const img = el("img", sizeClass || "plant-icon");
  img.src = plant.visual.icon;
  img.alt = `${plant.name} icon`;
  return img;
}

function getAvailableMethods(plant) {
  const methodsSupported = plant?.planting?.methods_supported || [];
  const hasDirectSowTask = (plant.task_plan || []).some(t => t.template === "direct_sow");
  const hasTransplantTask = (plant.task_plan || []).some(t => t.template === "transplant");
  const availableMethods = new Set(methodsSupported);
  if (hasDirectSowTask) availableMethods.add("direct_sow");
  if (hasTransplantTask) availableMethods.add("transplant");
  if (!availableMethods.size) availableMethods.add("direct_sow");
  return [...availableMethods];
}

function getAvailableSeasons(plant) {
  const seasons = new Set();
  if (plant?.planting?.spring || plant?.planting?.spring_direct_sow_window || plant?.planting?.spring_transplant_window) {
    seasons.add("spring");
  }
  if (plant?.planting?.fall || plant?.planting?.fall_direct_sow_window || plant?.planting?.fall_transplant_window) {
    seasons.add("fall");
  }
  if (!seasons.size) seasons.add("spring");
  return [...seasons];
}

function getPlantPlanDefaults(plant) {
  const methods = getAvailableMethods(plant);
  const seasons = getAvailableSeasons(plant);
  const interval = getSuccessionIntervalDays(plant);
  const cycles = interval ? { 1: true, 2: false, 3: false } : { 1: true };
  return {
    methods: Object.fromEntries(methods.map(m => [m, m === methods[0]])),
    seasons: Object.fromEntries([...seasons].map(s => [s, s === "spring"])),
    cycles,
  };
}

function getSuccessionIntervalDays(plant) {
  const interval = (plant.task_plan || []).find(t => t.succession_interval_days)?.succession_interval_days;
  if (interval) return interval;
  return null;
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

function buildScheduleForPlan(plant, method, season, cycleIndex, extraShiftDays = 0, scheduleKey = "") {
  const plan = plant.task_plan || [];
  const baseAnchor = getBasePlanAnchor(plant, method);
  const seasonAnchor = getPlantingWindowStart(plant, method, season) || baseAnchor;
  const baseDate = parseDate(baseAnchor);
  const targetDate = parseDate(seasonAnchor);
  const successionInterval = getSuccessionIntervalDays(plant) || 21;
  const successionOffset = (cycleIndex - 1) * successionInterval;
  const shiftDays = baseDate && targetDate ? Math.round((targetDate - baseDate) / 86400000) : 0;
  const baseShift = shiftDays + successionOffset;
  const totalShift = baseShift + extraShiftDays;

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
      const planned = addDays(date, baseShift);
      const adjusted = addDays(date, totalShift);
      return {
        ...base,
        date: formatDate(adjusted),
        plannedDate: formatDate(planned),
        baseDate: base.date,
        dt: adjusted,
        method,
        season,
        cycle: cycleIndex,
        scheduleKey,
      };
    })
    .filter(Boolean);
}

function collectPlannedTasks(data, state) {
  let tasks = [];
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
          const scheduleKey = makeScheduleKey(plant.name, method, season, cycleIndex);
          const extraShiftDays = state.scheduleShifts?.[scheduleKey] || 0;
          tasks.push(...buildScheduleForPlan(plant, method, season, cycleIndex, extraShiftDays, scheduleKey));
        });
      });
    });
  });
  tasks = mergeTasks(tasks, data);
  applyDateOverrides(tasks, state);
  return tasks;
}

function applyDateOverrides(tasks, state) {
  const overrides = state.taskDateOverrides || {};
  tasks.forEach(task => {
    const override = overrides[makeTaskKey(task)];
    if (override) {
      const parsed = parseDate(override);
      if (parsed) {
        task.date = formatDate(parsed);
        task.dt = parsed;
        task.overrideDate = task.date;
      }
    }
  });
}

function mergeTasks(tasks, data) {
  const merged = [];
  const fertilizerMap = new Map();
  const soilPrepMap = new Map();

  tasks.forEach(task => {
    if (SOIL_PREP_TEMPLATES.has(task.template)) {
      const treatmentKey = task.raw?.notes || "standard";
      const key = `soil_prep||${task.date}||${treatmentKey}`;
      if (!soilPrepMap.has(key)) {
        soilPrepMap.set(key, {
          ...task,
          plant: "Garden",
          method: null,
          season: null,
          cycle: null,
          scheduleKey: key,
          key,
          shiftMode: "override",
          appliesTo: new Set(),
          rawItems: [],
        });
      }
      const mergedTask = soilPrepMap.get(key);
      mergedTask.appliesTo.add(task.plant);
      mergedTask.rawItems.push(task.raw);
      return;
    }

    if (FERTILIZER_TEMPLATES.has(task.template)) {
      const key = `fertilize||${task.plant}||${task.date}||${task.method}||${task.season}||${task.cycle}`;
      if (!fertilizerMap.has(key)) {
        fertilizerMap.set(key, {
          ...task,
          template: "fertilize",
          key,
          fertilizers: [],
        });
      }
      const mergedTask = fertilizerMap.get(key);
      mergedTask.fertilizers.push({
        template: task.template,
        product: task.raw?.product,
        dose: task.raw?.dose,
        method: task.raw?.method,
        frequency_days: task.raw?.frequency_days,
        stop_conditions: task.raw?.stop_conditions,
        notes: task.raw?.notes,
      });
      return;
    }

    merged.push(task);
  });

  fertilizerMap.forEach(task => merged.push(task));
  soilPrepMap.forEach(task => {
    task.appliesTo = [...task.appliesTo];
    merged.push(task);
  });

  return merged;
}

function buildTaskInstructionLines(task, plant, data) {
  const lines = [];
  const raw = task.raw || {};
  const templateInstructions = data?.task_instructions?.[task.template];
  if (Array.isArray(templateInstructions)) {
    templateInstructions.forEach(text => lines.push(text));
  }

  if (task.template === "seed_start_indoor") {
    if (raw.tray_cell_size) lines.push(`Tray size: ${raw.tray_cell_size} cell.`);
    if (raw.depth_in) lines.push(`Sow depth: ${raw.depth_in} in.`);
    if (raw.temp_F) lines.push(`Germination temp: ${raw.temp_F}°F.`);
    if (raw.light_hours) lines.push(`Light: ${raw.light_hours} hrs/day.`);
  }

  if (task.template === "direct_sow") {
    if (raw.depth_in) lines.push(`Sow depth: ${raw.depth_in} in.`);
    if (raw.spacing_in) lines.push(`Plant spacing: ${raw.spacing_in} in.`);
    if (raw.row_spacing_in) lines.push(`Row spacing: ${raw.row_spacing_in} in.`);
    if (raw.succession_interval_days) lines.push(`Repeat every ${raw.succession_interval_days} days for successions.`);
  }

  if (task.template === "harden_off") {
    if (raw.duration_days) lines.push(`Harden off for ${raw.duration_days} days.`);
  }

  if (task.template === "transplant") {
    if (raw.spacing_in) lines.push(`Plant spacing: ${raw.spacing_in} in.`);
    if (raw.planting_hole_amendments?.length) {
      lines.push(`Amendments: ${raw.planting_hole_amendments.join(", ")}.`);
    }
    if (raw.water_in_instructions) lines.push(raw.water_in_instructions);
  }

  if (task.template === "thin_seedlings") {
    if (raw.final_spacing_in) lines.push(`Thin to ${raw.final_spacing_in} in. spacing.`);
  }

  if (task.template === "install_support") {
    if (raw.support_type) lines.push(`Support type: ${raw.support_type}.`);
  }

  if (task.template === "spray") {
    if (raw.product) lines.push(`Product: ${raw.product}.`);
    if (raw.dilution) lines.push(`Dilution: ${raw.dilution}.`);
    if (raw.coverage_notes) lines.push(raw.coverage_notes);
    if (raw.reentry_notes) lines.push(raw.reentry_notes);
  }

  if (task.template === "prune_train") {
    if (raw.method) lines.push(`Method: ${raw.method}.`);
  }

  if (task.template === "harvest") {
    if (raw.maturity_signs) lines.push(`Maturity signs: ${raw.maturity_signs}.`);
    if (raw.frequency_days) lines.push(`Harvest every ${raw.frequency_days} days as ready.`);
    if (raw.storage_notes) lines.push(`Storage: ${raw.storage_notes}.`);
  }

  if (task.template === "succession_sow") {
    if (raw.repeat_every_days) lines.push(`Repeat every ${raw.repeat_every_days} days.`);
    if (raw.end_date) lines.push(`Stop successions after ${raw.end_date}.`);
  }

  if (task.template === "pest_scout") {
    if (plant?.pest_disease?.key_pests?.length) {
      lines.push(`Look for pests: ${plant.pest_disease.key_pests.join(", ")}.`);
    }
    if (plant?.pest_disease?.key_diseases?.length) {
      lines.push(`Watch for diseases: ${plant.pest_disease.key_diseases.join(", ")}.`);
    }
  }

  if (task.template === "fertilize") {
    if (task.fertilizers?.length) {
      task.fertilizers.forEach(item => {
        const parts = [];
        if (item.product) parts.push(`Product: ${item.product}`);
        if (item.dose) parts.push(`Dose: ${item.dose}`);
        if (item.method) parts.push(`Method: ${item.method}`);
        if (item.frequency_days) parts.push(`Repeat every ${item.frequency_days} days`);
        if (item.stop_conditions) parts.push(`Stop: ${item.stop_conditions}`);
        if (item.notes) parts.push(item.notes);
        if (parts.length) lines.push(parts.join(". ") + ".");
      });
    } else if (raw.product || raw.dose || raw.method) {
      const parts = [];
      if (raw.product) parts.push(`Product: ${raw.product}`);
      if (raw.dose) parts.push(`Dose: ${raw.dose}`);
      if (raw.method) parts.push(`Method: ${raw.method}`);
      if (raw.frequency_days) parts.push(`Repeat every ${raw.frequency_days} days`);
      if (raw.stop_conditions) parts.push(`Stop: ${raw.stop_conditions}`);
      if (parts.length) lines.push(parts.join(". ") + ".");
    }
  }

  if (task.template === "pre_plant_soil_amendment" && task.appliesTo?.length) {
    lines.push(`Applies to: ${task.appliesTo.join(", ")}.`);
  }

  if (task.rawItems?.length) {
    task.rawItems
      .map(item => item?.notes)
      .filter(Boolean)
      .forEach(note => lines.push(note));
  } else if (raw.notes) {
    lines.push(raw.notes);
  }

  if (!lines.length) {
    lines.push("Follow crop-specific guidance and local conditions.");
  }

  return lines;
}

function renderTaskRow(task, state, data, onUpdate) {
  const row = el("div", "row task-row");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", "false");

  const top = el("div", "row-top");
  const info = el("div");
  info.appendChild(el("div", "row-title", getTaskTitle(task)));
  info.appendChild(el("div", "row-meta", "Tap to expand for instructions and details."));
  top.appendChild(info);

  const badge = el("span", "badge", task.date);
  if (task.dt) {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    if (task.dt < startOfToday) {
      badge.classList.add("overdue");
    } else {
      badge.classList.add("due");
    }
  }
  top.appendChild(badge);

  const taskKey = makeTaskKey(task);
  const completeToggle = el("label", "toggle");
  const completeInput = el("input");
  completeInput.type = "checkbox";
  completeInput.checked = Boolean(state.taskCompletion?.[taskKey]);
  completeInput.addEventListener("change", () => {
    state.taskCompletion = { ...state.taskCompletion, [taskKey]: completeInput.checked };
    saveStoredJSON(STORAGE_KEYS.taskCompletion, state.taskCompletion);
    row.classList.toggle("completed", completeInput.checked);
    onUpdate?.();
  });
  completeToggle.appendChild(completeInput);
  completeToggle.appendChild(el("span", null, "Completed"));
  top.appendChild(completeToggle);

  if (completeInput.checked) {
    row.classList.add("completed");
  }

  row.appendChild(top);

  const details = el("div", "row-details");
  const detailGrid = el("div", "detail-grid");
  detailGrid.appendChild(el("div", "label", "Planned"));
  detailGrid.appendChild(el("div", "muted", task.plannedDate || task.date));
  if (task.method) {
    detailGrid.appendChild(el("div", "label", "Method"));
    detailGrid.appendChild(el("div", "muted", task.method.replace("_", " ")));
  }
  if (task.season) {
    detailGrid.appendChild(el("div", "label", "Season"));
    detailGrid.appendChild(el("div", "muted", task.season));
  }
  if (task.cycle) {
    detailGrid.appendChild(el("div", "label", "Succession"));
    detailGrid.appendChild(el("div", "muted", `Succession ${task.cycle}`));
  }
  details.appendChild(detailGrid);

  const plant = state.plantIndex?.get(task.plant);
  const instructions = buildTaskInstructionLines(task, plant, data);
  const instructionBlock = el("div");
  instructionBlock.appendChild(el("div", "label", "Instructions"));
  const instructionList = el("ul");
  instructions.forEach(text => instructionList.appendChild(el("li", null, text)));
  instructionBlock.appendChild(instructionList);
  details.appendChild(instructionBlock);

  const controls = el("div", "row-controls");
  const dateLabel = el("label", "label", "Reschedule");
  const dateInput = el("input", "input");
  dateInput.type = "date";
  dateInput.value = task.date;
  dateInput.addEventListener("change", () => {
    const newDate = parseDate(dateInput.value);
    const plannedDate = parseDate(task.plannedDate || task.date);
    if (!newDate || !plannedDate) return;
    if (task.shiftMode === "override") {
      state.taskDateOverrides = { ...state.taskDateOverrides, [taskKey]: formatDate(newDate) };
      saveStoredJSON(STORAGE_KEYS.taskDateOverrides, state.taskDateOverrides);
      onUpdate?.();
      return;
    }
    const shiftDays = Math.round((newDate - plannedDate) / 86400000);
    state.scheduleShifts = { ...state.scheduleShifts, [task.scheduleKey]: shiftDays };
    saveStoredJSON(STORAGE_KEYS.scheduleShifts, state.scheduleShifts);
    onUpdate?.();
  });
  controls.appendChild(dateLabel);
  controls.appendChild(dateInput);

  const notesLabel = el("label", "label", "Notes");
  const notesInput = el("textarea", "input");
  notesInput.rows = 3;
  notesInput.value = state.taskNotes?.[taskKey] || "";
  notesInput.addEventListener("input", () => {
    state.taskNotes = { ...state.taskNotes, [taskKey]: notesInput.value };
    saveStoredJSON(STORAGE_KEYS.taskNotes, state.taskNotes);
  });
  controls.appendChild(notesLabel);
  controls.appendChild(notesInput);
  details.appendChild(controls);
  row.appendChild(details);

  const toggleExpanded = () => {
    const expanded = row.classList.toggle("expanded");
    row.setAttribute("aria-expanded", String(expanded));
  };
  row.addEventListener("click", event => {
    if (event.target.closest("input, textarea, label, button, select")) return;
    toggleExpanded();
  });
  row.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleExpanded();
    }
  });

  return row;
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
    const nameRow = el("div", "row-title");
    const icon = getPlantIcon(p);
    if (icon) nameRow.appendChild(icon);
    nameRow.appendChild(document.createTextNode(p.name));
    info.appendChild(nameRow);
    info.appendChild(el("div", "row-meta", `${p.category || "Plant"} · ${p.species || "Unknown"}`));
    top.appendChild(info);
    top.appendChild(el("span", "badge", p?.planting?.methods_supported?.join(" / ") || "plan"));
    row.appendChild(top);

    row.addEventListener("click", () => {
      state.selectedPlant = p.name;
      renderPlantDetail(p, state, main);
      renderPlantList(data, state, main);
      renderTodayTasks(data, state, main);
      renderUpcomingTasks(data, state, main);
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
  const summaryTitle = el("div", "row-title");
  const summaryIcon = getPlantIcon(plant, "plant-icon-lg");
  if (summaryIcon) summaryTitle.appendChild(summaryIcon);
  summaryTitle.appendChild(document.createTextNode(plant.name));
  summary.appendChild(summaryTitle);
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
  const availableMethods = getAvailableMethods(plant);
  if (availableMethods.length <= 1) {
    const methodLabel = availableMethods[0] ? availableMethods[0].replace("_", " ") : "Not specified";
    methodOptions.appendChild(el("div", "muted", methodLabel));
  } else {
    availableMethods.forEach(method => {
      const label = el("label", "toggle");
      const input = el("input");
      input.type = "checkbox";
      input.checked = Boolean(plan.methods[method]);
      input.addEventListener("change", () => {
        plan.methods[method] = input.checked;
        state.plantPlans.set(plant.name, { ...plan });
        renderPlantDetail(plant, state, main);
        renderTodayTasks(window.__gardenData, state, main);
        renderUpcomingTasks(window.__gardenData, state, main);
        renderCalendar(window.__gardenData, state, main);
      });
      label.appendChild(input);
      label.appendChild(el("span", null, method.replace("_", " ")));
      methodOptions.appendChild(label);
    });
  }
  methodRow.appendChild(methodOptions);
  planSection.appendChild(methodRow);

  const seasonRow = el("div", "row");
  seasonRow.appendChild(el("div", "row-title", "Season"));
  const seasonOptions = el("div", "row-actions");
  const availableSeasons = getAvailableSeasons(plant);
  if (availableSeasons.length <= 1) {
    seasonOptions.appendChild(el("div", "muted", availableSeasons[0] || "Not specified"));
  } else {
    availableSeasons.forEach(season => {
      const label = el("label", "toggle");
      const input = el("input");
      input.type = "checkbox";
      input.checked = Boolean(plan.seasons[season]);
      input.addEventListener("change", () => {
        plan.seasons[season] = input.checked;
        state.plantPlans.set(plant.name, { ...plan });
        renderPlantDetail(plant, state, main);
        renderTodayTasks(window.__gardenData, state, main);
        renderUpcomingTasks(window.__gardenData, state, main);
        renderCalendar(window.__gardenData, state, main);
      });
      label.appendChild(input);
      label.appendChild(el("span", null, season));
      seasonOptions.appendChild(label);
    });
  }
  seasonRow.appendChild(seasonOptions);
  planSection.appendChild(seasonRow);

  const cycleRow = el("div", "row");
  cycleRow.appendChild(el("div", "row-title", "Successions"));
  const cycleOptions = el("div", "row-actions");
  const cycleKeys = Object.keys(plan.cycles || {}).map(Number).sort((a, b) => a - b);
  if (cycleKeys.length <= 1) {
    cycleOptions.appendChild(el("div", "muted", "Single planting"));
  } else {
    cycleKeys.forEach(cycle => {
      const label = el("label", "toggle");
      const input = el("input");
      input.type = "checkbox";
      input.checked = Boolean(plan.cycles[cycle]);
      input.addEventListener("change", () => {
        plan.cycles[cycle] = input.checked;
        state.plantPlans.set(plant.name, { ...plan });
        renderPlantDetail(plant, state, main);
        renderTodayTasks(window.__gardenData, state, main);
        renderUpcomingTasks(window.__gardenData, state, main);
        renderCalendar(window.__gardenData, state, main);
      });
      label.appendChild(input);
      label.appendChild(el("span", null, `Succession ${cycle}`));
      cycleOptions.appendChild(label);
    });
  }
  cycleRow.appendChild(cycleOptions);
  planSection.appendChild(cycleRow);

  const interval = getSuccessionIntervalDays(plant);
  if (interval) {
    planSection.appendChild(el("div", "muted", `Succession offset: ${interval} days between cycles.`));
  } else {
    planSection.appendChild(el("div", "muted", "This crop is typically planted once per season."));
  }
  detail.appendChild(planSection);

  detail.appendChild(el("hr", "sep"));

  const infoSection = el("div");
  infoSection.appendChild(el("h3", null, "Plant details"));

  const addInfoBlock = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    const block = el("div");
    block.appendChild(el("div", "row-title", label));
    if (typeof value === "string") {
      block.appendChild(el("div", "muted", value));
    } else if (Array.isArray(value)) {
      const list = el("ul");
      value.forEach(item => {
        if (typeof item === "string") {
          list.appendChild(el("li", null, item));
        } else if (item && typeof item === "object") {
          const text = Object.entries(item).map(([key, val]) => `${key.replace(/_/g, " ")}: ${val}`).join(" · ");
          list.appendChild(el("li", null, text));
        }
      });
      block.appendChild(list);
    } else if (typeof value === "object") {
      const list = el("ul");
      Object.entries(value).forEach(([key, val]) => {
        if (Array.isArray(val)) {
          const text = val
            .map(item => {
              if (typeof item === "string") return item;
              if (item && typeof item === "object") {
                return Object.entries(item)
                  .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                  .join(" · ");
              }
              return "";
            })
            .filter(Boolean)
            .join("; ");
          list.appendChild(el("li", null, `${key.replace(/_/g, " ")}: ${text}`));
        } else {
          const text = val == null ? key : `${key.replace(/_/g, " ")}: ${val}`;
          list.appendChild(el("li", null, text));
        }
      });
      block.appendChild(list);
    }
    infoSection.appendChild(block);
  };

  addInfoBlock("Soil prep", plant.soil_preparation);
  addInfoBlock("Watering", plant.watering);
  addInfoBlock("Support & training", plant.support_and_training);
  addInfoBlock("Succession & rotation", plant.succession_and_rotation);
  addInfoBlock("Harvest & use", plant.harvest_and_use);

  if (plant.fertility_strategy?.length) {
    const fertility = el("div");
    fertility.appendChild(el("div", "row-title", "Fertilizer plan"));
    const list = el("ul");
    plant.fertility_strategy.forEach(entry => {
      const text = [entry.stage, entry.products?.join(", "), entry.dose, entry.timing].filter(Boolean).join(" · ");
      if (text) list.appendChild(el("li", null, text));
    });
    fertility.appendChild(list);
    infoSection.appendChild(fertility);
  }

  if (plant.pest_disease) {
    const pests = el("div");
    pests.appendChild(el("div", "row-title", "Pests & disease"));
    const pestLibrary = data?.pest_disease_library || {};
    if (plant.pest_disease.key_pests?.length) {
      const list = el("ul");
      plant.pest_disease.key_pests.forEach(item => {
        const li = el("li");
        const entry = pestLibrary[item];
        const image = entry?.images?.[0]?.src;
        if (image) {
          const img = el("img", "pest-thumb");
          img.src = image;
          img.alt = item;
          li.appendChild(img);
        }
        li.appendChild(document.createTextNode(item));
        list.appendChild(li);
      });
      pests.appendChild(el("div", "small", "Key pests"));
      pests.appendChild(list);
    }
    if (plant.pest_disease.key_diseases?.length) {
      const list = el("ul");
      plant.pest_disease.key_diseases.forEach(item => {
        const li = el("li");
        const entry = pestLibrary[item];
        const image = entry?.images?.[0]?.src;
        if (image) {
          const img = el("img", "pest-thumb");
          img.src = image;
          img.alt = item;
          li.appendChild(img);
        }
        li.appendChild(document.createTextNode(item));
        list.appendChild(li);
      });
      pests.appendChild(el("div", "small", "Key diseases"));
      pests.appendChild(list);
    }
    if (plant.pest_disease.prevention?.length) {
      const list = el("ul");
      plant.pest_disease.prevention.forEach(item => list.appendChild(el("li", null, item)));
      pests.appendChild(el("div", "small", "Prevention"));
      pests.appendChild(list);
    }
    infoSection.appendChild(pests);
  }

  if (infoSection.children.length > 1) {
    detail.appendChild(infoSection);
    detail.appendChild(el("hr", "sep"));
  }

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
      previewList.appendChild(renderTaskRow(task, state, window.__gardenData, () => {
        renderPlantDetail(plant, state, main);
        renderTodayTasks(window.__gardenData, state, main);
        renderUpcomingTasks(window.__gardenData, state, main);
        renderCalendar(window.__gardenData, state, main);
      }));
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
  const hideComplete = $("#toggle-hide-complete", main)?.checked;
  let dueTasks = tasks
    .filter(t => t.dt)
    .filter(t => t.dt <= horizon)
    .sort((a, b) => a.dt - b.dt);
  if (hideComplete) {
    dueTasks = dueTasks.filter(task => !state.taskCompletion?.[makeTaskKey(task)]);
  }

  if (!dueTasks.length) {
    root.appendChild(el("div", "muted", "No tasks due in the next week based on your plan selections."));
    return;
  }

  dueTasks.forEach(task => {
    root.appendChild(renderTaskRow(task, state, data, () => {
      renderTodayTasks(window.__gardenData, state, main);
      renderUpcomingTasks(window.__gardenData, state, main);
      renderCalendar(window.__gardenData, state, main);
    }));
  });
}

function renderUpcomingTasks(data, state, main) {
  const root = $("#upcoming-tasks", main);
  if (!root) return;
  root.innerHTML = "";
  const windowSelect = $("#upcoming-window", main);
  const windowDays = windowSelect ? parseInt(windowSelect.value, 10) : 30;
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const horizon = addDays(now, windowDays);
  let tasks = collectPlannedTasks(data, state)
    .filter(t => t.dt)
    .filter(t => t.dt >= startOfToday && t.dt <= horizon)
    .sort((a, b) => a.dt - b.dt);
  const hideComplete = $("#toggle-upcoming-hide-complete", main)?.checked;
  if (hideComplete) {
    tasks = tasks.filter(task => !state.taskCompletion?.[makeTaskKey(task)]);
  }

  if (!tasks.length) {
    root.appendChild(el("div", "muted", "No tasks scheduled for the selected window."));
    return;
  }

  tasks.forEach(task => {
    root.appendChild(renderTaskRow(task, state, data, () => {
      renderTodayTasks(window.__gardenData, state, main);
      renderUpcomingTasks(window.__gardenData, state, main);
      renderCalendar(window.__gardenData, state, main);
    }));
  });
}

function renderCalendar(data, state, main) {
  const yearSel = $("#cal-year", main);
  const grid = $("#calendar-grid", main);
  const legend = $("#calendar-legend", main);
  if (!yearSel || !grid) return;

  const stageConfig = [
    { key: "indoors", label: "Plant Indoors", className: "stage-indoors" },
    { key: "transplant", label: "Transplant", className: "stage-transplant" },
    { key: "sow", label: "Sow", className: "stage-sow" },
    { key: "growing", label: "Growing", className: "stage-growing" },
    { key: "harvest", label: "Harvest", className: "stage-harvest" },
  ];
  const stagePriority = ["harvest", "growing", "transplant", "sow", "indoors"];

  const buildLegend = () => {
    if (!legend) return;
    legend.innerHTML = "";
    stageConfig.forEach(stage => {
      const item = el("div", "legend-item");
      const swatch = el("span", "legend-swatch");
      swatch.classList.add(stage.className);
      item.appendChild(swatch);
      item.appendChild(el("span", null, stage.label));
      legend.appendChild(item);
    });
  };

  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const clampDate = (date, year) => {
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    if (date < start) return start;
    if (date > end) return end;
    return date;
  };

  const dateToSlot = date => {
    const month = date.getMonth();
    const half = date.getDate() > 15 ? 1 : 0;
    return month * 2 + half;
  };

  const fillSlots = (slots, startDate, endDate, stageKey) => {
    if (!startDate || !endDate) return;
    const startSlot = dateToSlot(startDate);
    const endSlot = dateToSlot(endDate);
    for (let idx = startSlot; idx <= endSlot; idx += 1) {
      const existing = slots[idx];
      if (!existing || stagePriority.indexOf(stageKey) < stagePriority.indexOf(existing)) {
        slots[idx] = stageKey;
      }
    }
  };

  const extractDurationDays = text => {
    if (!text) return null;
    const range = text.match(/(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)\s*(week|month|day)s?/i);
    const single = text.match(/(\d+(?:\.\d+)?)\s*(week|month|day)s?/i);
    const toDays = (value, unit) => {
      if (unit.startsWith("month")) return value * 30;
      if (unit.startsWith("week")) return value * 7;
      return value;
    };
    if (range) {
      const maxVal = parseFloat(range[2]);
      return Math.round(toDays(maxVal, range[3].toLowerCase()));
    }
    if (single) {
      return Math.round(toDays(parseFloat(single[1]), single[2].toLowerCase()));
    }
    return null;
  };

  const getHarvestSpanDays = plant => {
    const name = plant?.name?.toLowerCase() || "";
    if (name.includes("tomato")) return 90;
    if (name.includes("pepper") || name.includes("cucumber") || name.includes("eggplant")) return 75;
    const harvestWindow = plant?.harvest_and_use?.harvest_window || "";
    const frequency = plant?.harvest_and_use?.frequency || "";
    const fromWindow = extractDurationDays(harvestWindow);
    if (fromWindow) return fromWindow;
    const fromFrequency = extractDurationDays(frequency);
    if (fromFrequency) return fromFrequency;
    if (/weeks|side shoots|multiple/i.test(frequency)) return 60;
    return 30;
  };

  const buildStagesForTasks = (tasks, year) => {
    const stagesByPlant = new Map();
    const scheduleMap = new Map();
    tasks.forEach(task => {
      const key = task.scheduleKey || `${task.plant}||default`;
      if (!scheduleMap.has(key)) scheduleMap.set(key, []);
      scheduleMap.get(key).push(task);
    });

    scheduleMap.forEach(taskList => {
      const plantName = taskList[0]?.plant;
      if (!plantName) return;
      const byTemplate = {};
      taskList.forEach(task => {
        if (!byTemplate[task.template]) byTemplate[task.template] = [];
        byTemplate[task.template].push(task);
      });

      const pickDate = template => {
        const items = byTemplate[template] || [];
        if (!items.length) return null;
        const sorted = items.map(t => t.dt).filter(Boolean).sort((a, b) => a - b);
        return sorted[0] || null;
      };

      const seedStart = pickDate("seed_start_indoor");
      const transplant = pickDate("transplant");
      const directSow = pickDate("direct_sow");
      const harvestDates = (byTemplate.harvest || []).map(t => t.dt).filter(Boolean).sort((a, b) => a - b);
      const harvestStart = harvestDates[0] || null;
      const harvestEnd = harvestDates.length ? harvestDates[harvestDates.length - 1] : null;
      const yearEnd = new Date(year, 11, 31);
      const plantStages = [];

      if (seedStart && transplant) {
        plantStages.push({
          key: "indoors",
          start: clampDate(seedStart, year),
          end: clampDate(transplant, year),
        });
      }

      if (transplant) {
        plantStages.push({
          key: "transplant",
          start: clampDate(transplant, year),
          end: clampDate(addDays(transplant, 7), year),
        });
      }

      if (directSow) {
        plantStages.push({
          key: "sow",
          start: clampDate(directSow, year),
          end: clampDate(addDays(directSow, 7), year),
        });
      }

      const growStart = transplant || directSow;
      if (growStart) {
        const growEnd = harvestStart || yearEnd;
        if (growEnd >= growStart) {
          plantStages.push({
            key: "growing",
            start: clampDate(growStart, year),
            end: clampDate(growEnd, year),
          });
        }
      }

      if (harvestStart) {
        const harvestSpan = getHarvestSpanDays(data?.plants?.find(p => p.name === plantName));
        const endDate = harvestEnd || addDays(harvestStart, harvestSpan);
        plantStages.push({
          key: "harvest",
          start: clampDate(harvestStart, year),
          end: clampDate(endDate, year),
        });
      }

      if (!stagesByPlant.has(plantName)) {
        stagesByPlant.set(plantName, []);
      }
      stagesByPlant.get(plantName).push(...plantStages);
    });

    return stagesByPlant;
  };

  function rerender() {
    grid.innerHTML = "";
    const year = parseInt(yearSel.value, 10);
    const tasks = collectPlannedTasks(data, state)
      .filter(t => t.dt && t.dt.getFullYear() === year)
      .filter(t => !FERTILIZER_TEMPLATES.has(t.template))
      .filter(t => !SOIL_PREP_TEMPLATES.has(t.template));
    const stageMap = buildStagesForTasks(tasks, year);

    if (!tasks.length) {
      grid.appendChild(el("div", "muted", "No tasks scheduled for this year with the current plan selections."));
      return;
    }

    const matrix = el("div", "cal-grid");
    const header = el("div", "cal-header cal-row");
    header.appendChild(el("div", "cal-cell cal-label", "Plant"));
    monthNames.forEach(label => {
      const cell = el("div", "cal-cell cal-label cal-month");
      cell.style.gridColumn = "span 2";
      cell.textContent = label;
      header.appendChild(cell);
    });
    matrix.appendChild(header);

    (data.plants || []).forEach(plant => {
      const row = el("div", "cal-row");
      row.appendChild(el("div", "cal-cell cal-label", plant.name));
      const slots = Array(24).fill(null);
      const stages = stageMap.get(plant.name) || [];
      stages.forEach(stage => {
        fillSlots(slots, stage.start, stage.end, stage.key);
      });
      slots.forEach((stageKey, idx) => {
        const cell = el("div", "cal-cell cal-slot");
        if (Math.floor(idx / 2) % 2 === 1) {
          cell.classList.add("month-alt");
        }
        if (stageKey) {
          const stage = stageConfig.find(item => item.key === stageKey);
          const block = el("div", "cal-stage");
          if (stage?.className) block.classList.add(stage.className);
          cell.appendChild(block);
        }
        row.appendChild(cell);
      });
      matrix.appendChild(row);
    });

    grid.appendChild(matrix);
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

    if (created && /^\d{4}/.test(created)) {
      yearSel.value = created.slice(0, 4);
    } else {
      yearSel.value = String(new Date().getFullYear());
    }
    yearSel.onchange = rerender;
    yearSel.dataset.ready = "true";
  }
  buildLegend();
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
      scheduleShifts: loadStoredJSON(STORAGE_KEYS.scheduleShifts, {}),
      taskNotes: loadStoredJSON(STORAGE_KEYS.taskNotes, {}),
      taskCompletion: loadStoredJSON(STORAGE_KEYS.taskCompletion, {}),
      taskDateOverrides: loadStoredJSON(STORAGE_KEYS.taskDateOverrides, {}),
      plantIndex: new Map((data.plants || []).map(plant => [plant.name, plant])),
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
    renderUpcomingTasks(data, state, main);
    renderCalendar(data, state, main);

    const upcomingWindow = $("#upcoming-window", main);
    if (upcomingWindow) {
      upcomingWindow.addEventListener("change", () => renderUpcomingTasks(data, state, main));
    }
    const todayToggle = $("#toggle-hide-complete", main);
    if (todayToggle) {
      todayToggle.addEventListener("change", () => renderTodayTasks(data, state, main));
    }
    const upcomingToggle = $("#toggle-upcoming-hide-complete", main);
    if (upcomingToggle) {
      upcomingToggle.addEventListener("change", () => renderUpcomingTasks(data, state, main));
    }
  } catch (e) {
    console.error(e);
    const status = $("#data-status", document.querySelector("main")) || $("#data-status");
    if (status) status.textContent = `Failed to load data: ${e.message}`;
  }
});
