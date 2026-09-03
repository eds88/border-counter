# Border & Roof Counter — GPS Field Tool

A web-based fieldwork tool for surveying land borders and counting house units by GPS tracking and map marking.

## How It Works

**Step 1 — Track the Border Route**
Press **Start Track** and physically travel along the border. Your GPS route is recorded automatically in real time (with satellite imagery for accuracy). Press **Finish Track** when you complete a full loop.

**Step 2 — Build & Adjust the Border**
A closed polygon is created from your route. Drag the orange vertex handles on the map to extend/adjust the border, then press **Done** to finalize.

**Step 3 — Count House Roofs**
Use the rectangle tool to draw a rectangle over each roof seen inside the border (tap the + / − to adjust count per rectangle). Press **Finalize Count** to total everything.

**Export**
Export your survey as **JSON** (border coordinates + area + count) or **CSV** (roof counts).

## Live Status Panel

While working, a status box always shows:
- **Job Status** — Idle / Tracking in progress / Border marked / Done
- **GPS Status** — signal strength and accuracy
- **Latitude / Longitude** — your live coordinates
- **Accuracy** — GPS precision

## Requirements

- **HTTPS** — A feature of all free hosting (GitHub Pages, Netlify, Vercel) so the browser allows GPS.
- A device with GPS (phone recommended).

## Run Locally

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. (Note: GPS needs HTTPS even for local devices, so deploy to a free HTTPS host for full GPS in the field.)

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (e.g. `border-counter`).
2. In repo **Settings → Pages**, set source to **Deploy from a branch**, branch `main` / root `/`.
3. Your site will be at `https://<username>.github.io/border-counter/` over HTTPS.

## Files

- `index.html` — the app
- `css/style.css` — styles
- `js/app.js` — all logic (GPS tracking, map drawing, roof counting, exports)
- `lib/` — Bundled Leaflet + Leaflet.Draw (no internet CDN needed; works offline beyond map tiles)
