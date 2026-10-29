/**
 * Cloudflare Worker replacing the GitHub Actions pull-and-publish pipeline.
 *
 * Why: GitHub's scheduled (cron) triggers are explicitly documented as
 * best-effort, not guaranteed -- delays of 30+ minutes under load are normal,
 * and runs can be dropped entirely. A Cloudflare Cron Trigger runs on the
 * same platform already serving this dashboard, without competing for
 * GitHub's shared runner queue.
 *
 * - scheduled(): runs on the cron below. Pulls the latest forecast for every
 *   configured node from askthegrid's API and writes it to KV.
 * - fetch(): serves data/manifest.json, data/<node>_latest.json, and
 *   data/run_status.json out of KV; everything else (index.html, fleet.html,
 *   theme.js) falls through to the static ASSETS binding unchanged.
 *
 * Deliberately NOT ported from the old Python pipeline: the vintage-keyed
 * forecast_log.jsonl history used for the future live-accuracy-scorecard
 * work. That was never wired into the schedule in the first place -- if/when
 * that work resumes, it needs its own KV (or R2) design, not a straight port.
 */

import nodesConfig from './config/nodes.json';
import { pullAll, summarize, REPORTS as ERCOT_REPORTS } from './ercot.js';
import { runErcotJob, runMetisJob } from './fundamentals.js';

const BASE_URL = 'https://askthegrid.com';
const FORECAST_PATH = '/api/v1/grid/forecasts';
const SOURCE_MATCH = 'metis'; // confirmed correct against a live pull, 2026-10-06

const QUANTILE_LEVELS = { q05: 0.05, q10: 0.10, q25: 0.25, q50: 0.50, q75: 0.75, q90: 0.90, q95: 0.95 };
const TOP_LEVEL_FIELD = { 0.10: 'p10', 0.50: 'p50', 0.90: 'p90' };

