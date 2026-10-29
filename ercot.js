/**
 * ERCOT Public API client: pulls ERCOT's OWN forecasts (load, wind, solar,
 * outages, system adequacy) straight from api.ercot.com, instead of reading
 * them through Ask the Grid's mirror.
 *
 * Why direct: in a live comparison, ERCOT's API had wind and solar forecasts
 * posted 3 hours later than the mirror, and load/outage posts 1 hour later.
 *
 * What the live probe showed, and how it shapes this file:
 *  - Every ERCOT timestamp (postedDatetime, deliveryDate + hourEnding) and
 *    every date filter is Central time. Everything here is converted to UTC.
 *  - hourEnding comes as an integer (wind, solar, outage) or as "1:00" /
 *    "01:00" (load, adequacy). The repeated hour on the fall-back day is
 *    flagged as DSTFlag (load, wind, solar) or repeatHourFlag (adequacy); the
 *    outage report has no flag at all, so a repeat is inferred from the
 *    duplicate (date, hour) there.
 *  - The product-level lastPostDatetime lags the data by up to 2 hours, so
 *    freshness is measured from the rows' own postedDatetime.
 *  - These tables hold tens of millions of rows and an unbounded query can
 *    time out, so every query is bounded by postedDatetimeFrom. Two calls per
 *    report: the first finds the newest posting, the second reads only that
 *    one vintage.
 *  - ERCOT renames fields without warning. Columns are read by NAME, never by
 *    position, and a column that is missing is reported as missing. It is
 *    never turned into 0.
 *
 * Nothing in here touches KV. The caller decides what to keep.
 */

export const ERCOT_TOKEN_URL = 'https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token';
export const ERCOT_API_BASE = 'https://api.ercot.com/api/public-reports';
const CLIENT_ID = 'fec253ea-0d06-4272-a5e6-b478baeecd70'; // ERCOT's published public client id

const HOUR_MS = 3600000;
const WINDOW_PAST_HOURS = 24;   // enough history for actuals and alignment checks
const WINDOW_FUTURE_HOURS = 72; // covers Metis's 48 h horizon and the 36 h bidding window with margin

// ---------------------------------------------------------------------------
// Central-time helpers (DST-safe)
// ---------------------------------------------------------------------------
const CT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function ctWall(utcMs) {
  const p = {};
  for (const x of CT_FMT.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Minutes Central time is offset from UTC at this instant (-300 CDT, -360 CST).
export function ctOffsetMinutes(utcMs) {
  const w = ctWall(utcMs);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - (utcMs - (utcMs % 1000))) / 60000);
}

// The two offsets that matter on a calendar date: at its local midnight and at
// its local noon. They differ only on the two days a year the clocks change
// (the change happens at 02:00, between them).
const dayOffsetCache = new Map(); // a vintage has about 9 distinct dates but up to ~1,700 rows
function dayOffsets(dateStr) {
  const hit = dayOffsetCache.get(dateStr);
  if (hit) return hit;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const pick = (hh) => {
    for (const o of [-300, -360]) {
      if (ctOffsetMinutes(Date.UTC(y, mo - 1, d, hh, 0, 0) - o * 60000) === o) return o;
    }
    return -360;
  };
  const res = { y, mo, d, o0: pick(0), o1: pick(12) };
  if (dayOffsetCache.size > 500) dayOffsetCache.clear();
  dayOffsetCache.set(dateStr, res);
  return res;
}

// "1", 1, "1:00", "01:00", "24:00" -> 1..24. Anything else -> null.
export function parseHE(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v ?? '').trim().match(/^(\d{1,2})(?::\d{2})?$/);
  return m ? parseInt(m[1], 10) : null;
}

// The UTC interval an ERCOT (date, hour-ending) row covers. `repeatFlag` marks
// the second occurrence of the repeated hour on the fall-back day. Rows up to
// 02:00 use the offset in force at midnight, rows after use the offset in
// force at noon, which gives the right instant on all three kinds of day:
//   normal day, fall-back (25 hours: HE2 appears twice), spring-forward (HE3 absent).
export function heInterval(dateStr, he, repeatFlag) {
  const { y, mo, d, o0, o1 } = dayOffsets(dateStr);
  const after = !!repeatFlag || he >= 3;
  const endMs = Date.UTC(y, mo - 1, d, he, 0, 0) - (after ? o1 : o0) * 60000;
  return { startMs: endMs - HOUR_MS, endMs };
}

