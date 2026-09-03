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
        finalizeDone: false,
        jobs: [],
        savedJobLayer: null,
        startMarker: null,
        liveAreaPolygon: null
    };

    // ---- Persisted job registry (localStorage) ----
    const STORAGE_KEY = 'borderJobs';
    function loadJobs() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            state.jobs = raw ? JSON.parse(raw) : [];
        } catch (e) {
            state.jobs = [];
        }
    }
    function saveJobs() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.jobs));
        } catch (e) { /* storage may be unavailable */ }
    }

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
    const routeModal = $('routeModal');
    const routeImg = $('routeImg');
    const btnDownloadPng = $('btnDownloadPng');
    const btnCloseRoute = $('btnCloseRoute');
    const coordsList = $('coordsList');
    const coordsCount = $('coordsCount');

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
        // If we are recording, keep the "tracking" status; otherwise prompt to start.
        if (state.tracking) {
            setJobStatus('STARTED — tracking...', 'ok on');
        } else {
            showGpsMsg('Location found ✓ Accuracy ±' + Math.round(acc) + 'm', 'ok');
            setJobStatus('Press Start Track', 'ok on');
        }
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

        function gpsErrorMessage(err) {
            let msg = 'Could not get location. ';
            if (err.code === 1) { msg = 'Location permission DENIED. Allow location for this site, then refresh.'; showOverlay('Location permission was denied. Allow location for this site, then refresh the page.'); }
            else if (err.code === 2) { msg = 'GPS unavailable. Turn on GPS and move to an open area.'; }
            else if (err.code === 3) { msg = 'Location timed out (no satellite fix). Move outdoors with a clear sky.'; }
            else { msg = 'Could not get location: ' + (err.message || 'unknown error') + '. Ensure GPS + internet are on.'; }
            showGpsMsg(msg, 'err');
            setJobStatus('Please Enable GPS', 'err');
        }

        navigator.geolocation.getCurrentPosition(
            function (pos) { placeMarker(pos); },
            function (err) { gpsErrorMessage(err); }, // show one-shot errors instead of silent ignore
            { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
        );
        if (state.watchId === null) {
            state.watchId = navigator.geolocation.watchPosition(
                function (pos) { placeMarker(pos); },
                function (err) { gpsErrorMessage(err); },
                { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
            );
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
    followMe = true;

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

    // Auto-trace the user's location on page load (no tap required).
    // A small delay lets the map finish initializing first.
    setTimeout(function () {
        showGpsMsg('Tracing your location automatically...', 'warn');
        setJobStatus('Please Enable GPS', 'warn');
        findMe();
    }, 600);

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
        state.tracking = true;
        renderCoordList();

        // Clear any watch started by auto-locate so only the tracking watch runs.
        if (state.watchId !== null) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }

        // Remove old route layers & markers for a clean start
        if (state.routeLine) { map.removeLayer(state.routeLine); state.routeLine = null; }
        if (state.routePolygon) { map.removeLayer(state.routePolygon); state.routePolygon = null; }
        if (state.liveAreaPolygon) { map.removeLayer(state.liveAreaPolygon); state.liveAreaPolygon = null; }
        if (state.startMarker) { map.removeLayer(state.startMarker); state.startMarker = null; }

        // Prepare the route polyline
        state.routeLine = L.polyline([], { color: '#f9ab00', weight: 4, opacity: 0.9 }).addTo(map);

        // First, get the current position to tag it as the STARTING POINT.
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                const lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy;
                recordRoutePoint(lat, lng, acc, true);
                map.setView([lat, lng], 18);
                tagStartPoint(lat, lng);
                setJobStatus('STARTED — tracking...', 'ok on');
            },
            function () { /* watch will pick up the fix */ },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
        );

        // Then start the continuous watch
        state.watchId = navigator.geolocation.watchPosition(
            onGPSFix,
            onGPSError,
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
        );

        trackStatus.textContent = 'Tracking your route... travel along the border.';
        trackStatus.classList.add('tracking');
        setJobStatus('STARTED — locating start point...', 'ok on');
        btnStart.disabled = true;
        btnFinish.disabled = false;
    }

    // Tag the starting point with a distinct marker and its coordinate label
    function tagStartPoint(lat, lng) {
        if (!map) return;
        if (state.startMarker) map.removeLayer(state.startMarker);
        // Marker + a permanent label with the coordinates
        state.startMarker = L.marker([lat, lng], {
            icon: L.divIcon({ className: 'start-dot', iconSize: [16, 16], iconAnchor: [8, 8] })
        }).addTo(map).bindTooltip('START\n' + lat.toFixed(6) + ', ' + lng.toFixed(6), {
            permanent: true, direction: 'top', className: 'start-tooltip', offset: [0, -12]
        });
    }

    function onGPSFix(pos) {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const acc = pos.coords.accuracy;

        // always update the live coordinates in the status box
        updateCoordDisplay(lat, lng, acc);

        // Record the point (first fix also tags the start)
        recordRoutePoint(lat, lng, acc, state.routePoints.length === 0);

        // auto-follow the user while tracking (if toggled on)
        if (followMe && state.tracking) {
            map.setView([lat, lng]);
        }
    }

    // Record a route point and update the live drawing (line + closing area)
    function recordRoutePoint(lat, lng, acc, isFirst) {
        if (acc > 60) {
            setGpsStatus('Signal weak (±' + Math.round(acc) + 'm) — wait for better GPS', 'warn');
            return;
        }
        if (!state.routeLine) return;

        // Skip points that are very close together
        const last = state.routePoints[state.routePoints.length - 1];
        if (last) {
            const d = distMeters(last[0], last[1], lat, lng);
            if (d < 2) return;
        }

        state.routePoints.push([lat, lng]);
        state.routeLine.addLatLng([lat, lng]);
        renderCoordList();

        // Tag the starting point once, with coordinates
        if (isFirst && state.tracking) {
            tagStartPoint(lat, lng);
        }

        // Move the live user marker
        if (userMarker) userMarker.setLatLng([lat, lng]);
        else userMarker = L.marker([lat, lng]).addTo(map);

        setGpsStatus('Tracking ✓ (±' + Math.round(acc) + 'm)', 'ok');

        // Draw a live area that closes the route as it grows
        if (state.tracking && state.routePoints.length >= 3) {
            const closed = state.routePoints.slice();
            closed.push([closed[0][0], closed[0][1]]);
            if (state.liveAreaPolygon) {
                state.liveAreaPolygon.setLatLngs(closed);
            } else {
                state.liveAreaPolygon = L.polygon(closed, {
                    color: '#1a73e8', weight: 3, fillColor: '#1a73e8', fillOpacity: 0.15
                }).addTo(map);
            }
        }
    }

    function onGPSError(err) {
        let msg = 'GPS error (code ' + err.code + '): ' + err.message;
        setGpsStatus(msg, 'err');
        if (gpsError) gpsError.textContent = msg;
    }

    // Render the recorded coordinates list (below the finished jobs panel)
    function renderCoordList() {
        if (!coordsList) return;
        coordsList.innerHTML = '';
        if (coordsCount) coordsCount.textContent = state.routePoints.length + ' points';

        if (state.routePoints.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'coords-empty';
            empty.textContent = 'Coordinates recorded during tracking will appear here.';
            coordsList.appendChild(empty);
            return;
        }

        state.routePoints.forEach(function (p, i) {
            const row = document.createElement('div');
            row.className = 'coord-row';

            const num = document.createElement('span');
            num.className = 'coord-num';
            num.textContent = '#' + (i + 1);

            const latlng = document.createElement('span');
            latlng.className = 'coord-pts';
            latlng.textContent = p[0].toFixed(6) + ', ' + p[1].toFixed(6);

            const live = document.createElement('span');
            live.className = 'coord-live';
            if (i === 0) {
                live.innerHTML = '<span class="coord-idx">START</span>';
            } else if (i === state.routePoints.length - 1) {
                live.innerHTML = '<span class="live-dot"></span><span class="coord-idx">LIVE</span>';
            }

            row.appendChild(num);
            row.appendChild(latlng);
            row.appendChild(live);
            coordsList.appendChild(row);
        });

        // Auto-scroll to the newest point
        coordsList.scrollTop = coordsList.scrollHeight;
    }

    function finishTracking() {
        if (state.watchId !== null) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }
        state.tracking = false;
        // Remove the live-trace area polygon (the final border replaces it)
        if (state.liveAreaPolygon) { map.removeLayer(state.liveAreaPolygon); state.liveAreaPolygon = null; }
        trackStatus.classList.remove('tracking');
        trackStatus.textContent = (state.routePoints.length > 0)
            ? 'Tracking finished. ' + state.routePoints.length + ' points recorded.'
            : 'No points recorded.';
        setJobStatus((state.routePoints.length > 0) ? 'FINISHED — Border marked (' + state.routePoints.length + ' pts)' : 'Finished with no points', (state.routePoints.length > 0) ? 'ok on' : 'err');
        btnStart.disabled = false;
        btnFinish.disabled = true;
        if (state.routePoints.length >= 3) {
            goToStep(2);
            buildBorderFromRoute();
            showAndDownloadRoutePNG();
        } else {
            gpsError.textContent = 'Need at least 3 points. Please re-track.';
            setJobStatus('Not enough points (need 3+)', 'err');
        }
    }

    // ---------- Marked route PNG export ----------
    // Renders the recorded route (and closed border) onto a canvas and
    // both displays it "below the map" and auto-downloads it as a PNG.
    function showAndDownloadRoutePNG() {
        const points = state.routePoints;
        if (points.length < 2) return;

        const el = $('routeModal');
        const img = $('routeImg');
        const W = 1200, H = 900, pad = 60;

        // Planar (equirectangular) projection is accurate enough for local areas.
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        points.forEach(function (p) {
            if (p[0] < minLat) minLat = p[0];
            if (p[0] > maxLat) maxLat = p[0];
            if (p[1] < minLng) minLng = p[1];
            if (p[1] > maxLng) maxLng = p[1];
        });
        const spanLat = (maxLat - minLat) || 0.0001;
        const spanLng = (maxLng - minLng) || 0.0001;
        const pxPerLat = (H - 2 * pad) / spanLat;
        const pxPerLng = (W - 2 * pad) / spanLng;
        function X(lng) { return pad + (lng - minLng) * pxPerLng; }
        function Y(lat) { return H - pad - (lat - minLat) * pxPerLat; }

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);

        // Grid
        ctx.strokeStyle = '#e8eaed';
        ctx.lineWidth = 1;
        const gridN = 8;
        for (let i = 0; i <= gridN; i++) {
            const gx = pad + (W - 2 * pad) * i / gridN;
            const gy = pad + (H - 2 * pad) * i / gridN;
            ctx.beginPath(); ctx.moveTo(gx, pad); ctx.lineTo(gx, H - pad); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
        }

        // Closed border polygon (if we have a closed border)
        const borderPts = state.routePolygon ? coordsOfPolygon(state.routePolygon) : null;

        // Fill polygon
        if (borderPts && borderPts.length >= 3) {
            ctx.fillStyle = 'rgba(154, 52, 230, 0.12)';
            ctx.beginPath();
            ctx.moveTo(X(borderPts[0][1]), Y(borderPts[0][0]));
            for (let i = 1; i < borderPts.length; i++) ctx.lineTo(X(borderPts[i][1]), Y(borderPts[i][0]));
            ctx.closePath(); ctx.fill();
        }

        // Route polyline
        ctx.beginPath();
        ctx.moveTo(X(points[0][1]), Y(points[0][0]));
        for (let i = 1; i < points.length; i++) ctx.lineTo(X(points[i][1]), Y(points[i][0]));
        ctx.strokeStyle = '#1a73e8';
        ctx.lineWidth = 6;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.stroke();

        // Start marker
        ctx.fillStyle = '#188038';
        ctx.beginPath();
        ctx.arc(X(points[0][1]), Y(points[0][0]), 12, 0, Math.PI * 2);
        ctx.fill();

        // End marker
        if (points.length > 1) {
            const last = points[points.length - 1];
            ctx.fillStyle = '#d93025';
            ctx.beginPath();
            ctx.arc(X(last[1]), Y(last[0]), 12, 0, Math.PI * 2);
            ctx.fill();
        }

        // Title + legend
        ctx.fillStyle = '#202124';
        ctx.font = 'bold 34px Arial';
        ctx.fillText('Marked Travel Route', pad, 40);
        ctx.font = '22px Arial';
        ctx.fillStyle = '#5f6368';
        ctx.fillText('Green = Start    Red = End', pad, H - 18);

        const dataURL = canvas.toDataURL('image/png');
        if (img) img.src = dataURL;
        if (el) el.classList.remove('hidden');

        // Auto-download
        downloadPNG(dataURL);
    }

    // Extract [lat,lng] pairs from a Leaflet polygon layer
    function coordsOfPolygon(polygon) {
        const ll = polygon.getLatLngs();
        const arr = Array.isArray(ll) ? ll[0] : ll;
        const out = [];
        (function rec(a) {
            if (a.length && Array.isArray(a[0])) a.forEach(rec);
            else out.push([a[0], a[1]]);
        })(arr);
        return out;
    }

    function downloadPNG(dataURL) {
        const a = document.createElement('a');
        a.href = dataURL;
        a.download = 'marked-route-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
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
        saveCurrentJob();
        setJobStatus('DONE — saved to My Jobs ✓', 'ok');
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
        if (state.liveAreaPolygon) map.removeLayer(state.liveAreaPolygon);
        if (state.startMarker) map.removeLayer(state.startMarker);
        state.rectangles.forEach(r => {
            map.removeLayer(r.layer);
            if (r.tip) map.removeLayer(r.tip);
        });
        state.routePoints = [];
        renderCoordList();
        state.rectangles = [];
        state.rectCounter = 0;
        state.routeLine = null;
        state.routePolygon = null;
        state.liveAreaPolygon = null;
        state.startMarker = null;
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
        setJobStatus('Please Enable GPS', 'warn');
        setGpsStatus('Not detected');
        if (routeModal) routeModal.classList.add('hidden');
        goToStep(1);
        setTimeout(function () { findMe(); }, 300);
    }

    // ---------- Finished jobs ----------
    function saveCurrentJob() {
        if (!state.borderPoints || state.borderPoints.length < 3) return;
        const job = {
            id: Date.now(),
            label: 'Job #' + (state.jobs.length + 1),
            ts: Date.now(),
            border: state.borderPoints.map(p => [p[0], p[1]]),
            areaSqm: state.borderAreaSqm,
            perimeterKm: state.borderKm,
            roofCount: state.rectangles.reduce((s, r) => s + r.count, 0),
            roofRects: state.rectangles.length
        };
        state.jobs.unshift(job);
        saveJobs();
        renderJobList();
    }

    function renderJobList() {
        const list = $('jobsList');
        if (!list) return;
        list.innerHTML = '';
        if (state.jobs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'jobs-empty';
            empty.textContent = 'No finished jobs yet.';
            list.appendChild(empty);
            return;
        }
        state.jobs.forEach(function (job, idx) {
            const item = document.createElement('div');
            item.className = 'job-item';

            const top = document.createElement('div');
            top.className = 'job-top';
            const tleft = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'job-title';
            title.textContent = job.label;
            const date = document.createElement('div');
            date.className = 'job-date';
            date.textContent = new Date(job.ts).toLocaleString();
            tleft.appendChild(title);
            tleft.appendChild(date);
            const arrow = document.createElement('span');
            arrow.className = 'job-arrow';
            arrow.textContent = '▾';
            top.appendChild(tleft);
            top.appendChild(arrow);
            item.appendChild(top);

            const detail = document.createElement('div');
            detail.className = 'job-detail';
            detail.style.display = 'none';
            detail.innerHTML =
                '<div class="jrow"><span>Border Points</span><span>' + job.border.length + '</span></div>' +
                '<div class="jrow"><span>Area</span><span>' + job.areaSqm.toFixed(1) + ' m² (' + (job.areaSqm / 10000).toFixed(3) + ' ha)</span></div>' +
                '<div class="jrow"><span>Perimeter</span><span>' + job.perimeterKm.toFixed(2) + ' km</span></div>' +
                '<div class="jrow"><span>Roof Rectangles</span><span>' + job.roofRects + '</span></div>' +
                '<div class="jrow"><span>Total Count</span><span>' + job.roofCount + '</span></div>';
            item.appendChild(detail);

            // Toggle detail on click
            top.addEventListener('click', function () {
                const hidden = detail.style.display === 'none';
                detail.style.display = hidden ? 'block' : 'none';
                arrow.textContent = hidden ? '▴' : '▾';
            });

            // Actions: Show on map, Delete
            const actions = document.createElement('div');
            actions.className = 'job-actions';
            const showBtn = document.createElement('button');
            showBtn.className = 'btn btn-primary';
            showBtn.textContent = 'Show Border';
            showBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                showJobBorder(job);
            });
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-secondary';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                state.jobs.splice(idx, 1);
                saveJobs();
                renderJobList();
            });
            actions.appendChild(showBtn);
            actions.appendChild(delBtn);
            item.appendChild(actions);

            list.appendChild(item);
        });
    }

    // Redraw a saved job's border on the map
    function showJobBorder(job) {
        if (!map || !job.border || job.border.length < 3) return;
        // Remove any existing saved-job border layer
        if (state.savedJobLayer) { map.removeLayer(state.savedJobLayer); state.savedJobLayer = null; }
        state.savedJobLayer = L.polygon(job.border, {
            color: '#9334e6',
            weight: 3,
            fillColor: '#9334e6',
            fillOpacity: 0.18
        }).addTo(map);
        map.fitBounds(state.savedJobLayer.getBounds());
        // Reflect in the live job-status display
        setJobStatus('Showing saved border: ' + job.label, 'ok');
        goToStep(1);
    }

    function clearJobs() {
        if (state.jobs.length === 0) return;
        if (!confirm('Delete all saved jobs?')) return;
        state.jobs = [];
        saveJobs();
        renderJobList();
        if (state.savedJobLayer) { map.removeLayer(state.savedJobLayer); state.savedJobLayer = null; }
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
    const btnClearJobs = $('btnClearJobs');
    if (btnClearJobs) btnClearJobs.addEventListener('click', clearJobs);
    if (btnDownloadPng) btnDownloadPng.addEventListener('click', function () { showAndDownloadRoutePNG(); });
    if (btnCloseRoute) btnCloseRoute.addEventListener('click', function () { if (routeModal) routeModal.classList.add('hidden'); });

    // Load persisted jobs and render the list
    loadJobs();
    renderJobList();

    // Initialize count display
    updateTotalRoofs();

})();
