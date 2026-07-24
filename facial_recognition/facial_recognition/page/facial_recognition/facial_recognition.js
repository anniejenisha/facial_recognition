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
    // network/IP-based rather than real GPS, and block check-in.
    const MAX_ACCEPTABLE_ACCURACY_METERS = 200;

    // Detect if this is a desktop/laptop browser. These almost never have a
    // real GPS chip — Chrome/Edge silently fall back to WiFi/IP-based
    // positioning, which can be wrong by hundreds of kilometers while still
    // reporting a deceptively small "accuracy" value. We block check-in on
    // these devices rather than trust that data.
    function isLikelyDesktopDevice() {
        const ua = navigator.userAgent || "";
        const isMobileUA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
        // Coarse pointer + no touch points is a strong desktop signal even if UA is spoofed
        const hasTouch = (navigator.maxTouchPoints || 0) > 0;
        return !isMobileUA && !hasTouch;
    }

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

        // 3. District / County
        let district = addr.county || addr.state_district || addr.district;
        if (district) {
            let distClean = district.replace(/ District/i, '');
            parts.push(`${distClean} District`);
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

        if (isLikelyDesktopDevice()) {
            $('#emp-location').html('<span class="text-danger">Unavailable on desktop</span>');
            currentAddressText = 'Please check in from your mobile phone with GPS enabled';
            $('#emp-address').text(currentAddressText);
        } else {
            fetchLocation();
        }

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
            fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentCoordinates.latitude}&lon=${currentCoordinates.longitude}`)
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
            currentCoordinates = { latitude: null, longitude: null, accuracy: null };
            $('#emp-location').html('<span class="text-danger">Location Access Denied</span>');
            currentAddressText = 'Location Access Denied';
            $('#emp-address').text(currentAddressText);
        }, {
            enableHighAccuracy: true,   // Forces GPS chip usage where available, instead of cheap WiFi/IP lookup
            timeout: 15000,
            maximumAge: 0               // Never reuse a cached/stale fix
        });
    }

    // Proceed & Trigger Camera Interface Validation Pipeline
    $('#btn-proceed-checkin').on('click', function() {
        if (isLikelyDesktopDevice()) {
            frappe.msgprint({
                title: __('Mobile Device Required'),
                indicator: 'red',
                message: __('Laptops and desktops do not have a real GPS chip. Browsers on these devices estimate location from WiFi/IP data, which can be wrong by hundreds of kilometers.<br><br>Please open this page on your mobile phone (with GPS and mobile data or precise location turned on) to check in.')
            });
            return;
        }

        if (!currentCoordinates.latitude || isNaN(currentCoordinates.latitude)) {
            frappe.msgprint(__('GPS parameters required to execute biometric request. Please check permissions or wait a moment for the GPS to lock.'));
            return;
        }

        if (currentCoordinates.accuracy && currentCoordinates.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
            frappe.msgprint({
                title: __('Location Accuracy Too Low'),
                indicator: 'orange',
                message: __(`Your current location fix is only accurate to ~${Math.round(currentCoordinates.accuracy)} meters. This usually means GPS is off or the device is using WiFi/network-based location instead of real GPS.<br><br>Please enable "High Accuracy" / "Precise Location" in your device settings, turn off any VPN, and try again (ideally with a clear view of the sky).`)
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