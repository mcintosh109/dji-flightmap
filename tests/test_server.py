#!/usr/bin/env python3
"""
Tests for app/server.py, using made-up flights (tests/fixtures.py).

Run:  python3 -m unittest discover -s tests -v
(or:  bash tests/run-all.sh, which runs every test)

Two kinds of test:
  - "unit" tests call the server's functions directly,
  - "live" tests start the real server on a free port and talk to it over
    HTTP, the same way the web page does.
"""
import http.cookiejar
import importlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(ROOT, 'app')
sys.path.insert(0, HERE)
from fixtures import make_archive  # noqa: E402


def read_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def load_server(tmp):
    """Import the server's modules fresh, with their files pointed at a temp
    folder. Returns the functions the unit tests call."""
    os.environ['CACHE_FILE'] = os.path.join(tmp, 'state', 'summaries.json')
    os.environ.pop('AUTH_USER', None)
    os.environ.pop('AUTH_PASSWORD_HASH', None)
    if APP not in sys.path:
        sys.path.insert(0, APP)
    for name in [m for m in sys.modules if m == 'flightmap' or m.startswith('flightmap.')]:
        del sys.modules[name]
    flightlogs = importlib.import_module('flightmap.flightlogs')
    settings = importlib.import_module('flightmap.settings')
    auth = importlib.import_module('flightmap.auth')
    return types.SimpleNamespace(build_flight=flightlogs.build_flight, clean_settings=settings.clean_settings,
                                 hash_password=auth.hash_password, verify_password=auth.verify_password)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class LiveServer:
    """Starts app/server.py in the background for the live tests."""

    def __init__(self, data_dir, state_dir, **env):
        self.port = free_port()
        self.base = f'http://127.0.0.1:{self.port}'
        full_env = dict(os.environ, DATA_DIR=data_dir, PORT=str(self.port), HOST='127.0.0.1',
                        CACHE_FILE=os.path.join(state_dir, 'summaries.json'), SCAN_SECONDS='5', **env)
        self.log = open(os.path.join(state_dir, 'server.log'), 'w')
        self.proc = subprocess.Popen([sys.executable, '-u', os.path.join(APP, 'server.py')],
                                     env=full_env, stdout=self.log, stderr=subprocess.STDOUT)
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        # Wait until it answers (/api/health is open even with a login), then,
        # without a login, until the first scan of the folder is done.
        for _ in range(100):
            try:
                if self.request('/api/health')[0] == 200 and (
                        'AUTH_USER' in env or not self.json('/api/flights').get('scanning', True)):
                    return
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.1)
        raise RuntimeError('server did not start; see ' + self.log.name)

    def request(self, path, method='GET', body=None, headers=None):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with self.opener.open(req, timeout=10) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers), err.read()

    def json(self, path, **kw):
        status, _, body = self.request(path, **kw)
        return json.loads(body)

    def put_settings(self, values, header=True):
        headers = {'Content-Type': 'application/json'}
        if header:
            headers['X-Requested-With'] = 'flightmap'
        return self.request('/api/settings', 'PUT', json.dumps(values).encode(), headers)

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)
        self.log.close()


