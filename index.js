// CamperLog – Cloudflare Worker mit D1
// Routen:
//   GET  /                      -> App (HTML)
//   GET  /api/touren            -> Liste aller Touren
//   POST /api/touren            -> Neue Tour anlegen
//   PATCH  /api/touren/:id      -> Tour bearbeiten (voller Datensatz)
//   DELETE /api/touren/:id      -> Tour löschen
//   PATCH  /api/touren/:id/favorit -> Favorit-Status einer Tour umschalten
//   GET  /api/favoriten         -> Liste der ToDrive-Liste (gefundene Plätze)
//   POST /api/favoriten         -> Platz zur ToDrive-Liste hinzufügen
//   DELETE /api/favoriten/:id   -> Platz aus ToDrive-Liste entfernen
//   GET  /api/suche?q=...       -> Echte Campingplatz/Stellplatz-Suche (OpenStreetMap)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function uid() {
  return crypto.randomUUID();
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // --- Touren ---
  if (pathname === "/api/touren" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM touren ORDER BY datum_von DESC"
    ).all();
    return json(results);
  }

  if (pathname === "/api/touren" && method === "POST") {
    const body = await request.json();
    if (!body.ort || !body.datumVon) {
      return json({ error: "Ort und Datum sind erforderlich." }, 400);
    }
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO touren (id, ort, typ, datum_von, datum_bis, kosten, wetter, bewertung, notizen, favorit, strom, boden, sanitaer, bezahlung, broetchenservice, umgebung, nachttemperatur, tagestemperatur, anreise_zeit, abreise_zeit, zeiten_24h, mobilfunk, wlan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.ort.trim(),
        body.typ || "Stellplatz",
        body.datumVon,
        body.datumBis || null,
        body.kosten ? parseFloat(body.kosten) : null,
        body.wetter || "sonnig",
        body.bewertung ? parseInt(body.bewertung) : 4,
        body.notizen || null,
        body.strom ? 1 : 0,
        body.boden || null,
        body.sanitaer ? 1 : 0,
        body.bezahlung || null,
        body.broetchenservice ? 1 : 0,
        body.umgebung || null,
        body.nachttemperatur !== undefined && body.nachttemperatur !== null && body.nachttemperatur !== "" ? parseFloat(body.nachttemperatur) : null,
        body.tagestemperatur !== undefined && body.tagestemperatur !== null && body.tagestemperatur !== "" ? parseFloat(body.tagestemperatur) : null,
        body.anreiseZeit || null,
        body.abreiseZeit || null,
        body.zeiten24h ? 1 : 0,
        body.mobilfunk || null,
        body.wlan || null
      )
      .run();
    return json({ id }, 201);
  }

  const tourMatch = pathname.match(/^\/api\/touren\/([^/]+)$/);
  if (tourMatch && method === "PATCH") {
    const id = tourMatch[1];
    const body = await request.json();
    if (!body.ort || !body.datumVon) {
      return json({ error: "Ort und Datum sind erforderlich." }, 400);
    }
    await env.DB.prepare(
      `UPDATE touren SET ort = ?, typ = ?, datum_von = ?, datum_bis = ?, kosten = ?, wetter = ?, bewertung = ?, notizen = ?, strom = ?, boden = ?, sanitaer = ?, bezahlung = ?, broetchenservice = ?, umgebung = ?, nachttemperatur = ?, tagestemperatur = ?, anreise_zeit = ?, abreise_zeit = ?, zeiten_24h = ?, mobilfunk = ?, wlan = ?
       WHERE id = ?`
    )
      .bind(
        body.ort.trim(),
        body.typ || "Stellplatz",
        body.datumVon,
        body.datumBis || null,
        body.kosten ? parseFloat(body.kosten) : null,
        body.wetter || "sonnig",
        body.bewertung ? parseInt(body.bewertung) : 4,
        body.notizen || null,
        body.strom ? 1 : 0,
        body.boden || null,
        body.sanitaer ? 1 : 0,
        body.bezahlung || null,
        body.broetchenservice ? 1 : 0,
        body.umgebung || null,
        body.nachttemperatur !== undefined && body.nachttemperatur !== null && body.nachttemperatur !== "" ? parseFloat(body.nachttemperatur) : null,
        body.tagestemperatur !== undefined && body.tagestemperatur !== null && body.tagestemperatur !== "" ? parseFloat(body.tagestemperatur) : null,
        body.anreiseZeit || null,
        body.abreiseZeit || null,
        body.zeiten24h ? 1 : 0,
        body.mobilfunk || null,
        body.wlan || null,
        id
      )
      .run();
    return json({ ok: true });
  }
  if (tourMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM touren WHERE id = ?").bind(tourMatch[1]).run();
    return json({ ok: true });
  }

  const favToggleMatch = pathname.match(/^\/api\/touren\/([^/]+)\/favorit$/);
  if (favToggleMatch && method === "PATCH") {
    const id = favToggleMatch[1];
    const row = await env.DB.prepare("SELECT favorit FROM touren WHERE id = ?").bind(id).first();
    if (!row) return json({ error: "Nicht gefunden" }, 404);
    const next = row.favorit ? 0 : 1;
    await env.DB.prepare("UPDATE touren SET favorit = ? WHERE id = ?").bind(next, id).run();
    return json({ favorit: next });
  }

  // --- Favoriten (Wunschliste, unabhängig von Touren) ---
  if (pathname === "/api/favoriten" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM favoriten ORDER BY erstellt_am DESC"
    ).all();
    return json(results);
  }

  if (pathname === "/api/favoriten" && method === "POST") {
    const body = await request.json();
    if (!body.ort) return json({ error: "Ort ist erforderlich." }, 400);
    const id = uid();
    await env.DB.prepare(
      "INSERT INTO favoriten (id, ort, notiz, lat, lon) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, body.ort.trim(), body.notiz || null, body.lat != null ? body.lat : null, body.lon != null ? body.lon : null)
      .run();
    return json({ id }, 201);
  }

  const favMatch = pathname.match(/^\/api\/favoriten\/([^/]+)$/);
  if (favMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM favoriten WHERE id = ?").bind(favMatch[1]).run();
    return json({ ok: true });
  }

  // --- Echte Platzsuche über OpenStreetMap (kein API-Key nötig) ---
  if (pathname === "/api/suche" && method === "GET") {
    const q = url.searchParams.get("q");
    if (!q || !q.trim()) return json({ error: "Suchbegriff fehlt." }, 400);
    try {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
        { headers: { "User-Agent": "CamperLog/1.0 (privates Reisetagebuch)" } }
      );
      const geo = await geoRes.json();
      if (!geo || !geo.length) {
        return json({ results: [], message: "Ort nicht gefunden. Versuch's mit einer Stadt oder Region." });
      }
      const lat = parseFloat(geo[0].lat);
      const lon = parseFloat(geo[0].lon);
      const radius = 20000; // 20 km
      const overpassQuery = `[out:json][timeout:25];(node["tourism"~"^(camp_site|caravan_site)$"](around:${radius},${lat},${lon});way["tourism"~"^(camp_site|caravan_site)$"](around:${radius},${lat},${lon}););out center 25;`;
      const opRes = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "CamperLog/1.0" },
        body: "data=" + encodeURIComponent(overpassQuery),
      });
      if (!opRes.ok) {
        return json({ results: [], message: "Die Kartensuche ist gerade überlastet. Bitte gleich nochmal versuchen." });
      }
      const opData = await opRes.json();
      const results = (opData.elements || [])
        .map((el) => {
          const elLat = el.lat || (el.center && el.center.lat);
          const elLon = el.lon || (el.center && el.center.lon);
          if (!elLat || !elLon) return null;
          const dist = haversine(lat, lon, elLat, elLon);
          return {
            name: (el.tags && el.tags.name) || "Unbenannter Platz",
            typ: el.tags && el.tags.tourism === "caravan_site" ? "Stellplatz" : "Campingplatz",
            lat: elLat,
            lon: elLon,
            distanzKm: Math.round(dist * 10) / 10,
            website: (el.tags && (el.tags.website || el.tags["contact:website"])) || null,
            telefon: (el.tags && (el.tags.phone || el.tags["contact:phone"])) || null,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanzKm - b.distanzKm)
        .slice(0, 20);
      return json({ results, ort: geo[0].display_name });
    } catch (e) {
      return json({ results: [], message: "Suche ist gerade nicht erreichbar." });
    }
  }

  return json({ error: "Not found" }, 404);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CamperLog – Unser Tourenbuch</title>
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#2f6f9e" />
<link rel="apple-touch-icon" href="/icon-192.jpg" />
<link rel="icon" type="image/jpeg" href="/icon-192.jpg" />
<style>
  :root {
    --paper: #f2e6cc;
    --card: #fbf4e6;
    --ink: #2b3944;
    --sky: #2f6f9e;
    --sky-soft: rgba(47,111,158,.16);
    --accent: #dc9f4e;
    --muted: #4e5b63;
    --danger: #b5482f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: Georgia, 'Iowan Old Style', serif;
  }
  .mono { font-family: 'Courier New', ui-monospace, monospace; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 0 20px 110px; }
  h1 { font-size: 34px; line-height: 1.15; color: var(--sky); margin: 0 0 6px; }
  .eyebrow {
    display: flex; align-items: center; gap: 10px;
    font-family: 'Courier New', monospace; font-size: 16px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .14em; color: var(--muted);
    margin-bottom: 10px;
  }
  .logo-badge {
    width: 40px; height: 40px; border-radius: 999px; object-fit: cover;
    border: 2px solid var(--sky); flex-shrink: 0;
  }
  .hero { padding: 36px 0 24px; }
  .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .add-btn-top {
    display: flex; align-items: center; gap: 7px; flex-shrink: 0;
    background: var(--sky); color: var(--card); border: none; border-radius: 999px;
    padding: 11px 18px 11px 14px; font-family: inherit; font-size: 14px; font-weight: 700;
    cursor: pointer; box-shadow: 3px 3px 0 var(--accent); margin-top: 6px;
  }
  .add-btn-top:active { transform: translate(1px, 1px); box-shadow: 2px 2px 0 var(--accent); }
  .add-btn-plus {
    width: 20px; height: 20px; border-radius: 999px; background: rgba(255,255,255,.22);
    display: flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1;
  }
  @media (max-width: 420px) { .add-btn-top span:last-child { display: none; } .add-btn-top { padding: 11px; } }
  .yt-link {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; margin-top: 14px;
    color: #b5482f; text-decoration: none;
    background: rgba(181,72,47,.08); border: 2px solid rgba(181,72,47,.25);
    border-radius: 999px; padding: 0;
  }
  .yt-link:hover { background: rgba(181,72,47,.15); border-color: #b5482f; }
  .yt-link svg { width: 20px; height: 20px; flex-shrink: 0; color: #b5482f; }
  .stampcard {
    position: relative;
    background: var(--card);
    border: 2px solid var(--sky);
    border-radius: 16px;
    padding: 52px 20px 22px;
    margin-bottom: 32px;
    box-shadow: 4px 4px 0 var(--sky);
  }
  .stamp {
    position: absolute; top: -16px; right: 20px;
    width: 62px; height: 62px; border-radius: 999px;
    border: 3px solid var(--accent); color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    text-align: center; transform: rotate(-4deg);
    font-family: 'Courier New', monospace; font-size: 9px; font-weight: 700;
    text-transform: uppercase; line-height: 1.15;
    animation: stampIn .5s cubic-bezier(.2,1.4,.4,1) both;
    background: var(--card);
  }
  @keyframes stampIn { from { transform: scale(1.4) rotate(-8deg); opacity: 0; } to { transform: scale(1) rotate(-4deg); opacity: 1; } }
  .stats { display: grid; grid-template-columns: repeat(3,1fr); }
  .stats > div { text-align: center; padding: 0 4px; border-left: 1px solid var(--sky-soft); }
  .stats > div:first-child { border-left: none; }
  .stat-val { font-size: 28px; font-weight: 700; color: var(--accent); display: block; }
  .stat-label { font-family: 'Courier New', monospace; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  .temp-row {
    display: flex; justify-content: center; gap: 20px; margin-top: 16px; padding-top: 14px;
    border-top: 1px solid var(--sky-soft); font-family: 'Courier New', monospace;
    font-size: 12px; color: var(--ink); font-weight: 700;
  }
  @media (max-width: 380px) {
    .stat-val { font-size: 22px; }
    .stamp { width: 54px; height: 54px; font-size: 8px; right: 12px; }
    .stampcard { padding-top: 46px; }
    .temp-row { gap: 12px; font-size: 11px; }
  }

  .section-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 14px; }
  .section-head h2 { font-size: 20px; color: var(--sky); margin: 0; }
  .count { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 600; color: var(--muted); }

  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .tab-btn {
    flex: 1 1 calc(50% - 4px); min-width: 90px; padding: 10px 6px; border-radius: 10px; border: 2px solid var(--sky-soft);
    background: var(--card); color: var(--sky); font-family: 'Courier New', monospace; font-weight: 700;
    font-size: 12px; text-transform: uppercase; letter-spacing: .04em; cursor: pointer;
  }
  .tab-btn.active { background: var(--sky); border-color: var(--sky); color: var(--paper); }

  .empty {
    border: 2px dashed var(--sky-soft); border-radius: 12px; padding: 28px;
    text-align: center; color: var(--ink); font-size: 15px;
  }
  .year-head {
    font-family: 'Courier New', monospace; font-weight: 700; font-size: 13px;
    text-transform: uppercase; letter-spacing: .15em; color: var(--sky);
    margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--sky-soft);
  }
  .year-head:first-child { margin-top: 0; }

  .filter-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .filter-select {
    background: var(--card); border: 2px solid var(--sky-soft); border-radius: 8px;
    padding: 8px 10px; font-size: 13px; font-weight: 600; color: var(--sky); font-family: 'Courier New', monospace;
    flex: 1; min-width: 130px;
  }
  .filter-toggle {
    background: var(--card); border: 2px solid var(--sky-soft); border-radius: 8px;
    padding: 8px 12px; font-size: 13px; font-weight: 700; color: var(--sky); font-family: 'Courier New', monospace;
    cursor: pointer; white-space: nowrap;
  }
  .filter-toggle.active { background: var(--accent); border-color: var(--accent); color: var(--card); }

  .time-select-row { display: flex; align-items: center; gap: 6px; }
  .time-select-row .filter-select { min-width: 0; padding: 10px 6px; font-size: 15px; text-align: center; }
  .time-colon { font-weight: 700; color: var(--sky); flex-shrink: 0; }

  .card {
    width: 100%; text-align: left; background: var(--card);
    border: 2px solid var(--sky-soft); border-radius: 10px;
    padding: 14px 16px; display: flex; align-items: center; gap: 14px;
    margin-bottom: 10px; cursor: pointer;
  }
  .card:hover { border-color: var(--accent); }
  .icon-circle {
    width: 38px; height: 38px; border-radius: 999px; background: var(--sky-soft);
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 17px;
  }
  .card-body { flex: 1; min-width: 0; }
  .card-title { font-weight: 700; color: var(--sky); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-meta { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 3px; display: flex; gap: 6px; flex-wrap: wrap; }
  .fav-star { font-size: 18px; cursor: pointer; flex-shrink: 0; background: none; border: none; padding: 4px; line-height: 1; }
  .stars { color: var(--accent); font-size: 12px; letter-spacing: 1px; flex-shrink: 0; }

  /* FAB entfernt zugunsten des Hinzufügen-Buttons oben im Hero */

  label.field { display: block; margin-bottom: 16px; }
  .field-label { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); display: block; margin-bottom: 6px; }
  input, textarea, select {
    width: 100%; background: var(--card); border: 2px solid var(--sky-soft); border-radius: 8px;
    padding: 10px 12px; font-size: 15px; color: var(--ink); font-family: inherit;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { min-height: 90px; resize: vertical; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .choice-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .choice-btn {
    flex: 1; min-width: 80px; padding: 10px; border-radius: 8px; border: 2px solid var(--sky-soft);
    background: var(--card); color: var(--sky); font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  .choice-btn.sel { background: var(--sky); border-color: var(--sky); color: var(--paper); }
  .weather-btn { flex-direction: column; display: flex; align-items: center; gap: 4px; flex: none; width: 68px; }
  .star-picker { display: flex; gap: 4px; }
  .star-picker button { background: none; border: none; font-size: 26px; cursor: pointer; color: var(--sky-soft); }
  .star-picker button.on { color: var(--accent); }

  .btn-back {
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: 999px;
    background: var(--card); border: 2px solid var(--sky-soft); color: var(--sky);
    cursor: pointer; flex-shrink: 0; padding: 0;
  }
  .btn-back:hover { border-color: var(--sky); background: var(--sky-soft); }
  .btn-back:active { transform: translate(1px, 1px); }
  .btn-back svg { width: 18px; height: 18px; }
  .icon-btn {
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: 999px;
    background: var(--card); border: 2px solid var(--sky-soft); color: var(--sky);
    cursor: pointer; flex-shrink: 0; padding: 0;
  }
  .icon-btn svg { width: 17px; height: 17px; }
  .icon-btn:hover { border-color: var(--sky); background: var(--sky-soft); }
  .icon-btn.danger { color: var(--danger); }
  .icon-btn.danger:hover { border-color: var(--danger); background: rgba(181,72,47,.1); }
  .icon-btn-row { display: flex; gap: 8px; }
  .top-row { display: flex; align-items: center; justify-content: space-between; padding: 28px 0 18px; }
  .top-row-left { display: flex; align-items: center; gap: 10px; }
  .top-row h1 { font-size: 24px; margin: 0; }

  .btn-primary {
    width: 100%; background: var(--accent); color: var(--card); font-weight: 700;
    padding: 15px; border: none; border-radius: 10px; font-size: 16px; cursor: pointer;
    box-shadow: 3px 3px 0 var(--sky); font-family: inherit;
  }
  .btn-primary:disabled { opacity: .6; }
  .btn-primary svg { width: 18px; height: 18px; flex-shrink: 0; }
  .err { color: var(--danger); font-size: 14px; margin-bottom: 14px; }

  .detail-box { background: var(--card); border: 2px solid var(--sky-soft); border-radius: 14px; padding: 20px; }
  .detail-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .detail-row:last-child { margin-bottom: 0; }
  .detail-label { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); width: 96px; flex-shrink: 0; }
  .confirm-box { border: 2px solid var(--danger); background: #f6e8e0; border-radius: 10px; padding: 14px; margin-bottom: 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .confirm-box button { border-radius: 6px; padding: 7px 12px; font-size: 13px; cursor: pointer; border: 1px solid var(--danger); font-family: inherit; }
  .confirm-box .yes { background: var(--danger); color: white; border: none; }
  .confirm-box .no { background: transparent; color: var(--danger); }

  .pin-icon { color: var(--sky); flex-shrink: 0; cursor: pointer; }
  .pin-icon svg { width: 20px; height: 20px; display: block; }
  .icon-circle svg { width: 16px; height: 16px; }
  .result-body { cursor: pointer; }

  .search-row { display: flex; gap: 8px; margin-bottom: 18px; }
  .search-row input { flex: 1; }
  .search-btn {
    background: var(--sky); color: var(--card); border: none; border-radius: 8px;
    padding: 0 18px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit;
  }
  .search-btn:disabled { opacity: .6; }
  .result-card {
    background: var(--card); border: 2px solid var(--sky-soft); border-radius: 10px;
    padding: 14px 16px; display: flex; align-items: center; gap: 14px; margin-bottom: 10px;
  }
  .result-body { flex: 1; min-width: 0; }
  .result-title { font-weight: 700; color: var(--sky); }
  .result-meta { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 3px; }
  .add-todrive-btn {
    background: var(--accent); color: var(--card); border: none; border-radius: 999px;
    width: 34px; height: 34px; font-size: 18px; cursor: pointer; flex-shrink: 0; line-height: 1;
  }
  .add-todrive-btn:disabled { opacity: .5; }
  .search-msg { color: var(--ink); font-size: 15px; text-align: center; padding: 18px; }
  .hidden { display: none !important; }

  .badge-card {
    display: flex; align-items: center; gap: 14px;
    background: linear-gradient(135deg, rgba(220,159,78,.18), rgba(47,111,158,.1));
    border: 2px solid var(--accent); border-radius: 14px; padding: 16px 18px; margin-bottom: 18px;
  }
  .badge-icon { font-size: 32px; flex-shrink: 0; }
  .badge-title { font-weight: 700; color: var(--sky); font-size: 15px; }
  .badge-sub { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 2px; }

  .chart-card { background: var(--card); border: 2px solid var(--sky-soft); border-radius: 14px; padding: 18px; margin-bottom: 18px; }
  .chart-bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .chart-bar-row:last-child { margin-bottom: 0; }
  .chart-bar-label { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: var(--muted); width: 40px; flex-shrink: 0; }
  .chart-bar-track { flex: 1; height: 14px; background: var(--sky-soft); border-radius: 999px; overflow: hidden; }
  .chart-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width .4s ease; }
  .chart-bar-value { font-family: 'Courier New', monospace; font-size: 12px; color: var(--sky); font-weight: 700; width: 56px; text-align: right; flex-shrink: 0; }

  .year-card { background: var(--card); border: 2px solid var(--sky-soft); border-radius: 14px; padding: 18px; margin-bottom: 14px; }
  .year-card-head { font-family: 'Courier New', monospace; font-weight: 700; font-size: 14px; color: var(--sky); text-transform: uppercase; letter-spacing: .1em; margin-bottom: 12px; }
  .year-card-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 6px; }
  .year-card-grid > div { text-align: center; }
  .ycg-val { display: block; font-weight: 700; font-size: 18px; color: var(--accent); }
  .ycg-label { font-family: 'Courier New', monospace; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .year-card-fav { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--sky-soft); font-size: 13px; color: var(--ink); }
</style>
</head>
<body>
<div class="wrap" id="app"></div>

<script>
const WEATHER = [
  { key: 'sonnig', label: 'Sonnig', emoji: '☀️' },
  { key: 'bewoelkt', label: 'Bewölkt', emoji: '☁️' },
  { key: 'regen', label: 'Regen', emoji: '🌧️' },
  { key: 'windig', label: 'Windig', emoji: '💨' },
  { key: 'schnee', label: 'Schnee', emoji: '❄️' },
];
const PLATZ_TYPEN = ['Campingplatz', 'Stellplatz', 'Wildcamping'];
const BODEN_TYPEN = ['Schotter', 'Rasen', 'Sand', 'Asphalt', 'Wiese', 'Sonstiges'];
const BEZAHLUNG_TYPEN = ['Bar', 'Karte', 'Online'];
const UMGEBUNG_TYPEN = ['Natur', 'Stadt', 'Beides'];
const SIGNAL_STUFEN = ['Kein Empfang', 'Schwach', 'Mittel', 'Gut', 'Stark'];

const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
const ICON_YOUTUBE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4L15.8 12Z"/></svg>';

let state = {
  view: 'home', // home | form | detail
  touren: [],
  favoriten: [],
  activeId: null,
  editingId: null,
  homeTab: 'touren', // touren | favoriten | suche
  saving: false,
  error: '',
  sucheQuery: '',
  sucheLoading: false,
  sucheResults: null,
  sucheMessage: '',
  sucheAddedIds: {},
  tourenSort: 'datum_neu',
  tourenFilterUmgebung: '',
  tourenFilterFavorit: false,
};

function weatherEmoji(value) {
  if (!value) return WEATHER[0].emoji;
  return value.split(',').filter(Boolean).map(k => (WEATHER.find(w => w.key === k) || WEATHER[0]).emoji).join(' ') || WEATHER[0].emoji;
}
function weatherLabel(value) {
  if (!value) return '';
  return value.split(',').filter(Boolean).map(k => (WEATHER.find(w => w.key === k) || WEATHER[0]).label).join(', ');
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function starsStr(n) {
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
}
const STUNDEN = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTEN = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];
function zeitOptions(range, selected) {
  let html = '<option value="">--</option>';
  range.forEach((v) => {
    html += '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + v + '</option>';
  });
  return html;
}
function mapsUrlByName(name) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name);
}
function mapsUrlByCoords(lat, lon) {
  return 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lon;
}
function openMaps(placeOrCoords, name) {
  let url;
  if (placeOrCoords && placeOrCoords.lat != null && placeOrCoords.lon != null) {
    url = mapsUrlByCoords(placeOrCoords.lat, placeOrCoords.lon);
  } else {
    url = mapsUrlByName(name || placeOrCoords);
  }
  window.open(url, '_blank');
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.reload();
    throw new Error('Nicht angemeldet.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Fehler' }));
    throw new Error(err.error || 'Fehler');
  }
  return res.json();
}

