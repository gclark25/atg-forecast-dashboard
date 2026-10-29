/**
 * Data layer for the fundamentals tab: two scheduled jobs that keep ERCOT's own
 * forecasts and Metis's system-level forecasts side by side in KV.
 *
 *   runErcotJob  -> KV key 'ercot_state'  (served at /data/ercot.json)
 *   runMetisJob  -> KV key 'metis_fund'   (served at /data/metis_fund.json)
 *
 * Time convention used everywhere here: a stored interval is identified by its
 * START instant in UTC milliseconds. ERCOT's hour-ending rows are converted to
 * that (see ercot.js); Metis's `ts` already is the interval start (its first
 * point is the issue time plus one hour, as the source description says).
 *
 * Both jobs are built for Cloudflare's free plan:
 *  - ERCOT reports are pulled in small groups and the state is saved after each
 *    group, so a run that gets cut short still keeps what it finished.
 *  - After the first pull each ERCOT report costs one small request ("anything
 *    posted since what I hold?"), and nothing is downloaded twice.
 *  - The Metis job first asks one tiny question (what is the newest issue time?)
 *    and only downloads the full set when there is a new forecast.
 *
 * Everything is stored in column form ({ start: [...], cols: { name: [...] } }),
 * which is much smaller than one object per hour and easy to index in the page.
 */

import { pullAll, REPORTS, findGaps } from './ercot.js';

export const ERCOT_STATE_KEY = 'ercot_state';
export const METIS_STATE_KEY = 'metis_fund';
export const ERCOT_RUNS_KEY = 'ercot_runs'; // a short log of every ERCOT run: where it executed and how it ended

const ERCOT_SECRETS = ['ERCOT_API_USERNAME', 'ERCOT_API_PASSWORD', 'ERCOT_API_SUBSCRIPTION_KEY'];
export const ERCOT_GROUPS = [['load', 'wind', 'solar'], ['wind_system', 'solar_system', 'outage'], ['adequacy', 'load_actual']];
const HISTORY_MAX = 48;
const METIS_BASE = 'https://askthegrid.com/api/v1/grid/forecasts';
const BATCH_MAX = 20; // the API's limit on reads per batch request

const round1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const stripNewline = (s) => s.replace(/[\r\n]+$/, '');

async function readState(env, key) {
  try {
    const v = await env.FORECASTS_KV.get(key, 'json');
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null; // unreadable previous state: start that part fresh rather than fail
  }
}

