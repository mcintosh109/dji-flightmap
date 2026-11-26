#!/usr/bin/env python3
"""
Made-up flight logs for the tests.

They use the same columns as the CSV files from dji-log-parser, but every
value is invented: the flights circle Central Park in New York and use fake
serial numbers. Real flight logs must never be added to this repository
(they contain where you fly).

Use from Python:   from fixtures import make_archive
Use from a shell:  python3 tests/fixtures.py /some/empty/folder
                   (prints what it made, as JSON)
"""
import csv
import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone

# Column names used by dji-log-parser's CSV output (119 columns).
HEADER = [
    'CUSTOM.dateTime', 'OSD.flyTime', 'OSD.latitude', 'OSD.longitude', 'OSD.height', 'OSD.heightMax',
    'OSD.vpsHeight', 'OSD.altitude', 'OSD.xSpeed', 'OSD.xSpeedMax', 'OSD.ySpeed', 'OSD.ySpeedMax',
    'OSD.zSpeed', 'OSD.zSpeedMax', 'OSD.pitch', 'OSD.roll', 'OSD.yaw', 'OSD.flycState', 'OSD.flycCommand',
    'OSD.flightAction', 'OSD.isGPSUsed', 'OSD.nonGPSCause', 'OSD.gpsNum', 'OSD.gpsLevel', 'OSD.droneType',
    'OSD.isSwaveWork', 'OSD.waveError', 'OSD.goHomeStatus', 'OSD.batteryType', 'OSD.isOnGround',
    'OSD.isMotorOn', 'OSD.isMotorBlocked', 'OSD.motorStartFailedCause', 'OSD.isImuPreheated',
    'OSD.imuInitFailReason', 'OSD.isAcceleratorOverRange', 'OSD.isBarometerDeadInAir', 'OSD.isCompassError',
    'OSD.isGoHomeHeightModified', 'OSD.canIOCWork', 'OSD.isNotEnoughForce', 'OSD.isOutOfLimit',
    'OSD.isPropellerCatapult', 'OSD.isVibrating', 'OSD.isVisionUsed', 'OSD.voltageWarning', 'GIMBAL.mode',
    'GIMBAL.pitch', 'GIMBAL.roll', 'GIMBAL.yaw', 'GIMBAL.isPitchAtLimit', 'GIMBAL.isRollAtLimit',
    'GIMBAL.isYawAtLimit', 'GIMBAL.isStuck', 'CAMERA.isPhoto', 'CAMERA.isVideo', 'CAMERA.sdCardIsInserted',
    'CAMERA.sdCardState', 'RC.downlinkSignal', 'RC.uplinkSignal', 'RC.aileron', 'RC.elevator', 'RC.throttle',
    'RC.rudder', 'BATTERY.chargeLevel', 'BATTERY.voltage', 'BATTERY.current', 'BATTERY.currentCapacity',
    'BATTERY.fullCapacity', 'BATTERY.cellNum', 'BATTERY.isCellVoltageEstimated', 'BATTERY.cellVoltage1',
    'BATTERY.cellVoltage2', 'BATTERY.cellVoltageDeviation', 'BATTERY.maxCellVoltageDeviation',
    'BATTERY.temperature', 'BATTERY.minTemperature', 'BATTERY.maxTemperature', 'HOME.latitude',
    'HOME.longitude', 'HOME.altitude', 'HOME.heightLimit', 'HOME.isHomeRecord', 'HOME.goHomeMode',
    'HOME.isDynamicHomePointEnabled', 'HOME.isNearDistanceLimit', 'HOME.isNearHeightLimit',
    'HOME.isCompassCalibrating', 'HOME.compassCalibrationState', 'HOME.isMultipleModeEnabled',
    'HOME.isBeginnerMode', 'HOME.isIOCEnabled', 'HOME.IOCMode', 'HOME.goHomeHeight', 'HOME.IOCCourseLockAngle',
    'HOME.maxAllowedHeight', 'HOME.currentFlightRecordIndex', 'RECOVER.appPlatform', 'RECOVER.appVersion',
    'RECOVER.aircraftName', 'RECOVER.aircraftSerial', 'RECOVER.cameraSerial', 'RECOVER.rcSerial',
    'RECOVER.batterySerial', 'APP.tip', 'APP.warn', 'DETAILS.totalTime', 'DETAILS.totalDistance',
    'DETAILS.maxHeight', 'DETAILS.maxHorizontalSpeed', 'DETAILS.maxVerticalSpeed', 'DETAILS.photoNum',
    'DETAILS.videoTime', 'DETAILS.aircraftName', 'DETAILS.aircraftSerial', 'DETAILS.cameraSerial',
    'DETAILS.rcSerial', 'DETAILS.appPlatform', 'DETAILS.appVersion',
]

