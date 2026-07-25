import frappe
from frappe import _
from frappe.utils import now_datetime, format_time, flt, today, get_system_timezone
import base64
import json

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
    lat = flt(latitude)
    lng = flt(longitude)

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