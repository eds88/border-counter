/* =========================================================
   Border & Roof Counter — GPS Field Tool
   Steps:
     1) Track GPS route along the border
     2) Build polygon from route + manually adjust / extend it
     3) Count house roofs with rectangles inside the border
   ========================================================= */

(function () {
    'use strict';

    // ==================================================================
    // GPS + UI helpers are defined FIRST and are independent of the map,
    // so that "Enable My Location" (GPS) ALWAYS works, even if the map or
    // drawing library fails to initialize. GPS is the core feature.
    // ==================================================================
    const $ = id => document.getElementById(id);
    let map = null;          // assigned after Leaflet init; GPS guards for null
    let userMarker = null;
    let followMe = true;
    let drawControl = null;

    const state = {
        tracking: false,
        watchId: null,
        routePoints: [],
        routeLine: null,
        routePolygon: null,
        borderPoints: [],
        borderAreaSqm: 0,
        borderKm: 0,
        rectangles: [],
        rectCounter: 0,
        step: 1,
        editing: false,
        finalizeDone: false
    };

    // Element references (always safe; may be null if DOM changed)
    const btnStart = $('btnStart');
    const btnFinish = $('btnFinish');
    const btnDoneBorder = $('btnDoneBorder');
    const btnResetBorder = $('btnResetBorder');
    const btnNewRect = $('btnNewRect');
    const btnFinalize = $('btnFinalize');
    const btnExportJson = $('btnExportJson');
    const btnExportCsv = $('btnExportCsv');
    const btnNewSurvey = $('btnNewSurvey');
    const trackStatus = $('trackStatus');
    const gpsError = $('gpsError');

    // ---- GPS status/message helpers (no map dependency) ----
    function showGpsMsg(msg, cls) {
        if (gpsError) gpsError.textContent = msg;
        setGpsStatus(msg, cls);
    }
    function setGpsStatus(text, cls) {
        const el = $('gpsStatus');
        if (!el) return;
        el.textContent = text;
        el.className = 'status-val' + (cls ? ' ' + cls : '');
        if (/Location found/.test(text) && !cls) el.className = 'status-val ok';
        else if (/DENIED|unavailable|timed out|Could not|ERROR|SECURE/.test(text)) el.className = 'status-val err';
        else if (/Requesting|Waiting|Let me find|Finding|Looking/.test(text)) el.className = 'status-val warn';
    }
    function setJobStatus(text, cls) {
        const el = $('jobStatus');
        if (!el) return;
        el.textContent = text;
        el.className = 'status-val' + (cls ? ' ' + cls : '');
    }
    function updateCoordDisplay(lat, lng, acc) {
        const latEl = $('curLat'), lngEl = $('curLng'), accEl = $('curAcc');
        if (latEl) latEl.textContent = (lat != null) ? lat.toFixed(6) : '-';
        if (lngEl) lngEl.textContent = (lng != null) ? lng.toFixed(6) : '-';
        if (accEl) accEl.textContent = (acc != null) ? '±' + Math.round(acc) + ' m' : '-';
    }
    function showOverlay(hint) {
        const ov = $('gpsOverlay');
        if (!ov) return;
        ov.classList.remove('hidden');
        const hintEl = $('gpsOverlayHint');
        if (hintEl && hint) hintEl.textContent = hint;
    }
    function hideOverlay() {
        const ov = $('gpsOverlay');
        if (ov) ov.classList.add('hidden');
    }
    function geoUnavailable(msg) {
        showGpsMsg(msg, 'err');
        setJobStatus('GPS unavailable', 'err');
    }
    function placeMarker(pos) {
        const lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy;
        updateCoordDisplay(lat, lng, acc);
        showGpsMsg('Location found ✓ Accuracy ±' + Math.round(acc) + 'm', 'ok');
        setJobStatus('Location on — you can Start Track', 'ok');
        if (!map) return; // map not ready; still recorded coords
        const ll = [lat, lng];
        map.setView(ll, 18);
        if (userMarker) userMarker.setLatLng(ll);
        else userMarker = L.marker(ll, { draggable: false }).addTo(map);
    }
    function findMe() {
        if (typeof isSecureContext === 'boolean' && !isSecureContext) {
            showGpsMsg('NOT over HTTPS — browser blocks location. Open the https:// vercel.app link.', 'err');
            setJobStatus('Open via https:// link', 'err');
            return;
        }
        if (!navigator.geolocation) { geoUnavailable('Geolocation not supported on this device.'); return; }
        if (navigator.permissions && navigator.permissions.query) {
            navigator.permissions.query({ name: 'geolocation' }).then(function (res) {
                if (res.state === 'denied') {
                    showGpsMsg('Location is BLOCKED for this site. Allow it in browser settings, then tap "Enable My Location" again.', 'err');
                }
            }).catch(function () {});
        }
        showGpsMsg('Waiting for GPS... If a permission popup appears, tap "Allow".', 'warn');
        setJobStatus('Looking for your location...', 'warn');
        navigator.geolocation.getCurrentPosition(function (pos) { placeMarker(pos); }, function () {
            /* one-shot may timeout; the watch below recovers */
        }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
        if (state.watchId === null) {
            state.watchId = navigator.geolocation.watchPosition(function (pos) { placeMarker(pos); }, function (err) {
                let msg = 'Could not get location. ';
                if (err.code === 1) { msg = 'Location permission DENIED. Allow location for this site in browser settings, then tap "Enable My Location" again.'; showOverlay('Location permission was denied. Allow location for this site, then tap "Enable My Location".'); }
                else if (err.code === 2) { msg = 'GPS unavailable. Move to an open area and refresh.'; }
                else if (err.code === 3) { msg = 'Location timed out. Move to an open area and try again.'; }
                else { msg = 'Could not get location. Ensure GPS + internet are on, open via https://.'; }
                showGpsMsg(msg, 'err');
            }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
        }
    }

    // ATTACH the "Enable My Location" handler FIRST — this runs even if the map
    // initialization below fails, so GPS always works.
    const enableBtn = $('btnEnableGps');
    if (enableBtn) {
        enableBtn.addEventListener('click', function () { hideOverlay(); findMe(); });
    }

    // ==================================================================
    // Leaflet library guard + map initialization
    // ==================================================================
    if (typeof L === 'undefined') {
        showGpsMsg('Map library failed to load.', 'err');
        return; // GPS status helpers above are already attached; map unavailable
    }

    // ---------- Map setup ----------
    map = L.map('map').setView([6.9271, 79.8612], 14); // default (Colombo) — will move on GPS fix

    // Free base layers: Esri satellite (best for roof spotting) + OpenStreetMap street
    const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
    });

    const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    });

    const labelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri'
    });

    // default to satellite + place labels
    satLayer.addTo(map);
    labelsLayer.addTo(map);

    L.control.layers({
        'Satellite (Best for Roofs)': satLayer,
        'Street Map': streetLayer,
        'Street Map + Labels': L.layerGroup([streetLayer, labelsLayer])
    }, null, { collapsed: true }).addTo(map);

    // locate control + follow-me toggle state
    let followMe = true;
    let userMarker = null;

    L.control.locate = L.control.extend({
        onAdd: function () {
            const btn = L.DomUtil.create('button', 'leaflet-bar locate-btn');
            btn.innerHTML = '&#9673;';
            btn.title = 'Find my location';
            btn.style.cssText = 'width:30px;height:30px;line-height:30px;text-align:center;cursor:pointer;font-size:18px;border-bottom:1px solid #ccc;background:#fff;';
            btn.onclick = function () {
                findMe();
                btn.style.background = '#e8f0fe';
                setTimeout(() => { btn.style.background = '#fff'; }, 500);
            };
            return btn;
        }
    });
    new L.control.locate({ position: 'topleft' }).addTo(map);

    // On load, show the "Enable GPS" overlay so the user taps to allow location
    // (a real gesture — mobile browsers often block GPS without a tap).
    setTimeout(function () {
        showGpsMsg('Tap "Enable My Location" to find your position', 'warn');
        showOverlay();
    }, 400);

    // ---------- Draw control (rectangle creation) ----------
    // Warn if the draw library failed to load (common cause of the app not starting)
    try {
        drawControl = new L.Control.Draw({
            draw: {
                polyline: false,
                polygon: false,
                circle: false,
                marker: false,
                circlemarker: false,
                rectangle: {
                    shapeOptions: {
                        color: '#1a73e8',
                        weight: 2,
                        fillColor: '#1a73e8',
                        fillOpacity: 0.12
                    }
                }
            },
            edit: { featureGroup: new L.FeatureGroup() }
        });
        map.addControl(drawControl);
    } catch (e) {
        console.error('Leaflet.Draw failed to load:', e);
        if (trackStatus) {
            trackStatus.textContent = 'Warning: drawing plugin failed to load. Some tools may be limited.';
        }
    }

    // ---------- Leaflet draw handlers ----------
    // Only bind these if the draw plugin loaded successfully
    try {
        if (typeof L.Draw !== 'undefined') {
            map.on(L.Draw.Event.CREATED, function (event) {
                const layer = event.layer;
                if (event.layerType === 'rectangle') {
                    addRoofRectangle(layer);
                }
            });

            map.on(L.Draw.Event.EDITED, function () {
                refreshBorderStats();
            });

            map.on(L.Draw.Event.DELETED, function () {
                refreshBorderStats();
            });
        }
    } catch (e) {
        console.error('Could not bind draw handlers:', e);
    }

    // ---------- GPS Step 1 ----------
    function startTracking() {
        if (!navigator.geolocation) {
            gpsError.textContent = 'Geolocation not supported on this device/browser.';
            return;
        }
        gpsError.textContent = '';
        state.routePoints = [];

        // Clear any watch started earlier by "Enable My Location" so only ONE
        // geolocation watch (the tracking watch below) runs at a time.
        if (state.watchId !== null) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }

        // Move map to current position first
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                map.setView([pos.coords.latitude, pos.coords.longitude], 18);
            },
            function () { /* ignore initial error, watch will handle */ },
            { enableHighAccuracy: true, timeout: 20000 }
        );

        state.watchId = navigator.geolocation.watchPosition(
            onGPSFix,
            onGPSError,
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
        );

        if (state.routeLine) {
            map.removeLayer(state.routeLine);
            state.routeLine = null;
        }
        state.routeLine = L.polyline([], { color: '#f9ab00', weight: 4, opacity: 0.9 }).addTo(map);

        state.tracking = true;
        trackStatus.textContent = 'Tracking your route... travel along the border.';
        trackStatus.classList.add('tracking');
        setJobStatus('Tracking in progress...', 'ok');
        btnStart.disabled = true;
        btnFinish.disabled = false;
        updateStats();
    }

    function onGPSFix(pos) {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = pos.coords.accuracy;

        // always update the live coordinates in the status box
        updateCoordDisplay(lat, lng, acc);

        // only record a route point when accuracy is reasonable (< 60m) to avoid jumps
        if (acc > 60) {
            setGpsStatus('Signal weak (±' + Math.round(acc) + 'm) — wait for better GPS', 'warn');
            return;
        }

        // Avoid duplicate points that are very close together
        const last = state.routePoints[state.routePoints.length - 1];
        if (last) {
            const d = distMeters(last[0], last[1], lat, lng);
            if (d < 2) return; // skip if <2m apart
        }

        state.routePoints.push([lat, lng]);
        state.routeLine.addLatLng([lat, lng]);

        // update the GPS status to "tracking" if not already
        setGpsStatus('Tracking ✓ (±' + Math.round(acc) + 'm)', 'ok');

        // move the user marker with the GPS fix
        if (userMarker) userMarker.setLatLng([lat, lng]);
        else userMarker = L.marker([lat, lng]).addTo(map);

        // auto-follow the user while tracking (if toggled on)
        if (followMe && state.tracking) {
            map.setView([lat, lng]);
        }
        updateStats();
    }

    function onGPSError(err) {
        let msg = 'GPS error (code ' + err.code + '): ' + err.message;
        setGpsStatus(msg, 'err');
        if (gpsError) gpsError.textContent = msg;
    }

    function finishTracking() {
        if (state.watchId !== null) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }
        state.tracking = false;
        trackStatus.classList.remove('tracking');
        trackStatus.textContent = (state.routePoints.length > 0)
            ? 'Tracking finished. ' + state.routePoints.length + ' points recorded.'
            : 'No points recorded.';
        setJobStatus((state.routePoints.length > 0) ? 'Border marked — ' + state.routePoints.length + ' points' : 'Finished with no points', (state.routePoints.length > 0) ? 'ok' : 'err');
        btnStart.disabled = false;
        btnFinish.disabled = true;
        updateStats();
        if (state.routePoints.length >= 3) {
            goToStep(2);
            buildBorderFromRoute();
        } else {
            gpsError.textContent = 'Need at least 3 points. Please re-track.';
            setJobStatus('Not enough points (need 3+)', 'err');
        }
    }

    // ---------- Step 2: Build border polygon ----------
    function buildBorderFromRoute() {
        // Build polygon coordinates from the route.
        // Polyline needs to be closed manually by appending the first point.
        const coords = state.routePoints.map(p => [p[0], p[1]]);
        // Close the loop (ensure it's closed)
        if (coords.length > 0) {
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                coords.push([first[0], first[1]]);
            }
        }

        // If a previous border polygon exists, remove it
        if (state.routePolygon) {
            map.removeLayer(state.routePolygon);
            state.routePolygon = null;
        }

        state.routePolygon = L.polygon(coords, {
            color: '#1a73e8',
            weight: 3,
            fillColor: '#1a73e8',
            fillOpacity: 0.15
        }).addTo(map);
        map.fitBounds(state.routePolygon.getBounds());

        // Enable editing handles so the user can drag vertices to extend the border
        state.routePolygon.editing.enable();
        state.editing = true;
    }

    function resetBorderFromRoute() {
        if (state.routePolygon) {
            map.removeLayer(state.routePolygon);
            state.routePolygon = null;
        }
        if (state.routePoints.length >= 3) {
            buildBorderFromRoute();
        }
    }

    // Recompute border stats after the polygon is edited via the draw toolbar
    function refreshBorderStats() {
        if (!state.routePolygon) return;
        const layers = state.routePolygon.getLatLngs();
        const coords = flattenLatLngs(layers[0]);
        state.borderPoints = coords;
        state.borderKm = perimeterKm(coords);
        state.borderAreaSqm = polygonAreaM2(coords);
    }

    function doneBorder() {
        if (!state.routePolygon) return;
        // Stop editing and capture final coordinates
        const layers = state.routePolygon.getLatLngs();
        // Flatten (polygon latlngs may be nested: [[ [lat,lng], ... ]])
        const coords = flattenLatLngs(layers[0]);
        state.borderPoints = coords;
        state.borderKm = perimeterKm(coords);
        // area
        state.borderAreaSqm = polygonAreaM2(coords);

        // disable editing
        if (state.routePolygon.editing) state.routePolygon.editing.disable();

        // Show finalized border details aside
        const bi = $('borderInfo');
        bi.classList.remove('hidden');
        $('biArea').textContent = state.borderAreaSqm.toFixed(1) + ' m² (' + (state.borderAreaSqm / 10000).toFixed(3) + ' ha)';
        $('biPerim').textContent = state.borderKm.toFixed(2) + ' km';
        $('biVerts').textContent = state.borderPoints.length;

        // Show border info panel and summary
        showBorderAside();
        goToStep(3);
        setJobStatus('Border finalized — counting roofs', 'ok');
    }

    // ---------- Step 3: Roof rectangles ----------
    function addRoofRectangle(layer) {
        // remove any default tooltip from the rectangle
        state.rectCounter++;
        const id = 'R' + state.rectCounter;
        const rect = { id: id, layer: layer, count: 1 };
        state.rectangles.push(rect);

        // add a marker at center with count
        const center = layer.getBounds().getCenter();
        const tip = L.marker(center, {
            icon: L.divIcon({
                className: 'roof-tip',
                html: '<div>' + rect.count + '</div>',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            })
        }).addTo(map);
        rect.tip = tip;

        renderRectList();
    }

    function setRectCount(rect, delta) {
        rect.count = Math.max(0, rect.count + delta);
        if (rect.tip) {
            rect.tip.setIcon(L.divIcon({
                className: 'roof-tip',
                html: '<div>' + rect.count + '</div>',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            }));
        }
        renderRectList();
    }

    function removeRect(id) {
        const idx = state.rectangles.findIndex(r => r.id === id);
        if (idx >= 0) {
            const r = state.rectangles[idx];
            map.removeLayer(r.layer);
            if (r.tip) map.removeLayer(r.tip);
            state.rectangles.splice(idx, 1);
            renderRectList();
        }
    }

    function renderRectList() {
        const list = $('rectList');
        list.innerHTML = '';
        state.rectangles.forEach(rect => {
            const item = document.createElement('div');
            item.className = 'rect-item';
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.background = rect.layer.options.color || '#1a73e8';

            const name = document.createElement('span');
            name.className = 'rect-name';
            name.textContent = rect.id;

            const controls = document.createElement('span');
            const minus = document.createElement('button');
            minus.className = 'rect-del';
            minus.textContent = '−';
            minus.onclick = () => setRectCount(rect, -1);
            const count = document.createElement('span');
            count.className = 'rect-count';
            count.textContent = rect.count;
            const plus = document.createElement('button');
            plus.className = 'rect-del';
            plus.textContent = '+';
            plus.onclick = () => setRectCount(rect, 1);
            const del = document.createElement('button');
            del.className = 'rect-del';
            del.textContent = '✕';
            del.title = 'Remove';
            del.onclick = () => removeRect(rect.id);

            controls.appendChild(minus);
            controls.appendChild(count);
            controls.appendChild(plus);
            controls.appendChild(del);

            item.appendChild(swatch);
            item.appendChild(name);
            item.appendChild(controls);
            list.appendChild(item);
        });
        updateTotalRoofs();
    }

    function updateTotalRoofs() {
        const total = state.rectangles.reduce((sum, r) => sum + r.count, 0);
        $('totalRoofs').textContent = total;
    }

    function finalizeCount() {
        state.finalizeDone = true;
        showResult();
        goToStep(3);
    }

    // ---------- Aside display / summary ----------
    function showBorderAside() {
        const panel = $('panel3');
        panel.classList.remove('hidden');
    }

    function showResult() {
        $('resultPanel').classList.remove('hidden');
        setJobStatus('DONE — Job complete ✓', 'ok');
        const summary = $('summary');
        const areaH = state.borderAreaSqm / 10000;
        summary.innerHTML =
            '<div class="row"><span>Border Points</span><span>' + state.borderPoints.length + '</span></div>' +
            '<div class="row"><span>Area</span><span>' + state.borderAreaSqm.toFixed(1) + ' m² (' + areaH.toFixed(3) + ' ha)</span></div>' +
            '<div class="row"><span>Perimeter</span><span>' + state.borderKm.toFixed(2) + ' km</span></div>' +
            '<div class="row"><span>Roof Rectangles</span><span>' + state.rectangles.length + '</span></div>' +
            '<div class="row"><span>Total House Count</span><span><strong>' + $('totalRoofs').textContent + '</strong></span></div>';
    }

    // ---------- Steps UI ----------
    function goToStep(n) {
        state.step = n;
        $('panel1').classList.toggle('hidden', n !== 1);
        $('panel2').classList.toggle('hidden', n !== 2);
        $('panel3').classList.toggle('hidden', n !== 3);
        $('stepBadge1').classList.toggle('active', n === 1);
        $('stepBadge2').classList.toggle('active', n === 2);
        $('stepBadge3').classList.toggle('active', n === 3);

        // Enable/disable rectangle drawing control only in step 3
        if (n === 3) {
            // ensure draw control enabled for rectangle
        }
    }

    // ---------- Stats ----------
    function updateStats() {
        $('statPoints').textContent = state.routePoints.length;
        $('statDistance').textContent = formatDistance(routeLengthMeters(state.routePoints));
    }

    // ---------- Geo math helpers ----------
    function distMeters(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
    function toRad(d) { return d * Math.PI / 180; }

    function routeLengthMeters(points) {
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            total += distMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
        }
        return total;
    }

    function perimeterKm(points) {
        return routeLengthMeters(points) / 1000;
    }

    // Polygonal area on a sphere (WGS84) — proper geodesic formula
    // Returns area in square meters. Accepts array of [lat, lng].
    function polygonAreaM2(points) {
        const R = 6378137; // equatorial radius
        let area = 0;
        const n = points.length;
        const toRad = d => d * Math.PI / 180;

        for (let i = 0; i < n; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % n];
            const x1 = toRad(p1[0]);
            const y1 = toRad(p1[1]);
            const x2 = toRad(p2[0]);
            const y2 = toRad(p2[1]);
            area += (y2 - y1) * (Math.cos(x1) + Math.cos(x2));
        }
        area = Math.abs(area) * R * R / 2;
        return area;
    }

    function flattenLatLngs(ll) {
        // ll is an array (could be array of arrays)
        const out = [];
        (function rec(arr) {
            if (arr.length && Array.isArray(arr[0])) {
                arr.forEach(rec);
            } else {
                out.push([arr[0], arr[1]]);
            }
        })(ll);
        return out;
    }

    function formatDistance(m) {
        if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
        return Math.round(m) + ' m';
    }

    // ---------- Export ----------
    function exportJSON() {
        const data = {
            border: state.borderPoints,
            areaSqm: state.borderAreaSqm,
            perimeterKm: state.borderKm,
            roofs: state.rectangles.map(r => ({ id: r.id, count: r.count })),
            totalRoofCount: state.rectangles.reduce((s, r) => s + r.count, 0)
        };
        downloadFile('border-survey.json', 'application/json',
            JSON.stringify(data, null, 2));
    }

    function exportCSV() {
        let csv = 'id,count\n';
        state.rectangles.forEach(r => {
            csv += r.id + ',' + r.count + '\n';
        });
        csv += 'TOTAL,' + state.rectangles.reduce((s, r) => s + r.count, 0) + '\n';
        downloadFile('roof-count.csv', 'text/csv', csv);
    }

    function downloadFile(name, type, content) {
        const blob = new Blob([content], { type: type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function newSurvey() {
        // reset everything
        if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
        if (state.routeLine) map.removeLayer(state.routeLine);
        if (state.routePolygon) map.removeLayer(state.routePolygon);
        state.rectangles.forEach(r => {
            map.removeLayer(r.layer);
            if (r.tip) map.removeLayer(r.tip);
        });
        state.routePoints = [];
        state.rectangles = [];
        state.rectCounter = 0;
        state.routeLine = null;
        state.routePolygon = null;
        state.borderPoints = [];
        state.borderAreaSqm = 0;
        state.borderKm = 0;
        state.tracking = false;
        state.finalizeDone = false;
        $('rectList').innerHTML = '';
        $('totalRoofs').textContent = '0';
        $('resultPanel').classList.add('hidden');
        $('borderInfo').classList.add('hidden');
        gpsError.textContent = '';
        trackStatus.textContent = 'Not tracking';
        trackStatus.classList.remove('tracking');
        btnStart.disabled = false;
        btnFinish.disabled = true;
        updateCoordDisplay(null, null, null);
        setJobStatus('Idle — press Start Track');
        setGpsStatus('Not detected');
        updateStats();
        goToStep(1);
    }

    // ---------- Event listeners ----------
    btnStart.addEventListener('click', startTracking);
    btnFinish.addEventListener('click', finishTracking);
    $('followToggle').addEventListener('change', function (e) {
        followMe = e.target.checked;
    });

    btnDoneBorder.addEventListener('click', doneBorder);
    btnResetBorder.addEventListener('click', resetBorderFromRoute);
    btnNewRect.addEventListener('click', function () {
        if (!drawControl || typeof L.Draw === 'undefined') {
            gpsError.textContent = 'Rectangle tool unavailable (plugin failed to load). Refresh the page.';
            return;
        }
        // Trigger the draw rectangle tool programmatically
        new L.Draw.Rectangle(map, drawControl.options.draw.rectangle).enable();
    });
    btnFinalize.addEventListener('click', finalizeCount);
    btnExportJson.addEventListener('click', exportJSON);
    btnExportCsv.addEventListener('click', exportCSV);
    btnNewSurvey.addEventListener('click', newSurvey);

    // Initialize count display
    updateStats();
    updateTotalRoofs();

})();
