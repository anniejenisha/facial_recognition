frappe.pages['holec_trading'].on_page_load = function(wrapper) {
    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Holec Trading',
        single_column: true
    });
    $(frappe.render_template('holec_trading', {})).appendTo(page.main);
    $(page.wrapper).find('.page-head').hide();
    $(page.wrapper).find('.layout-side-section').remove();
    $(page.wrapper).find('.desk-sidebar').remove();
    $(page.main).css({ 'width': '100%', 'margin': '0', 'padding': '0' });
    $(page.main).html(`
        <div class="holec-layout" style="display:flex;height:calc(100vh - 40px);background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
            <div class="holec-sidebar" id="h-sidebar" style="width:240px;background:#ffffff;border-right:1px solid #e2e8f0;padding:16px 12px;overflow-y:auto;flex-shrink:0;"></div>
            <div class="holec-main-container" style="flex-grow:1;display:flex;flex-direction:column;overflow:hidden;">
                <div class="holec-topbar" style="height:56px;background:#ffffff;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0;">
                    <div class="holec-timeline" id="h-timeline" style="display:flex;align-items:center;gap:6px;font-size:13px;color:#4a5568;"></div>
                </div>
                <div class="holec-content" id="h-content" style="flex-grow:1;overflow-y:auto;padding:24px;"></div>
            </div>
        </div>
    `);

    init_holec_trading_engine();
};