async function loadData() {
  const [touren, favoriten] = await Promise.all([
    api('/api/touren'),
    api('/api/favoriten'),
  ]);
  state.touren = touren;
  state.favoriten = favoriten;
  render();
}

async function toggleFavorit(id) {
  await api('/api/touren/' + id + '/favorit', { method: 'PATCH' });
  await loadData();
}

async function deleteTour(id) {
  await api('/api/touren/' + id, { method: 'DELETE' });
  state.view = 'home';
  await loadData();
}

async function deleteFavorit(id) {
  await api('/api/favoriten/' + id, { method: 'DELETE' });
  await loadData();
}

async function suchePlaetze(q) {
  return api('/api/suche?q=' + encodeURIComponent(q));
}

async function zuToDriveHinzufuegen(result) {
  const notizTeile = [result.typ];
  if (result.distanzKm != null) notizTeile.push(result.distanzKm + ' km entfernt');
  if (result.website) notizTeile.push(result.website);
  await api('/api/favoriten', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ort: result.name, notiz: notizTeile.join(' · '), lat: result.lat, lon: result.lon }),
  });
  await loadData();
}

function computeStats() {
  const orte = new Set(state.touren.map(t => t.ort.trim().toLowerCase()).filter(Boolean));
  const naechte = state.touren.reduce((sum, t) => {
    if (!t.datum_von || !t.datum_bis) return sum + 1;
    const a = new Date(t.datum_von), b = new Date(t.datum_bis);
    const diff = Math.round((b - a) / 86400000);
    return sum + Math.max(1, diff);
  }, 0);
  const temps = state.touren.map(t => t.nachttemperatur).filter(v => v !== null && v !== undefined && v !== '');
  const avgTemp = temps.length ? Math.round((temps.reduce((s, v) => s + parseFloat(v), 0) / temps.length) * 10) / 10 : null;
  const tagTemps = state.touren.map(t => t.tagestemperatur).filter(v => v !== null && v !== undefined && v !== '');
  const avgTagTemp = tagTemps.length ? Math.round((tagTemps.reduce((s, v) => s + parseFloat(v), 0) / tagTemps.length) * 10) / 10 : null;
  return { plaetze: orte.size, touren: state.touren.length, naechte, avgTemp, avgTagTemp };
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  if (state.view === 'home') app.appendChild(renderHome());
  else if (state.view === 'form') {
    const editTour = state.editingId ? state.touren.find(x => x.id === state.editingId) : null;
    app.appendChild(renderForm(editTour));
  }
  else if (state.view === 'detail') app.appendChild(renderDetail());
}

