/* Garden Tracker PWA (v2)
   Enhancements:
   - Includes global_tasks in Today/Upcoming views
   - Per-plant planning choices (direct sow vs transplant when both are plausible; season; cycles)
   - Rolling timers: for tasks with frequency_days, next due is based on last completion date
   - More detailed task guidance (hardening off, transplanting, direct sow, fertilizing)
   - Fertilizer tasks on the same date for the same plant are grouped into one row
*/

const DATA_URL = 'garden_master_full.json';
const STORE_KEY = 'garden_tracker_v2';
const WEATHER_ZIP = '20002';
const WEATHER_CACHE_KEY = 'garden_weather_cache_v1';
const WEATHER_GEO_KEY = 'garden_weather_geo_v1';

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function parseISO(s){
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}
function isoDateOnly(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function daysBetween(a, b){
  const ms = (b.getTime() - a.getTime());
  return Math.round(ms / (1000*60*60*24));
}

function fmtDate(d){
  if (!d) return '';
  return d.toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'});
}

function safeText(s){
  return (s ?? '').toString();
}

function loadStore(){
  try{
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    // normalize
    s.completed = s.completed || {};
    s.notes = s.notes || {};
    s.plans = s.plans || {};
    return s;
  }catch(e){
    return {completed:{}, notes:{}, plans:{}};
  }
}

function saveStore(obj){
  localStorage.setItem(STORE_KEY, JSON.stringify(obj));
}

const TASK_GUIDE = {
  harden_off: [
    "Start 7–10 days before transplanting.",
    "Day 1–2: 1–2 hours outdoors in bright shade; bring inside.",
    "Day 3–4: 2–4 hours; introduce gentle morning sun; protect from wind.",
    "Day 5–7: 4–8 hours; increase sun exposure gradually.",
    "Final 1–2 days: full day outdoors (avoid cold snaps); water well before transplant.",
    "Do not harden off by withholding water; keep evenly moist."
  ],
  transplant: [
    "Transplant late afternoon or on an overcast day to reduce stress.",
    "Water seedlings 1–2 hours before planting.",
    "Plant to the same depth unless the crop supports deeper planting (tomatoes do).",
    "Firm soil gently; water in thoroughly.",
    "Mulch after soil warms; keep mulch 1–2 inches away from stems."
  ],
  direct_sow: [
    "Prepare a fine, level seedbed; remove clods and stones (critical for carrots).",
    "Pre-moisten the row; sow at the recommended depth; press soil to ensure contact.",
    "Keep the surface consistently moist until emergence (often daily in containers).",
    "Thin promptly to final spacing to avoid stunting."
  ],
  fertilize: [
    "Prefer light, regular feeding over large doses.",
    "Water before and after granular applications to prevent burn.",
    "Reduce nitrogen-heavy feeding once fruit set begins for tomatoes/peppers/cucumbers.",
  ],
  pest_scout: [
    "Check undersides of leaves and new growth.",
    "Look for stippling, curling, frass, eggs, and chewing damage.",
    "Scout at least weekly; twice weekly during warm humid stretches."
  ],
  soil_test: [
    "Request pH + nutrients + lead (urban areas).",
    "Use results to decide whether to add lime/sulfur and whether phosphorus is needed."
  ]
};

function classifySeason(taskDate){
  // Simple heuristic for DC: "spring" through June, "fall" July onward.
  const m = taskDate.getMonth() + 1;
  return (m <= 6) ? 'spring' : 'fall';
}

function plantKey(plant){
  return plant?.catalog_id || plant?.name || 'plant';
}

function getPlan(store, plant){
  const key = plantKey(plant);
  const defaultPlan = { method: 'either', season: 'both', cycles: 1 };
  return Object.assign(defaultPlan, (store.plans?.[key] || {}));
}

function setPlan(store, plant, planPatch){
  const key = plantKey(plant);
  store.plans = store.plans || {};
  store.plans[key] = Object.assign({ method: 'either', season: 'both', cycles: 1 }, store.plans[key] || {}, planPatch || {});
  saveStore(store);
}

function midpointDateISO(win){
  if (!win || !win.start || !win.end) return null;
  const a = parseISO(win.start);
  const b = parseISO(win.end);
  if (!a || !b) return null;
  const mid = new Date((a.getTime() + b.getTime()) / 2);
  mid.setHours(0,0,0,0);
  return isoDate(mid);
}

function addDaysISO(iso, days){
  if (!iso) return null;
  const d = parseISO(iso);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  d.setHours(0,0,0,0);
  return isoDate(d);
}

function isSeedAnchorTemplate(tpl){
  return /(seed_start|seed start|harden|pot_up|prick_out)/i.test(tpl || '');
}

function isInBedAnchorTemplate(tpl){
  return /(transplant|direct_sow|direct sow|bed_prep|soil_prep|soil_amend|fert|pest|support|trellis|stake|cage|prune|harvest)/i.test(tpl || '');
}

function applyAltScheduleToPlantTaskPlan(plant, plan){
  // Returns a NEW array of tasks with date_target rewritten based on the selected season + method.
  if (!plant || !plant.task_plan || !plant.planting) return plant.task_plan || [];
  const season = (plan && plan.season && plan.season !== 'both') ? plan.season : null;

  // Choose the first available season if 'both'
  const chosenSeason = season || (plant.planting.spring ? 'spring' : (plant.planting.fall ? 'fall' : null));
  if (!chosenSeason || !plant.planting[chosenSeason]) return plant.task_plan || [];

  const pwin = plant.planting[chosenSeason];
  const method = (plan && plan.method) ? plan.method : 'either';

  // New anchor dates (midpoints of windows)
  const newSeed = midpointDateISO(pwin.indoor_start_window);
  const newTransplant = midpointDateISO(pwin.transplant_window);
  const newDirect = midpointDateISO(pwin.direct_sow_window);

  // Determine the new "in-bed start" date based on method
  let newInBed = null;
  if (method === 'transplant') newInBed = newTransplant;
  else if (method === 'direct_sow') newInBed = newDirect;
  else newInBed = newTransplant || newDirect; // 'either'

  // Baseline anchors from the existing task_plan (so we can shift all dependent tasks)
  let baseSeed = null;
  let baseInBed = null;
  for (const t of (plant.task_plan || [])){
    const tpl = t.template || '';
    if (!baseSeed && /seed_start|seed start/i.test(tpl) && t.date_target) baseSeed = t.date_target;
    if (!baseInBed && /(transplant|direct_sow|direct sow)/i.test(tpl) && t.date_target) baseInBed = t.date_target;
  }

  const deltaSeedDays = (baseSeed && newSeed) ? Math.round((parseISO(newSeed)-parseISO(baseSeed))/(24*3600*1000)) : 0;
  const deltaInBedDays = (baseInBed && newInBed) ? Math.round((parseISO(newInBed)-parseISO(baseInBed))/(24*3600*1000)) : 0;

  // Rewrite tasks
  const out = [];
  for (const src of (plant.task_plan || [])){
    const t = JSON.parse(JSON.stringify(src));
    const tpl = (t.template || '').toLowerCase();

    // Filter by method: if user selected direct_sow, drop transplant-only workflow steps; vice versa.
    if (method === 'direct_sow'){
      if (/(seed_start|harden|transplant)/i.test(tpl)) { /* keep seed_start? usually not */ if (/seed_start|harden/i.test(tpl)) continue; if (/transplant/i.test(tpl)) continue; }
    }
    if (method === 'transplant'){
      if (/(direct_sow|direct sow)/i.test(tpl)) continue;
    }

    // Rewrite key steps explicitly
    if (/seed_start|seed start/i.test(tpl) && newSeed) t.date_target = newSeed;
    else if (/transplant/i.test(tpl) && newTransplant) t.date_target = newTransplant;
    else if (/(direct_sow|direct sow)/i.test(tpl) && newDirect) t.date_target = newDirect;
    else if (/harden/i.test(tpl) && newTransplant){
      // Harden off starts ~10 days before transplant
      t.date_target = addDaysISO(newTransplant, -10);
    } else if (t.date_target){
      // Shift everything else relative to the most relevant anchor
      if (isSeedAnchorTemplate(tpl) && deltaSeedDays) t.date_target = addDaysISO(t.date_target, deltaSeedDays);
      else if (isInBedAnchorTemplate(tpl) && deltaInBedDays) t.date_target = addDaysISO(t.date_target, deltaInBedDays);
      else if (deltaInBedDays) t.date_target = addDaysISO(t.date_target, deltaInBedDays);
    }

    out.push(t);
  }

  return out;
}

function prettyTemplate(task){
  const tpl = (task.template || '').replaceAll('_',' ').trim();
  const map = {
    'direct sow': 'Direct sow outdoors',
    'seed start': 'Start seeds indoors',
    'seed start indoors': 'Start seeds indoors',
    'harden off': 'Harden off seedlings',
    'transplant': 'Transplant outdoors',
    'bed prep': 'Prepare bed / soil',
    'soil prep': 'Prepare bed / soil',
    'soil amend': 'Amend soil',
    'pest scout': 'Scout for pests & disease',
    'support': 'Install supports / trellis',
    'harvest': 'Harvest'
  };
  const key = tpl.toLowerCase();
  if (map[key]) return map[key];
  if (!tpl) return 'Task';
  return tpl.replace(/\b\w/g, c => c.toUpperCase());
}


function taskId(scopeKey, task, idx, dueIso){
  const tpl = task.template || 'task';
  const dt = dueIso || task.date_target || task.start_date || task.end_date || '';
  return `${scopeKey}::${tpl}::${dt}::${idx}`;
}

function normalizeTask(scopeKey, plantName, catalogId, task, idx, dueOverride=null, flags={}){
  const when = dueOverride ? parseISO(dueOverride) : parseISO(task.date_target || task.start_date || null);
  const end = parseISO(task.end_date || null);
  const dueIso = (when instanceof Date) ? isoDateOnly(when) : (task.date_target || task.start_date || '');
  const id = taskId(scopeKey, task, idx, dueIso);
  return {
    id,
    scope_key: scopeKey,
    plant_name: plantName,
    catalog_id: catalogId,
    template: task.template || 'task',
    when,
    end,
    raw: task,
    flags: flags || {}
  };
}

function isFertilizerTask(t){
  const tpl = (t.template || '').toLowerCase();
  if (tpl.includes('fert')) return true;
  if (t.raw?.product) return true;
  return false;
}

function isRollingTask(t){
  return Number.isFinite(Number(t.raw?.frequency_days)) && Number(t.raw.frequency_days) > 0;
}

function completionDate(store, taskId){
  const entry = store.completed?.[taskId];
  if (!entry) return null;
  if (typeof entry === 'boolean') return null;
  const d = parseISO(entry.date);
  return d instanceof Date ? d : null;
}

function isCompleted(store, id){
  const v = store.completed?.[id];
  return v === true || (typeof v === 'object' && !!v.done);
}

function markComplete(store, id, done){
  store.completed = store.completed || {};
  if (done){
    store.completed[id] = {done: true, date: todayISO()};
  }else{
    delete store.completed[id];
  }
  saveStore(store);
}

function collectBaseTasks(data, store){
  const out = [];

  // Global tasks
  (data.global_tasks || []).forEach((t, idx) => {
    const nt = normalizeTask('GLOBAL', 'Global', null, t, idx, null, {is_global:true});
    if (nt.when) out.push(nt);
  });

  // Plant tasks
  for (const plant of (data.plants || [])){
    const scopeKey = plantKey(plant);
    const plan = getPlan(store, plant);
    const tasks = applyAltScheduleToPlantTaskPlan(plant, plan) || [];
    tasks.forEach((t, idx) => {
      const nt = normalizeTask(scopeKey, plant.name, plant.catalog_id, t, idx);
      if (nt.when) out.push(nt);
    });
  }

  return out;
}

function applyPlanFilters(tasks, data, store){
  // Filter plant tasks based on per-plant plan selections
  const plantIndex = {};
  for (const p of (data.plants || [])){
    plantIndex[plantKey(p)] = p;
  }

  return tasks.filter(t => {
    if (t.flags?.is_global) return true;

    const plant = plantIndex[t.scope_key];
    const plan = getPlan(store, plant);

    const tpl = (t.template || '').toLowerCase();

    // method filter
    if (plan.method === 'direct_sow'){
      if (tpl.includes('transplant') || tpl.includes('indoor_start') || tpl.includes('harden')) return false;
    }
    if (plan.method === 'transplant'){
      if (tpl.includes('direct_sow')) return false;
    }

    // season filter
    const seasonTag = classifySeason(t.when);
    if (plan.season !== 'both' && plan.season !== seasonTag) return false;

    return true;
  });
}

function expandRollingTasks(tasks, store){
  // For any task with frequency_days, compute next due based on last completion
  // and create future occurrences (within 180 days) as separate tasks.
  const expanded = [];
  const horizonDays = 180;

  const now = new Date(); now.setHours(0,0,0,0);
  const horizon = new Date(now); horizon.setDate(horizon.getDate() + horizonDays);

  for (const t of tasks){
    expanded.push(t);

    if (!isRollingTask(t)) continue;

    const freq = Number(t.raw.frequency_days);
    const baseId = t.id;

    // Determine anchor: completion date if task was completed, else the scheduled due date
    let anchor = completionDate(store, baseId);
    if (!anchor) anchor = t.when;

    if (!(anchor instanceof Date)) continue;

    // Generate occurrences starting after anchor
    let next = new Date(anchor); next.setHours(0,0,0,0);
    next.setDate(next.getDate() + freq);

    let genIdx = 0;
    while (next <= horizon){
      const dueIso = isoDateOnly(next);
      const genTask = normalizeTask(
        t.scope_key,
        t.plant_name,
        t.catalog_id,
        Object.assign({}, t.raw, {date_target: dueIso}),
        // index: stable across render
        10000 + genIdx,
        dueIso,
        {generated:true, rolling_from: baseId}
      );

      // If user already completed this specific generated task, keep it; else include.
      expanded.push(genTask);

      genIdx += 1;
      next = new Date(next); next.setDate(next.getDate() + freq);
    }
  }

  return expanded;
}

function groupTasksForRender(tasks, store){
  // Existing grouping: fertilizer tasks per-plant per-day into a single row
  // Additional grouping: bed/soil prep tasks across plants when additives are identical and dates match.
  const out = [];

  // Helper: determine if a task is a fertilizer task (existing logic downstream uses product).
  const isFert = (t) => {
    const tpl = (t.template || '').toLowerCase();
    return tpl.includes('fert') || tpl.includes('tomato_tone') || (t.raw && t.raw.product);
  };

  const isBedPrep = (t) => {
    const tpl = (t.template || '').toLowerCase();
    return tpl.includes('bed_prep') || tpl.includes('soil_prep') || tpl.includes('soil_amend') || tpl.includes('preplant');
  };

  const dateKey = (d) => isoDateOnly(d);

  // First, take fertilizer groups (same day + same plant) into "fert_group"
  const remaining = [];
  const fertBuckets = new Map();
  for (const t of tasks){
    if (isFert(t)){
      const k = `${dateKey(t.when)}||${safeText(t.plant_name || 'Global')}`;
      if (!fertBuckets.has(k)) fertBuckets.set(k, []);
      fertBuckets.get(k).push(t);
    }else{
      remaining.push(t);
    }
  }
  for (const [k, items] of fertBuckets.entries()){
    if (items.length === 1){
      out.push({type:'single', task: items[0]});
    }else{
      // Reuse fertilizer-group renderer expectations
      out.push({
        type:'fert_group',
        when: items[0].when,
        plant_name: items[0].plant_name,
        items
      });
    }
  }

  // Next, group bed prep tasks across plants when same day + same additives signature
  const bedBuckets = new Map();
  const remaining2 = [];
  for (const t of remaining){
    if (isBedPrep(t)){
      // signature: product + dose + notes (best-effort). If missing, fall back to template.
      const prod = safeText(t.raw?.product || '');
      const dose = safeText(t.raw?.dose || t.dose || '');
      const notes = safeText(t.raw?.notes || t.notes || '');
      const sig = `${(t.template||'').toLowerCase()}|${prod}|${dose}|${notes}`;
      const k = `${dateKey(t.when)}||${sig}`;
      if (!bedBuckets.has(k)) bedBuckets.set(k, []);
      bedBuckets.get(k).push(t);
    }else{
      remaining2.push(t);
    }
  }

  for (const [k, items] of bedBuckets.entries()){
    if (items.length === 1){
      out.push({type:'single', task: items[0]});
    }else{
      out.push({
        type:'bed_group',
        when: items[0].when,
        signature: k.split('||').slice(1).join('||'),
        items
      });
    }
  }

  // Everything else as single rows
  for (const t of remaining2){
    out.push({type:'single', task: t});
  }

  // Sort by time
  out.sort((a,b)=>{
    const da = (a.type==='single') ? a.task.when : a.when;
    const db = (b.type==='single') ? b.task.when : b.when;
    return da - db;
  });

  return out;
}

function badgeForDelta(deltaDays){
  if (deltaDays < 0) return {text: `${Math.abs(deltaDays)}d overdue`, cls:'overdue'};
  if (deltaDays === 0) return {text: 'Due today', cls:'due'};
  if (deltaDays <= 2) return {text: `Due in ${deltaDays}d`, cls:'due'};
  return {text: `In ${deltaDays}d`, cls:''};
}

function renderGuideForTemplate(tpl){
  const key = (tpl || '').toLowerCase();
  const guide = TASK_GUIDE[key];
  if (!guide || !guide.length) return '';
  const lis = guide.map(x => `<li>${safeText(x)}</li>`).join('');
  return `<div class="note"><strong>Tips</strong><ul>${lis}</ul></div>`;
}

function renderTaskDetails(raw, template){
  const lines = [];
  const kv = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(`<div><span class="badge">${safeText(k)}</span> ${safeText(v)}</div>`);
  };

  kv('Target', raw.date_target || raw.start_date);
  kv('Depth', raw.depth_in ? `${raw.depth_in} in` : '');
  const sp = raw.spacing_in || raw.final_spacing_in || '';
  kv('Plant spacing', (typeof sp==='number' || /^\d+(\.\d+)?$/.test(String(sp))) ? `${sp} in (between plants)` : sp);

  const rs = raw.row_spacing_in || '';
  kv('Row spacing', (typeof rs==='number' || /^\d+(\.\d+)?$/.test(String(rs))) ? `${rs} in (between rows)` : rs);

  kv('Product', raw.product || '');
  kv('Dose', raw.dose || '');
  kv('Method', raw.method || '');
  kv('Frequency', raw.frequency_days ? `${raw.frequency_days} days` : '');
  kv('Notes', raw.notes || '');
  kv('Maturity', raw.maturity_signs || '');
  kv('Storage', raw.storage_notes || '');
  kv('Stop', raw.stop_conditions || '');

  const base = lines.length ? lines.join('') : '—';
  const guide = renderGuideForTemplate(template);
  return base + guide;
}