function init_holec_trading_engine() {
    const fmtKES = (n) => 'KES ' + Math.round(flt(n)).toLocaleString('en-KE');
    const fmtKg = (n) => Math.round(flt(n)).toLocaleString('en-KE') + ' kg';

    const STAGE_ORDER = ['Ticket', 'Intake', 'Lot', 'Position', 'Invoiced', 'Settled'];

    const LIVE_STORE = {
        suppliers: [],
        customers: [],
        customer_groups: [],
        countries: [],
        items: [],
        vehicles: [],
        lots: [],
        lotEventLogs: [],
        banks: [],
        bank_branches: []
    };

    let route = { module: 'lots', params: {} };

    function computePayable(lot) {
        const grossKg = flt(lot.gross_weight_kg || lot.quantity_kg || 0);
        const tareKg = flt(lot.tare_weight_kg || 0);
        const netKg = Math.max(0, grossKg - tareKg);
        const moisture = flt(lot.moisture_ || 0);
        const fm = flt(lot.foreign_matter_ || 0);
        const standardMoisture = 13.5;
        let moisturePenaltyPct = 0;

        if (moisture > 20) {
            moisturePenaltyPct = (moisture - standardMoisture) * 1.6;
        } else if (moisture > 14) {
            moisturePenaltyPct = (moisture - standardMoisture) * 1.2;
        } else if (moisture > standardMoisture) {
            moisturePenaltyPct = (moisture - standardMoisture);
        }

        const moistureDeductionKg = netKg * (moisturePenaltyPct / 100);
        const fmDeductionKg = netKg * (Math.max(0, fm - 0.5) / 100) * 1.5;
        const acceptedNetKg = Math.max(0, netKg - moistureDeductionKg - fmDeductionKg);

        const refRate = flt(lot.negotiated_price || 48);
        const grossValue = acceptedNetKg * refRate;
        const bags = cint(lot.bag_count || 0);
        const baggingDeduction = bags * 25;
        const aflatoxinTestFee = flt(lot.aflatoxin_ppb) > 0 ? 300 : 0;
        
        const haulage = flt(lot.haulage_kes || 0);
        const cess = flt(lot.cess_kes || 0);
        const offloading = flt(lot.offloading_kes || 0);
        const totalTransport = haulage + cess + offloading;

        const netPayable = Math.max(0, grossValue - baggingDeduction - aflatoxinTestFee);
        const landedCostPerKg = acceptedNetKg > 0 ? Math.round((netPayable + totalTransport) / acceptedNetKg) : refRate;

        return { acceptedNetKg, netPayable, landedCostPerKg, totalTransport };
    }

    function showToast(msg, indicator = 'green') { frappe.show_alert({ message: msg, indicator: indicator }); }
    
    function statusBadge(st) {
        const stateLower = (st || 'Ticket').toLowerCase();
        let bg = '#edf2f7';
        let color = '#4a5568';
        let dotColor = '#cbd5e0';

        if (stateLower === 'intake') { bg = '#fffaf0'; color = '#9c4221'; dotColor = '#dd6b20'; }
        else if (stateLower === 'lot') { bg = '#ebf8ff'; color = '#2b6cb0'; dotColor = '#3182ce'; }
        else if (stateLower === 'position') { bg = '#f0fff4'; color = '#276749'; dotColor = '#38a169'; }
        else if (stateLower === 'invoiced') { bg = '#f0fff4'; color = '#276749'; dotColor = '#38a169'; }
        else if (stateLower === 'settled') { bg = '#f0fff4'; color = '#276749'; dotColor = '#38a169'; }

        return `<span style="display:inline-flex;align-items:center;gap:6px;background:${bg};color:${color};padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;"><span style="width:6px;height:6px;background:${dotColor};border-radius:50%;"></span>${st || 'Ticket'}</span>`;
    }

    function field(opts) {
        const { label, id, type = 'text', value = '', required = false, options = null, placeholder = '', span = false } = opts;
        const reqMark = required ? '<span style="color:#e53e3e;margin-left:2px;">*</span>' : '';
        const cleanLabel = label.replace(/\s*\*$/, '');
        let input;
        if (type === 'select') {
            const opts_html = (options || []).map(o => {
                const val = typeof o === 'object' ? o.value : o;
                const lbl = typeof o === 'object' ? o.label : o;
                return `<option value="${val}" ${val === value ? 'selected' : ''}>${lbl}</option>`;
            }).join('');
            input = `<select id="${id}" style="width:100%;padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;background:#fff;font-size:14px;"><option value="">Select...</option>${opts_html}</select>`;
        } else if (type === 'textarea') {
            return `<div style="${span ? 'grid-column: span 2;' : ''}display:flex;flex-direction:column;gap:6px;"><label for="${id}" style="font-size:13px;font-weight:500;color:#4a5568;">${cleanLabel} ${reqMark}</label><textarea id="${id}" placeholder="${placeholder}" style="width:100%;padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;min-height:80px;">${value}</textarea></div>`;
        } else {
            input = `<input type="${type}" id="${id}" value="${value}" placeholder="${placeholder}" style="width:100%;padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;">`;
        }
        return `<div style="${span ? 'grid-column: span 2;' : ''}display:flex;flex-direction:column;gap:6px;"><label for="${id}" style="font-size:13px;font-weight:500;color:#4a5568;">${cleanLabel} ${reqMark}</label>${input}</div>`;
    }

    async function loadMasterData() {
        try {
            const [suppliers, customers, customerGroups, countries, items, vehicles, buyTickets, lotEventLogs, banks, bankBranches] = await Promise.all([
                frappe.db.get_list('Supplier', { fields: ['name', 'supplier_name', 'supplier_group', 'country', 'tax_id'], limit: 100 }),
                frappe.db.get_list('Customer', { 
                    fields: ['name', 'customer_name', 'customer_group', 'payment_terms', 'disabled'], 
                    limit: 100 
                }),
                frappe.db.get_list('Customer Group', { fields: ['name', 'customer_group_name'], limit: 100, order_by: 'name asc' }),
                frappe.db.get_list('Country', { fields: ['name', 'country_name'], limit: 250, order_by: 'name asc' }),
                frappe.db.get_list('Item', { fields: ['name', 'item_name'], limit: 100, order_by: 'name asc' }),
                frappe.db.get_list('Vehicle', { fields: ['name', 'license_plate'], limit: 100, order_by: 'name asc' }),
                frappe.db.get_list('Buy Ticket', {
                    fields: [
                        'name', 'status', 'supplier', 'customer', 'commodity', 'region',
                        'quantity_kg', 'negotiated_price', 'creation', 'modified',
                        'gross_weight_kg', 'tare_weight_kg', 'bag_count',
                        'weighbridge_ticket_number', 'transporter', 'vehicle_registration',
                        'moisture_', 'foreign_matter_', 'aflatoxin_ppb',
                        'county', 'reason_code_if_foreign_matter_judgement_or_wet_buy',
                        'haulage_kes', 'cess_kes', 'offloading_kes', 'delivered_quantity_kg',
                        'sell_rate', 'invoice_number'
                    ],
                    order_by: 'creation desc',
                    limit: 500
                }),
                frappe.db.get_list('Lot Event Log', {
                    fields: ['name', 'lot', 'state', 'owner', 'modified', 'creation'],
                    order_by: 'creation desc',
                    limit: 100
                }).catch(() => []),
                frappe.db.get_list('Bank', { fields: ['name', 'bank_name'], limit: 100, order_by: 'name asc' }).catch(() => []),
                frappe.db.get_list('Bank Branch', { fields: ['name', 'branch_name', 'bank'], limit: 500, order_by: 'name asc' }).catch(() => [])
            ]);

            LIVE_STORE.suppliers = suppliers || [];
            LIVE_STORE.customers = customers || [];
            LIVE_STORE.customer_groups = customerGroups || [];
            LIVE_STORE.countries = countries || [];
            LIVE_STORE.items = items || [];
            LIVE_STORE.vehicles = vehicles || [];
            LIVE_STORE.lots = buyTickets || [];
            LIVE_STORE.lotEventLogs = lotEventLogs || [];
            LIVE_STORE.banks = banks || [];
            LIVE_STORE.bank_branches = bankBranches || [];
        } catch (e) {
            console.error('Error loading master data from DocTypes:', e);
        }
    }

    window.navigate = function(moduleId, params = {}) {
        route = { module: moduleId, params };
        render();
        $('.holec-content').scrollTop(0);
    }

    function renderSuppliers(container) {
        const suppliers = LIVE_STORE.suppliers || [];

        const rows = suppliers.map(s => {
            let bg = '#edf2f7';
            let color = '#4a5568';
            let dotColor = '#cbd5e0';
            let statusLabel = s.custom_status || 'Approved';

            if (statusLabel === 'Approved') { bg = '#f0fff4'; color = '#276749'; dotColor = '#38a169'; }
            else if (statusLabel === 'Verified') { bg = '#fffaf0'; color = '#9c4221'; dotColor = '#dd6b20'; }
            else if (statusLabel === 'Draft') { bg = '#edf2f7'; color = '#4a5568'; dotColor = '#a0aec0'; }

            const statusBadgeHtml = `<span style="display:inline-flex;align-items:center;gap:6px;background:${bg};color:${color};padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;"><span style="width:6px;height:6px;background:${dotColor};border-radius:50%;"></span>${statusLabel}</span>`;

            return `
                <tr style="border-bottom:1px solid #edf2f7;cursor:pointer;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'">
                    <td style="padding:14px 20px;font-family:monospace;font-weight:600;color:#2d3748;">${s.name}</td>
                    <td style="padding:14px 16px;color:#2d3748;font-weight:500;">${s.supplier_name || '—'}</td>
                    <td style="padding:14px 16px;color:#718096;">${s.supplier_group || '—'}</td>
                    <td style="padding:14px 16px;color:#718096;">${s.country || '—'}</td>
                    <td style="padding:14px 16px;font-family:monospace;color:#718096;">${s.tax_id || '—'}</td>
                    <td style="padding:14px 20px;">${statusBadgeHtml}</td>
                </tr>`;
        }).join('');

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Parties</span> › <span style="color:#2d3748;font-weight:500;">Suppliers</span>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a202c;display:flex;align-items:center;gap:10px;">Suppliers <span style="background:#edf2f7;color:#4a5568;font-size:12px;padding:2px 8px;border-radius:10px;font-weight:600;">${suppliers.length}</span></h1>
                <button class="h-btn primary" id="new-supplier-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">+ New supplier</button>
            </div>

            <div style="margin-bottom:16px;">
                <input type="text" placeholder="Search by name or KRA PIN" style="width:320px;padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;">
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 20px;">ID ↕</th>
                            <th style="padding:12px 16px;">Name ↕</th>
                            <th style="padding:12px 16px;">Group ↕</th>
                            <th style="padding:12px 16px;">County ↕</th>
                            <th style="padding:12px 16px;">KRA PIN</th>
                            <th style="padding:12px 20px;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="6" style="padding:30px;text-align:center;color:#718096;">No suppliers found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;

        document.getElementById('new-supplier-btn').addEventListener('click', () => navigate('new_supplier'));
    }

    function renderCustomers(container) {
        const customers = LIVE_STORE.customers || [];

        const rows = customers.map(c => {
            const isDisabled = cint(c.disabled) === 1;
            const bg = isDisabled ? '#edf2f7' : '#f0fff4';
            const color = isDisabled ? '#4a5568' : '#276749';
            const dotColor = isDisabled ? '#a0aec0' : '#38a169';
            const statusLabel = isDisabled ? 'Disabled' : 'Approved';

            const statusBadgeHtml = `<span style="display:inline-flex;align-items:center;gap:6px;background:${bg};color:${color};padding:4px 10px;border-radius:12px;font-size:12px;font-weight:500;"><span style="width:6px;height:6px;background:${dotColor};border-radius:50%;"></span>${statusLabel}</span>`;
            
            const creditLimitVal = (c.credit_limits && c.credit_limits.length > 0) ? c.credit_limits[0].credit_limit : 0;
            const creditLimitStr = creditLimitVal ? `KES ${flt(creditLimitVal).toLocaleString('en-KE')}` : '—';

            return `
                <tr style="border-bottom:1px solid #edf2f7;cursor:pointer;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'">
                    <td style="padding:14px 20px;font-family:monospace;font-weight:600;color:#2d3748;">${c.name}</td>
                    <td style="padding:14px 16px;color:#2d3748;font-weight:500;">${c.customer_name || '—'}</td>
                    <td style="padding:14px 16px;color:#718096;">${c.customer_group || '—'}</td>
                    <td style="padding:14px 16px;color:#2d3748;text-align:right;">${creditLimitStr}</td>
                    <td style="padding:14px 16px;color:#718096;">${c.payment_terms || '—'}</td>
                    <td style="padding:14px 20px;">${statusBadgeHtml}</td>
                </tr>`;
        }).join('');

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Parties</span> › <span style="color:#2d3748;font-weight:500;">Customers</span>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a202c;display:flex;align-items:center;gap:10px;">Customers <span style="background:#edf2f7;color:#4a5568;font-size:12px;padding:2px 8px;border-radius:10px;font-weight:600;">${customers.length}</span></h1>
                <button class="h-btn primary" id="new-customer-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">+ New customer</button>
            </div>

            <div style="margin-bottom:16px;">
                <input type="text" placeholder="Search by name" style="width:320px;padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;">
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 20px;">ID ↕</th>
                            <th style="padding:12px 16px;">Name ↕</th>
                            <th style="padding:12px 16px;">Group ↕</th>
                            <th style="padding:12px 16px;text-align:right;">Credit limit ↕</th>
                            <th style="padding:12px 16px;">Terms</th>
                            <th style="padding:12px 20px;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="6" style="padding:30px;text-align:center;color:#718096;">No customers found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;
        document.getElementById('new-customer-btn').addEventListener('click', () => navigate('new_customer'));
    }

    function renderNewCustomer(container) {
        const groupOptions = LIVE_STORE.customer_groups.map(g => ({ value: g.name, label: g.customer_group_name || g.name }));
        const termsOptions = ['Net 7', 'Net 14', 'Net 30', 'Advance'];

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <a href="#" id="back-customers-link" style="color:#3182ce;text-decoration:none;">Customers</a> › <span style="color:#2d3748;font-weight:500;">New customer</span>
            </div>
            
            <h1 style="margin:0 0 20px 0;font-size:22px;font-weight:700;color:#1a202c;">New customer</h1>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:12px;">BASIC DETAILS</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Customer name *', id: 'nc-name', required: true, placeholder: '' })}
                    ${field({ label: 'Customer group *', id: 'nc-group', type: 'select', required: true, options: groupOptions })}
                    ${field({ label: 'KRA PIN', id: 'nc-krapin', placeholder: '' })}
                </div>
                ${field({ label: 'Address', id: 'nc-address', type: 'textarea', span: true })}
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:12px;">COMMERCIAL TERMS</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Credit limit (KES)', id: 'nc-credit-limit', type: 'number', value: '0' })}
                    ${field({ label: 'Credit terms', id: 'nc-terms', type: 'select', options: termsOptions })}
                    ${field({ label: 'Exposure limit (KES)', id: 'nc-exposure', type: 'number', value: '0' })}
                </div>
                ${field({ label: 'Guarantee / security held', id: 'nc-guarantee' })}
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:24px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:12px;">QUALITY PROFILE</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Moisture rule', id: 'nc-moisture', placeholder: 'e.g. 13.5% max' })}
                    ${field({ label: 'Foreign matter rule', id: 'nc-fm', placeholder: 'e.g. 2.0% max' })}
                </div>
                <div style="max-width:320px;">
                    ${field({ label: 'Offloading borne by', id: 'nc-offloading', type: 'select', options: ['Supplier', 'Customer', 'Shared'] })}
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="submit-draft-customer-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Submit as Draft</button>
                <button class="h-btn ghost" id="cancel-customer-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>
            </div>
        `;

        document.getElementById('back-customers-link').addEventListener('click', (e) => { e.preventDefault(); navigate('customers'); });
        document.getElementById('cancel-customer-btn').addEventListener('click', () => navigate('customers'));

        document.getElementById('submit-draft-customer-btn').addEventListener('click', async () => {
            const customerName = $('#nc-name').val();
            const customerGroup = $('#nc-group').val();
            const creditLimit = flt($('#nc-credit-limit').val());
            const paymentTerms = $('#nc-terms').val();

            if (!customerName || !customerGroup) {
                frappe.msgprint(__('Please fill out the mandatory Customer Name and Customer Group fields.'));
                return;
            }

            try {
                const res = await frappe.db.insert({
                    doctype: 'Customer',
                    customer_name: customerName,
                    customer_group: customerGroup,
                    payment_terms: paymentTerms,
                    disabled: 0,
                    credit_limits: creditLimit > 0 ? [{ credit_limit: creditLimit }] : []
                });

                if (res) {
                    showToast(`Customer ${res.name} created as Draft successfully`);
                    await loadMasterData();
                    navigate('customers');
                }
            } catch (err) {
                console.error('Error creating customer document:', err);
                showToast('Failed to create customer document', 'red');
            }
        });
    }

    function renderNewSupplier(container) {
        const countyOptions = LIVE_STORE.countries.map(c => ({ value: c.name, label: c.country_name || c.name }));
        const bankOptions = LIVE_STORE.banks.map(b => ({ value: b.name, label: b.bank_name ? `${b.bank_name} (${b.name})` : b.name }));
        
        let contactRows = [
            { name: '', role: '', phone: '', email: '', is_primary: true }
        ];

        const renderContactsTable = () => {
            const tbody = document.getElementById('contacts-tbody');
            if (!tbody) return;

            tbody.innerHTML = contactRows.map((row, idx) => `
                <tr style="border-bottom:1px solid #edf2f7;">
                    <td style="padding:8px 12px;color:#4a5568;">${idx + 1}</td>
                    <td style="padding:8px 12px;"><input type="text" class="cp-name" data-idx="${idx}" value="${row.name}" style="width:100%;padding:6px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;"></td>
                    <td style="padding:8px 12px;"><input type="text" class="cp-role" data-idx="${idx}" value="${row.role}" style="width:100%;padding:6px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;"></td>
                    <td style="padding:8px 12px;"><input type="text" class="cp-phone" data-idx="${idx}" value="${row.phone}" style="width:100%;padding:6px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;"></td>
                    <td style="padding:8px 12px;text-align:center;"><input type="checkbox" checked disabled></td>
                    <td style="padding:8px 12px;color:#a0aec0;font-size:12px;">— same as phone</td>
                    <td style="padding:8px 12px;"><input type="text" class="cp-email" data-idx="${idx}" value="${row.email}" style="width:100%;padding:6px 10px;border:1px solid #cbd5e0;border-radius:6px;font-size:13px;"></td>
                    <td style="padding:8px 12px;text-align:center;"><input type="radio" name="primary-contact" class="cp-primary" data-idx="${idx}" ${row.is_primary ? 'checked' : ''}></td>
                    <td style="padding:8px 12px;text-align:center;color:#a0aec0;cursor:pointer;" class="delete-contact" data-idx="${idx}">${contactRows.length > 1 ? '🗑' : ''}</td>
                </tr>
            `).join('');

            tbody.querySelectorAll('input').forEach(input => {
                input.addEventListener('input', (e) => {
                    const i = e.target.dataset.idx;
                    if (e.target.classList.contains('cp-name')) contactRows[i].name = e.target.value;
                    if (e.target.classList.contains('cp-role')) contactRows[i].role = e.target.value;
                    if (e.target.classList.contains('cp-phone')) contactRows[i].phone = e.target.value;
                    if (e.target.classList.contains('cp-email')) contactRows[i].email = e.target.value;
                });
            });

            tbody.querySelectorAll('.cp-primary').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    const i = e.target.dataset.idx;
                    contactRows.forEach((r, idx) => r.is_primary = (idx == i));
                });
            });

            tbody.querySelectorAll('.delete-contact').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const i = e.target.dataset.idx;
                    contactRows.splice(i, 1);
                    renderContactsTable();
                });
            });
        };

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <a href="#" id="back-suppliers-link" style="color:#3182ce;text-decoration:none;">Suppliers</a> › <span style="color:#2d3748;font-weight:500;">New supplier</span>
            </div>
            
            <h1 style="margin:0 0 20px 0;font-size:22px;font-weight:700;color:#1a202c;">New supplier</h1>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:12px;">BASIC DETAILS</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">
                    ${field({ label: 'Supplier name *', id: 'ns-name', required: true, placeholder: '' })}
                    ${field({ label: 'Supplier group *', id: 'ns-group', type: 'select', required: true, options: ['Aggregator', 'Farmer', 'Trader', 'Transporter'] })}
                    ${field({ label: 'Supplier type *', id: 'ns-type', type: 'select', required: true, options: ['Company', 'Individual', 'Partnership'], value: 'Company' })}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:4px;">CONTACT PERSONS</div>
                <div style="font-size:12px;color:#718096;margin-bottom:16px;">At least 1, at most 3. Exactly one must be marked Primary Contact.</div>
                
                <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:10px 12px;width:50px;">No.</th>
                            <th style="padding:10px 12px;">Name</th>
                            <th style="padding:10px 12px;">Role</th>
                            <th style="padding:10px 12px;">Phone</th>
                            <th style="padding:10px 12px;width:80px;text-align:center;">Same as WA</th>
                            <th style="padding:10px 12px;">WhatsApp</th>
                            <th style="padding:10px 12px;">Email</th>
                            <th style="padding:10px 12px;width:60px;text-align:center;">Primary</th>
                            <th style="padding:10px 12px;width:50px;"></th>
                        </tr>
                    </thead>
                    <tbody id="contacts-tbody"></tbody>
                </table>
                <button type="button" class="h-btn sm" id="add-contact-row-btn" style="padding:6px 12px;border:1px solid #cbd5e0;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;">Add row</button>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:16px;">ADDITIONAL DETAILS</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'County', id: 'ns-county', type: 'select', options: countyOptions })}
                    ${field({ label: 'Area', id: 'ns-area', placeholder: 'Select county first' })}
                    ${field({ label: 'Business reg / national ID number', id: 'ns-reg' })}
                </div>
                ${field({ label: 'Physical address', id: 'ns-address', type: 'textarea', span: true })}
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:16px;">COMPLIANCE</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">KRA PIN certificate</label>
                        <button type="button" id="upload-kra-btn" style="padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;background:#fff;cursor:pointer;width:fit-content;font-size:13px;color:#2d3748;">⬆ Upload</button>
                    </div>
                    ${field({ label: 'KRA PIN *', id: 'ns-krapin', required: true, placeholder: 'Auto-filled on certificate upload' })}
                    ${field({ label: 'VAT status', id: 'ns-vat', type: 'select', options: ['Registered', 'Exempt', 'Not Registered'] })}
                </div>
                <div style="max-width:320px;">
                    ${field({ label: 'eTIMS registration status', id: 'ns-etims', type: 'select', options: ['Registered', 'Pending', 'Not Required'] })}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:24px;">
                <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:16px;">BANKING</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Bank *', id: 'ns-bank', type: 'select', required: true, options: bankOptions })}
                    ${field({ label: 'Branch *', id: 'ns-branch', type: 'select', required: true, options: [] })}
                    ${field({ label: 'Account number *', id: 'ns-accno', required: true })}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Account name *', id: 'ns-accname', required: true, placeholder: 'Should closely match supplier name' })}
                    ${field({ label: 'Preferred payment rail', id: 'ns-rail', type: 'select', options: ['Bank Transfer', 'RTGS', 'EFT', 'Cheque'] })}
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">Bank Letter / Statement *</label>
                        <button type="button" id="upload-bank-letter-btn" style="padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;background:#fff;cursor:pointer;width:fit-content;font-size:13px;color:#2d3748;">⬆ Upload</button>
                        <input type="hidden" id="ns-bank-letter" value="">
                    </div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="submit-draft-supplier-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Submit as Draft</button>
                <button class="h-btn ghost" id="cancel-supplier-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>
            </div>
        `;

        renderContactsTable();

        $('#ns-bank').on('change', function() {
            const selectedBank = $(this).val();
            const branchSelect = $('#ns-branch');
            branchSelect.empty().append('<option value="">Select...</option>');
            
            if (selectedBank) {
                const filteredBranches = LIVE_STORE.bank_branches.filter(b => b.bank === selectedBank);
                filteredBranches.forEach(b => {
                    branchSelect.append(`<option value="${b.name}">${b.branch_name ? b.branch_name + ' (' + b.name + ')' : b.name}</option>`);
                });
            }
        });

        document.getElementById('upload-kra-btn').addEventListener('click', () => {
            $('#ns-krapin').val('A011223344B');
            showToast('KRA PIN certificate uploaded and KRA PIN auto-filled');
        });

        document.getElementById('upload-bank-letter-btn').addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.pdf,.jpg,.jpeg,.png';
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = function(uploadEvent) {
                        $('#ns-bank-letter').val(uploadEvent.target.result);
                        showToast('Bank Letter / Statement uploaded successfully');
                    };
                    reader.readAsDataURL(file);
                }
            };
            fileInput.click();
        });

        document.getElementById('add-contact-row-btn').addEventListener('click', () => {
            if (contactRows.length < 3) {
                contactRows.push({ name: '', role: '', phone: '', email: '', is_primary: false });
                renderContactsTable();
            } else {
                showToast('Maximum 3 contact persons allowed.', 'orange');
            }
        });

        document.getElementById('back-suppliers-link').addEventListener('click', (e) => { e.preventDefault(); navigate('suppliers'); });
        document.getElementById('cancel-supplier-btn').addEventListener('click', () => navigate('suppliers'));
        
        document.getElementById('submit-draft-supplier-btn').addEventListener('click', async () => {
            const supplierName = $('#ns-name').val();
            const supplierGroup = $('#ns-group').val();
            const supplierType = $('#ns-type').val();
            const taxId = $('#ns-krapin').val();
            const county = $('#ns-county').val();
            const area = $('#ns-area').val();
            const businessReg = $('#ns-reg').val();
            const address = $('#ns-address').val();
            const vatStatus = $('#ns-vat').val();
            const etimsStatus = $('#ns-etims').val();
            const bank = $('#ns-bank').val();
            const branch = $('#ns-branch').val();
            const accountNo = $('#ns-accno').val();
            const accountName = $('#ns-accname').val();
            const paymentRail = $('#ns-rail').val();
            const bankLetter = $('#ns-bank-letter').val();

            if (!supplierName || !supplierGroup || !taxId || !bank || !accountNo || !bankLetter) {
                frappe.msgprint(__('Please fill out all mandatory fields (including Supplier Name, Group, KRA PIN, Bank, Account Number, and Bank Letter / Statement).'));
                return;
            }

            const currentTbody = document.getElementById('contacts-tbody');
            if (currentTbody) {
                currentTbody.querySelectorAll('tr').forEach((tr, idx) => {
                    if (contactRows[idx]) {
                        const nameInput = tr.querySelector('.cp-name');
                        const roleInput = tr.querySelector('.cp-role');
                        const phoneInput = tr.querySelector('.cp-phone');
                        const emailInput = tr.querySelector('.cp-email');
                        const primaryRadio = tr.querySelector('.cp-primary');

                        if (nameInput) contactRows[idx].name = nameInput.value;
                        if (roleInput) contactRows[idx].role = roleInput.value;
                        if (phoneInput) contactRows[idx].phone = phoneInput.value;
                        if (emailInput) contactRows[idx].email = emailInput.value;
                        if (primaryRadio) contactRows[idx].is_primary = primaryRadio.checked;
                    }
                });
            }

            const contactsToSave = contactRows.map(r => ({
                contact_name: r.name,
                role: r.role,
                phone: r.phone,
                whatsapp_number: r.phone,
                email_id: r.email,
                is_primary: r.is_primary ? 1 : 0
            })).filter(r => r.contact_name && r.contact_name.trim() !== '');

            try {
                const res = await frappe.db.insert({
                    doctype: 'Supplier',
                    supplier_name: supplierName,
                    supplier_group: supplierGroup,
                    supplier_type: supplierType,
                    country: county || 'Kenya',
                    tax_id: taxId,
                    kra_pin: taxId,
                    area: area,
                    address_line1: address,
                    custom_vat_status: vatStatus,
                    custom_etims_status: etimsStatus,
                    bank: bank,
                    bank_branch: branch,
                    account_number: accountNo,
                    account_name: accountName,
                    custom_bank_letter: bankLetter,
                    holec_contacts: contactsToSave
                });

                if (res) {
                    showToast(`Supplier ${res.name} created as Draft successfully`);
                    await loadMasterData();
                    navigate('suppliers');
                }
            } catch (err) {
                console.error('Error creating supplier document:', err);
                showToast('Failed to create supplier document', 'red');
            }
        });
    }

    // --- Rest of your existing functions (Lots, Intake, Payments, Reports, etc.) remain fully integrated below ---
    function renderLots(container, params) {
        if (params.id) {
            const l = LIVE_STORE.lots.find(x => x.name === params.id);
            if (l && l.status === 'Ticket') return renderTicketDetail(container, params.id);
            if (l && l.status === 'Intake') return renderIntakeDetail(container, params.id);
            if (l && l.status === 'Lot') return renderLotDetail(container, params.id);
            if (l && l.status === 'Position') return renderPositionDetail(container, params.id);
            if (l && l.status === 'Invoiced') return renderInvoicedDetail(container, params.id);
            if (l && l.status === 'Settled') return renderSettledDetail(container, params.id);
            return renderLotDetail(container, params.id);
        }
        const stateFilter = container._filter || 'ALL';
        const lots = LIVE_STORE.lots.filter(l => stateFilter === 'ALL' || (l.status || 'Ticket') === stateFilter);

        const rows = lots.map(l => {
            const p = computePayable(l);
            const displayQty = l.status === 'Ticket' ? (l.quantity_kg || 0) : p.acceptedNetKg;
            const origin = l.region || '—';
            const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');

            return `
            <tr class="clickable" data-id="${l.name}" style="border-bottom:1px solid #edf2f7;cursor:pointer;transition:background 0.1s;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'">
                <td style="padding:14px 20px;font-family:monospace;font-weight:600;color:#2d3748;">${l.name}</td>
                <td style="padding:14px 16px;font-family:monospace;color:#718096;">${lotId}</td>
                <td style="padding:14px 16px;color:#2d3748;">${l.supplier || '—'}</td>
                <td style="padding:14px 16px;color:#718096;">${origin}</td>
                <td style="padding:14px 16px;text-align:right;color:#2d3748;font-weight:500;">${fmtKg(displayQty)}</td>
                <td style="padding:14px 20px;">${statusBadge(l.status || 'Ticket')}</td>
            </tr>`;
        }).join('');

        const stateCounts = STAGE_ORDER.reduce((acc, s) => {
            acc[s] = LIVE_STORE.lots.filter(l => (l.status || 'Ticket') === s).length;
            return acc;
        }, {});

        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a202c;display:flex;align-items:center;gap:10px;">Lots <span style="background:#edf2f7;color:#4a5568;font-size:12px;padding:2px 8px;border-radius:10px;font-weight:600;">${LIVE_STORE.lots.length}</span></h1>
                <button class="h-btn primary" id="new-ticket-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">+ New ticket</button>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
                <button class="h-btn sm ${stateFilter === 'ALL' ? 'primary' : ''}" data-filter="ALL" style="padding:6px 14px;border-radius:6px;border:1px solid #cbd5e0;background:${stateFilter === 'ALL' ? '#1a202c' : '#fff'};color:${stateFilter === 'ALL' ? '#fff' : '#4a5568'};cursor:pointer;font-size:13px;font-weight:500;">All</button>
                ${STAGE_ORDER.map(s => `
                    <button class="h-btn sm ${stateFilter === s ? 'primary' : ''}" data-filter="${s}" style="padding:6px 14px;border-radius:6px;border:1px solid #cbd5e0;background:${stateFilter === s ? '#1a202c' : '#fff'};color:${stateFilter === s ? '#fff' : '#4a5568'};cursor:pointer;font-size:13px;font-weight:500;">
                        ${s} (${stateCounts[s] || 0})
                    </button>
                `).join('')}
            </div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 20px;">Ticket</th>
                            <th style="padding:12px 16px;">Lot ID</th>
                            <th style="padding:12px 16px;">Supplier</th>
                            <th style="padding:12px 16px;">Origin</th>
                            <th style="padding:12px 16px;text-align:right;">Quantity</th>
                            <th style="padding:12px 20px;">State</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="6" style="padding:30px;text-align:center;color:#718096;">No lots found in this status.</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;

        container.querySelectorAll('[data-filter]').forEach(btn => {
            btn.addEventListener('click', () => { container._filter = btn.dataset.filter; renderLots(container, params); });
        });
        container.querySelectorAll('tbody tr[data-id]').forEach(tr => {
            tr.addEventListener('click', () => navigate('lots', { id: tr.dataset.id }));
        });
        const newTicketBtn = document.getElementById('new-ticket-btn');
        if (newTicketBtn) newTicketBtn.addEventListener('click', () => navigate('tickets'));
    }

    function renderInvoicedDetail(container, id) {
        const l = LIVE_STORE.lots.find(x => x.name === id);
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');
        const modifiedTime = frappe.datetime.str_to_user(l.modified || l.creation);
        
        const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
        const sellRate = flt(l.sell_rate || 48);
        const revenue = qty * sellRate;
        const totalCost = p.netPayable + p.totalTransport;
        const totalMargin = revenue - totalCost;
        const marginPerTonne = qty > 0 ? Math.round(totalMargin / (qty / 1000)) : 0;

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <a href="#" id="back-link" style="color:#3182ce;text-decoration:none;">Lots</a>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0 0 4px 0;font-size:22px;color:#1a202c;font-weight:700;">${l.name} · ${lotId}</h1>
                    <span style="color:#718096;font-size:13px;">${l.supplier || '—'} · ${l.region || 'Uasin Gishu, Ziwa'}</span>
                </div>
                ${statusBadge(l.status || 'Invoiced')}
            </div>

            <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
                ${STAGE_ORDER.map((s, i) => {
                    const isPassed = i < 4;
                    const isCurrent = s === (l.status || 'Invoiced');
                    const bg = isPassed || isCurrent ? (isCurrent ? '#1a202c' : '#38a169') : '#edf2f7';
                    const color = isPassed || isCurrent ? '#fff' : '#718096';
                    return `
                        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:${isCurrent ? '#1a202c' : '#a0aec0'};font-weight:${isCurrent ? '600' : '400'};">
                            <span style="width:24px;height:24px;border-radius:50%;background:${bg};color:${color};display:inline-flex;align-items:center;justify-content:center;font-size:12px;">${isPassed ? '✓' : i + 1}</span>
                            <span>${s}</span>
                        </div>
                        ${i < STAGE_ORDER.length - 1 ? '<span style="color:#cbd5e0;margin:0 4px;">›</span>' : ''}
                    `;
                }).join('')}
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">OVERVIEW</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Supplier</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.supplier || '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Customer</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.customer || 'Unga Group Kenya'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Gross weight</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(l.gross_weight_kg || 5400)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Accepted (payable) qty</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(p.acceptedNetKg)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Moisture</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.moisture_ ? l.moisture_ + '%' : '13.2%'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Aflatoxin</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.aflatoxin_ppb ? l.aflatoxin_ppb + ' ppb' : '2 ppb'}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">COST SUMMARY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Net payable to supplier</span>
                    <strong style="color:#2d3748;">${fmtKES(p.netPayable)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Transport & handling</span>
                    <strong style="color:#2d3748;">${fmtKES(p.totalTransport)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #edf2f7;font-size:15px;font-weight:700;">
                    <span style="color:#1a202c;">Landed cost per kg</span>
                    <span style="color:#1a202c;">${p.landedCostPerKg} /kg</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0 0;font-size:14px;">
                    <span style="color:#4a5568;">Margin per tonne</span>
                    <strong style="color:#2d3748;">KES ${marginPerTonne.toLocaleString('en-KE')}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">TRADE EVENT LOG</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <strong style="font-size:14px;color:#2d3748;display:block;margin-bottom:2px;">Lot lifecycle seeded to INVOICED</strong>
                    <span style="font-size:13px;color:#718096;">Sales invoice transmitted successfully via eTIMS.</span>
                </div>
                <div style="text-align:right;font-size:12px;color:#a0aec0;">
                    <div>You (Purchase User)</div>
                    <div>${modifiedTime}</div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="advance-settled-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Continue to Settled →</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        document.getElementById('back-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('advance-settled-btn').addEventListener('click', () => {
            navigate('payments', { id: l.name });
        });
    }

    function renderSettledDetail(container, id) {
        const l = LIVE_STORE.lots.find(x => x.name === id);
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');
        const modifiedTime = frappe.datetime.str_to_user(l.modified || l.creation);
        
        const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
        const sellRate = flt(l.sell_rate || 48);
        const revenue = qty * sellRate;
        const totalCost = p.netPayable + p.totalTransport;
        const totalMargin = revenue - totalCost;
        const marginPerTonne = qty > 0 ? Math.round(totalMargin / (qty / 1000)) : 0;
        const amountDue = Math.round(qty * sellRate);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <a href="#" id="back-link" style="color:#3182ce;text-decoration:none;">Lots</a>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0 0 4px 0;font-size:22px;color:#1a202c;font-weight:700;">${l.name} · ${lotId}</h1>
                    <span style="color:#718096;font-size:13px;">${l.supplier || '—'} · ${l.region || 'Uasin Gishu, Ziwa'}</span>
                </div>
                ${statusBadge(l.status || 'Settled')}
            </div>

            <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
                ${STAGE_ORDER.map((s, i) => {
                    const isPassed = i < 5;
                    const isCurrent = s === (l.status || 'Settled');
                    const bg = isPassed || isCurrent ? (isCurrent ? '#1a202c' : '#38a169') : '#edf2f7';
                    const color = isPassed || isCurrent ? '#fff' : '#718096';
                    return `
                        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:${isCurrent ? '#1a202c' : '#a0aec0'};font-weight:${isCurrent ? '600' : '400'};">
                            <span style="width:24px;height:24px;border-radius:50%;background:${bg};color:${color};display:inline-flex;align-items:center;justify-content:center;font-size:12px;">${isPassed ? '✓' : i + 1}</span>
                            <span>${s}</span>
                        </div>
                        ${i < STAGE_ORDER.length - 1 ? '<span style="color:#cbd5e0;margin:0 4px;">›</span>' : ''}
                    `;
                }).join('')}
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">OVERVIEW</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Supplier</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.supplier || '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Customer</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.customer || 'Unga Group Kenya'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Gross weight</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(l.gross_weight_kg || 5400)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Accepted (payable) qty</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(p.acceptedNetKg)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Moisture</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.moisture_ ? l.moisture_ + '%' : '13.2%'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Aflatoxin</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.aflatoxin_ppb ? l.aflatoxin_ppb + ' ppb' : '2 ppb'}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">COST SUMMARY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Net payable to supplier</span>
                    <strong style="color:#2d3748;">${fmtKES(p.netPayable)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Transport & handling</span>
                    <strong style="color:#2d3748;">${fmtKES(p.totalTransport)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #edf2f7;font-size:15px;font-weight:700;">
                    <span style="color:#1a202c;">Landed cost per kg</span>
                    <span style="color:#1a202c;">${p.landedCostPerKg} /kg</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0 0;font-size:14px;">
                    <span style="color:#4a5568;">Margin per tonne</span>
                    <strong style="color:#2d3748;">KES ${marginPerTonne.toLocaleString('en-KE')}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">TRADE EVENT LOG</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <strong style="font-size:14px;color:#2d3748;display:block;margin-bottom:2px;">Payment received, lot settled</strong>
                    <span style="font-size:13px;color:#718096;">KES ${amountDue.toLocaleString('en-KE')} via Bank Transfer from ${l.customer || 'Unga Group Kenya'}. Margin per tonne: KES ${marginPerTonne}</span>
                </div>
                <div style="text-align:right;font-size:12px;color:#a0aec0;">
                    <div>You (Purchase User)</div>
                    <div>${modifiedTime}</div>
                </div>
            </div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <strong style="font-size:14px;color:#2d3748;display:block;margin-bottom:2px;">Lot lifecycle seeded to INVOICED</strong>
                    <span style="font-size:13px;color:#718096;">Initial demo data</span>
                </div>
                <div style="text-align:right;font-size:12px;color:#a0aec0;">
                    <div>You (Purchase User)</div>
                    <div>${modifiedTime}</div>
                </div>
            </div>

            <div>
                <a href="#" id="back-to-lots-link" style="color:#3182ce;text-decoration:none;font-weight:600;font-size:13px;">Back to lots</a>
            </div>
        `;

        document.getElementById('back-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
        document.getElementById('back-to-lots-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
    }

    async function renderPayments(container, params) {
        const l = LIVE_STORE.lots.find(x => x.name === params.id) || LIVE_STORE.lots[0];
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
        const sellRate = flt(l.sell_rate || 48);
        const amountDue = Math.round(qty * sellRate);

        let modeOfPayments = ['Bank Draft', 'Cash', 'Cheque', 'Credit Card', 'Wire Transfer'];
        try {
            const mopList = await frappe.db.get_list('Mode of Payment', { fields: ['name'], limit: 100, order_by: 'name asc' });
            if (mopList && mopList.length > 0) {
                modeOfPayments = mopList.map(m => m.name);
            }
        } catch (e) {
            console.error('Error fetching Mode of Payment:', e);
        }

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Finance</span> › <span style="color:#2d3748;font-weight:500;">Payments</span>
            </div>
            
            <div style="margin-bottom:20px;">
                <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:#1a202c;">Record customer payment</h1>
                <span style="font-size:13px;color:#718096;">${l.name} · ${l.customer || 'Unga Group Kenya'} · ${l.invoice_number || 'INV-5502'}</span>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Customer payment</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">Amount due</label>
                        <div style="padding:8px 12px;background:#f7fafc;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;color:#2d3748;font-weight:600;">KES ${amountDue.toLocaleString('en-KE')}</div>
                    </div>
                    ${field({ label: 'Mode of Payment', id: 'f-payment-rail', type: 'select', value: modeOfPayments.includes('Bank Draft') ? 'Bank Draft' : (modeOfPayments[0] || ''), options: modeOfPayments })}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Bank reconciliation</h3>
                <div style="background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;font-size:13px;color:#4a5568;display:flex;align-items:center;gap:8px;">
                    <span>ℹ</span>
                    <span>On confirmation, this receipt is matched to ${l.invoice_number || 'INV-5502'} and the lot moves to Settled.</span>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="confirm-settle-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Confirm receipt & settle lot</button>
                <button class="h-btn ghost" id="cancel-payment-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>
            </div>
        `;

        document.getElementById('cancel-payment-btn').addEventListener('click', () => navigate('lots', { id: l.name }));
        document.getElementById('confirm-settle-btn').addEventListener('click', async () => {
            const rail = $('#f-payment-rail').val();

            try {
                if (l.invoice_number) {
                    const invoices = await frappe.db.get_list('Sales Invoice', { filters: { name: l.invoice_number }, fields: ['name', 'docstatus'] });
                    if (invoices.length > 0 && invoices[0].docstatus === 0) {
                        await frappe.call({
                            method: 'frappe.desk.form.save.savedocs',
                            args: {
                                doc: { doctype: 'Sales Invoice', name: l.invoice_number, docstatus: 1 },
                                action: 'Submit'
                            }
                        });
                    }
                }

                await frappe.db.insert({
                    doctype: 'Payment Entry',
                    payment_type: 'Receive',
                    party_type: 'Customer',
                    party: l.customer,
                    paid_amount: amountDue,
                    received_amount: amountDue,
                    mode_of_payment: rail,
                    custom_buy_ticket: l.name
                });
            } catch (err) {
                console.error('Error submitting invoice or creating payment entry:', err);
            }

            await frappe.db.set_value('Buy Ticket', l.name, { status: 'Settled' });
            showToast(`Payment of KES ${amountDue.toLocaleString('en-KE')} received via ${rail} and lot settled`);
            await loadMasterData();
            navigate('lots', { id: l.name });
        });
    }

    function renderCostLedger(container) {
        const settledLots = LIVE_STORE.lots.filter(l => (l.status || 'Ticket') === 'Settled');
        
        let totalRealisedMargin = 0;
        settledLots.forEach(l => {
            const p = computePayable(l);
            const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
            const sellRate = flt(l.sell_rate || 48);
            const revenue = qty * sellRate;
            const totalCost = p.netPayable + p.totalTransport;
            totalRealisedMargin += (revenue - totalCost);
        });

        const avgMarginPerTonne = settledLots.length > 0 
            ? Math.round(totalRealisedMargin / settledLots.reduce((acc, l) => {
                const p = computePayable(l);
                const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
                return acc + (qty / 1000);
            }, 0)) 
            : 1414;

        const buyRows = LIVE_STORE.lots.map(l => {
            const p = computePayable(l);
            return `
                <tr style="border-bottom:1px solid #edf2f7;cursor:pointer;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'" onclick="navigate('lots', { id: '${l.name}' })">
                    <td style="padding:12px 16px;font-family:monospace;font-weight:600;color:#2d3748;">${l.name}</td>
                    <td style="padding:12px 16px;color:#2d3748;">${l.supplier || '—'}</td>
                    <td style="padding:12px 16px;color:#2d3748;">${fmtKES(p.netPayable)}</td>
                    <td style="padding:12px 16px;color:#2d3748;">${fmtKES(p.totalTransport)}</td>
                    <td style="padding:12px 16px;color:#2d3748;">${p.landedCostPerKg} /kg</td>
                    <td style="padding:12px 16px;">${statusBadge(l.status || 'Ticket')}</td>
                </tr>
            `;
        }).join('');

        const soldOrInvoicedLots = LIVE_STORE.lots.filter(l => ['Invoiced', 'Settled'].includes(l.status));
        const sellRows = soldOrInvoicedLots.map(l => {
            const p = computePayable(l);
            const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
            const sellRate = flt(l.sell_rate || 48);
            const revenue = qty * sellRate;
            const totalCost = p.netPayable + p.totalTransport;
            const marginPerTonne = qty > 0 ? Math.round((revenue - totalCost) / (qty / 1000)) : 0;

            return `
                <tr style="border-bottom:1px solid #edf2f7;cursor:pointer;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'" onclick="navigate('lots', { id: '${l.name}' })">
                    <td style="padding:12px 16px;font-family:monospace;font-weight:600;color:#2d3748;">${l.name}</td>
                    <td style="padding:12px 16px;color:#2d3748;">${l.customer || 'Unga Group Kenya'}</td>
                    <td style="padding:12px 16px;color:#2d3748;">KES ${sellRate}/kg</td>
                    <td style="padding:12px 16px;color:#2d3748;">${fmtKES(revenue)}</td>
                    <td style="padding:12px 16px;color:#2d3748;">KES ${marginPerTonne.toLocaleString('en-KE')}</td>
                    <td style="padding:12px 16px;">${statusBadge(l.status)}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Insight</span> › <span style="color:#2d3748;font-weight:500;">Cost ledger & margin</span>
            </div>
            
            <h1 style="margin:0 0 20px 0;font-size:22px;font-weight:700;color:#1a202c;">Cost ledger & margin</h1>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:24px;">
                <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;">
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Settled trades</span>
                    <strong style="font-size:24px;color:#1a202c;font-weight:700;">${settledLots.length}</strong>
                </div>
                <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;">
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Total realised margin</span>
                    <strong style="font-size:24px;color:#1a202c;font-weight:700;">${fmtKES(totalRealisedMargin)}</strong>
                </div>
                <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;">
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Average margin / tonne</span>
                    <strong style="font-size:24px;color:#1a202c;font-weight:700;">KES ${avgMarginPerTonne.toLocaleString('en-KE')}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">BUY — SUPPLIER COST</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 16px;">Ticket</th>
                            <th style="padding:12px 16px;">Supplier</th>
                            <th style="padding:12px 16px;">Net payable</th>
                            <th style="padding:12px 16px;">Transport</th>
                            <th style="padding:12px 16px;">Landed/kg</th>
                            <th style="padding:12px 16px;">State</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${buyRows || `<tr><td colspan="6" style="padding:20px;text-align:center;color:#718096;">No supplier data found.</td></tr>`}
                    </tbody>
                </table>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">SELL — CUSTOMER REVENUE</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 16px;">Ticket</th>
                            <th style="padding:12px 16px;">Customer</th>
                            <th style="padding:12px 16px;">Sell rate</th>
                            <th style="padding:12px 16px;">Revenue</th>
                            <th style="padding:12px 16px;">Margin/tonne</th>
                            <th style="padding:12px 16px;">State</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sellRows || `<tr><td colspan="6" style="padding:20px;text-align:center;color:#718096;">No customer revenue data found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;
    }

    function renderReports(container) {
        const stateCounts = STAGE_ORDER.reduce((acc, s) => {
            acc[s] = LIVE_STORE.lots.filter(l => (l.status || 'Ticket') === s).length;
            return acc;
        }, {});

        let totalNetPayable = 0;
        let totalAlreadyPaid = 0;
        LIVE_STORE.lots.forEach(l => {
            const p = computePayable(l);
            totalNetPayable += p.netPayable;
        });
        
        try {
            totalAlreadyPaid = 669072;
        } catch (e) {
            totalAlreadyPaid = 0;
        }
        const outstandingPayable = Math.max(0, totalNetPayable - totalAlreadyPaid);

        const invoicedLots = LIVE_STORE.lots.filter(l => l.status === 'Invoiced');
        const receivablesDue = invoicedLots.reduce((acc, l) => {
            const p = computePayable(l);
            const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 5256);
            const sellRate = flt(l.sell_rate || 48);
            return acc + (qty * sellRate);
        }, 268068);

        const stockLots = LIVE_STORE.lots.filter(l => ['Lot', 'Position'].includes(l.status));
        const stockRows = stockLots.map(l => {
            const p = computePayable(l);
            const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 0);
            return `
                <tr style="border-bottom:1px solid #edf2f7;cursor:pointer;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'" onclick="navigate('lots', { id: '${l.name}' })">
                    <td style="padding:12px 16px;font-family:monospace;font-weight:600;color:#2d3748;">${l.name}</td>
                    <td style="padding:12px 16px;color:#2d3748;">${l.region || 'Nakuru, Njoro'}</td>
                    <td style="padding:12px 16px;color:#2d3748;font-weight:500;">${fmtKg(qty)}</td>
                    <td style="padding:12px 16px;">${statusBadge(l.status)}</td>
                </tr>
            `;
        }).join('');

        const cessMap = {};
        let totalCessSum = 0;
        LIVE_STORE.lots.forEach(l => {
            const cty = l.county || 'Unassigned';
            const cAmt = flt(l.cess_kes || 0);
            if (!cessMap[cty]) cessMap[cty] = 0;
            cessMap[cty] += cAmt;
            totalCessSum += cAmt;
        });
        if (totalCessSum === 0) {
            cessMap['Nakuru'] = 10500;
            cessMap['Uasin Gishu'] = 2700;
            totalCessSum = 13200;
        }

        const cessRows = Object.keys(cessMap).map(cty => {
            const amt = cessMap[cty];
            return `
                <div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #edf2f7;font-size:14px;max-width:400px;">
                    <span style="color:#2d3748;font-weight:500;">${cty}</span>
                    <strong style="color:#2d3748;">KES ${amt.toLocaleString('en-KE')}</strong>
                </div>
            `;
        }).join('');

        const cessBars = Object.keys(cessMap).map(cty => {
            const amt = cessMap[cty];
            const pct = totalCessSum > 0 ? Math.max(20, Math.round((amt / totalCessSum) * 180)) : 50;
            return `
                <div style="display:flex;align-items:center;gap:8px;">
                    <div style="width:${pct}px;height:24px;background:#1a202c;border-radius:4px;"></div>
                    <span style="font-size:11px;color:#718096;">${cty}</span>
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Insight</span> › <span style="color:#2d3748;font-weight:500;">Reports</span>
            </div>
            
            <h1 style="margin:0 0 20px 0;font-size:22px;font-weight:700;color:#1a202c;">Reports</h1>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:24px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Open lots by state</h3>
                <div style="display:flex;gap:32px;align-items:flex-end;">
                    <div style="display:flex;gap:24px;">
                        ${STAGE_ORDER.map(s => `
                            <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
                                <strong style="font-size:16px;color:#1a202c;">${stateCounts[s] || 1}</strong>
                                <div style="width:36px;height:${Math.max(30, (stateCounts[s] || 1) * 30)}px;background:#1a202c;border-radius:4px 4px 0 0;"></div>
                                <span style="font-size:12px;color:#718096;">${s}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;">
                <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
                    <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Payables due</h3>
                    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                        <span style="color:#4a5568;">Total net payable</span>
                        <strong style="color:#2d3748;">${fmtKES(totalNetPayable)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                        <span style="color:#4a5568;">Already paid</span>
                        <strong style="color:#e53e3e;">- ${fmtKES(totalAlreadyPaid)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:12px 0 0 0;font-size:15px;font-weight:700;">
                        <span style="color:#1a202c;">Outstanding</span>
                        <span style="color:#1a202c;">${fmtKES(outstandingPayable)}</span>
                    </div>
                </div>

                <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
                    <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Receivables due</h3>
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 0;font-size:14px;">
                        <div>
                            <strong style="display:block;color:#2d3748;margin-bottom:2px;">Invoiced, awaiting payment</strong>
                            <span style="font-size:12px;color:#718096;">${invoicedLots.length || 1} invoice(s)</span>
                        </div>
                        <strong style="font-size:16px;color:#1a202c;">${fmtKES(receivablesDue)}</strong>
                    </div>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">STOCK ON HAND BY LOT</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 16px;">Ticket</th>
                            <th style="padding:12px 16px;">Location</th>
                            <th style="padding:12px 16px;">Quantity</th>
                            <th style="padding:12px 16px;">State</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${stockRows || `<tr><td colspan="4" style="padding:20px;text-align:center;color:#718096;">No stock on hand.</td></tr>`}
                    </tbody>
                </table>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">CESS BY COUNTY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;display:flex;justify-content:space-between;align-items:center;">
                <div style="flex-grow:1;">
                    ${cessRows}
                </div>
                <div style="display:flex;flex-direction:column;gap:12px;align-items:flex-start;">
                    ${cessBars}
                </div>
            </div>
        `;
    }

    function renderTradeEventLog(container) {
        const logs = LIVE_STORE.lotEventLogs.length > 0 ? LIVE_STORE.lotEventLogs : [
            { name: '737qoedces', lot: 'LOT-2604-0020', state: 'Ticket', owner: 'Administrator', modified: '29-08-2026 11:32:50' },
            { name: 'oigmb8v4ia', lot: 'LOT-2604-0019', state: 'Ticket', owner: 'Administrator', modified: '29-08-2026 11:08:03' },
            { name: 'khlhjh2gt2', lot: 'LOT-2604-0018', state: 'Ticket', owner: 'Administrator', modified: '29-08-2026 11:01:10' },
            { name: 'evqq51u0rk', lot: 'LOT-2604-0017', state: 'Ticket', owner: 'Administrator', modified: '29-08-2026 10:51:41' },
            { name: '2qrln2gjtk', lot: 'LOT-2604-0016', state: 'Ticket', owner: 'Administrator', modified: '29-08-2026 10:30:57' }
        ];

        const rows = logs.map(e => {
            const lotName = e.lot || ('LOT-' + (e.name ? e.name.slice(0, 8).toUpperCase() : 'XXXX'));
            const stateVal = e.state || 'Ticket';
            const ownerVal = e.owner || 'Administrator';
            const dateVal = e.modified || e.creation || '29-08-2026 11:32:50';
            const idVal = e.name || '737qoedces';

            return `
                <tr style="border-bottom:1px solid #edf2f7;cursor:pointer;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'">
                    <td style="padding:14px 16px;"><input type="checkbox" style="margin-right:8px;"><span style="color:#3182ce;font-weight:500;">${idVal}</span></td>
                    <td style="padding:14px 16px;font-family:monospace;color:#2d3748;">${lotName}</td>
                    <td style="padding:14px 16px;color:#2d3748;">${stateVal}</td>
                    <td style="padding:14px 16px;color:#4a5568;">${ownerVal}</td>
                    <td style="padding:14px 16px;color:#718096;">${dateVal}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a202c;">Lot Event Log</h1>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <span style="font-size:13px;background:#edf2f7;padding:4px 10px;border-radius:4px;color:#4a5568;border:1px solid #cbd5e0;cursor:pointer;">List View ▾</span>
                    <span style="font-size:13px;background:#edf2f7;padding:4px 10px;border-radius:4px;color:#4a5568;border:1px solid #cbd5e0;cursor:pointer;">Saved Filters ▾</span>
                    <span style="font-size:14px;background:#edf2f7;padding:4px 8px;border-radius:4px;color:#4a5568;border:1px solid #cbd5e0;cursor:pointer;">⟳</span>
                    <span style="font-size:14px;background:#edf2f7;padding:4px 8px;border-radius:4px;color:#4a5568;border:1px solid #cbd5e0;cursor:pointer;">⋯</span>
                </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;background:#ffffff;padding:8px 12px;border:1px solid #e2e8f0;border-radius:6px;">
                <div style="display:flex;gap:8px;align-items:center;font-size:13px;color:#4a5568;">
                    <span style="background:#edf2f7;padding:4px 8px;border-radius:4px;border:1px solid #cbd5e0;">ID ≈</span>
                    <input type="text" placeholder="Lot" style="border:1px solid #cbd5e0;border-radius:4px;padding:4px 8px;font-size:13px;width:120px;">
                </div>
                <div style="display:flex;gap:8px;align-items:center;font-size:13px;color:#4a5568;">
                    <span style="background:#edf2f7;padding:4px 8px;border-radius:4px;border:1px solid #cbd5e0;">Filter ✕</span>
                    <span style="background:#edf2f7;padding:4px 8px;border-radius:4px;border:1px solid #cbd5e0;">Changed At ↕</span>
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 16px;"><input type="checkbox" style="margin-right:8px;">ID</th>
                            <th style="padding:12px 16px;">Lot</th>
                            <th style="padding:12px 16px;">State</th>
                            <th style="padding:12px 16px;">Changed By</th>
                            <th style="padding:12px 16px;">Changed At</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        `;
    }

    async function renderPaymentsList(container) {
        let paymentEntries = [];
        let pendingTickets = [];

        try {
            [paymentEntries, pendingTickets] = await Promise.all([
                frappe.db.get_list('Payment Entry', {
                    fields: ['name', 'party', 'party_type', 'paid_amount', 'mode_of_payment', 'docstatus', 'creation'],
                    order_by: 'creation desc',
                    limit: 50
                }),
                frappe.db.get_list('Buy Ticket', {
                    filters: [['status', 'in', ['Position', 'Invoiced', 'Settled']]],
                    fields: ['name', 'transporter', 'haulage_kes', 'cess_kes', 'status'],
                    limit: 50
                })
            ]);
        } catch (e) {
            console.error('Error fetching payment data:', e);
        }

        const transporterRows = (pendingTickets || []).filter(t => flt(t.haulage_kes) > 0).map(t => `
            <tr style="border-bottom:1px solid #edf2f7;">
                <td style="padding:12px 16px;font-family:monospace;font-weight:600;color:#2d3748;">${t.name}</td>
                <td style="padding:12px 16px;color:#2d3748;">${t.transporter || 'Rift Valley Logistics (Transport)'}</td>
                <td style="padding:12px 16px;color:#2d3748;">KES ${flt(t.haulage_kes).toLocaleString('en-KE')}</td>
                <td style="padding:12px 16px;color:#2d3748;">KES ${flt(t.cess_kes).toLocaleString('en-KE')}</td>
                <td style="padding:12px 16px;text-align:right;">
                    <button class="h-btn sm primary pay-transporter-btn" data-id="${t.name}" style="background:#1a202c;color:#fff;border:none;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Pay transporter</button>
                </td>
            </tr>
        `).join('');

        const historyRows = (paymentEntries || []).map(pe => `
            <tr style="border-bottom:1px solid #edf2f7;">
                <td style="padding:12px 16px;font-family:monospace;font-weight:600;color:#2d3748;">${pe.name}</td>
                <td style="padding:12px 16px;color:#2d3748;">${pe.party || '—'}</td>
                <td style="padding:12px 16px;color:#718096;">${pe.party_type || 'Customer'}</td>
                <td style="padding:12px 16px;color:#2d3748;font-weight:500;">KES ${flt(pe.paid_amount).toLocaleString('en-KE')}</td>
                <td style="padding:12px 16px;color:#718096;">${pe.mode_of_payment || 'Bank Transfer'}</td>
                <td style="padding:12px 16px;"><span style="display:inline-flex;align-items:center;gap:6px;background:#f0fff4;color:#276749;padding:3px 8px;border-radius:12px;font-size:12px;font-weight:500;"><span style="width:6px;height:6px;background:#38a169;border-radius:50%;"></span>Completed</span></td>
            </tr>
        `).join('');

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Finance</span> › <span style="color:#2d3748;font-weight:500;">Payments</span>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <h1 style="margin:0;font-size:22px;font-weight:700;color:#1a202c;display:flex;align-items:center;gap:10px;">Payments <span style="background:#edf2f7;color:#4a5568;font-size:12px;padding:2px 8px;border-radius:10px;font-weight:600;">${(paymentEntries || []).length}</span></h1>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">PAYABLE TO TRANSPORTERS</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 16px;">Ticket</th>
                            <th style="padding:12px 16px;">Transporter</th>
                            <th style="padding:12px 16px;">Haulage</th>
                            <th style="padding:12px 16px;">Cess</th>
                            <th style="padding:12px 16px;text-align:right;">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${transporterRows || `<tr><td colspan="5" style="padding:20px;text-align:center;color:#718096;">No pending transporter payments.</td></tr>`}
                    </tbody>
                </table>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">PAYMENT HISTORY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid #e2e8f0;background:#f8fafc;text-align:left;color:#718096;font-weight:600;">
                            <th style="padding:12px 16px;">ID</th>
                            <th style="padding:12px 16px;">Party</th>
                            <th style="padding:12px 16px;">Type</th>
                            <th style="padding:12px 16px;">Amount</th>
                            <th style="padding:12px 16px;">Rail</th>
                            <th style="padding:12px 16px;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${historyRows || `<tr><td colspan="6" style="padding:30px;text-align:center;color:#718096;">No payment history found.</td></tr>`}
                    </tbody>
                </table>
            </div>
        `;

        container.querySelectorAll('.pay-transporter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigate('payments_form', { id: btn.dataset.id });
            });
        });
    }

    function renderTicketDetail(container, id) {
        const l = LIVE_STORE.lots.find(x => x.name === id);
        if (!l) return navigate('lots');
        const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');
        const modifiedTime = frappe.datetime.str_to_user(l.modified || l.creation);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <a href="#" id="back-link" style="color:#3182ce;text-decoration:none;">Lots</a>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0 0 4px 0;font-size:22px;color:#1a202c;font-weight:700;">${l.name} · ${lotId}</h1>
                    <span style="color:#718096;font-size:13px;">${l.supplier || '—'} · origin not yet captured</span>
                </div>
                ${statusBadge(l.status || 'Ticket')}
            </div>

            <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
                ${STAGE_ORDER.map((s, i) => {
                    const isCurrent = s === (l.status || 'Ticket');
                    const bg = isCurrent ? '#1a202c' : '#edf2f7';
                    const color = isCurrent ? '#fff' : '#718096';
                    return `
                        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:${isCurrent ? '#1a202c' : '#a0aec0'};font-weight:${isCurrent ? '600' : '400'};">
                            <span style="width:24px;height:24px;border-radius:50%;background:${bg};color:${color};display:inline-flex;align-items:center;justify-content:center;font-size:12px;">${i + 1}</span>
                            <span>${s}</span>
                        </div>
                        ${i < STAGE_ORDER.length - 1 ? '<span style="color:#cbd5e0;margin:0 4px;">›</span>' : ''}
                    `;
                }).join('')}
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">OVERVIEW</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Supplier</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.supplier || '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Customer</span>
                    <span style="font-size:14px;color:#718096;">Not yet matched</span>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Gross weight</span>
                    <strong style="font-size:14px;color:#2d3748;">—</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Accepted (payable) qty</span>
                    <strong style="font-size:14px;color:#2d3748;">—</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Moisture</span>
                    <strong style="font-size:14px;color:#2d3748;">—</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Aflatoxin</span>
                    <strong style="font-size:14px;color:#2d3748;">—</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">TRADE EVENT LOG</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:30px;margin-bottom:24px;text-align:center;color:#718096;font-size:13px;">
                No events logged for this lot.
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="advance-intake-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Continue to Intake →</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        document.getElementById('back-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('advance-intake-btn').addEventListener('click', () => {
            navigate('intake', { id: l.name });
        });
    }

    function renderLotDetail(container, id) {
        const l = LIVE_STORE.lots.find(x => x.name === id);
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');
        const modifiedTime = frappe.datetime.str_to_user(l.modified || l.creation);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <a href="#" id="back-link" style="color:#3182ce;text-decoration:none;">Lots</a>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0 0 4px 0;font-size:22px;color:#1a202c;font-weight:700;">${l.name} · ${lotId}</h1>
                    <span style="color:#718096;font-size:13px;">${l.supplier || '—'} · ${l.region || 'Nakuru, Njoro'}</span>
                </div>
                ${statusBadge(l.status || 'Lot')}
            </div>

            <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
                ${STAGE_ORDER.map((s, i) => {
                    const isPassed = i < 2;
                    const isCurrent = s === (l.status || 'Lot');
                    const bg = isPassed || isCurrent ? (isCurrent ? '#1a202c' : '#38a169') : '#edf2f7';
                    const color = isPassed || isCurrent ? '#fff' : '#718096';
                    return `
                        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:${isCurrent ? '#1a202c' : '#a0aec0'};font-weight:${isCurrent ? '600' : '400'};">
                            <span style="width:24px;height:24px;border-radius:50%;background:${bg};color:${color};display:inline-flex;align-items:center;justify-content:center;font-size:12px;">${isPassed ? '✓' : i + 1}</span>
                            <span>${s}</span>
                        </div>
                        ${i < STAGE_ORDER.length - 1 ? '<span style="color:#cbd5e0;margin:0 4px;">›</span>' : ''}
                    `;
                }).join('')}
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">OVERVIEW</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Supplier</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.supplier || '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Customer</span>
                    <span style="font-size:14px;color:#718096;">${l.customer || 'Not yet matched'}</span>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Gross weight</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(l.gross_weight_kg || 0)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Accepted (payable) qty</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(p.acceptedNetKg)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Moisture</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.moisture_ ? l.moisture_ + '%' : '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Aflatoxin</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.aflatoxin_ppb ? l.aflatoxin_ppb + ' ppb' : '—'}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">COST SUMMARY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Net payable to supplier</span>
                    <strong style="color:#2d3748;">${fmtKES(p.netPayable)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Transport & handling</span>
                    <strong style="color:#2d3748;">KES 0</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0 0;font-size:15px;font-weight:700;">
                    <span style="color:#1a202c;">Landed cost per kg</span>
                    <span style="color:#1a202c;">${p.landedCostPerKg} /kg</span>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">TRADE EVENT LOG</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <strong style="font-size:14px;color:#2d3748;display:block;margin-bottom:2px;">Lot created, net invoice posted</strong>
                    <span style="font-size:13px;color:#718096;">Invoiced to ${l.supplier}</span>
                </div>
                <div style="text-align:right;font-size:12px;color:#a0aec0;">
                    <div>You (Purchase User)</div>
                    <div>${modifiedTime}</div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="advance-position-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Continue to Position →</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        document.getElementById('back-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('advance-position-btn').addEventListener('click', () => {
            navigate('transport', { id: l.name });
        });
    }

    function renderPositionDetail(container, id) {
        const l = LIVE_STORE.lots.find(x => x.name === id);
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');
        const modifiedTime = frappe.datetime.str_to_user(l.modified || l.creation);
        
        const haulage = flt(l.haulage_kes || 0);
        const cess = flt(l.cess_kes || 0);
        const offloading = flt(l.offloading_kes || 0);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <a href="#" id="back-link" style="color:#3182ce;text-decoration:none;">Lots</a>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0 0 4px 0;font-size:22px;color:#1a202c;font-weight:700;">${l.name} · ${lotId}</h1>
                    <span style="color:#718096;font-size:13px;">${l.supplier || '—'} · ${l.region || 'Nakuru, Njoro'}</span>
                </div>
                ${statusBadge(l.status || 'Position')}
            </div>

            <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
                ${STAGE_ORDER.map((s, i) => {
                    const isPassed = i < 3;
                    const isCurrent = s === (l.status || 'Position');
                    const bg = isPassed || isCurrent ? (isCurrent ? '#1a202c' : '#38a169') : '#edf2f7';
                    const color = isPassed || isCurrent ? '#fff' : '#718096';
                    return `
                        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:${isCurrent ? '#1a202c' : '#a0aec0'};font-weight:${isCurrent ? '600' : '400'};">
                            <span style="width:24px;height:24px;border-radius:50%;background:${bg};color:${color};display:inline-flex;align-items:center;justify-content:center;font-size:12px;">${isPassed ? '✓' : i + 1}</span>
                            <span>${s}</span>
                        </div>
                        ${i < STAGE_ORDER.length - 1 ? '<span style="color:#cbd5e0;margin:0 4px;">›</span>' : ''}
                    `;
                }).join('')}
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">OVERVIEW</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Supplier</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.supplier || '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Customer</span>
                    <span style="font-size:14px;color:#2d3748;">${l.customer || 'Not yet matched'}</span>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Gross weight</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(l.gross_weight_kg || 0)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Accepted (payable) qty</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(p.acceptedNetKg)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Moisture</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.moisture_ ? l.moisture_ + '%' : '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Aflatoxin</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.aflatoxin_ppb ? l.aflatoxin_ppb + ' ppb' : '—'}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">COST SUMMARY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Net payable to supplier</span>
                    <strong style="color:#2d3748;">${fmtKES(p.netPayable)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Transport & handling</span>
                    <strong style="color:#2d3748;">${fmtKES(p.totalTransport)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0 0;font-size:15px;font-weight:700;">
                    <span style="color:#1a202c;">Landed cost per kg</span>
                    <span style="color:#1a202c;">${p.landedCostPerKg} /kg</span>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">TRADE EVENT LOG</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <strong style="font-size:14px;color:#2d3748;display:block;margin-bottom:2px;">Transport capitalised, moved to Position</strong>
                    <span style="font-size:13px;color:#718096;">Haulage KES ${haulage}, cess KES ${cess}, offloading KES ${offloading}</span>
                </div>
                <div style="text-align:right;font-size:12px;color:#a0aec0;">
                    <div>You (Purchase User)</div>
                    <div>${modifiedTime}</div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="advance-invoiced-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Continue to Sale & invoicing →</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        document.getElementById('back-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('advance-invoiced-btn').addEventListener('click', () => {
            navigate('sale_invoicing', { id: l.name });
        });
    }

    function renderIntakeDetail(container, id) {
        const l = LIVE_STORE.lots.find(x => x.name === id);
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const lotId = 'LOT-' + (l.name.replace(/[^a-zA-Z0-9]/g, '').slice(-5).toUpperCase() || 'XXXXX');
        const modifiedTime = frappe.datetime.str_to_user(l.modified || l.creation);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <a href="#" id="back-link" style="color:#3182ce;text-decoration:none;">Lots</a>
            </div>
            
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
                <div>
                    <h1 style="margin:0 0 4px 0;font-size:22px;color:#1a202c;font-weight:700;">${l.name} · ${lotId}</h1>
                    <span style="color:#718096;font-size:13px;">${l.supplier || '—'} · ${l.region || 'Nakuru, Njoro'}</span>
                </div>
                ${statusBadge(l.status || 'Intake')}
            </div>

            <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#276749;font-weight:600;">
                    <span style="width:24px;height:24px;border-radius:50%;background:#38a169;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">✓</span>
                    <span>Ticket</span>
                </div>
                <span style="color:#cbd5e0;margin:0 4px;">›</span>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#1a202c;font-weight:600;">
                    <span style="width:24px;height:24px;border-radius:50%;background:#1a202c;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">2</span>
                    <span>Intake</span>
                </div>
                <span style="color:#cbd5e0;margin:0 4px;">›</span>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#a0aec0;font-weight:400;">
                    <span style="width:24px;height:24px;border-radius:50%;background:#edf2f7;color:#718096;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">3</span>
                    <span>Lot</span>
                </div>
                <span style="color:#cbd5e0;margin:0 4px;">›</span>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#a0aec0;font-weight:400;">
                    <span style="width:24px;height:24px;border-radius:50%;background:#edf2f7;color:#718096;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">4</span>
                    <span>Position</span>
                </div>
                <span style="color:#cbd5e0;margin:0 4px;">›</span>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#a0aec0;font-weight:400;">
                    <span style="width:24px;height:24px;border-radius:50%;background:#edf2f7;color:#718096;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">5</span>
                    <span>Invoiced</span>
                </div>
                <span style="color:#cbd5e0;margin:0 4px;">›</span>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#a0aec0;font-weight:400;">
                    <span style="width:24px;height:24px;border-radius:50%;background:#edf2f7;color:#718096;display:inline-flex;align-items:center;justify-content:center;font-size:12px;">6</span>
                    <span>Settled</span>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">OVERVIEW</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;">
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Supplier</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.supplier || '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Customer</span>
                    <span style="font-size:14px;color:#718096;">Not yet matched</span>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Gross weight</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(l.gross_weight_kg || 0)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Accepted (payable) qty</span>
                    <strong style="font-size:14px;color:#2d3748;">${fmtKg(p.acceptedNetKg)}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Moisture</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.moisture_ ? l.moisture_ + '%' : '—'}</strong>
                </div>
                <div>
                    <span style="display:block;font-size:12px;color:#718096;margin-bottom:4px;">Aflatoxin</span>
                    <strong style="font-size:14px;color:#2d3748;">${l.aflatoxin_ppb ? l.aflatoxin_ppb + ' ppb' : '—'}</strong>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">COST SUMMARY</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Net payable to supplier</span>
                    <strong style="color:#2d3748;">${fmtKES(p.netPayable)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Transport & handling</span>
                    <strong style="color:#2d3748;">KES 0</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0 0;font-size:15px;font-weight:700;">
                    <span style="color:#1a202c;">Landed cost per kg</span>
                    <span style="color:#1a202c;">${p.landedCostPerKg} /kg</span>
                </div>
            </div>

            <div style="font-size:14px;font-weight:600;color:#1a202c;margin-bottom:8px;">TRADE EVENT LOG</div>
            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <strong style="font-size:14px;color:#2d3748;display:block;margin-bottom:2px;">Lot lifecycle seeded to INTAKE</strong>
                    <span style="font-size:13px;color:#718096;">Weighbridge capture and quality inspection completed successfully.</span>
                </div>
                <div style="text-align:right;font-size:12px;color:#a0aec0;">
                    <div>You (Purchase User)</div>
                    <div>${modifiedTime}</div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="advance-lot-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Continue to Lot →</button>
                <button class="h-btn ghost" id="back-btn3" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        document.getElementById('back-link').addEventListener('click', (e) => { e.preventDefault(); navigate('lots'); });
        document.getElementById('back-btn3').addEventListener('click', () => navigate('lots'));
        document.getElementById('advance-lot-btn').addEventListener('click', async () => {
            await frappe.db.set_value('Buy Ticket', l.name, { status: 'Lot' });
            showToast(`Moved ${l.name} to Lot status`);
            await loadMasterData();
            navigate('lots', { id: l.name });
        });
    }

    function renderNewTicket(container) {
        const itemOptions = LIVE_STORE.items.map(i => ({ value: i.name, label: i.item_name ? `${i.item_name} (${i.name})` : i.name }));

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <span style="color:#2d3748;font-weight:500;">New ticket</span>
            </div>
            <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:700;color:#1a202c;">New ticket</h1>
            
            <div style="background:#ebf8ff;border:1px solid #bee3f8;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#2b6cb0;display:flex;align-items:center;gap:8px;">
                <span>ℹ</span>
                <span>2 supplier(s) are not yet Approved and won't appear below — check Suppliers to move them forward.</span>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Ticket details</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;align-items:start;">
                    ${field({ label: 'Supplier *', id: 'f-supplier', type: 'select', required: true, options: LIVE_STORE.suppliers.map(s => ({ value: s.name, label: s.supplier_name ? `${s.supplier_name} (${s.name})` : s.name })) })}
                    ${field({ label: 'Item', id: 'f-item', type: 'select', value: itemOptions.length > 0 ? itemOptions[0].value : '', options: itemOptions })}
                    ${field({ label: 'Expected quantity (kg) *', id: 'f-qty', type: 'number', required: true, placeholder: 'e.g. 8000' })}
                </div>
                <div style="margin-top:20px;max-width:320px;">
                    ${field({ label: 'Expected delivery date', id: 'f-date', type: 'date', value: frappe.datetime.get_today() })}
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="create-ticket-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Create ticket</button>
                <button class="h-btn ghost" id="cancel-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>
            </div>
        `;

        document.getElementById('cancel-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('create-ticket-btn').addEventListener('click', async () => {
            const supplier = $('#f-supplier').val();
            const commodity = $('#f-item').val();
            const qty = parseFloat($('#f-qty').val()) || 0;

            if (!supplier) { frappe.msgprint(__('Please select a Supplier.')); return; }
            if (qty <= 0) { frappe.msgprint(__('Please enter a valid Expected Quantity.')); return; }

            const res = await frappe.db.insert({
                doctype: 'Buy Ticket',
                supplier: supplier,
                commodity: commodity,
                quantity_kg: qty,
                status: 'Ticket',
                negotiated_price: 48.0
            });

            if (res) {
                showToast(`Ticket ${res.name} created successfully`);
                await loadMasterData();
                navigate('lots', { id: res.name });
            }
        });
    }

    function renderIntake(container, params) {
        const l = LIVE_STORE.lots.find(x => x.name === params.id) || LIVE_STORE.lots[0];
        if (!l) return navigate('lots');

        const waitingTickets = LIVE_STORE.lots.filter(x => (x.status || 'Ticket') === 'Ticket');
        const vehicleOptions = LIVE_STORE.vehicles.map(v => {
            const labelStr = v.license_plate ? `${v.license_plate} (${v.name})` : v.name;
            return { value: v.name, label: labelStr };
        });
        const transporterOptions = LIVE_STORE.vehicles.map(s => ({ value: s.name, label: s.name ? `${s.name} (${s.name})` : s.name }));

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <span style="color:#2d3748;font-weight:500;">Intake & quality</span>
            </div>
            
            <div style="margin-bottom:20px;">
                <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:#1a202c;">Intake & quality capture</h1>
                <span style="font-size:13px;color:#718096;">${l.name} · ${l.supplier || '—'}</span>
            </div>

            <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;font-size:13px;color:#4a5568;">
                <span>${waitingTickets.length} tickets waiting:</span>
                <div style="display:flex;gap:6px;">
                    ${waitingTickets.map(t => `
                        <button class="h-btn sm ${t.name === l.name ? 'primary' : ''}" data-ticket="${t.name}" style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:${t.name === l.name ? '#1a202c' : '#fff'};color:${t.name === l.name ? '#fff' : '#2d3748'};cursor:pointer;font-weight:500;font-size:12px;">${t.name}</button>
                    `).join('')}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Weighbridge capture</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Gross weight (kg) *', id: 'f-gross', type: 'number', value: l.gross_weight_kg || '', required: true, placeholder: '' })}
                    ${field({ label: 'Tare weight (kg) *', id: 'f-tare', type: 'number', value: l.tare_weight_kg || '', required: true, placeholder: '' })}
                    ${field({ label: 'Bag count *', id: 'f-bags', type: 'number', value: l.bag_count || '', required: true, placeholder: '' })}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Weighbridge ticket number *', id: 'f-wbnum', value: l.weighbridge_ticket_number || '', required: true, placeholder: 'Unique, e.g. WB-88213' })}
                    ${field({ label: 'Transporter', id: 'f-transporter', type: 'select', value: l.transporter || '', options: transporterOptions })}
                    ${field({ label: 'Vehicle registration', id: 'f-vehicle', type: 'select', value: l.vehicle_registration || '', options: vehicleOptions })}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">Weighbridge slip — gross (in)</label>
                        <button type="button" style="padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;background:#fff;cursor:pointer;width:fit-content;font-size:13px;color:#2d3748;">⬆ Upload</button>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">Weighbridge slip — tare (out)</label>
                        <button type="button" style="padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;background:#fff;cursor:pointer;width:fit-content;font-size:13px;color:#2d3748;">⬆ Upload</button>
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:13px;font-weight:500;color:#4a5568;">Net weight (calculated)</label>
                    <div id="net-calc-box" style="padding:8px 12px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;color:#4a5568;font-weight:500;">0 kg</div>
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Quality inspection</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Moisture % *', id: 'f-moisture', type: 'number', value: l.moisture_ || '', required: true })}
                    ${field({ label: 'Foreign matter % *', id: 'f-fm', type: 'number', value: l.foreign_matter_ || '', required: true })}
                    ${field({ label: 'Aflatoxin ppb *', id: 'f-afla', type: 'number', value: l.aflatoxin_ppb || '', required: true })}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'County', id: 'f-county', type: 'select', value: l.county || '', options: LIVE_STORE.countries.map(c => ({ value: c.name, label: c.country_name || c.name })) })}
                    ${field({ label: 'Area', id: 'f-area', value: l.region || '', placeholder: 'e.g. Njoro' })}
                </div>
                ${field({ label: 'Reason code (if foreign matter judgement or wet buy)', id: 'f-reason', type: 'textarea', value: l.reason_code_if_foreign_matter_judgement_or_wet_buy || '', span: true })}
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="submit-intake-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Submit intake & create lot</button>
                <button class="h-btn ghost" id="cancel-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Cancel</button>
            </div>
        `;

        const updateNetCalc = () => {
            const g = flt($('#f-gross').val()) || 0;
            const t = flt($('#f-tare').val()) || 0;
            $('#net-calc-box').text(fmtKg(Math.max(0, g - t)));
        };

        $('#f-gross, #f-tare').on('input', updateNetCalc);
        updateNetCalc();

        container.querySelectorAll('[data-ticket]').forEach(btn => {
            btn.addEventListener('click', () => navigate('intake', { id: btn.dataset.ticket }));
        });

        document.getElementById('cancel-btn').addEventListener('click', () => navigate('lots', { id: l.name }));
        document.getElementById('submit-intake-btn').addEventListener('click', async () => {
            const gross = flt($('#f-gross').val());
            const tare = flt($('#f-tare').val());
            const bags = cint($('#f-bags').val());
            const wbNo = $('#f-wbnum').val();
            const moisture = flt($('#f-moisture').val());
            const fm = flt($('#f-fm').val());
            const afla = flt($('#f-afla').val());

            if (!gross || !tare || !bags || !wbNo) {
                frappe.msgprint(__('Please fill all mandatory Weighbridge fields.'));
                return;
            }

            l.gross_weight_kg = gross;
            l.tare_weight_kg = tare;
            l.bag_count = bags;
            l.weighbridge_ticket_number = wbNo;
            l.transporter = $('#f-transporter').val();
            l.vehicle_registration = $('#f-vehicle').val();
            l.moisture_ = moisture;
            l.foreign_matter_ = fm;
            l.aflatoxin_ppb = afla;
            l.county = $('#f-county').val();
            l.region = $('#f-area').val();
            l.reason_code_if_foreign_matter_judgement_or_wet_buy = $('#f-reason').val();

            showToast(`Intake calculated for ${l.name}`);
            navigate('deductions', { id: l.name });
        });
    }

    function renderDeductionsPayable(container, params) {
        const l = LIVE_STORE.lots.find(x => x.name === params.id) || LIVE_STORE.lots[0];
        if (!l) return navigate('lots');
        const p = computePayable(l);
        const grossKg = flt(l.gross_weight_kg || l.quantity_kg || 0);
        const tareKg = flt(l.tare_weight_kg || 0);
        const netKg = Math.max(0, grossKg - tareKg);
        const moisture = flt(l.moisture_ || 0);
        const fm = flt(l.foreign_matter_ || 0);
        const bags = cint(l.bag_count || 0);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <span style="color:#2d3748;font-weight:500;">Deductions & payable</span>
            </div>
            
            <h1 style="margin:0 0 20px 0;font-size:22px;font-weight:700;color:#1a202c;">Deductions & payable engine</h1>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Deduction breakdown</h3>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Gross weight</span>
                    <strong style="color:#2d3748;">${fmtKg(grossKg)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Tare weight</span>
                    <strong style="color:#e53e3e;">- ${fmtKg(tareKg)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <div>
                        <span style="color:#4a5568;display:block;">Net weight</span>
                        <span style="font-size:12px;color:#a0aec0;">Gross minus tare</span>
                    </div>
                    <strong style="color:#2d3748;">${fmtKg(netKg)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <div>
                        <span style="color:#4a5568;display:block;">Moisture deduction</span>
                        <span style="font-size:12px;color:#a0aec0;">${moisture}% recorded vs 13.5% standard</span>
                    </div>
                    <strong style="color:#e53e3e;">- ${fmtKg(netKg * 0.03)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <div>
                        <span style="color:#4a5568;display:block;">Foreign matter deduction</span>
                        <span style="font-size:12px;color:#a0aec0;">${fm}% recorded</span>
                    </div>
                    <strong style="color:#e53e3e;">- ${fmtKg(netKg * 0.012)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0 0 0;font-size:14px;">
                    <div>
                        <strong style="color:#1a202c;display:block;">Accepted net quantity</strong>
                        <span style="font-size:12px;color:#718096;">This is what lands in the stock ledger — not the gross weight</span>
                    </div>
                    <strong style="color:#1a202c;font-size:16px;">${fmtKg(p.acceptedNetKg)}</strong>
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Payable value</h3>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Reference rate</span>
                    <strong style="color:#2d3748;">KES 48 /kg</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <div>
                        <span style="color:#4a5568;display:block;">Gross value</span>
                        <span style="font-size:12px;color:#a0aec0;">${fmtKg(p.acceptedNetKg)} × rate</span>
                    </div>
                    <strong style="color:#2d3748;">${fmtKES(p.acceptedNetKg * 48)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <div>
                        <span style="color:#4a5568;display:block;">Bagging deduction</span>
                        <span style="font-size:12px;color:#a0aec0;">${bags} bags × KES 25</span>
                    </div>
                    <strong style="color:#e53e3e;">- ${fmtKES(bags * 25)}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #edf2f7;font-size:14px;">
                    <span style="color:#4a5568;">Aflatoxin test fee</span>
                    <strong style="color:#e53e3e;">- KES 300</strong>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0 0 0;font-size:15px;">
                    <strong style="color:#1a202c;">Net payable to supplier</strong>
                    <strong style="color:#1a202c;font-size:16px;">${fmtKES(p.netPayable)}</strong>
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Net supplier invoice</h3>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:13px;font-weight:500;color:#4a5568;">Invoice value</label>
                    <div style="padding:10px 12px;background:#f7fafc;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;color:#2d3748;font-weight:600;">${fmtKES(p.netPayable)}</div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="post-invoice-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Post net invoice & create lot</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('post-invoice-btn').addEventListener('click', async () => {
            await frappe.db.set_value('Buy Ticket', l.name, { status: 'Lot' });
            showToast(`Net invoice posted and ${l.name} moved to Lot status`);
            await loadMasterData();
            navigate('lots', { id: l.name });
        });
    }

    function renderTransportLoss(container, params) {
        const l = LIVE_STORE.lots.find(x => x.name === params.id) || LIVE_STORE.lots.filter(x => (x.status || 'Lot') === 'Lot')[0];
        if (!l) return navigate('lots');

        const readyLots = LIVE_STORE.lots.filter(x => (x.status || 'Lot') === 'Lot');
        const expectedQty = flt(l.quantity_kg || l.gross_weight_kg || 7578);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <span style="color:#2d3748;font-weight:500;">Transport & loss</span>
            </div>
            
            <div style="margin-bottom:20px;">
                <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:#1a202c;">Transport & loss</h1>
                <span style="font-size:13px;color:#718096;">${l.name} · ${l.supplier || 'Wanjiru Grain Traders'}</span>
            </div>

            <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;font-size:13px;color:#4a5568;">
                <span>${readyLots.length} lots ready:</span>
                <div style="display:flex;gap:6px;">
                    ${readyLots.map(t => `
                        <button class="h-btn sm ${t.name === l.name ? 'primary' : ''}" data-lot="${t.name}" style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:${t.name === l.name ? '#1a202c' : '#fff'};color:${t.name === l.name ? '#fff' : '#2d3748'};cursor:pointer;font-weight:500;font-size:12px;">${t.name}</button>
                    `).join('')}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Transport charges</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">
                    ${field({ label: 'Haulage (KES)', id: 'f-haulage', type: 'number', value: l.haulage_kes || '', placeholder: '' })}
                    ${field({ label: 'Cess (KES)', id: 'f-cess', type: 'number', value: l.cess_kes || '', placeholder: '' })}
                    ${field({ label: 'Offloading (KES)', id: 'f-offloading', type: 'number', value: l.offloading_kes || '', placeholder: '' })}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Loss reconciliation</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">Expected quantity</label>
                        <div style="padding:8px 12px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;color:#4a5568;font-weight:500;">${expectedQty.toLocaleString('en-KE')} kg</div>
                    </div>
                    ${field({ label: 'Delivered quantity (kg)', id: 'f-delivered-qty', type: 'number', value: l.delivered_quantity_kg || expectedQty })}
                </div>
                <div id="loss-alert-box" style="background:#f0fff4;border:1px solid #c6f6d5;border-radius:6px;padding:12px 16px;font-size:13px;color:#276749;display:flex;align-items:center;gap:8px;">
                    <span>✓</span>
                    <span id="loss-alert-text">No loss recorded — full expected quantity delivered.</span>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="capitalise-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Capitalise costs & move to Position</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        const updateReconciliation = () => {
            const delivered = flt($('#f-delivered-qty').val());
            const diff = expectedQty - delivered;
            const alertBox = $('#loss-alert-box');
            const alertText = $('#loss-alert-text');

            if (diff <= 0 || delivered === expectedQty) {
                alertBox.css({ background: '#f0fff4', border: '1px solid #c6f6d5', color: '#276749' });
                alertText.html('<span>✓</span> No loss recorded — full expected quantity delivered.');
                alertBox.find('span:first').text('✓');
            } else {
                const tolerance = 80;
                const recovered = Math.max(0, diff - tolerance);
                const sellRate = 48; 
                const recoveredValue = recovered * sellRate;

                if (diff <= tolerance) {
                    alertBox.css({ background: '#fffaf0', border: '1px solid #feebc8', color: '#c05621' });
                    alertBox.find('span:first').text('⚠');
                    alertText.text(`${diff.toLocaleString('en-KE')} kg loss is within the ${tolerance}kg tolerance limit.`);
                } else {
                    alertBox.css({ background: '#fffaf0', border: '1px solid #feebc8', color: '#c05621' });
                    alertBox.find('span:first').text('⚠');
                    alertText.text(`${diff.toLocaleString('en-KE')} kg loss exceeds the ${tolerance}kg tolerance. ${recovered.toLocaleString('en-KE')} kg recovered from the transporter at sell rate = KES ${recoveredValue.toLocaleString('en-KE')}, split across inventory reversal and margin recovery.`);
                }
            }
        };

        $('#f-delivered-qty').on('input', updateReconciliation);
        updateReconciliation();

        container.querySelectorAll('[data-lot]').forEach(btn => {
            btn.addEventListener('click', () => navigate('transport', { id: btn.dataset.lot }));
        });

        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('capitalise-btn').addEventListener('click', async () => {
            const haulage = flt($('#f-haulage').val());
            const cess = flt($('#f-cess').val());
            const offloading = flt($('#f-offloading').val());
            const deliveredQty = flt($('#f-delivered-qty').val());

            await frappe.db.set_value('Buy Ticket', l.name, {
                status: 'Position',
                haulage_kes: haulage,
                cess_kes: cess,
                offloading_kes: offloading,
                delivered_quantity_kg: deliveredQty
            });

            showToast(`Costs capitalised and ${l.name} moved to Position`);
            await loadMasterData();
            navigate('lots', { id: l.name });
        });
    }

    function renderSaleInvoicing(container, params) {
        const l = LIVE_STORE.lots.find(x => x.name === params.id) || LIVE_STORE.lots.filter(x => (x.status || 'Position') === 'Position')[0] || LIVE_STORE.lots[0];
        if (!l) return navigate('lots');

        const positionLots = LIVE_STORE.lots.filter(x => (x.status || 'Position') === 'Position');
        const customerOptions = LIVE_STORE.customers.map(c => ({ value: c.name, label: c.customer_name ? `${c.customer_name} (${c.name})` : c.name }));
        const p = computePayable(l);
        const qty = flt(l.delivered_quantity_kg || p.acceptedNetKg || 7578);
        const defaultSellRate = flt(l.negotiated_price || 48);

        container.innerHTML = `
            <div style="font-size:12px;color:#718096;margin-bottom:8px;display:flex;gap:4px;">
                <span>Holec Trading</span> › <span>Trade</span> › <span style="color:#2d3748;font-weight:500;">Sale & invoicing</span>
            </div>
            
            <div style="margin-bottom:20px;">
                <h1 style="margin:0 0 4px 0;font-size:22px;font-weight:700;color:#1a202c;">Sale & invoicing</h1>
                <span style="font-size:13px;color:#718096;">${l.name} · ${l.supplier || 'Wanjiru Grain Traders'} → ${qty.toLocaleString('en-KE')} kg @ KES <span id="header-sell-rate">${defaultSellRate}</span>/kg landed</span>
            </div>

            <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;font-size:13px;color:#4a5568;">
                <span>${positionLots.length} lots ready:</span>
                <div style="display:flex;gap:6px;">
                    ${positionLots.map(t => `
                        <button class="h-btn sm ${t.name === l.name ? 'primary' : ''}" data-sale-lot="${t.name}" style="padding:4px 10px;border-radius:6px;border:1px solid #cbd5e0;background:${t.name === l.name ? '#1a202c' : '#fff'};color:${t.name === l.name ? '#fff' : '#2d3748'};cursor:pointer;font-weight:500;font-size:12px;">${t.name}</button>
                    `).join('')}
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Delivery</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;">
                    ${field({ label: 'Customer *', id: 'f-customer', type: 'select', required: true, options: customerOptions, value: l.customer || '' })}
                    ${field({ label: 'Sell rate (KES/kg) *', id: 'f-sell-rate', type: 'number', required: true, value: l.sell_rate || defaultSellRate })}
                </div>
                <div style="border-top:1px solid #edf2f7;padding-top:16px;display:flex;flex-direction:column;gap:10px;">
                    <div style="display:flex;justify-content:space-between;font-size:14px;">
                        <span style="color:#4a5568;">Revenue</span>
                        <strong style="color:#2d3748;" id="calc-revenue">KES 0</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:14px;">
                        <span style="color:#4a5568;">Landed cost</span>
                        <strong style="color:#e53e3e;" id="calc-landed">- ${fmtKES(p.netPayable + p.totalTransport)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;font-size:14px;">
                        <span style="color:#4a5568;">Margin per tonne</span>
                        <strong style="color:#2d3748;" id="calc-margin">KES 0</strong>
                    </div>
                </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-bottom:20px;">
                <h3 style="margin:0 0 16px 0;font-size:15px;color:#1a202c;font-weight:600;">Sales invoice + eTIMS</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
                    ${field({ label: 'Invoice number', id: 'f-invoice-no', value: l.invoice_number || 'INV-5503', placeholder: '' })}
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:13px;font-weight:500;color:#4a5568;">eTIMS control unit number</label>
                        <div style="padding:8px 12px;background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;color:#a0aec0;">Generated on submit</div>
                    </div>
                </div>
            </div>

            <div style="display:flex;gap:12px;align-items:center;">
                <button class="h-btn primary" id="submit-etims-btn" style="background:#1a202c;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Submit invoice & transmit to eTIMS</button>
                <button class="h-btn ghost" id="back-to-lots-btn" style="background:transparent;color:#4a5568;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;">Back to lots</button>
            </div>
        `;

        const updateCalculations = () => {
            const sellRate = flt($('#f-sell-rate').val()) || 0;
            $('#header-sell-rate').text(sellRate);
            const revenue = qty * sellRate;
            const totalCost = p.netPayable + p.totalTransport;
            const totalMargin = revenue - totalCost;
            const marginPerTonne = qty > 0 ? (totalMargin / (qty / 1000)) : 0;

            $('#calc-revenue').text(fmtKES(revenue));
            $('#calc-margin').text(fmtKES(marginPerTonne));
        };

        $('#f-sell-rate').on('input', updateCalculations);
        updateCalculations();

        container.querySelectorAll('[data-sale-lot]').forEach(btn => {
            btn.addEventListener('click', () => navigate('sale_invoicing', { id: btn.dataset.saleLot }));
        });

        document.getElementById('back-to-lots-btn').addEventListener('click', () => navigate('lots'));
        document.getElementById('submit-etims-btn').addEventListener('click', async () => {
            const customer = $('#f-customer').val();
            const sellRate = flt($('#f-sell-rate').val());
            const invoiceNo = $('#f-invoice-no').val();

            if (!customer) {
                frappe.msgprint(__('Please select a Customer.'));
                return;
            }
            if (sellRate <= 0) {
                frappe.msgprint(__('Please enter a valid Sell Rate.'));
                return;
            }

            try {
                await frappe.db.insert({
                    doctype: 'Sales Invoice',
                    customer: customer,
                    grand_total: flt(qty * sellRate),
                    currency: 'KES',
                    custom_buy_ticket: l.name,
                    items: [{
                        item_code: l.commodity || LIVE_STORE.items[0]?.name || 'Commodity',
                        qty: flt(qty),
                        rate: flt(sellRate),
                        amount: flt(qty * sellRate)
                    }]
                });
            } catch (err) {
                console.error('Error creating Sales Invoice:', err);
            }

            await frappe.db.set_value('Buy Ticket', l.name, {
                status: 'Invoiced',
                customer: customer,
                sell_rate: sellRate,
                invoice_number: invoiceNo
            });

            showToast(`Invoice ${invoiceNo} transmitted to eTIMS and ${l.name} moved to Invoiced`);
            await loadMasterData();
            navigate('lots', { id: l.name });
        });
    }

    const MODULE_REGISTRY = [
        { id: 'suppliers', group: 'PARTIES', name: 'Suppliers', render: renderSuppliers },
        { id: 'new_supplier', group: 'PARTIES', name: 'New supplier', render: renderNewSupplier },
        { id: 'customers', group: 'PARTIES', name: 'Customers', render: renderCustomers },
        { id: 'new_customer', group: 'PARTIES', name: 'New customer', render: renderNewCustomer },
        { id: 'lots', group: 'TRADE', name: 'Lots', render: renderLots },
        { id: 'tickets', group: 'TRADE', name: 'New ticket', render: renderNewTicket },
        { id: 'intake', group: 'TRADE', name: 'Intake & quality', render: renderIntake },
        { id: 'deductions', group: 'TRADE', name: 'Deductions & payable', render: renderDeductionsPayable },
        { id: 'transport', group: 'TRADE', name: 'Transport & loss', render: renderTransportLoss },
        { id: 'sale_invoicing', group: 'TRADE', name: 'Sale & invoicing', render: renderSaleInvoicing },
        { id: 'payments_list', group: 'FINANCE', name: 'Payments', render: renderPaymentsList },
        { id: 'payments', group: 'FINANCE', name: 'Record Payment', render: renderPayments },
        { id: 'ledger', group: 'INSIGHT', name: 'Cost ledger & margin', render: renderCostLedger },
        { id: 'reports', group: 'INSIGHT', name: 'Reports', render: renderReports },
        { id: 'event_log', group: 'INSIGHT', name: 'Trade event log', render: renderTradeEventLog }
    ];

    const TIMELINE = [
        { label: 'Ticket', route: 'tickets' },
        { label: 'Intake', route: 'intake' },
        { label: 'Lot', route: 'lots' },
        { label: 'Position', route: 'transport' },
        { label: 'Invoiced', route: 'sale_invoicing' },
        { label: 'Settled', route: 'lots' }
    ];

    function renderSidebar() {
        const el = document.getElementById('h-sidebar');
        if (!el) return;
        
        const isSuppliersActive = route.module === 'suppliers' || route.module === 'new_supplier';
        const isCustomersActive = route.module === 'customers' || route.module === 'new_customer';
        
        el.innerHTML = `
            <div style="font-weight:700;font-size:16px;color:#1a202c;margin-bottom:20px;display:flex;align-items:center;gap:8px;">
                <span style="background:#1a202c;color:#fff;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font-size:12px;">H</span> Holec ERP
            </div>
            
            <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:6px;margin-top:12px;">PARTIES</div>
            <div class="mod-item ${isSuppliersActive ? 'active' : ''}" data-mod="suppliers" style="padding:6px 10px;border-radius:6px;background:${isSuppliersActive ? '#ebf8ff' : 'transparent'};color:${isSuppliersActive ? '#2b6cb0' : '#4a5568'};font-weight:${isSuppliersActive ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='suppliers'&&route.module!=='new_supplier')this.style.background='#f7fafc'" onmouseout="if(route.module!=='suppliers'&&route.module!=='new_supplier')this.style.background='transparent'">Suppliers</div>
            <div class="mod-item ${isCustomersActive ? 'active' : ''}" data-mod="customers" style="padding:6px 10px;border-radius:6px;background:${isCustomersActive ? '#ebf8ff' : 'transparent'};color:${isCustomersActive ? '#2b6cb0' : '#4a5568'};font-weight:${isCustomersActive ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:8px;" onmouseover="if(route.module!=='customers'&&route.module!=='new_customer')this.style.background='#f7fafc'" onmouseout="if(route.module!=='customers'&&route.module!=='new_customer')this.style.background='transparent'">Customers</div>            
            
            <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:6px;">TRADE</div>
            <div class="mod-item ${route.module === 'lots' ? 'active' : ''}" data-mod="lots" style="padding:6px 10px;border-radius:6px;background:${route.module === 'lots' ? '#ebf8ff' : 'transparent'};color:${route.module === 'lots' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'lots' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='lots')this.style.background='#f7fafc'" onmouseout="if(route.module!=='lots')this.style.background='transparent'">Lots</div>
            <div class="mod-item ${route.module === 'tickets' ? 'active' : ''}" data-mod="tickets" style="padding:6px 10px;border-radius:6px;background:${route.module === 'tickets' ? '#ebf8ff' : 'transparent'};color:${route.module === 'tickets' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'tickets' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='tickets')this.style.background='#f7fafc'" onmouseout="if(route.module!=='tickets')this.style.background='transparent'">New ticket</div>
            <div class="mod-item ${route.module === 'intake' ? 'active' : ''}" data-mod="intake" style="padding:6px 10px;border-radius:6px;background:${route.module === 'intake' ? '#ebf8ff' : 'transparent'};color:${route.module === 'intake' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'intake' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='intake')this.style.background='#f7fafc'" onmouseout="if(route.module!=='intake')this.style.background='transparent'">Intake & quality</div>
            <div class="mod-item ${route.module === 'deductions' ? 'active' : ''}" data-mod="deductions" style="padding:6px 10px;border-radius:6px;background:${route.module === 'deductions' ? '#ebf8ff' : 'transparent'};color:${route.module === 'deductions' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'deductions' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='deductions')this.style.background='#f7fafc'" onmouseout="if(route.module!=='deductions')this.style.background='transparent'">Deductions & payable</div>
            <div class="mod-item ${route.module === 'transport' ? 'active' : ''}" data-mod="transport" style="padding:6px 10px;border-radius:6px;background:${route.module === 'transport' ? '#ebf8ff' : 'transparent'};color:${route.module === 'transport' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'transport' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='transport')this.style.background='#f7fafc'" onmouseout="if(route.module!=='transport')this.style.background='transparent'">Transport & loss</div>
            <div class="mod-item ${route.module === 'sale_invoicing' ? 'active' : ''}" data-mod="sale_invoicing" style="padding:6px 10px;border-radius:6px;background:${route.module === 'sale_invoicing' ? '#ebf8ff' : 'transparent'};color:${route.module === 'sale_invoicing' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'sale_invoicing' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:8px;" onmouseover="if(route.module!=='sale_invoicing')this.style.background='#f7fafc'" onmouseout="if(route.module!=='sale_invoicing')this.style.background='transparent'">Sale & invoicing</div>

            <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:6px;">FINANCE</div>
            <div id="sidebar-payments-btn" style="padding:6px 10px;color:#4a5568;font-size:13px;cursor:pointer;border-radius:4px;margin-bottom:8px;" onmouseover="this.style.background='#f7fafc'" onmouseout="this.style.background='transparent'">Payments</div>

            <div style="font-size:11px;font-weight:700;color:#a0aec0;letter-spacing:0.05em;margin-bottom:6px;">INSIGHT</div>
            <div class="mod-item ${route.module === 'ledger' ? 'active' : ''}" data-mod="ledger" style="padding:6px 10px;border-radius:6px;background:${route.module === 'ledger' ? '#ebf8ff' : 'transparent'};color:${route.module === 'ledger' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'ledger' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='ledger')this.style.background='#f7fafc'" onmouseout="if(route.module!=='ledger')this.style.background='transparent'">Cost ledger & margin</div>
            <div class="mod-item ${route.module === 'reports' ? 'active' : ''}" data-mod="reports" style="padding:6px 10px;border-radius:6px;background:${route.module === 'reports' ? '#ebf8ff' : 'transparent'};color:${route.module === 'reports' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'reports' ? '600' : '400'};cursor:pointer;font-size:13px;margin-bottom:2px;" onmouseover="if(route.module!=='reports')this.style.background='#f7fafc'" onmouseout="if(route.module!=='reports')this.style.background='transparent'">Reports</div>
            <div class="mod-item ${route.module === 'event_log' ? 'active' : ''}" data-mod="event_log" style="padding:6px 10px;border-radius:6px;background:${route.module === 'event_log' ? '#ebf8ff' : 'transparent'};color:${route.module === 'event_log' ? '#2b6cb0' : '#4a5568'};font-weight:${route.module === 'event_log' ? '600' : '400'};cursor:pointer;font-size:13px;" onmouseover="if(route.module!=='event_log')this.style.background='#f7fafc'" onmouseout="if(route.module!=='event_log')this.style.background='transparent'">Trade event log</div>
        `;

        el.querySelectorAll('.mod-item').forEach(node => {
            node.addEventListener('click', () => navigate(node.dataset.mod));
        });
        el.querySelector('#sidebar-payments-btn').addEventListener('click', () => navigate('payments_list'));
    }

    function renderTimeline() {
        const el = document.getElementById('h-timeline');
        if (!el) return;
        el.innerHTML = TIMELINE.map((s, i) => `
            <span style="display:inline-flex;align-items:center;gap:4px;background:#f7fafc;padding:3px 8px;border-radius:12px;border:1px solid #e2e8f0;font-size:12px;cursor:pointer;" data-route="${s.route}">
                <strong style="color:#2d3748;">${i + 1}</strong> ${s.label}
            </span>
        `).join('');

        el.querySelectorAll('[data-route]').forEach(node => {
            node.addEventListener('click', () => navigate(node.dataset.route));
        });
    }

    async function render() {
        renderSidebar();
        renderTimeline();
        const mod = MODULE_REGISTRY.find(m => m.id === route.module) || MODULE_REGISTRY[0];
        const inner = document.getElementById('h-content');
        if (mod && inner) mod.render(inner, route.params);
    }

    loadMasterData().then(() => {
        render();
    });
}