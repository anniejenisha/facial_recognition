"""
Hikvision DS-K1T341AMF -> ERPNext (Frappe Cloud) Employee Checkin Sync
DRY RUN VERSION - prints what WOULD be synced. Creates nothing in ERPNext.
------------------------------------------------------------------------
Use this to verify device connectivity + employee mapping before switching
to the real sync script that actually creates Employee Checkins.

Install:
    pip install requests

Run:
    python3 sync_dry_run.py
"""

import json
from datetime import datetime, timedelta

import requests
from requests.auth import HTTPDigestAuth

# ============================================================
# CONFIG - edit these for THIS location
# ============================================================

DEVICE_NAME = "IN-Device"
DEVICE_IP = "192.168.1.201"
DEVICE_PORT = 80
DEVICE_USER = "admin"
DEVICE_PASSWORD = "HAZE123qsd"
LOG_TYPE = "IN"
USE_HTTPS = False

TZ_OFFSET = "+05:30"

ERP_URL = "https://truegroup.c.frappe.cloud"
ERP_API_KEY = "0e13f224037d193"
ERP_API_SECRET = "a39ee3705f33be3"

# How far back to look for this test run (dry run doesn't use sync_state.json,
# so specify a window manually)
LOOKBACK_HOURS = 24

PAGE_SIZE = 30

HEADERS_ERP = {
    "Authorization": f"token {ERP_API_KEY}:{ERP_API_SECRET}",
    "Content-Type": "application/json",
}

# ============================================================


def get_employee_by_device_id(employee_no):
    """Read-only lookup - does not modify anything in ERPNext."""
    try:
        resp = requests.get(
            f"{ERP_URL}/api/resource/Employee",
            headers=HEADERS_ERP,
            params={
                "filters": json.dumps([["attendance_device_id", "=", str(employee_no)]]),
                "fields": json.dumps(["name"]),
                "limit_page_length": 1,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json().get("data", [])
        return data[0]["name"] if data else None
    except Exception as e:
        return f"[ERROR checking ERPNext: {e}]"


def fetch_events(start_dt, end_dt):
    scheme = "https" if USE_HTTPS else "http"
    url = f"{scheme}://{DEVICE_IP}:{DEVICE_PORT}/ISAPI/AccessControl/AcsEvent?format=json"
    auth = HTTPDigestAuth(DEVICE_USER, DEVICE_PASSWORD)

    all_events = []
    position = 0

    while True:
        body = {
            "AcsEventCond": {
                "searchID": "1",
                "searchResultPosition": position,
                "maxResults": PAGE_SIZE,
                "major": 0,
                "minor": 0,
                "startTime": start_dt.strftime("%Y-%m-%dT%H:%M:%S") + TZ_OFFSET,
                "endTime": end_dt.strftime("%Y-%m-%dT%H:%M:%S") + TZ_OFFSET,
            }
        }
        resp = requests.post(url, auth=auth, json=body, timeout=20, verify=USE_HTTPS)
        resp.raise_for_status()
        data = resp.json()

        info_list = data.get("AcsEvent", {}).get("InfoList", [])
        all_events.extend(info_list)

        num_matches = data.get("AcsEvent", {}).get("numOfMatches", 0)
        if num_matches < PAGE_SIZE or not info_list:
            break
        position += PAGE_SIZE

    return all_events


def main():
    end_dt = datetime.now()
    start_dt = end_dt - timedelta(hours=LOOKBACK_HOURS)

    print("=" * 70)
    print(f"DRY RUN - {DEVICE_NAME} ({DEVICE_IP})  |  log_type = {LOG_TYPE}")
    print(f"Window: {start_dt}  ->  {end_dt}")
    print("NOTE: No Employee Checkins will be created. Read-only.")
    print("=" * 70)

    try:
        events = fetch_events(start_dt, end_dt)
    except Exception as e:
        print(f"\nERROR: could not reach device - {e}")
        return

    print(f"\nFetched {len(events)} raw events from device.\n")

    person_events = 0
    for i, ev in enumerate(events, 1):
        employee_no = ev.get("employeeNoString")
        raw_time = ev.get("time")
        major = ev.get("major")
        minor = ev.get("minor")

        if not employee_no or not raw_time:
            print(f"[{i}] SKIP (non-person event) major={major} minor={minor}")
            continue

        person_events += 1
        employee = get_employee_by_device_id(employee_no)
        match_status = "MATCHED" if employee and not str(employee).startswith("[ERROR") else "NO MATCH"

        print(f"[{i}] time={raw_time}  device_person_id={employee_no}  "
              f"-> ERPNext employee={employee}  ({match_status})  "
              f"would_create: employee_checkin(log_type={LOG_TYPE})")

    print("\n" + "-" * 70)
    print(f"Total events: {len(events)}  |  Person punches: {person_events}")
    print("Dry run complete. No data was written to ERPNext.")
    print("-" * 70)


if __name__ == "__main__":
    main()