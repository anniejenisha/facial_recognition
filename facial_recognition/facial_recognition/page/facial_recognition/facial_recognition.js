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

    const MAX_ACCEPTABLE_ACCURACY_METERS = 200;

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
                if (r.message == "Logged In") {
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
            currentCoordinates.accuracy = position.coords.accuracy;

            const latLngStr = `${currentCoordinates.latitude.toFixed(4)}, ${currentCoordinates.longitude.toFixed(4)}`;
            $('#emp-location').html(latLngStr);

            if (currentCoordinates.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
                $('#emp-location').append(
                    `<div class="text-danger font-weight-bold style-sub-text">
                        ⚠️ Low accuracy (~${Math.round(currentCoordinates.accuracy)}m)
                    </div>`
                );
            } else {
                $('#emp-location').append(
                    `<div class="text-success style-sub-text">
                        ✓ Accuracy ~${Math.round(currentCoordinates.accuracy)}m
                    </div>`
                );
            }

            // Step 2 Evaluation: Popup immediately if user is outside geo-fence
            geoRestrictionStatus = { allowed: true, message: null, checked: false };
            frappe.call({
                method: "facial_recognition.api.check_location_restriction",
                args: {
                    latitude: currentCoordinates.latitude,
                    longitude: currentCoordinates.longitude
                },
                callback: function(res) {
                    if (res.message) {
                        geoRestrictionStatus = {
                            allowed: res.message.allowed !== false,
                            message: res.message.message || null,
                            checked: true
                        };

                        if (!geoRestrictionStatus.allowed) {
                            frappe.msgprint({
                                title: __('Outside Approved Location'),
                                indicator: 'red',
                                message: geoRestrictionStatus.message
                            });
                        }
                    }
                }
            });

            // Fetch dynamic street address via reverse geocoding
            fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentCoordinates.latitude}&lon=${currentCoordinates.longitude}&accept-language=en`)
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
                    currentAddressText = `${latLngStr} (Address service offline)`;
                    $('#emp-address').text(currentAddressText);
                });

        }, function(error) {
            currentCoordinates = { latitude: null, longitude: null, accuracy: null };
            $('#emp-location').html('<span class="text-danger">Location Unavailable</span>');
            currentAddressText = 'Location access failed or disabled';
            $('#emp-address').text(currentAddressText);

            frappe.msgprint({
                title: __('Location Services Disabled'),
                indicator: 'red',
                message: __('Please turn ON High Accuracy Location Services in your browser/device settings and click Retry.'),
                primary_action: {
                    label: __('Retry'),
                    action: function() {
                        cur_dialog.hide();
                        fetchLocation();
                    }
                }
            });
        }, {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        });
    }

    $('#btn-proceed-checkin').on('click', function() {
        if (!currentCoordinates.latitude || isNaN(currentCoordinates.latitude)) {
            frappe.msgprint({
                title: __('Location Required'),
                indicator: 'red',
                message: __('Location is required to check in. Please ensure Location Services are enabled.')
            });
            return;
        }

        if (currentCoordinates.accuracy && currentCoordinates.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
            frappe.msgprint({
                title: __('Location Accuracy Too Low'),
                indicator: 'orange',
                message: __(`Your GPS accuracy is ~${Math.round(currentCoordinates.accuracy)}m. Please switch to High Accuracy/GPS mode and try again.`)
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

    $(document).on('click', '#btn-retry-location', function() {
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
                                    <div class="camera-wrapper">
                                        <video id="webcam-preview" autoplay playsinline muted></video>
                                        <canvas id="capture-canvas" style="display:none;"></canvas>
                                        <div class="mt-3 text-center">
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
            frappe.msgprint(__('Browser environment does not support media stream interface.'));
        }
    }

    $('#btn-logout').on('click', function(e) {
        e.preventDefault();
        frappe.app.logout();
    });
};