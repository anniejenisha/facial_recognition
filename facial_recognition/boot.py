import frappe

def boot_session(bootinfo):
    bootinfo.default_route = "/app/facial_recognition"