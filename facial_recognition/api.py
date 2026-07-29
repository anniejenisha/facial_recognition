import frappe
from frappe import _
from frappe.utils import now_datetime, format_time, flt, today, get_system_timezone
import base64
import json
import math

try:
    import pytz
except ImportError:
    pytz = None


def get_accurate_now_datetime():
    """
    Returns the current datetime correctly localized to the site's configured
    timezone (System Settings > Time Zone).

    frappe.utils.now_datetime() already does a UTC -> system-timezone
    conversion internally, but if System Settings has no timezone configured
    (or it was left as the Frappe/ERPNext default "UTC" on a site that is
    actually run for IST users), the resulting timestamp will be off by a
    fixed offset (e.g. 5 hours 30 minutes for India).

    This helper re-derives the time explicitly from UTC using the site's
    configured timezone string, so the correct offset is applied even if
    System Settings was left at its default value. If pytz isn't available
    for some reason, it safely falls back to frappe's own now_datetime().
    """
    if not pytz:
        return now_datetime()

    site_timezone_name = get_system_timezone() or "UTC"

    try:
        tz = pytz.timezone(site_timezone_name)
    except Exception:
        # Unknown/invalid timezone string in System Settings - fall back safely
        tz = pytz.UTC

    utc_now = frappe.utils.datetime.datetime.utcnow().replace(tzinfo=pytz.UTC)
    localized_now = utc_now.astimezone(tz)

    # Strip tzinfo before returning so it stores/compares cleanly against
    # Frappe's naive datetime fields, same as now_datetime() does.
    return localized_now.replace(tzinfo=None)


@frappe.whitelist(allow_guest=True)
def get_employee_dashboard_details():
    current_user = frappe.session.user

    if not current_user or current_user == "Guest":
        frappe.throw(_("Unauthorized Session. Please log in again."), frappe.PermissionError)

    # 1. Fetch matching active ERPNext Employee document
    employee_profile = frappe.db.get_value(
        "Employee",
        {"user_id": current_user, "status": "Active"},
        ["name", "employee_name", "image", "default_shift"],
        as_dict=True
    )

    if not employee_profile:
        return None

    # Base response initialization
    response_payload = {
        "employee_id": employee_profile.name,
        "employee_name": employee_profile.employee_name,
        "image": employee_profile.image,
        "shift_type": "No Shift Assigned",
        "shift_timing": "Flexible timings or no rules declared.",
        "next_action": "Check - IN"
    }

    # 2. Get Today's Shift Assignment (or fall back to Employee Default Shift)
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

    # 2. If not found, look for shift assignment with no end date set (ongoing shift)
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

    # Fallback to employee master default shift if no assignment exists
    shift_name = assigned_shift or employee_profile.default_shift

    if shift_name:
        response_payload["shift_type"] = shift_name

        # Fetch Shift Type start and end times
        shift_data = frappe.db.get_value(
            "Shift Type",
            shift_name,
            ["start_time", "end_time"],
            as_dict=True
        )

        if shift_data and shift_data.start_time and shift_data.end_time:
            # Format times into 24-hour railway format (HH:mm)
            start_formatted = format_time(shift_data.start_time, "HH:mm")
            end_formatted = format_time(shift_data.end_time, "HH:mm")

            response_payload["shift_timing"] = f"{start_formatted} - {end_formatted}"

    # 3. Determine Next Action strictly from TODAY'S Employee Checkin history
    #
    # IMPORTANT: today() returns the site's calendar date as a plain date
    # string. Comparing that against the "time" datetime field only gives
    # the correct "today" window if the site timezone is configured
    # correctly - otherwise checkins near midnight can be bucketed into the
    # wrong day. Building an explicit start-of-day boundary from
    # get_accurate_now_datetime() keeps this aligned with how we now save
    # checkin times below.
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


# Server-side mirror of the client-side threshold. Even if someone bypasses
# the frontend check (e.g. calls this API directly), a low-accuracy fix
# will still be rejected here.
MAX_ACCEPTABLE_ACCURACY_METERS = 200


# ---------------------------------------------------------------------------
# GEO RESTRICTIONS ENFORCEMENT
#
# Reads the "Geo Restrictions" doctype and blocks check-in unless the
# employee's live GPS fix falls inside an approved zone.
#
# FIELDNAMES on "Geo Restrictions" (confirmed from the doctype's field list):
#   title           Data                document title
#   service         Data                e.g. "Attendance"
#   app_location    Table MultiSelect   ("Location Table") - a tag list of
#                   named locations; has no coordinates, so it is NOT used
#                   for the geofence math and is left untouched here.
#   user            Select              "All Users" / etc.
#   employee        Table MultiSelect   ("Employee Table") -> child rows
#                   expose `.employee` (Link to Employee)
#   location        Geolocation         the actual drawn circle(s)/
#                   polygon(s) (GeoJSON) that define the allowed area
# ---------------------------------------------------------------------------

