/**
 * Hourly snapshot history: has Metis been closer than ERCOT, and what is each series' usual gap?
 *
 * Every hour two things are saved, then paired:
 *   - Metis's forecast, as issued at hour T (47 hourly points, the first for T+1h), the median and the
 *     p10 to p90 band, for each of the six system series.
 *   - ERCOT's forecast for the same hours AS IT STOOD WHEN METIS WAS ISSUED ("as of" T). It is captured
 *     a few minutes after T, from the latest posting of each report, which is the posting a forecaster
 *     issuing at T would have had. A capture taken more than FAIR_MS after T is never used for a
 *     comparison, because it would give ERCOT newer information than Metis had.
 *
 * From the pairs it keeps two small running summaries, in daily buckets so old days fall away:
 *   - gap:   Metis median minus ERCOT's forecast, by lead (hours ahead): count, sum, sum of squares.
 *   - score: once an hour's actual value is known, the error of each forecast made for it at every
 *            lead from 1 to 47 hours ahead: count, sum |error|, sum error, sum error^2, and how often
 *            the actual fell inside Metis's p10 to p90 band.
 *
 * It runs against any SQLite with the Durable Object `sql.exec(query, ...params)` shape (tests use
 * node:sqlite). Nothing here talks to the network, and a failure here must never affect the data jobs.
 */

export const HOUR = 3600000;
export const LEADS = 47;
export const FAIR_MS = 25 * 60000;          // an "as of" capture later than this after the issue time is not comparable
export const KEEP_DAYS = 35;                // raw snapshots, actuals
export const AGG_DAYS = 28;                 // how many daily buckets the summary adds up
export const KEEP_AGG_DAYS = 60;            // daily buckets
export const SCORE_HOURS_PER_TICK = 12;     // actual hours scored per run, so a backlog clears over several runs
export const ACTUAL_LOOKBACK_H = 72;
export const BUCKETS = [[1, 3], [4, 6], [7, 12], [13, 24], [25, 47]];
export const MODELS = ['metis', 'ercot'];

const ZONES = ['south', 'north', 'west', 'houston'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// the report that carries a figure; of two reports with the same figure, the later posting
function pickNewest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(b.posted_utc) > Date.parse(a.posted_utc) ? b : a;
}
// value of a stored report column at an hour start (UTC ms)
function indexed(rep) {
  const m = new Map();
  if (rep && Array.isArray(rep.start)) rep.start.forEach((t, i) => m.set(t, i));
  return m;
}
function column(rep, key) {
  if (!rep || !rep.cols || !Array.isArray(rep.cols[key])) return null;
  const idx = indexed(rep), col = rep.cols[key];
  return (t) => { const i = idx.get(t); const v = i === undefined ? null : col[i]; return isNum(v) ? v : null; };
}
const postedMs = (rep) => (rep && rep.posted_utc ? Date.parse(rep.posted_utc) : null);

// ---------------------------------------------------------------------------
// The six series: where Metis's side lives, where ERCOT's comes from, and (where one exists) what actually happened
// ---------------------------------------------------------------------------
export const SERIES = {
  load: {
    label: 'Load', mseries: 'load:system', scored: true,
    ercot: (R) => { const f = column(R.load, 'system'); return f && { value: f, posted_ms: postedMs(R.load) }; },
    actual: (R) => { const f = R.load_actual && column(R.load_actual, 'total'); return f ? { rep: R.load_actual, key: 'total' } : null; },
  },
  wind: {
    label: 'Wind', mseries: 'wind:system', scored: true,
    ercot: (R) => { const rep = pickNewest(R.wind_system, R.wind), f = column(rep, 'system_stwpf'); return f && { value: f, posted_ms: postedMs(rep) }; },
    actual: (R) => { const rep = pickNewest(R.wind_system, R.wind); return rep && rep.cols && rep.cols.system_actual ? { rep, key: 'system_actual' } : null; },
  },
  solar: {
    label: 'Solar', mseries: 'solar:system', scored: true,
    ercot: (R) => { const rep = pickNewest(R.solar_system, R.solar), f = column(rep, 'system_stppf'); return f && { value: f, posted_ms: postedMs(rep) }; },
    actual: (R) => { const rep = pickNewest(R.solar_system, R.solar); return rep && rep.cols && rep.cols.system_actual ? { rep, key: 'system_actual' } : null; },
  },
  outage: {
    label: 'Outages', mseries: 'outage:system',
    ercot: (R) => { const f = column(R.outage, 'resource_system'); return f && { value: f, posted_ms: postedMs(R.outage) }; },
    actual: () => null,
  },
  avail_zones: {
    label: 'Capacity (CapGenRes zone sum)', mseries: 'avail_cap:system',
    ercot: (R) => {
      const fs = ZONES.map((z) => column(R.adequacy, 'cap_gen_res_' + z));
      if (fs.some((f) => !f)) return null;
      return { value: (t) => { let s = 0; for (const f of fs) { const v = f(t); if (v === null) return null; s += v; } return s; }, posted_ms: postedMs(R.adequacy) };
    },
    actual: () => null,
  },
  avail_gen: {
    label: 'Capacity (availCapGen)', mseries: 'avail_cap:system',
    ercot: (R) => { const f = column(R.adequacy, 'avail_cap_gen'); return f && { value: f, posted_ms: postedMs(R.adequacy) }; },
    actual: () => null,
  },
};