async function fetchWithRetry(url, headers, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 200) return res.json();
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    throw new Error(`askthegrid API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  throw new Error(`askthegrid API: exhausted retries on ${url}`);
}

async function getLatestForecast(nodeId, apiKey, horizonHours = 48) {
  const now = new Date();
  const to = new Date(now.getTime() + horizonHours * 3600 * 1000);
  const params = new URLSearchParams({
    iso: 'ERCOT', targetKind: 'node', targetId: nodeId,
    from: now.toISOString(), to: to.toISOString(), detail: 'levels',
  });
  return fetchWithRetry(`${BASE_URL}${FORECAST_PATH}?${params}`, {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  });
}

// Every series on the response that looks like a Metis forecast.
function metisCandidates(raw) {
  return (raw.series || []).filter((s) => {
    const src = s.source || {};
    const name = ['id', 'shortName', 'displayName', 'modelId'].map((k) => String(src[k] || '')).join(' ').toLowerCase();
    return name.includes(SOURCE_MATCH);
  });
}

// Which series to show. If the API ever returns more than one Metis series for
// a node (a second model build, say), take the newest usable one instead of
// whichever happens to be listed first: usable = status 'ready' with points,
// newest = latest issuedAt. A single candidate is chosen exactly as before.
function selectMetisSeries(raw) {
  const series = raw.series || [];
  const candidates = metisCandidates(raw);
  if (candidates.length) {
    const usable = (s) => (s.status === undefined || s.status === 'ready') && Array.isArray(s.points) && s.points.length > 0;
    return [...candidates].sort((a, b) => {
      if (usable(a) !== usable(b)) return usable(a) ? -1 : 1;
      const ai = a.issuedAt || '';
      const bi = b.issuedAt || '';
      if (ai !== bi) return ai > bi ? -1 : 1; // newest issue time first
      return 0; // tie: keep the API's order
    })[0];
  }
  return series.length ? series[0] : null;
}

function extractQuantile(point, level) {
  if (TOP_LEVEL_FIELD[level]) return point[TOP_LEVEL_FIELD[level]];
  const levels = point.levels || {};
  for (const key of [String(level), level.toFixed(2), String(Math.round(level * 100)), `p${String(Math.round(level * 100)).padStart(2, '0')}`]) {
    if (key in levels) return levels[key];
  }
  return null;
}

function parseForecastResponse(raw, nodeId) {
  const series = selectMetisSeries(raw);
  if (!series) return [];
  const issuedAt = series.issuedAt;
  const issuedMs = issuedAt ? new Date(issuedAt).getTime() : null;

  return (series.points || []).map((p) => {
    const ts = p.ts;
    const horizonHours = issuedMs && ts ? (new Date(ts).getTime() - issuedMs) / 3600000 : null;
    const row = {
      node_id: nodeId,
      origin_time: issuedAt,
      target_time: ts,
      horizon_hours: horizonHours,
      pulled_at: new Date().toISOString(),
      truth: p.actual ?? null,
    };
    for (const [qcol, qlev] of Object.entries(QUANTILE_LEVELS)) {
      row[qcol] = extractQuantile(p, qlev);
    }
    return row;
  });
}

function extractSeriesMeta(raw) {
  const series = selectMetisSeries(raw);
  if (!series) return null;
  const src = series.source || {};
  const meta = {
    display_name: src.displayName ?? null,
    model_id: src.modelId ?? null,
    horizon_hours: src.horizonHours ?? null,
    issue_cadence_minutes: src.issueCadenceMinutes ?? null,
    resolution_minutes: src.resolutionMinutes ?? null,
    // Which model build and which forecast run this is, so the pages can say so:
    source_id: src.id ?? null,
    model_version: series.modelVersion ?? null,
    model_hash: series.modelHash ?? null,
    issued_at: series.issuedAt ?? null,
    mirror_updated_at: series.mirrorUpdatedAt ?? null,
    series_status: series.status ?? null,
  };
  const passedOver = metisCandidates(raw).filter((s) => s !== series);
  if (passedOver.length) {
    meta.alternatives = passedOver.map((s) => ({
      source_id: (s.source || {}).id ?? null,
      model_id: (s.source || {}).modelId ?? null,
      model_version: s.modelVersion ?? null,
      issued_at: s.issuedAt ?? null,
      status: s.status ?? null,
    }));
  }
  return meta;
}

// ---- Model-version and forecast-vintage history ----
//
// Rides inside run_status, which is already written every run, so it costs no
// extra KV write. Two things are kept:
//   model.history -- every distinct model build this dashboard has seen
//   vintage_log   -- recent forecast issue times and when we first saw each, so
//                    missing vintages and publishing delay are visible after the
//                    fact. (Not the full forecast history; just the timeline.)
// If a run gets no data at all, the previous history is carried forward as it
// was instead of being wiped.
const MODEL_HISTORY_MAX = 20;
const VINTAGE_LOG_MAX = 48;

function modelKey(m) {
  return [m.source_id, m.model_id, m.model_version, m.model_hash].map((v) => (v == null ? '' : String(v))).join('|');
}

function buildRunStatus(prev, allLatest, nowIso) {
  const prevModel = prev && prev.model && typeof prev.model === 'object' ? prev.model : {};
  const nodes = Object.values(allLatest);

  // The model build the fleet is on: the most common one across nodes.
  const tally = new Map();
  for (const n of nodes) {
    const m = n.source_meta;
    if (!m || (!m.model_id && !m.model_version && !m.source_id)) continue;
    const k = modelKey(m);
    const e = tally.get(k) || { count: 0, meta: m };
    e.count++;
    tally.set(k, e);
  }
  let current = null;
  for (const e of tally.values()) {
    if (!current || e.count > current.nodes) {
      current = {
        source_id: e.meta.source_id ?? null,
        display_name: e.meta.display_name ?? null,
        model_id: e.meta.model_id ?? null,
        model_version: e.meta.model_version ?? null,
        model_hash: e.meta.model_hash ?? null,
        nodes: e.count,
      };
    }
  }

  let history = Array.isArray(prevModel.history) ? prevModel.history.slice() : [];
  if (current && (!history.length || modelKey(history[0]) !== modelKey(current))) {
    history.unshift({
      first_seen_at: nowIso,
      source_id: current.source_id,
      display_name: current.display_name,
      model_id: current.model_id,
      model_version: current.model_version,
      model_hash: current.model_hash,
    });
  }
  history = history.slice(0, MODEL_HISTORY_MAX);

  // Forecast issue times across the fleet.
  const issued = nodes
    .map((n) => ({
      at: (n.source_meta && n.source_meta.issued_at) || n.origin_time || null,
      mirror: (n.source_meta && n.source_meta.mirror_updated_at) || null,
    }))
    .filter((x) => x.at)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const newest = issued.length ? issued[issued.length - 1] : null;

  let log = Array.isArray(prev && prev.vintage_log) ? prev.vintage_log.slice() : [];
  if (newest && !log.some((v) => v.issued_at === newest.at)) {
    log.push({ issued_at: newest.at, first_seen_at: nowIso, mirror_updated_at: newest.mirror });
  }
  log.sort((a, b) => (a.issued_at < b.issued_at ? 1 : a.issued_at > b.issued_at ? -1 : 0)); // newest first
  log = log.slice(0, VINTAGE_LOG_MAX);

  return {
    generated_at: nowIso,
    model: { current: current || prevModel.current || null, history },
    vintage: newest
      ? { newest_issued_at: newest.at, oldest_issued_at: issued[0].at, nodes: issued.length, newest_mirror_updated_at: newest.mirror }
      : (prev && prev.vintage) || null,
    vintage_log: log,
  };
}

async function pullAndStore(env) {
  console.log('pullAndStore: starting, apiKey present?', !!env.ASKTHEGRID_API_KEY);
  const nodes = nodesConfig.nodes;
  const weakTail = new Set(nodesConfig.weak_tail_nodes || []);
  const apiKey = env.ASKTHEGRID_API_KEY;

  // Cloudflare's free KV plan caps writes at 1,000/day (resets 00:00 UTC).
  // A separate KV key per node (33 writes/run: 32 nodes + manifest +
  // run_status) at a 15min cadence works out to ~3,168 writes/day -- over
  // 3x the quota, which would make the pull start silently failing again
  // partway through most days once the quota's used up. Instead, every
  // node's data goes into ONE combined key (allLatest), written once per
  // run -- 3 writes/run regardless of fleet size, ~288/day. fetch() below
  // reads that one key and pulls out just the requested node, so the
  // frontend's per-node URLs (/data/<node>_latest.json) are unchanged.
  //
  // nodes.map(async ...) + Promise.all preserves the INPUT order in the
  // resolved array, regardless of which fetch actually finishes first --
  // critical here, since index.html's node button list just iterates
  // whatever order manifest.json arrives in. Pushing to a shared array as
  // each promise resolved (an earlier version of this) would have made that
  // list reshuffle unpredictably between pulls; returning from the mapped
  // function instead keeps it stable and matching config/nodes.json's order.
  const results = await Promise.all(nodes.map(async (node) => {
    const nodeId = node.node_id;
    try {
      const raw = await getLatestForecast(nodeId, apiKey);
      const rows = parseForecastResponse(raw, nodeId);
      const meta = extractSeriesMeta(raw);

      let nodeData = null;
      if (rows.length) {
        const latestOrigin = rows.reduce((max, r) => (r.origin_time > max ? r.origin_time : max), rows[0].origin_time);
        const snapshotRows = rows
          .filter((r) => r.origin_time === latestOrigin)
          .sort((a, b) => (a.target_time < b.target_time ? -1 : 1));

        nodeData = {
          node_id: nodeId,
          display_name: node.display_name,
          origin_time: latestOrigin,
          weak_tail_node: weakTail.has(nodeId),
          source_meta: meta,
          rows: snapshotRows,
        };
      }

      return {
        nodeId,
        nodeData,
        manifestEntry: {
          node_id: nodeId,
          display_name: node.display_name,
          weak_tail_node: weakTail.has(nodeId),
          rows_pulled: rows.length,
          new_rows: rows.length, // vintage-dedup history not ported in this migration
        },
      };
    } catch (e) {
      console.log(`pullAndStore: ${nodeId} failed:`, e.message || e);
      return {
        nodeId,
        nodeData: null,
        manifestEntry: {
          node_id: nodeId,
          display_name: node.display_name,
          weak_tail_node: weakTail.has(nodeId),
          rows_pulled: 0,
          new_rows: 0,
          error: String(e.message || e),
        },
      };
    }
  }));

  const allLatest = {};
  for (const r of results) {
    if (r.nodeData) allLatest[r.nodeId] = r.nodeData;
  }
  const manifest = results.map((r) => r.manifestEntry);

  let prevStatus = null;
  try {
    prevStatus = await env.FORECASTS_KV.get('run_status', 'json');
  } catch (e) {
    console.log('pullAndStore: could not read the previous run_status; its history starts fresh:', e.message || e);
  }
  const runStatus = buildRunStatus(prevStatus, allLatest, new Date().toISOString());
  if (runStatus.vintage) {
    const ageMin = Math.round((Date.now() - new Date(runStatus.vintage.newest_issued_at).getTime()) / 60000);
    console.log(`pullAndStore: newest forecast vintage issued ${runStatus.vintage.newest_issued_at} (${ageMin} min old), model ${runStatus.model.current ? runStatus.model.current.model_id + ' ' + runStatus.model.current.model_version : 'unknown'}`);
  }

  console.log('pullAndStore: writing allLatest + manifest + run_status, node results:', manifest.map(m => `${m.node_id}:${m.rows_pulled}${m.error ? '(' + m.error + ')' : ''}`).join(', '));
  await env.FORECASTS_KV.put('allLatest', JSON.stringify(allLatest));
  await env.FORECASTS_KV.put('manifest', JSON.stringify(manifest));
  await env.FORECASTS_KV.put('run_status', JSON.stringify(runStatus));
  console.log('pullAndStore: done');
}

const KV_ROUTES = {
  '/data/manifest.json': 'manifest',
  '/data/run_status.json': 'run_status',
  '/data/ercot.json': 'ercot_state',      // ERCOT's own forecasts, written by runErcotJob
  '/data/metis_fund.json': 'metis_fund',  // Metis's system feeds, written by runMetisJob
  '/data/ercot_runs.json': 'ercot_runs',  // where each ERCOT run executed and how it ended
};

// Which scheduled job runs is decided by the minute the trigger fired:
//   :05 :20 :35 :50          nodal price pull (unchanged)
//   :03 :06 :09 :33          ERCOT's own forecasts, ONE group of reports per run so each run stays small
//                            (:03 load+wind+solar, :06 system wind/solar+outage, :09 adequacy, :33 load again
//                            because ERCOT posts the load forecast at :30; the rest post around :55 and :00)
//   :38 :48 :58              Metis system feeds (issued at :00, available to us about :33); a new forecast is
//                            fetched in two batches, one per run
// All of it runs from the single cron expression in wrangler.toml; anything not listed below is the price pull.
const ERCOT_JOB_GROUP_BY_MINUTE = { 3: 0, 6: 1, 9: 2, 33: 0 };
const METIS_JOB_MINUTES = [38, 48, 58];

// Node-latest requests (/data/<id>_latest.json) don't map to their own KV
// key anymore -- all nodes live together in the single 'allLatest' key (see
// the write-batching note in pullAndStore). This extracts just the
// requested node_id so fetch() can pull its data back out.
function nodeIdForPath(pathname) {
  const m = pathname.match(/^\/data\/([A-Za-z0-9_]+)_latest\.json$/);
  return m ? m[1] : null;
}

// ---- Chat: proxies the dashboard's chat panel to askthegrid's grid agent ----
//
// The browser never sees the API key: it posts to /api/chat on this Worker,
// which submits the turn upstream and streams the NDJSON answer back.
// Upstream contract (from askthegrid's published OpenAPI 3.1 file):
//   POST /api/v1/agent/runtime/v1/session   -> returns immediately; session id
//        comes back in the x-atg-agent-session-id header. Requires headers
//        x-atg-iso (market the turn is locked to) and x-atg-turn-id (16-200
//        chars of [A-Za-z0-9_-], makes a retried submit idempotent).
//   GET  .../session/{sessionId}/stream?startIndex=N -> NDJSON event stream.
//
// Off by default (CHAT_ENABLED var in wrangler.toml): every message spends
// askthegrid usage. The whole site now sits behind the password gate below,
// so once chat is on, only people with that password can reach this route.
const CHAT_SESSION_URL = `${BASE_URL}/api/v1/agent/runtime/v1/session`;
const CHAT_MARKET = 'ERCOT'; // fixed server-side; never taken from the browser
const MAX_CHAT_MESSAGE_CHARS = 4000;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function handleChat(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (env.CHAT_ENABLED !== 'true') return jsonResponse({ error: 'chat_disabled' }, 403);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return jsonResponse({ error: 'empty_message' }, 400);
  if (message.length > MAX_CHAT_MESSAGE_CHARS) {
    return jsonResponse({ error: 'message_too_long', maxChars: MAX_CHAT_MESSAGE_CHARS }, 400);
  }

  const clientSessionId = body.sessionId == null ? null : body.sessionId;
  if (clientSessionId !== null && (typeof clientSessionId !== 'string' || clientSessionId.length < 1 || clientSessionId.length > 300)) {
    return jsonResponse({ error: 'invalid_session_id' }, 400);
  }

  // Which event index to start reading from. Only matters for follow-up turns
  // in an existing session (the client tracks how many events it has already
  // processed); a new session always starts at 0.
  const startIndex = Number.isInteger(body.startIndex) && body.startIndex >= 0 && body.startIndex <= 1000000
    ? body.startIndex
    : 0;

  const submitBody = { message };
  if (clientSessionId) submitBody.sessionId = clientSessionId;

  const authHeaders = { Authorization: `Bearer ${env.ASKTHEGRID_API_KEY}` };

  let submitRes;
  try {
    submitRes = await fetch(CHAT_SESSION_URL, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-atg-iso': CHAT_MARKET,
        'x-atg-turn-id': `hen-${crypto.randomUUID()}`,
      },
      body: JSON.stringify(submitBody),
    });
  } catch (e) {
    return jsonResponse({ error: 'upstream_unreachable' }, 502);
  }
  if (!submitRes.ok) {
    const detail = (await submitRes.text()).slice(0, 300);
    return jsonResponse({ error: 'upstream_error', upstreamStatus: submitRes.status, detail }, 502);
  }

  const sessionId = submitRes.headers.get('x-atg-agent-session-id') || clientSessionId;
  if (!sessionId) return jsonResponse({ error: 'no_session_id_returned' }, 502);

  let streamRes;
  try {
    streamRes = await fetch(
      `${CHAT_SESSION_URL}/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`,
      { headers: { ...authHeaders, Accept: 'application/x-ndjson' } },
    );
  } catch (e) {
    return jsonResponse({ error: 'upstream_unreachable' }, 502);
  }
  if (!streamRes.ok || !streamRes.body) {
    return jsonResponse({ error: 'stream_error', upstreamStatus: streamRes.status }, 502);
  }

  return new Response(streamRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'x-atg-agent-session-id': sessionId,
    },
  });
}

// ---- ERCOT connectivity + data check (read-only; stores nothing) ----
//
// Visit /debug/ercot-check (site password required). It signs in to ERCOT's
// public API from this Worker, pulls the reports the fundamentals tab will use,
// and returns a short credential-free summary: did it work from Cloudflare's
// network, how fresh is each report, did an expected column go missing.
//
//   /debug/ercot-check                  all seven reports (about 14 ERCOT requests)
//   /debug/ercot-check?only=load,wind   just those (use this if one request is too much work
//                                       for the free plan's 10 ms CPU limit)
//
// ERCOT documents a limit of 30 requests a minute. This route keeps a running
// count of what it has spent in the last minute and refuses to go over 25.
const ERCOT_SECRETS = ['ERCOT_API_USERNAME', 'ERCOT_API_PASSWORD', 'ERCOT_API_SUBSCRIPTION_KEY'];
const ERCOT_MINUTE_BUDGET = 25;
let ercotSpend = []; // [timestampMs, requestsSpent]

async function handleErcotCheck(request, env) {
  const missing = ERCOT_SECRETS.filter((k) => typeof env[k] !== 'string' || !env[k].replace(/[\r\n]+$/, '').length);
  if (missing.length) return jsonResponse({ error: 'ercot_secrets_missing', missing }, 503);

  const onlyParam = new URL(request.url).searchParams.get('only');
  const ids = onlyParam ? onlyParam.split(',').map((x) => x.trim()).filter(Boolean) : Object.keys(ERCOT_REPORTS);
  const unknown = ids.filter((id) => !(id in ERCOT_REPORTS));
  if (unknown.length || !ids.length) return jsonResponse({ error: 'unknown_report', unknown, valid: Object.keys(ERCOT_REPORTS) }, 400);

  const now = Date.now();
  ercotSpend = ercotSpend.filter(([t]) => now - t < 60000);
  const spent = ercotSpend.reduce((a, [, n]) => a + n, 0);
  const planned = ids.length * 2 + 1;
  if (spent + planned > ERCOT_MINUTE_BUDGET) {
    const oldest = ercotSpend.length ? ercotSpend[0][0] : now;
    return jsonResponse({ error: 'too_soon', spent_last_minute: spent, retry_in_seconds: Math.max(1, Math.ceil((60000 - (now - oldest)) / 1000)) }, 429);
  }
  // A stray trailing newline from `wrangler secret put` would otherwise break sign-in.
  const ercotEnv = Object.fromEntries(ERCOT_SECRETS.map((k) => [k, env[k].replace(/[\r\n]+$/, '')]));
  const results = await pullAll(ercotEnv, { nowMs: now, ids });
  const reports = {};
  let used = 1; // the sign-in
  for (const [id, r] of Object.entries(results)) { reports[id] = summarize(r); used += r.requests || 0; }
  ercotSpend.push([now, used]);
  const cf = request.cf || {};
  return jsonResponse({
    checked_at: new Date(now).toISOString(),
    total_ms: Date.now() - now,
    worker_location: { colo: cf.colo || null, country: cf.country || null },
    all_ok: Object.values(reports).every((r) => r.ok),
    ercot_requests_this_call: used,
    reports,
  });
}

// ---- A plain-text read-out of how the scheduled ERCOT runs have gone ----
//
// /debug/ercot-log (site password required) prints the run log as a table, a tally by the place each run
// executed, and the most recent firewall block with the evidence kept from it. It exists so the question
// "are the scheduled runs being blocked, and from where?" is one curl, not a pasted script.
async function handleErcotLog(env) {
  const read = async (k) => { try { return await env.FORECASTS_KV.get(k, 'json'); } catch (e) { return null; } };
  const runsDoc = await read('ercot_runs');
  const state = await read('ercot_state');
  const runs = runsDoc && Array.isArray(runsDoc.runs) ? runsDoc.runs : [];
  const lines = ['ERCOT scheduled-job log (newest first, times UTC)', ''];
  if (!runs.length) {
    lines.push('No runs recorded yet. Scheduled runs happen at :03 :06 :09 and :33 past each hour.');
  } else {
    lines.push('at (UTC)         grp  colo  loc  outcome     req     ms');
    for (const r of runs) {
      lines.push(`${String(r.at).slice(5, 19).replace('T', ' ')}  ${(r.groups || []).join(',').padEnd(3)}  ${String(r.colo ?? '?').padEnd(4)}  ${String(r.loc ?? '?').padEnd(3)}  ${String(r.outcome).padEnd(10)}  ${String(r.requests ?? '').padStart(3)}  ${String(r.ms ?? '').padStart(5)}${r.blocked && r.blocked.length ? `  blocked: ${r.blocked.join(',')}` : ''}`);
    }
    const tally = {};
    for (const r of runs) {
      const key = `${r.colo ?? '?'} ${r.loc ?? '?'}`;
      const t = tally[key] || (tally[key] = { runs: 0, blocked: 0, other: 0 });
      t.runs++;
      if (r.outcome === 'blocked') t.blocked++;
      else if (r.outcome !== 'updated' && r.outcome !== 'unchanged') t.other++;
    }
    lines.push('', 'By location:');
    for (const [k, t] of Object.entries(tally).sort((a, b) => b[1].runs - a[1].runs)) {
      lines.push(`  ${k.padEnd(8)} ${t.runs} runs, ${t.blocked} blocked, ${t.other} other errors`);
    }
  }
  const lb = state && state.last_block;
  lines.push('', lb ? `Most recent block: ${lb.at} on report "${lb.report}", run executing in ${lb.colo ?? '?'} ${lb.loc ?? '?'}` : 'No block has been recorded since this logging began.');
  if (lb && lb.detail) {
    lines.push(`  headers: ${JSON.stringify(lb.detail.headers || {})}`);
    lines.push(`  page length: ${lb.detail.body_length}`);
    lines.push(`  end of the page: ${String(lb.detail.body_tail || '').replace(/\s+/g, ' ').slice(-400)}`);
  }
  return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---- Site password gate (HTTP Basic) ----
//
// Every request to the site goes through fetch() below, and this check runs
// first, so one password covers the pages, the forecast data and the chat.
// The browser shows its own login box once, then re-sends the credentials
// automatically (the username is ignored -- only the password is checked).
//
// This depends on `run_worker_first = true` in wrangler.toml: that setting is
// what makes the static pages (index.html, fleet.html) pass through fetch()
// at all. If it's ever removed, those pages would be served without this check.
//
// Fails CLOSED: if SITE_PASSWORD is missing or shorter than 16 characters the
// site refuses every request rather than quietly serving everyone. The cron
// pull (scheduled()) doesn't go through fetch() and is unaffected.
const MIN_SITE_PASSWORD_CHARS = 16;

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compares without revealing where two strings first differ: both are hashed
// to equal-length digests and every byte is compared before answering.
async function passwordMatches(supplied, expected) {
  const [a, b] = await Promise.all([sha256(supplied), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readBasicPassword(request) {
  const m = (request.headers.get('Authorization') || '').match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded;
  try {
    const bytes = Uint8Array.from(atob(m[1].trim()), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch (e) {
    return null;
  }
  const colon = decoded.indexOf(':'); // username can't contain ':', but the password can
  return colon === -1 ? null : decoded.slice(colon + 1);
}

// Returns a Response if the request must be stopped, or null if it may proceed.
async function checkSiteGate(request, env) {
  // trim(): a stray newline pasted into `wrangler secret put` would otherwise
  // make the real password impossible to type.
  const expected = typeof env.SITE_PASSWORD === 'string' ? env.SITE_PASSWORD.trim() : '';
  if (expected.length < MIN_SITE_PASSWORD_CHARS) {
    return new Response(
      `Site locked: SITE_PASSWORD must be set to at least ${MIN_SITE_PASSWORD_CHARS} characters.`,
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const supplied = readBasicPassword(request);
  if (supplied !== null && (await passwordMatches(supplied, expected))) return null;
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="ATG Forecast Dashboard", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async scheduled(event, env, ctx) {
    const minute = new Date(event && event.scheduledTime).getUTCMinutes(); // NaN if there is no scheduled time
    if (minute in ERCOT_JOB_GROUP_BY_MINUTE) {
      ctx.waitUntil(runErcotJob(env, { groups: [ERCOT_JOB_GROUP_BY_MINUTE[minute]] }).then((r) => console.log('ercot job:', JSON.stringify(r))));
    } else if (METIS_JOB_MINUTES.includes(minute)) {
      ctx.waitUntil(runMetisJob(env).then((r) => console.log('metis job:', JSON.stringify(r))));
    } else {
      ctx.waitUntil(pullAndStore(env));
    }
  },

  async fetch(request, env, ctx) {
    const blocked = await checkSiteGate(request, env);
    if (blocked) return blocked;

    const url = new URL(request.url);

    // Manual "pull now" trigger. Needs the site password (gate above) AND the
    // full askthegrid key in ?key=. Handy after any change to how data is
    // stored, so you don't wait for the next cron tick. (The /debug/ping and
    // /debug/keycheck routes that used to sit here were removed: keycheck
    // revealed the first and last six characters of the API key.)
    if (url.pathname === '/debug/run-pull' && url.searchParams.get('key') === env.ASKTHEGRID_API_KEY) {
      await pullAndStore(env);
      return new Response('Pull complete -- check Observability logs and /data/manifest.json', { status: 200 });
    }

    if (url.pathname === '/debug/ercot-check') {
      return handleErcotCheck(request, env);
    }
    if (url.pathname === '/debug/ercot-log') {
      return handleErcotLog(env);
    }

    // Manual runs of the two scheduled jobs. Same protection as /debug/run-pull: the site password
    // (the gate above) AND the askthegrid key in ?key=. Each run saves its progress as it goes, so if
    // one is cut short (free plan CPU limit), running it again picks up where it left off.
    if (url.pathname === '/debug/run-ercot' || url.pathname === '/debug/run-metis') {
      if (url.searchParams.get('key') !== env.ASKTHEGRID_API_KEY) return jsonResponse({ error: 'bad_key' }, 403);
      const g = url.searchParams.get('group'); // /debug/run-ercot?key=...&group=1 runs just the first group (1-3)
      const groups = g && /^[1-3]$/.test(g) ? [Number(g) - 1] : undefined;
      const result = url.pathname === '/debug/run-ercot' ? await runErcotJob(env, { groups }) : await runMetisJob(env);
      return jsonResponse(result);
    }

    if (url.pathname === '/api/chat/status') {
      return jsonResponse({ enabled: env.CHAT_ENABLED === 'true' });
    }
    if (url.pathname === '/api/chat') {
      return handleChat(request, env);
    }

    const kvKey = KV_ROUTES[url.pathname];
    if (kvKey) {
      const value = await env.FORECASTS_KV.get(kvKey);
      if (value === null) {
        return new Response(`Not found: ${kvKey}`, { status: 404 });
      }
      return new Response(value, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const nodeId = nodeIdForPath(url.pathname);
    if (nodeId) {
      const raw = await env.FORECASTS_KV.get('allLatest');
      const allLatest = raw ? JSON.parse(raw) : {};
      const nodeData = allLatest[nodeId];
      if (!nodeData) {
        return new Response(`Not found: ${nodeId}`, { status: 404 });
      }
      return new Response(JSON.stringify(nodeData), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
