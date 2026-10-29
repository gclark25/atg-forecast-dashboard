#!/usr/bin/env python3
"""Read-only: what does ERCOT's actual-load report (NP6-345-CD) look like through the public API?
Prints the field names, a few rows, and how recent the newest hour is. Prints no secrets. Writes nothing."""
import os, sys, json, time, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timedelta
try:
    from zoneinfo import ZoneInfo
    CT = ZoneInfo('America/Chicago')
except Exception:
    sys.exit('This needs Python 3.9 or newer (zoneinfo).')

API = os.environ.get('ERCOT_BASE', 'https://api.ercot.com')
TOKEN_URL = os.environ.get('ERCOT_TOKEN_URL', 'https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token')
CLIENT_ID = 'fec253ea-0d06-4272-a5e6-b478baeecd70'
PAUSE = float(os.environ.get('ERCOT_PROBE_SLEEP', '2.2'))
PATH = '/api/public-reports/np6-345-cd/act_sys_load_by_wzn'

def env(names):
    for n in names:
        v = os.environ.get(n, '').strip()
        if v:
            return v
    return ''
USER = env(['ERCOT_API_USERNAME', 'ERCOT_USERNAME']); PWD = env(['ERCOT_API_PASSWORD', 'ERCOT_PASSWORD'])
KEY = env(['ERCOT_PUBLIC_API_SUBSCRIPTION_KEY', 'ERCOT_API_SUBSCRIPTION_KEY', 'ERCOT_SUBSCRIPTION_KEY'])
if not (USER and PWD and KEY):
    sys.exit('Set ERCOT_API_USERNAME, ERCOT_API_PASSWORD and ERCOT_API_SUBSCRIPTION_KEY first.')

body = urllib.parse.urlencode({'username': USER, 'password': PWD, 'grant_type': 'password', 'client_id': CLIENT_ID,
                               'scope': 'openid %s offline_access' % CLIENT_ID, 'response_type': 'id_token'}).encode()
try:
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body, method='POST', headers={'Content-Type': 'application/x-www-form-urlencoded'}), timeout=60) as r:
        TOKEN = json.loads(r.read().decode()).get('id_token')
except Exception as e:
    sys.exit('Could not get a token: %s' % str(e)[:200])

def get(params):
    time.sleep(PAUSE)
    url = API + PATH + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + TOKEN, 'Ocp-Apim-Subscription-Key': KEY, 'Accept': 'application/json', 'User-Agent': 'hen-atg-dashboard-probe/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors='replace')[:400]
    except Exception as e:
        return 0, str(e)[:200]

now = datetime.now(CT)
d0, d1 = (now - timedelta(days=1)).strftime('%Y-%m-%d'), now.strftime('%Y-%m-%d')
print('Now (Central): %s' % now.strftime('%Y-%m-%dT%H:%M:%S'))
print('Report:', PATH)

attempts = [('with the date window', {'operatingDayFrom': d0, 'operatingDayTo': d1, 'size': 100}),
            ('with no filters, five rows', {'size': 5})]
data = None
for label, params in attempts:
    st, d = get(params)
    print('\n=== %s: HTTP %s ===' % (label, st))
    if st == 200 and isinstance(d, dict) and d.get('data'):
        data = d
        break
    print('  reply:', str(d)[:400])
if not data:
    sys.exit('\nNo rows came back from either attempt. Paste the output above.')

fields = data.get('fields', [])
names = [(f.get('name') if isinstance(f, dict) else f) for f in fields]
print('_meta:', json.dumps(data.get('_meta'))[:300])
print('fields (%d):' % len(names))
for f in fields:
    print('  ', json.dumps(f) if isinstance(f, dict) else f)
rows = [dict(zip(names, r)) if isinstance(r, list) else r for r in data['data']]
print('\nrows returned: %d' % len(rows))
dkey = next((n for n in names if n.lower().startswith('operatingday') or n.lower().endswith('day')), None)
hkey = next((n for n in names if n.lower().startswith('hourending')), None)
print('date field guess: %s | hour field guess: %s' % (dkey, hkey))
print('flag-like fields:', [n for n in names if 'dst' in n.lower() or 'flag' in n.lower()] or 'none')
print('total-like fields:', [n for n in names if 'total' in n.lower()] or 'none')
if dkey and hkey:
    rows.sort(key=lambda r: (str(r.get(dkey)), str(r.get(hkey))))
print('\nfirst 2 rows:')
for r in rows[:2]: print('  ', json.dumps(r))
print('last 3 rows (newest):')
for r in rows[-3:]: print('  ', json.dumps(r))
if dkey and hkey:
    last = rows[-1]
    try:
        he = int(str(last[hkey]).split(':')[0])
        newest_end = datetime.strptime(str(last[dkey])[:10], '%Y-%m-%d').replace(tzinfo=CT) + timedelta(hours=he)
        print('\nnewest hour ends at %s Central, which is %.1f hours before now' % (newest_end.strftime('%Y-%m-%d %H:%M'), (now - newest_end).total_seconds() / 3600))
    except Exception as e:
        print('\ncould not work out how recent the newest hour is:', str(e)[:100])
print('\nDONE (read-only).')