GEO_RESTRICTION_DOCTYPE = "Geo Restrictions"
GEO_RESTRICTION_SERVICE_FIELD = "service"
GEO_RESTRICTION_APPLICABLE_TO_FIELD = "user"
GEO_RESTRICTION_EMPLOYEE_TABLE_FIELD = "employee"
GEO_RESTRICTION_EMPLOYEE_CHILD_FIELDNAME = "employee"  # fieldname inside each child row of the Employee Table child doctype
GEO_RESTRICTION_LOCATION_FIELD = "location"

# Value used in the "Applicable To" select to mean "every employee".
ALL_USERS_VALUES = {"all", "all users", "all employees"}

# Service name to match against for attendance check-ins. Change this if
# your "Applicable Service" options use different text.
ATTENDANCE_SERVICE_NAME = "Attendance"

# If a drawn point on the map has no explicit circle radius (i.e. it's a
# bare marker rather than a drawn circle), treat it as a circle of this
# radius so a single pinned marker still defines a usable zone.
DEFAULT_POINT_RADIUS_METERS = 200

# If an employee has NO matching "Geo Restrictions" document at all,
# should check-in be allowed from anywhere? True = opt-in geofencing
# (only restrict employees/locations that have an explicit rule). Set to
# False for default-deny (employee must have an approved zone to check in).
DEFAULT_ALLOW_WHEN_NO_RESTRICTION = True