// Where this Worker's outbound requests actually come from. ERCOT's API is described as US-only, and
// a cron run is not guaranteed to execute in the same place as a request you make yourself.
export async function egressTrace(f = fetch) {
  try {
    const res = await f('https://www.cloudflare.com/cdn-cgi/trace');
    const kv = {};
    for (const line of (await res.text()).split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return { colo: kv.colo || null, loc: kv.loc || null };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ERCOT
// ---------------------------------------------------------------------------
export function compactReport(r, fetchedAtIso) {
  const iv = r.intervals;
  const keys = iv.length ? Object.keys(iv[0].v) : [];
  const cols = {};
  for (const k of keys) cols[k] = iv.map((x) => round1(x.v[k]));
  return {
    source: r.source, posted_ct: r.posted_ct, posted_utc: r.posted_utc, fetched_at: fetchedAtIso,
    n: iv.length, start: iv.map((x) => Date.parse(x.start)), cols,
    missing_fields: r.missing_fields, gaps: findGaps(iv), window: r.window,
  };
}

export async function runErcotJob(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f = opts.f || fetch;
  const t0 = Date.now();
  const missing = ERCOT_SECRETS.filter((k) => typeof env[k] !== 'string' || !stripNewline(env[k]).length);
  if (missing.length) return { ok: false, error: 'secrets_missing', missing };
  const ercotEnv = Object.fromEntries(ERCOT_SECRETS.map((k) => [k, stripNewline(env[k])]));

  const prev = await readState(env, ERCOT_STATE_KEY);
  const state = prev && prev.reports ? prev : { reports: {}, history: {}, errors: {}, filter_ok: {} };
  state.history = state.history || {};
  state.errors = state.errors || {};
  state.filter_ok = state.filter_ok || {};

  // Where is this run executing? Asked on EVERY run, because a scheduled run can execute in a different place from
  // the last one, and ERCOT's firewall refuses some addresses. The answer is logged with the outcome below.
  let egressChanged = false;
  const trace = await egressTrace(f);
  if (trace) {
    egressChanged = !state.egress || state.egress.colo !== trace.colo || state.egress.loc !== trace.loc;
    state.egress = { ...trace, at: nowIso };
  }

  const since = {};
  for (const id of Object.keys(REPORTS)) if (state.reports[id] && state.reports[id].posted_ct) since[id] = state.reports[id].posted_ct;

  const summary = { ok: true, requests: 0, writes: 0, reports: {}, egress: state.egress || null };
  let stop = false;
  const wanted = Array.isArray(opts.groups) ? opts.groups : ERCOT_GROUPS.map((_, i) => i); // a scheduled run handles one group; a manual run can do all
  for (const gi of wanted) {
    const group = ERCOT_GROUPS[gi];
    if (!group || stop) continue;
    const results = await pullAll(ercotEnv, { nowMs, ids: group, since, knownFilter: state.filter_ok, f, sleep: opts.sleep });
    let changed = false;
    for (const id of group) {
      const r = results[id];
      summary.requests += r.requests || 0;
      if (!r.ok) {
        const e = r.error || {};
        state.errors[id] = { at: nowIso, kind: e.kind || 'unexpected', message: e.message || '', colo: trace ? trace.colo : null, loc: trace ? trace.loc : null, ...(e.detail ? { detail: e.detail } : {}) };
        summary.reports[id] = { status: 'error', error: state.errors[id] };
        if (e.kind === 'blocked' && !r.skipped) { // (the reports skipped after a refusal are not themselves the one refused) errors clear themselves when a report next succeeds, so the evidence also gets a home that persists
          state.last_block = { at: nowIso, report: id, via: opts.runner || 'worker', colo: trace ? trace.colo : null, loc: trace ? trace.loc : null, message: String(e.message || '').slice(0, 220), detail: e.detail || null };
        }
        if (e.kind === 'auth' || e.kind === 'blocked') stop = true; // asking again would only repeat the refusal
        changed = true;
        continue;
      }
      if (r.unchanged) {
        summary.reports[id] = { status: 'unchanged', posted_ct: r.posted_ct };
        if (state.errors[id]) { delete state.errors[id]; changed = true; } // answering again, even with nothing new, means it is healthy
        continue;
      }
      if (r.empty) {
        state.errors[id] = { at: nowIso, kind: 'empty', message: r.note };
        summary.reports[id] = { status: 'empty', note: r.note };
        changed = true;
        continue;
      }
      delete state.errors[id];
      const compact = compactReport(r, nowIso);
      state.reports[id] = compact;
      const hist = state.history[id] || [];
      if (!hist.some((h) => h.posted_utc === r.posted_utc)) {
        const lag = Math.round((nowMs - Date.parse(r.posted_utc)) / 60000);
        hist.unshift({ posted_ct: r.posted_ct, posted_utc: r.posted_utc, first_seen_at: nowIso, lag_min: lag });
      }
      state.history[id] = hist.slice(0, HISTORY_MAX);
      if (id === 'load' && r.server_side_filter === 'used') state.filter_ok.load = true;
      summary.reports[id] = { status: 'updated', posted_ct: r.posted_ct, age_min: r.age_min, intervals: compact.n, gaps: compact.gaps.length, missing_fields: r.missing_fields };
      changed = true;
    }
    if (changed || (egressChanged && summary.writes === 0)) {
      state.updated_at = nowIso;
      state.last_poll = { at: nowIso, requests: summary.requests, ms: Date.now() - t0 };
      const text = JSON.stringify(state);
      await env.FORECASTS_KV.put(ERCOT_STATE_KEY, text);
      summary.writes++;
      summary.bytes = text.length;
      egressChanged = false;
    }
  }
  summary.ms = Date.now() - t0;
  summary.ok = !Object.values(summary.reports).some((r) => r.status === 'error');

  // One line per run, newest first, in its own small key so that runs which change nothing are recorded too.
  const reps = Object.values(summary.reports);
  const bad = reps.find((r) => r.status === 'error');
  const runs = (await readState(env, ERCOT_RUNS_KEY)) || { runs: [] };
  runs.runs = [{
    at: nowIso, groups: wanted.map((g) => g + 1), colo: trace ? trace.colo : null, loc: trace ? trace.loc : null, via: opts.runner || 'worker',
    outcome: bad ? bad.error.kind : reps.some((r) => r.status === 'updated') ? 'updated' : 'unchanged', requests: summary.requests, ms: summary.ms,
    ...(Object.entries(summary.reports).some(([, r]) => r.status === 'error' && r.error.kind === 'blocked')
      ? { blocked: Object.entries(summary.reports).filter(([, r]) => r.status === 'error' && r.error.kind === 'blocked').map(([id]) => id) } : {}),
  }, ...(Array.isArray(runs.runs) ? runs.runs : [])].slice(0, 48);
  await env.FORECASTS_KV.put(ERCOT_RUNS_KEY, JSON.stringify(runs));
  return summary;
}

// ---------------------------------------------------------------------------
// Metis
// ---------------------------------------------------------------------------
const SYSTEM_FEEDS = [
  ['load', 'metis_load'], ['wind', 'metis_wind_generation'], ['solar', 'metis_solar_generation'],
  ['outage', 'metis_outage_capacity'], ['avail_cap', 'metis_available_capacity'], ['net_imports', 'metis_net_imports'],
];
// Zone names exactly as the API lists them (they match ERCOT's own regions, which is what makes a
// like-for-like zone comparison possible).
const ZONE_FEEDS = {
  load: { sourceId: 'metis_load', zones: ['coast', 'east', 'far_west', 'north', 'north_central', 'south_central', 'southern', 'west'] },
  wind: { sourceId: 'metis_wind_generation', zones: ['coastal', 'north', 'panhandle', 'south', 'west'] },
  solar: { sourceId: 'metis_solar_generation', zones: ['center_east', 'center_west', 'far_east', 'far_west', 'north_west', 'south_east'] },
  outage: { sourceId: 'metis_outage_capacity', zones: ['houston', 'north', 'south', 'west'] },
};

export function metisItems(includeZones = true) {
  const items = SYSTEM_FEEDS.map(([key, sourceId]) => ({
    id: `${key}:system`,
    input: { sourceId, iso: 'ERCOT', targetKind: 'system', targetId: 'system', horizonHours: '48', detail: 'levels' }, // all 21 levels
  }));
  if (includeZones) {
    for (const [key, { sourceId, zones }] of Object.entries(ZONE_FEEDS)) {
      for (const z of zones) {
        items.push({ id: `${key}:${z}`, input: { sourceId, iso: 'ERCOT', targetKind: 'zone', targetId: z, horizonHours: '48', detail: 'levels', quantiles: '0.1,0.5,0.9' } });
      }
    }
  }
  return items;
}

// One API series -> { start: [ms...], q: { p01: [...], ... } }. Zone series only carry p10/p50/p90.
export function buildSeries(series) {
  const pts = series.points || [];
  const levelKeys = pts.length && pts[0].levels ? Object.keys(pts[0].levels) : [];
  const keys = (levelKeys.length > 3 ? levelKeys : ['p10', 'p50', 'p90'])
    .slice().sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const q = {};
  for (const k of keys) q[k] = pts.map((p) => round1(p.levels && p.levels[k] !== undefined ? p.levels[k] : p[k]));
  return { start: pts.map((p) => Date.parse(p.ts)), q };
}

// Every call has a time limit, because one hung request would otherwise hold a whole run open.
// A batch of 20 series has been seen taking 20 s, so the default allows three times that.
async function metisCall(f, url, init, sleep, timeoutMs = 60000) {
  for (let attempt = 0; ; attempt++) {
    let res;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      res = await f(url, { ...init, signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < 1) { await sleep(1000); continue; }
      throw new Error(e && e.name === 'AbortError' ? `askthegrid gave no answer within ${timeoutMs} ms` : `could not reach askthegrid: ${e.message || e}`);
    }
    clearTimeout(timer);
    if (res.status === 200) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 1) { await sleep(1000); continue; }
    throw new Error(`askthegrid returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export async function runMetisJob(env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const f = opts.f || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  if (!env.ASKTHEGRID_API_KEY) return { ok: false, error: 'secrets_missing', missing: ['ASKTHEGRID_API_KEY'] };
  const headers = { Authorization: `Bearer ${stripNewline(env.ASKTHEGRID_API_KEY)}`, Accept: 'application/json' };
  const includeZones = env.FUNDAMENTALS_ZONES !== 'false';
  let requests = 0;

  // 1. one tiny request: what is the newest forecast?
  let issuedAt;
  try {
    requests++;
    const probe = await metisCall(f, `${METIS_BASE}?${new URLSearchParams({ iso: 'ERCOT', sourceId: 'metis_load', targetKind: 'system', targetId: 'system', horizonHours: '1', detail: 'levels', quantiles: '0.5' })}`, { headers }, sleep, opts.timeoutMs);
    const s = probe && probe.series && probe.series[0];
    issuedAt = s && s.issuedAt;
  } catch (e) {
    return { ok: false, error: 'probe_failed', message: String(e.message || e), requests, ms: Date.now() - t0 };
  }
  if (!issuedAt) return { ok: false, error: 'no_issued_at', requests, ms: Date.now() - t0 };

  const prev = await readState(env, METIS_STATE_KEY);
  const state = prev && prev.series ? prev : { series: {}, feeds: {}, errors: {}, vintage_log: [] };
  state.feeds = state.feeds || {};
  state.errors = state.errors || {};
  state.vintage_log = state.vintage_log || [];
  if (state.issued_at === issuedAt && state.complete !== false) {
    return { ok: true, unchanged: true, issued_at: issuedAt, requests, ms: Date.now() - t0 };
  }

  // 2. a new forecast. A new one starts a fresh round; a round that was cut short carries on with only what it
  //    has not fetched yet. Each run fetches at most `perRun` batches of 20 (default 1, which keeps one run well
  //    inside the free plan's CPU limit) and saves after every batch; the next poll continues.
  if (state.pending_issued_at !== issuedAt) {
    state.pending_issued_at = issuedAt;
    state.errors = {};
  }
  state.complete = false;
  const items = metisItems(includeZones);
  const isDone = (id) => !!(state.series[id] && state.feeds[id] && state.feeds[id].issued_at === issuedAt);
  const outstanding = () => items.filter((it) => !isDone(it.id) && !state.errors[it.id]);
  const perRun = Math.max(1, Number(env.FUNDAMENTALS_BATCHES_PER_RUN) || 1);
  let bytes = 0;
  let fetched = 0;
  for (let c = 0; c < perRun; c++) {
    const batch = outstanding().slice(0, BATCH_MAX);
    if (!batch.length) break;
    requests++;
    let body;
    try {
      body = await metisCall(f, `${METIS_BASE}/batch`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: batch }) }, sleep, opts.timeoutMs);
    } catch (e) {
      return { ok: false, error: 'batch_failed', message: String(e.message || e), requests, ms: Date.now() - t0 };
    }
    for (const r of (body && body.results) || []) {
      const series = r.ok && r.bundle && r.bundle.series && r.bundle.series[0];
      if (!series || series.status === 'empty' || !(series.points || []).length) {
        state.errors[r.id] = { status: r.status ?? null, message: String((r.error && (r.error.message || r.error)) || (series && series.status) || 'no data').slice(0, 200) };
        continue;
      }
      state.series[r.id] = buildSeries(series);
      state.feeds[r.id] = { issued_at: series.issuedAt, mirror_updated_at: series.mirrorUpdatedAt || null, status: series.status || null, model_version: series.modelVersion || null };
      fetched++;
      if (r.id === 'load:system') {
        state.model = { model_id: (series.source || {}).modelId || null, short_name: (series.source || {}).shortName || null, model_version: series.modelVersion || null };
      }
    }
    for (const it of batch) if (!isDone(it.id) && !state.errors[it.id]) state.errors[it.id] = { status: null, message: 'missing from the batch response' };
    if (!outstanding().length) {
      state.issued_at = issuedAt;
      state.mirror_updated_at = (state.feeds['load:system'] && state.feeds['load:system'].mirror_updated_at) || null;
      state.complete = true;
      if (!state.vintage_log.some((v) => v.issued_at === issuedAt)) {
        state.vintage_log.unshift({ issued_at: issuedAt, first_seen_at: nowIso, mirror_updated_at: state.mirror_updated_at, lag_min: Math.round((nowMs - Date.parse(issuedAt)) / 60000) });
        state.vintage_log = state.vintage_log.slice(0, HISTORY_MAX);
      }
    }
    state.updated_at = nowIso;
    const text = JSON.stringify(state);
    await env.FORECASTS_KV.put(METIS_STATE_KEY, text);
    bytes = text.length;
  }
  if (!bytes && state.complete === false && !outstanding().length) { // nothing was outstanding (e.g. every remaining item had already failed): close the round
    state.issued_at = issuedAt;
    state.complete = true;
    state.updated_at = nowIso;
    const text = JSON.stringify(state);
    await env.FORECASTS_KV.put(METIS_STATE_KEY, text);
    bytes = text.length;
  }
  return { ok: Object.keys(state.errors).length === 0, unchanged: false, complete: state.complete === true, remaining: outstanding().length, fetched_this_run: fetched, issued_at: issuedAt, requests, ms: Date.now() - t0, series: Object.keys(state.series).length, errors: state.errors, bytes };
}