function renderSingleTaskRow(task, store, {showPlant=true} = {}){
  const completed = isCompleted(store, task.id);
  const notes = store.notes?.[task.id] || '';

  const now = new Date(); now.setHours(0,0,0,0);
  const when = new Date(task.when); when.setHours(0,0,0,0);
  const delta = daysBetween(now, when);
  const badge = badgeForDelta(delta);

  const title = task.template.replaceAll('_',' ').replace(/\b\w/g, c => c.toUpperCase());
  const metaParts = [fmtDate(task.when)];
  if (showPlant && task.plant_name) metaParts.push(task.plant_name);
  if (task.catalog_id) metaParts.push(`#${task.catalog_id}`);
  if (task.flags?.is_global) metaParts.push('Global');

  const wrapper = document.createElement('div');
  wrapper.className = 'row';
  wrapper.innerHTML = `
    <div class="row-top">
      <div>
        <div class="row-title">${safeText(title)}</div>
        <div class="row-meta">${metaParts.map(safeText).join(' • ')}</div>
      </div>
      <div class="row-actions">
        <span class="badge ${badge.cls}">${badge.text}</span>
        <label class="toggle" title="Mark complete">
          <input type="checkbox" ${completed ? 'checked' : ''} data-task-id="${task.id}" class="chk-complete" />
          <span class="small">Done</span>
        </label>
      </div>
    </div>
    <div class="muted" style="margin-top:8px">
      ${renderTaskDetails(task.raw, task.template)}
    </div>
    <div style="margin-top:10px">
      <label class="label">Notes</label>
      <textarea class="input" style="width:100%; max-width:none; height:70px" placeholder="Optional notes…" data-note-id="${task.id}">${safeText(notes)}</textarea>
    </div>
  `;
  return wrapper;
}


