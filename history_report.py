#!/usr/bin/env python3
"""How have Metis's live forecasts done against ERCOT's, and against what actually happened?

  python3 history_report.py              asks for the site password, downloads /data/history.json, saves a copy, prints the report
  python3 history_report.py FILE.json    reads a saved copy instead

Read-only. The summary contains aggregated numbers only (no keys or credentials).
"""
import sys, os, json, math, getpass, subprocess
from datetime import datetime, timezone

SITE = os.environ.get('SITE', 'https://atg-forecast-dashboard.georgia-catherine5.workers.dev')
MIN_PAIRS = 48          # fewer scored forecast-hours than this in a window: no winner is named
EDGE = 0.05             # a difference smaller than 5% of the error is called "about equal"
WINDOWS = [('under 2 h', 1, 2), ('3-6 h', 3, 6), ('7-12 h', 7, 12), ('13-24 h', 13, 24), ('25-36 h', 25, 36), ('37-47 h', 37, 47), ('ALL 1-36 h', 1, 36)]
COMPARATOR = {'load': "ERCOT's seven-day load forecast (the model in use)", 'wind': "ERCOT's STWPF wind forecast", 'solar': "ERCOT's STPPF solar forecast"}


def load():
    if len(sys.argv) > 1:
        return json.load(open(sys.argv[1]))
    pw = os.environ.get('SITE_PASSWORD') or getpass.getpass('Site password: ')
    cfg = 'url = "%s/data/history.json?detail=1"\nuser = "hen:%s"\n' % (SITE, pw)   # on stdin, so it never appears in the process list
    pr = subprocess.run(['curl', '-s', '-m', '60', '-w', '\n%{http_code}', '-K', '-'], input=cfg, capture_output=True, text=True)
    body, _, code = pr.stdout.rpartition('\n')
    if code != '200':
        sys.exit('HTTP %s from the history route: %s' % (code or '?', body[:200] or pr.stderr[:200]))
    d = json.loads(body)
    name = 'history_snapshot_%s.json' % datetime.now(timezone.utc).strftime('%Y%m%d_%H%MZ')
    json.dump(d, open(name, 'w'))
    print('saved a copy: %s (safe to upload: aggregated numbers only)\n' % name)
    return d


num = lambda v, d=0: '-' if v is None else format(round(v, d), ',.%df' % d)
sgn = lambda v: '-' if v is None else ('+' if v >= 0 else '-') + format(abs(round(v)), ',')
day = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).strftime('%a %b %d %H:%M UTC')


def window_stats(sr, lo, hi):
    """Pooled Metis and ERCOT errors over leads lo..hi, from the per-lead lines."""
    ls = [l for l in (sr['score'].get('leads') or []) if lo <= l['lead'] <= hi and l.get('ercot')]
    n = sum(l['n'] for l in ls)
    if not n:
        return None
    w = lambda side, key: sum(l['n'] * l[side][key] for l in ls) / n
    return {'n': n, 'm_mae': w('metis', 'mae'), 'e_mae': w('ercot', 'mae'), 'm_bias': w('metis', 'bias'), 'e_bias': w('ercot', 'bias'),
            'cover': sum(l['n'] * l['metis']['cover'] for l in ls) / n}


def bucket_stats(sr):
    """Fallback for a summary without per-lead lines: the five coarse buckets."""
    out = []
    for b in sr['score'].get('buckets') or []:
        if b.get('metis') and b.get('ercot'):
            out.append(('%d-%d h' % (b['lo'], b['hi']), {'n': b['n'], 'm_mae': b['metis']['mae'], 'e_mae': b['ercot']['mae'], 'm_bias': b['metis']['bias'], 'e_bias': b['ercot']['bias'], 'cover': b['metis'].get('cover')}))
    return out


def verdict(s):
    if s['n'] < MIN_PAIRS:
        return 'too few (n=%d)' % s['n']
    if s['e_mae'] <= 0:
        return 'ERCOT closer'
    r = s['m_mae'] / s['e_mae']
    if r < 1 - EDGE:
        return 'Metis closer by %d%%' % round((1 - r) * 100)
    if r > 1 + EDGE:
        return 'ERCOT closer by %d%%' % round((1 - 1 / r) * 100)
    return 'about equal'