# A public place far from anyone's home: the middle of Central Park, New York.
HOME_LAT, HOME_LON = 40.7812, -73.9665
SERIAL = 'TEST0000SERIAL01'
MODEL = 'DJI Mini 4 Pro'


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def write_flight(path, *, start, seconds, clock_offset=0.0, gps=True, max_h=40.0, loop_m=150.0,
                 warn_at=None, serial=SERIAL, name=MODEL, battery=('TESTBATTERY01', 2453)):
    """Write a flight that takes off, flies a loop, and lands.

    clock_offset: the drone's flight clock at the first row. Real drones keep
    counting if you land and take off without switching off (we saw 407 s).
    gps=False:    every position is 0,0 (no GPS lock, e.g. indoors).
    battery:      (serial, full capacity in mAh). 2453 = a used standard
                  Mini 4 Pro battery (2590 new), 3790 = a Plus one (3850 new).
    """
    rows = []
    total = seconds
    base = {h: '' for h in HEADER}
    base.update({
        'RECOVER.aircraftName': name, 'RECOVER.aircraftSerial': serial, 'RECOVER.batterySerial': battery[0],
        'BATTERY.fullCapacity': str(battery[1]),
        'RECOVER.appVersion': '1.21.18', 'DETAILS.aircraftName': name, 'DETAILS.aircraftSerial': serial,
        'DETAILS.appVersion': '1.21.18', 'DETAILS.totalTime': f'{total:.1f}', 'DETAILS.photoNum': '2',
        'DETAILS.videoTime': '0', 'OSD.gpsNum': '18',
        # Real logs carry junk here; the app must ignore it.
        'HOME.latitude': '45836623.61046586', 'HOME.longitude': '45836623.61046586',
    })
    # First row: clock not set yet (1970), like real logs.
    first = dict(base, **{'CUSTOM.dateTime': '1970-01-01T00:00:00Z', 'OSD.flyTime': f'{clock_offset:.1f}',
                          'OSD.latitude': '0.0', 'OSD.longitude': '0.0', 'APP.tip': 'Flight mode changed to GPSNormal.'})
    rows.append(first)
    steps = int(seconds * 10)
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(HOME_LAT))
    for i in range(1, steps + 1):
        t = i / 10
        ang = 2 * math.pi * t / seconds
        has_fix = gps and t >= 2.0                       # 2 s before GPS lock, like real logs
        north = loop_m * math.sin(ang)
        east = loop_m * (1 - math.cos(ang))
        climb = min(t, seconds - t, max_h / 1.5) * 1.5   # up, cruise, down
        row = dict(base, **{
            'CUSTOM.dateTime': iso(start + timedelta(seconds=t)),
            'OSD.flyTime': f'{clock_offset + t:.1f}',
            'OSD.latitude': f'{HOME_LAT + north / m_per_deg_lat:.10f}' if has_fix else '0.0',
            'OSD.longitude': f'{HOME_LON + east / m_per_deg_lon:.10f}' if has_fix else '0.0',
            'OSD.height': f'{climb:.1f}',
            'OSD.xSpeed': f'{6 * math.cos(ang):.2f}', 'OSD.ySpeed': f'{6 * math.sin(ang):.2f}',
            'OSD.zSpeed': '-1.5' if t < max_h / 1.5 else ('1.5' if t > seconds - max_h / 1.5 else '0.0'),
            'OSD.yaw': f'{(math.degrees(ang) + 90 + 180) % 360 - 180:.1f}',
            'OSD.flycState': 'GPSNormal',
            'BATTERY.chargeLevel': str(int(95 - 25 * t / seconds)),
            # Battery warms from 20 to 30 deg C; the cells drift apart a little.
            'BATTERY.temperature': f'{20 + 10 * t / seconds:.1f}',
            'BATTERY.cellVoltageDeviation': f'{0.01 + 0.02 * t / seconds:.3f}',
            'APP.warn': 'Strong wind. Fly with caution.' if warn_at and warn_at <= t < warn_at + 1 else '',
        })
        rows.append(row)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='') as fh:
        writer = csv.DictWriter(fh, fieldnames=HEADER)
        writer.writeheader()
        writer.writerows(rows)


