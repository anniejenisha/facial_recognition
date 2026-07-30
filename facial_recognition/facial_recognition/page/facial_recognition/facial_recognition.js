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

    // Accuracy Thresholds (in meters)
    const MAX_ACCEPTABLE_ACCURACY_METERS = 200;
    const GOOD_ACCURACY_METERS = 25;

    // Time window allocated to acquire hardware GPS fix before trying IP fallback
    const LOCATION_REFINE_TIMEOUT_MS = 12000;

    let watchId = null;
    let refineTimer = null;

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
    // OPTIMIZED LOCATION ACQUISITION & FALLBACK STRATEGY
    // ---------------------------------------------------------------------

    function fetchLocation() {
        stopWatching();

        $('#emp-location').html('<span class="text-info"><i class="fa fa-spinner fa-spin"></i> Acquiring GPS coordinates...</span>');
        currentAddressText = 'Resolving address details...';
        $('#emp-address').text(currentAddressText);
        $('#btn-proceed-checkin').prop('disabled', true);

        if (!navigator.geolocation) {
            fetchIPFallbackLocation(__('Native Geolocation unsupported. Switched to IP Location.'));
            return;
        }

        let bestFix = null;

        const processIncomingFix = (coords) => {
            if (!bestFix || coords.accuracy < bestFix.accuracy) {
                bestFix = {
                    latitude: coords.latitude,
                    longitude: coords.longitude,
                    accuracy: coords.accuracy
                };

                currentCoordinates = { ...bestFix };
                renderLiveAccuracy(bestFix, bestFix.accuracy > GOOD_ACCURACY_METERS);

                const isAcceptable = bestFix.accuracy <= MAX_ACCEPTABLE_ACCURACY_METERS;
                $('#btn-proceed-checkin').prop('disabled', !isAcceptable);

                checkGeofenceAndResolveAddress(bestFix.latitude, bestFix.longitude);

                if (bestFix.accuracy <= GOOD_ACCURACY_METERS) {
                    finalizeLocation(bestFix);
                }
            }
        };

        // 1. Instant snapshot attempt (fast initial load)
        navigator.geolocation.getCurrentPosition(
            (pos) => processIncomingFix(pos.coords),
            (err) => { /* Fail over to watchPosition */ },
            { enableHighAccuracy: true, timeout: 4000, maximumAge: 5000 }
        );

        // 2. Active stream listener to refine accuracy
        watchId = navigator.geolocation.watchPosition(
            (pos) => processIncomingFix(pos.coords),
            (error) => {
                if (!bestFix) {
                    stopWatching();
                    fetchIPFallbackLocation(getGeolocationErrorMessage(error));
                }
            },
            {
                enableHighAccuracy: true,
                timeout: LOCATION_REFINE_TIMEOUT_MS,
                maximumAge: 0
            }
        );

        // 3. Fallback timer if signal stream delays
        refineTimer = setTimeout(function() {
            stopWatching();
            if (bestFix) {
                finalizeLocation(bestFix);
            } else {
                fetchIPFallbackLocation(__('GPS signal timed out. Switched to Network IP Location.'));
            }
        }, LOCATION_REFINE_TIMEOUT_MS);
    }

    function fetchIPFallbackLocation(reasonMessage) {
        fetch('https://ipapi.co/json/')
            .then(res => res.json())
            .then(data => {
                if (data && data.latitude && data.longitude) {
                    let ipFix = {
                        latitude: parseFloat(data.latitude),
                        longitude: parseFloat(data.longitude),
                        accuracy: 1000
                    };
                    
                    currentCoordinates = ipFix;
                    const latLngStr = `${ipFix.latitude.toFixed(6)}, ${ipFix.longitude.toFixed(6)}`;
                    $('#emp-location').html(`<strong>${latLngStr}</strong> <div class="text-warning style-sub-text mt-1">⚠️ Network IP Estimate</div>`);
                    
                    $('#btn-proceed-checkin').prop('disabled', false);
                    checkGeofenceAndResolveAddress(ipFix.latitude, ipFix.longitude);
                } else {
                    renderLocationUnavailable(reasonMessage || __('Unable to resolve location coordinates.'), true);
                }
            })
            .catch(err => {
                renderLocationUnavailable(reasonMessage || __('Location services unavailable.'), true);
            });
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
                        ⚠️ Low Accuracy (~${Math.round(fix.accuracy)}m radius)${stillRefining ? ' — refining signal…' : ''}
                     </div>`;
        } else {
            html += `<div class="text-success font-weight-bold style-sub-text mt-1">
                        ✓ Precise GPS (~${Math.round(fix.accuracy)}m radius)${stillRefining ? ' — refining…' : ''}
                     </div>`;
        }
        $('#emp-location').html(html);
    }

    function finalizeLocation(fix) {
        stopWatching();

        currentCoordinates.latitude = fix.latitude;
        currentCoordinates.longitude = fix.longitude;
        currentCoordinates.accuracy = fix.accuracy;

        renderLiveAccuracy(fix, false);

        const accuracyOk = fix.accuracy <= MAX_ACCEPTABLE_ACCURACY_METERS;
        $('#btn-proceed-checkin').prop('disabled', !accuracyOk);

        if (!accuracyOk) {
            let platformHelp = !isLikelyMobile() 
                ? 'Laptops rely on Wi-Fi/IP routing. Please check in using a mobile device with active GPS for precise tracking.'
                : 'Ensure "Precise Location" is enabled in browser permissions and step near a window or outdoors.';

            currentAddressText = `Location accuracy insufficient (~${Math.round(fix.accuracy)}m)`;
            $('#emp-address').html(
                `<span class="text-danger">
                    Accuracy low (~${Math.round(fix.accuracy)}m).<br>
                    <small>${platformHelp}</small>
                 </span>
                 <div class="mt-2">
                    <a href="#" id="btn-retry-location" class="btn btn-xs btn-default font-weight-bold">Retry Location Acquisition</a>
                 </div>`
            ).attr('title', currentAddressText);

            frappe.msgprint({
                title: __('Low GPS Accuracy Detected'),
                indicator: 'orange',
                message: __(`Coordinates acquired with ~${Math.round(fix.accuracy)}m tolerance.<br><br>${platformHelp}`),
                primary_action: {
                    label: __('Retry'),
                    action: function() {
                        cur_dialog.hide();
                        fetchLocation();
                    }
                }
            });

            checkGeofenceAndResolveAddress(fix.latitude, fix.longitude);
            return;
        }

        checkGeofenceAndResolveAddress(fix.latitude, fix.longitude);
    }

    function checkGeofenceAndResolveAddress(lat, lon) {
        geoRestrictionStatus = { allowed: true, message: null, checked: false };
        frappe.call({
            method: "facial_recognition.api.check_location_restriction",
            args: { latitude: lat, longitude: lon },
            callback: function(res) {
                if (res.message) {
                    geoRestrictionStatus = {
                        allowed: res.message.allowed !== false,
                        message: res.message.message || null,
                        checked: true
                    };

                    if (!geoRestrictionStatus.allowed) {
                        frappe.msgprint({
                            title: __('Outside Approved Geofence'),
                            indicator: 'red',
                            message: geoRestrictionStatus.message
                        });
                    }
                }
            }
        });

        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=en`)
            .then(response => response.json())
            .then(data => {
                let addressLines = parseDynamicAddress(data);
                currentAddressText = addressLines.join(", ");
                let addressHtml = addressLines
                    .map(line => `<div class="address-line">${frappe.utils.escape_html(line)}</div>`)
                    .join("");
                $('#emp-address').html(addressHtml).attr('title', currentAddressText);
            })
            .catch(err => {
                const latLngStr = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                currentAddressText = `${latLngStr} (Address service offline)`;
                $('#emp-address').text(currentAddressText);
            });
    }

    function renderLocationUnavailable(customMessage, isPermissionOrTimeoutError) {
        $('#emp-location').html('<span class="text-danger font-weight-bold">Location Unavailable</span>');
        currentAddressText = customMessage || 'Location access failed or disabled';
        $('#emp-address').html(
            `<span class="text-danger">${frappe.utils.escape_html(currentAddressText)}</span>
             <div class="mt-2"><a href="#" id="btn-retry-location" class="btn btn-xs btn-default font-weight-bold">Retry Location</a></div>`
        );
        $('#btn-proceed-checkin').prop('disabled', true);

        if (isPermissionOrTimeoutError) {
            frappe.msgprint({
                title: __('Location Access Issue'),
                indicator: 'red',
                message: __('Please grant browser location permissions and enable Location Services.'),
                primary_action: {
                    label: __('Retry'),
                    action: function() {
                        cur_dialog.hide();
                        fetchLocation();
                    }
                }
            });
        }
    }

    function getGeolocationErrorMessage(error) {
        switch (error.code) {
            case error.PERMISSION_DENIED:
                return __('Location permission denied in browser settings.');
            case error.POSITION_UNAVAILABLE:
                return __('GPS position unavailable from device.');
            case error.TIMEOUT:
                return __('GPS request timed out.');
            default:
                return __('Error acquiring GPS location.');
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
                message: __('Location coordinates are required to complete check-in.')
            });
            return;
        }

        if (geoRestrictionStatus.checked && !geoRestrictionStatus.allowed) {
            frappe.msgprint({
                title: __('Outside Approved Geofence'),
                indicator: 'red',
                message: geoRestrictionStatus.message || __('You are outside your authorized check-in location.')
            });
            return;
        }

        openBiometricCameraSubsystem();
    });

    $(document).on('click', '#btn-retry-location', function(e) {
        e.preventDefault();
        fetchLocation();
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
                                log_type: currentActionState
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
            frappe.msgprint(__('Browser environment does not support media stream interface. Ensure site is running over HTTPS.'));
        }
    }

    $('#btn-logout').on('click', function(e) {
        e.preventDefault();
        frappe.app.logout();
    });
};