function renderBedPrepGroupRow(group, store){
  const div = document.createElement('div');
  div.className = 'task-row';

  const when = group.when;
  const title = 'Bed / soil prep (combined)';
  const plants = Array.from(new Set(group.items.map(i => i.plant_name).filter(Boolean))).join(', ');
  const meta = `${fmtDate(when)} • ${plants || 'Multiple plants'}`;

  const allDone = group.items.every(t => isCompleted(store, t.id));

  div.innerHTML = `
    <div class="row-left">
      <div class="row-title">${safeText(title)}</div>
      <div class="row-meta">${safeText(meta)}</div>
      <div class="row-meta muted">Same amendments/additives on the same date. Completing this marks all included items complete.</div>
    </div>
    <div class="row-right">
      <button class="btn ${allDone ? 'secondary' : ''}" data-action="toggle-bed-group">${allDone ? 'Completed' : 'Mark done'}</button>
    </div>
  `;

  div.querySelector('[data-action="toggle-bed-group"]').addEventListener('click', () => {
    const nowDone = !allDone;
    for (const t of group.items){
      setCompleted(store, t.id, nowDone);
    }
    saveStore(store);
    refreshViews();
  });

  return div;
}

function renderGroupedFertilizerRow(group, store, {showPlant=true} = {}){
  const now = new Date(); now.setHours(0,0,0,0);
  const when = new Date(group.when); when.setHours(0,0,0,0);
  const delta = daysBetween(now, when);
  const badge = badgeForDelta(delta);

  // Group completion: completed if all items completed
  const allDone = group.items.every(t => isCompleted(store, t.id));
  const groupNotes = store.notes?.[group.id] || '';

  const title = `Fertilize (${group.items.length} items)`;
  const metaParts = [fmtDate(group.when)];
  if (showPlant && group.plant_name) metaParts.push(group.plant_name);
  

  const details = group.items.map(t => {
    const prod = t.raw?.product ? ` — ${t.raw.product}` : '';
    const dose = t.raw?.dose ? ` (${t.raw.dose})` : '';
    return `<li>${safeText(t.template)}${safeText(prod)}${safeText(dose)}</li>`;
  }).join('');

  const wrapper = document.createElement('div');
  wrapper.className = 'row';
  wrapper.innerHTML = `
    <div class="row-top">
      <div>
        <div class="row-title">${safeText(title)}</div>
        <div class="row-meta">${metaParts.map(safeText).join(' • ')}</div>
      </div>
      <div class="row-actions">
        <span class="badge ${badge.cls}">${badge.text}</span>
        <label class="toggle" title="Mark complete">
          <input type="checkbox" ${allDone ? 'checked' : ''} data-group-id="${group.id}" class="chk-group-complete" />
          <span class="small">Done</span>
        </label>
      </div>
    </div>
    <div class="muted" style="margin-top:8px">
      <div><strong>Included</strong></div>
      <ul>${details}</ul>
      ${renderGuideForTemplate('fertilize')}
    </div>
    <div style="margin-top:10px">
      <label class="label">Notes</label>
      <textarea class="input" style="width:100%; max-width:none; height:70px" placeholder="Optional notes…" data-note-id="${group.id}">${safeText(groupNotes)}</textarea>
    </div>
  `;
  return wrapper;
}

function setSubtitle(text){
  document.getElementById('subtitle').textContent = text;
}

function renderPlantsList(data, store){
  const list = document.getElementById('plants-list');
  list.innerHTML = '';

  const search = (document.getElementById('plant-search').value || '').trim().toLowerCase();
  const plants = (data.plants || []).filter(p => {
    const blob = `${p.name} ${p.catalog_id || ''} ${p.species || ''}`.toLowerCase();
    return !search || blob.includes(search);
  });

  plants.forEach(p => {
    const plan = getPlan(store, p);
    const el = document.createElement('div');
    el.className = 'row';
    el.style.cursor = 'pointer';
    el.innerHTML = `
      <div class="row-top">
        <div>
          <div class="row-title"><img class="plant-icon" src="${safeText(p.visual?.icon || 'icons/plants/plant.svg')}" alt="" /> ${safeText(p.name)}</div>
          <div class="row-meta">${safeText(p.species || '')}</div>
        </div>
        <div class="row-actions">
          <span class="badge">${safeText(p.category || 'plant')}</span>
          <span class="badge">${safeText(plan.method)}</span>
          <span class="badge">${safeText(plan.season)}</span>
        </div>
      </div>
    `;
    el.addEventListener('click', () => renderPlantDetail(p, store));
    list.appendChild(el);
  });

  if (!plants.length){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No plants match your search.';
    list.appendChild(empty);
  }
}