const zeros = () => Array(LEADS).fill(0);
const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch { return null; } };

export class History {
  /** sql: { exec(query, ...params) -> { toArray() } }; tx: runs a function atomically (default: just runs it) */
  constructor(sql, tx) { this.sql = sql; this.tx = tx || ((fn) => fn()); }
  all(query, ...p) { return this.sql.exec(query, ...p).toArray(); }
  run(query, ...p) { this.sql.exec(query, ...p).toArray(); }

  migrate() {
    const t = [
      'CREATE TABLE IF NOT EXISTS metis_snap (issued_ms INTEGER NOT NULL, mseries TEXT NOT NULL, p10 TEXT, p50 TEXT, p90 TEXT, taken_ms INTEGER NOT NULL, PRIMARY KEY (issued_ms, mseries))',
      'CREATE TABLE IF NOT EXISTS ercot_asof (asof_ms INTEGER NOT NULL, series TEXT NOT NULL, vals TEXT, posted_ms INTEGER, taken_ms INTEGER NOT NULL, PRIMARY KEY (asof_ms, series))',
      'CREATE TABLE IF NOT EXISTS actual (series TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL, PRIMARY KEY (series, t))',
      'DROP TABLE IF EXISTS scored',   // the first version marked hours with no pairs as scored; replaced by hour_scored
      'CREATE TABLE IF NOT EXISTS hour_scored (series TEXT NOT NULL, t INTEGER NOT NULL, pairs INTEGER NOT NULL, PRIMARY KEY (series, t))',
      'CREATE TABLE IF NOT EXISTS gap_day (day TEXT NOT NULL, series TEXT NOT NULL, n TEXT, s TEXT, ss TEXT, PRIMARY KEY (day, series))',
      'CREATE TABLE IF NOT EXISTS score_day (day TEXT NOT NULL, series TEXT NOT NULL, model TEXT NOT NULL, n TEXT, sabs TEXT, serr TEXT, ssq TEXT, cov TEXT, PRIMARY KEY (day, series, model))',
      'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
    ];
    for (const q of t) this.run(q);
  }

  // ---- ERCOT, as of the hour Metis was issued ----
  recordAsof(nowMs, ercot) {
    const T = Math.floor(nowMs / HOUR) * HOUR;
    const R = (ercot && ercot.reports) || {};
    const out = { asof_ms: T, captured: [], actuals: 0 };
    this.tx(() => {
      for (const [name, def] of Object.entries(SERIES)) {
        const src = def.ercot(R);
        if (src) {
          const vals = [];
          let any = false;
          for (let i = 1; i <= LEADS; i++) { const v = src.value(T + i * HOUR); vals.push(v); if (v !== null) any = true; }
          if (any) {
            // the first capture in an hour is the one that counts: a later one would be newer than Metis's information
            const before = this.all('SELECT 1 AS x FROM ercot_asof WHERE asof_ms = ? AND series = ?', T, name).length;
            this.run('INSERT OR IGNORE INTO ercot_asof (asof_ms, series, vals, posted_ms, taken_ms) VALUES (?, ?, ?, ?, ?)', T, name, JSON.stringify(vals), src.posted_ms, nowMs);
            if (!before) out.captured.push(name);
          }
        }
        const act = def.actual(R);
        if (act) {
          const col = act.rep.cols[act.key];
          act.rep.start.forEach((t, i) => {
            const v = col[i];
            // only whole hours that are over, and not further back than we keep
            if (isNum(v) && t + HOUR <= nowMs && t >= nowMs - ACTUAL_LOOKBACK_H * HOUR) {
              this.run('INSERT OR REPLACE INTO actual (series, t, v) VALUES (?, ?, ?)', name, t, v);
              out.actuals++;
            }
          });
        }
      }
    });
    return out;
  }

