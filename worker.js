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

function selectMetisSeries(raw) {
  const series = raw.series || [];
  for (const s of series) {
    const src = s.source || {};
    const name = ['id', 'shortName', 'displayName', 'modelId'].map((k) => String(src[k] || '')).join(' ').toLowerCase();
    if (name.includes(SOURCE_MATCH)) return s;
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
  return {
    display_name: src.displayName ?? null,
    model_id: src.modelId ?? null,
    horizon_hours: src.horizonHours ?? null,
    issue_cadence_minutes: src.issueCadenceMinutes ?? null,
    resolution_minutes: src.resolutionMinutes ?? null,
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

  console.log('pullAndStore: writing allLatest + manifest + run_status, node results:', manifest.map(m => `${m.node_id}:${m.rows_pulled}${m.error ? '(' + m.error + ')' : ''}`).join(', '));
  await env.FORECASTS_KV.put('allLatest', JSON.stringify(allLatest));
  await env.FORECASTS_KV.put('manifest', JSON.stringify(manifest));
  await env.FORECASTS_KV.put('run_status', JSON.stringify({ generated_at: new Date().toISOString() }));
  console.log('pullAndStore: done');
}

const KV_ROUTES = {
  '/data/manifest.json': 'manifest',
  '/data/run_status.json': 'run_status',
};

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
    ctx.waitUntil(pullAndStore(env));
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