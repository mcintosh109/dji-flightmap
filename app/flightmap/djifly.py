"""A saved plan as a DJI Fly waypoint mission (.kmz) for the DJI Mini 4 Pro.

DJI Fly has no import button. The file is put in place of a mission DJI
Fly made (see the README: "Sending a plan to DJI Fly"). The file must look
exactly like the ones DJI Fly writes, so everything here was copied from
missions made by the owner's own RC 2 (DJI Fly, November 2026):

  - a ZIP with wpmz/template.kml and wpmz/waylines.wpml (the route the
    drone flies), in the "uav.com/wpmz/1.0.2" format, drone type 68
  - heights are metres above the take-off point
  - ONE speed for the whole route (DJI Fly has no speed per waypoint)
  - a pause is a "hover" action; the camera stays level and the drone
    faces the way it flies (DJI Fly's defaults: gimbal 0°, Follow Course)
  - at the end and when the signal is lost: return home or land

Research: "DJI WPML", "KMZ waypoint mission", "DJI Fly waypoints".
"""
import io
import time
import zipfile

DRONE_ENUM = 68           # DJI Mini 4 Pro, as written by DJI Fly
NAMESPACE = "http://www.uav.com/wpmz/1.0.2"
AUTO_FLIGHT_SPEED = 2.5   # DJI Fly always writes 2.5 here, whatever the route's speed
MIN_HEIGHT = 5            # m: lower than this is too close to the ground for a mission
MIN_SPEED, MAX_SPEED = 1.0, 15.0   # m/s
MAX_HOVER = 300           # s

# The choices DJI Fly offers that both samples showed how to write.
FINISH = {"goHome": "Return to home", "autoLand": "Land"}
LOST = {"goBack": "Return to home", "landing": "Land"}


class MissionError(ValueError):
    """The plan can't be turned into a mission; the message says why."""


def route_speed(plan):
    """The one speed of the route, or None if the waypoints differ."""
    speeds = {round(float(w["speed"]), 2) for w in plan.get("waypoints", [])}
    return speeds.pop() if len(speeds) == 1 else None


def check(plan, max_height):
    """Every reason this plan can't be sent to DJI Fly (an empty list = it can)."""
    problems = []
    wps = plan.get("waypoints", [])
    if not plan.get("home"):
        problems.append("The plan has no take-off point.")
    if len(wps) < 2:
        problems.append("DJI Fly needs at least 2 waypoints.")
    for i, w in enumerate(wps, 1):
        if w["alt"] < MIN_HEIGHT:
            problems.append(f"Waypoint {i} is lower than {MIN_HEIGHT} m above take-off: too close to the ground.")
        if w["alt"] > max_height:
            problems.append(f"Waypoint {i} is above your height limit.")
        if not 0 <= w.get("hold", 0) <= MAX_HOVER:
            problems.append(f"Waypoint {i}: the pause must be 0 to {MAX_HOVER} seconds.")
    if wps:
        speed = route_speed(plan)
        if speed is None:
            problems.append("DJI Fly uses one speed for the whole route: give every waypoint the same speed first.")
        elif not MIN_SPEED <= speed <= MAX_SPEED:
            problems.append(f"The speed must be {MIN_SPEED:g} to {MAX_SPEED:g} m/s.")
    return problems


def _num(value):
    """A number the way DJI Fly writes it: 50, 2.5, 4.3 (no trailing zeros)."""
    value = round(float(value), 2)
    return str(int(value)) if value == int(value) else f"{value:g}"


def _mission_config(finish, lost, speed):
    return f"""    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>{finish}</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>{lost}</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>{_num(speed)}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>{DRONE_ENUM}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>0</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>
"""


