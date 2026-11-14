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
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(ROOT, 'app')
sys.path.insert(0, HERE)
from fixtures import make_archive  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def load_server(tmp):
    """Import server.py fresh, with its files pointed at a temp folder."""
    os.environ['CACHE_FILE'] = os.path.join(tmp, 'state', 'summaries.json')
    os.environ.pop('AUTH_USER', None)
    os.environ.pop('AUTH_PASSWORD_HASH', None)
    sys.path.insert(0, APP)
    if 'server' in sys.modules:
        del sys.modules['server']
    return importlib.import_module('server')


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
        self.assertEqual(json.load(open(path))['mapLayer'], 'satellite')
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), '0o600')   # may hold map keys
        status, _, body = self.srv.put_settings({'pathColor': 'red'})
        self.assertEqual(status, 400)
        self.assertIn(b'colour', body)


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
                saved = json.load(open(os.path.join(state, 'settings.json')))
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
