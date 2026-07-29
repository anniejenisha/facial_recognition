frappe.pages['facial-recognition'].on_page_load = function(wrapper) {
    // Layout Initialization
    var page = wrapper.page || frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Biometric Attendance',
        single_column: true
    });

    if (page && typeof page.set_title === "function") {
        page.set_title('Biometric Attendance');
    }

    // Render HTML Template
    $(wrapper).find('.layout-main-section').html(frappe.render_template('facial_recognition', {}));

    const $loginSec = $('#login-section');
    const $dashSec = $('#dashboard-section');

    let currentCoordinates = { latitude: null, longitude: null, accuracy: null };
    let currentActionState = "IN"; // Default logic tracking status parameter
    let currentAddressText = ""; // Flat, single-line address kept for backend submission / title attr

    // Accuracy threshold (in meters). Above this, we treat the fix as
    // low-quality (WiFi/IP-based rather than a real GPS/Wi-Fi-assisted fix)
    // and block check-in. This is the single source of truth for location
    // quality now - it applies equally to phones and laptops, so no device
    // type is special-cased or blocked outright.
    const MAX_ACCEPTABLE_ACCURACY_METERS = 200;

    // Parse Reverse Geocoding JSON into a clean, human-readable address dynamically
    function parseDynamicAddress(data) {
        if (!data || !data.address) return "Address unavailable";
        let addr = data.address;

        let parts = [];

        // 1. Street / Road / Specific Locality
        let localArea = addr.road || addr.village || addr.suburb || addr.neighbourhood || addr.residential;
        if (localArea) parts.push(localArea);

        // 2. City / Town / Subdistrict / Taluk
        let cityOrTown = addr.town || addr.city || addr.subdistrict || addr.municipality;
        if (cityOrTown && cityOrTown !== localArea) parts.push(cityOrTown);

        // 3. District (prefer the genuine administrative district)
        //
        // NOTE: For Indian addresses, Nominatim's `county` field is very often
        // a taluk / sub-district (e.g. "Tiruchendur"), NOT the revenue district.
        // Blindly taking `county` first and appending "District" produced
        // incorrect labels like "Tiruchendur District". `state_district` (or
        // plain `district`) is the reliable field for the actual district, so
        // it takes priority. `county` is only used as a last-resort fallback,
        // and shown as-is rather than being labeled "District".
        let district = addr.state_district || addr.district;
        if (district) {
            // Strip any existing "District" word (any casing/spacing) before
            // re-appending our own, so we never end up with it duplicated.
            let distClean = district.replace(/\s*district\s*/gi, '').trim();
            if (distClean) parts.push(`${distClean} District`);
        } else if (addr.county) {
            parts.push(addr.county);
        }

        // 4. State
        if (addr.state) parts.push(addr.state);

        // 5. Postal Pin Code
        if (addr.postcode) parts.push(addr.postcode);

        return parts.length > 0 ? parts : (data.display_name ? [data.display_name] : ["Location details logged"]);
    }

    // Initialize View State Engine
    if (frappe.session.user && frappe.session.user !== "Guest") {
        initDashboard();
    } else {
        $loginSec.show();
    }

    // Login Form Submission Action
    $('#btn-login').on('click', function() {
        let usr = $('#login-username').val();
        let pwd = $('#login-password').val();

        if(!usr || !pwd) {
            frappe.msgprint(__('Please fill out all credential fields.'));
            return;
        }

        frappe.call({
            method: "frappe.core.doctype.user.user.login",
            args: { usr: usr, pwd: pwd },
            callback: function(r) {
                if (r.message == "Logged In") {
                    frappe.session.user = usr;
                    initDashboard();
                }
            }
        });
    });

    // Populate Dashboard Data & Track Location Telemetry
    function initDashboard() {
        $loginSec.hide();
        $dashSec.show();

        // Always attempt to fetch a live location, on any device (phone,
        // tablet, or laptop/desktop). Location QUALITY is enforced later
        // via the accuracy check, rather than blocking a whole device
        // category up front.
        fetchLocation();

        // Fetch dynamic backend calculation parameters
        frappe.call({
            method: "facial_recognition.api.get_employee_dashboard_details",
            callback: function(r) {
                if(r.message) {
                    let data = r.message;
                    $('#emp-name').text(data.employee_name);
                    $('#emp-image').attr('src', data.image || '/assets/frappe/images/default-avatar.png');
                    $('#emp-shift').text(data.shift_type || 'No Shift Assigned');
                    $('#emp-timing').text(data.shift_timing || 'Flexible timings or no rules declared.');

                    // Match action context parameter explicitly ("IN" or "OUT")
                    currentActionState = (data.next_action && data.next_action.includes("OUT")) ? "OUT" : "IN";

                    // Dynamic button label updates
                    let dynamicLabel = `Check - ${currentActionState}`;
                    $('#btn-proceed-checkin').html(`<i class="fa fa-camera"></i> ${dynamicLabel}`);
                } else {
                    frappe.msgprint(__('No active Employee profile linked to this user session.'));
                }
            }
        });
    }

    // Request GPS location and validate accuracy before trusting it
    function fetchLocation() {
        if (!navigator.geolocation) {
            $('#emp-location').html('<span class="text-danger">Geolocation not supported</span>');
            currentAddressText = 'Geolocation not supported by this browser';
            $('#emp-address').text(currentAddressText);
            return;
        }

        $('#emp-location').html('Fetching GPS...');
        currentAddressText = 'Fetching address details...';
        $('#emp-address').text(currentAddressText);

        navigator.geolocation.getCurrentPosition(function(position) {
            currentCoordinates.latitude = position.coords.latitude;
            currentCoordinates.longitude = position.coords.longitude;
            currentCoordinates.accuracy = position.coords.accuracy; // meters

            // Format & display GPS numerical coordinates
            const latLngStr = `${currentCoordinates.latitude.toFixed(4)}, ${currentCoordinates.longitude.toFixed(4)}`;
            $('#emp-location').html(latLngStr);

            // Flag low-accuracy fixes (likely WiFi/IP-based, not real GPS)
            if (currentCoordinates.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
                $('#emp-location').append(
                    `<div style="color:#ef4444; font-size:11px; font-weight:600; margin-top:2px;">
                        ⚠️ Low accuracy (~${Math.round(currentCoordinates.accuracy)}m)
                    </div>`
                );
            } else {
                $('#emp-location').append(
                    `<div style="color:#10b981; font-size:11px; margin-top:2px;">
                        ✓ Accuracy ~${Math.round(currentCoordinates.accuracy)}m
                    </div>`
                );
            }

            // Fetch dynamic address from live coordinates
            fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentCoordinates.latitude}&lon=${currentCoordinates.longitude}&accept-language=en`)
                .then(response => response.json())
                .then(data => {
                    let addressLines = parseDynamicAddress(data);

                    // Keep a flat, single-line copy for the title attribute and backend payload
                    currentAddressText = addressLines.join(", ");

                    // Render each address component on its own line
                    let addressHtml = addressLines
                        .map(line => `<div class="address-line">${frappe.utils.escape_html(line)}</div>`)
                        .join("");
                    $('#emp-address').html(addressHtml).attr('title', currentAddressText);
                })
                .catch(err => {
                    console.error("Reverse geocoding error:", err);
                    currentAddressText = `${latLngStr} (Address service offline)`;
                    $('#emp-address').text(currentAddressText);
                });

        }, function(error) {
            // Reset state on any failure
            currentCoordinates = { latitude: null, longitude: null, accuracy: null };

            // error.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
            //
            // Browsers report POSITION_UNAVAILABLE (code 2) when the device's
            // Location/GPS service itself is switched off at the OS level
            // (as opposed to the site being denied permission, which is code 1).
            // Some Android/Chrome combinations also surface this as a
            // PERMISSION_DENIED with a "location unavailable" style message,
            // so we pattern-match on the message text as a fallback signal too.
            const rawMessage = (error && error.message) ? error.message.toLowerCase() : "";
            const looksLikeServiceOff = rawMessage.indexOf('location provider') !== -1 ||
                                        rawMessage.indexOf('location service') !== -1 ||
                                        rawMessage.indexOf('unavailable') !== -1;

            if (error.code === 2 || (error.code === 1 && looksLikeServiceOff)) {
                // Device-level Location/GPS service is turned off
                $('#emp-location').html('<span class="text-danger">Location Services Off</span>');
                currentAddressText = 'Location Services (GPS) is turned off on this device';
                $('#emp-address').text(currentAddressText);

                frappe.msgprint({
                    title: __('Turn On Location Services'),
                    indicator: 'red',
                    message: __('Your device\'s Location Services (GPS) appear to be switched off, so we cannot fetch your position.<br><br>Please turn Location ON for this browser (set mode to "High Accuracy" / "Precise" if available), then tap Retry below.'),
                    primary_action: {
                        label: __('Retry'),
                        action: function() {
                            cur_dialog.hide();
                            fetchLocation();
                        }
                    }
                });
            } else if (error.code === 1) {
                // Site-level permission denied (Location service may be on, but this site was blocked)
                $('#emp-location').html('<span class="text-danger">Location Access Denied</span>');
                currentAddressText = 'Location Access Denied';
                $('#emp-address').text(currentAddressText);

                frappe.msgprint({
                    title: __('Location Permission Required'),
                    indicator: 'red',
                    message: __('This site does not have permission to access your location.<br><br>Please enable Location permission for this site in your browser settings, then tap Retry below.'),
                    primary_action: {
                        label: __('Retry'),
                        action: function() {
                            cur_dialog.hide();
                            fetchLocation();
                        }
                    }
                });
            } else if (error.code === 3) {
                // Timed out waiting for a location fix
                $('#emp-location').html('<span class="text-danger">GPS Timeout</span>');
                currentAddressText = 'GPS Timeout';
                $('#emp-address').text(currentAddressText);

                frappe.msgprint({
                    title: __('Could Not Get Location Fix'),
                    indicator: 'orange',
                    message: __('We could not get a location fix in time. Make sure Location Services is turned ON for this browser, then tap Retry below.'),
                    primary_action: {
                        label: __('Retry'),
                        action: function() {
                            cur_dialog.hide();
                            fetchLocation();
                        }
                    }
                });
            } else {
                // Fallback for any unexpected error shape
                $('#emp-location').html('<span class="text-danger">Location Access Denied</span>');
                currentAddressText = 'Location Access Denied';
                $('#emp-address').text(currentAddressText);

                frappe.msgprint({
                    title: __('Location Unavailable'),
                    indicator: 'red',
                    message: __('We could not determine your location. Please make sure Location Services is turned on for this browser and try again.'),
                    primary_action: {
                        label: __('Retry'),
                        action: function() {
                            cur_dialog.hide();
                            fetchLocation();
                        }
                    }
                });
            }
        }, {
            enableHighAccuracy: true,   // Forces GPS chip usage where available, instead of cheap WiFi/IP lookup
            timeout: 15000,
            maximumAge: 0               // Never reuse a cached/stale fix
        });
    }

    // Proceed & Trigger Camera Interface Validation Pipeline
    $('#btn-proceed-checkin').on('click', function() {
        if (!currentCoordinates.latitude || isNaN(currentCoordinates.latitude)) {
            frappe.msgprint({
                title: __('Location Required'),
                indicator: 'red',
                message: __('Location is required to check in.<br><br>Please make sure Location Services is turned ON in your device/browser settings, then tap Retry below.'),
                primary_action: {
                    label: __('Retry'),
                    action: function() {
                        cur_dialog.hide();
                        fetchLocation();
                    }
                }
            });
            return;
        }

        if (currentCoordinates.accuracy && currentCoordinates.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
            frappe.msgprint({
                title: __('Location Accuracy Too Low'),
                indicator: 'orange',
                message: __(`Your current location fix is only accurate to ~${Math.round(currentCoordinates.accuracy)} meters. This usually means location services are off or the device is using WiFi/network-based location instead of a precise fix.<br><br>Please enable "High Accuracy" / "Precise Location", turn off any VPN, and try again (ideally with a clear view of the sky if using a mobile device).`)
            });
            return;
        }

        openBiometricCameraSubsystem();
    });

    // Retry location fetch if user wants a fresh fix without reloading the page
    $(document).on('click', '#btn-retry-location', function() {
        fetchLocation();
    });

    // Native Camera Engine Modal Component Trigger
    function openBiometricCameraSubsystem() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } })
                .then(function(stream) {
                    let dialog = new frappe.ui.Dialog({
                        title: __(`Face Recognition Authentication: Check-${currentActionState}`),
                        fields: [
                            {
                                fieldtype: 'HTML',
                                fieldname: 'camera_view',
                                options: `
                                    <div class="text-center" style="min-height: 300px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                                        <video id="webcam-preview" autoplay playsinline muted width="400" height="300" style="max-width: 100%; height: auto; border-radius: 8px; transform: scaleX(-1); box-shadow: 0 4px 6px rgba(0,0,0,0.1); background-color: #000;"></video>
                                        <canvas id="capture-canvas" style="display:none;"></canvas>
                                        <div class="mt-3">
                                            <button id="btn-capture-face" class="btn btn-success btn-md"><i class="fa fa-circle"></i> Capture & Log Identity</button>
                                        </div>
                                    </div>
                                `
                            }
                        ],
                        primary_action_label: __('Cancel View'),
                        primary_action: function() {
                            stream.getTracks().forEach(track => track.stop());
                            dialog.hide();
                        }
                    });

                    dialog.show();

                    // Selection using Frappe's dialog wrapper context
                    let video = dialog.$wrapper.find('#webcam-preview')[0];

                    if (video) {
                        video.srcObject = stream;
                        video.onloadedmetadata = function(e) {
                            video.play().catch(function(err) {
                                console.log("Video autoplay blocked or interrupted:", err);
                            });
                        };
                    } else {
                        setTimeout(() => {
                            let retryVideo = dialog.$wrapper.find('#webcam-preview')[0];
                            if (retryVideo) {
                                retryVideo.srcObject = stream;
                                retryVideo.onloadedmetadata = function(e) {
                                    retryVideo.play().catch(p_err => console.log(p_err));
                                };
                            }
                        }, 150);
                    }

                    // Frame Capture Submission Handler
                    dialog.$wrapper.find('#btn-capture-face').off('click').on('click', function() {
                        let canvas = dialog.$wrapper.find('#capture-canvas')[0];

                        if (!video || !canvas) {
                            frappe.msgprint(__('Camera interface objects not found. Please close and try again.'));
                            return;
                        }

                        // Use video element internal resolution parameters
                        canvas.width = video.videoWidth || 640;
                        canvas.height = video.videoHeight || 480;
                        let context = canvas.getContext('2d');

                        // Extract frame data bounds
                        context.drawImage(video, 0, 0, canvas.width, canvas.height);
                        let base64Image = canvas.toDataURL('image/jpeg');

                        // Stop stream tracks
                        stream.getTracks().forEach(track => track.stop());
                        dialog.hide();

                        // Dispatch payload to backend validation APIs
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
                            freeze_message: __("Verifying biometric data profile against database record..."),
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
                    frappe.msgprint(__('Unable to access target camera hardware device: ') + (err.message || err.name));
                });
        } else {
            frappe.msgprint(__('Your browser environment context does not support native media stream interface devices.'));
        }
    }

    // System Logout Handler
    $('#btn-logout').on('click', function(e) {
        e.preventDefault();
        frappe.app.logout();
    });
};