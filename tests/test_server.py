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
import base64
import hashlib
import io
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
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(ROOT, 'app')
sys.path.insert(0, HERE)
from fixtures import make_archive  # noqa: E402


def read_json(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def read_text(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()


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
                        CACHE_FILE=os.path.join(state_dir, 'summaries.json'), SCAN_SECONDS='5',
                        DEFAULT_HTTPS='off', **env)
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
            'mapProvider': 'not-a-provider', 'pathColor': 'red', 'scanSeconds': 1,
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
        self.fail_next = 0            # answer this many requests with 503 first (a busy moment)
        self.search_status = 200      # answer for places searches (e.g. 400: switched off)
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
                if outer.fail_next > 0:
                    outer.fail_next -= 1
                    self.send_response(503)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                if u.path == '/search/nearby/json':
                    # Places around Central Park (made up), like Search v1 answers.
                    results = [
                        {'id': 'US/POI/p0/1', 'poi': {'name': 'Corner Gas', 'classifications': [
                            {'code': 'PETROL_STATION', 'names': [{'nameLocale': 'en-US', 'name': 'petrol station'}]}]},
                         'address': {'streetNumber': '1', 'streetName': 'Park Ave', 'municipality': 'New York'},
                         'position': {'lat': 40.7812, 'lon': -73.9665}},
                        {'id': 'US/POI/p0/2', 'poi': {'name': 'Town Clinic', 'classifications': [
                            {'code': 'HOSPITAL_POLYCLINIC', 'names': [{'nameLocale': 'en-US', 'name': 'hospital polyclinic'}]}]},
                         'position': {'lat': 40.7820, 'lon': -73.9650}},
                        {'id': 'US/POI/p0/3', 'poi': {'name': '<b>Evil</b>'}, 'position': {'lat': 'x', 'lon': 1}},
                    ]
                    body = json.dumps({'results': results}).encode()
                    self.send_response(outer.search_status)
                    self.send_header('Content-Type', 'application/json')
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

    def test_a_busy_moment_is_retried(self):
        # Azure answers 503 once: the server asks again instead of leaving a
        # black square on the map.
        self.srv.put_settings({'azureMapsKey': self.KEY})
        self.azure.fail_next = 1
        status, _, body = self.srv.request('/tiles/azure/microsoft.imagery/14/4824/6159.png')
        self.assertEqual((status, body), (200, b'\x89PNG fake tile'))
        self.azure.fail_next = 2        # still busy the second time: an error the page will retry
        self.assertEqual(self.srv.request('/tiles/azure/microsoft.imagery/14/4824/6160.png')[0], 502)
        self.azure.fail_next = 0

    def places(self, lat=40.7812, lon=-73.9665, radius=1500):
        return self.srv.request(f'/api/azure-places?lat={lat}&lon={lon}&radius={radius}')

    def searches(self):
        return sum(1 for path, _ in self.azure.seen if path == '/search/nearby/json')

    def test_places_from_azure(self):
        self.srv.put_settings({'mapProvider': 'azure', 'azureMapsKey': self.KEY, 'azurePlacesDailyLimit': 150})
        before = self.searches()
        status, _, body = self.places()
        data = json.loads(body)
        self.assertEqual(status, 200, data)
        self.assertEqual([(p['name'], p['kind']) for p in data['places']],
                         [('Corner Gas', 'car'), ('Town Clinic', 'health')], 'broken entries are skipped')
        self.assertEqual(data['places'][0]['label'], 'Petrol station')
        self.assertEqual(data['places'][0]['addr'], '1 Park Ave, New York')
        self.assertIn(('/search/nearby/json', self.KEY), self.azure.seen, 'the key is added by the server')
        self.assertNotIn(self.KEY.encode(), body)
        # A view nearby (same ~1 km square, same size) uses the remembered answer:
        # Azure isn't asked again and it doesn't count.
        used = data['used']
        status, _, body = self.places(lat=40.7814, lon=-73.9663, radius=1800)
        again = json.loads(body)
        self.assertTrue(again.get('remembered'))
        self.assertEqual((self.searches(), again['used']), (before + 1, used))

    def test_azure_places_rules(self):
        self.srv.put_settings({'mapProvider': 'azure', 'azureMapsKey': self.KEY, 'azurePlacesDailyLimit': 0})
        status, _, body = self.places(lat=41.5)
        self.assertEqual(status, 403)
        self.assertTrue(json.loads(body)['off'])
        self.srv.put_settings({'azurePlacesDailyLimit': 1})
        self.places(lat=42.5)                               # may use up today's one search
        status, _, body = self.places(lat=43.5)
        self.assertEqual(status, 429, 'over the daily limit')
        self.srv.put_settings({'azurePlacesDailyLimit': 150, 'mapProvider': 'free'})
        self.assertEqual(self.places(lat=44.5)[0], 400, 'only with the Azure map')
        # Azure refuses (e.g. the old search was switched off): an error the page
        # answers by showing OpenStreetMap places.
        self.srv.put_settings({'mapProvider': 'azure'})
        self.azure.search_status = 400
        status, _, body = self.places(lat=45.5)
        self.azure.search_status = 200
        self.assertEqual(status, 502)
        self.assertNotIn(self.KEY.encode(), body)

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


class FakeGoogle:
    """A pretend Google Map Tiles API: sessions, pictures and credits."""

    def __init__(self, key):
        import http.server
        import threading
        self.key = key
        self.sessions = []      # the body of each createSession request
        self.tiles = []         # (path, session) of each picture request
        self.expired = set()    # session codes to refuse ("ran out")
        self.session_status = 200   # set to 404 to refuse making sessions
        self.searches = []      # (field mask, body) of each Places search
        self.no_styles_on = set()   # map types on which "styles" is refused (like Google may)
        self.cache_control = 'public, max-age=3600'
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def reply(self, status, body, ctype='application/json', extra=None):
                self.send_response(status)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def bad_key(self, q):
                if q.get('key', [''])[0] == outer.key:
                    return False
                msg = 'API key not valid: ' + q.get('key', [''])[0]
                self.reply(400, json.dumps({'error': {'message': msg}}).encode())
                return True

            def do_POST(self):
                from urllib.parse import parse_qs, urlparse
                u = urlparse(self.path)
                q = parse_qs(u.query)
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)))
                if u.path == '/v1/places:searchNearby':
                    if self.headers.get('X-Goog-Api-Key') != outer.key:
                        return self.reply(403, b'{"error":{"message":"denied","status":"PERMISSION_DENIED"}}')
                    outer.searches.append((self.headers.get('X-Goog-FieldMask', ''), body))
                    c = body['locationRestriction']['circle']['center']
                    near = lambda dlat, name, kind, label: {
                        'id': 'ChIJ' + name.replace(' ', ''), 'displayName': {'text': name, 'languageCode': 'en'},
                        'location': {'latitude': c['latitude'] + dlat, 'longitude': c['longitude']},
                        'primaryType': kind, 'primaryTypeDisplayName': {'text': label},
                        'shortFormattedAddress': '1 Main St', 'googleMapsUri': 'https://maps.google.com/?cid=1'}
                    return self.reply(200, json.dumps({'places': [
                        near(0.0002, 'Dollar Store', 'discount_store', 'Discount store'),
                        near(0.0004, 'Quick Gas', 'gas_station', 'Gas station'),
                        near(0.0006, 'Family Doctor', 'doctor', 'Doctor'),
                        {'id': 'x', 'displayName': {'text': ''}}]}).encode())
                if self.bad_key(q):
                    return
                if body.get('styles') and body.get('mapType') in outer.no_styles_on:
                    outer.sessions.append(None)
                    return self.reply(400, b'{"error":{"message":"styles not supported","status":"INVALID_ARGUMENT"}}')
                if outer.session_status != 200:
                    outer.sessions.append(None)
                    return self.reply(outer.session_status, json.dumps({'error': {
                        'code': 404, 'message': 'Requested entity was not found.', 'status': 'NOT_FOUND'}}).encode())
                outer.sessions.append(body)
                code = f'S{len(outer.sessions)}'
                self.reply(200, json.dumps({'session': code, 'expiry': str(int(time.time()) + 1209600),
                                            'tileWidth': 256, 'tileHeight': 256, 'imageFormat': 'png'}).encode())

            def do_GET(self):
                from urllib.parse import parse_qs, urlparse
                u = urlparse(self.path)
                q = parse_qs(u.query)
                if self.bad_key(q):
                    return
                session = q.get('session', [''])[0]
                if session in outer.expired:
                    return self.reply(400, b'{"error":{"message":"session expired"}}')
                if u.path == '/tile/v1/viewport':
                    # Like the real answer: the whole world at a low zoom, plus closer areas.
                    rects = [{'maxzoom': 3, 'south': -85, 'north': 85, 'west': -180, 'east': 180},
                             {'maxzoom': 19, 'south': 40, 'north': 41, 'west': -74.5, 'east': -73.5},
                             {'maxzoom': 21, 'south': 10, 'north': 11, 'west': 10, 'east': 11}]
                    return self.reply(200, json.dumps({'copyright': 'Map data \u00a92026 Google <b>x</b>',
                                                       'maxZoomRects': rects}).encode())
                outer.tiles.append((u.path, session))
                self.reply(200, b'\x89PNG google tile', 'image/png',
                           {'Cache-Control': outer.cache_control} if outer.cache_control else None)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