function renderPlantDetail(plant, store){
  document.getElementById('plant-title').textContent = plant.name || 'Plant';
  const detail = document.getElementById('plant-detail');

  const plan = getPlan(store, plant);

  const planUI = `
    <div class="detail">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
        <img class="plant-icon-lg" src="${safeText(plant.visual?.icon || 'icons/plants/plant.svg')}" alt="" />
        <div class="muted">${safeText(plant.species || '')}</div>
      ${plant.visual?.photo ? `<img class="plant-hero" src="${safeText(plant.visual.photo)}" alt="" />` : ``}

      </div>
      <h3>Plan</h3>
      <div class="kv"><div>Sowing method</div>
        <div>
          <div class="radio-group" id="plan-method">
  <label class="radio"><input type="radio" name="plan-method" value="either"> Either / decide later</label>
  <label class="radio"><input type="radio" name="plan-method" value="direct_sow"> Direct sow</label>
  <label class="radio"><input type="radio" name="plan-method" value="transplant"> Transplant</label>
</div>
        </div>
      </div>
      <div class="kv"><div>Season</div>
        <div>
          <div class="radio-group" id="plan-season">
  <label class="radio"><input type="radio" name="plan-season" value="both"> Both (spring & fall)</label>
  <label class="radio"><input type="radio" name="plan-season" value="spring"> Spring</label>
  <label class="radio"><input type="radio" name="plan-season" value="fall"> Fall</label>
</div>
        </div>
      </div>
      <div class="kv"><div>Cycles</div>
        <div>
          <input id="plan-cycles" class="input" type="number" min="1" step="1" value="${safeText(plan.cycles)}" style="width:100%; max-width:none"/>
          <div class="help">Cycles controls how many times you intend to plant this crop this year. Current UI uses it as a planning note; future version can auto-generate repeated cycles.</div>
        </div>
      </div>
      <button id="btn-save-plan" class="btn secondary" style="width:100%; margin-top:8px">Save plan</button>

      <hr class="sep"/>
  `;

  const site = plant.site_requirements || {};
  const kv = (k, v) => v ? `<div class="kv"><div>${safeText(k)}</div><div>${safeText(v)}</div></div>` : '';
  const plantingBlock = `
      <h3>Planting</h3>
      <div class="muted">${renderPlanting(plant.planting)}</div>
      ${renderGuideForTemplate(plan.method === 'direct_sow' ? 'direct_sow' : (plan.method === 'transplant' ? 'transplant' : 'transplant'))}
  `;

  const soilPrep = plant.soil_preparation || {};
  const soilBlock = `
      <h3>Soil preparation</h3>
      <div class="muted">
        ${soilPrepToHtml(soilPrep)}
      </div>
  `;

  const fertilityBlock = `
      <h3>Supplement schedule</h3>
      ${renderBullets(plant.supplement_schedule || plant.fertility_strategy)}
  `;

  const pestsBlock = `
      <h3>Pest & disease</h3>
      ${renderPests(plant.pest_disease, data)}
  `;

  const harvestBlock = `
      <h3>Harvest</h3>
      <div class="muted">${renderHarvest(plant.harvest_and_use)}</div>
  `;

  // tasks: include plan filtering + rolling expansion for this plant
  const planAdj = applyAltScheduleToPlantTaskPlan(plant, plan) || [];
  const baseTasks = (planAdj || []).map((t, idx) => normalizeTask(plantKey(plant), plant.name, plant.catalog_id, t, idx))
    .filter(t => t.when instanceof Date);

  const filtered = applyPlanFilters(baseTasks, {plants:[plant]}, store);
  const expanded = expandRollingTasks(filtered, store)
    .sort((a,b)=>a.when-b.when);

  const hideComplete = document.getElementById('toggle-hide-complete').checked;
  const visible = expanded.filter(t => !hideComplete || !isCompleted(store, t.id));

  const taskRows = groupTasksForRender(visible, store);

  detail.innerHTML = planUI + `
      ${kv('Species', plant.species)}
      ${kv('Category', plant.category)}
      ${kv('Sun', site.sun)}
      ${kv('Soil pH', site.soil_ph)}
      ${kv('Container', site.container_suitability)}
      ${plantingBlock}
      ${soilBlock}
      ${fertilityBlock}
      ${pestsBlock}
      ${harvestBlock}
      <hr class="sep"/>
      <h3>Tasks</h3>
      <div class="list" id="plant-tasks"></div>
    </div>
  `;

  // Set current plan values
  detail.querySelector('#plan-method').value = plan.method;
  detail.querySelector('#plan-season').value = plan.season;

  detail.querySelector('#btn-save-plan').onclick = () => {
    const method = detail.querySelector('#plan-method').value;
    const season = detail.querySelector('#plan-season').value;
    const cycles = parseInt(detail.querySelector('#plan-cycles').value || '1', 10);
    setPlan(store, plant, {method, season, cycles: (Number.isFinite(cycles) && cycles>0) ? cycles : 1});
    refreshViews();
    // keep plant detail updated
    renderPlantDetail(plant, loadStore());
  };

  const container = detail.querySelector('#plant-tasks');
  if (!taskRows.length){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No tasks (or all tasks are hidden as completed).';
    container.appendChild(empty);
  }else{
    for (const r of taskRows){
      if (r.type === 'single'){
        container.appendChild(renderSingleTaskRow(r.task, store, {showPlant:false}));
      }else{
        container.appendChild(renderGroupedFertilizerRow(r, store, {showPlant:false}));
      }
    }
  }

  wireInteractions();
}

function soilPrepToHtml(sp){
  if (!sp || typeof sp !== 'object') return '—';
  const rows = Object.entries(sp).map(([k,v]) => `<div class="kv"><div>${safeText(k.replaceAll('_',' '))}</div><div>${safeText(v)}</div></div>`).join('');
  return rows || '—';
}

function renderBullets(arr){
  if (!arr || !arr.length) return `<div class="muted">—</div>`;
  const items = arr.map(x => {
    const stage = x.stage ? `<span class="badge">${safeText(x.stage)}</span> ` : '';
    const product = x.product ? safeText(x.product) : safeText((x.products || []).join(', '));
    const dose = x.rate ? ` — ${safeText(x.rate)}` : (x.dose ? ` — ${safeText(x.dose)}` : '');
    const timing = x.frequency ? ` (${safeText(x.frequency)})` : (x.timing ? ` (${safeText(x.timing)})` : '');
    const notes = x.notes ? `<div class="note">${safeText(x.notes)}</div>` : '';
    const stop = x.stop_conditions ? `<div class="note"><strong>Stop/adjust:</strong> ${safeText(x.stop_conditions)}</div>` : '';
    return `<li>${stage}${safeText(product)}${dose}${timing}${notes}${stop}</li>`;
  }).join('');
  return `<ul>${items}</ul>`;
}

function renderPests(pd, data){
  if (!pd) return `<div class="muted">—</div>`;
  const pests = (pd.key_pests || []);
  const dis = (pd.key_diseases || []);
  const imgs = pd.images || {};
  const lib = (data && data.pest_disease_library) ? data.pest_disease_library : {};

  const chip = (label) => {
    const src = imgs[label];
    const libImgs = (lib[label]?.images || []);
    const fallback = libImgs.length ? libImgs[0].src : null;
    const finalSrc = src || fallback;
    if (!finalSrc) return `<span class="badge">${safeText(label)}</span>`;
    return `<span class="pill"><img class="mini-icon" src="${safeText(finalSrc)}" alt="" /> ${safeText(label)}</span>`;
  };

  const detailsFor = (label) => {
    const entry = lib[label];
    if (!entry) return '';
    const tips = (entry.id_tips || []).map(t => `<li>${safeText(t)}</li>`).join('');
    const images = (entry.images || []).map(img => {
      const capParts = [];
      if (img.credit) capParts.push(`Credit: ${img.credit}`);
      if (img.license) capParts.push(`License: ${img.license}`);
      const cap = capParts.length ? `<div class="muted tiny">${safeText(capParts.join(' • '))}</div>` : '';
      const link = img.source_url ? `<a href="${safeText(img.source_url)}" target="_blank" rel="noopener">Source</a>` : '';
      return `
        <div class="pd-photo">
          <img src="${safeText(img.src)}" alt="${safeText(label)}" loading="lazy" />
          ${cap}
          ${link ? `<div class="tiny">${link}</div>` : ``}
        </div>
      `;
    }).join('');

    const hasContent = tips || images;
    if (!hasContent) return '';
    return `
      <details class="pd-details">
        <summary>${safeText(label)} — identification photos & notes</summary>
        ${tips ? `<ul>${tips}</ul>` : ``}
        ${images ? `<div class="pd-photos">${images}</div>` : ``}
      </details>
    `;
  };

  const pestsHtml = pests.length ? pests.map(chip).join(' ') : '—';
  const disHtml = dis.length ? dis.map(chip).join(' ') : '—';

  const prev = (pd.prevention || []).map(x => `<li>${safeText(x)}</li>`).join('');

  const allDetails = [...pests, ...dis].map(detailsFor).filter(Boolean).join('');

  return `
    <div class="muted">
      <div class="kv"><div>Key pests</div><div>${pestsHtml}</div></div>
      <div class="kv"><div>Key diseases</div><div>${disHtml}</div></div>
      <div class="kv"><div>Prevention</div><div>${prev ? `<ul>${prev}</ul>` : '—'}</div></div>
      ${allDetails ? `<div class="pd-detail-wrap">${allDetails}</div>` : ``}
    </div>
  `;
}

