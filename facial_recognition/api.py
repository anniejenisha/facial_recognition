import frappe
from frappe import _
from frappe.utils import now_datetime, format_time, flt, today, get_system_timezone
import base64
import io
import json
import math

try:
    import pytz
except ImportError:
    pytz = None

try:
    import face_recognition
except Exception:
    # Catch ANY failure here (ImportError, OSError from missing shared libs
    # like liblapack/libopenblas at runtime, etc). If this import fails and
    # isn't caught broadly, the whole api.py module fails to load, which
    # silently breaks every whitelisted method in this file -- not just the
    # face verification one. Log it so it's visible in the Error Log.
    frappe.log_error(title="face_recognition import failed", message=frappe.get_traceback())
    face_recognition = None

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

# Lower = stricter match. face_recognition's own docs recommend ~0.6 as the
# default cutoff; 0.45-0.5 is tighter and reduces false-accepts for attendance use cases.
FACE_MATCH_TOLERANCE = 0.5


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


# --- FACE VERIFICATION HELPERS ---

def _resolve_file_absolute_path(file_url):
    """Resolve a Frappe file_url (e.g. '/files/emp.jpg' or '/private/files/emp.jpg')
    to an absolute path on disk, using the File doctype record when available."""
    if not file_url:
        return None

    file_name = frappe.db.get_value("File", {"file_url": file_url}, "name")
    if file_name:
        try:
            file_doc = frappe.get_doc("File", file_name)
            return file_doc.get_full_path()
        except Exception:
            frappe.log_error(title="Face Verification: File resolve error", message=frappe.get_traceback())

    # Fallback: construct the path manually from the site path
    relative_path = file_url.lstrip("/")
    return frappe.utils.get_site_path(relative_path)


def _decode_live_image_bytes(image_base64):
    if "," in image_base64:
        image_data = image_base64.split(",")[1]
    else:
        image_data = image_base64

    try:
        return base64.b64decode(image_data)
    except Exception as e:
        frappe.throw(_("Error parsing captured image frame: {0}").format(str(e)))


def _get_face_encoding_from_path(image_path, context_label):
    try:
        image_array = face_recognition.load_image_file(image_path)
    except Exception:
        frappe.log_error(title="Face Verification: image load error", message=frappe.get_traceback())
        frappe.throw(_("Could not load {0} for face verification.").format(context_label))

    encodings = face_recognition.face_encodings(image_array)
    return encodings


def _get_face_encoding_from_bytes(image_bytes, context_label):
    try:
        image_array = face_recognition.load_image_file(io.BytesIO(image_bytes))
    except Exception:
        frappe.log_error(title="Face Verification: image load error", message=frappe.get_traceback())
        frappe.throw(_("Could not process {0}.").format(context_label))

    encodings = face_recognition.face_encodings(image_array)
    return encodings


def verify_face_match(baseline_image_url, live_image_bytes):
    """
    Compares the captured selfie against the employee's registered baseline photo.
    Returns (is_match: bool, error_message: str | None).
    A non-None error_message means verification could not even be attempted
    (e.g. no face detected) and should be surfaced to the user as-is.
    """
    if face_recognition is None:
        frappe.throw(
            _("Face verification library is not installed on the server. "
              "Please ask your system administrator to install 'face_recognition'.")
        )

    baseline_path = _resolve_file_absolute_path(baseline_image_url)
    if not baseline_path:
        frappe.throw(_("No baseline profile photo found in Employee Master. Please upload a profile photo first."))

    baseline_encodings = _get_face_encoding_from_path(baseline_path, _("baseline profile photo"))
    if not baseline_encodings:
        frappe.throw(
            _("No face detected in the employee's baseline profile photo. "
              "Please ask HR/Admin to upload a clearer profile photo.")
        )

    live_encodings = _get_face_encoding_from_bytes(live_image_bytes, _("the captured selfie image"))
    if not live_encodings:
        return False, _("No face detected in the captured selfie. Please ensure your face is clearly visible and try again.")

    if len(live_encodings) > 1:
        return False, _("Multiple faces detected in the captured selfie. Please ensure only your face is visible and try again.")

    face_distance = face_recognition.face_distance([baseline_encodings[0]], live_encodings[0])[0]
    is_match = bool(face_distance <= FACE_MATCH_TOLERANCE)

    return is_match, None


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

    # --- Face verification (real check, not a placeholder) ---
    live_image_bytes = _decode_live_image_bytes(image_base64)

    is_match, verification_error = verify_face_match(employee.image, live_image_bytes)

    if verification_error:
        # Could not even attempt a comparison (no face / multiple faces found)
        frappe.throw(verification_error)

    if not is_match:
        frappe.throw(_("Face verification failed. Employee Checkin cannot be created."))

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
        "geolocation": json.dumps(geolocation_data)
    })

    checkin_doc.insert(ignore_permissions=True)
    frappe.db.commit()

    railway_time = format_time(checkin_time, "HH:mm")
    action_text = _("Checked IN") if log_type == "IN" else _("Checked OUT")

    return {
        "status": "Success",
        "message": _("Biometric log registered successfully: {0} at {1}").format(action_text, railway_time)
    }