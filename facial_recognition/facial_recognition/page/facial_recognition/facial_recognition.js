frappe.pages['facial-recognition'].on_page_load = function(wrapper) {
    var page = wrapper.page || frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Biometric Attendance',
        single_column: true
    });

    if (page && typeof page.set_title === "function") {
        page.set_title('Biometric Attendance');
    }

    $(wrapper).find('.layout-main-section').html(frappe.render_template('facial_recognition', {}));

    const $loginSec = $('#login-section');
    const $dashSec = $('#dashboard-section');

    let currentCoordinates = { latitude: null, longitude: null, accuracy: null };
    let currentActionState = "IN";
    let currentAddressText = "";
    let geoRestrictionStatus = { allowed: true, message: null, checked: false };
    let locationSource = "auto"; // "auto" (GPS) or "manual" (user-confirmed pin)

    const MAX_ACCEPTABLE_ACCURACY_METERS = 100;
    const GOOD_ACCURACY_METERS = 15;
    const LOCATION_REFINE_TIMEOUT_MS = 15000;
    const AUTO_RETRY_INTERVAL_MS = 5000;

    let watchId = null;
    let refineTimer = null;
    let autoRetryTimer = null;
    let locationFinalized = false;      // one-shot guard so a fix is only finalized once
    let geofenceRequestToken = 0;       // ignore stale geofence responses from an older fix
    let addressRequestToken = 0;        // ignore stale reverse-geocode responses from an older fix

    function setCheckinButtonEnabled(enabled) {
        const $btn = $('#btn-proceed-checkin');
        $btn.prop('disabled', !enabled);
        $btn.css({
            'opacity': enabled ? '1' : '0.45',
            'cursor': enabled ? 'pointer' : 'not-allowed',
            'filter': enabled ? 'none' : 'grayscale(40%)',
            'pointer-events': enabled ? 'auto' : 'none'
        });
    }

    function hideCheckinButton() {
        $('#btn-proceed-checkin').hide();
    }

    function showCheckinButton() {
        $('#btn-proceed-checkin').show();
    }

    function clearAutoRetry() {
        if (autoRetryTimer) {
            clearTimeout(autoRetryTimer);
            autoRetryTimer = null;
        }
    }

    function scheduleAutoRetry() {
        clearAutoRetry();
        autoRetryTimer = setTimeout(function() {
            fetchLocation(true /* isAutoRetry */);
        }, AUTO_RETRY_INTERVAL_MS);
    }

    // Chrome/Edge/Firefox support the Permissions API for geolocation.
    // If the user flips the browser-level permission back to "allow"
    // (after having denied it), this reloads the page automatically
    // instead of leaving them stuck on the old error state.
    let _permissionWatcherAttached = false;
    function watchGeolocationPermissionForAutoRecover() {
        if (_permissionWatcherAttached) return;
        if (!navigator.permissions || !navigator.permissions.query) return;

        navigator.permissions.query({ name: 'geolocation' }).then(function(status) {
            _permissionWatcherAttached = true;
            status.onchange = function() {
                if (status.state === 'granted') {
                    location.reload();
                }
            };
        }).catch(function() { /* Permissions API not supported for geolocation on this browser */ });
    }

    function parseDynamicAddress(data) {
        if (!data || !data.address) return ["Address unavailable"];
        let addr = data.address;
        let parts = [];

        let localArea = addr.road || addr.village || addr.suburb || addr.neighbourhood || addr.residential;
        if (localArea) parts.push(localArea);

        let cityOrTown = addr.town || addr.city || addr.subdistrict || addr.municipality;
        if (cityOrTown && cityOrTown !== localArea) parts.push(cityOrTown);

        let district = addr.state_district || addr.district;
        if (district) {
            let distClean = district.replace(/\s*district\s*/gi, '').trim();
            if (distClean) parts.push(`${distClean} District`);
        } else if (addr.county) {
            parts.push(addr.county);
        }

        if (addr.state) parts.push(addr.state);
        if (addr.postcode) parts.push(addr.postcode);

        return parts.length > 0 ? parts : (data.display_name ? [data.display_name] : ["Location details logged"]);
    }

    // ---------------------------------------------------------------------
    // Shared reverse-geocoding helper.
    // Used for auto (GPS/network) fixes AND manual map pins, and now also
    // for the "low accuracy" case so the person always sees a real address
    // instead of a generic error message — on both mobile and desktop.
    // ---------------------------------------------------------------------
    function resolveAddressLines(lat, lng) {
        return fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=en`)
            .then(response => response.json())
            .then(data => parseDynamicAddress(data))
            .catch(() => [`${lat.toFixed(6)}, ${lng.toFixed(6)} (Geocoding server unreachable)`]);
    }

    if (frappe.session.user && frappe.session.user !== "Guest") {
        initDashboard();
    } else {
        $loginSec.show();
    }

    $('#btn-login').on('click', function() {
        let usr = $('#login-username').val();
        let pwd = $('#login-password').val();

        if (!usr || !pwd) {
            frappe.msgprint(__('Please fill out all credential fields.'));
            return;
        }

        frappe.call({
            method: "frappe.core.doctype.user.user.login",
            args: { usr: usr, pwd: pwd },
            callback: function(r) {
                if (r.message === "Logged In") {
                    frappe.session.user = usr;
                    initDashboard();
                }
            }
        });
    });

    function initDashboard() {
        $loginSec.hide();
        $dashSec.show();
        fetchLocation();

        frappe.call({
            method: "facial_recognition.api.get_employee_dashboard_details",
            callback: function(r) {
                if (r.message) {
                    let data = r.message;
                    $('#emp-name').text(data.employee_name);
                    $('#emp-image').attr('src', data.image || '/assets/frappe/images/default-avatar.png');
                    $('#emp-shift').text(data.shift_type || 'No Shift Assigned');
                    $('#emp-timing').text(data.shift_timing || 'Flexible timings or no rules declared.');

                    currentActionState = (data.next_action && data.next_action.includes("OUT")) ? "OUT" : "IN";
                    let dynamicLabel = `Check - ${currentActionState}`;
                    $('#btn-proceed-checkin').html(`<i class="fa fa-camera"></i> ${dynamicLabel}`);
                } else {
                    frappe.msgprint(__('No active Employee profile linked to this user session.'));
                }
            }
        });
    }

    // ---------------------------------------------------------------------
    // AUTOMATIC LOCATION (GPS / network)
    // ---------------------------------------------------------------------

    function fetchLocation(isAutoRetry) {
        locationSource = "auto";

        if (!isAutoRetry) {
            clearAutoRetry();
        }

        if (!navigator.geolocation) {
            renderLocationUnavailable(__('Geolocation is not supported by this browser interface.'), false, null, isAutoRetry);
            return;
        }

        stopWatching();
        locationFinalized = false;

        showCheckinButton();
        $('#emp-location').html('Acquiring precise GPS coordinates...');
        currentAddressText = 'Resolving address details...';
        $('#emp-address').text(currentAddressText);
        setCheckinButtonEnabled(false);

        let bestFix = null;
        let positionUnavailableSeen = false;

        function tryFinalize(fix) {
            if (locationFinalized) return; // already finalized this round — ignore any late/duplicate callback
            locationFinalized = true;
            clearAutoRetry();
            finalizeLocation(fix);
        }

        watchId = navigator.geolocation.watchPosition(
            function(position) {
                if (locationFinalized) return;

                const coords = position.coords;

                if (!bestFix || coords.accuracy < bestFix.accuracy) {
                    bestFix = {
                        latitude: coords.latitude,
                        longitude: coords.longitude,
                        accuracy: coords.accuracy
                    };
                    renderLiveAccuracy(bestFix, bestFix.accuracy > GOOD_ACCURACY_METERS);
                }

                if (bestFix.accuracy <= GOOD_ACCURACY_METERS) {
                    tryFinalize(bestFix);
                }
            },
            function(error) {
                if (locationFinalized) return;

                if (error.code === error.PERMISSION_DENIED) {
                    stopWatching();
                    locationFinalized = true;
                    currentCoordinates = { latitude: null, longitude: null, accuracy: null };
                    renderLocationUnavailable(getGeolocationErrorMessage(error), true, null, isAutoRetry);
                    watchGeolocationPermissionForAutoRecover();
                    return;
                }

                if (error.code === error.POSITION_UNAVAILABLE) {
                    // Most commonly means device Location Services are switched off
                    // at the OS level. Keep waiting for the refine timeout below,
                    // but remember this so the timeout message is accurate.
                    positionUnavailableSeen = true;
                }
                // Transient error: keep whatever bestFix we already have, if any.
            },
            {
                enableHighAccuracy: true,
                timeout: LOCATION_REFINE_TIMEOUT_MS,
                maximumAge: 0
            }
        );

        refineTimer = setTimeout(function() {
            stopWatching();
            if (locationFinalized) return;

            if (bestFix) {
                tryFinalize(bestFix);
            } else {
                locationFinalized = true;
                const message = positionUnavailableSeen
                    ? __('Location Services appear to be turned off on this device.')
                    : __('Could not get a GPS fix in time.');
                renderLocationUnavailable(message, true, null, isAutoRetry);
            }
        }, LOCATION_REFINE_TIMEOUT_MS);
    }

    function stopWatching() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        if (refineTimer) {
            clearTimeout(refineTimer);
            refineTimer = null;
        }
    }

    function renderLiveAccuracy(fix, stillRefining) {
        const latLngStr = `${fix.latitude.toFixed(6)}, ${fix.longitude.toFixed(6)}`;
        let html = `<strong>${latLngStr}</strong>`;

        if (fix.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
            html += `<div class="text-danger font-weight-bold style-sub-text mt-1">
                        ⚠️ Low Accuracy (~${Math.round(fix.accuracy)}m radius)${stillRefining ? ' — refining hardware signal…' : ''}
                     </div>`;
        } else {
            html += `<div class="text-success font-weight-bold style-sub-text mt-1">
                        ✓ Precise GPS (~${Math.round(fix.accuracy)}m radius)${stillRefining ? ' — refining…' : ''}
                     </div>`;
        }
        $('#emp-location').html(html);
    }

    // ---------------------------------------------------------------------
    // Renders the resolved address into #emp-address.
    // extraHtml (optional) is appended below the address lines — used to
    // show the low-accuracy warning + retry/manual buttons without hiding
    // the actual address, on both mobile and desktop.
    // ---------------------------------------------------------------------
    function renderAddressBlock(addressLines, suffixForTitle, extraHtml) {
        currentAddressText = addressLines.join(", ") + (suffixForTitle ? ` ${suffixForTitle}` : "");

        let html = addressLines
            .map(line => `<div class="address-line">${frappe.utils.escape_html(line)}</div>`)
            .join("");

        if (extraHtml) {
            html += extraHtml;
        }

        $('#emp-address').html(html).attr('title', currentAddressText);
    }

    function finalizeLocation(fix) {
        stopWatching();
        clearAutoRetry();

        currentCoordinates.latitude = fix.latitude;
        currentCoordinates.longitude = fix.longitude;
        currentCoordinates.accuracy = fix.accuracy;
        locationSource = "auto";

        renderLiveAccuracy(fix, false);

        const accuracyOk = fix.accuracy <= MAX_ACCEPTABLE_ACCURACY_METERS;
        setCheckinButtonEnabled(accuracyOk);

        if (!accuracyOk) {
            // Still resolve and SHOW the real address — just alongside a
            // low-accuracy warning, instead of replacing it with an error.
            $('#emp-address').html(`<span class="text-muted">${__('Resolving address details...')}</span>`);
            hideCheckinButton();

            const myToken = ++addressRequestToken;

            resolveAddressLines(fix.latitude, fix.longitude).then(function(addressLines) {
                if (myToken !== addressRequestToken) return; // a newer fix superseded this lookup

                const warningHtml = `
                    <div class="text-danger font-weight-bold" style="font-size:12px; margin-top:6px;">
                        ⚠️ ${__('Accuracy too low')} (~${Math.round(fix.accuracy)}m) — ${__('please retry GPS or confirm on map before checking in')}
                    </div>
                    <div class="mt-2">
                    </div>`;

                renderAddressBlock(addressLines, `(Low accuracy ~${Math.round(fix.accuracy)}m)`, warningHtml);
            });

            frappe.msgprint({
                title: __('Location Accuracy Too Low'),
                indicator: 'orange',
                message: __(`Automatic accuracy is ~${Math.round(fix.accuracy)}m (need ${MAX_ACCEPTABLE_ACCURACY_METERS}m or better). This is common on laptops without GPS hardware. You can retry, or confirm your location manually on the map.`),
                
            });
            return;
        }

        proceedWithCoordinates();
    }

    function renderLocationUnavailable(customMessage, isPermissionOrTimeoutError, fallbackCenter, isAutoRetry) {
        $('#emp-location').html('<span class="text-danger font-weight-bold">Location Unavailable</span>');
        currentAddressText = customMessage || 'Location access failed or disabled';
        $('#emp-address').html(
            `<span class="text-danger">${frappe.utils.escape_html(currentAddressText)}</span>
             <div class="mt-2">
                <a href="#" id="btn-retry-location" class="btn btn-xs btn-default font-weight-bold">Retry</a>
                <a href="#" id="btn-manual-location" class="btn btn-xs btn-primary font-weight-bold">Set Location on Map</a>
             </div>`
        );
        setCheckinButtonEnabled(false);
        hideCheckinButton();

        if (isPermissionOrTimeoutError) {
            // Keep quietly re-checking in the background so that as soon as
            // the user flips Location Services back on, the app recovers
            // on its own without them needing to manually retry.
            scheduleAutoRetry();

            if (!isAutoRetry) {
                frappe.msgprint({
                    title: __('Location Services Disabled or Denied'),
                    indicator: 'red',
                    message: __('Please turn ON Location Services (with High Accuracy) and allow location access when prompted. We will keep checking automatically every few seconds — or you can set your location manually on the map.'),
                    primary_action: {
                        label: __('Set Location on Map'),
                        action: function() {
                            cur_dialog.hide();
                            openManualLocationPicker(fallbackCenter && fallbackCenter.lat, fallbackCenter && fallbackCenter.lng);
                        }
                    }
                });
            }
        }
    }

    function getGeolocationErrorMessage(error) {
        switch (error.code) {
            case error.PERMISSION_DENIED:
                return __('Location permission denied. Please grant permission in browser settings.');
            case error.POSITION_UNAVAILABLE:
                return __('Location information is unavailable from hardware/network providers.');
            case error.TIMEOUT:
                return __('GPS location request timed out. Please try again.');
            default:
                return __('An unknown error occurred while acquiring location.');
        }
    }

    // ---------------------------------------------------------------------
    // MANUAL LOCATION PICKER (Leaflet + OpenStreetMap, no API key required)
    //
    // Used when automatic (GPS/network) location can't be trusted — most
    // commonly a laptop with no GPS chip whose Wi-Fi network resolves to a
    // stale/wrong location in Google's or Mozilla's crowdsourced database.
    // No JS can correct that external database; letting the person confirm
    // their real position on a map is the only reliable way to get a
    // correct address in that situation.
    // ---------------------------------------------------------------------

    let _leafletLoading = null;

    function loadLeafletAssets() {
        if (window.L) return Promise.resolve();
        if (_leafletLoading) return _leafletLoading;

        _leafletLoading = new Promise(function(resolve, reject) {
            const cssLink = document.createElement('link');
            cssLink.rel = 'stylesheet';
            cssLink.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(cssLink);

            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load map library'));
            document.head.appendChild(script);
        });

        return _leafletLoading;
    }

    function openManualLocationPicker(initialLat, initialLng) {
        loadLeafletAssets().then(function() {
            // Fallback center: last known auto fix, else a neutral default (India center-ish).
            const centerLat = (typeof initialLat === 'number' && !isNaN(initialLat)) ? initialLat : 20.5937;
            const centerLng = (typeof initialLng === 'number' && !isNaN(initialLng)) ? initialLng : 78.9629;
            const startZoom = (typeof initialLat === 'number') ? 16 : 5;

            let dialog = new frappe.ui.Dialog({
                title: __('Confirm Your Location'),
                fields: [
                    {
                        fieldtype: 'HTML',
                        fieldname: 'map_picker',
                        options: `
                            <div style="font-size:12px;color:#64748b;margin-bottom:8px;">
                                ${__('Drag the pin (or tap the map) to your exact current location, then confirm.')}
                            </div>
                            <div id="manual-location-map" style="width:100%; height:340px; border-radius:10px;"></div>
                            <div id="manual-location-readout" style="margin-top:8px; font-size:12px; color:#334155;"></div>
                        `
                    }
                ],
                primary_action_label: __('Confirm This Location'),
                primary_action: function() {
                    const m = dialog.$wrapper.data('marker');
                    if (!m) return; // map still initializing, ignore accidental early click
                    const pos = m.getLatLng();
                    dialog.hide();
                    reverseGeocodeManualPin(pos.lat, pos.lng);
                },
                secondary_action_label: __('Cancel')
            });

            dialog.show();

            // Leaflet needs the container to be visible/sized before init.
            setTimeout(function() {
                const map = L.map('manual-location-map').setView([centerLat, centerLng], startZoom);

                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '© OpenStreetMap contributors'
                }).addTo(map);

                const marker = L.marker([centerLat, centerLng], { draggable: true }).addTo(map);
                dialog.$wrapper.data('marker', marker);

                function updateReadout(latlng) {
                    $('#manual-location-readout').text(
                        `${__('Selected')}: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`
                    );
                }
                updateReadout(marker.getLatLng());

                marker.on('drag', function(e) {
                    updateReadout(e.target.getLatLng());
                });

                map.on('click', function(e) {
                    marker.setLatLng(e.latlng);
                    updateReadout(e.latlng);
                });
            }, 150);
        }).catch(function(err) {
            frappe.msgprint({
                title: __('Map Unavailable'),
                indicator: 'red',
                message: __('Could not load the map picker. Please check your internet connection and try again.')
            });
        });
    }

    function reverseGeocodeManualPin(lat, lng) {
        clearAutoRetry();
        locationFinalized = true;

        $('#emp-location').html(`<strong>${lat.toFixed(6)}, ${lng.toFixed(6)}</strong>
            <div class="text-success font-weight-bold style-sub-text mt-1">✓ Manually Confirmed</div>`);
        $('#emp-address').text(__('Resolving address details...'));

        currentCoordinates.latitude = lat;
        currentCoordinates.longitude = lng;
        currentCoordinates.accuracy = 1; // treated as trusted since the user explicitly confirmed it
        locationSource = "manual";

        const myToken = ++addressRequestToken;

        resolveAddressLines(lat, lng)
            .then(function(addressLines) {
                if (myToken !== addressRequestToken) return;
                renderAddressBlock(
                    addressLines,
                    "(Manually Confirmed)",
                    `<div class="text-muted" style="font-size:11px;">(${__('Manually Confirmed')})</div>`
                );
            })
            .finally(function() {
                proceedWithCoordinates();
            });
    }

    // ---------------------------------------------------------------------
    // Shared step: geofence check, run for both auto and manual coordinates
    // ---------------------------------------------------------------------

    function proceedWithCoordinates() {
        showCheckinButton();
        setCheckinButtonEnabled(false); // stay disabled until the geofence check below resolves

        geoRestrictionStatus = { allowed: true, message: null, checked: false };

        const myToken = ++geofenceRequestToken;

        frappe.call({
            method: "facial_recognition.api.check_location_restriction",
            args: {
                latitude: currentCoordinates.latitude,
                longitude: currentCoordinates.longitude
            },
            callback: function(res) {
                if (myToken !== geofenceRequestToken) return; // a newer fix superseded this check — ignore

                if (res.message) {
                    geoRestrictionStatus = {
                        allowed: res.message.allowed !== false,
                        message: res.message.message || null,
                        checked: true
                    };

                    if (!geoRestrictionStatus.allowed) {
                        setCheckinButtonEnabled(false);
                        hideCheckinButton();
                        frappe.msgprint({
                            title: __('Outside Approved Location'),
                            indicator: 'red',
                            message: geoRestrictionStatus.message
                        });
                    } else {
                        showCheckinButton();
                        setCheckinButtonEnabled(true);
                    }
                } else {
                    // No restriction info returned — don't block the person unnecessarily.
                    showCheckinButton();
                    setCheckinButtonEnabled(true);
                }
            }
        });

        // For auto-located fixes, also refresh the displayed address via reverse geocoding.
        // (Manual pins already resolve their address in reverseGeocodeManualPin.)
        if (locationSource === "auto") {
            const myAddrToken = ++addressRequestToken;
            resolveAddressLines(currentCoordinates.latitude, currentCoordinates.longitude)
                .then(function(addressLines) {
                    if (myAddrToken !== addressRequestToken) return;
                    renderAddressBlock(addressLines);
                });
        }
    }

    function isLikelyMobile() {
        return /Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent || "");
    }

    $('#btn-proceed-checkin').on('click', function() {
        if (!currentCoordinates.latitude || isNaN(currentCoordinates.latitude)) {
            frappe.msgprint({
                title: __('Location Required'),
                indicator: 'red',
                message: __('Location is required to check in. Please allow Location Services or set your location manually.')
            });
            return;
        }

        if (locationSource === "auto" && currentCoordinates.accuracy && currentCoordinates.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
            frappe.msgprint({
                title: __('Location Accuracy Too Low'),
                indicator: 'orange',
                message: __(`GPS accuracy is ~${Math.round(currentCoordinates.accuracy)}m. Required precision is ${MAX_ACCEPTABLE_ACCURACY_METERS}m or better, or confirm your location manually.`)
            });
            return;
        }

        if (geoRestrictionStatus.checked && !geoRestrictionStatus.allowed) {
            frappe.msgprint({
                title: __('Outside Approved Location'),
                indicator: 'red',
                message: geoRestrictionStatus.message || __('You are outside your approved check-in location.')
            });
            return;
        }

        openBiometricCameraSubsystem();
    });

    $(document).on('click', '#btn-retry-location', function(e) {
        e.preventDefault();
        fetchLocation();
    });

    $(document).on('click', '#btn-manual-location', function(e) {
        e.preventDefault();
        openManualLocationPicker(currentCoordinates.latitude, currentCoordinates.longitude);
    });

    function openBiometricCameraSubsystem() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } })
                .then(function(stream) {
                    let dialog = new frappe.ui.Dialog({
                        title: __(`Face Recognition: Check-${currentActionState}`),
                        fields: [
                            {
                                fieldtype: 'HTML',
                                fieldname: 'camera_view',
                                options: `
                                    <div class="camera-wrapper text-center">
                                        <video id="webcam-preview" autoplay playsinline muted style="width:100%; max-width:480px; border-radius:8px; background:#000;"></video>
                                        <canvas id="capture-canvas" style="display:none;"></canvas>
                                        <div class="mt-3">
                                            <button id="btn-capture-face" class="btn btn-success btn-md">
                                                <i class="fa fa-camera"></i> Capture Selfie & Log
                                            </button>
                                        </div>
                                    </div>
                                `
                            }
                        ],
                        primary_action_label: __('Cancel'),
                        primary_action: function() {
                            stream.getTracks().forEach(track => track.stop());
                            dialog.hide();
                        }
                    });

                    dialog.show();

                    let video = dialog.$wrapper.find('#webcam-preview')[0];
                    if (video) {
                        video.srcObject = stream;
                        video.onloadedmetadata = function() {
                            video.play().catch(e => console.log(e));
                        };
                    }

                    dialog.$wrapper.find('#btn-capture-face').off('click').on('click', function() {
                        let canvas = dialog.$wrapper.find('#capture-canvas')[0];
                        if (!video || !canvas) return;

                        canvas.width = video.videoWidth || 640;
                        canvas.height = video.videoHeight || 480;
                        let context = canvas.getContext('2d');
                        context.drawImage(video, 0, 0, canvas.width, canvas.height);
                        let base64Image = canvas.toDataURL('image/jpeg');

                        stream.getTracks().forEach(track => track.stop());
                        dialog.hide();

                        frappe.call({
                            method: "facial_recognition.api.process_biometric_attendance",
                            args: {
                                image_base64: base64Image,
                                latitude: currentCoordinates.latitude,
                                longitude: currentCoordinates.longitude,
                                accuracy: currentCoordinates.accuracy,
                                address: currentAddressText.trim(),
                                log_type: currentActionState,
                                location_source: locationSource
                            },
                            freeze: true,
                            freeze_message: __("Verifying facial biometric profile..."),
                            callback: function(res) {
                                if (res.message && res.message.status === "Success") {
                                    frappe.msgprint({
                                        title: __('Verification Successful'),
                                        indicator: 'green',
                                        message: res.message.message
                                    });
                                    initDashboard();
                                }
                            }
                        });
                    });
                })
                .catch(function(err) {
                    frappe.msgprint(__('Unable to access camera hardware: ') + (err.message || err.name));
                });
        } else {
            frappe.msgprint(__('Browser environment does not support media stream interface. Ensure site is running on HTTPS.'));
        }
    }

    $('#btn-logout').on('click', function(e) {
        e.preventDefault();
        frappe.app.logout();
    });
};