function renderHarvest(h){
  if (!h) return '—';
  const parts = [];
  if (h.harvest_window) parts.push(`<div><span class="badge">Window</span> ${safeText(h.harvest_window)}</div>`);
  if (h.harvest_method) parts.push(`<div><span class="badge">Method</span> ${safeText(h.harvest_method)}</div>`);
  if (h.frequency) parts.push(`<div><span class="badge">Cadence</span> ${safeText(h.frequency)}</div>`);
  if (h.storage) parts.push(`<div><span class="badge">Storage</span> ${safeText(h.storage)}</div>`);
  if (!parts.length) return '—';
  return parts.join('');
}

function renderPlanting(p){
  if (!p) return '—';
  const lines = [];
  const addWindow = (label, win) => {
    if (!win) return;
    const s = win.start ? fmtDate(parseISO(win.start)) : (win.start_date ? fmtDate(parseISO(win.start_date)) : '');
    const e = win.end ? fmtDate(parseISO(win.end)) : (win.end_date ? fmtDate(parseISO(win.end_date)) : '');
    const range = (s && e) ? `${s} → ${e}` : (s || e || '');
    if (range) lines.push(`<div><span class="badge">${safeText(label)}</span> ${safeText(range)}</div>`);
    if (win.notes) lines.push(`<div class="note">${safeText(win.notes)}</div>`);
  };

  if (p.spring) {
    addWindow('Spring start indoors', p.spring.indoor_start_window);
    addWindow('Spring transplant', p.spring.transplant_window);
    addWindow('Spring direct sow', p.spring.direct_sow_window);
  }
  if (p.fall) {
    addWindow('Fall start indoors', p.fall.indoor_start_window);
    addWindow('Fall transplant', p.fall.transplant_window);
    addWindow('Fall direct sow', p.fall.direct_sow_window);
  }
  addWindow('Direct sow', p.direct_sow_window || p.spring_direct_sow_window || p.fall_direct_sow_window);
  addWindow('Indoor start', p.indoor_start_window || p.indoor_start_optional);
  addWindow('Transplant', p.transplant_window);

  if (p.seed_depth_in !== undefined) lines.push(`<div><span class="badge">Seed depth</span> ${safeText(p.seed_depth_in)} in</div>`);
  if (p.spacing_in) lines.push(`<div><span class="badge">Spacing</span> ${safeText(JSON.stringify(p.spacing_in))}</div>`);
  if (p.germination) lines.push(`<div><span class="badge">Germination</span> ${safeText(p.germination.days || '')} days @ ${safeText(p.germination.temp_F || '')}°F</div>`);
  if (p.notes) lines.push(`<div class="note">${safeText(p.notes)}</div>`);

  return lines.length ? lines.join('') : '—';
}

