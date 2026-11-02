import glob, json, sys, collections
from datetime import datetime
from zoneinfo import ZoneInfo
CT = ZoneInfo('America/Chicago')
files = sorted(glob.glob('data/*/forecast_log.jsonl'))
if not files:
    sys.exit('No data/*/forecast_log.jsonl in this checkout. Paste the output of:  git log --oneline --all -- data | tail -3')
f = files[0]
p = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
seen = set()
for line in open(f):
    line = line.strip()
    if not line: continue
    try: seen.add(json.loads(line)['origin_time'])
    except Exception: pass
times = sorted(p(s) for s in seen)
print('file:', f, '| distinct issue times:', len(times))
if len(times) < 2: sys.exit('Not enough vintages to measure.')
print('first:', times[0].astimezone(CT).strftime('%a %m-%d %H:%M CT'), '| last:', times[-1].astimezone(CT).strftime('%a %m-%d %H:%M CT'))
gaps = collections.Counter(str(b - a) for a, b in zip(times, times[1:]))
print('\nspacing between consecutive issues (how many times each gap occurred):')
for g, n in sorted(gaps.items(), key=lambda kv: -kv[1])[:8]: print('   %-10s x %d' % (g, n))
print('\nissues per day (CT):')
per = collections.Counter(t.astimezone(CT).strftime('%a %m-%d') for t in times)
order = []
for t in times:
    k = t.astimezone(CT).strftime('%a %m-%d')
    if k not in order: order.append(k)
for k in order: print('   %s  %d' % (k, per[k]))
print('\nminutes past the hour the issues land on:', dict(sorted(collections.Counter(t.minute for t in times).items())))
