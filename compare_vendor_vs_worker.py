#!/usr/bin/env python3
"""Read-only: is our Worker behind the vendor? Asks askthegrid directly (from this machine, no Cloudflare, no KV)
for one node's newest nodal issue, then reads what the Worker has stored, and compares. Prints no secrets."""
import os, sys, json, getpass, subprocess, urllib.parse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
CT = ZoneInfo('America/Chicago')
VENDOR = os.environ.get('VENDOR_BASE', 'https://askthegrid.com')
SITE = os.environ.get('SITE', 'https://atg-forecast-dashboard.georgia-catherine5.workers.dev')
NODE = os.environ.get('NODE', 'CATARINA_B1')
KEY = os.environ.get('ASKTHEGRID_API_KEY', '').strip()
if not KEY:
    sys.exit('Set ASKTHEGRID_API_KEY first (it is already in your Codespace).')
pw = os.environ.get('SITE_PASSWORD') or getpass.getpass('Site password: ')
p = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
fmt = lambda t: t.astimezone(CT).strftime('%a %m-%d %H:%M:%S CT')

def get(url, headers):
    """Uses curl, as the earlier probes did: Cloudflare (error 1010) refuses Python's default client identity on askthegrid.
    The URL and headers go to curl on stdin, so the API key and password never appear in the process list."""
    cfg = 'url = "%s"\n' % url + ''.join('header = "%s"\n' % ('%s: %s' % kv) for kv in headers.items())
    pr = subprocess.run(['curl', '-s', '-m', '60', '-w', '\n%{http_code}', '-K', '-'], input=cfg, capture_output=True, text=True)
    body, _, code = pr.stdout.rpartition('\n')
    if code != '200':
        sys.exit('HTTP %s from %s: %s' % (code or '?', url.split('?')[0], body[:200] or pr.stderr[:200]))
    try:
        return json.loads(body)
    except ValueError:
        sys.exit('Not JSON from %s: %s' % (url.split('?')[0], body[:200]))

now = datetime.now(timezone.utc)
q = urllib.parse.urlencode({'iso': 'ERCOT', 'targetKind': 'node', 'targetId': NODE, 'from': now.isoformat().replace('+00:00', 'Z'),
                            'to': (now + timedelta(hours=48)).isoformat().replace('+00:00', 'Z'), 'detail': 'levels'})
vend = get('%s/api/v1/grid/forecasts?%s' % (VENDOR, q), {'Authorization': 'Bearer ' + KEY, 'Accept': 'application/json'})
import base64
auth = 'Basic ' + base64.b64encode(('hen:' + pw).encode()).decode()
ours = get('%s/data/run_status.json' % SITE, {'Authorization': auth})

print('now:', fmt(now), '(%s)' % now.strftime('%H:%M:%SZ'))
print('\nVENDOR, asked directly just now (node %s):' % NODE)
newest = None
for s in vend.get('series', []):
    src = s.get('source') or {}
    iss, mir = s.get('issuedAt'), s.get('mirrorUpdatedAt')
    lag = str(p(mir) - p(iss)) if iss and mir else '-'
    print('  %-22s status=%-6s issued %s   mirror %s   (lag %s)' % (src.get('id'), s.get('status'), fmt(p(iss)) if iss else '-', fmt(p(mir)) if mir else '-', lag))
    if iss and 'nodal' in str(src.get('id', '')).lower() and (newest is None or p(iss) > p(newest[0])): newest = (iss, mir)
if newest is None:
    sys.exit('\nNo nodal series found in the vendor reply; paste the lines above.')
v = ours.get('vintage') or {}
print('\nOUR WORKER has stored:')
print('  newest issue %s   (mirror %s)' % (fmt(p(v['newest_issued_at'])) if v.get('newest_issued_at') else '-', fmt(p(v['newest_mirror_updated_at'])) if v.get('newest_mirror_updated_at') else '-'))
log = ours.get('vintage_log') or []
if log and log[0].get('first_seen_at'):
    first = p(log[0]['first_seen_at'])
    print('  newest issue first seen by the Worker at %s' % fmt(first))
    if log[0].get('mirror_updated_at'):
        print('  = %.1f minutes after the vendor says it was mirrored' % ((first - p(log[0]['mirror_updated_at'])).total_seconds() / 60))
print('\nVERDICT:')
if v.get('newest_issued_at') and p(v['newest_issued_at']) == p(newest[0]):
    print('  In sync: the Worker holds the same newest issue the vendor serves right now.')
elif v.get('newest_issued_at') and p(v['newest_issued_at']) < p(newest[0]):
    behind = (p(newest[0]) - p(v['newest_issued_at'])).total_seconds() / 3600
    mir = p(newest[1]) if newest[1] else None
    when = ('mirrored %.1f min ago' % ((now - mir).total_seconds() / 60)) if mir else 'mirror time unknown'
    print('  The vendor serves a newer issue (%.0f hour(s) newer, %s).' % (behind, when))
    print('  If that was mirrored under 15 minutes ago the Worker is simply between its :05/:20/:35/:50 checks. If longer, that is on our side.')
else:
    print('  The Worker holds an issue NEWER than the vendor serves now (unexpected); paste this output.')