class LiveGoogleKey(unittest.TestCase):
    """The Google key stays on the server; pictures are never stored there."""
    KEY = 'AIzaFAKE-google-key_123'

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        os.makedirs(os.path.join(cls.tmp, 'state'))
        os.makedirs(os.path.join(cls.tmp, 'archive'))
        cls.google = FakeGoogle(cls.KEY)
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'),
                             GOOGLE_TILES_URL=cls.google.url, GOOGLE_PLACES_URL=cls.google.url)

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.google.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.srv.put_settings({'mapProvider': 'google', 'googleMapsKey': self.KEY})

    def test_key_never_sent_to_the_browser(self):
        for path in ('/api/settings', '/api/flights'):
            self.assertNotIn(self.KEY.encode(), self.srv.request(path)[2])
        self.assertTrue(self.srv.json('/api/settings')['settings']['googleMapsKeySet'])

    def test_one_session_per_kind_of_map(self):
        before = len(self.google.sessions)
        for x in range(3):
            status, headers, body = self.srv.request(f'/tiles/google/roadmap/15/{9650 + x}/12318.png')
            self.assertEqual((status, body), (200, b'\x89PNG google tile'))
        self.assertEqual(headers.get('Cache-Control'), 'public, max-age=3600', "Google's own instruction is passed on")
        self.srv.request('/tiles/google/hybrid/15/9650/12318.png')
        made = self.google.sessions[before:]
        self.assertLessEqual(len(made), 2)
        kinds = {(b['mapType'], tuple(b.get('layerTypes', []))) for b in self.google.sessions if b}
        self.assertIn(('roadmap', ()), kinds)
        self.assertIn(('satellite', ('layerRoadmap',)), kinds)

    def test_pictures_are_not_stored_on_the_server(self):
        before = len(self.google.tiles)
        self.srv.request('/tiles/google/satellite/12/300/300.png')
        self.srv.request('/tiles/google/satellite/12/300/300.png')
        self.assertEqual(len(self.google.tiles), before + 2, 'both requests must go to Google')

    def test_expired_session_is_renewed(self):
        self.srv.request('/tiles/google/terrain/10/100/100.png')
        old = self.google.tiles[-1][1]
        self.google.expired.add(old)
        status, _, _ = self.srv.request('/tiles/google/terrain/10/101/100.png')
        self.assertEqual(status, 200)
        self.assertNotEqual(self.google.tiles[-1][1], old)

    def test_credits_text_and_closest_zoom(self):
        got = self.srv.json('/api/google-credits?set=roadmap&zoom=17&bounds=-74.0,40.7,-73.9,40.8')
        self.assertEqual(got, {'copyright': 'Map data \u00a92026 Google x', 'maxZoom': 19})

    def test_bad_requests_refused(self):
        for path in ('/tiles/google/evil/1/0/0.png', '/tiles/google/roadmap/2/9/0.png',
                     '/tiles/google/roadmap/1/0/0.jpg', '/api/google-credits?set=roadmap&zoom=3&bounds=x',
                     '/api/google-credits?set=nope&zoom=3&bounds=1,2,3,4'):
            self.assertEqual(self.srv.request(path)[0], 400, path)

    def test_wrong_key_error_not_passed_on(self):
        self.srv.put_settings({'googleMapsKey': 'WRONG-KEY'})
        status, _, body = self.srv.request('/tiles/google/dark/3/1/1.png')
        self.assertEqual(status, 502)
        self.assertNotIn(b'WRONG-KEY', body)
        with open(os.path.join(self.tmp, 'state', 'server.log')) as fh:
            log = fh.read()
        self.assertNotIn('WRONG-KEY', log, 'the key must not be written to the log')

    def test_refused_session_not_asked_for_every_picture(self):
        self.google.session_status = 404
        try:
            before = len(self.google.sessions)
            for x in range(5):
                self.assertEqual(self.srv.request(f'/tiles/google/dark/12/{x}/0.png')[0], 404)
            self.assertEqual(len(self.google.sessions) - before, 1, 'Google is asked once, not once per picture')
        finally:
            self.google.session_status = 200
        with open(os.path.join(self.tmp, 'state', 'server.log')) as fh:
            log = fh.read()
        self.assertIn('Requested entity was not found. / NOT_FOUND', log)
        self.assertIn('Map Tiles API is enabled', log)

    def test_check_command(self):
        """python3 server.py --check-google says what Google answered, never the key."""
        out = subprocess.run([sys.executable, os.path.join(APP, 'server.py'), '--check-google'],
                             env=dict(os.environ, GOOGLE_TILES_URL=self.google.url,
                                      CACHE_FILE=os.path.join(self.tmp, 'state', 'summaries.json')),
                             capture_output=True, text=True, timeout=30).stdout
        self.assertIn('roadmap', out)
        self.assertIn('session OK, picture OK', out)
        self.assertIn('roads as a separate layer', out)
        self.assertNotIn(self.KEY, out)

    def test_pictures_without_googles_own_places(self):
        status, _, body = self.srv.request('/tiles/google/roadmap-nopoi/16/100/100.png')
        self.assertEqual((status, body), (200, b'\x89PNG google tile'))
        styles = [b for b in self.google.sessions if b and b['mapType'] == 'roadmap' and b.get('styles')][-1]['styles']
        self.assertIn({'featureType': 'poi', 'elementType': 'labels', 'stylers': [{'visibility': 'off'}]}, styles)

    def test_refused_style_falls_back_to_normal_pictures(self):
        self.google.no_styles_on.add('satellite')
        try:
            status, _, body = self.srv.request('/tiles/google/hybrid-nopoi/16/101/100.png')
            self.assertEqual((status, body), (200, b'\x89PNG google tile'))
            before = len(self.google.sessions)
            self.assertEqual(self.srv.request('/tiles/google/hybrid-nopoi/16/102/100.png')[0], 200)
            self.assertEqual(len(self.google.sessions), before, 'the refusal is remembered')
        finally:
            self.google.no_styles_on.clear()

    def test_google_places(self):
        self.srv.put_settings({'googlePlacesDailyLimit': 150})
        status, _, body = self.srv.request('/api/google-places?lat=40.78&lon=-73.96&radius=400')
        self.assertEqual(status, 200)
        got = json.loads(body)
        self.assertNotIn(self.KEY.encode(), body)
        kinds = {p['name']: p['kind'] for p in got['places']}
        self.assertEqual(kinds, {'Dollar Store': 'shop', 'Quick Gas': 'car', 'Family Doctor': 'health'})
        self.assertTrue(all(p['id'].startswith('g:') and p['link'].startswith('https://') for p in got['places']))
        mask, sent = self.google.searches[-1]
        for dearer in ('rating', 'regularOpeningHours', 'reviews', 'photos'):
            self.assertNotIn(dearer, mask, 'only Pro fields, so each search stays at the Pro price')
        self.assertEqual((sent['maxResultCount'], sent['rankPreference']), (20, 'DISTANCE'))
        self.assertEqual(sent['locationRestriction']['circle']['radius'], 400.0)
        self.assertGreaterEqual(got['used'], 1)

    def test_google_places_daily_limit(self):
        self.srv.put_settings({'googlePlacesDailyLimit': 150})
        used = self.srv.json('/api/google-places?lat=40.78&lon=-73.96&radius=400')['used']
        self.srv.put_settings({'googlePlacesDailyLimit': used + 1})
        self.assertEqual(self.srv.request('/api/google-places?lat=40.78&lon=-73.96&radius=400')[0], 200)
        before = len(self.google.searches)
        status, _, body = self.srv.request('/api/google-places?lat=40.78&lon=-73.96&radius=400')
        self.assertEqual(status, 429)
        self.assertTrue(json.loads(body)['limit'])
        self.assertEqual(len(self.google.searches), before, 'over the limit: Google is not asked')
        # 0 turns it off; other providers never use Google places.
        self.srv.put_settings({'googlePlacesDailyLimit': 0})
        self.assertEqual(self.srv.request('/api/google-places?lat=40.78&lon=-73.96&radius=400')[0], 403)
        self.srv.put_settings({'googlePlacesDailyLimit': 150, 'mapProvider': 'free'})
        self.assertEqual(self.srv.request('/api/google-places?lat=40.78&lon=-73.96&radius=400')[0], 400)
        self.assertEqual(self.srv.request('/api/google-places?lat=x&lon=1&radius=1')[0], 400)

    def test_remove_key(self):
        self.srv.put_settings({'units': 'metric', 'googleMapsKey': ''})
        self.assertTrue(self.srv.json('/api/settings')['settings']['googleMapsKeySet'])
        self.srv.put_settings({'removeGoogleMapsKey': True})
        self.assertFalse(self.srv.json('/api/settings')['settings']['googleMapsKeySet'])
        self.assertEqual(self.srv.request('/tiles/google/roadmap/1/0/0.png')[0], 404)