function renderHome() {
  const stats = computeStats();
  const wrap = el('<div></div>');
  wrap.innerHTML = \`
    <div class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow"><img src="/icon-192.jpg" class="logo-badge" alt="CamperLog Logo" /> Unser Tourenbuch</div>
          <h1>Unterwegs im<br/>Wohnmobil</h1>
        </div>
        <button class="add-btn-top" id="add-top-btn"><span class="add-btn-plus">+</span><span>Neue Tour</span></button>
      </div>
      <a href="https://www.youtube.com/@Iva_ontour" target="_blank" rel="noopener" class="yt-link" title="Iva on Tour auf YouTube">\${ICON_YOUTUBE}</a>
    </div>
    <div class="stampcard">
      <div class="stamp">\${stats.plaetze}<br/>Plätze</div>
      <div class="stats">
        <div><span class="stat-val">\${stats.plaetze}</span><span class="stat-label">Plätze</span></div>
        <div><span class="stat-val">\${stats.touren}</span><span class="stat-label">Touren</span></div>
        <div><span class="stat-val">\${stats.naechte}</span><span class="stat-label">Nächte</span></div>
      </div>
      \${(stats.avgTemp != null || stats.avgTagTemp != null) ? \`
      <div class="temp-row">
        <span>☀️ Ø Tag \${stats.avgTagTemp != null ? stats.avgTagTemp + '°' : '–'}</span>
        <span>🌙 Ø Nacht \${stats.avgTemp != null ? stats.avgTemp + '°' : '–'}</span>
      </div>\` : ''}
    </div>
    <div id="todrive-home"></div>
    <div class="tabs">
      <button class="tab-btn \${state.homeTab === 'touren' ? 'active' : ''}" data-tab="touren">Touren</button>
      <button class="tab-btn \${state.homeTab === 'favoriten' ? 'active' : ''}" data-tab="favoriten">★ Favoriten</button>
      <button class="tab-btn \${state.homeTab === 'suche' ? 'active' : ''}" data-tab="suche">🔍 Suche</button>
      <button class="tab-btn \${state.homeTab === 'rueckblick' ? 'active' : ''}" data-tab="rueckblick">📊 Rückblick</button>
    </div>
    <div id="tab-content"></div>
  \`;
  wrap.querySelector('#todrive-home').appendChild(renderToDriveHome());
  wrap.querySelector('#add-top-btn').onclick = () => { state.editingId = null; state.view = 'form'; state.error = ''; render(); };
  wrap.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => { state.homeTab = btn.dataset.tab; render(); };
  });
  const content = wrap.querySelector('#tab-content');
  if (state.homeTab === 'touren') {
    content.appendChild(renderTourenTab());
  } else if (state.homeTab === 'favoriten') {
    content.appendChild(renderFavoritenTab());
  } else if (state.homeTab === 'suche') {
    content.appendChild(renderSucheTab());
  } else {
    content.appendChild(renderRueckblickTab());
  }
  return wrap;
}

function renderToDriveHome() {
  const box = el('<div></div>');
  if (state.favoriten.length === 0) {
    return box; // nichts anzeigen, wenn die Liste leer ist
  }
  box.innerHTML = \`
    <div class="section-head" style="margin-top: 6px;"><h2 style="font-size:17px;">📍 ToDrive-Liste</h2><span class="count">\${state.favoriten.length} Plätze</span></div>
  \`;
  state.favoriten.forEach(f => {
    const card = el(\`
      <div class="card" title="Auf Google Maps öffnen">
        <div class="icon-circle pin-icon">\${ICON_PIN}</div>
        <div class="card-body">
          <div class="card-title">\${escapeHtml(f.ort)}</div>
          <div class="card-meta"><span>\${f.notiz ? escapeHtml(f.notiz) : 'Zum Vormerken'}</span></div>
        </div>
        <button class="icon-btn danger" title="Von der ToDrive-Liste entfernen">\${ICON_TRASH}</button>
      </div>
    \`);
    card.querySelector('.card-body').onclick = () => openMaps(f.lat != null ? { lat: f.lat, lon: f.lon } : null, f.ort);
    card.querySelector('.icon-circle').onclick = () => openMaps(f.lat != null ? { lat: f.lat, lon: f.lon } : null, f.ort);
    card.querySelector('.icon-btn').onclick = (e) => { e.stopPropagation(); deleteFavorit(f.id); };
    box.appendChild(card);
  });
  return box;
}

function renderTourCard(t) {
  const card = el(\`
    <div class="card">
      <div class="icon-circle">\${weatherEmoji(t.wetter)}</div>
      <div class="card-body">
        <div class="card-title">\${escapeHtml(t.ort)}</div>
        <div class="card-meta"><span>\${fmtDate(t.datum_von)}</span><span>·</span><span>\${escapeHtml(t.typ)}</span>\${t.strom ? '<span>⚡</span>' : ''}\${t.sanitaer ? '<span>🚿</span>' : ''}\${t.broetchenservice ? '<span>🥐</span>' : ''}</div>
      </div>
      <div class="stars">\${starsStr(t.bewertung || 0)}</div>
      <button class="fav-star">\${t.favorit ? '★' : '☆'}</button>
    </div>
  \`);
  card.querySelector('.fav-star').onclick = (e) => { e.stopPropagation(); toggleFavorit(t.id); };
  card.onclick = () => { state.activeId = t.id; state.view = 'detail'; render(); };
  return card;
}

function renderTourenTab() {
  const box = el('<div></div>');
  box.innerHTML = \`
    <div class="section-head"><h2>Bisherige Touren</h2><span class="count" id="touren-count"></span></div>
    <div class="filter-row">
      <select id="sort-select" class="filter-select">
        <option value="datum_neu">Neueste zuerst</option>
        <option value="datum_alt">Älteste zuerst</option>
        <option value="bewertung">Beste Bewertung</option>
        <option value="kosten_hoch">Teuerste zuerst</option>
        <option value="kosten_niedrig">Günstigste zuerst</option>
      </select>
      <select id="umgebung-select" class="filter-select">
        <option value="">Alle Umgebungen</option>
        <option value="Natur">Natur</option>
        <option value="Stadt">Stadt</option>
        <option value="Beides">Beides</option>
      </select>
      <button id="fav-filter-btn" class="filter-toggle \${state.tourenFilterFavorit ? 'active' : ''}">★ Nur Favoriten</button>
    </div>
    <div id="touren-list"></div>
  \`;

  const sortSel = box.querySelector('#sort-select');
  const umgSel = box.querySelector('#umgebung-select');
  const favBtn = box.querySelector('#fav-filter-btn');
  sortSel.value = state.tourenSort;
  umgSel.value = state.tourenFilterUmgebung;
  sortSel.onchange = () => { state.tourenSort = sortSel.value; render(); };
  umgSel.onchange = () => { state.tourenFilterUmgebung = umgSel.value; render(); };
  favBtn.onclick = () => { state.tourenFilterFavorit = !state.tourenFilterFavorit; render(); };

  let list = [...state.touren];
  if (state.tourenFilterUmgebung) list = list.filter(t => (t.umgebung || '') === state.tourenFilterUmgebung);
  if (state.tourenFilterFavorit) list = list.filter(t => t.favorit);

  box.querySelector('#touren-count').textContent = list.length + ' Einträge';
  const listEl = box.querySelector('#touren-list');

  if (list.length === 0) {
    listEl.appendChild(el('<div class="empty">Keine Touren gefunden. Passe die Filter an oder trag eine neue Tour ein.</div>'));
    return box;
  }

  if (state.tourenSort === 'datum_neu' || state.tourenSort === 'datum_alt') {
    const neuZuerst = state.tourenSort === 'datum_neu';
    list.sort((a, b) => neuZuerst ? (b.datum_von || '').localeCompare(a.datum_von || '') : (a.datum_von || '').localeCompare(b.datum_von || ''));
    const gruppen = {};
    list.forEach(t => {
      const jahr = t.datum_von ? t.datum_von.slice(0, 4) : 'Unbekannt';
      if (!gruppen[jahr]) gruppen[jahr] = [];
      gruppen[jahr].push(t);
    });
    const jahre = Object.keys(gruppen).sort((a, b) => neuZuerst ? b.localeCompare(a) : a.localeCompare(b));
    jahre.forEach(jahr => {
      listEl.appendChild(el(\`<div class="year-head">Touren \${jahr}</div>\`));
      gruppen[jahr].forEach(t => listEl.appendChild(renderTourCard(t)));
    });
  } else {
    if (state.tourenSort === 'bewertung') list.sort((a, b) => (b.bewertung || 0) - (a.bewertung || 0));
    else if (state.tourenSort === 'kosten_hoch') list.sort((a, b) => (parseFloat(b.kosten) || 0) - (parseFloat(a.kosten) || 0));
    else if (state.tourenSort === 'kosten_niedrig') list.sort((a, b) => (parseFloat(a.kosten) || 0) - (parseFloat(b.kosten) || 0));
    list.forEach(t => listEl.appendChild(renderTourCard(t)));
  }
  return box;
}

function renderFavoritenTab() {
  const box = el('<div></div>');
  const favTouren = state.touren.filter(t => t.favorit);
  box.innerHTML = \`
    <div class="section-head"><h2>Favoriten-Plätze</h2><span class="count">\${favTouren.length} Einträge</span></div>
  \`;

  if (favTouren.length === 0) {
    box.appendChild(el('<div class="empty">Noch keine Favoriten. Markiere einen besuchten Platz mit ★, oder finde neue Plätze im Tab "Suche" – die landen dann auf der ToDrive-Liste oben auf der Startseite.</div>'));
    return box;
  }

  favTouren.forEach(t => {
    const card = el(\`
      <div class="card">
        <div class="icon-circle">\${weatherEmoji(t.wetter)}</div>
        <div class="card-body">
          <div class="card-title">\${escapeHtml(t.ort)}</div>
          <div class="card-meta"><span>Besucht · \${fmtDate(t.datum_von)}</span></div>
        </div>
        <button class="fav-star">★</button>
      </div>
    \`);
    card.querySelector('.fav-star').onclick = (e) => { e.stopPropagation(); toggleFavorit(t.id); };
    card.onclick = () => { state.activeId = t.id; state.view = 'detail'; render(); };
    box.appendChild(card);
  });
  return box;
}

function renderRueckblickTab() {
  const box = el('<div></div>');
  if (state.touren.length === 0) {
    box.appendChild(el('<div class="empty">Noch keine Touren für einen Rückblick. Trag eure erste Tour ein!</div>'));
    return box;
  }

  // Nach Jahr gruppieren
  const jahre = {};
  state.touren.forEach(t => {
    const jahr = t.datum_von ? t.datum_von.slice(0, 4) : 'Unbekannt';
    if (!jahre[jahr]) jahre[jahr] = [];
    jahre[jahr].push(t);
  });
  const jahresListe = Object.keys(jahre).sort((a, b) => b.localeCompare(a));
  const maxKosten = Math.max(...jahresListe.map(j => jahre[j].reduce((s, t) => s + (parseFloat(t.kosten) || 0), 0)), 1);

  // Meistbesuchter Platz (über alle Jahre)
  const ortCount = {};
  state.touren.forEach(t => {
    const key = t.ort.trim();
    ortCount[key] = (ortCount[key] || 0) + 1;
  });
  let topOrt = null, topCount = 0;
  Object.entries(ortCount).forEach(([ort, c]) => { if (c > topCount) { topOrt = ort; topCount = c; } });

  box.appendChild(el(\`<div class="section-head"><h2>📊 Rückblick</h2></div>\`));

  if (topOrt && topCount > 1) {
    box.appendChild(el(\`
      <div class="badge-card">
        <div class="badge-icon">🏆</div>
        <div>
          <div class="badge-title">Euer Lieblingsplatz</div>
          <div class="badge-sub">\${escapeHtml(topOrt)} · \${topCount}× besucht</div>
        </div>
      </div>
    \`));
  }

  // Kosten-Balkendiagramm über Jahre
  if (jahresListe.length > 1) {
    const chart = el('<div class="chart-card"><div class="field-label" style="margin-bottom:14px;">Kosten pro Jahr</div><div class="chart-bars"></div></div>');
    const bars = chart.querySelector('.chart-bars');
    [...jahresListe].reverse().forEach(jahr => {
      const summe = jahre[jahr].reduce((s, t) => s + (parseFloat(t.kosten) || 0), 0);
      const pct = Math.max(4, Math.round((summe / maxKosten) * 100));
      bars.appendChild(el(\`
        <div class="chart-bar-row">
          <span class="chart-bar-label">\${jahr}</span>
          <div class="chart-bar-track"><div class="chart-bar-fill" style="width:\${pct}%"></div></div>
          <span class="chart-bar-value">\${summe.toFixed(0)} €</span>
        </div>
      \`));
    });
    box.appendChild(chart);
  }

  // Jahreskarten mit Details
  jahresListe.forEach(jahr => {
    const touren = jahre[jahr];
    const naechte = touren.reduce((sum, t) => {
      if (!t.datum_von || !t.datum_bis) return sum + 1;
      const a = new Date(t.datum_von), b = new Date(t.datum_bis);
      const diff = Math.round((b - a) / 86400000);
      return sum + Math.max(1, diff);
    }, 0);
    const kosten = touren.reduce((s, t) => s + (parseFloat(t.kosten) || 0), 0);
    const temps = touren.map(t => t.nachttemperatur).filter(v => v !== null && v !== undefined && v !== '');
    const minTemp = temps.length ? Math.min(...temps.map(parseFloat)) : null;
    const maxTemp = temps.length ? Math.max(...temps.map(parseFloat)) : null;
    const bewertungen = touren.map(t => t.bewertung || 0);
    const beste = touren.slice().sort((a, b) => (b.bewertung || 0) - (a.bewertung || 0))[0];

    box.appendChild(el(\`
      <div class="year-card">
        <div class="year-card-head">\${jahr}</div>
        <div class="year-card-grid">
          <div><span class="ycg-val">\${touren.length}</span><span class="ycg-label">Touren</span></div>
          <div><span class="ycg-val">\${naechte}</span><span class="ycg-label">Nächte</span></div>
          <div><span class="ycg-val">\${kosten.toFixed(0)} €</span><span class="ycg-label">Kosten</span></div>
          <div><span class="ycg-val">\${minTemp != null ? minTemp + '° – ' + maxTemp + '°' : '–'}</span><span class="ycg-label">Temp.</span></div>
        </div>
        \${beste ? \`<div class="year-card-fav">⭐ Bestbewertet: \${escapeHtml(beste.ort)} (\${starsStr(beste.bewertung || 0)})</div>\` : ''}
      </div>
    \`));
  });

  return box;
}

function renderSucheTab() {
  const box = el('<div></div>');
  box.innerHTML = \`
    <div class="section-head"><h2>Plätze finden</h2></div>
    <div class="search-row">
      <input type="text" id="suche-input" placeholder="Ort, Region oder Land eingeben …" value="\${escapeHtml(state.sucheQuery)}" />
      <button class="search-btn" id="suche-btn">\${state.sucheLoading ? '…' : 'Suchen'}</button>
    </div>
    <div id="suche-ergebnisse"></div>
  \`;
  const input = box.querySelector('#suche-input');
  const btn = box.querySelector('#suche-btn');
  const ergebnisse = box.querySelector('#suche-ergebnisse');

  async function runSearch() {
    const q = input.value.trim();
    if (!q) return;
    state.sucheQuery = q;
    state.sucheLoading = true;
    state.sucheMessage = '';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await suchePlaetze(q);
      state.sucheResults = res.results || [];
      state.sucheMessage = res.message || (state.sucheResults.length === 0 ? 'Keine Plätze in der Nähe gefunden.' : '');
    } catch (e) {
      state.sucheResults = [];
      state.sucheMessage = 'Suche ist gerade nicht erreichbar. Bitte später nochmal versuchen.';
    }
    state.sucheLoading = false;
    render();
  }
  btn.onclick = runSearch;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } };

  if (state.sucheResults === null) {
    ergebnisse.appendChild(el('<div class="empty">Gib einen Ort ein – z. B. eine Stadt, Region oder Küste – und finde echte Camping- und Stellplätze in der Umgebung (Daten von OpenStreetMap).</div>'));
    return box;
  }
  if (state.sucheMessage && state.sucheResults.length === 0) {
    ergebnisse.appendChild(el(\`<div class="search-msg">\${escapeHtml(state.sucheMessage)}</div>\`));
    return box;
  }
  state.sucheResults.forEach((r, i) => {
    const already = state.favoriten.some(f => f.ort === r.name) || state.sucheAddedIds[i];
    const card = el(\`
      <div class="result-card">
        <div class="icon-circle pin-icon" title="Auf Google Maps öffnen">\${ICON_PIN}</div>
        <div class="result-body" title="Auf Google Maps öffnen">
          <div class="result-title">\${escapeHtml(r.name)}</div>
          <div class="result-meta">\${escapeHtml(r.typ)} · \${r.distanzKm} km entfernt\${r.website ? ' · Website vorhanden' : ''}</div>
        </div>
        <button class="add-todrive-btn" \${already ? 'disabled' : ''} title="Zur ToDrive-Liste hinzufügen">\${already ? '✓' : '+'}</button>
      </div>
    \`);
    card.querySelector('.icon-circle').onclick = () => openMaps({ lat: r.lat, lon: r.lon });
    card.querySelector('.result-body').onclick = () => openMaps({ lat: r.lat, lon: r.lon });
    if (!already) {
      card.querySelector('.add-todrive-btn').onclick = async (e) => {
        e.stopPropagation();
        state.sucheAddedIds[i] = true;
        await zuToDriveHinzufuegen(r);
      };
    }
    ergebnisse.appendChild(card);
  });
  return box;
}

function renderForm(editTour) {
  const isEdit = !!editTour;
  const form = isEdit ? {
    ort: editTour.ort || '',
    typ: editTour.typ || 'Stellplatz',
    datumVon: editTour.datum_von || '',
    datumBis: editTour.datum_bis || '',
    kosten: editTour.kosten != null ? String(editTour.kosten) : '',
    wetter: (editTour.wetter || 'sonnig').split(',').filter(Boolean),
    bewertung: editTour.bewertung || 4,
    notizen: editTour.notizen || '',
    strom: !!editTour.strom,
    boden: (editTour.boden || '').split(',').filter(Boolean),
    sanitaer: !!editTour.sanitaer,
    bezahlung: (editTour.bezahlung || '').split(',').filter(Boolean),
    broetchenservice: !!editTour.broetchenservice,
    umgebung: editTour.umgebung || '',
    nachttemperatur: editTour.nachttemperatur != null ? String(editTour.nachttemperatur) : '',
    tagestemperatur: editTour.tagestemperatur != null ? String(editTour.tagestemperatur) : '',
    anreiseZeit: editTour.anreise_zeit || '',
    abreiseZeit: editTour.abreise_zeit || '',
    zeiten24h: !!editTour.zeiten_24h,
    mobilfunk: editTour.mobilfunk || '',
    wlan: editTour.wlan || '',
  } : {
    ort: '', typ: 'Stellplatz', datumVon: '', datumBis: '',
    kosten: '', wetter: ['sonnig'], bewertung: 4, notizen: '',
    strom: false, boden: [], sanitaer: false, bezahlung: [], broetchenservice: false, umgebung: '',
    nachttemperatur: '', tagestemperatur: '', anreiseZeit: '', abreiseZeit: '', zeiten24h: false,
    mobilfunk: '', wlan: '',
  };
  const [anreiseH, anreiseM] = (form.anreiseZeit || '').split(':');
  const [abreiseH, abreiseM] = (form.abreiseZeit || '').split(':');
  const wrap = el('<div></div>');
  wrap.innerHTML = \`
    <div class="top-row"><div class="top-row-left"><button class="btn-back">\${ICON_BACK}</button><h1>\${isEdit ? 'Tour bearbeiten' : 'Neue Tour eintragen'}</h1></div></div>
    <form id="tour-form">
      <label class="field"><span class="field-label">Ort / Platzname</span><input name="ort" required placeholder="z. B. Campingplatz Seeblick" value="\${escapeHtml(form.ort)}" /></label>
      <label class="field"><span class="field-label">Art des Platzes</span>
        <div class="choice-row" id="typ-row">
          \${PLATZ_TYPEN.map(t => \`<button type="button" class="choice-btn \${t === form.typ ? 'sel' : ''}" data-typ="\${t}">\${t}</button>\`).join('')}
        </div>
      </label>
      <div class="row2">
        <label class="field"><span class="field-label">Von</span><input type="date" name="datumVon" required value="\${form.datumVon}" /></label>
        <label class="field"><span class="field-label">Bis</span><input type="date" name="datumBis" value="\${form.datumBis}" /></label>
      </div>
      <div class="row2" id="zeiten-row" style="\${form.zeiten24h ? 'display:none;' : ''}">
        <label class="field"><span class="field-label">Anreisezeit</span>
          <div class="time-select-row">
            <select name="anreiseStunde" class="filter-select">\${zeitOptions(STUNDEN, anreiseH)}</select>
            <span class="time-colon">:</span>
            <select name="anreiseMinute" class="filter-select">\${zeitOptions(MINUTEN, anreiseM)}</select>
          </div>
        </label>
        <label class="field"><span class="field-label">Abreisezeit</span>
          <div class="time-select-row">
            <select name="abreiseStunde" class="filter-select">\${zeitOptions(STUNDEN, abreiseH)}</select>
            <span class="time-colon">:</span>
            <select name="abreiseMinute" class="filter-select">\${zeitOptions(MINUTEN, abreiseM)}</select>
          </div>
        </label>
      </div>
      <label class="field">
        <button type="button" class="choice-btn \${form.zeiten24h ? 'sel' : ''}" id="zeiten-24h-btn" style="width:100%;">🕐 Ein-/Ausfahrt rund um die Uhr (24 Stunden)</button>
      </label>
      <label class="field"><span class="field-label">Boden (mehrfach möglich)</span>
        <div class="choice-row" id="boden-row">
          \${BODEN_TYPEN.map(b => \`<button type="button" class="choice-btn \${form.boden.includes(b) ? 'sel' : ''}" data-boden="\${b}">\${b}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">Ausstattung</span>
        <div class="choice-row" id="ausstattung-row">
          <button type="button" class="choice-btn \${form.strom ? 'sel' : ''}" data-flag="strom">⚡ Strom</button>
          <button type="button" class="choice-btn \${form.sanitaer ? 'sel' : ''}" data-flag="sanitaer">🚿 Sanitär</button>
          <button type="button" class="choice-btn \${form.broetchenservice ? 'sel' : ''}" data-flag="broetchenservice">🥐 Brötchenservice</button>
        </div>
      </label>
      <label class="field"><span class="field-label">Bezahlen (mehrfach möglich)</span>
        <div class="choice-row" id="bezahlung-row">
          \${BEZAHLUNG_TYPEN.map(b => \`<button type="button" class="choice-btn \${form.bezahlung.includes(b) ? 'sel' : ''}" data-bezahlung="\${b}">\${b}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">Umgebung</span>
        <div class="choice-row" id="umgebung-row">
          \${UMGEBUNG_TYPEN.map(u => \`<button type="button" class="choice-btn \${u === form.umgebung ? 'sel' : ''}" data-umgebung="\${u}">\${u}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">📶 Mobilfunk-Empfang</span>
        <div class="choice-row" id="mobilfunk-row">
          \${SIGNAL_STUFEN.map(s => \`<button type="button" class="choice-btn signal-btn \${s === form.mobilfunk ? 'sel' : ''}" data-mobilfunk="\${s}">\${s}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">📡 WLAN-Stärke</span>
        <div class="choice-row" id="wlan-row">
          \${SIGNAL_STUFEN.map(s => \`<button type="button" class="choice-btn signal-btn \${s === form.wlan ? 'sel' : ''}" data-wlan="\${s}">\${s}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">Kosten (€)</span><input type="number" step="0.01" min="0" name="kosten" placeholder="0,00" value="\${form.kosten}" /></label>
      <label class="field"><span class="field-label">Wetter (mehrfach möglich)</span>
        <div class="choice-row" id="wetter-row">
          \${WEATHER.map(w => \`<button type="button" class="choice-btn weather-btn \${form.wetter.includes(w.key) ? 'sel' : ''}" data-wetter="\${w.key}"><span style="font-size:18px">\${w.emoji}</span><span class="mono" style="font-size:10px">\${w.label}</span></button>\`).join('')}
        </div>
      </label>
      <div class="row2">
        <label class="field"><span class="field-label">Tagestemperatur (°C)</span><input type="number" step="0.5" name="tagestemperatur" placeholder="z. B. 22" value="\${form.tagestemperatur}" /></label>
        <label class="field"><span class="field-label">Nachttemperatur (°C)</span><input type="number" step="0.5" name="nachttemperatur" placeholder="z. B. 12" value="\${form.nachttemperatur}" /></label>
      </div>
      <label class="field"><span class="field-label">Bewertung des Platzes</span>
        <div class="star-picker" id="star-picker">
          \${[1,2,3,4,5].map(i => \`<button type="button" data-star="\${i}" class="\${i <= form.bewertung ? 'on' : ''}">★</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">Notizen</span><textarea name="notizen" placeholder="Besonderheiten, Tipps für nächstes Mal, Ausblick …">\${escapeHtml(form.notizen)}</textarea></label>
      <div class="err hidden" id="form-err"></div>
      <button type="submit" class="btn-primary" id="submit-btn">\${isEdit ? 'Änderungen speichern' : 'Tour speichern'}</button>
    </form>
  \`;
  wrap.querySelector('.btn-back').onclick = () => {
    state.view = isEdit ? 'detail' : 'home';
    render();
  };

  wrap.querySelectorAll('#typ-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      form.typ = btn.dataset.typ;
      wrap.querySelectorAll('#typ-row .choice-btn').forEach(b => b.classList.toggle('sel', b === btn));
    };
  });
  // Boden: mehrfach abhakbar
  wrap.querySelectorAll('#boden-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.boden;
      if (form.boden.includes(val)) form.boden = form.boden.filter(b => b !== val);
      else form.boden.push(val);
      btn.classList.toggle('sel', form.boden.includes(val));
    };
  });
  // Bezahlung: mehrfach abhakbar
  wrap.querySelectorAll('#bezahlung-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.bezahlung;
      if (form.bezahlung.includes(val)) form.bezahlung = form.bezahlung.filter(b => b !== val);
      else form.bezahlung.push(val);
      btn.classList.toggle('sel', form.bezahlung.includes(val));
    };
  });
  // Umgebung: einfache Auswahl
  wrap.querySelectorAll('#umgebung-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      form.umgebung = form.umgebung === btn.dataset.umgebung ? '' : btn.dataset.umgebung;
      wrap.querySelectorAll('#umgebung-row .choice-btn').forEach(b => b.classList.toggle('sel', b.dataset.umgebung === form.umgebung));
    };
  });
  wrap.querySelectorAll('#mobilfunk-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      form.mobilfunk = form.mobilfunk === btn.dataset.mobilfunk ? '' : btn.dataset.mobilfunk;
      wrap.querySelectorAll('#mobilfunk-row .choice-btn').forEach(b => b.classList.toggle('sel', b.dataset.mobilfunk === form.mobilfunk));
    };
  });
  wrap.querySelectorAll('#wlan-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      form.wlan = form.wlan === btn.dataset.wlan ? '' : btn.dataset.wlan;
      wrap.querySelectorAll('#wlan-row .choice-btn').forEach(b => b.classList.toggle('sel', b.dataset.wlan === form.wlan));
    };
  });
  // Ausstattung: mehrfach abhakbar
  wrap.querySelectorAll('#ausstattung-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      const flag = btn.dataset.flag;
      form[flag] = !form[flag];
      btn.classList.toggle('sel', form[flag]);
    };
  });
  wrap.querySelector('#zeiten-24h-btn').onclick = (btnEvent) => {
    form.zeiten24h = !form.zeiten24h;
    btnEvent.target.classList.toggle('sel', form.zeiten24h);
    wrap.querySelector('#zeiten-row').style.display = form.zeiten24h ? 'none' : '';
  };
  wrap.querySelectorAll('#wetter-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      const val = btn.dataset.wetter;
      if (form.wetter.includes(val)) form.wetter = form.wetter.filter(w => w !== val);
      else form.wetter.push(val);
      btn.classList.toggle('sel', form.wetter.includes(val));
    };
  });
  wrap.querySelectorAll('#star-picker button').forEach(btn => {
    btn.onclick = () => {
      form.bewertung = parseInt(btn.dataset.star);
      wrap.querySelectorAll('#star-picker button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.star) <= form.bewertung));
    };
  });

  wrap.querySelector('#tour-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      ort: fd.get('ort'),
      typ: form.typ,
      datumVon: fd.get('datumVon'),
      datumBis: fd.get('datumBis') || null,
      kosten: fd.get('kosten') || null,
      wetter: form.wetter.join(','),
      bewertung: form.bewertung,
      notizen: fd.get('notizen') || null,
      strom: form.strom,
      boden: form.boden.join(',') || null,
      sanitaer: form.sanitaer,
      bezahlung: form.bezahlung.join(',') || null,
      broetchenservice: form.broetchenservice,
      umgebung: form.umgebung || null,
      nachttemperatur: fd.get('nachttemperatur') || null,
      tagestemperatur: fd.get('tagestemperatur') || null,
      anreiseZeit: (fd.get('anreiseStunde') && fd.get('anreiseMinute')) ? fd.get('anreiseStunde') + ':' + fd.get('anreiseMinute') : null,
      abreiseZeit: (fd.get('abreiseStunde') && fd.get('abreiseMinute')) ? fd.get('abreiseStunde') + ':' + fd.get('abreiseMinute') : null,
      zeiten24h: form.zeiten24h,
      mobilfunk: form.mobilfunk || null,
      wlan: form.wlan || null,
    };
    const errBox = wrap.querySelector('#form-err');
    if (!payload.ort || !payload.ort.trim() || !payload.datumVon) {
      errBox.textContent = 'Bitte mindestens Ort und Datum eintragen.';
      errBox.classList.remove('hidden');
      return;
    }
    const submitBtn = wrap.querySelector('#submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Speichern …';
    try {
      if (isEdit) {
        await api('/api/touren/' + editTour.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        state.view = 'detail';
        state.activeId = editTour.id;
        state.editingId = null;
      } else {
        await api('/api/touren', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        state.view = 'home';
      }
      await loadData();
    } catch (err) {
      errBox.textContent = 'Speichern hat nicht geklappt. Bitte nochmal versuchen.';
      errBox.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? 'Änderungen speichern' : 'Tour speichern';
    }
  };
  return wrap;
}

function renderDetail() {
  const t = state.touren.find(x => x.id === state.activeId);
  const wrap = el('<div></div>');
  if (!t) { wrap.innerHTML = '<p>Nicht gefunden.</p>'; return wrap; }
  wrap.innerHTML = \`
    <div class="top-row">
      <button class="btn-back">\${ICON_BACK}</button>
      <div class="icon-btn-row">
        <button class="icon-btn" id="edit-toggle" title="Bearbeiten">\${ICON_EDIT}</button>
        <button class="icon-btn danger" id="del-toggle" title="Löschen">\${ICON_TRASH}</button>
      </div>
    </div>
    <div id="confirm-slot"></div>
    <div style="display:flex; gap:10px; align-items:flex-start; margin-bottom:4px;">
      <span class="pin-icon" style="margin-top:2px;">\${ICON_PIN}</span>
      <h1 style="font-size:28px; margin:0;">\${escapeHtml(t.ort)}</h1>
    </div>
    <div class="mono" style="margin-left:32px; color: var(--muted); font-size:13px; margin-bottom:22px;">\${escapeHtml(t.typ)} \${t.favorit ? ' · ★ Favorit' : ''}</div>
    <div class="detail-box">
      <div class="detail-row"><span class="detail-label">Datum</span><span>\${fmtDate(t.datum_von)}\${t.datum_bis && t.datum_bis !== t.datum_von ? ' – ' + fmtDate(t.datum_bis) : ''}</span></div>
      \${t.zeiten_24h ? \`<div class="detail-row"><span class="detail-label">Zeiten</span><span>🕐 Rund um die Uhr</span></div>\` : (t.anreise_zeit || t.abreise_zeit) ? \`<div class="detail-row"><span class="detail-label">Zeiten</span><span>\${t.anreise_zeit ? 'An ' + t.anreise_zeit + ' Uhr' : ''}\${t.anreise_zeit && t.abreise_zeit ? ' · ' : ''}\${t.abreise_zeit ? 'Ab ' + t.abreise_zeit + ' Uhr' : ''}</span></div>\` : ''}
      \${t.boden ? \`<div class="detail-row"><span class="detail-label">Boden</span><span>\${escapeHtml(t.boden.split(',').filter(Boolean).join(', '))}</span></div>\` : ''}
      \${t.umgebung ? \`<div class="detail-row"><span class="detail-label">Umgebung</span><span>\${escapeHtml(t.umgebung)}</span></div>\` : ''}
      \${t.mobilfunk ? \`<div class="detail-row"><span class="detail-label">Mobilfunk</span><span>📶 \${escapeHtml(t.mobilfunk)}</span></div>\` : ''}
      \${t.wlan ? \`<div class="detail-row"><span class="detail-label">WLAN</span><span>📡 \${escapeHtml(t.wlan)}</span></div>\` : ''}
      \${t.bezahlung ? \`<div class="detail-row"><span class="detail-label">Bezahlen</span><span>\${escapeHtml(t.bezahlung.split(',').filter(Boolean).join(', '))}</span></div>\` : ''}
      \${t.kosten ? \`<div class="detail-row"><span class="detail-label">Kosten</span><span>\${parseFloat(t.kosten).toFixed(2)} €</span></div>\` : ''}
      <div class="detail-row"><span class="detail-label">Wetter</span><span>\${weatherEmoji(t.wetter)} \${weatherLabel(t.wetter)}</span></div>
      \${t.tagestemperatur != null ? \`<div class="detail-row"><span class="detail-label">Tagestemp.</span><span>☀️ \${t.tagestemperatur}°C</span></div>\` : ''}
      \${t.nachttemperatur != null ? \`<div class="detail-row"><span class="detail-label">Nachttemp.</span><span>🌙 \${t.nachttemperatur}°C</span></div>\` : ''}
      <div class="detail-row"><span class="detail-label">Bewertung</span><span style="color:var(--accent)">\${starsStr(t.bewertung || 0)}</span></div>
      \${(t.strom || t.sanitaer || t.broetchenservice) ? \`<div class="detail-row"><span class="detail-label">Ausstattung</span><span>\${[t.strom ? '⚡ Strom' : '', t.sanitaer ? '🚿 Sanitär' : '', t.broetchenservice ? '🥐 Brötchenservice' : ''].filter(Boolean).join(' · ')}</span></div>\` : ''}
    </div>
    \${t.notizen ? \`<div style="margin-top:20px;"><div class="field-label">Notizen</div><p style="white-space:pre-wrap; line-height:1.6;">\${escapeHtml(t.notizen)}</p></div>\` : ''}
    <div style="display:flex; gap:10px; margin-top:24px; flex-wrap:wrap;">
      <button class="btn-primary" id="fav-toggle-btn" style="flex:1; min-width:180px; background: var(--sky); box-shadow: 3px 3px 0 var(--accent);">\${t.favorit ? '★ Aus Favoriten entfernen' : '☆ Zu Favoriten hinzufügen'}</button>
      <button class="btn-primary" id="maps-btn" style="flex:1; min-width:180px; background: var(--accent); box-shadow: 3px 3px 0 var(--sky); display:flex; align-items:center; justify-content:center; gap:8px;">\${ICON_PIN} Auf Google Maps öffnen</button>
    </div>
  \`;
  wrap.querySelector('.btn-back').onclick = () => { state.view = 'home'; render(); };
  wrap.querySelector('#edit-toggle').onclick = () => { state.editingId = t.id; state.view = 'form'; render(); };
  wrap.querySelector('#fav-toggle-btn').onclick = async () => { await toggleFavorit(t.id); state.view = 'detail'; render(); };
  wrap.querySelector('#maps-btn').onclick = () => openMaps(null, t.ort);
  wrap.querySelector('#del-toggle').onclick = () => {
    const slot = wrap.querySelector('#confirm-slot');
    slot.innerHTML = \`
      <div class="confirm-box">
        <span>Diese Tour wirklich löschen?</span>
        <div style="display:flex; gap:8px;">
          <button class="yes">Löschen</button>
          <button class="no">Abbrechen</button>
        </div>
      </div>
    \`;
    slot.querySelector('.yes').onclick = () => deleteTour(t.id);
    slot.querySelector('.no').onclick = () => { slot.innerHTML = ''; };
  };
  return wrap;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

loadData();
</script>
</body>
</html>`;

const ICON_192_B64 = "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";
const ICON_512_B64 = "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";

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const MANIFEST_JSON = JSON.stringify({
  name: "CamperLog - Unser Tourenbuch",
  short_name: "CamperLog",
  description: "Unser Wohnmobil-Reisetagebuch",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f2e6cc",
  theme_color: "#2f6f9e",
  icons: [
    { src: "/icon-192.jpg", sizes: "192x192", type: "image/jpeg" },
    { src: "/icon-512.jpg", sizes: "512x512", type: "image/jpeg" }
  ]
});

const SERVICE_WORKER_JS = `
const CACHE_NAME = 'camperlog-v2';
const APP_SHELL = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App-Seite und Manifest: IMMER zuerst frisch vom Server laden (network-first),
  // damit Updates sofort ankommen. Nur wenn gar keine Verbindung da ist, zeigen
  // wir die zuletzt gecachte Version (Offline-Fallback).
  if (url.pathname === '/' || url.pathname === '/manifest.json') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Icons ändern sich praktisch nie: cache-first ist hier unproblematisch
  if (url.pathname.startsWith('/icon-')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // API-GET-Anfragen: network-first, mit Cache-Fallback fürs Offline-Anzeigen
  if (url.pathname.startsWith('/api/') ) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
`;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>CamperLog – Anmelden</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f2e6cc; font-family: Georgia, 'Iowan Old Style', serif; padding: 20px; }
  .box { background:#fbf4e6; border:2px solid #2f6f9e; border-radius:16px; padding:32px 28px; max-width:340px; width:100%; box-shadow:4px 4px 0 #2f6f9e; text-align:center; }
  img { width:64px; height:64px; border-radius:999px; object-fit:cover; border:2px solid #2f6f9e; margin-bottom:14px; }
  h1 { font-size:22px; color:#2f6f9e; margin:0 0 20px; }
  input { width:100%; box-sizing:border-box; background:#fbf4e6; border:2px solid rgba(47,111,158,.25); border-radius:8px; padding:12px; font-size:16px; margin-bottom:14px; text-align:center; }
  input:focus { outline:none; border-color:#2f6f9e; }
  button { width:100%; background:#dc9f4e; color:#fbf4e6; font-weight:700; padding:13px; border:none; border-radius:10px; font-size:15px; cursor:pointer; box-shadow:3px 3px 0 #2f6f9e; font-family: inherit; }
  .err { color:#b5482f; font-size:13px; margin-bottom:12px; }
</style>
</head>
<body>
  <div class="box">
    <img src="/icon-192.jpg" alt="CamperLog" />
    <h1>Unser Tourenbuch</h1>
    <form method="POST" action="/login">
      __ERR__
      <input type="password" name="passwort" placeholder="Passwort" autofocus required />
      <button type="submit">Anmelden</button>
    </form>
  </div>
</body>
</html>`;

function checkAuthCookie(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/camperlog_pw=([^;]+)/);
  const pw = env.APP_PASSWORD || "iva2026";
  return match && decodeURIComponent(match[1]) === pw;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pw = env.APP_PASSWORD || "iva2026";

    // Login-Route
    if (url.pathname === "/login" && request.method === "POST") {
      const formData = await request.formData();
      const eingabe = formData.get("passwort");
      if (eingabe === pw) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": `camperlog_pw=${encodeURIComponent(pw)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
          },
        });
      }
      return new Response(LOGIN_HTML.replace("__ERR__", '<div class="err">Falsches Passwort, bitte nochmal versuchen.</div>'), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Icons und Manifest sind ohne Login erreichbar (werden auch vom Homescreen geladen)
    if (url.pathname === "/icon-192.jpg") {
      return new Response(b64ToBytes(ICON_192_B64), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000" } });
    }
    if (url.pathname === "/icon-512.jpg") {
      return new Response(b64ToBytes(ICON_512_B64), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000" } });
    }
    if (url.pathname === "/manifest.json") {
      return new Response(MANIFEST_JSON, { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } });
    }
    if (url.pathname === "/sw.js") {
      return new Response(SERVICE_WORKER_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    }

    // Auth-Check für alles andere
    const authed = checkAuthCookie(request, env);
    if (!authed) {
      if (url.pathname.startsWith("/api/")) {
        return json({ error: "Nicht angemeldet." }, 401);
      }
      return new Response(LOGIN_HTML.replace("__ERR__", ""), { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: e.message || "Serverfehler" }, 500);
      }
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
