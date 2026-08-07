import frappe
from frappe import _
from frappe.utils import now_datetime, format_time, flt, today, get_system_timezone, get_site_path
import base64
import json
import math
import os
import uuid
import numpy as np

try:
    import pytz
except ImportError:
    pytz = None

MAX_ACCEPTABLE_ACCURACY_METERS = 200
GEO_RESTRICTION_DOCTYPE = "Geo Restrictions"
GEO_RESTRICTION_SERVICE_FIELD = "service"
GEO_RESTRICTION_APPLICABLE_TO_FIELD = "user"
GEO_RESTRICTION_EMPLOYEE_TABLE_FIELD = "employee"
GEO_RESTRICTION_EMPLOYEE_CHILD_FIELDNAME = "employee"
GEO_RESTRICTION_LOCATION_FIELD = "location"

ALL_USERS_VALUES = {"all", "all users", "all employees"}
ATTENDANCE_SERVICE_NAME = "Attendance"
DEFAULT_POINT_RADIUS_METERS = 200
DEFAULT_ALLOW_WHEN_NO_RESTRICTION = True


def get_accurate_now_datetime():
    """Returns current datetime localized explicitly to system timezone."""
    if not pytz:
        return now_datetime()

    site_timezone_name = get_system_timezone() or "UTC"
    try:
        tz = pytz.timezone(site_timezone_name)
    except Exception:
        tz = pytz.UTC

    utc_now = frappe.utils.datetime.datetime.utcnow().replace(tzinfo=pytz.UTC)
    localized_now = utc_now.astimezone(tz)
    return localized_now.replace(tzinfo=None)


@frappe.whitelist(allow_guest=True)
def get_employee_dashboard_details():
    current_user = frappe.session.user

    if not current_user or current_user == "Guest":
        frappe.throw(_("Unauthorized Session. Please log in again."), frappe.PermissionError)

    # Fetch active Employee
    employee_profile = frappe.db.get_value(
        "Employee",
        {"user_id": current_user, "status": "Active"},
        ["name", "employee_name", "image", "default_shift"],
        as_dict=True
    )

    if not employee_profile:
        return None

    response_payload = {
        "employee_id": employee_profile.name,
        "employee_name": employee_profile.employee_name,
        "image": employee_profile.image,
        "shift_type": "No Shift Assigned",
        "shift_timing": "Flexible timings or no rules declared.",
        "next_action": "Check - IN"
    }

    # Fetch Today's Shift Assignment
    assigned_shift = frappe.db.get_value(
        "Shift Assignment",
        {
            "employee": employee_profile.name,
            "start_date": ["<=", today()],
            "end_date": [">=", today()],
            "docstatus": 1
        },
        "shift_type"
    )

    if not assigned_shift:
        assigned_shift = frappe.db.get_value(
            "Shift Assignment",
            {
                "employee": employee_profile.name,
                "start_date": ["<=", today()],
                "end_date": ("is", "not set"),
                "docstatus": 1
            },
            "shift_type"
        )

    shift_name = assigned_shift or employee_profile.default_shift

    if shift_name:
        response_payload["shift_type"] = shift_name
        shift_data = frappe.db.get_value(
            "Shift Type",
            shift_name,
            ["start_time", "end_time"],
            as_dict=True
        )

        if shift_data and shift_data.start_time and shift_data.end_time:
            start_formatted = format_time(shift_data.start_time, "HH:mm")
            end_formatted = format_time(shift_data.end_time, "HH:mm")
            response_payload["shift_timing"] = f"{start_formatted} - {end_formatted}"

    # Determine Next Action (IN / OUT)
    day_start = get_accurate_now_datetime().replace(hour=0, minute=0, second=0, microsecond=0)

    todays_last_checkin = frappe.get_all(
        "Employee Checkin",
        filters={
            "employee": employee_profile.name,
            "time": [">=", day_start]
        },
        fields=["log_type"],
        order_by="time desc",
        limit_page_length=1
    )

    if todays_last_checkin and todays_last_checkin[0].log_type == "IN":
        response_payload["next_action"] = "Check - OUT"
    else:
        response_payload["next_action"] = "Check - IN"

    return response_payload


# --- GEOFENCING MATH HELPERS ---