class LiveHttps(unittest.TestCase):
    """HTTPS: on by default with a private certificate, changed in Settings."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-test-')
        cls.state = os.path.join(cls.tmp, 'state')
        for d in ('state', 'archive'):
            os.makedirs(os.path.join(cls.tmp, d))
        cls.http_port, cls.https_port = free_port(), free_port()
        with open(os.path.join(cls.state, 'settings.json'), 'w') as fh:
            json.dump({'httpsPort': cls.https_port, 'httpsName': 'flightmap.test'}, fh)
        cls.acme_log = os.path.join(cls.tmp, 'acme.log')
        cls.make_fake_acme()
        cls.proc, cls.log = cls.start(cls.http_port)
        cls.wait_for(lambda: cls.https_status()['state'] == 'on')

    @classmethod
    def make_fake_acme(cls):
        """A pretend acme.sh: records what it is asked, hands out a test certificate."""
        cert, key = os.path.join(cls.tmp, 'le-cert.pem'), os.path.join(cls.tmp, 'le-key.pem')
        subprocess.run(['openssl', 'req', '-x509', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
                        '-keyout', key, '-out', cert, '-days', '90', '-subj', '/CN=map.example.test',
                        '-addext', 'subjectAltName=DNS:map.example.test'], check=True, capture_output=True)
        cls.acme = os.path.join(cls.tmp, 'acme.sh')
        with open(cls.acme, 'w') as fh:
            fh.write(f"""#!/bin/bash
echo "$* | token:${{CF_Token:+given}}" >> {cls.acme_log}
case " $* " in
  *" --issue "*) [ -f {cls.tmp}/fail ] && {{ echo "error: Cloudflare refused token $CF_Token"; echo "[Tue Nov 24] invalid domain"; exit 1; }}; exit 0;;
  *" --install-cert "*) while [ $# -gt 0 ]; do
      case "$1" in --key-file) cp {key} "$2";; --fullchain-file) cp {cert} "$2";; esac; shift; done;;
