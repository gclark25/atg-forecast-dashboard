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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pullAndStore(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Temporary, no-auth diagnostic: isolates "is routing even reaching
    // fetch() for /debug/*" from "is the key comparison below failing" --
    // a 404 on /debug/run-pull is consistent with EITHER, since both end
    // up falling through to the same ASSETS 404 page. Remove once resolved.
    if (url.pathname === '/debug/ping') {
      return new Response('pong', { status: 200 });
    }

    // Temporary: reveals enough about the stored secret to spot a mismatch
    // (stray whitespace, wrong key, truncation) without ever printing the
    // full value anywhere. Remove once the key issue is resolved.
    if (url.pathname === '/debug/keycheck') {
      const k = env.ASKTHEGRID_API_KEY || '';
      return new Response(JSON.stringify({
        present: !!env.ASKTHEGRID_API_KEY,
        length: k.length,
        first6: k.slice(0, 6),
        last6: k.slice(-6),
        hasLeadingWhitespace: k !== k.trimStart(),
        hasTrailingWhitespace: k !== k.trimEnd(),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Temporary manual-trigger route for debugging the cron pull directly
    // against real KV/secrets without needing wrangler dev --remote (which
    // tunnels through Cloudflare's edge and can trip loop-protection).
    // Gated behind the existing API key so it's not a public trigger.
    // Safe to remove once the schedule is confirmed working reliably.
    if (url.pathname === '/debug/run-pull' && url.searchParams.get('key') === env.ASKTHEGRID_API_KEY) {
      await pullAndStore(env);
      return new Response('Pull complete -- check Observability logs and /data/manifest.json', { status: 200 });
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