def _haversine_distance_meters(lat1, lon1, lat2, lon2):
    R = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (math.sin(d_phi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def _point_in_polygon(lat, lng, ring_coords):
    inside = False
    n = len(ring_coords)
    if n < 3:
        return False

    j = n - 1
    for i in range(n):
        xi, yi = ring_coords[i][0], ring_coords[i][1]
        xj, yj = ring_coords[j][0], ring_coords[j][1]

        intersects = ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i

    return inside


def _point_within_geofence(lat, lng, geojson_value):
    if not geojson_value:
        return False

    try:
        data = json.loads(geojson_value) if isinstance(geojson_value, str) else geojson_value
    except Exception:
        frappe.log_error(title="Geo Restrictions JSON Parse Error", message=frappe.get_traceback())
        return False

    if not data:
        return False

    if data.get("type") == "FeatureCollection":
        features = data.get("features") or []
    elif data.get("type") == "Feature":
        features = [data]
    else:
        features = []

    for feature in features:
        geometry = feature.get("geometry") or {}
        gtype = geometry.get("type")
        props = feature.get("properties") or {}
        coords = geometry.get("coordinates")

        if not coords:
            continue

        if gtype == "Point":
            center_lng, center_lat = coords[0], coords[1]
            radius = props.get("radius")
            radius_m = flt(radius) if radius not in (None, "") else DEFAULT_POINT_RADIUS_METERS
            if _haversine_distance_meters(lat, lng, center_lat, center_lng) <= radius_m:
                return True

        elif gtype == "Polygon":
            outer_ring = coords[0] if coords else []
            if _point_in_polygon(lat, lng, outer_ring):
                return True

        elif gtype == "MultiPolygon":
            for polygon in coords:
                outer_ring = polygon[0] if polygon else []
                if _point_in_polygon(lat, lng, outer_ring):
                    return True

    return False


def _get_applicable_geo_restrictions(employee_name, service=ATTENDANCE_SERVICE_NAME):
    restriction_names = frappe.get_all(
        GEO_RESTRICTION_DOCTYPE,
        filters={GEO_RESTRICTION_SERVICE_FIELD: service},
        pluck="name"
    )

    matched_docs = []
    for rname in restriction_names:
        doc = frappe.get_doc(GEO_RESTRICTION_DOCTYPE, rname)
        applicable_to = (doc.get(GEO_RESTRICTION_APPLICABLE_TO_FIELD) or "").strip().lower()
        applies_to_employee = applicable_to in ALL_USERS_VALUES

        if not applies_to_employee:
            for row in (doc.get(GEO_RESTRICTION_EMPLOYEE_TABLE_FIELD) or []):
                if row.get(GEO_RESTRICTION_EMPLOYEE_CHILD_FIELDNAME) == employee_name:
                    applies_to_employee = True
                    break

        if applies_to_employee:
            matched_docs.append(doc)

    return matched_docs


def _evaluate_geo_restriction(employee_name, lat, lng):
    restrictions = _get_applicable_geo_restrictions(employee_name)

    if not restrictions:
        if DEFAULT_ALLOW_WHEN_NO_RESTRICTION:
            return {"allowed": True, "message": None, "zone_names": []}
        return {
            "allowed": False,
            "message": _("No approved check-in location has been configured for you. Please contact HR/Admin."),
            "zone_names": []
        }

    for restriction_doc in restrictions:
        location_value = restriction_doc.get(GEO_RESTRICTION_LOCATION_FIELD)
        if _point_within_geofence(lat, lng, location_value):
            return {"allowed": True, "message": None, "zone_names": []}

    zone_names = [r.name for r in restrictions]
    return {
        "allowed": False,
        "message": _("You are outside the approved check-in location(s) for your profile ({0}).").format(", ".join(zone_names)),
        "zone_names": zone_names
    }


def enforce_geo_restriction(employee_name, lat, lng):
    result = _evaluate_geo_restriction(employee_name, lat, lng)
    if not result["allowed"]:
        frappe.throw(result["message"])


@frappe.whitelist()
def check_location_restriction(latitude, longitude):
    current_user = frappe.session.user
    if not current_user or current_user == "Guest":
        frappe.throw(_("Unauthorized Session."), frappe.PermissionError)

    employee_name = frappe.db.get_value(
        "Employee",
        {"user_id": current_user, "status": "Active"},
        "name"
    )

    if not employee_name:
        return {"allowed": True, "message": None}

    return _evaluate_geo_restriction(employee_name, flt(latitude), flt(longitude))


# ── Face Matching Helpers ─────────────────────────────────────────────────
_face_app = None


def _get_face_app():
    import insightface
    app = insightface.app.FaceAnalysis(name="buffalo_sc", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def _get_absolute_path(file_url: str) -> str:
    from frappe.utils.file_manager import get_file_path
    if file_url.startswith("/files/"):
        path = frappe.get_site_path("public", "files", file_url[len("/files/"):])
    elif file_url.startswith("/private/files/"):
        path = frappe.get_site_path("private", "files", file_url[len("/private/files/"):])
    else:
        path = get_file_path(file_url)
    return os.path.abspath(path)


def _get_embedding(app, image_path: str):
    import cv2
    img = cv2.imread(image_path)
    if img is None:
        return None
    faces = app.get(img)
    if not faces:
        return None
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return face.embedding


def _cosine_similarity(a, b) -> float:
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    return float(np.dot(a, b))


def _verify_face_match(live_image_bytes, employee_profile_image_url):
    """
    Saves the captured live image to a temp file, extracts its embedding,
    compares it against the employee's baseline profile photo.
    Returns (is_match: bool, score: float).
    """
    global _face_app
    if _face_app is None:
        _face_app = _get_face_app()

    tmp_dir = get_site_path("private", "files", "tmp_biometric")
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f"{uuid.uuid4().hex}.jpg")

    try:
        with open(tmp_path, "wb") as f:
            f.write(live_image_bytes)

        live_emb = _get_embedding(_face_app, tmp_path)
        if live_emb is None:
            return False, 0.0

        ref_emb = _get_embedding(_face_app, _get_absolute_path(employee_profile_image_url))
        if ref_emb is None:
            return False, 0.0

        score = round(_cosine_similarity(live_emb, ref_emb) * 100, 2)
        threshold = 50
        return score >= threshold, score
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@frappe.whitelist()
def process_biometric_attendance(image_base64, latitude, longitude, log_type, accuracy=None, address=None):
    current_user = frappe.session.user
    if not current_user or current_user == "Guest":
        frappe.throw(_("Unauthorized Session."), frappe.PermissionError)

    employee = frappe.db.get_value(
        "Employee",
        {"user_id": current_user, "status": "Active"},
        ["name", "employee_name", "image"],
        as_dict=True
    )

    if not employee:
        frappe.throw(_("No active Employee profile linked to this account."))

    if not employee.image:
        frappe.throw(_("No baseline profile photo found in Employee Master. Please upload a profile photo first."))

    if accuracy is not None and accuracy != "":
        accuracy_val = flt(accuracy)
        if accuracy_val > MAX_ACCEPTABLE_ACCURACY_METERS:
            frappe.throw(
                _("Location accuracy too low (~{0}m). Please enable High Accuracy / Precise Location and try again.").format(int(accuracy_val))
            )

    lat = flt(latitude)
    lng = flt(longitude)

    # Server Guard Enforcement
    enforce_geo_restriction(employee.name, lat, lng)

    # ── Real face verification ───────────────────────────────────────────
    if "," in image_base64:
        image_data = image_base64.split(",")[1]
    else:
        image_data = image_base64

    try:
        live_image_bytes = base64.b64decode(image_data)
    except Exception as e:
        frappe.throw(_("Error parsing captured image frame: {0}").format(str(e)))

    try:
        face_match_success, match_score = _verify_face_match(live_image_bytes, employee.image)
    except Exception as e:
        frappe.log_error(f"Face Match Error: {str(e)}", "Biometric Attendance")
        frappe.throw(_("Face verification could not be completed. Please try again."))

    if not face_match_success:
        frappe.throw(
            _("Biometric verification failed. The face does not match the employee profile photo (score: {0}%).").format(match_score)
        )

    geolocation_data = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "accuracy_meters": flt(accuracy) if accuracy not in (None, "") else None,
                    "address": address or ""
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat]
                }
            }
        ]
    }

    checkin_time = get_accurate_now_datetime()

    checkin_doc = frappe.get_doc({
        "doctype": "Employee Checkin",
        "employee": employee.name,
        "log_type": log_type,
        "time": checkin_time,
        "device_id": "Webcam Facial Terminal",
        "latitude": lat,
        "longitude": lng,
        "geolocation": json.dumps(geolocation_data),
        "custom_face_match_score": match_score
    })

    checkin_doc.insert(ignore_permissions=True)
    frappe.db.commit()

    railway_time = format_time(checkin_time, "HH:mm")
    action_text = _("Checked IN") if log_type == "IN" else _("Checked OUT")

    return {
        "status": "Success",
        "message": _("Biometric log registered successfully: {0} at {1}").format(action_text, railway_time),
        "match_score": match_score
    }