esac
exit 0
""")
        os.chmod(cls.acme, 0o755)

    @classmethod
    def start(cls, http_port):
        log = open(os.path.join(cls.state, f'server-{http_port}.log'), 'w')
        env = dict(os.environ, DATA_DIR=os.path.join(cls.tmp, 'archive'), HOST='127.0.0.1', PORT=str(http_port),
                   CACHE_FILE=os.path.join(cls.state, 'summaries.json'), DEFAULT_HTTPS='private',
                   FLIGHTMAP_IP='127.0.0.1', ACME_SH=cls.acme)
        proc = subprocess.Popen([sys.executable, '-u', os.path.join(APP, 'server.py')], env=env,
                                stdout=log, stderr=subprocess.STDOUT)
        cls.wait_for(lambda: urllib.request.urlopen(f'http://127.0.0.1:{http_port}/api/health', timeout=2))
        return proc, log

    @staticmethod
    def wait_for(test, seconds=20):
        for _ in range(int(seconds * 10)):
            try:
                if test():
                    return
            except (urllib.error.URLError, ConnectionError, OSError, KeyError, ValueError):
                pass
            time.sleep(0.1)
        raise AssertionError('waited too long')

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.log.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- helpers ----
    @classmethod
    def ctx(cls):
        import ssl
        return ssl.create_default_context(cafile=os.path.join(cls.state, 'tls', 'ca.crt'))

    @classmethod
    def https(cls, path, data=None, method='GET', ctx=None):
        req = urllib.request.Request(f'https://127.0.0.1:{cls.https_port}{path}', data=data, method=method,
                                     headers={'Content-Type': 'application/json', 'X-Requested-With': 'flightmap'})
        with urllib.request.urlopen(req, context=ctx or cls.ctx(), timeout=5) as res:
            return res.status, res.read()

    @classmethod
    def https_status(cls):
        """The HTTPS status, asked over https or (when off) plain http."""
        try:
            return json.loads(cls.https('/api/settings')[1])['info']['https']
        except (urllib.error.URLError, OSError):
            with urllib.request.urlopen(f'http://127.0.0.1:{cls.http_port}/api/settings', timeout=5) as res:
                return json.loads(res.read())['info']['https']

    def save(self, values, over_https=True):
        body = json.dumps(values).encode()
        if over_https:
            return self.https('/api/settings', body, 'PUT')
        req = urllib.request.Request(f'http://127.0.0.1:{self.http_port}/api/settings', data=body, method='PUT',
                                     headers={'Content-Type': 'application/json', 'X-Requested-With': 'flightmap'})
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, res.read()

    def plain(self, method, path, host='192.168.1.50:8080'):
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', self.http_port, timeout=5)
        try:
            conn.request(method, path, body=b'x' if method == 'POST' else None, headers={'Host': host})
            res = conn.getresponse()
            return res.status, res.getheader('Location'), res.getheader('Content-Type'), res.read()
        finally:
            conn.close()

    def ca_fingerprint(self):
        out = subprocess.run(['openssl', 'x509', '-in', os.path.join(self.state, 'tls', 'ca.crt'), '-noout',
                              '-fingerprint', '-sha256'], capture_output=True, text=True)
        return out.stdout

    # ---- tests (named a_, b_... so they run in this order) ----
    def test_a_on_by_default_with_a_private_certificate(self):
        self.assertEqual(self.https('/api/health')[0], 200)
        self.assertIn(b'Flight Map', self.https('/')[1])
        info = self.https_status()
        self.assertEqual((info['state'], info['mode'], info['caCert']), ('on', 'private', True))
        self.assertEqual(set(info['names']), {'127.0.0.1', 'flightmap.test'})
        self.assertGreater(info['daysLeft'], 800)
        key = os.path.join(self.state, 'tls', 'ca.key')
        self.assertEqual(os.stat(key).st_mode & 0o777, 0o600)
        names = subprocess.run(['openssl', 'x509', '-in', os.path.join(self.state, 'tls', 'ca.crt'), '-noout',
                                '-ext', 'nameConstraints'], capture_output=True, text=True).stdout
        self.assertIn('DNS:flightmap.test', names, 'the authority only covers this map')

    def test_b_http_sends_you_to_https(self):
        self.assertEqual(self.plain('GET', '/settings.html?x=1')[:2],
                         (301, f'https://192.168.1.50:{self.https_port}/settings.html?x=1'))
        self.assertEqual(self.plain('POST', '/api/login', host='flightmap.test')[:2],
                         (308, f'https://flightmap.test:{self.https_port}/api/login'))
        self.assertEqual(self.plain('GET', '/', host='bad host')[0], 400)
        status, _, _, body = self.plain('GET', '/api/health')
        self.assertEqual((status, json.loads(body)['httpsPort']), (200, self.https_port))
        status, _, ctype, body = self.plain('GET', '/flightmap-ca.crt')
        self.assertEqual((status, ctype), (200, 'application/x-x509-ca-cert'))
        self.assertIn(b'BEGIN CERTIFICATE', body)
        self.assertNotIn(b'PRIVATE KEY', body)

    def test_c_cookie_is_secure_and_untrusting_browsers_are_quiet(self):
        import http.client
        import ssl
        conn = http.client.HTTPSConnection('127.0.0.1', self.https_port, context=self.ctx(), timeout=5)
        conn.request('GET', '/logout')
        res = conn.getresponse()
        res.read()
        conn.close()
        self.assertIn('Secure', res.getheader('Set-Cookie'))
        with self.assertRaises(urllib.error.URLError):
            self.https('/api/health', ctx=ssl.create_default_context())
        self.assertEqual(self.https('/api/health')[0], 200)
        with open(self.log.name) as fh:
            self.assertNotIn('Traceback', fh.read())

    def test_d_bad_choices_refused(self):
        for values in ({'httpsMode': 'letsencrypt', 'httpsName': ''}, {'httpsPort': self.http_port},
                       {'httpsName': 'not a name'}, {'httpsDnsApi': 'rm -rf'}):
            with self.assertRaises(urllib.error.HTTPError, msg=values) as err:
                self.save(values)
            self.assertEqual(err.exception.code, 400)

    def test_e_off_and_on_again_from_settings(self):
        before = self.ca_fingerprint()
        self.save({'httpsMode': 'off'})
        self.wait_for(lambda: urllib.request.urlopen(f'http://127.0.0.1:{self.http_port}/api/flights', timeout=2))
        self.assertEqual(self.https_status()['state'], 'off')
        self.save({'httpsMode': 'private'}, over_https=False)
        self.wait_for(lambda: self.https('/api/health')[0] == 200)
        self.assertEqual(self.ca_fingerprint(), before, 'same authority: devices need not import again')

    def test_f_letsencrypt(self):
        self.save({'httpsMode': 'letsencrypt', 'httpsName': 'map.example.test', 'httpsDnsApi': 'dns_cf',
                   'httpsDnsCredentials': {'CF_Token': 'SECRET-CF-TOKEN'}})
        self.wait_for(lambda: urllib.request.urlopen(f'http://127.0.0.1:{self.http_port}/api/health', timeout=2)
                      and os.path.exists(self.acme_log) and 'install-cert' in read_text(self.acme_log))
        import ssl
        ctx = ssl.create_default_context(cafile=os.path.join(self.tmp, 'le-cert.pem'))
        ctx.check_hostname = False
        self.wait_for(lambda: json.loads(self.https('/api/settings', ctx=ctx)[1])['info']['https']['state'] == 'on')
        _, body = self.https('/api/settings', ctx=ctx)
        self.assertNotIn(b'SECRET-CF-TOKEN', body)
        data = json.loads(body)
        self.assertEqual(data['settings']['httpsDnsCredentialsSet'], ['CF_Token'])
        self.assertEqual(data['info']['https']['mode'], 'letsencrypt')
        with open(self.acme_log) as fh:
            calls = fh.read()
        self.assertIn('--set-default-ca --server letsencrypt', calls)
        self.assertIn('--issue --dns dns_cf -d map.example.test --keylength ec-256 | token:given', calls)
        self.assertNotIn('SECRET-CF-TOKEN', calls, 'the token goes by environment, never on the command line')
        # Refused by the DNS company: an error, the secret hidden, the map still there.
        open(os.path.join(self.tmp, 'fail'), 'w').close()
        self.https('/api/https/renew', b'', 'POST', ctx=ctx)
        self.wait_for(lambda: json.loads(self.https('/api/settings', ctx=ctx)[1])['info']['https']['state'] == 'error')
        message = json.loads(self.https('/api/settings', ctx=ctx)[1])['info']['https']['message']
        self.assertIn('Cloudflare refused token <hidden>', message)
        self.assertIn('spelled exactly like your domain', message, 'a plain hint for "invalid domain"')
        self.assertLess(message.index('spelled exactly'), message.index('Details:'), 'the hint comes first')
        with open(self.log.name) as fh:
            self.assertNotIn('SECRET-CF-TOKEN', fh.read())
        os.remove(os.path.join(self.tmp, 'fail'))
        self.https('/api/settings', json.dumps({'httpsMode': 'private', 'removeHttpsDnsCredentials': True}).encode(),
                   'PUT', ctx=ctx)
        self.wait_for(lambda: self.https('/api/health')[0] == 200)
        self.assertEqual(json.loads(self.https('/api/settings')[1])['settings']['httpsDnsCredentialsSet'], [])

    def test_h_address_only_certificate_is_accepted(self):
        """Without a name: a certificate for the address only (checked by the
        same OpenSSL rules browsers use for "name constraints")."""
        self.https('/api/settings', json.dumps({'httpsName': ''}).encode(), 'PUT')
        self.wait_for(lambda: self.https('/api/health')[0] == 200
                      and self.https_status()['names'] == ['127.0.0.1'])
        curl = subprocess.run(['curl', '-sf', '--cacert', os.path.join(self.state, 'tls', 'ca.crt'),
                               f'https://127.0.0.1:{self.https_port}/api/health'], capture_output=True, text=True)
        self.assertEqual(curl.returncode, 0, curl.stderr)

    def test_g_busy_port_falls_back_to_plain_http(self):
        # A second map with the same settings: its HTTPS port is taken (by the first).
        http_port = free_port()
        proc, log = self.start(http_port)
        try:
            self.wait_for(lambda: 'Could not open port' in read_text(log.name))
            with urllib.request.urlopen(f'http://127.0.0.1:{http_port}/api/flights', timeout=5) as res:
                self.assertEqual(res.status, 200, 'the map itself, on plain http')
        finally:
            proc.terminate()
            proc.wait(5)
            log.close()


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
        self.assertEqual(self.srv.request('/api/nas')[0], 401, 'the NAS details need a login')
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


# ------------------------------------------------- the NAS connection (4.3.0)
def write_mountinfo(path, data_dir, fstype, source='//127.0.0.1/Central/DJI\\040Flight\\040logs'):
    """A pretend /proc/self/mountinfo: the container's own disk, plus what is
    mounted at the logs folder (cifs = the NAS share)."""
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n')
        fh.write(f'99 22 0:50 /archive {data_dir} ro,relatime - {fstype} {source} ro,vers=3.0\n')


class NasRules(unittest.TestCase):
    """flightmap/nas.py: the checks behind Settings -> Flight logs on the NAS."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-nas-')
        cls.data = os.path.join(cls.tmp, 'logs')
        os.makedirs(cls.data)
        cls.mountinfo = os.path.join(cls.tmp, 'mountinfo')
        cls.nas_listener = socket.socket()          # stands in for the NAS's file sharing
        cls.nas_listener.bind(('127.0.0.1', 0))
        cls.nas_listener.listen()
        os.environ.update(DATA_DIR=cls.data, NAS_MOUNTINFO=cls.mountinfo,
                          NAS_PORT=str(cls.nas_listener.getsockname()[1]))
        load_server(cls.tmp)
        cls.nas = importlib.import_module('flightmap.nas')
        os.makedirs(os.path.dirname(cls.nas.HOST_FILE), exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.nas_listener.close()
        for key in ('DATA_DIR', 'NAS_MOUNTINFO', 'NAS_PORT'):
            os.environ.pop(key, None)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        for f in (self.nas.HOST_FILE, self.nas.REQUEST_FILE, os.path.join(self.data, 'archive-folder')):
            if os.path.isdir(f):
                os.rmdir(f)
            elif os.path.exists(f):
                os.remove(f)

    def report(self, **values):
        values.setdefault('at', time.time() - 20)
        with open(self.nas.HOST_FILE, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)

    def check(self, status, check_id):
        return next(c for c in status['checks'] if c['id'] == check_id)

    def test_reads_what_is_mounted(self):
        write_mountinfo(self.mountinfo, self.data, 'cifs')
        fs, source = self.nas.folder_mount()
        self.assertEqual(fs, 'cifs')
        self.assertEqual(source, '//127.0.0.1/Central/DJI Flight logs', 'spaces are written \\040 in mountinfo')
        self.assertEqual(self.nas.server_from(source), '127.0.0.1')

    def test_all_connected(self):
        write_mountinfo(self.mountinfo, self.data, 'cifs')
        os.makedirs(os.path.join(self.data, 'archive-folder'))
        self.report(share=True, server='127.0.0.1', handled=0)
        s = self.nas.status(flight_count=7)
        self.assertEqual(s['kind'], 'share')
        self.assertTrue(s['ok'], s)
        self.assertEqual([c['ok'] for c in s['checks']], [True, True, True, True])
        self.assertIn('7 flights', self.check(s, 'readable')['text'])
        self.assertIn('Connected', s['summary'])

    def test_container_sees_the_empty_folder(self):
        # The NAS was off when the server started: the container sees the
        # folder underneath the share, which is empty.
        write_mountinfo(self.mountinfo, self.data, 'ext4', '/dev/sda1')
        self.report(share=True, server='127.0.0.1')
        s = self.nas.status()
        self.assertEqual(s['kind'], 'share', 'the helper said it is a share')
        self.assertFalse(s['ok'])
        self.assertFalse(self.check(s, 'connected')['ok'])
        self.assertFalse(self.check(s, 'readable')['ok'])
        self.assertIn('empty', self.check(s, 'readable')['text'])
        self.assertTrue(self.check(s, 'reachable')['ok'], 'the address comes from the helper')
        self.assertIn('Reconnect now', s['summary'])

    def test_nas_not_answering(self):
        write_mountinfo(self.mountinfo, self.data, 'cifs')
        os.makedirs(os.path.join(self.data, 'archive-folder'))
        self.report(share=True, server='127.0.0.1')
        old = self.nas.NAS_PORT
        self.nas.NAS_PORT = free_port()   # nothing listens there
        try:
            s = self.nas.status()
        finally:
            self.nas.NAS_PORT = old
        self.assertFalse(self.check(s, 'reachable')['ok'])
        self.assertIn('switched on', self.check(s, 'reachable')['text'])

    def test_logs_in_a_plain_folder(self):
        write_mountinfo(self.mountinfo, self.data, 'zfs', 'tank/dji')
        os.makedirs(os.path.join(self.data, 'archive-folder'))
        s = self.nas.status(flight_count=2)
        self.assertEqual(s['kind'], 'folder')
        self.assertEqual([c['id'] for c in s['checks']], ['readable'], 'no NAS checks for a plain folder')
        self.assertTrue(s['ok'])
        self.assertIn('not a NAS share', s['summary'])

    def test_helper_not_running(self):
        write_mountinfo(self.mountinfo, self.data, 'cifs')
        os.makedirs(os.path.join(self.data, 'archive-folder'))
        self.report(share=True, server='127.0.0.1', at=time.time() - 3600)
        s = self.nas.status()
        self.assertFalse(self.check(s, 'helper')['ok'])
        self.assertIn('run the update', self.check(s, 'helper')['text'])
        self.assertEqual(s['message'], '', 'an hour-old report is not shown')

    def test_reconnect_request(self):
        write_mountinfo(self.mountinfo, self.data, 'ext4', '/dev/sda1')
        self.report(share=True, server='127.0.0.1', handled=0)
        asked = self.nas.request_reconnect(now=1000)
        self.assertEqual(self.nas.request_reconnect(now=1005), asked, 'pressing twice quickly asks once')
        self.report(share=True, server='127.0.0.1', handled=0)
        self.assertTrue(self.nas.status()['pending'])
        self.assertIn('Asked the Proxmox server', self.nas.status()['summary'])
        self.report(share=True, server='127.0.0.1', handled=asked,
                    action='Restarted the map, so it sees the NAS share again.')
        s = self.nas.status()
        self.assertFalse(s['pending'], 'the helper handled it')
        self.assertIn('Restarted the map', s['message'])

    def test_read_that_hangs_is_given_up(self):
        old = self.nas._list
        self.nas._list = lambda path, box: time.sleep(1.5)   # a NAS that doesn't answer
        try:
            ok, why = self.nas.readable(wait=0.2)
            self.assertFalse(ok)
            self.assertIn("didn't answer", why)
            ok, why = self.nas.readable(wait=0.2)
            self.assertIn('earlier read', why, 'no second read while one is stuck')
        finally:
            self.nas._list = old
            time.sleep(1.5)


class LiveNas(unittest.TestCase):
    """/api/nas and /api/nas/reconnect on the real server."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-nas-live-')
        cls.expect = make_archive(os.path.join(cls.tmp, 'archive'))
        cls.state = os.path.join(cls.tmp, 'state')
        os.makedirs(cls.state)
        cls.mountinfo = os.path.join(cls.tmp, 'mountinfo')
        write_mountinfo(cls.mountinfo, os.path.join(cls.tmp, 'archive'), 'cifs')
        with open(os.path.join(cls.state, 'nas-host.json'), 'w', encoding='utf-8') as fh:
            json.dump({'at': time.time(), 'share': True, 'server': '127.0.0.1', 'handled': 0}, fh)
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), cls.state,
                             NAS_MOUNTINFO=cls.mountinfo, NAS_PORT=str(free_port()))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_status(self):
        s = self.srv.json('/api/nas')
        self.assertEqual(s['kind'], 'share')
        ids = [c['id'] for c in s['checks']]
        self.assertEqual(ids, ['reachable', 'connected', 'readable', 'helper'])
        self.assertIn(f"{self.expect['flights']} flights", next(c for c in s['checks'] if c['id'] == 'readable')['text'])

    def test_reconnect(self):
        self.assertEqual(self.srv.request('/api/nas/reconnect', 'POST')[0], 403,
                         'only the settings page itself may ask')
        status, _, body = self.srv.request('/api/nas/reconnect', 'POST', headers={'X-Requested-With': 'flightmap'})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['requested'])
        self.assertTrue(os.path.exists(os.path.join(self.state, 'nas-request.json')))
        self.assertTrue(self.srv.json('/api/nas')['pending'])


# ------------------------------------------------------ DJI Fly missions (5.0.0)
def central_park_plan(**extra):
    """A made-up plan over Central Park (never the owner's real places)."""
    wps = [
        {'lat': 40.7812, 'lon': -73.9665, 'alt': 30, 'speed': 5, 'hold': 3},
        {'lat': 40.7820, 'lon': -73.9650, 'alt': 45.5, 'speed': 5, 'hold': 0},
        {'lat': 40.7830, 'lon': -73.9660, 'alt': 60, 'speed': 5, 'hold': 6},
        {'lat': 40.7825, 'lon': -73.9675, 'alt': 50, 'speed': 5, 'hold': 2},
    ]
    return dict({'name': 'Park loop', 'home': {'lat': 40.7810, 'lon': -73.9670}, 'waypoints': wps}, **extra)


class AzurePlaceKinds(unittest.TestCase):
    """Azure's place codes become the map's kinds (icons)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-azkinds-')
        load_server(cls.tmp)
        cls.az = importlib.import_module('flightmap.azplaces')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_kinds(self):
        for code, kind in (('PETROL_STATION', 'car'), ('OPEN_PARKING_AREA', 'car'), ('HOSPITAL_POLYCLINIC', 'health'),
                           ('PHARMACY', 'health'), ('SCHOOL', 'school'), ('RESTAURANT', 'food'), ('CAFE_PUB', 'food'),
                           ('PLACE_OF_WORSHIP', 'worship'), ('POLICE_STATION', 'public'), ('BANK', 'public'),
                           ('PARK_RECREATION_AREA', 'park'), ('HOTEL_MOTEL', 'stay'), ('MUSEUM', 'sight'),
                           ('CINEMA', 'fun'), ('RAILWAY_STATION', 'transport'), ('SHOP', 'shop'),
                           ('AIRPORT', 'air'), ('HELIPAD_HELICOPTER_LANDING', 'air'), ('BARBER_SHOP', 'shop'),
                           ('COMPANY', 'work'), ('', 'work')):
            self.assertEqual(self.az.kind_of(code), kind, code)

    def test_nearby_views_share_one_search(self):
        self.assertEqual(self.az.snap(40.78123, -73.96121, 1500), self.az.snap(40.7838, -73.9641, 1900))
        self.assertEqual(self.az.snap(40.78, -73.96, 300)[2], 1000)
        self.assertEqual(self.az.snap(40.78, -73.96, 90000)[2], 5000)


class DjiFlyRules(unittest.TestCase):
    """flightmap/djifly.py writes missions like DJI Fly does (it was checked
    against three missions made by the owner's own RC 2, which are not in
    this public project)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-djifly-')
        load_server(cls.tmp)
        cls.dj = importlib.import_module('flightmap.djifly')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def files(self, plan=None, **kw):
        import io
        import zipfile
        data = self.dj.build_kmz(plan or central_park_plan(), 122, now=1795000000, **kw)
        z = zipfile.ZipFile(io.BytesIO(data))
        return z, {n: z.read(n).decode() for n in z.namelist()}

    def test_zip_like_dji_fly(self):
        z, files = self.files()
        self.assertEqual(z.namelist(), ['wpmz/template.kml', 'wpmz/waylines.wpml'])
        self.assertTrue(all(i.compress_type == 8 for i in z.infolist()), 'compressed, like DJI Fly')
        import xml.etree.ElementTree as ET
        for text in files.values():
            ET.fromstring(text.encode())   # well-formed
            self.assertIn('xmlns:wpml="http://www.uav.com/wpmz/1.0.2"', text)
            self.assertIn('<wpml:droneEnumValue>68</wpml:droneEnumValue>', text, 'Mini 4 Pro')
        self.assertIn('<wpml:createTime>1795000000000</wpml:createTime>', files['wpmz/template.kml'])

    def test_route(self):
        import re
        _, files = self.files()
        w = files['wpmz/waylines.wpml']
        self.assertEqual(w.count('<Placemark>'), 4)
        self.assertEqual(re.findall(r'<wpml:executeHeight>([^<]+)<', w), ['30', '45.5', '60', '50'])
        self.assertEqual(set(re.findall(r'<wpml:waypointSpeed>([^<]+)<', w)), {'5'})
        self.assertIn('<wpml:globalTransitionalSpeed>5</wpml:globalTransitionalSpeed>', w)
        self.assertIn('<wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>', w)
        self.assertIn('-73.9665,40.7812', w, 'longitude first, like KML')
        # Pauses are hovers (also at the first waypoint, after the gimbal).
        self.assertEqual(re.findall(r'<wpml:hoverTime>(\d+)<', w), ['3', '6', '2'])
        first = w.split('</Placemark>')[0]
        self.assertLess(first.index('gimbalRotate'), first.index('<wpml:actionActuatorFunc>hover'))
        ids = [int(i) for i in re.findall(r'<wpml:actionId>(\d+)<', w)]
        self.assertEqual(ids, list(range(1, len(ids) + 1)), 'action numbers count up through the file')
        last = w.split('<Placemark>')[-1]
        self.assertNotIn('gimbalEvenlyRotate', last, 'nothing to level towards after the last point')
        self.assertIn('<wpml:finishAction>goHome</wpml:finishAction>', w, 'return home by default')
        self.assertIn('<wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>', w)
        self.assertEqual(set(re.findall(r'<wpml:useStraightLine>(\d)<', w)), {'0'})

    def test_choices(self):
        _, files = self.files(finish='autoLand', lost='landing')
        w = files['wpmz/waylines.wpml']
        self.assertIn('<wpml:finishAction>autoLand</wpml:finishAction>', w)
        self.assertIn('<wpml:executeRCLostAction>landing</wpml:executeRCLostAction>', w)
        with self.assertRaises(self.dj.MissionError):
            self.files(finish='gotoFirstWaypoint')

    def test_refuses_unsafe_or_impossible_plans(self):
        cases = {
            'one speed': lambda p: p['waypoints'][1].update(speed=8),
            'at least 2 waypoints': lambda p: p.update(waypoints=p['waypoints'][:1]),
            'too close to the ground': lambda p: p['waypoints'][0].update(alt=2),
            'height limit': lambda p: p['waypoints'][2].update(alt=130),
            'take-off point': lambda p: p.update(home=None),
        }
        for words, change in cases.items():
            plan = central_park_plan()
            change(plan)
            with self.assertRaises(self.dj.MissionError) as err:
                self.files(plan)
            self.assertIn(words, str(err.exception))


class LiveDjiFly(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-djifly-live-')
        make_archive(os.path.join(cls.tmp, 'archive'))
        os.makedirs(os.path.join(cls.tmp, 'state'))
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), os.path.join(cls.tmp, 'state'))

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def save(self, plan):
        status, _, body = self.srv.request('/api/plans/new', 'PUT', json.dumps(plan).encode(),
                                           {'Content-Type': 'application/json', 'X-Requested-With': 'flightmap'})
        self.assertEqual(status, 200, body)
        return json.loads(body)['id']

    def test_download(self):
        plan_id = self.save(central_park_plan())
        status, headers, body = self.srv.request(f'/api/plans/{plan_id}/djifly.kmz?finish=autoLand&lost=goBack')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/vnd.google-earth.kmz')
        self.assertIn('filename="Park loop.kmz"', headers['Content-Disposition'])
        self.assertEqual(body[:2], b'PK')

    def test_refusals(self):
        plan = central_park_plan()
        plan['waypoints'][0]['speed'] = 9
        status, _, body = self.srv.request(f'/api/plans/{self.save(plan)}/djifly.kmz')
        self.assertEqual(status, 400)
        self.assertIn('one speed', json.loads(body)['error'])
        self.assertEqual(self.srv.request('/api/plans/0123456789ab/djifly.kmz')[0], 404)
        self.assertEqual(self.srv.request('/api/plans/../../etc/djifly.kmz')[0], 404)


def placeholder_kmz(points, update_ms=1700000000000):
    """A made-up DJI Fly mission like the ones on an RC 2 (Central Park, never real places)."""
    marks = ''.join(f"""<Placemark><Point><coordinates>{lon},{lat}</coordinates></Point>
<wpml:index>{i}</wpml:index><wpml:executeHeight>{h}</wpml:executeHeight></Placemark>"""
                    for i, (lat, lon, h) in enumerate(points))
    wpml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.uav.com/wpmz/1.0.2">
<Document><Folder>{marks}</Folder></Document></kml>"""
    template = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.uav.com/wpmz/1.0.2">
<Document><wpml:updateTime>{update_ms}</wpml:updateTime></Document></kml>"""
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as zf:
        zf.writestr('wpmz/template.kml', template)
        zf.writestr('wpmz/waylines.wpml', wpml)
    return out.getvalue()


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==')
UUID_A = '0A1B2C3D-0000-4000-8000-00000000000A'
UUID_B = '0A1B2C3D-0000-4000-8000-00000000000B'


class LiveRc2(unittest.TestCase):
    """Send to RC 2: the map's side of the dock (dji-rc2-dock)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='flightmap-rc2-')
        make_archive(os.path.join(cls.tmp, 'archive'))
        cls.state = os.path.join(cls.tmp, 'state')
        os.makedirs(cls.state)
        cls.srv = LiveServer(os.path.join(cls.tmp, 'archive'), cls.state)
        cls.page = {'Content-Type': 'application/json', 'X-Requested-With': 'flightmap'}
        cls.key = None

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, path, method='GET', data=None, key=None, page=True):
        headers = dict(self.page) if page else {}
        if key:
            headers['Authorization'] = f'Bearer {key}'
        body = json.dumps(data).encode() if data is not None else None
        status, headers, raw = self.srv.request(path, method, body, headers)
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, raw

    def dock(self, path, method='GET', data=None):
        return self.call(path, method, data, key=self.key, page=False)

    def report(self, missions):
        return self.dock('/api/dock/missions', 'PUT', {'missions': missions})

    def mission(self, uuid, points, preview=True):
        item = {'uuid': uuid, 'kmz': base64.b64encode(placeholder_kmz(points)).decode(), 'modified': '2026-11-20 10:00'}
        if preview:
            item['preview'] = base64.b64encode(PNG).decode()
        return item

    def save_plan(self, plan):
        status, body = self.call('/api/plans/new', 'PUT', plan)
        self.assertEqual(status, 200, body)
        return body['id']

    def test_1_dock_key(self):
        self.assertEqual(self.call('/api/dock/queue', page=False)[0], 401, 'no key: refused')
        self.assertFalse(self.call('/api/rc2')[1]['keySet'])
        self.assertEqual(self.call('/api/rc2/key', 'POST', {}, page=False)[0], 403, 'only from our own page')
        status, body = self.call('/api/rc2/key', 'POST', {})
        self.assertEqual(status, 200)
        old = body['key']
        self.assertTrue(old.startswith('dock_') and len(old) > 40)
        status, body = self.call('/api/rc2/key', 'POST', {})
        type(self).key = body['key']
        self.assertEqual(self.call('/api/dock/queue', key=old, page=False)[0], 401, 'a new key replaces the old one')
        status, body = self.dock('/api/dock/hello')
        self.assertEqual((status, body['ok']), (200, True))
        stored = read_text(os.path.join(self.state, 'dock-key.json'))
        self.assertNotIn(self.key, stored, 'only a hash of the key is kept')
        status, body = self.call('/api/rc2')
        self.assertTrue(body['keySet'] and body['dockSeen'])
        self.assertNotIn(self.key, json.dumps(body))

    def test_2_missions_and_send(self):
        status, body = self.dock('/api/dock/queue')
        self.assertEqual(status, 200)
        self.assertEqual(body, {'send': [], 'wantList': True}, 'no list yet: the dock is asked for one')
        a = self.mission(UUID_A, [(40.7812, -73.9665, 30), (40.7830, -73.9660, 40)])
        b = self.mission(UUID_B, [(40.7790, -73.9690, 20), (40.7795, -73.9700, 25), (40.7800, -73.9690, 30)], preview=False)
        bad = [{'uuid': '../etc', 'kmz': a['kmz']}, {'uuid': UUID_A.replace('A', 'C'), 'kmz': 'bm90IGEgemlw'}]
        status, body = self.report([a, b] + bad)
        self.assertEqual((status, body['missions']), (200, 2), body)
        self.assertEqual(len(body['problems']), 2)
        self.assertFalse(self.dock('/api/dock/queue')[1]['wantList'])
        status, page = self.call('/api/rc2')
        listed = {m['uuid']: m for m in page['missions']}
        self.assertEqual(listed[UUID_A]['waypoints'], 2)
        self.assertEqual(listed[UUID_B]['waypoints'], 3)
        self.assertAlmostEqual(listed[UUID_A]['lengthM'], 205, delta=10)
        self.assertEqual(listed[UUID_A]['points'][0], [40.7812, -73.9665, 30.0])
        self.assertTrue(listed[UUID_A]['updated'].startswith('2023-11-14'))
        self.assertEqual((listed[UUID_A]['preview'], listed[UUID_B]['preview']), ('png', False))
        status, headers, raw = self.srv.request(f'/api/rc2/preview/{UUID_A}')
        self.assertEqual((status, headers['Content-Type'], raw), (200, 'image/png', PNG))
        self.assertEqual(self.srv.request('/api/rc2/preview/..%2Fdock-key.json')[0], 404)

        # The 4 slots: placeholders with 2, 3, 4 and 5 waypoints, confirmed once.
        slots = {s['slot']: s for s in page['slots']}
        self.assertEqual([slots[n]['waypoints'] for n in (1, 2, 3, 4)], [2, 3, 4, 5])
        self.assertEqual((slots[1]['candidates'], slots[2]['candidates'], slots[3]['candidates']), ([UUID_A], [UUID_B], []),
                         'found by their number of waypoints')
        plan_id = self.save_plan(central_park_plan())
        self.assertEqual(self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 1})[0], 409, 'not confirmed yet')
        status, body = self.call('/api/rc2/slot', 'POST', {'slot': 1, 'uuid': UUID_B})
        self.assertEqual(status, 400)
        self.assertIn('must have 2 waypoints', body['error'], 'only a placeholder with the right count')
        self.assertEqual(self.call('/api/rc2/slot', 'POST', {'slot': True, 'uuid': UUID_A})[0], 400)
        self.assertEqual(self.call('/api/rc2/slot', 'POST', {'slot': 1, 'uuid': UUID_A}, page=False)[0], 403)
        self.assertEqual(self.call('/api/rc2/slot', 'POST', {'slot': 1, 'uuid': UUID_A})[0], 200)
        status, page = self.call('/api/rc2/slot', 'POST', {'slot': 2, 'uuid': UUID_B})
        slots = {s['slot']: s for s in page['slots']}
        self.assertEqual((slots[1]['uuid'], slots[2]['uuid'], slots[1]['candidates']), (UUID_A, UUID_B, []))

        # Send a plan to slot 1 (mission A).
        self.assertEqual(self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 1}, page=False)[0], 403)
        self.assertEqual(self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 3})[0], 409, 'slot 3 is not set up')
        self.assertEqual(self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 9})[0], 400)
        self.assertEqual(self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'uuid': UUID_A})[0], 400,
                         'any other mission can never be picked')
        bad_plan = self.save_plan(central_park_plan(waypoints=central_park_plan()['waypoints'][:1]))
        status, body = self.call(f'/api/plans/{bad_plan}/rc2', 'POST', {'slot': 1})
        self.assertEqual(status, 400)
        self.assertIn('2 waypoints', body['error'], 'the same checks as the DJI Fly download')
        status, body = self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 1, 'finish': 'autoLand'})
        self.assertEqual(status, 200, body)
        send = body['send']
        self.assertEqual((send['state'], send['expectSha256']), ('waiting', listed[UUID_A]['sha256']))

        # The dock picks it up.
        status, queue = self.dock('/api/dock/queue')
        self.assertEqual([s['id'] for s in queue['send']], [send['id']])
        item = queue['send'][0]
        self.assertEqual((item['uuid'], item['expectSha256'], item['planName']), (UUID_A, listed[UUID_A]['sha256'], 'Park loop'))
        status, headers, kmz = self.srv.request(item['url'], headers={'Authorization': f'Bearer {self.key}'})
        self.assertEqual((status, kmz[:2]), (200, b'PK'))
        self.assertEqual(hashlib.sha256(kmz).hexdigest(), item['sha256'])
        self.assertIn(b'autoLand', zipfile.ZipFile(io.BytesIO(kmz)).read('wpmz/waylines.wpml'))
        self.assertEqual(self.srv.request(item['url'])[0], 401, 'the file needs the dock key')
        status, body = self.dock(f"/api/dock/result/{send['id']}", 'POST',
                                 {'ok': True, 'message': 'written and checked', 'backup': 'mission-backups/x.kmz'})
        self.assertEqual((status, body['state']), (200, 'done'))
        self.assertEqual(self.dock('/api/dock/queue')[1]['send'], [])
        self.assertEqual(self.srv.request(item['url'], headers={'Authorization': f'Bearer {self.key}'})[0], 404)
        status, page = self.call('/api/rc2')
        listed = {m['uuid']: m for m in page['missions']}
        self.assertEqual(listed[UUID_A]['fromMap'], 'Park loop', 'the mission now holds our plan')
        self.assertEqual(page['slots'][0]['mission']['fromMap'], 'Park loop', 'slot 1 holds it')
        self.assertEqual(page['slots'][0]['uuid'], UUID_A, 'and stays slot 1 though it has 4 waypoints now')
        self.assertEqual(page['sends'][0]['state'], 'done')

        # Cancel a waiting send; a failed send keeps the dock's message.
        status, body = self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 2})
        first = body['send']['id']
        status, body = self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 2})
        second = body['send']['id']
        states = {s['id']: s['state'] for s in self.call('/api/rc2')[1]['sends']}
        self.assertEqual((states[first], states[second]), ('cancelled', 'waiting'), 'a newer send replaces the older')
        self.assertEqual(self.call(f'/api/rc2/send/{second}', 'DELETE')[0], 200)
        self.assertEqual(self.call(f'/api/rc2/send/{second}', 'DELETE')[0], 409)
        self.assertEqual(self.dock('/api/dock/queue')[1]['send'], [])
        status, body = self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 2})
        third = body['send']['id']
        self.dock(f'/api/dock/result/{third}', 'POST', {'ok': False, 'message': 'The mission changed on the RC 2 <b>'})
        sends = {s['id']: s for s in self.call('/api/rc2')[1]['sends']}
        self.assertEqual(sends[third]['state'], 'failed')
        self.assertNotIn('<', sends[third]['message'])

        # A mission deleted in DJI Fly: a send still waiting for it fails.
        status, body = self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 2})
        fourth = body['send']['id']
        self.report([a])
        sends = {s['id']: s for s in self.call('/api/rc2')[1]['sends']}
        self.assertEqual(sends[fourth]['state'], 'failed')
        self.assertIn('no longer on the RC 2', sends[fourth]['message'])
        page = self.call('/api/rc2')[1]
        self.assertTrue(page['slots'][1]['missing'], "slot 2's mission was deleted in DJI Fly")
        self.assertEqual(self.call(f'/api/plans/{plan_id}/rc2', 'POST', {'slot': 2})[0], 409)
        self.assertEqual(self.call('/api/rc2/slot/2', 'DELETE')[0], 200)
        self.assertEqual(self.call('/api/rc2/slot/2', 'DELETE')[0], 404)
        self.assertEqual(self.call('/api/rc2')[1]['slots'][1]['uuid'], '', 'slot 2 freed')

        # "Refresh the list" on the page.
        self.call('/api/rc2/refresh', 'POST', {})
        self.assertTrue(self.dock('/api/dock/queue')[1]['wantList'])

    def test_3_remove_key(self):
        self.assertEqual(self.call('/api/rc2/key', 'DELETE')[0], 200)
        self.assertEqual(self.dock('/api/dock/queue')[0], 401)
        self.assertFalse(self.call('/api/rc2')[1]['keySet'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