function buildAllTasks(data, store){
  let tasks = collectBaseTasks(data, store);
  tasks = applyPlanFilters(tasks, data, store);
  tasks = expandRollingTasks(tasks, store);
  // de-dupe by id
  const seen = new Set();
  tasks = tasks.filter(t => {
    if (!t.when) return false;
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  return tasks;
}

function renderToday(data, store){
  const hideComplete = document.getElementById('toggle-hide-complete').checked;

  const now = parseISO(todayISO()); now.setHours(0,0,0,0);
  const end = new Date(now); end.setDate(end.getDate() + 7);

  const tasks = buildAllTasks(data, store);

  // "Today" view = overdue + due within next 7 days
  const due = tasks.filter(t => {
    const when = new Date(t.when); when.setHours(0,0,0,0);
    return when <= end;
  }).sort((a,b)=>a.when-b.when);

  const visible = due.filter(t => !hideComplete || !isCompleted(store, t.id));
  const rows = groupTasksForRender(visible, store);

  const container = document.getElementById('today-tasks');
  container.innerHTML = '';

  const header = document.getElementById('today-range');
  if (header){
    header.textContent = `Showing overdue + next 7 days (through ${fmtDate(end)})`;
  }

  if (!rows.length){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = hideComplete
      ? 'No tasks due in the next 7 days (or everything is completed).'
      : 'No tasks due in the next 7 days.';
    container.appendChild(empty);
    return;
  }

  for (const r of rows){
    if (r.type === 'single'){
      container.appendChild(renderSingleTaskRow(r.task, store, {showPlant:true}));
    }else if (r.type === 'fert_group'){
      container.appendChild(renderGroupedFertilizerRow(r, store, {showPlant:true}));
    }else if (r.type === 'bed_group'){
      container.appendChild(renderBedPrepGroupRow(r, store));
    }
  }
}

function renderUpcoming(data, store){
  const hideComplete = document.getElementById('toggle-upcoming-hide-complete').checked;
  const windowDays = parseInt(document.getElementById('upcoming-window').value, 10) || 30;

  const tasks = buildAllTasks(data, store);

  const now = parseISO(todayISO()); now.setHours(0,0,0,0);
  const end = new Date(now); end.setDate(end.getDate() + windowDays);

  const upcoming = tasks.filter(t => t.when >= now && t.when <= end).sort((a,b)=>a.when-b.when);
  const visible = upcoming.filter(t => !hideComplete || !isCompleted(store, t.id));

  const rows = groupTasksForRender(visible, store);

  const container = document.getElementById('upcoming-tasks');
  container.innerHTML = '';

  if (!rows.length){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = hideComplete
      ? 'No upcoming tasks (or all are completed).'
      : 'No upcoming tasks.';
    container.appendChild(empty);
    return;
  }

  // Group header by date
  let currentKey = '';
  for (const r of rows){
    const d = (r.type==='single') ? r.task.when : r.when;
    const key = isoDateOnly(d);
    if (key !== currentKey){
      currentKey = key;
      const h = document.createElement('div');
      h.className = 'muted';
      h.style.marginTop = '6px';
      h.innerHTML = `<strong>${fmtDate(d)}</strong>`;
      container.appendChild(h);
    }
    if (r.type === 'single'){
      container.appendChild(renderSingleTaskRow(r.task, store, {showPlant:true}));
    }else{
      container.appendChild(renderGroupedFertilizerRow(r, store, {showPlant:true}));
    }
  }
}

function wireInteractions(){
  const store = loadStore();

  // single task completion
  document.querySelectorAll('.chk-complete').forEach(chk => {
    chk.onchange = (e) => {
      const id = e.target.getAttribute('data-task-id');
      markComplete(store, id, !!e.target.checked);
      refreshViews();
    };
  });

  // grouped completion
  document.querySelectorAll('.chk-group-complete').forEach(chk => {
    chk.onchange = (e) => {
      const gid = e.target.getAttribute('data-group-id');
      // find tasks included in this group from the DOM list item texts is brittle; instead,
      // we store group notes separately and mark individual tasks by searching visible tasks on refresh.
      // Here: treat group toggle as a convenience for "mark all fertilizer tasks on that day for that plant".
      const nowIso = todayISO();
      const parts = gid.split('::');
      // GROUP::scope::YYYY-MM-DD::FERT::N
      const scope = parts[1] || '';
      const day = parts[2] || '';
      const done = !!e.target.checked;

      // mark matching tasks in current dataset
      const tasks = buildAllTasks(window.__data, store);
      tasks.forEach(t => {
        if (t.scope_key === scope && isoDateOnly(t.when) === day && isFertilizerTask(t) && !t.flags?.is_global){
          markComplete(store, t.id, done);
        }
      });

      refreshViews();
    };
  });

  // notes (task or group)
  document.querySelectorAll('textarea[data-note-id]').forEach(t => {
    t.onchange = (e) => {
      const id = e.target.getAttribute('data-note-id');
      store.notes = store.notes || {};
      store.notes[id] = e.target.value || '';
      saveStore(store);
    };
  });
}

function refreshViews(){
  const store = loadStore();
  if (!window.__data) return;
  renderToday(window.__data, store);
  renderUpcoming(window.__data, store);
  renderPlantsList(window.__data, store);
  renderCalendar(window.__data, store);
  wireInteractions();
}

function activateTab(tabName){
  document.querySelectorAll('.tab').forEach(b => {
    const active = (b.getAttribute('data-tab') === tabName);
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');
}

async function fetchData(){
  const res = await fetch(DATA_URL, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL}`);
  return await res.json();
}

// Weather (optional) using Open-Meteo (no API key)

// Weather (Open-Meteo). Fixed location: ZIP 20002 (Washington, DC).
async function geocodeZip(zip){
  // Cache lat/lon so we don't geocode every load.
  try{
    const cached = JSON.parse(localStorage.getItem(WEATHER_GEO_KEY) || 'null');
    if (cached && cached.zip === zip && cached.lat && cached.lon) return cached;
  }catch(e){}

  const q = encodeURIComponent(`${zip} USA`);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json&country_code=US`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocoding failed');
  const j = await res.json();
  const r = j?.results?.[0];
  if (!r) throw new Error('No geocode result');
  const out = {zip, lat: r.latitude, lon: r.longitude, name: r.name, admin1: r.admin1, country: r.country, ts: Date.now()};
  localStorage.setItem(WEATHER_GEO_KEY, JSON.stringify(out));
  return out;
}

function getCachedWeather(){
  try{
    const c = JSON.parse(localStorage.getItem(WEATHER_CACHE_KEY) || 'null');
    if (!c) return null;
    return c;
  }catch(e){
    return null;
  }
}
function setCachedWeather(payload){
  try{
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ts: Date.now(), payload}));
  }catch(e){}
}

function gardenWeatherTips(data, store, weather){
  const tips = [];
  try{
    const u = weather?.daily_units || {};
    const tmax = weather?.daily?.temperature_2m_max?.[0];
    const tmin = weather?.daily?.temperature_2m_min?.[0];
    const p = weather?.daily?.precipitation_sum?.[0] ?? 0;
    const wmax = weather?.daily?.windspeed_10m_max?.[0];
    const rainIn = (u.precipitation_sum === 'mm') ? (p/25.4) : p;

    if (rainIn >= 0.25){
      tips.push('Rain expected: reduce irrigation and prioritize airflow (tomatoes/cucumbers) to limit fungal pressure.');
    }else{
      tips.push('No meaningful rain expected: check containers daily; shallow planters dry quickly even with irrigation.');
    }
    if (tmax !== undefined && tmax >= 88){
      tips.push('Heat stress risk: water early, mulch, and watch for blossom drop on tomatoes/peppers.');
    }
    if (tmin !== undefined && tmin <= 40){
      tips.push('Cool night risk: protect tender transplants (tomatoes/peppers/cucumbers) or delay transplanting.');
    }
    if (wmax !== undefined && wmax >= 18){
      tips.push('Windy day: secure trellises/stakes and consider delaying foliar sprays (neem/copper).');
    }

    const now = parseISO(todayISO()); now.setHours(0,0,0,0);
    const end = new Date(now); end.setDate(end.getDate() + 7);
    const tasks = buildAllTasks(data, store).filter(t => t.when >= now && t.when <= end);

    const soonTransplants = tasks.filter(t => (t.template||'').toLowerCase().includes('transplant'));
    if (soonTransplants.length){
      if (rainIn >= 0.25) tips.push('Transplanting soon: avoid planting into saturated soil; transplant after rain when soil is workable.');
      if (tmin !== undefined && tmin <= 40) tips.push('Transplanting soon: harden off more gently and consider row cover for cold nights.');
    }

    const soonFerts = tasks.filter(t => (t.template||'').toLowerCase().includes('fert') || t.raw?.product);
    if (soonFerts.length && rainIn >= 0.25){
      tips.push('Fertilizing soon: delay granular top-dress if heavy rain is forecast to reduce nutrient loss.');
    }

    const warmHumid = (tmax !== undefined && tmax >= 80) && (rainIn >= 0.10);
    if (warmHumid){
      tips.push('Warm + wet conditions: scout for fungal issues (leaf spots, mildews). Copper is preventive—apply at first sign and follow label intervals.');
    }

  }catch(e){}
  return tips.slice(0, 6);
}


async function getWeather(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Weather fetch failed');
  return await res.json();
}

function summarizeIrrigation(weather){
  try{
    const p = weather?.daily?.precipitation_sum?.[0];
    const p1 = weather?.daily?.precipitation_sum?.[1];
    const tmax = weather?.daily?.temperature_2m_max?.[0];
    const tmin = weather?.daily?.temperature_2m_min?.[0];
    const u = weather?.daily_units || {};

    const rainIn = (u.precipitation_sum === 'mm')
      ? (x) => (x ?? 0) / 25.4
      : (x) => (x ?? 0);

    const r0 = rainIn(p);
    const r1 = rainIn(p1);

    let recommendation = 'Maintain your normal schedule.';
    if (r0 >= 0.2 || r1 >= 0.2){
      recommendation = 'Rain is expected. Consider reducing or pausing irrigation (especially for containers) and re-check soil moisture.';
    } else if (tmax !== undefined && tmax >= 88){
      recommendation = 'Hot day expected. Consider an extra short irrigation cycle for containers and shallow-rooted greens.';
    }

    return {r0, r1, tmax, tmin, recommendation, units: u};
  }catch(e){
    return {recommendation: 'Weather loaded, but irrigation summary failed.'};
  }
}

function renderWeatherBlock(weather){
  const el = document.getElementById('weather');
  if (!el) return;

  const cache = getCachedWeather();
  const cachedAgeMin = cache?.ts ? Math.round((Date.now() - cache.ts)/60000) : null;

  if (!weather?.daily){
    el.textContent = 'Weather data unavailable.';
    return;
  }
  const u = weather.daily_units || {};
  const day0 = weather.daily.time?.[0];
  const tmax = weather.daily.temperature_2m_max?.[0];
  const tmin = weather.daily.temperature_2m_min?.[0];
  const p = weather.daily.precipitation_sum?.[0];
  const wmax = weather.daily.windspeed_10m_max?.[0];

  const summary = summarizeIrrigation(weather);
  const rainDisplay = (u.precipitation_sum === 'mm')
    ? `${(p ?? 0).toFixed(0)} ${u.precipitation_sum}`
    : `${(p ?? 0).toFixed(2)} ${u.precipitation_sum || 'in'}`;

  const windDisplay = (wmax === undefined) ? '—' : `${(wmax ?? 0).toFixed(0)} ${u.windspeed_10m_max || 'mph'}`;
  const cacheLine = (cachedAgeMin !== null) ? `<div class="help">Cached: ~${cachedAgeMin} min ago (ZIP ${WEATHER_ZIP}).</div>` : `<div class="help">ZIP ${WEATHER_ZIP}</div>`;

  const store = loadStore();
  const tips = gardenWeatherTips(window.__data, store, weather) || [];
  const tipsHtml = tips.length ? `<ul>${tips.map(t=>`<li>${safeText(t)}</li>`).join('')}</ul>` : '<div class="muted">—</div>';

  el.innerHTML = `
    <div class="kv"><div>Location</div><div>ZIP ${WEATHER_ZIP} (DC)</div></div>
    <div class="kv"><div>Date</div><div>${safeText(day0 || '')}</div></div>
    <div class="kv"><div>Temp</div><div>${safeText(tmin)}–${safeText(tmax)} ${safeText(u.temperature_2m_max || '°F')}</div></div>
    <div class="kv"><div>Rain</div><div>${rainDisplay}</div></div>
    <div class="kv"><div>Wind</div><div>${windDisplay}</div></div>
    <div class="note"><strong>Irrigation suggestion:</strong> ${safeText(summary.recommendation)}</div>
    <div class="note"><strong>Weather tips (next 7 days):</strong> ${tipsHtml}</div>
    ${cacheLine}
    <div style="margin-top:10px">
      <button id="btn-weather-refresh" class="btn secondary" style="width:100%">Refresh weather</button>
    </div>
  `;

  const btn = document.getElementById('btn-weather-refresh');
  if (btn){
    btn.onclick = async () => {
      const el2 = document.getElementById('weather');
      el2.textContent = 'Refreshing weather…';
      try{
        const geo = await geocodeZip(WEATHER_ZIP);
        const w = await getWeather(geo.lat, geo.lon);
        setCachedWeather(w);
        renderWeatherBlock(w);
      }catch(e){
        el2.textContent = `Weather unavailable: ${e.message || e}`;
      }
    };
  }
}


// ---------- Calendar (visual) ----------
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function yearFromData(data){
  // Choose a "default" year from the earliest task date in data
  let min = null;
  const scan = (t) => {
    const d = parseISO(t.date_target || t.start_date || null);
    if (d){
      if (!min || d < min) min = d;
    }
  };
  (data.global_tasks || []).forEach(scan);
  (data.plants || []).forEach(p => (p.task_plan || []).forEach(scan));
  return (min ? min.getFullYear() : new Date().getFullYear());
}

function collectYears(data){
  const years = new Set();
  const scan = (t) => {
    const d = parseISO(t.date_target || t.start_date || null);
    if (d) years.add(d.getFullYear());
  };
  (data.global_tasks || []).forEach(scan);
  (data.plants || []).forEach(p => (p.task_plan || []).forEach(scan));
  if (!years.size) years.add(new Date().getFullYear());
  return Array.from(years).sort((a,b)=>a-b);
}

function monthKey(year, monthIdx){ // monthIdx: 0-11
  return `${year}-${String(monthIdx+1).padStart(2,'0')}`;
}

function monthStart(year, monthIdx){
  return new Date(year, monthIdx, 1);
}
function monthEnd(year, monthIdx){
  return new Date(year, monthIdx+1, 0);
}

function taskCategory(template){
  const t = (template || '').toLowerCase();
  if (t.includes('seed_start')) return 'seedstart';
  if (t.includes('direct_sow') || t === 'sow' || t.includes('succession_sow')) return 'plant';
  if (t.includes('transplant')) return 'transplant';
  if (t.includes('harvest')) return 'harvest';
  // growing is derived as a period, not per-task
  return null;
}

function computePlantPeriods(plant){
  // Determine seed-start period (seed start -> transplant), in-bed period (direct_sow/transplant -> end_of_season_cleanup),
  // and harvest period (harvest -> end_of_season_cleanup). Uses first occurrences.
  const tasks = (plant.task_plan || []).map(t => ({...t, _d: parseISO(t.date_target || t.start_date || null)}))
    .filter(x => x._d)
    .sort((a,b)=>a._d-b._d);

  const firstSeed = tasks.find(t => (t.template || '').toLowerCase().includes('seed_start'))?._d || null;
  const firstTrans = tasks.find(t => (t.template || '').toLowerCase().includes('transplant'))?._d || null;
  const firstDirect = tasks.find(t => (t.template || '').toLowerCase().includes('direct_sow') || (t.template||'').toLowerCase().includes('succession_sow'))?._d || null;
  const firstHarvest = tasks.find(t => (t.template || '').toLowerCase().includes('harvest'))?._d || null;
  const endSeason = tasks.find(t => (t.template || '').toLowerCase().includes('end_of_season_cleanup'))?._d || (tasks.length ? tasks[tasks.length-1]._d : null);

  const seedStartPeriod = (firstSeed && firstTrans) ? {start:firstSeed, end:firstTrans} : null;
  const inBedStart = firstTrans || firstDirect || null;
  const inBedPeriod = (inBedStart && endSeason) ? {start: inBedStart, end: endSeason} : null;
  const harvestPeriod = (firstHarvest && endSeason) ? {start:firstHarvest, end:endSeason} : null;

  return {seedStartPeriod, inBedPeriod, harvestPeriod};
}

function monthHasDateRange(year, monthIdx, range){
  if (!range || !range.start || !range.end) return false;
  const ms = monthStart(year, monthIdx);
  const me = monthEnd(year, monthIdx);
  // overlap test
  return (range.start <= me) && (range.end >= ms);
}

function monthHasTaskEvent(plant, year, monthIdx, category, plan){
  const ms = monthStart(year, monthIdx);
  const me = monthEnd(year, monthIdx);
  const tasks = (plant.task_plan || []).filter(t => taskCategory(t.template) === category);
  if (!tasks.length) return false;

  // Apply plan method filter similarly to tasks list
  const method = plan?.method || 'either';
  const tplBlock = (tpl) => (tpl||'').toLowerCase();
  const allowed = (t) => {
    const tpl = tplBlock(t.template);
    if (method === 'direct_sow' && (tpl.includes('transplant') || tpl.includes('seed_start') || tpl.includes('harden'))) return false;
    if (method === 'transplant' && (tpl.includes('direct_sow') || tpl.includes('succession_sow'))) return false;
    return true;
  };

  return tasks.some(t => {
    if (!allowed(t)) return false;
    const d = parseISO(t.date_target || t.start_date || null);
    if (!d) return false;
    return d >= ms && d <= me;
  });
}

function renderCalendarMatrix(data, store, year){
  const el = document.getElementById('calendar-view');
  if (!el) return;

  // Header
  const table = document.createElement('div');
  table.className = 'cal-matrix';

  const header = document.createElement('div');
  header.className = 'cal-row cal-header';
  header.innerHTML = `<div class="cal-cell cal-plant-head">Plant</div>` + MONTHS.map(m => `<div class="cal-cell cal-month-head">${m}</div>`).join('');
  table.appendChild(header);

  for (const plant of (data.plants || [])){
    const plan = (typeof getPlan === 'function') ? getPlan(store, plant) : {method:'either', season:'both'};
    const periods = computePlantPeriods(plant);

    const row = document.createElement('div');
    row.className = 'cal-row';

    const icon = plant.visual?.icon || 'icons/plants/plant.svg';
    row.innerHTML = `
      <div class="cal-cell cal-plant">
        <img class="plant-icon" src="${safeText(icon)}" alt="" />
        <span class="cal-plant-name">${safeText(plant.name || '')}</span>
      </div>
    `;

    for (let mi=0; mi<12; mi++){
      const cell = document.createElement('div');
      cell.className = 'cal-cell cal-month';

      // Determine statuses (priority layering)
      const hasSeed = monthHasTaskEvent(plant, year, mi, 'seedstart', plan) || monthHasDateRange(year, mi, periods.seedStartPeriod);
      const hasPlant = monthHasTaskEvent(plant, year, mi, 'plant', plan);
      const hasTrans = monthHasTaskEvent(plant, year, mi, 'transplant', plan);
      const hasGrow = monthHasDateRange(year, mi, periods.inBedPeriod);
      const hasHarv = monthHasTaskEvent(plant, year, mi, 'harvest', plan) || monthHasDateRange(year, mi, periods.harvestPeriod);

      const tags = [];
      if (hasSeed) tags.push('seedstart');
      if (hasPlant) tags.push('plant');
      if (hasTrans) tags.push('transplant');
      if (hasGrow) tags.push('growing');
      if (hasHarv) tags.push('harvest');

      if (tags.length){
        cell.classList.add('cal-active');
        // background class: harvest dominates, else growing, else transplant, else plant, else seedstart
        const bg = hasHarv ? 'harvest' : (hasGrow ? 'growing' : (hasTrans ? 'transplant' : (hasPlant ? 'plant' : 'seedstart')));
        cell.classList.add(`cal-${bg}`);

        // small markers inside
        const markers = tags.map(t => `<span class="cal-dot ${t}" title="${t}"></span>`).join('');
        cell.innerHTML = `<div class="cal-dots">${markers}</div>`;
      } else {
        cell.innerHTML = '';
      }

      row.appendChild(cell);
    }

    table.appendChild(row);
  }

  // Replace
  el.innerHTML = '';
  el.appendChild(table);

  // Click behavior: click a plant row to open that plant detail in Plants tab
  table.querySelectorAll('.cal-row').forEach((r, idx) => {
    if (idx === 0) return; // header
    r.style.cursor = 'pointer';
    r.addEventListener('click', () => {
      activateTab('plants');
      // Find plant object
      const plant = (data.plants || [])[idx-1];
      if (typeof renderPlantDetail === 'function') renderPlantDetail(plant, store);
    });
  });
}

function renderCalendarMonth(data, store, year, monthIdx){
  const el = document.getElementById('calendar-view');
  if (!el) return;

  const ms = monthStart(year, monthIdx);
  const me = monthEnd(year, monthIdx);

  // Collect relevant events from tasks (including global)
  const store2 = store || loadStore();
  const tasks = (typeof buildAllTasks === 'function')
    ? buildAllTasks(data, store2)
    : collectBaseTasks(data);

  const monthTasks = tasks.filter(t => t.when >= ms && t.when <= me).sort((a,b)=>a.when-b.when);

  const wrap = document.createElement('div');
  wrap.className = 'cal-month';

  const title = document.createElement('div');
  title.className = 'muted';
  title.innerHTML = `<strong>${MONTHS[monthIdx]} ${year}</strong>`;
  wrap.appendChild(title);

  if (!monthTasks.length){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.marginTop = '10px';
    empty.textContent = 'No scheduled tasks in this month (based on your current plan).';
    wrap.appendChild(empty);
    el.innerHTML = '';
    el.appendChild(wrap);
    return;
  }

  // Group by date
  let current = '';
  for (const t of monthTasks){
    const k = isoDateOnly(t.when);
    if (k !== current){
      current = k;
      const h = document.createElement('div');
      h.className = 'cal-day';
      h.innerHTML = `<div class="cal-day-head">${fmtDate(t.when)}</div>`;
      wrap.appendChild(h);
    }

    const cat = taskCategory(t.template) || (t.flags?.is_global ? 'global' : 'other');
    const icon = t.flags?.is_global
      ? 'icons/plants/plant.svg'
      : (data.plants || []).find(p => (p.catalog_id||p.name) === (t.catalog_id||t.plant_name))?.visual?.icon || 'icons/plants/plant.svg';

    const card = document.createElement('div');
    card.className = `cal-event cal-${cat}`;
    card.innerHTML = `
      <img class="plant-icon" src="${safeText(icon)}" alt="" />
      <div>
        <div class="row-title" style="margin:0">${safeText(t.template.replaceAll('_',' '))}</div>
        <div class="row-meta">${safeText(t.plant_name || 'Global')}</div>
      </div>
    `;
    wrap.appendChild(card);
  }

  el.innerHTML = '';
  el.appendChild(wrap);
}

function renderCalendar(data, store){
  const panel = document.getElementById('tab-upcoming');
  if (!panel) return;

  const years = collectYears(data);
  const yearSel = document.getElementById('cal-year');
  const viewSel = document.getElementById('cal-view');
  const monthWrap = document.getElementById('cal-month-wrap');
  const monthSel = document.getElementById('cal-month');

  if (!yearSel || !viewSel || !monthSel) return;

  // Populate selectors once
  if (!yearSel.dataset.ready){
    yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearSel.value = String(yearFromData(data));
    yearSel.dataset.ready = '1';
  }

  if (!monthSel.dataset.ready){
    monthSel.innerHTML = MONTHS.map((m,i)=>`<option value="${i}">${m}</option>`).join('');
    monthSel.value = String(new Date().getMonth());
    monthSel.dataset.ready = '1';
  }

  const apply = () => {
    const y = parseInt(yearSel.value, 10);
    const v = viewSel.value;
    if (v === 'month'){
      monthWrap.style.display = 'block';
      const mi = parseInt(monthSel.value, 10);
      renderCalendarMonth(data, store, y, mi);
    }else{
      monthWrap.style.display = 'none';
      renderCalendarMatrix(data, store, y);
    }
  };

  if (!viewSel.dataset.ready){
    viewSel.dataset.ready = '1';
    viewSel.addEventListener('change', apply);
    yearSel.addEventListener('change', apply);
    monthSel.addEventListener('change', apply);
  }

  apply();
}

async function init(){
  // tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.getAttribute('data-tab')));
  });

  document.getElementById('toggle-hide-complete').addEventListener('change', refreshViews);
  document.getElementById('toggle-upcoming-hide-complete').addEventListener('change', refreshViews);
  document.getElementById('upcoming-window').addEventListener('change', refreshViews);
  document.getElementById('plant-search').addEventListener('input', refreshViews);

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Clear all completion history, notes, and plans on this device?')){
      localStorage.removeItem(STORE_KEY);
      refreshViews();
    }
  });

  // Hide legacy weather button; weather is auto-loaded for ZIP 20002
  const bw = document.getElementById('btn-weather');
  if (bw) bw.style.display = 'none';

  // data
  try{
    setSubtitle('Tasks: overdue + next 7 days');
    const data = await fetchData();
    window.__data = data;

    // Frost assumptions
    const lf = data?.meta?.region?.last_frost_assumption?.date || '—';
    const ff = data?.meta?.region?.first_frost_assumption?.date || '—';
    document.getElementById('frost').textContent = `Last frost: ${lf} • First frost: ${ff}`;

    refreshViews();

    // Weather: render cache immediately, then refresh
    try{
      const cached = getCachedWeather();
      if (cached?.payload){
        renderWeatherBlock(cached.payload);
      }else{
        document.getElementById('weather').textContent = 'Loading weather for ZIP ' + WEATHER_ZIP + '…';
      }
      const geo = await geocodeZip(WEATHER_ZIP);
      const w = await getWeather(geo.lat, geo.lon);
      setCachedWeather(w);
      renderWeatherBlock(w);
    }catch(e){
      const el = document.getElementById('weather');
      if (el) el.textContent = `Weather unavailable: ${e.message || e}`;
    }

  }catch(e){
    setSubtitle('Failed to load data');
    document.getElementById('today-tasks').innerHTML = `<div class="muted">Error: ${safeText(e.message || e)}</div>`;
  }

  // service worker
  if ('serviceWorker' in navigator){
    try{
      await navigator.serviceWorker.register('service-worker.js');
    }catch(e){
      // non-fatal
    }
  }
}