def typical_level(sr):
    a = sr.get('actuals') or []
    hrs = sum(r['hours'] for r in a)
    return sum(r['hours'] * r['mean'] for r in a) / hrs if hrs else None


def pooled_gap(leads, lo, hi):
    ls = [l for l in leads if lo <= l['lead'] <= hi and l['n'] and l['mean'] is not None]
    N = sum(l['n'] for l in ls)
    if not N:
        return None, None, 0
    S = sum(l['n'] * l['mean'] for l in ls)
    ss = sum((l['n'] - 1) * (l['sd'] or 0) ** 2 + l['n'] * l['mean'] ** 2 for l in ls)
    var = (ss - S * S / N) / (N - 1) if N > 1 else 0
    return S / N, math.sqrt(max(var, 0)), N


def main():
    d = load()
    S = d.get('series') or {}
    sn = d.get('snapshots') or {}
    per_lead = any((S.get(k, {}).get('score') or {}).get('leads') for k in ('wind', 'solar', 'load'))
    print('=' * 100)
    print('METIS LIVE FORECASTS vs ERCOT: report from the history summary generated %s' % day(d['generated_at']))
    print('=' * 100)

    # ---- coverage ----
    print('\n1. HOW MUCH HISTORY THERE IS')
    if not sn.get('metis'):
        sys.exit('   No snapshots saved yet.')
    t0, t1 = datetime.fromisoformat(sn['first_issued_at'].replace('Z', '+00:00')), datetime.fromisoformat(sn['last_issued_at'].replace('Z', '+00:00'))
    expected = int((t1 - t0).total_seconds() // 3600) + 1
    print('   %d hourly Metis forecasts saved, from %s to %s (%.1f days).' % (sn['metis'], day(sn['first_issued_at']), day(sn['last_issued_at']), (t1 - t0).total_seconds() / 86400))
    miss = expected - sn['metis']
    print('   %d would be complete over that span: %s.' % (expected, 'none missing' if miss <= 0 else '%d hour(s) missing (the vendor skipped them, or one was not mirrored in time)' % miss))
    print('   ERCOT captured as of issue time for %d of those hours. A capture more than 25 min after the issue time is excluded, so ERCOT never has newer information than Metis.' % sn['ercot_asof'])
    for k in ('wind', 'solar', 'load'):
        sc = (S.get(k) or {}).get('score') or {}
        print('   %-6s scored hours: %s' % (k, sc.get('hours_scored', 0)))
    issued = sn.get('issued_ms')
    if issued and miss > 0:
        H = 3600000
        have = {m // H * H for m in issued}
        gaps, t = [], issued[0] // H * H
        while t <= issued[-1]:
            if t not in have:
                if gaps and gaps[-1][1] == t - H:
                    gaps[-1][1] = t
                else:
                    gaps.append([t, t])
            t += H
        fm = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%a %b %d %H:%M')
        print('   The hours with no forecast saved, as runs (UTC):')
        for a, b in gaps[:30]:
            n = (b - a) // H + 1
            print('     %s%s  (%d hour%s)' % (fm(a), '' if a == b else ' to ' + fm(b), n, '' if n == 1 else 's'))
        ep = sn.get('ercot_posted') or {}
        def age(series, lo, hi):
            return [(asof - posted) / 60000 for asof, posted in ep.get(series, []) if lo <= asof <= hi]
        for a, b in gaps[:10]:
            if b - a < 2 * H:
                continue
            bits = []
            for k, label in (('wind', 'wind'), ('load', 'load forecast')):
                inside = age(k, a, b)
                allv = sorted(age(k, 0, 10 ** 15))
                if inside and allv:
                    typical = allv[len(allv) // 2]
                    bits.append('ERCOT %s posting was up to %d min old (typical %d)%s' % (label, max(inside), typical, ' <- STALE' if max(inside) > max(180, 3 * typical) else ''))
            if bits:
                print('     ERCOT inputs during %s to %s: %s' % (fm(a), fm(b), '; '.join(bits)))
        # ---- what OUR job did during each gap: the job log, by clock hour ----
        mr = sn.get('metis_runs') or {}
        since = mr.get('since_ms')
        byh = {x['h']: x for x in mr.get('hours') or []}
        print('   WHAT OUR METIS JOB DID DURING EACH GAP:')
        if since is None:
            print('     (no job log yet: it starts collecting at the deploy that added it, so earlier gaps cannot be checked)')
        else:
            print('     (the job log starts %s; gaps before that cannot be checked)' % fm(since))
            for a, b in gaps[:12]:
                tag = '%s%s' % (fm(a), '' if a == b else ' to ' + fm(b))
                if b + H <= since // H * H:
                    print('     %s: predates the job log, so it cannot be told whether the vendor or our job was responsible.' % tag)
                    continue
                hrs = [byh[h] for h in range(max(a, since // H * H), b + H, H) if h in byh]
                n_hours = (b - max(a, since // H * H)) // H + 1
                runs = sum(x['runs'] for x in hrs)
                expected = 3 * n_hours
                out = {}
                for x in hrs:
                    for k, v in x['out'].items():
                        out[k] = out.get(k, 0) + v
                bad = {k: v for k, v in out.items() if k not in ('unchanged', 'complete')}
                snaps = [sn_ for x in hrs for sn_ in x['snap'] if not sn_.startswith('stored')]
                issued = [i for x in hrs if x.get('issued') for i in x['issued']]
                newest = max(issued) if issued else None
                notes = [n for x in hrs for n in x['notes']][:3]
                print('     %s: the job ran %d time%s (about %d expected); outcomes %s.' % (tag, runs, '' if runs == 1 else 's', expected, ', '.join('%s x%d' % kv for kv in sorted(out.items())) or 'none'))
                if runs < 0.8 * expected:
                    print('        -> OUR SIDE: the job ran far fewer times than scheduled, so it could not have seen new issues. (A cron or Worker problem.)')
                elif bad or snaps:
                    print('        -> OUR SIDE: %s%s' % ('; '.join('%d %s' % (v, k) for k, v in bad.items()), ('; snapshot: ' + ', '.join(snaps)) if snaps else ''))
                    for n in notes:
                        print('           ' + n)
                else:
                    print('        -> VENDOR SIDE: every run saw the same issue%s, i.e. no new one was visible to us.' % (' (newest seen: %s)' % fm(newest) if newest else ''))
        if since is not None:
            allout = {}
            for x in mr.get('hours') or []:
                for k, v in x['out'].items():
                    allout[k] = allout.get(k, 0) + v
            tot = sum(allout.values())
            if tot:
                print('     Job health since the log began: %d runs: %s.' % (tot, ', '.join('%s %d' % kv for kv in sorted(allout.items(), key=lambda kv: -kv[1]))))
        longest = max((b - a) // H + 1 for a, b in gaps)
        print('   %d run(s); the longest is %d hour(s). Long runs point to the vendor not issuing or not mirroring; scattered single hours can also be a mirror delay of more than an hour,' % (len(gaps), longest))
        print('   because the API returns only the newest issue, so a late one can be replaced before it is seen.')
    if not per_lead:
        print('\n   NOTE: this summary has no per-lead detail, so windows below are the coarse five buckets (1-3, 4-6, 7-12, 13-24, 25-47 h).\n   Deploy the updated history.js for the exact "under 2 h" and "out to 36 h" windows.')

    # ---- headlines ----
    print('\n2. HEADLINES (mean absolute error in MW, Metis vs ERCOT; lower is better)')
    heads = []
    for k in ('wind', 'solar', 'load'):
        sr = S.get(k) or {}
        if not (sr.get('score') or {}).get('buckets'):
            print('   %-6s not scored yet%s' % (k, ' (actual load arrives once a day; it is scored after the next morning\'s posting)' if k == 'load' else ''))
            continue
        lvl = typical_level(sr)
        if per_lead:
            picks = [('under 2 h', window_stats(sr, 1, 2)), ('1-36 h', window_stats(sr, 1, 36))]
        else:
            bs = bucket_stats(sr)
            picks = [bs[0]] if bs else []
        for label, s in picks:
            if not s:
                continue
            rel = ' (Metis error is %.1f%% of the average %s of %s MW)' % (s['m_mae'] / lvl * 100, k, num(lvl)) if lvl else ''
            heads.append('   %-6s %-9s Metis %s vs ERCOT %s  ->  %s%s' % (k, label, num(s['m_mae']), num(s['e_mae']), verdict(s), rel))
    print('\n'.join(heads) if heads else '   (nothing scored yet)')

    # ---- scorecard by window ----
    print('\n3. SCORECARD BY HOW FAR AHEAD THE FORECAST WAS MADE')
    for k in ('wind', 'solar', 'load'):
        sr = S.get(k) or {}
        if not (sr.get('score') or {}).get('buckets'):
            continue
        print('\n   %s: Metis vs %s' % (k.upper(), COMPARATOR[k]))
        print('   %-11s %8s %12s %12s   %-24s %12s %12s %8s' % ('window', 'pairs', 'Metis MAE', 'ERCOT MAE', 'who is closer', 'Metis bias', 'ERCOT bias', 'band'))
        rows = [(lab, window_stats(sr, lo, hi)) for lab, lo, hi in WINDOWS] if per_lead else bucket_stats(sr)
        for lab, s in rows:
            if not s:
                continue
            print('   %-11s %8s %12s %12s   %-24s %12s %12s %8s' % (lab, num(s['n']), num(s['m_mae']), num(s['e_mae']), verdict(s), sgn(s['m_bias']), sgn(s['e_bias']), '-' if s['cover'] is None else '%d%%' % round(s['cover'] * 100)))
    print('\n   Bias is forecast minus actual (negative = too low). Band is how often the actual fell inside Metis\'s own p10-p90 range; it should be about 80%.')

    # ---- consistency by day ----
    if any(((S.get(k) or {}).get('score') or {}).get('days') for k in ('wind', 'solar', 'load')):
        print('\n3b. DOES IT HOLD DAY BY DAY? (forecasts made 1-36 h ahead, for hours falling on each UTC day)')
        for k in ('wind', 'solar', 'load'):
            days = ((S.get(k) or {}).get('score') or {}).get('days') or []
            if not days:
                continue
            print('\n   %s' % k.upper())
            print('   %-12s %8s %12s %12s   %s' % ('day', 'pairs', 'Metis MAE', 'ERCOT MAE', 'closer'))
            wins = full = 0
            for r in days:
                partial = r['n'] < 300
                if r['ercot_mae'] is None:
                    continue
                if not partial:
                    full += 1
                    wins += 1 if r['metis_mae'] < r['ercot_mae'] else 0
                who = 'partial day' if partial else ('Metis' if r['metis_mae'] < r['ercot_mae'] else 'ERCOT')
                print('   %-12s %8s %12s %12s   %s' % (r['day'], num(r['n']), num(r['metis_mae']), num(r['ercot_mae']), who))
            if full:
                print('   -> Metis was closer on %d of %d full days.' % (wins, full))
            rows = [(r['day'], r['n'], r['metis_mae'], r['ercot_mae']) for r in days if r['ercot_mae'] is not None]
            if len(rows) >= 2:
                pooled = lambda rs: (sum(n * m for _, n, m, e in rs) / sum(n for _, n, m, e in rs), sum(n * e for _, n, m, e in rs) / sum(n for _, n, m, e in rs))
                m_all, e_all = pooled(rows)
                adv = [(d, n * (e - m)) for d, n, m, e in rows if e > m]
                if m_all < e_all and adv:
                    best_day, best_adv = max(adv, key=lambda x: x[1])
                    share = best_adv / sum(a for _, a in adv) * 100
                    rest = [r for r in rows if r[0] != best_day]
                    m2, e2 = pooled(rest)
                    verdict2 = ('Metis still closer by %d%%' % round((1 - m2 / e2) * 100)) if m2 < e2 else ('ERCOT closer by %d%%' % round((1 - e2 / m2) * 100))
                    print('   -> Without the single best day for Metis (%s): Metis %s vs ERCOT %s, %s. That one day is %d%% of its total advantage%s.' % (best_day, num(m2), num(e2), verdict2, round(share), ' (so the pooled lead rests on one day)' if share >= 50 else ''))

    # ---- usual gaps ----
    print('\n4. EACH SERIES\' USUAL GAP: METIS MINUS ERCOT (MW, mean +/- spread), by how far ahead')
    wins = [w for w in WINDOWS if w[0] in ('under 2 h', '13-24 h', '25-36 h', '37-47 h')] if per_lead else None
    names = [('load', 'Load'), ('wind', 'Wind'), ('solar', 'Solar'), ('outage', 'Outages'), ('avail_zones', 'Capacity vs CapGenRes zone sum'), ('avail_gen', 'Capacity vs availCapGen')]
    hdr = [w[0] for w in wins] if wins else ['1-3 h', '4-6 h', '7-12 h', '13-24 h', '25-47 h']
    print('   %-34s' % '' + ''.join('%20s' % h for h in hdr))
    for k, lab in names:
        g = (S.get(k) or {}).get('gap')
        if not g:
            print('   %-34s %s' % (lab, 'no paired hours yet'))
            continue
        cells = []
        if wins:
            for _, lo, hi in wins:
                m, sd, N = pooled_gap(g['leads'], lo, hi)
                cells.append('%20s' % ('-' if m is None else '%s +/- %s' % (sgn(m), num(sd))))
        else:
            for b in g['buckets']:
                cells.append('%20s' % ('%s +/- %s' % (sgn(b['mean']), num(b['sd']))))
        print('   %-34s' % lab + ''.join(cells))
    print('\n   A gap that keeps the same sign and changes with lead time (as the outage gap did on Oct 29) points to how the series is built, not to a view about the grid.')

    # ---- actuals ----
    print('\n5. WHAT ACTUALLY HAPPENED (ERCOT actuals, UTC days; first and last days may be partial)')
    days = sorted({r['day'] for k in ('wind', 'solar', 'load') for r in (S.get(k) or {}).get('actuals') or []})
    if not days:
        print('   (no actuals stored yet)')
    else:
        print('   %-12s %6s   %-22s %-22s %-22s' % ('day', 'hours', 'wind avg / max (GW)', 'solar avg / max (GW)', 'load avg / max (GW)'))
        by = {k: {r['day']: r for r in (S.get(k) or {}).get('actuals') or []} for k in ('wind', 'solar', 'load')}
        gw = lambda r: '-' if not r else '%.1f / %.1f' % (r['mean'] / 1000, r['max'] / 1000)
        for dd in days:
            hrs = max((by[k][dd]['hours'] for k in by if dd in by[k]), default=0)
            print('   %-12s %6s   %-22s %-22s %-22s' % (dd, hrs, gw(by['wind'].get(dd)), gw(by['solar'].get(dd)), gw(by['load'].get(dd))))

    # ---- cautions ----
    print('\n6. READ THESE NUMBERS WITH CARE')
    span = (t1 - t0).total_seconds() / 86400
    print('   - Only %.1f days of history. Short leads have the most data; the longest leads have the least (see the pairs column).' % span)
    from datetime import timedelta
    days_in = [(t0 + timedelta(days=i)).date() for i in range(int(span) + 2)]
    if any(x.weekday() >= 5 for x in days_in):
        print('   - It includes weekend days, which are unrepresentative of a normal weekday (load especially).')
    if any(x.isoformat() == '2026-11-01' for x in days_in):
        print('   - It includes the Nov 1 clock change (a 25-hour day in Central time); everything here is matched by UTC timestamp, so it is aligned, but load behaves differently that day.')
    print('   - Per the vendor, Metis is primarily a price model; load, wind, solar, outage and capacity come out as by-products.')
    print('   - Wind is scored against ERCOT\'s STWPF and solar against STPPF only; ERCOT publishes other bases (WGRPP, PVGRPP).')
    print('   - Errors are in MW; the "% of the average" figures in section 2 make wind, solar and load comparable.')


main()