def write_geojson(path, *, start, seconds):
    coords = []
    for i in range(40):
        ang = 2 * math.pi * i / 39
        coords.append([HOME_LON + 0.001 * (1 - math.cos(ang)), HOME_LAT + 0.001 * math.sin(ang), 20.0 + 10 * math.sin(ang / 2)])
    feature = {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coords},
               'properties': {'aircraftName': MODEL, 'aircraftSN': 'TEST0000SERIAL02',
                              'startTime': start.strftime('%Y-%m-%d %H:%M:%S.000 UTC'), 'totalTime': seconds}}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(feature, fh)


def make_archive(root):
    """Build an 'archive' folder shaped like the dji-rc2-dock output.

    Returns a dict describing what the app should find.
    """
    utc = timezone.utc
    a_start = datetime(2026, 1, 10, 15, 0, 0, tzinfo=utc)
    b_start = datetime(2026, 1, 10, 15, 5, 0, tzinfo=utc)
    dock1 = os.path.join(root, '2026-01-10_15-20-00')
    dock2 = os.path.join(root, '2026-01-11_09-00-00')

    # A: a normal 2-minute loop (with one wind warning).
    write_flight(os.path.join(dock1, 'parsed', 'DJIFlightRecord_2026-01-10_[10-00-00].csv'),
                 start=a_start, seconds=120, warn_at=60)
    # The parser also writes a .geojson next to each CSV; the CSV must win.
    write_geojson(os.path.join(dock1, 'parsed', 'DJIFlightRecord_2026-01-10_[10-00-00].geojson'),
                  start=a_start, seconds=120)
    # B: second flight, drone not switched off, so its clock starts at 120.
    # Flown with the bigger "Plus" battery.
    write_flight(os.path.join(dock1, 'parsed', 'DJIFlightRecord_2026-01-10_[10-05-00].csv'),
                 start=b_start, seconds=90, clock_offset=120.0, max_h=60, battery=('TESTBATTERY02', 3790))
    # A again, saved by a later dock session: must be shown once.
    write_flight(os.path.join(dock2, 'parsed', 'DJIFlightRecord_2026-01-10_[10-00-00].csv'),
                 start=a_start, seconds=120, warn_at=60)
    # C: short indoor flight, no GPS at all.
    write_flight(os.path.join(dock2, 'parsed', 'FlightRecord_2026-01-11_[08-00-00].csv'),
                 start=datetime(2026, 1, 11, 14, 0, 0, tzinfo=utc), seconds=15, gps=False, max_h=1)
    # D: only a GeoJSON (no CSV), from a second aircraft.
    write_geojson(os.path.join(dock2, 'parsed', 'DJIFlightRecord_2026-01-11_[08-30-00].geojson'),
                  start=datetime(2026, 1, 11, 14, 30, 0, tzinfo=utc), seconds=60)
    # E: a CSV that is not a flight log.
    os.makedirs(os.path.join(dock2, 'parsed'), exist_ok=True)
    with open(os.path.join(dock2, 'parsed', 'notes.csv'), 'w') as fh:
        fh.write('this,is,not,a,flight\n1,2,3,4,5\n')
    # Raw .txt files must be ignored.
    os.makedirs(os.path.join(dock2, 'raw'), exist_ok=True)
    with open(os.path.join(dock2, 'raw', 'FlightRecord_2026-01-11_[08-00-00].txt'), 'w') as fh:
        fh.write('encrypted raw log stand-in\n')

    return {
        'flights': 4,                       # A (once), B, C, D
        'files': 7,                         # CSVs + GeoJSON-only + notes.csv (raw .txt ignored)
        'a_start': '2026-01-10T15:00:00',
        'b_start': '2026-01-10T15:05:00',
        'serial': SERIAL,
        'home': [HOME_LAT, HOME_LON],
    }


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: fixtures.py EMPTY_FOLDER')
    print(json.dumps(make_archive(sys.argv[1])))