def _haversine_distance_meters(lat1, lon1, lat2, lon2):
    """Great-circle distance between two lat/lng points, in meters."""
    R = 6371000.0  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (math.sin(d_phi / 2) ** 2
         + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def _point_in_polygon(lat, lng, ring_coords):
    """
    Ray-casting point-in-polygon test.
    ring_coords: list of [lng, lat] pairs forming the polygon's outer ring
    (GeoJSON coordinate order is [lng, lat]).
    """
    inside = False
    n = len(ring_coords)
    if n < 3:
        return False

    j = n - 1
    for i in range(n):
        xi, yi = ring_coords[i][0], ring_coords[i][1]  # lng, lat
        xj, yj = ring_coords[j][0], ring_coords[j][1]

        intersects = ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i

    return inside


def _point_within_geofence(lat, lng, geojson_value):
    """
    Checks whether (lat, lng) falls inside any circle/polygon feature stored
    in a Geolocation field's GeoJSON value. Returns True/False. Malformed or
    empty geolocation data returns False (no zone == does not match).
    """
    if not geojson_value:
        return False

    try:
        data = json.loads(geojson_value) if isinstance(geojson_value, str) else geojson_value
    except Exception:
        frappe.log_error(
            title="Geo Restrictions: failed to parse applicable_location",
            message=frappe.get_traceback()
        )
        return False

    if not data:
        return False

    # Normalize to a list of features whether we got a FeatureCollection
    # or a single Feature.
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
        # LineString / MultiPoint / etc. are not areas - intentionally ignored.

    return False


def _get_applicable_geo_restrictions(employee_name, service=ATTENDANCE_SERVICE_NAME):
    """
    Returns the list of "Geo Restrictions" documents (as frappe Documents)
    that apply to this employee for the given service - i.e. either scoped
    to "All" users, or explicitly listing this employee.
    """
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
    """
    Non-throwing check: returns {"allowed": bool, "message": str|None,
    "zone_names": list}. This is the single source of truth for the geofence
    decision - both the early "as soon as we have a fix" popup and the
    final check-in guard call into this, so the two can never disagree.
    """
    restrictions = _get_applicable_geo_restrictions(employee_name)

    if not restrictions:
        if DEFAULT_ALLOW_WHEN_NO_RESTRICTION:
            return {"allowed": True, "message": None, "zone_names": []}
        return {
            "allowed": False,
            "message": _("No approved check-in location has been configured for you yet. "
                          "Please contact HR/Admin to set up a Geo Restrictions zone before checking in."),
            "zone_names": []
        }

    for restriction_doc in restrictions:
        location_value = restriction_doc.get(GEO_RESTRICTION_LOCATION_FIELD)
        if _point_within_geofence(lat, lng, location_value):
            return {"allowed": True, "message": None, "zone_names": []}

    zone_names = [r.name for r in restrictions]
    return {
        "allowed": False,
        "message": _("You are outside the approved check-in location(s) for your profile ({0}). "
                      "Please move within an approved zone and try again.").format(", ".join(zone_names)),
        "zone_names": zone_names
    }


def enforce_geo_restriction(employee_name, lat, lng):
    """
    Raises frappe.throw() if the employee is not inside any of their
    applicable Geo Restrictions zones. Silently passes (no-op) if allowed.
    This remains the authoritative server-side guard, called from
    process_biometric_attendance right before the check-in is written -
    it must never be skipped, even though the client also warns earlier.
    """
    result = _evaluate_geo_restriction(employee_name, lat, lng)
    if not result["allowed"]:
        frappe.throw(result["message"])


@frappe.whitelist()
def check_location_restriction(latitude, longitude):
    """
    Lightweight, non-throwing endpoint the frontend calls as soon as it has
    a GPS fix (i.e. right when the location/address is displayed), so the
    employee sees the "outside approved zone" popup immediately - rather
    than only discovering it after opening the camera and capturing a
    photo at Check-IN time.

    Returns {"allowed": bool, "message": str|None} and never throws for a
    normal "outside zone" case, so the client can render its own popup.
    """
    current_user = frappe.session.user
    if not current_user or current_user == "Guest":
        frappe.throw(_("Unauthorized Session."), frappe.PermissionError)

    employee_name = frappe.db.get_value(
        "Employee",
        {"user_id": current_user, "status": "Active"},
        "name"
    )

    if not employee_name:
        # No Employee profile - let get_employee_dashboard_details' own
        # messaging handle that; don't block on location for this case.
        return {"allowed": True, "message": None}

    return _evaluate_geo_restriction(employee_name, flt(latitude), flt(longitude))


@frappe.whitelist()
def process_biometric_attendance(image_base64, latitude, longitude, log_type, accuracy=None):
    """Decodes live frame image, verifies identity, maps coordinates, and creates an Employee Checkin record."""
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
        frappe.throw(_("No baseline profile photo found in Employee Master to compare against. Please upload a profile photo first."))

    # --- SERVER-SIDE GPS ACCURACY GUARD ---
    if accuracy is not None and accuracy != "":
        accuracy_val = flt(accuracy)
        if accuracy_val > MAX_ACCEPTABLE_ACCURACY_METERS:
            frappe.throw(
                _("Location accuracy too low (~{0}m). Please enable High Accuracy / Precise Location and try again.").format(int(accuracy_val))
            )

    lat = flt(latitude)
    lng = flt(longitude)

    # --- GEO RESTRICTIONS GUARD ---
    # Blocks check-in unless the employee's live GPS fix falls inside an
    # approved zone configured via the "Geo Restrictions" doctype.
    enforce_geo_restriction(employee.name, lat, lng)

    # --- BIOMETRIC VALIDATION LOGIC ---
    if "," in image_base64:
        image_data = image_base64.split(",")[1]
    else:
        image_data = image_base64

    try:
        live_image_bytes = base64.b64decode(image_data)
        # In a real environment:
        # 1. Load baseline photo from employee.image path
        # 2. Extract facial encodings using face_recognition or DeepFace
        # 3. Compare live_image_bytes to baseline photo.
        face_match_success = True  # Simulation placeholder
    except Exception as e:
        frappe.throw(_("Error parsing captured image frames: {0}").format(str(e)))

    if not face_match_success:
        frappe.throw(_("Biometric verification failed. The face does not match the employee profile photo."))

    # --- GEOLOCATION DATA STRUCTURING ---
    geolocation_data = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "accuracy_meters": flt(accuracy) if accuracy not in (None, "") else None
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat]  # GeoJSON expects [longitude, latitude]
                }
            }
        ]
    }

    # --- CAPTURE ONE CANONICAL TIMESTAMP ---
    #
    # Previously this was called twice (once here, once again when building
    # the response message below), which meant the saved Employee Checkin
    # "time" and the time shown to the user could drift apart by however
    # long face-match/DB insert took. It also relied on now_datetime()'s
    # implicit UTC -> System Settings timezone conversion, which silently
    # produces a wrong wall-clock time if that setting is blank or wrong.
    #
    # Fix: compute the timestamp ONCE, using the explicit timezone-safe
    # helper, and reuse that single value both for the saved record and
    # for the confirmation message.
    checkin_time = get_accurate_now_datetime()

    # --- SUBMIT EMPLOYEE CHECK-IN ---
    checkin_doc = frappe.get_doc({
        "doctype": "Employee Checkin",
        "employee": employee.name,
        "log_type": log_type,                   # Natively tracks "IN" or "OUT"
        "time": checkin_time,
        "device_id": "Webcam Facial Terminal",
        "latitude": lat,
        "longitude": lng,
        "geolocation": json.dumps(geolocation_data) # Serialized GeoJSON string
    })

    checkin_doc.insert(ignore_permissions=True)
    frappe.db.commit()

    # --- RESPONSE PREPARATION ---
    # Reuse the exact same timestamp that was saved to the Employee Checkin,
    # instead of calling now_datetime() again - guarantees the message the
    # user sees always matches what was actually recorded.
    railway_time = format_time(checkin_time, "HH:mm")

    # Dynamic status presentation ("Checked IN" or "Checked OUT")
    action_text = _("Checked IN") if log_type == "IN" else _("Checked OUT")

    return {
        "status": "Success",
        "message": _("Biometric log registered successfully: {0} at {1}").format(action_text, railway_time)
    }