  // ---- Metis, as issued at T ----
  recordMetis(nowMs, metis) {
    if (!metis || !metis.issued_at || !metis.series) return { skipped: 'no_metis_data' };
    if (metis.complete === false) return { skipped: 'incomplete' };
    const T = Date.parse(metis.issued_at);
    if (!Number.isFinite(T)) return { skipped: 'bad_issue_time' };
    if (this.all('SELECT 1 AS x FROM metis_snap WHERE issued_ms = ? LIMIT 1', T).length) return { skipped: 'already_stored', issued_ms: T };
    const out = { issued_ms: T, stored: [], paired: [] };
    this.tx(() => {
      const seen = new Set();
      for (const def of Object.values(SERIES)) {
        const key = def.mseries;
        if (seen.has(key)) continue;
        seen.add(key);
        const ser = metis.series[key];
        if (!ser || !Array.isArray(ser.start) || !ser.q || !ser.q.p50) continue;
        const idx = indexed(ser);
        const aligned = (lvl) => {
          const col = ser.q[lvl];
          const a = [];
          for (let i = 1; i <= LEADS; i++) { const j = idx.get(T + i * HOUR); const v = j === undefined || !col ? null : col[j]; a.push(isNum(v) ? v : null); }
          return a;
        };
        const p50 = aligned('p50');
        if (p50.every((v) => v === null)) continue;
        this.run('INSERT OR IGNORE INTO metis_snap (issued_ms, mseries, p10, p50, p90, taken_ms) VALUES (?, ?, ?, ?, ?, ?)', T, key, JSON.stringify(aligned('p10')), JSON.stringify(p50), JSON.stringify(aligned('p90')), nowMs);
        out.stored.push(key);
      }
      // the usual gap, from the pairs that are fair
      for (const [name, def] of Object.entries(SERIES)) {
        const m = this.all('SELECT p50 FROM metis_snap WHERE issued_ms = ? AND mseries = ?', T, def.mseries)[0];
        const e = this.all('SELECT vals, taken_ms FROM ercot_asof WHERE asof_ms = ? AND series = ?', T, name)[0];
        if (!m || !e || e.taken_ms - T > FAIR_MS || e.taken_ms < T) continue;
        const mp = parse(m.p50), ev = parse(e.vals);
        if (!mp || !ev) continue;
        const n = zeros(), s = zeros(), ss = zeros();
        for (let i = 0; i < LEADS; i++) {
          if (isNum(mp[i]) && isNum(ev[i])) { const g = mp[i] - ev[i]; n[i] = 1; s[i] = g; ss[i] = g * g; }
        }
        this.bump('gap_day', [dayOf(T), name], { n, s, ss });
        out.paired.push(name);
      }
    });
    return out;
  }