def _template(finish, lost, speed, now_ms):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="{NAMESPACE}">
  <Document>
    <wpml:author>fly</wpml:author>
    <wpml:createTime>{now_ms}</wpml:createTime>
    <wpml:updateTime>{now_ms}</wpml:updateTime>
{_mission_config(finish, lost, speed)}  </Document>
</kml>
"""


def _action(action_id, func, params):
    return f"""          <wpml:action>
            <wpml:actionId>{action_id}</wpml:actionId>
            <wpml:actionActuatorFunc>{func}</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
{params}            </wpml:actionActuatorFuncParam>
          </wpml:action>
"""


def _group(group_id, start, end, actions):
    return f"""        <wpml:actionGroup>
          <wpml:actionGroupId>{group_id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>{start}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>{end}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>parallel</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>
          </wpml:actionTrigger>
{actions}        </wpml:actionGroup>
"""


def _hover(seconds):
    return f"              <wpml:hoverTime>{seconds}</wpml:hoverTime>\n"


GIMBAL_ROTATE = """              <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>0</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
"""
GIMBAL_EVENLY = """              <wpml:gimbalPitchRotateAngle>0</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
"""


def _placemark(i, last, w, speed, straight, next_action):
    """One waypoint, with the same actions DJI Fly adds:
       group 1 at the point itself (the first point sets the gimbal; a pause
       is a hover, after the gimbal at the first point), group 2 levels the
       gimbal on the way to the next point."""
    end_point = i == 0 or i == last
    groups = ""
    hover = round(w.get("hold", 0))
    here = _action(next_action(), "gimbalRotate", GIMBAL_ROTATE) if i == 0 else ""
    if hover > 0:
        here += _action(next_action(), "hover", _hover(hover))
    if here:
        groups += _group(1, i, i, here)
    if i != last:
        groups += _group(2, i, i + 1, _action(next_action(), "gimbalEvenlyRotate", GIMBAL_EVENLY))
    turn = "toPointAndStopWithContinuityCurvature" if end_point else "toPointAndPassWithContinuityCurvature"
    return f"""      <Placemark>
        <Point>
          <coordinates>
            {w["lon"]},{w["lat"]}
          </coordinates>
        </Point>
        <wpml:index>{i}</wpml:index>
        <wpml:executeHeight>{_num(w["alt"])}</wpml:executeHeight>
        <wpml:waypointSpeed>{_num(speed)}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>{1 if end_point else 0}</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
          <wpml:waypointHeadingPoiIndex>0</wpml:waypointHeadingPoiIndex>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>{turn}</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>{1 if straight else 0}</wpml:useStraightLine>
{groups}        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
      </Placemark>
"""


def _waylines(wps, finish, lost, speed, straight):
    counter = {"n": 0}

    def next_action():
        counter["n"] += 1
        return counter["n"]

    marks = "".join(_placemark(i, len(wps) - 1, w, speed, straight, next_action) for i, w in enumerate(wps))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="{NAMESPACE}">
  <Document>
{_mission_config(finish, lost, speed)}    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>0</wpml:distance>
      <wpml:duration>0</wpml:duration>
      <wpml:autoFlightSpeed>{_num(AUTO_FLIGHT_SPEED)}</wpml:autoFlightSpeed>
{marks}    </Folder>
  </Document>
</kml>
"""


def build_kmz(plan, max_height, finish="goHome", lost="goBack", straight=False, now=None):
    """The .kmz file's bytes. Raises MissionError if the plan can't be sent."""
    if finish not in FINISH or lost not in LOST:
        raise MissionError("Unknown choice for the end of the flight or a lost signal.")
    problems = check(plan, max_height)
    if problems:
        raise MissionError(" ".join(problems))
    speed = route_speed(plan)
    now_ms = int((now or time.time()) * 1000)
    files = {
        "wpmz/template.kml": _template(finish, lost, speed, now_ms),
        "wpmz/waylines.wpml": _waylines(plan["waypoints"], finish, lost, speed, straight),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        for name, text in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))   # like DJI Fly: no real date
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, text.encode("utf-8"))
    return out.getvalue()