// 'YYYY-MM-DDTHH:MM:SS' written in Central time -> UTC ms.
export function ctLocalToMs(str) {
  const m = String(str ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  for (const o of [-300, -360]) { // ambiguous fall-back hour resolves to the first (CDT) reading
    const utc = Date.UTC(y, mo - 1, d, h, mi, s) - o * 60000;
    if (ctOffsetMinutes(utc) === o) return utc;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) + 6 * HOUR_MS;
}

// UTC ms -> 'YYYY-MM-DDTHH:MM:SS' in Central time (what ERCOT filters expect).
export function msToCtLocal(ms) {
  const w = ctWall(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${w.y}-${z(w.mo)}-${z(w.d)}T${z(w.h)}:${z(w.mi)}:${z(w.s)}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ErcotError extends Error {
  // kind: auth | blocked | rate_limited | server | timeout | network | bad_response | http
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'ErcotError';
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Auth + HTTP
// ---------------------------------------------------------------------------
let tokenCache = null; // { token, expiresMs } kept for the life of the isolate
const optionalParamOk = new Map(); // "reportId:param" -> true | false, learned at runtime

export function resetErcotCaches() {
  tokenCache = null;
  optionalParamOk.clear();
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jwtExpiryMs(token) {
  try {
    const seg = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(seg + '='.repeat((4 - (seg.length % 4)) % 4)));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

export async function getIdToken(env, f = fetch, nowMs = Date.now()) {
  if (tokenCache && tokenCache.expiresMs - 120000 > nowMs) return tokenCache.token;
  const body = new URLSearchParams({
    username: env.ERCOT_API_USERNAME, password: env.ERCOT_API_PASSWORD, grant_type: 'password',
    client_id: CLIENT_ID, scope: `openid ${CLIENT_ID} offline_access`, response_type: 'id_token',
  });
  let res;
  try {
    res = await f(ERCOT_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch (e) {
    throw new ErcotError('network', `could not reach ERCOT's token endpoint: ${e.message || e}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new ErcotError(res.status === 403 ? 'blocked' : 'auth', `ERCOT token endpoint returned HTTP ${res.status}: ${text}`, res.status);
  }
  let j;
  try { j = await res.json(); } catch (e) { throw new ErcotError('bad_response', 'ERCOT token endpoint did not return JSON'); }
  const token = j.id_token || j.access_token;
  if (!token) throw new ErcotError('bad_response', 'ERCOT token response had no id_token');
  tokenCache = { token, expiresMs: jwtExpiryMs(token) || nowMs + (Number(j.expires_in) || 3600) * 1000 };
  return token;
}

async function ercotGet(path, params, env, opt) {
  const { f, sleep, retries = 2, timeoutMs = 20000 } = opt;
  const url = `${ERCOT_API_BASE}${path}?${new URLSearchParams(params)}`;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getIdToken(env, f);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await f(url, {
        headers: { Authorization: `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': env.ERCOT_API_SUBSCRIPTION_KEY, Accept: 'application/json' },
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
      throw new ErcotError(e && e.name === 'AbortError' ? 'timeout' : 'network', `ERCOT request failed: ${e && e.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : (e.message || e)}`);
    }
    clearTimeout(timer);
    if (res.status === 200) {
      try { return await res.json(); } catch (e) { throw new ErcotError('bad_response', 'ERCOT returned a 200 that was not JSON'); }
    }
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 && !refreshed) { tokenCache = null; refreshed = true; continue; } // token may simply have expired
    if (res.status === 401) throw new ErcotError('auth', `ERCOT rejected the credentials (HTTP 401): ${text}`, 401);
    if (res.status === 403) throw new ErcotError('blocked', `ERCOT refused the request (HTTP 403), which can mean the caller's network is outside the US: ${text}`, 403);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt, 10000));
        continue;
      }
      throw new ErcotError(res.status === 429 ? 'rate_limited' : 'server', `ERCOT returned HTTP ${res.status}: ${text}`, res.status);
    }
    const err = new ErcotError('http', `ERCOT returned HTTP ${res.status}: ${text}`, res.status);
    err.body = text;
    throw err;
  }
}

// { fields: [{name}], data: [[...]] } -> { rows, names, meta } with the rows left exactly as
// ERCOT sent them (arrays, aligned to `names`). This is the cheap path the puller uses.
export function bodyToTable(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
    if (body && typeof body === 'object' && body._meta && (body._meta.totalRecords === 0 || body.data === undefined)) return { rows: [], names: [], meta: body._meta };
    throw new ErcotError('bad_response', 'ERCOT response had no data array');
  }
  const names = (body.fields || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
  if (!names.length && body.data.length && !Array.isArray(body.data[0]) && typeof body.data[0] === 'object') names.push(...Object.keys(body.data[0]));
  return { rows: body.data, names, meta: body._meta || {} };
}

// Same data as plain objects keyed by field name (convenient, but slower).
export function bodyToRows(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) {
    if (body && typeof body === 'object' && body._meta && (body._meta.totalRecords === 0 || body.data === undefined)) return { rows: [], names: [], meta: body._meta };
    throw new ErcotError('bad_response', 'ERCOT response had no data array');
  }
  const names = (body.fields || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
  const nn = names.length;
  const rows = body.data.map((r) => {
    if (!Array.isArray(r)) return r;
    const o = {};
    for (let i = 0; i < nn; i++) o[names[i]] = r[i];
    return o;
  });
  if (!names.length && rows.length && typeof rows[0] === 'object') names.push(...Object.keys(rows[0]));
  return { rows, names, meta: body._meta || {} };
}

// ---------------------------------------------------------------------------
// Report definitions: where each lives, how its rows are timed, which columns we keep
// ---------------------------------------------------------------------------
function regionColumns(regions, kinds) {
  const cols = [];
  for (const [srcRegion, outRegion] of regions) {
    for (const [srcKind, outKind] of kinds) cols.push([`${srcKind}${srcRegion}`, `${outRegion}_${outKind}`]);
  }
  return cols;
}
const WIND_KINDS = [['gen', 'actual'], ['COPHSL', 'cop_hsl'], ['STWPF', 'stwpf'], ['WGRPP', 'wgrpp']];
const SOLAR_KINDS = [['gen', 'actual'], ['COPHSL', 'cop_hsl'], ['STPPF', 'stppf'], ['PVGRPP', 'pvgrpp']];
const WIND_REGIONS = [['SystemWide', 'system'], ['Panhandle', 'panhandle'], ['Coastal', 'coastal'], ['South', 'south'], ['West', 'west'], ['North', 'north']];
const SOLAR_REGIONS = [['SystemWide', 'system'], ['CenterWest', 'center_west'], ['NorthWest', 'north_west'], ['FarWest', 'far_west'], ['FarEast', 'far_east'], ['SouthEast', 'south_east'], ['CenterEast', 'center_east']];
const SYSTEM_ONLY = [['SystemWide', 'system']];
const OUTAGE_ZONES = [['South', 'south'], ['North', 'north'], ['West', 'west'], ['Houston', 'houston']];

const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|t|y|yes|1)$/i.test(v.trim()));

function sumZones(values, prefix) {
  let total = 0;
  for (const [, z] of OUTAGE_ZONES) {
    const v = values[`${prefix}_${z}`];
    if (v === null || v === undefined) return null; // never sum a partial set into a misleading total
    total += v;
  }
  return total;
}

export const REPORTS = {
  load: {
    source: 'NP3-565-CD', path: '/np3-565-cd/lf_by_model_weather_zone', what: 'seven-day load forecast by weather zone',
    dateField: 'deliveryDate', heField: 'hourEnding', flagFields: ['DSTFlag'],
    filterField: 'inUseFlag', // keep only the model ERCOT actually uses
    optionalParam: ['inUseFlag', 'true'],   // asks ERCOT for just that model; dropped automatically if unsupported
    columns: [['systemTotal', 'system'], ['coast', 'coast'], ['east', 'east'], ['farWest', 'far_west'], ['north', 'north'],
      ['northCentral', 'north_central'], ['southCentral', 'south_central'], ['southern', 'southern'], ['west', 'west']],
  },
  wind: {
    source: 'NP4-742-CD', path: '/np4-742-cd/wpp_hrly_actual_fcast_geo', what: 'wind actual + forecasts by region',
    dateField: 'deliveryDate', heField: 'hourEnding', flagFields: ['DSTFlag'],
    columns: [...regionColumns(WIND_REGIONS, WIND_KINDS), ['HSLSystemWide', 'system_hsl']],
  },
  wind_system: {
    source: 'NP4-732-CD', path: '/np4-732-cd/wpp_hrly_avrg_actl_fcast', what: 'wind actual + forecasts, system-wide',
    dateField: 'deliveryDate', heField: 'hourEnding', flagFields: ['DSTFlag'],
    columns: [...regionColumns(SYSTEM_ONLY, WIND_KINDS), ['HSLSystemWide', 'system_hsl']],
  },
  solar: {
    source: 'NP4-745-CD', path: '/np4-745-cd/spp_hrly_actual_fcast_geo', what: 'solar actual + forecasts by region',
    dateField: 'deliveryDate', heField: 'hourEnding', flagFields: ['DSTFlag'],
    columns: [...regionColumns(SOLAR_REGIONS, SOLAR_KINDS), ['HSLSystemWide', 'system_hsl']],
  },
  solar_system: {
    source: 'NP4-737-CD', path: '/np4-737-cd/spp_hrly_avrg_actl_fcast', what: 'solar actual + forecasts, system-wide',
    dateField: 'deliveryDate', heField: 'hourEnding', flagFields: ['DSTFlag'],
    columns: [...regionColumns(SYSTEM_ONLY, SOLAR_KINDS), ['HSLSystemWide', 'system_hsl']],
  },
  outage: {
    source: 'NP3-233-CD', path: '/np3-233-cd/hourly_res_outage_cap', what: 'resource outage capacity by load zone (168 h)',
    dateField: 'operatingDate', heField: 'hourEnding', flagFields: [], inferRepeat: true, // this report has no DST flag column
    columns: [
      ...OUTAGE_ZONES.map(([s, o]) => [`totalResourceMWZone${s}`, `resource_${o}`]),
      ...OUTAGE_ZONES.map(([s, o]) => [`totalIRRMWZone${s}`, `irr_${o}`]),
      ...OUTAGE_ZONES.map(([s, o]) => [`totalNewEquipResourceMWZone${s}`, `new_equip_${o}`]),
    ],
    post: (v) => { v.resource_system = sumZones(v, 'resource'); v.irr_system = sumZones(v, 'irr'); v.new_equip_system = sumZones(v, 'new_equip'); },
  },
  adequacy: {
    source: 'NP3-763-CD', path: '/np3-763-cd/st_sys_adequacy', what: 'short-term system adequacy (hourly capacity outlook)',
    dateField: 'deliveryDate', heField: 'hourEnding', flagFields: ['repeatHourFlag'],
    columns: [
      ['availCapGen', 'avail_cap_gen'], ['availCapRes', 'avail_cap_res'], ['capGenRes', 'cap_gen_res'], ['capLoadRes', 'cap_load_res'],
      ['offAvailMW', 'off_avail_mw'], ['capREGUP', 'cap_regup'], ['capREGDN', 'cap_regdn'], ['capRRS', 'cap_rrs'],
      ['capECRS', 'cap_ecrs'], ['capNSPIN', 'cap_nspin'],
      ...OUTAGE_ZONES.map(([s, o]) => [`capGenRes${s}`, `cap_gen_res_${o}`]),
      ...OUTAGE_ZONES.map(([s, o]) => [`capLoadRes${s}`, `cap_load_res_${o}`]),
      ...OUTAGE_ZONES.map(([s, o]) => [`offAvailMW${s}`, `off_avail_mw_${o}`]),
    ],
  },
};

// ---------------------------------------------------------------------------
// Turning one vintage's rows into UTC intervals
// ---------------------------------------------------------------------------
const toNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

// `window` = { fromDate, toDate } (inclusive, 'YYYY-MM-DD' in Central). Rows outside it are skipped
// before any real work is done on them; the tab only needs about a day back and three days ahead, and
// ERCOT's vintage runs a week. Rows may be arrays (aligned to `names`) or objects keyed by name.
export function normalizeRows(spec, rows, names, window = null) {
  const arrays = rows.length > 0 && Array.isArray(rows[0]);
  const idx = {};
  names.forEach((n, i) => { idx[n] = i; });
  const have = new Set(names);
  const missing = spec.columns.map(([src]) => src).filter((src) => !have.has(src));
  const key = (name) => (arrays ? idx[name] : name);
  const dateK = key(spec.dateField);
  const heK = key(spec.heField);
  const flagKs = spec.flagFields.map(key);
  const filterK = spec.filterField ? key(spec.filterField) : null;
  const cols = spec.columns.map(([src, out]) => [arrays ? idx[src] : src, out, have.has(src)]);
  const byStart = new Map();
  const seenDateHe = new Set();
  const dateCounts = {}; // rows ERCOT sent per date, whole vintage (a 25-row day is the fall-back day)
  let firstDate = null, firstHe = null, lastDate = null, lastHe = null;
  let dropped = 0;
  let duplicates = 0;
  let outside = 0;
  for (const r of rows) {
    if (filterK !== null && !truthy(r[filterK])) continue;
    const date = String(r[dateK] ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dateCounts[date] = (dateCounts[date] || 0) + 1;
    if (firstDate === null) { firstDate = date; firstHe = r[heK]; }
    lastDate = date; lastHe = r[heK];
    if (window && /^\d{4}-\d{2}-\d{2}$/.test(date) && (date < window.fromDate || date > window.toDate)) { outside++; continue; }
    const he = parseHE(r[heK]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || he === null || he < 1 || he > 24) { dropped++; continue; }
    let flag = false;
    for (const fk of flagKs) if (truthy(r[fk])) { flag = true; break; }
    if (spec.inferRepeat) {
      const k = `${date}|${he}`;
      if (seenDateHe.has(k) && !flag) flag = true; // a second (date, hour) in one vintage is the repeated hour
      seenDateHe.add(k);
    }
    const { startMs, endMs } = heInterval(date, he, flag);
    if (byStart.has(startMs)) { duplicates++; continue; }
    const v = {};
    for (const [k, out, present] of cols) v[out] = present ? toNumber(r[k]) : null; // null stays null; nothing becomes 0
    if (spec.post) spec.post(v);
    byStart.set(startMs, { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), v });
  }
  const intervals = [...byStart.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  return { intervals, missing, dropped, duplicates, outside, dateCounts, firstRaw: firstDate === null ? null : { date: firstDate, he: firstHe }, lastRaw: lastDate === null ? null : { date: lastDate, he: lastHe } };
}

// ---------------------------------------------------------------------------
// One report: find the newest posting, then read only that vintage
// ---------------------------------------------------------------------------
export async function pullReport(id, env, opts = {}) {
  const spec = REPORTS[id];
  const nowMs = opts.nowMs ?? Date.now();
  const o = { f: opts.f || fetch, sleep: opts.sleep || realSleep, retries: opts.retries, timeoutMs: opts.timeoutMs };
  const started = Date.now();
  let requests = 0;
  const get = async (params) => { requests++; return bodyToTable(await ercotGet(spec.path, params, env, o)); };
  try {
    // 1. newest posting, searching back 6 h and, failing that, 72 h
    let newest = null;
    for (const hours of [6, 72]) {
      const first = await get({ postedDatetimeFrom: msToCtLocal(nowMs - hours * HOUR_MS), size: '1' });
      if (first.rows.length) {
        const p = first.rows[0];
        newest = String(Array.isArray(p) ? p[first.names.indexOf('postedDatetime')] : p.postedDatetime);
        break;
      }
    }
    if (!newest) {
      return { id, source: spec.source, ok: true, empty: true, requests, ms: Date.now() - started, intervals: [], missing_fields: [], note: 'no postings in the last 72 hours' };
    }
    // 2. that vintage only. An optional server-side filter is tried first and dropped if ERCOT rejects it or returns nothing.
    const main = { postedDatetimeFrom: newest, size: '20000' };
    let page = null;
    const opt = spec.optionalParam;
    const optKey = opt ? `${id}:${opt[0]}` : null;
    if (opt && optionalParamOk.get(optKey) !== false) {
      try {
        const attempt = await get({ ...main, [opt[0]]: opt[1] });
        if (attempt.rows.length) { page = attempt; optionalParamOk.set(optKey, true); } else optionalParamOk.set(optKey, false);
      } catch (e) {
        if (e.kind === 'http' && e.status === 400) optionalParamOk.set(optKey, false); else throw e;
      }
    }
    if (!page) page = await get(main);
    let rows = page.rows;
    const names = page.names;
    for (let p = 2; p <= Math.min(Number(page.meta.totalPages) || 1, 4); p++) {
      await o.sleep(250);
      const more = await get({ ...main, ...(optionalParamOk.get(optKey) ? { [opt[0]]: opt[1] } : {}), page: String(p) });
      rows = rows.concat(more.rows);
    }
    // A newer vintage may have landed between the two calls; keep the newest posting only.
    const pIdx = names.indexOf('postedDatetime');
    const posted = (r) => (Array.isArray(r) ? r[pIdx] : r.postedDatetime);
    let newestStr = newest;
    for (const r of rows) { const p = posted(r); if (typeof p === 'string' && p > newestStr) newestStr = p; }
    const vintage = rows.filter((r) => posted(r) === newestStr);
    const win = opts.window || {};
    const window = {
      fromDate: msToCtLocal(nowMs - (win.pastHours ?? WINDOW_PAST_HOURS) * HOUR_MS).slice(0, 10),
      toDate: msToCtLocal(nowMs + (win.futureHours ?? WINDOW_FUTURE_HOURS) * HOUR_MS).slice(0, 10),
    };
    const norm = normalizeRows(spec, vintage, names, window);
    const postedMs = ctLocalToMs(newestStr);
    return {
      id, source: spec.source, ok: true, requests, ms: Date.now() - started,
      posted_ct: newestStr, posted_utc: postedMs === null ? null : new Date(postedMs).toISOString(),
      age_min: postedMs === null ? null : Math.round((nowMs - postedMs) / 60000),
      rows_in_vintage: vintage.length, rows_outside_window: norm.outside, window, intervals: norm.intervals,
      date_counts: norm.dateCounts, first_raw: norm.firstRaw, last_raw: norm.lastRaw,
      missing_fields: norm.missing, dropped_rows: norm.dropped, duplicate_intervals: norm.duplicates,
      server_side_filter: opt ? (optionalParamOk.get(optKey) ? 'used' : 'not available') : null,
    };
  } catch (e) {
    return { id, source: spec.source, ok: false, requests, ms: Date.now() - started, error: { kind: e.kind || 'unexpected', status: e.status ?? null, message: String(e.message || e).slice(0, 300) } };
  }
}

// All reports, one after another so ERCOT's 30-requests-a-minute limit is never in play.
export async function pullAll(env, opts = {}) {
  const sleep = opts.sleep || realSleep;
  const ids = opts.ids || Object.keys(REPORTS);
  const out = {};
  for (let i = 0; i < ids.length; i++) {
    if (i) await sleep(300);
    out[ids[i]] = await pullReport(ids[i], env, opts);
    if (!out[ids[i]].ok && ['auth', 'blocked'].includes(out[ids[i]].error.kind)) { // no point asking six more times
      for (const rest of ids.slice(i + 1)) out[rest] = { id: rest, source: REPORTS[rest].source, ok: false, skipped: true, error: out[ids[i]].error };
      break;
    }
  }
  return out;
}

// Hours missing (or overlapping) between consecutive intervals. A healthy hourly series has none.
export function findGaps(intervals, max = 5) {
  const gaps = [];
  for (let i = 1; i < intervals.length; i++) {
    const d = Date.parse(intervals[i].start) - Date.parse(intervals[i - 1].end);
    if (d !== 0) {
      gaps.push({ after: intervals[i - 1].end, resumes_at: intervals[i].start, hours: d / HOUR_MS });
      if (gaps.length >= max) break;
    }
  }
  return gaps;
}

// A compact, credential-free summary of a pull, for the check route.
export function summarize(result) {
  if (!result.ok) return { ok: false, skipped: result.skipped || false, requests: result.requests, error: result.error };
  const iv = result.intervals;
  const first = iv[0];
  return {
    ok: true, source: result.source, requests: result.requests, ms: result.ms, empty: result.empty || false,
    posted_ct: result.posted_ct, posted_utc: result.posted_utc, age_min: result.age_min,
    rows_in_vintage: result.rows_in_vintage, intervals: iv.length,
    first_start_utc: first ? first.start : null, last_start_utc: iv.length ? iv[iv.length - 1].start : null,
    missing_fields: result.missing_fields, dropped_rows: result.dropped_rows, duplicate_intervals: result.duplicate_intervals,
    server_side_filter: result.server_side_filter,
    gaps: findGaps(iv),
    date_counts: result.date_counts && Object.keys(result.date_counts).length <= 14 ? result.date_counts : undefined,
    first_raw: result.first_raw, last_raw: result.last_raw,
    sample: first ? { start: first.start, values: Object.fromEntries(Object.entries(first.v).slice(0, 8)) } : null,
  };
}