  // adds arrays into a daily bucket (creating it if needed)
  bump(table, key, add) {
    const cols = Object.keys(add);
    const where = table === 'gap_day' ? 'day = ? AND series = ?' : 'day = ? AND series = ? AND model = ?';
    const row = this.all(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${where}`, ...key)[0];
    const merged = {};
    for (const c of cols) {
      const cur = row ? parse(row[c]) : null;
      merged[c] = add[c].map((v, i) => (cur && isNum(cur[i]) ? cur[i] : 0) + v);
    }
    if (table === 'gap_day') {
      this.run('INSERT OR REPLACE INTO gap_day (day, series, n, s, ss) VALUES (?, ?, ?, ?, ?)', key[0], key[1], JSON.stringify(merged.n), JSON.stringify(merged.s), JSON.stringify(merged.ss));
    } else {
      this.run('INSERT OR REPLACE INTO score_day (day, series, model, n, sabs, serr, ssq, cov) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', key[0], key[1], key[2],
        JSON.stringify(merged.n), JSON.stringify(merged.sabs), JSON.stringify(merged.serr), JSON.stringify(merged.ssq), JSON.stringify(merged.cov));
    }
  }

  // ---- score both forecasts against actual hours not yet scored ----
  score() {
    const out = { scored: {}, counted: {}, pairs: 0 };
    for (const [name, def] of Object.entries(SERIES)) {
      if (!def.scored) continue;
      const todo = this.all(
        'SELECT a.t AS t, a.v AS v FROM actual a LEFT JOIN hour_scored s ON s.series = a.series AND s.t = a.t WHERE a.series = ? AND s.t IS NULL ORDER BY a.t LIMIT ?',
        name, SCORE_HOURS_PER_TICK);
      if (!todo.length) continue;
      const lo = todo[0].t - LEADS * HOUR, hi = todo[todo.length - 1].t - HOUR;
      const metisRows = new Map(this.all('SELECT issued_ms, p10, p50, p90 FROM metis_snap WHERE mseries = ? AND issued_ms BETWEEN ? AND ?', def.mseries, lo, hi)
        .map((r) => [r.issued_ms, { p10: parse(r.p10), p50: parse(r.p50), p90: parse(r.p90) }]));
      const ercotRows = new Map(this.all('SELECT asof_ms, vals, taken_ms FROM ercot_asof WHERE series = ? AND asof_ms BETWEEN ? AND ?', name, lo, hi)
        .map((r) => [r.asof_ms, { vals: parse(r.vals), taken_ms: r.taken_ms }]));
      let counted = 0;       // hours that had at least one forecast pair
      this.tx(() => {
        const buckets = new Map(); // day -> model -> arrays
        const arrs = (day, model) => {
          const k = day + '|' + model;
          if (!buckets.has(k)) buckets.set(k, { day, model, n: zeros(), sabs: zeros(), serr: zeros(), ssq: zeros(), cov: zeros() });
          return buckets.get(k);
        };
        for (const { t, v } of todo) {
          let hourPairs = 0;
          for (let L = 1; L <= LEADS; L++) {
            const T = t - L * HOUR, m = metisRows.get(T), e = ercotRows.get(T);
            if (!m || !e || !m.p50 || !e.vals || e.taken_ms - T > FAIR_MS || e.taken_ms < T) continue;
            const mp = m.p50[L - 1], ep = e.vals[L - 1];
            if (!isNum(mp) || !isNum(ep)) continue;
            const day = dayOf(t), i = L - 1, em = mp - v, ee = ep - v;
            const a = arrs(day, 'metis'), b = arrs(day, 'ercot');
            a.n[i] += 1; a.sabs[i] += Math.abs(em); a.serr[i] += em; a.ssq[i] += em * em;
            if (isNum(m.p10 && m.p10[i]) && isNum(m.p90 && m.p90[i]) && v >= m.p10[i] && v <= m.p90[i]) a.cov[i] += 1;
            b.n[i] += 1; b.sabs[i] += Math.abs(ee); b.serr[i] += ee; b.ssq[i] += ee * ee;
            out.pairs++; hourPairs++;
          }
          // An hour with no pair at all (it predates the first snapshot) is passed over so it cannot block newer hours,
          // but it is recorded with 0 pairs and never counted as scored.
          this.run('INSERT OR IGNORE INTO hour_scored (series, t, pairs) VALUES (?, ?, ?)', name, t, hourPairs);
          if (hourPairs > 0) counted++;
        }
        for (const b of buckets.values()) this.bump('score_day', [b.day, name, b.model], { n: b.n, sabs: b.sabs, serr: b.serr, ssq: b.ssq, cov: b.cov });
      });
      out.scored[name] = todo.length;
      out.counted[name] = counted;
    }
    return out;
  }

  // ---- housekeeping, once a day ----
  maintain(nowMs) {
    const today = dayOf(nowMs);
    const done = this.all("SELECT v FROM meta WHERE k = 'cleaned_day'")[0];
    if (done && done.v === today) return { cleaned: false };
    const cut = nowMs - KEEP_DAYS * 24 * HOUR;
    this.tx(() => {
      this.run('DELETE FROM metis_snap WHERE issued_ms < ?', cut);
      this.run('DELETE FROM ercot_asof WHERE asof_ms < ?', cut);
      this.run('DELETE FROM actual WHERE t < ?', cut);
      this.run('DELETE FROM hour_scored WHERE t < ?', cut);
      this.run('DELETE FROM gap_day WHERE day < ?', dayOf(nowMs - KEEP_AGG_DAYS * 24 * HOUR));
      this.run('DELETE FROM score_day WHERE day < ?', dayOf(nowMs - KEEP_AGG_DAYS * 24 * HOUR));
      this.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('cleaned_day', ?)", today);
    });
    return { cleaned: true };
  }

  // ---- what the page reads ----
  summary(nowMs) {
    const since = dayOf(nowMs - AGG_DAYS * 24 * HOUR);
    const sum = (rows, cols) => {
      const acc = {};
      for (const r of rows) {
        for (const c of cols) {
          const a = parse(r[c]) || [];
          acc[c] = acc[c] || zeros();
          for (let i = 0; i < LEADS; i++) if (isNum(a[i])) acc[c][i] += a[i];
        }
      }
      return acc;
    };
    const within = (arr, lo, hi) => { let t = 0; for (let L = lo; L <= hi; L++) t += arr[L - 1]; return t; };
    const count = (q, ...p) => { const r = this.all(q, ...p)[0]; return r ? Object.values(r)[0] : 0; };
    const snaps = this.all('SELECT COUNT(*) AS n, MIN(issued_ms) AS first, MAX(issued_ms) AS last FROM metis_snap WHERE mseries = ?', 'load:system')[0] || {};
    const scoredHours = Object.fromEntries(this.all('SELECT series, COUNT(*) AS n FROM hour_scored WHERE pairs > 0 GROUP BY series').map((r) => [r.series, r.n]));
    const result = {
      generated_at: new Date(nowMs).toISOString(), window_days: AGG_DAYS, leads: LEADS, buckets: BUCKETS,
      snapshots: { metis: snaps.n || 0, first_issued_at: snaps.first ? new Date(snaps.first).toISOString() : null, last_issued_at: snaps.last ? new Date(snaps.last).toISOString() : null,
        ercot_asof: count('SELECT COUNT(DISTINCT asof_ms) AS n FROM ercot_asof') },
      series: {},
    };
    for (const [name, def] of Object.entries(SERIES)) {
      const g = sum(this.all('SELECT n, s, ss FROM gap_day WHERE series = ? AND day >= ?', name, since), ['n', 's', 'ss']);
      const gapRows = [];
      let gapBuckets = null;
      if (g.n) {
        gapBuckets = BUCKETS.map(([lo, hi]) => {
          const n = within(g.n, lo, hi), s = within(g.s, lo, hi), ss = within(g.ss, lo, hi);
          const mean = n ? s / n : null, sd = n > 1 ? Math.sqrt(Math.max(0, (ss - (s * s) / n) / (n - 1))) : null;
          return { lo, hi, n, mean: round1(mean), sd: round1(sd) };
        });
        for (let i = 0; i < LEADS; i++) {
          const n = g.n[i], mean = n ? g.s[i] / n : null, sd = n > 1 ? Math.sqrt(Math.max(0, (g.ss[i] - (g.s[i] * g.s[i]) / n) / (n - 1))) : null;
          gapRows.push({ lead: i + 1, n, mean: round1(mean), sd: round1(sd) });
        }
      }
      let score = null;
      if (def.scored) {
        const rows = this.all('SELECT model, n, sabs, serr, ssq, cov FROM score_day WHERE series = ? AND day >= ?', name, since);
        const byModel = Object.fromEntries(MODELS.map((m) => [m, sum(rows.filter((r) => r.model === m), ['n', 'sabs', 'serr', 'ssq', 'cov'])]));
        const have = byModel.metis.n && byModel.metis.n.some((v) => v > 0);
        score = {
          hours_scored: scoredHours[name] || 0,
          buckets: have ? BUCKETS.map(([lo, hi]) => {
            const stats = (m) => {
              const a = byModel[m], n = within(a.n, lo, hi);
              if (!n) return null;
              const o = { mae: round1(within(a.sabs, lo, hi) / n), bias: round1(within(a.serr, lo, hi) / n), rmse: round1(Math.sqrt(within(a.ssq, lo, hi) / n)) };
              if (m === 'metis') o.cover = Math.round((within(a.cov, lo, hi) / n) * 1000) / 1000;
              return o;
            };
            return { lo, hi, n: within(byModel.metis.n, lo, hi), metis: stats('metis'), ercot: stats('ercot') };
          }) : [],
        };
      }
      result.series[name] = { label: def.label, has_actuals: !!def.scored, gap: gapBuckets ? { buckets: gapBuckets, leads: gapRows } : null, score };
    }
    return result;
  }
}

// One run of the history job. `phase`: 'asof' (capture ERCOT as of this hour, take in new actuals, score),
// 'metis' (store a newly issued Metis forecast and pair it), or 'all'. Reading the stored states is the caller's job
// (`readState(key)`), so this works the same in the Durable Object and in tests. Never throws.
export async function runHistory(history, readState, nowMs, phase = 'all') {
  const t0 = Date.now();
  const out = { ok: true, phase, now: new Date(nowMs).toISOString() };
  try {
    if (phase === 'asof' || phase === 'all') {
      const ercot = await readState('ercot_state');
      if (ercot && ercot.reports) {
        out.asof = history.recordAsof(nowMs, ercot);
        out.score = history.score();
      } else out.asof = { skipped: 'no_ercot_data' };
    }
    if (phase === 'metis' || phase === 'all') {
      const metis = await readState('metis_fund');
      out.metis = history.recordMetis(nowMs, metis);
    }
    out.maintain = history.maintain(nowMs);
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e).slice(0, 300);
  }
  out.ms = Date.now() - t0;
  return out;
}
