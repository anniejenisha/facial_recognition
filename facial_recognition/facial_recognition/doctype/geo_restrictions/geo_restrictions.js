frappe.ui.form.on('Geo Restrictions', {
    app_location: function(frm) {
        // 1. Check if there are any rows in the app_location child table
        if (frm.doc.app_location && frm.doc.app_location.length > 0) {
            
            // Get the location value from the first row (or last added row)
            // Note: Change 'location' below to the exact fieldname inside your child table if it's named differently
            let selected_location = frm.doc.app_location[0].location; 

            if (selected_location) {
                // Fetch the actual Location master document
                frappe.db.get_doc('Location', selected_location)
                    .then(doc => {
                        if (doc) {
                            // If GeoJSON / Boundary string exists
                            if (doc.location) {
                                frm.set_value('location', doc.location);
                            } 
                            // Fallback if only Latitude & Longitude exist
                            else if (doc.latitude && doc.longitude) {
                                const geojson = {
                                    "type": "FeatureCollection",
                                    "features": [{
                                        "type": "Feature",
                                        "properties": {},
                                        "geometry": {
                                            "type": "Point",
                                            "coordinates": [parseFloat(doc.longitude), parseFloat(doc.latitude)]
                                        }
                                    }]
                                };
                                frm.set_value('location', JSON.stringify(geojson));
                            }
                        }
                    });
            }
        } else {
            // Clear map field if no locations are selected
            frm.set_value('location', '');
        }
    }
});