init();



function monthLabel(i){
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][i];
}

function taskCategory(t){
  const tpl = (t.template || '').toLowerCase();
  if (tpl.includes('indoor') || tpl.includes('seed_start')) return 'seedstart';
  if (tpl.includes('direct_sow') || tpl.includes('sow')) return 'plant';
  if (tpl.includes('transplant')) return 'transplant';
  if (tpl.includes('harvest')) return 'harvest';
  if (tpl.includes('fert')) return 'fert';
  if (tpl.includes('spray') || tpl.includes('pest') || tpl.includes('disease')) return 'pest';
  return 'other';
}

function catIcon(cat){
  // Small, readable emojis as fallback; plant icons still appear in row headers
  switch(cat){
    case 'seedstart': return '🌱';
    case 'plant': return '🫘';
    case 'transplant': return '🪴';
    case 'harvest': return '🧺';
    case 'fert': return '🧪';
    case 'pest': return '🐛';
    default: return '•';
  }
}

function renderCalendar(data, store){
  const tasks = buildAllTasks(data, store);
  const yearSel = document.getElementById('cal-year');
  const grid = document.getElementById('calendar-grid');
  if (!yearSel || !grid) return;

  // Determine years present in tasks
  const years = Array.from(new Set(tasks.map(t => new Date(t.when).getFullYear()))).sort((a,b)=>a-b);
  const curY = (new Date()).getFullYear();
  const defaultYear = years.includes(curY) ? curY : (years[0] || curY);

  yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('') || `<option value="${defaultYear}">${defaultYear}</option>`;
  yearSel.value = String(defaultYear);

  const paint = () => {
    const year = parseInt(yearSel.value, 10);
    const plants = (data.plants || []).slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    // Build a map: plantKey -> monthIdx -> set(categories)
    const map = {};
    for (const p of plants){
      map[plantKey(p)] = Array.from({length:12}, ()=> new Set());
    }
    // Include global tasks as a synthetic row
    map['GLOBAL'] = Array.from({length:12}, ()=> new Set());

    for (const t of tasks){
      const d = new Date(t.when);
      if (d.getFullYear() !== year) continue;
      const m = d.getMonth();
      const key = t.flags?.is_global ? 'GLOBAL' : t.scope_key;
      if (!map[key]) continue;
      map[key][m].add(taskCategory(t));
    }

    // Render table
    let html = `<table class="cal-table">
      <thead><tr><th class="sticky-col">Plant</th>${Array.from({length:12},(_,i)=>`<th>${monthLabel(i)}</th>`).join('')}</tr></thead>
      <tbody>`;

    const renderRow = (label, key, iconPath) => {
      html += `<tr><td class="sticky-col cal-plant">
        ${iconPath ? `<img class="plant-icon" src="${iconPath}" alt="" />` : ''} 
        <span>${escapeHtml(label)}</span>
      </td>`;
      for (let m=0;m<12;m++){
        const cats = Array.from(map[key]?.[m] || []);
        const content = cats.map(c => `<span class="cal-pill ${c}" title="${c}">${catIcon(c)}</span>`).join('');
        html += `<td class="cal-cell">${content || ''}</td>`;
      }
      html += `</tr>`;
    };

    renderRow('Global', 'GLOBAL', null);
    for (const p of plants){
      const icon = p.visual?.icon || p.icon || p.assets?.icon || null;
      renderRow(p.name || 'Plant', plantKey(p), icon);
    }

    html += `</tbody></table>`;
    grid.innerHTML = html;
  };

  yearSel.onchange = paint;
  paint();
}