# ---------------------------------------------------------------- unit tests
class ReadingLogs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        cls.archive = os.path.join(cls.tmp, 'archive')
        cls.expect = make_archive(cls.archive)
        cls.server = load_server(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def flight(self, name):
        for dirpath, _, files in os.walk(self.archive):
            if name in files:
                path = os.path.join(dirpath, name)
                return self.server.build_flight(path, os.path.relpath(path, self.archive), 0)
        raise FileNotFoundError(name)

    def test_normal_flight(self):
        summary, detail = self.flight('DJIFlightRecord_2026-01-10_[10-00-00].csv')
        self.assertTrue(summary['hasGps'])
        self.assertEqual(summary['serial'], self.expect['serial'])
        self.assertTrue(summary['start'].startswith(self.expect['a_start']))
        self.assertAlmostEqual(summary['duration'], 120, delta=0.5)
        self.assertAlmostEqual(summary['maxHeight'], 40, delta=1)
        self.assertGreater(summary['distance'], 800)           # a 150 m loop is about 940 m
        self.assertEqual(summary['warnings'], 1)
        # The first 2 s have no GPS fix (like real logs), so the track starts there.
        self.assertAlmostEqual(detail['track'][0]['t'], 2.0, delta=0.15)
        # Take-off point is the first GPS fix, not the junk HOME.latitude column.
        self.assertAlmostEqual(summary['home']['lat'], self.expect['home'][0], places=3)

    def test_clock_carried_over_from_previous_flight(self):
        # The drone's clock starts at 120 s here; the start time must still be
        # the first timestamp, and the replay must start at 0:00.
        summary, detail = self.flight('DJIFlightRecord_2026-01-10_[10-05-00].csv')
        self.assertTrue(summary['start'].startswith(self.expect['b_start']), summary['start'])
        self.assertAlmostEqual(detail['track'][0]['t'], 2.0, delta=0.15)   # not 122
        self.assertLessEqual(detail['track'][-1]['t'], 90.5)

    def test_flight_without_gps(self):
        summary, detail = self.flight('FlightRecord_2026-01-11_[08-00-00].csv')
        self.assertFalse(summary['hasGps'])
        self.assertEqual(detail['track'], [])

    def test_geojson_only(self):
        summary, _ = self.flight('DJIFlightRecord_2026-01-11_[08-30-00].geojson')
        self.assertEqual(summary['source'], 'geojson')
        self.assertTrue(summary['hasGps'])

    def test_not_a_flight_log(self):
        with self.assertRaises(ValueError):
            self.flight('notes.csv')


class SettingsRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        cls.server = load_server(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_good_values_accepted(self):
        new, problems = self.server.clean_settings({
            'mapProvider': 'azure', 'mapLayer': 'satellite', 'azureMapsKey': 'abc-DEF_123',
            'pathColor': '#ff8800', 'aircraftNames': {'TEST0000SERIAL01': 'Scout'}, 'scanSeconds': 60})
        self.assertEqual(problems, [])
        self.assertEqual(new['mapProvider'], 'azure')
        self.assertEqual(new['aircraftNames'], {'TEST0000SERIAL01': 'Scout'})

    def test_bad_values_rejected(self):
        _, problems = self.server.clean_settings({
            'mapProvider': 'google', 'pathColor': 'red', 'scanSeconds': 1,
            'customTileUrl': 'javascript:alert(1)', 'mapboxToken': 'pk.<script>', 'aircraftNames': {'X': '<b>'}})
        self.assertEqual(len(problems), 6, problems)

    def test_password_hash(self):
        stored = self.server.hash_password('correct horse', rounds=1000)
        self.assertNotIn('correct horse', stored)
        self.assertNotIn('$', stored)                     # must be safe in a systemd env file
        self.assertTrue(self.server.verify_password('correct horse', stored))
        self.assertFalse(self.server.verify_password('wrong', stored))


# ---------------------------------------------------------------- live tests
class LiveFlights(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        cls.expect = make_archive(os.path.join(cls.tmp, 'archive'))
        os.makedirs(os.path.join(cls.tmp, 'state'))
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_listing(self):
        data = self.srv.json('/api/flights')
        self.assertEqual(len(data['flights']), self.expect['flights'])
        self.assertEqual(len(data['errors']), 1)                  # notes.csv
        self.assertIn('version', data['app'])
        a = [f for f in data['flights'] if f['start'] and f['start'].startswith(self.expect['a_start'])]
        self.assertEqual(len(a), 1, 'the same flight in two dock folders must be listed once')
        self.assertEqual(a[0]['copies'], 2)
        self.assertEqual(a[0]['source'], 'csv')

    def test_one_flight(self):
        fid = self.srv.json('/api/flights')['flights'][0]['id']
        detail = self.srv.json(f'/api/flights/{fid}')
        self.assertIn('track', detail)
        status, _, _ = self.srv.request('/api/flights/doesnotexist')
        self.assertEqual(status, 404)

    def test_static_files_and_traversal(self):
        status, _, body = self.srv.request('/')
        self.assertEqual(status, 200)
        self.assertIn(b'Flight Map', body)
        status, _, _ = self.srv.request('/../../etc/passwd')
        self.assertEqual(status, 404)

    def test_changes_need_our_header(self):
        status, _, _ = self.srv.put_settings({'units': 'metric'}, header=False)
        self.assertEqual(status, 403)
        status, _, _ = self.srv.request('/api/rescan', 'POST')
        self.assertEqual(status, 403)
        status, _, body = self.srv.request('/api/rescan', 'POST', headers={'X-Requested-With': 'flightmap'})
        self.assertEqual(status, 200)

    def test_settings_saved_and_private(self):
        status, _, _ = self.srv.put_settings({'mapProvider': 'free', 'mapLayer': 'satellite', 'units': 'metric'})
        self.assertEqual(status, 200)
        path = os.path.join(self.tmp, 'state', 'settings.json')
        self.assertEqual(read_json(path)['mapLayer'], 'satellite')
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')   # may hold map keys
        status, _, body = self.srv.put_settings({'pathColor': 'red'})
        self.assertEqual(status, 400)
        self.assertIn(b'colour', body)


class LivePlans(unittest.TestCase):
    """Saved flight plans: /api/plans."""

    PLAN = {
        'name': 'Park loop', 'home': {'lat': 40.7812, 'lon': -73.9665},
        'waypoints': [{'lat': 40.782, 'lon': -73.966, 'alt': 121.92, 'speed': 8.05, 'hold': 0},
                      {'lat': 40.783, 'lon': -73.965, 'alt': 60, 'speed': 6, 'hold': 10}],
        'defaults': {'alt': 60.96, 'speed': 8.05}, 'plannedFor': '2026-11-20T15:30',
        'batteryStart': 100, 'returnHome': True, 'notes': 'Check the wind\nfirst',
    }

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        os.makedirs(os.path.join(cls.tmp, 'state'))
        make_archive(os.path.join(cls.tmp, 'archive'))
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def put(self, plan_id, plan, header=True):
        headers = {'Content-Type': 'application/json'}
        if header:
            headers['X-Requested-With'] = 'flightmap'
        status, _, body = self.srv.request(f'/api/plans/{plan_id}', 'PUT', json.dumps(plan).encode(), headers)
        return status, json.loads(body or b'{}')

    def test_save_list_change_delete(self):
        status, saved = self.put('new', self.PLAN)
        self.assertEqual(status, 200, saved)
        pid = saved['id']
        # 400 ft and 18 mph must come back exactly (no rounding drift).
        self.assertEqual(saved['waypoints'][0]['alt'], 121.92)
        self.assertEqual(saved['waypoints'][0]['speed'], 8.05)
        self.assertEqual(saved['notes'], 'Check the wind\nfirst')
        names = [p['name'] for p in self.srv.json('/api/plans')['plans']]
        self.assertIn('Park loop', names)

        status, changed = self.put(pid, dict(self.PLAN, name='Park loop v2'))
        self.assertEqual((status, changed['id'], changed['created']), (200, pid, saved['created']))

        path = os.path.join(self.tmp, 'state', 'plans.json')
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')

        headers = {'X-Requested-With': 'flightmap'}
        self.assertEqual(self.srv.request(f'/api/plans/{pid}', 'DELETE', headers=headers)[0], 200)
        self.assertEqual(self.srv.request(f'/api/plans/{pid}', 'DELETE', headers=headers)[0], 404)

    def test_bad_plans_refused(self):
        bad = dict(self.PLAN, name='<script>', waypoints=[{'lat': 40.78, 'lon': -73.96, 'alt': 900, 'speed': 0, 'hold': 0}],
                   plannedFor='tomorrow')
        status, body = self.put('new', bad)
        self.assertEqual(status, 400)
        self.assertGreaterEqual(len(body['problems']), 4, body)
        status, _ = self.put('new', dict(self.PLAN, home=None))   # waypoints but no take-off point
        self.assertEqual(status, 400)

    def test_plans_need_our_header_and_good_ids(self):
        self.assertEqual(self.put('new', self.PLAN, header=False)[0], 403)
        self.assertEqual(self.put('..%2F..%2Fetc', self.PLAN)[0], 400)
        status, _, _ = self.srv.request('/api/plans/new', 'DELETE')
        self.assertEqual(status, 403)

    def test_planner_settings(self):
        s = self.srv.json('/api/settings')['settings']
        self.assertEqual(s['plannerMaxHeight'], 122)            # 400 ft
        status, _, _ = self.srv.put_settings({'plannerMaxHeight': 5})
        self.assertEqual(status, 400)


class FakeAzure:
    """A pretend Azure Maps on a local port, for the server to talk to."""

    def __init__(self, key):
        import http.server
        import threading
        self.key, self.seen = key, []
        self.connections = set()      # each connection our server opened to "Azure"
        self.cache_control = None     # Cache-Control header to send with pictures
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'   # keeps connections open, like the real Azure

            def do_GET(self):
                from urllib.parse import parse_qs, urlparse
                u = urlparse(self.path)
                q = parse_qs(u.query)
                outer.seen.append((u.path, q.get('subscription-key', [''])[0]))
                outer.connections.add(self.client_address)
                if q.get('subscription-key', [''])[0] != outer.key:
                    body = b'bad key ' + q.get('subscription-key', [''])[0].encode()
                    self.send_response(401)
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if u.path == '/map/attribution':
                    body = json.dumps({'copyrights': ['<a x="1">&copy;2026 TomTom</a>', '<a>&copy;2026 TomTom</a>',
                                                      '<script>alert(1)</script>Vexcel']}).encode()
                    ctype = 'application/json'
                else:
                    body, ctype = b'\x89PNG fake tile', 'image/png'
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                if outer.cache_control and u.path == '/map/tile':
                    self.send_header('Cache-Control', outer.cache_control)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


class LiveAzureKey(unittest.TestCase):
    """The Azure Maps key stays on the server; pictures and credits come through it."""
    KEY = 'SECRET-AZURE-KEY-123'

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        os.makedirs(os.path.join(cls.tmp, 'state'))
        os.makedirs(os.path.join(cls.tmp, 'archive'))
        cls.azure = FakeAzure(cls.KEY)
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'), AZURE_MAPS_URL=cls.azure.url)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.azure.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_key_never_sent_to_the_browser(self):
        self.srv.put_settings({'mapProvider': 'azure', 'azureMapsKey': self.KEY})
        for path in ('/api/settings', '/api/flights'):
            self.assertNotIn(self.KEY.encode(), self.srv.request(path)[2])
        self.assertTrue(self.srv.json('/api/settings')['settings']['azureMapsKeySet'])

    def test_tiles_and_credits_through_the_server(self):
        self.srv.put_settings({'azureMapsKey': self.KEY})
        status, headers, body = self.srv.request('/tiles/azure/microsoft.imagery/15/9650/12318.png')
        self.assertEqual((status, body), (200, b'\x89PNG fake tile'))
        self.assertIn('max-age', headers.get('Cache-Control', ''))
        self.assertIn(('/map/tile', self.KEY), self.azure.seen)
        credits = self.srv.json('/api/azure-credits?tileset=microsoft.base.road&zoom=15&bounds=-74.0,40.7,-73.9,40.8')
        self.assertEqual(credits['copyrights'], ['\u00a92026 TomTom', 'Vexcel'])   # text only, once each

    def test_bad_requests_refused(self):
        for path in ('/tiles/azure/evil.example/1/0/0.png', '/tiles/azure/microsoft.imagery/2/9/0.png',
                     '/tiles/azure/microsoft.imagery/1/0/0.jpg', '/api/azure-credits?tileset=microsoft.imagery&zoom=3&bounds=x'):
            self.assertEqual(self.srv.request(path)[0], 400, path)

    def test_empty_box_keeps_key_and_remove_deletes_it(self):
        self.srv.put_settings({'azureMapsKey': self.KEY})
        self.srv.put_settings({'units': 'metric', 'azureMapsKey': ''})
        self.assertTrue(self.srv.json('/api/settings')['settings']['azureMapsKeySet'])
        self.srv.put_settings({'removeAzureMapsKey': True})
        self.assertFalse(self.srv.json('/api/settings')['settings']['azureMapsKeySet'])
        self.assertEqual(self.srv.request('/tiles/azure/microsoft.imagery/1/0/0.png')[0], 404)

    def tile_count(self):
        return sum(1 for path, _ in self.azure.seen if path == '/map/tile')

    def test_connections_to_azure_are_reused(self):
        self.srv.put_settings({'azureMapsKey': self.KEY})
        self.azure.connections.clear()
        for x in range(100, 108):                      # 8 different pictures, one after another
            self.assertEqual(self.srv.request(f'/tiles/azure/microsoft.base.road/12/{x}/200.png')[0], 200)
        self.assertEqual(len(self.azure.connections), 1, 'one connection to Azure should serve them all')

    def test_pictures_remembered_only_as_azure_allows(self):
        self.srv.put_settings({'azureMapsKey': self.KEY})
        # Azure says "valid for an hour": the second request must not reach Azure.
        self.azure.cache_control = 'max-age=3600'
        before = self.tile_count()
        first = self.srv.request('/tiles/azure/microsoft.imagery/12/300/300.png')
        second = self.srv.request('/tiles/azure/microsoft.imagery/12/300/300.png')
        self.assertEqual(self.tile_count(), before + 1)
        self.assertEqual(first[2], second[2])
        self.assertRegex(second[1].get('Cache-Control', ''), r'^max-age=\d+$')
        # Azure says "private" (or nothing): ask Azure every time.
        for header in ('private, max-age=3600', 'no-store', None):
            self.azure.cache_control = header
            before = self.tile_count()
            self.srv.request('/tiles/azure/microsoft.imagery/12/301/301.png')
            self.srv.request('/tiles/azure/microsoft.imagery/12/301/301.png')
            self.assertEqual(self.tile_count(), before + 2, header)
        self.azure.cache_control = None

    def test_remembered_pictures_need_a_key(self):
        self.srv.put_settings({'azureMapsKey': self.KEY})
        self.azure.cache_control = 'max-age=3600'
        self.assertEqual(self.srv.request('/tiles/azure/microsoft.imagery/12/302/302.png')[0], 200)
        self.azure.cache_control = None
        self.srv.put_settings({'removeAzureMapsKey': True})
        self.assertEqual(self.srv.request('/tiles/azure/microsoft.imagery/12/302/302.png')[0], 404)

    def test_browser_connection_reused_without_mixing_answers(self):
        """Several requests on one connection: each gets its own Cache-Control."""
        import http.client
        self.srv.put_settings({'azureMapsKey': self.KEY})
        conn = http.client.HTTPConnection('127.0.0.1', self.srv.port, timeout=10)
        try:
            conn.request('GET', '/tiles/azure/microsoft.base.road/12/400/400.png')
            tile = conn.getresponse()
            tile.read()
            self.assertIn('max-age', tile.getheader('Cache-Control'))
            sock = conn.sock
            conn.request('GET', '/api/health')           # same connection
            health = conn.getresponse()
            health.read()
            self.assertIs(conn.sock, sock, 'the connection should have been reused')
            self.assertEqual(health.getheader('Cache-Control'), 'no-cache')
            # A request that carries data is answered with "Connection: close".
            conn.request('POST', '/api/rescan', body=b'x' * 10)
            refused = conn.getresponse()
            refused.read()
            self.assertEqual((refused.status, refused.getheader('Connection')), (403, 'close'))
        finally:
            conn.close()

    def test_wrong_key_error_not_passed_on(self):
        self.srv.put_settings({'azureMapsKey': 'WRONG-KEY'})
        status, _, body = self.srv.request('/tiles/azure/microsoft.imagery/1/0/0.png')
        self.assertEqual(status, 502)
        self.assertNotIn(b'WRONG-KEY', body)


class FakeOverpass:
    """A pretend OpenStreetMap Overpass API: answers with made-up places in
    the middle of whatever box it is asked about."""

    def __init__(self):
        import http.server
        import re
        import threading
        from urllib.parse import parse_qs
        self.queries, self.agents = [], []
        self.status = 200          # set to 429 to play "too busy"
        self.extra = 0             # add this many extra shops (to test "too many")
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                query = parse_qs(self.rfile.read(length).decode())['data'][0]
                outer.queries.append(query)
                outer.agents.append(self.headers.get('User-Agent', ''))
                if outer.status != 200:
                    self.send_response(outer.status)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                s, w, n, e = map(float, re.search(r'\[bbox:([^\]]+)\]', query).group(1).split(','))
                lat, lon = (s + n) / 2, (w + e) / 2
                elements = [
                    {'type': 'node', 'id': 1, 'lat': lat, 'lon': lon,
                     'tags': {'name': 'Joe\'s <b>Cafe</b>', 'amenity': 'cafe', 'addr:housenumber': '12',
                              'addr:street': 'Main St', 'opening_hours': 'Mo-Fr 07:00-15:00'}},
                    {'type': 'way', 'id': 2, 'center': {'lat': lat + 0.0005, 'lon': lon},
                     'tags': {'name': 'Hillside School', 'amenity': 'school'}},
                    {'type': 'node', 'id': 3, 'lat': lat, 'lon': lon + 0.0005,
                     'tags': {'name': 'County Heliport', 'aeroway': 'heliport'}},
                    {'type': 'node', 'id': 4, 'lat': lat, 'lon': lon, 'tags': {'amenity': 'cafe'}},        # no name
                    {'type': 'node', 'id': 5, 'lat': lat, 'lon': lon, 'tags': {'name': 'Bench', 'amenity': 'bench'}},
                    {'type': 'node', 'id': 6, 'lat': n + 1, 'lon': e + 1, 'tags': {'name': 'Far away', 'shop': 'yes'}},
                ] + [{'type': 'node', 'id': 100 + i, 'lat': lat, 'lon': lon, 'tags': {'name': f'Shop {i}', 'shop': 'yes'}}
                     for i in range(outer.extra)]
                body = json.dumps({'elements': elements}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/api/interpreter'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


class PlacesRules(unittest.TestCase):
    """Sorting OpenStreetMap places into kinds, and the map squares."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        load_server(cls.tmp)
        cls.places = importlib.import_module('flightmap.places')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_kinds(self):
        c = self.places.classify
        self.assertEqual(c({'amenity': 'fast_food'}), ('food', 'Fast food'))
        self.assertEqual(c({'shop': 'car_repair'}), ('car', 'Car repair'))   # not just "shop"
        self.assertEqual(c({'shop': 'bakery'}), ('shop', 'Bakery'))
        self.assertEqual(c({'aeroway': 'aerodrome'}), ('air', 'Aerodrome'))
        self.assertEqual(c({'leisure': 'park'}), ('park', 'Park'))
        self.assertEqual(c({'office': 'yes'}), ('work', 'Business'))
        self.assertIsNone(c({'amenity': 'bench'}))
        self.assertIsNone(c({'highway': 'residential'}))

    def test_squares_round_trip(self):
        x, y = self.places.tile_of(40.7812, -73.9665)          # Central Park
        s, w, n, e = self.places.tile_bounds(x, y)
        self.assertTrue(s <= 40.7812 <= n and w <= -73.9665 <= e)
        self.assertEqual(self.places.tile_of((s + n) / 2, (w + e) / 2), (x, y))

    def test_range_checks(self):
        pr = self.places.parse_range
        self.assertEqual(pr({'x0': ['1'], 'x1': ['2'], 'y0': ['3'], 'y1': ['4']}), (1, 2, 3, 4))
        for bad in ({'x0': ['2'], 'x1': ['1'], 'y0': ['3'], 'y1': ['4']},     # backwards
                    {'x0': ['0'], 'x1': ['99'], 'y0': ['0'], 'y1': ['0']},    # far too many squares
                    {'x0': ['-1'], 'x1': ['1'], 'y0': ['0'], 'y1': ['0']},
                    {'x0': ['0'], 'x1': ['40000'], 'y0': ['0'], 'y1': ['0']},
                    {'x0': ['a'], 'x1': ['1'], 'y0': ['0'], 'y1': ['0']}, {}):
            self.assertIsNone(pr(bad), bad)


class LivePlaces(unittest.TestCase):
    """Places come from OpenStreetMap through our server, and are remembered."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        os.makedirs(os.path.join(cls.tmp, 'state'))
        os.makedirs(os.path.join(cls.tmp, 'archive'))
        cls.osm = FakeOverpass()
        cls.spare = FakeOverpass()     # the second server, tried when the first is busy
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'),
                             OVERPASS_URL=f'{cls.osm.url},{cls.spare.url}')

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.osm.stop()
        cls.spare.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_places_sorted_and_remembered(self):
        before = len(self.osm.queries)
        got = self.srv.json('/api/places?x0=9650&x1=9651&y0=12317&y1=12317')
        self.assertEqual(len(self.osm.queries), before + 1, 'two squares, one question to OpenStreetMap')
        names = {p['name']: p for p in got['places']}
        self.assertEqual(set(names), {"Joe's <b>Cafe</b>", 'Hillside School', 'County Heliport'})
        cafe = names["Joe's <b>Cafe</b>"]
        self.assertEqual((cafe['kind'], cafe['label'], cafe['addr'], cafe['hours']),
                         ('food', 'Cafe', '12 Main St', 'Mo-Fr 07:00-15:00'))
        self.assertEqual(names['Hillside School']['id'], 'w2')
        self.assertEqual(names['County Heliport']['kind'], 'air')
        self.assertFalse(got['truncated'])
        self.assertIn('dji-flightmap/', self.osm.agents[-1])
        query = self.osm.queries[-1]
        self.assertIn('[out:json]', query)
        self.assertIn('nwr["name"]->.named;', query)
        self.assertIn('nwr.named["shop"];', query)
        # Asked again (also as part of a bigger area): nothing new goes to OpenStreetMap
        # for the squares it already knows.
        again = self.srv.json('/api/places?x0=9650&x1=9651&y0=12317&y1=12317')
        self.assertEqual(again['places'], got['places'])
        self.assertEqual(len(self.osm.queries), before + 1)
        self.srv.json('/api/places?x0=9650&x1=9652&y0=12317&y1=12317')
        self.assertEqual(len(self.osm.queries), before + 2)
        bbox = query[query.index('[bbox:') + 6:query.index(']', query.index('[bbox:'))]
        new_bbox = self.osm.queries[-1][self.osm.queries[-1].index('[bbox:') + 6:]
        self.assertNotEqual(bbox, new_bbox.split(']')[0], 'only the new square is asked about')

    def test_bad_areas_refused(self):
        for q in ('', 'x0=1&x1=0&y0=0&y1=0', 'x0=0&x1=50&y0=0&y1=50', 'x0=a&x1=1&y0=1&y1=1'):
            self.assertEqual(self.srv.request('/api/places?' + q)[0], 400, q)

    def test_second_server_used_when_first_is_busy(self):
        self.osm.status = 504
        first, spare = len(self.osm.queries), len(self.spare.queries)
        try:
            got = self.srv.json('/api/places?x0=9680&x1=9680&y0=12320&y1=12320')
            self.assertEqual(len(got['places']), 3)
            self.assertEqual((len(self.osm.queries) - first, len(self.spare.queries) - spare), (1, 1))
            # The one that worked is asked first next time.
            self.srv.json('/api/places?x0=9681&x1=9681&y0=12320&y1=12320')
            self.assertEqual((len(self.osm.queries) - first, len(self.spare.queries) - spare), (1, 2))
        finally:
            self.osm.status = 200
            # Make the first server busy for a moment so the order goes back.
            self.spare.status = 429
            self.srv.json('/api/places?x0=9682&x1=9682&y0=12320&y1=12320')
            self.spare.status = 200

    def test_busy_openstreetmap(self):
        self.osm.status = self.spare.status = 429
        try:
            status, _, body = self.srv.request('/api/places?x0=9660&x1=9660&y0=12320&y1=12320')
        finally:
            self.osm.status = self.spare.status = 200
        self.assertEqual(status, 503)
        self.assertTrue(json.loads(body)['busy'])
        # Not remembered as "nothing here": asking again works.
        got = self.srv.json('/api/places?x0=9660&x1=9660&y0=12320&y1=12320')
        self.assertEqual(len(got['places']), 3)

    def test_too_many_places_not_remembered(self):
        self.osm.extra = self.spare.extra = 4000
        try:
            first = self.srv.json('/api/places?x0=9670&x1=9670&y0=12320&y1=12320')
            self.assertTrue(first['truncated'])
            before = len(self.osm.queries)
            self.srv.json('/api/places?x0=9670&x1=9670&y0=12320&y1=12320')
            self.assertEqual(len(self.osm.queries), before + 1, 'a cut-off answer must be asked again')
        finally:
            self.osm.extra = self.spare.extra = 0


class LiveMigration(unittest.TestCase):
    """Settings saved by versions before 1.5.0 used one 'mapStyle'."""

    def test_old_map_style_converted(self):
        tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        try:
            state = os.path.join(tmp, 'state')
            os.makedirs(state)
            os.makedirs(os.path.join(tmp, 'archive'))
            with open(os.path.join(state, 'settings.json'), 'w') as fh:
                json.dump({'mapStyle': 'azure-hybrid', 'azureMapsKey': 'k123', 'satelliteLabels': False}, fh)
            srv = LiveServer(os.path.join(tmp, 'archive'), state)
            try:
                s = srv.json('/api/settings')['settings']
                self.assertEqual((s['mapProvider'], s['mapLayer'], s['satelliteLabels']), ('azure', 'satellite', True))
                saved = read_json(os.path.join(state, 'settings.json'))
                self.assertNotIn('mapStyle', saved)
            finally:
                srv.stop()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class LiveLogin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        os.makedirs(os.path.join(cls.tmp, 'state'))
        make_archive(os.path.join(cls.tmp, 'archive'))
        server = load_server(cls.tmp)
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'),
                             AUTH_USER='tester', AUTH_PASSWORD_HASH=server.hash_password('testpass123', rounds=1000))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def login(self, password):
        body = f'username=tester&password={password}'.encode()
        return self.srv.request('/api/login', 'POST', body, {'Content-Type': 'application/x-www-form-urlencoded'})

    def test_login_flow(self):
        status, headers, _ = self.srv.request('/')
        self.assertEqual((status, headers.get('Location')), (303, '/login.html'))
        self.assertEqual(self.srv.request('/api/flights')[0], 401)
        self.assertEqual(self.srv.request('/login.html')[0], 200)
        self.assertEqual(self.srv.request('/api/health')[0], 200)

        status, headers, _ = self.login('wrong-password')
        self.assertEqual(headers.get('Location'), '/login.html?error=1')

        status, headers, _ = self.login('testpass123')
        self.assertEqual(headers.get('Location'), '/')
        self.assertIn('HttpOnly', headers.get('Set-Cookie', ''))
        self.assertEqual(self.srv.request('/api/flights')[0], 200)

        # A changed cookie must not work.
        for cookie in self.srv.jar:
            cookie.value = cookie.value.replace('tester:', 'admin:')
        self.assertEqual(self.srv.request('/api/flights')[0], 401)


if __name__ == '__main__':
    unittest.main(verbosity=2)