def send_checkout_reminders():
    """
    Run hourly via scheduler.
    Emails employees who checked IN more than 9 hours ago with no OUT.
    """
    from frappe.utils import add_to_date

    cutoff = add_to_date(get_accurate_now_datetime(), hours=-9)

    missed_ins = frappe.get_all(
        "Employee Checkin",
        filters={
            "log_type": "IN",
            "time": ["<=", cutoff]
        },
        fields=["name", "employee", "time"]
    )

    for rec in missed_ins:
        has_out = frappe.db.exists("Employee Checkin", {
            "employee": rec.employee,
            "log_type": "OUT",
            "time": [">=", rec.time]
        })
        if has_out:
            continue

        emp = frappe.get_doc("Employee", rec.employee)
        if not emp.user_id:
            continue

        frappe.sendmail(
            recipients=[emp.user_id],
            subject="⏰ Reminder: You haven't checked out yet",
            message=f"""
                <p>Hi <strong>{emp.employee_name}</strong>,</p>
                <p>You checked in at <strong>{rec.time}</strong>
                but haven't marked your check-out yet.</p>
                <p>Please check out to record your working hours correctly.</p>
                <br>
                <p style="color:#888;font-size:12px;">
                    This is an automated reminder from the HR system.
                </p>
            """
        )