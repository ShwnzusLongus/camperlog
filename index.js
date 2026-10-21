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

async function fetchMitTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Legt eine Spalte automatisch an, falls sie noch fehlt (z. B. nach einem
// Feature-Update, bei dem die manuelle Datenbank-Migration noch aussteht).
// Existiert die Spalte schon, schlägt ALTER TABLE erwartungsgemäß fehl –
// das wird hier bewusst ignoriert.
async function ensureSpalte(env, tabelle, spalte, typ) {
  try {
    await env.DB.prepare(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${typ}`).run();
  } catch (e) {
    // Spalte existiert vermutlich bereits – kein Problem.
  }
}

// Foto-Tabellen einmal pro Worker-Instanz anlegen (CREATE ... IF NOT EXISTS
// ist beliebig oft ausführbar; der Merker spart unnötige Datenbankaufrufe).
let fotoTabellenBereit = false;
async function ensureFotoTabellen(env) {
  if (fotoTabellenBereit) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS fotos (tour_id TEXT PRIMARY KEY, mime TEXT, aktualisiert TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS foto_teile (tour_id TEXT NOT NULL, teil INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tour_id, teil))"),
  ]);
  fotoTabellenBereit = true;
}


async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // Selbstreparatur: neue Spalten aus Updates automatisch nachziehen,
  // damit keine manuelle SQL-Konsole nötig ist.
  if (
    (pathname === "/api/touren" && (method === "POST" || method === "PATCH")) ||
    /^\/api\/touren\/[^/]+$/.test(pathname)
  ) {
    await ensureSpalte(env, "touren", "strom_kosten", "TEXT");
  }

  // --- Touren ---
  if (pathname === "/api/touren" && method === "GET") {
    await ensureFotoTabellen(env);
    const { results } = await env.DB.prepare(
      "SELECT t.*, f.aktualisiert AS foto_stand FROM touren t LEFT JOIN fotos f ON f.tour_id = t.id ORDER BY t.datum_von DESC"
    ).all();
    return json(results);
  }

  // --- Titelbild pro Tour ---
  const fotoMatch = pathname.match(/^\/api\/touren\/([^/]+)\/foto$/);
  if (fotoMatch) {
    await ensureFotoTabellen(env);
    const tourId = fotoMatch[1];

    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT data FROM foto_teile WHERE tour_id = ? ORDER BY teil ASC"
      ).bind(tourId).all();
      if (!results || !results.length) return new Response("Kein Foto", { status: 404 });
      const meta = await env.DB.prepare("SELECT mime FROM fotos WHERE tour_id = ?").bind(tourId).first();
      const bytes = b64ToBytes(results.map((r) => r.data).join(""));
      return new Response(bytes, {
        headers: {
          "Content-Type": (meta && meta.mime) || "image/jpeg",
          // Die URL enthält den Änderungsstand (?v=...), daher darf lange gecacht werden
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    }

    if (method === "PUT") {
      const tour = await env.DB.prepare("SELECT id FROM touren WHERE id = ?").bind(tourId).first();
      if (!tour) return json({ error: "Tour nicht gefunden." }, 404);
      const body = await request.json().catch(() => null);
      const daten = body && typeof body.data === "string" ? body.data.replace(/^data:[^,]*,/, "") : "";
      const mime = body && /^image\/(jpeg|png|webp)$/.test(body.mime || "") ? body.mime : "image/jpeg";
      if (!daten || !/^[A-Za-z0-9+/=]+$/.test(daten)) return json({ error: "Ungültiges Bild." }, 400);
      if (daten.length > 2500000) return json({ error: "Das Foto ist zu groß." }, 413);

      // In Stücke teilen, damit kein einzelner Datenbank-Befehl zu groß wird
      const STUECK = 64000;
      const statements = [
        env.DB.prepare("DELETE FROM foto_teile WHERE tour_id = ?").bind(tourId),
      ];
      for (let i = 0, teil = 0; i < daten.length; i += STUECK, teil++) {
        statements.push(
          env.DB.prepare("INSERT INTO foto_teile (tour_id, teil, data) VALUES (?, ?, ?)").bind(tourId, teil, daten.slice(i, i + STUECK))
        );
      }
      const stand = new Date().toISOString();
      statements.push(
        env.DB.prepare("INSERT OR REPLACE INTO fotos (tour_id, mime, aktualisiert) VALUES (?, ?, ?)").bind(tourId, mime, stand)
      );
      await env.DB.batch(statements);
      return json({ ok: true, foto_stand: stand });
    }

    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM foto_teile WHERE tour_id = ?").bind(tourId),
        env.DB.prepare("DELETE FROM fotos WHERE tour_id = ?").bind(tourId),
      ]);
      return json({ ok: true });
    }
  }

  if (pathname === "/api/touren" && method === "POST") {
    const body = await request.json();
    if (!body.ort || !body.datumVon) {
      return json({ error: "Ort und Datum sind erforderlich." }, 400);
    }
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO touren (id, ort, typ, datum_von, datum_bis, kosten, wetter, bewertung, notizen, favorit, strom, boden, sanitaer, bezahlung, broetchenservice, umgebung, nachttemperatur, tagestemperatur, anreise_zeit, abreise_zeit, zeiten_24h, mobilfunk, wlan, strom_kosten)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.ort.trim(),
        body.typ || "Stellplatz",
        body.datumVon,
        body.datumBis || null,
        body.kosten !== undefined && body.kosten !== null && body.kosten !== "" ? parseFloat(body.kosten) : null,
        body.wetter || "sonnig",
        body.bewertung ? parseInt(body.bewertung) : null,
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
        body.stromKosten || null
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
      `UPDATE touren SET ort = ?, typ = ?, datum_von = ?, datum_bis = ?, kosten = ?, wetter = ?, bewertung = ?, notizen = ?, strom = ?, boden = ?, sanitaer = ?, bezahlung = ?, broetchenservice = ?, umgebung = ?, nachttemperatur = ?, tagestemperatur = ?, anreise_zeit = ?, abreise_zeit = ?, zeiten_24h = ?, mobilfunk = ?, wlan = ?, strom_kosten = ?
       WHERE id = ?`
    )
      .bind(
        body.ort.trim(),
        body.typ || "Stellplatz",
        body.datumVon,
        body.datumBis || null,
        body.kosten !== undefined && body.kosten !== null && body.kosten !== "" ? parseFloat(body.kosten) : null,
        body.wetter || "sonnig",
        body.bewertung ? parseInt(body.bewertung) : null,
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
        body.stromKosten || null,
        id
      )
      .run();
    return json({ ok: true });
  }
  if (tourMatch && method === "DELETE") {
    await ensureFotoTabellen(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM touren WHERE id = ?").bind(tourMatch[1]),
      env.DB.prepare("DELETE FROM foto_teile WHERE tour_id = ?").bind(tourMatch[1]),
      env.DB.prepare("DELETE FROM fotos WHERE tour_id = ?").bind(tourMatch[1]),
    ]);
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
      async function nominatimSuche(query) {
        const res = await fetchMitTimeout(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=20&extratags=1&namedetails=1`,
          { headers: { "User-Agent": "CamperLog/1.0 (privates Reisetagebuch)" } },
          8000
        );
        if (!res.ok) return { fehler: "überlastet" };
        const data = await res.json().catch(() => null);
        if (!data) return { fehler: "antwort" };
        return { daten: data };
      }

      // 1) Direkte Namenssuche: passt einer der Treffer selbst zu einem
      //    Camping- oder Stellplatz, brauchen wir keine Stadt/Region dazu.
      let erg;
      try {
        erg = await nominatimSuche(q);
      } catch (e) {
        return json({ results: [], message: "Die Ortssuche antwortet gerade nicht. Bitte gleich nochmal versuchen." });
      }
      if (erg.fehler === "überlastet") {
        return json({ results: [], message: "Die Ortssuche ist gerade überlastet. Bitte gleich nochmal versuchen." });
      }
      if (erg.fehler === "antwort") {
        return json({ results: [], message: "Die Ortssuche hat eine unerwartete Antwort geliefert. Bitte nochmal versuchen." });
      }
      let geoAlle = erg.daten;

      const PLATZ_TYPEN_OSM = ["camp_site", "caravan_site"];
      const treffersuche = (liste) => (liste || []).filter((r) => r.class === "tourism" && PLATZ_TYPEN_OSM.includes(r.type));
      let namensTreffer = treffersuche(geoAlle);

      // 1b) Nichts gefunden? Der Suchbegriff enthält evtl. einen Zusatz wie
      //     "Womo Park" vor dem eigentlichen Ortsnamen. Wir probieren
      //     automatisch kürzere Varianten (die letzten 1-2 Wörter), bevor
      //     wir aufgeben.
      const woerter = q.trim().split(/\s+/);
      if ((!geoAlle || geoAlle.length === 0) && woerter.length > 1) {
        for (const anzahl of [2, 1]) {
          if (woerter.length <= anzahl) continue;
          const kurzerBegriff = woerter.slice(-anzahl).join(" ");
          try {
            const zweiterVersuch = await nominatimSuche(kurzerBegriff);
            if (zweiterVersuch.daten && zweiterVersuch.daten.length > 0) {
              geoAlle = zweiterVersuch.daten;
              namensTreffer = treffersuche(geoAlle);
              break;
            }
          } catch (e) {
            // nächste kürzere Variante probieren
          }
        }
      }

      if (namensTreffer.length > 0) {
        const results = namensTreffer
          .map((r) => ({
            name: (r.namedetails && r.namedetails.name) || (r.display_name || "").split(",")[0],
            typ: r.type === "caravan_site" ? "Stellplatz" : "Campingplatz",
            lat: parseFloat(r.lat),
            lon: parseFloat(r.lon),
            distanzKm: null,
            adresse: (r.display_name || "").split(",").slice(1, 3).join(",").trim(),
            website: (r.extratags && (r.extratags.website || r.extratags["contact:website"])) || null,
            telefon: (r.extratags && (r.extratags.phone || r.extratags["contact:phone"])) || null,
          }))
          .slice(0, 20);
        return json({ results, modus: "name" });
      }

      // 2) Kein direkter Namenstreffer: q (bzw. die kürzere Variante) als
      //    Ort/Region behandeln und im Umkreis nach Camping-/Stellplätzen
      //    suchen (bisheriges Verhalten).
      const geo = geoAlle;
      if (!geo || !geo.length) {
        return json({
          results: [],
          message:
            "Nichts gefunden. Versuch's mit dem genauen Platznamen oder einer Stadt in der Nähe – nicht jeder private Stellplatz ist bei OpenStreetMap verzeichnet.",
        });
      }
      const lat = parseFloat(geo[0].lat);
      const lon = parseFloat(geo[0].lon);
      const radius = 20000; // 20 km
      const overpassQuery = `[out:json][timeout:25];(node["tourism"~"^(camp_site|caravan_site)$"](around:${radius},${lat},${lon});way["tourism"~"^(camp_site|caravan_site)$"](around:${radius},${lat},${lon}););out center 25;`;

      // Mehrere Overpass-Server probieren, falls der erste überlastet ist
      const overpassServer = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.openstreetmap.ru/api/interpreter",
      ];
      let opRes = null;
      for (const server of overpassServer) {
        try {
          const res = await fetchMitTimeout(
            server,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "CamperLog/1.0" },
              body: "data=" + encodeURIComponent(overpassQuery),
            },
            12000
          );
          if (res.ok) {
            opRes = res;
            break;
          }
        } catch (e) {
          // nächsten Server probieren
        }
      }
      if (!opRes) {
        return json({ results: [], message: "Die Kartensuche ist gerade überlastet. Bitte in ein paar Minuten nochmal versuchen." });
      }
      const opData = await opRes.json().catch(() => null);
      if (!opData) {
        return json({ results: [], message: "Die Kartensuche hat eine unerwartete Antwort geliefert. Bitte nochmal versuchen." });
      }
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
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background: linear-gradient(rgba(242,230,204,.74), rgba(242,230,204,.74)), url(/hintergrund-1.jpg) center / cover no-repeat;
  }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: Georgia, 'Iowan Old Style', serif;
  }
  .mono { font-family: 'Courier New', ui-monospace, monospace; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 0 20px 110px; }
  h1 { font-size: 34px; line-height: 1.15; color: var(--sky); margin: 0 0 6px; }
  /* Texte, die direkt auf dem Hintergrundbild stehen: heller Schein für bessere Lesbarkeit */
  h1, h2, .eyebrow, .count { text-shadow: 0 0 3px rgba(242,230,204,.95), 0 0 9px rgba(242,230,204,.9), 0 0 18px rgba(242,230,204,.85); }
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
    background: var(--card); border: 2px solid rgba(181,72,47,.4);
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
    font-family: 'Courier New', monospace; font-size: 10px; font-weight: 700;
    text-transform: uppercase; line-height: 1.15;
    animation: stampIn .5s cubic-bezier(.2,1.4,.4,1) both;
    background: var(--card);
  }
  @keyframes stampIn { from { transform: scale(1.4) rotate(-8deg); opacity: 0; } to { transform: scale(1) rotate(-4deg); opacity: 1; } }
  .stats { display: grid; grid-template-columns: repeat(3,1fr); }
  .stats > div { text-align: center; padding: 0 4px; border-left: 1px solid var(--sky-soft); }
  .stats > div:first-child { border-left: none; }
  .stat-val { font-size: 28px; font-weight: 700; color: var(--accent); display: block; }
  .stat-label { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .temp-row {
    display: flex; justify-content: center; gap: 20px; margin-top: 16px; padding-top: 14px;
    border-top: 1px solid var(--sky-soft); font-family: 'Courier New', monospace;
    font-size: 14px; color: var(--ink); font-weight: 700;
  }
  @media (max-width: 380px) {
    .stat-val { font-size: 22px; }
    .stamp { width: 58px; height: 58px; font-size: 9px; right: 12px; }
    .stampcard { padding-top: 46px; }
    .temp-row { gap: 12px; font-size: 13px; }
  }

  .section-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 14px; }
  .section-head h2 { font-size: 20px; color: var(--sky); margin: 0; }
  .count { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: var(--muted); }

  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  .tab-btn {
    flex: 1 1 calc(50% - 4px); min-width: 90px; padding: 10px 6px; border-radius: 10px; border: 2px solid var(--sky-soft);
    background: var(--card); color: var(--sky); font-family: 'Courier New', monospace; font-weight: 700;
    font-size: 13px; text-transform: uppercase; letter-spacing: .02em; cursor: pointer;
  }
  .tab-btn.active { background: var(--sky); border-color: var(--sky); color: var(--paper); }

  .empty {
    border: 2px dashed var(--sky-soft); border-radius: 12px; padding: 28px;
    text-align: center; color: var(--ink); font-size: 15px;
  }
  .year-head {
    font-family: 'Courier New', monospace; font-weight: 700; font-size: 15px;
    text-transform: uppercase; letter-spacing: .15em; color: var(--sky);
    margin: 22px 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--sky-soft);
  }
  .year-head:first-child { margin-top: 0; }

  .filter-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .filter-select {
    background: var(--card); border: 2px solid var(--sky-soft); border-radius: 8px;
    padding: 9px 10px; font-size: 14px; font-weight: 700; color: var(--sky); font-family: 'Courier New', monospace;
    flex: 1; min-width: 130px;
  }
  .filter-toggle {
    background: var(--card); border: 2px solid var(--sky-soft); border-radius: 8px;
    padding: 9px 12px; font-size: 14px; font-weight: 700; color: var(--sky); font-family: 'Courier New', monospace;
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
  .card-title { font-weight: 700; color: var(--sky); white-space: normal; overflow-wrap: anywhere; line-height: 1.25; }
  .card-meta { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: var(--muted); margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
  .card-bottom { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 4px 10px; }
  .card-bottom .card-meta { flex: 1 1 auto; min-width: 0; }
  .card-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; margin-top: 4px; }
  .fav-star { font-size: 18px; cursor: pointer; flex-shrink: 0; background: none; border: none; padding: 4px; line-height: 1; }
  .stars { color: var(--accent); font-size: 14px; letter-spacing: 1px; flex-shrink: 0; }

  /* FAB entfernt zugunsten des Hinzufügen-Buttons oben im Hero */

  label.field { display: block; margin-bottom: 16px; }
  .field-label { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: block; margin-bottom: 7px; }
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
    background: var(--card); color: var(--sky); font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit;
  }
  .choice-btn.sel { background: var(--sky); border-color: var(--sky); color: var(--paper); }
  .weather-btn { flex-direction: column; display: flex; align-items: center; gap: 4px; flex: none; width: 78px; }
  .signal-btn { flex: 1 1 auto; min-width: 74px; padding: 10px 8px; font-size: 13px; }
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
  .detail-label { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); width: 104px; flex-shrink: 0; }
  .confirm-box { border: 2px solid var(--danger); background: #f6e8e0; border-radius: 10px; padding: 14px; margin-bottom: 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .confirm-box button { border-radius: 6px; padding: 8px 13px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1px solid var(--danger); font-family: inherit; }
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
  .result-meta { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: var(--muted); margin-top: 4px; }
  .add-todrive-btn {
    background: var(--accent); color: var(--card); border: none; border-radius: 999px;
    width: 34px; height: 34px; font-size: 18px; cursor: pointer; flex-shrink: 0; line-height: 1;
  }
  .add-todrive-btn:disabled { opacity: .5; }
  .search-msg { color: var(--ink); font-size: 15px; text-align: center; padding: 18px; }
  .hidden { display: none !important; }
  .vorlage-hinweis {
    background: rgba(47,111,158,.1); border: 1px solid var(--sky-soft); border-radius: 10px;
    padding: 10px 12px; font-size: 14px; color: var(--ink); margin: -6px 0 18px; line-height: 1.45;
  }
  .card-thumb {
    width: 48px; height: 48px; border-radius: 10px; object-fit: cover; flex-shrink: 0;
    border: 2px solid var(--sky-soft); background: var(--sky-soft);
  }
  .detail-foto {
    width: 100%; max-height: 420px; object-fit: cover; border-radius: 14px;
    border: 2px solid var(--sky-soft); margin-bottom: 18px; display: block; background: var(--sky-soft);
  }
  .foto-feld { display: flex; flex-direction: column; gap: 10px; }
  .foto-vorschau { width: 100%; max-height: 300px; object-fit: contain; border-radius: 12px; border: 2px solid var(--sky-soft); background: var(--sky-soft); }
  .crop-overlay {
    position: fixed; inset: 0; z-index: 1000; background: #14202b; color: #fff;
    display: flex; flex-direction: column; gap: 10px; padding: 14px 16px calc(14px + env(safe-area-inset-bottom));
  }
  .crop-head { font-weight: 700; font-size: 18px; text-align: center; }
  .crop-ratios { display: flex; gap: 8px; justify-content: center; }
  .crop-ratio {
    background: transparent; color: #fff; border: 2px solid rgba(255,255,255,.35); border-radius: 8px;
    padding: 8px 14px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit;
  }
  .crop-ratio.sel { background: #fff; color: #14202b; border-color: #fff; }
  .crop-stage { flex: 1; min-height: 0; position: relative; overflow: hidden; touch-action: none; cursor: grab; border-radius: 10px; }
  .crop-img { position: absolute; max-width: none; user-select: none; -webkit-user-drag: none; pointer-events: none; transform-origin: center center; }
  .crop-frame {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    border: 2px solid #fff; border-radius: 4px; box-shadow: 0 0 0 9999px rgba(0,0,0,.6); pointer-events: none;
  }
  .crop-hint { text-align: center; font-size: 13px; opacity: .75; }
  .crop-zoom { width: 100%; }
  .crop-actions { display: flex; gap: 10px; }
  .crop-actions .filter-toggle { flex: 0 0 auto; padding: 0 18px; }
  .crop-actions .btn-primary { flex: 1; width: auto; }
  .foto-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  .foto-waehlen { display: inline-flex; align-items: center; }
  .foto-status { font-size: 14px; color: var(--muted); font-weight: 600; }
  .sicherung-card { background: var(--card); border: 2px dashed var(--sky-soft); border-radius: 14px; padding: 18px; margin-top: 22px; }
  .sicherung-text { font-size: 14px; color: var(--ink); line-height: 1.5; margin: 0 0 14px; }
  .sicherung-buttons { display: flex; gap: 10px; }
  .sicherung-buttons .btn-primary { flex: 1; padding: 12px; font-size: 15px; }
  .toast {
    position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px);
    background: var(--ink); color: var(--paper); padding: 12px 18px; border-radius: 10px;
    font-size: 14px; font-weight: 600; max-width: calc(100% - 32px); text-align: center;
    opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; z-index: 50;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }

  .badge-card {
    display: flex; align-items: center; gap: 14px;
    background: linear-gradient(135deg, rgba(220,159,78,.18), rgba(47,111,158,.1));
    border: 2px solid var(--accent); border-radius: 14px; padding: 16px 18px; margin-bottom: 18px;
  }
  .badge-icon { font-size: 32px; flex-shrink: 0; }
  .badge-title { font-weight: 700; color: var(--sky); font-size: 15px; }
  .badge-sub { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: var(--muted); margin-top: 3px; }

  .chart-card { background: var(--card); border: 2px solid var(--sky-soft); border-radius: 14px; padding: 18px; margin-bottom: 18px; }
  .chart-bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .chart-bar-row:last-child { margin-bottom: 0; }
  .chart-bar-label { font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: var(--muted); width: 44px; flex-shrink: 0; }
  .chart-bar-track { flex: 1; height: 14px; background: var(--sky-soft); border-radius: 999px; overflow: hidden; }
  .chart-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width .4s ease; }
  .chart-bar-value { font-family: 'Courier New', monospace; font-size: 13px; color: var(--sky); font-weight: 700; width: 60px; text-align: right; flex-shrink: 0; }

  .year-card { background: var(--card); border: 2px solid var(--sky-soft); border-radius: 14px; padding: 18px; margin-bottom: 14px; }
  .year-card-head { font-family: 'Courier New', monospace; font-weight: 700; font-size: 14px; color: var(--sky); text-transform: uppercase; letter-spacing: .1em; margin-bottom: 12px; }
  .year-card-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 6px; }
  .year-card-grid > div { text-align: center; }
  .ycg-val { display: block; font-weight: 700; font-size: 18px; color: var(--accent); }
  .ycg-label { font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
  .year-card-fav { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--sky-soft); font-size: 14px; font-weight: 600; color: var(--ink); }

  .stat-card { background: var(--card); border: 2px solid var(--sky-soft); border-radius: 14px; padding: 18px; margin-bottom: 18px; }
  .stat-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; }
  .stat-controls .filter-select { flex: 1 1 140px; min-width: 0; }
  .stat-print { flex: 1 1 100%; width: auto; padding: 12px; font-size: 15px; }
  .stat-report { color: var(--ink); font-family: Georgia, 'Iowan Old Style', serif; }
  .stat-report * { text-shadow: none; }
  .sr-title { font-size: 20px; font-weight: 700; color: var(--sky); }
  .sr-sub { font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: var(--muted); margin: 2px 0 14px; }
  .sr-tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 14px; }
  .sr-tile { border: 1px solid var(--sky-soft); border-radius: 10px; padding: 8px 6px; text-align: center; }
  .sr-val { display: block; font-weight: 700; font-size: 18px; color: var(--accent); }
  .sr-lab { font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--muted); }
  .sr-list { margin: 0 0 14px; padding-left: 18px; font-size: 14px; line-height: 1.5; }
  .sr-h { font-family: 'Courier New', monospace; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .1em; color: var(--sky); margin: 16px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--sky-soft); }
  .sr-scroll { overflow-x: auto; }
  .sr-table { border-collapse: collapse; width: 100%; font-size: 13px; line-height: 1.35; }
  .sr-table th, .sr-table td { border: 1px solid var(--sky-soft); padding: 5px 7px; text-align: left; vertical-align: top; }
  .sr-table thead th { background: rgba(47,111,158,.12); }
  .sr-small th { width: 110px; background: rgba(47,111,158,.08); }
  .sr-touren { min-width: 760px; }
  .sr-table .nw { white-space: nowrap; }
  #print-area { display: none; }
  @media (min-width: 560px) { .sr-tiles { grid-template-columns: repeat(5, 1fr); } }
  @page { size: A4 landscape; margin: 12mm; }
  @media print {
    html, body.printing { background: #fff !important; }
    body.printing::before { display: none !important; }
    body.printing > *:not(#print-area) { display: none !important; }
    body.printing #print-area { display: block; }
    body.printing .stat-report { color: #000; font-size: 11pt; }
    body.printing .sr-title { font-size: 20pt; color: #1d4f75; }
    body.printing .sr-tiles { grid-template-columns: repeat(5, 1fr); }
    body.printing .sr-tile, body.printing .sr-table th, body.printing .sr-table td { border-color: #999; }
    body.printing .sr-scroll { overflow: visible; }
    body.printing .sr-touren { min-width: 0; font-size: 9.5pt; }
    body.printing .sr-table tr { break-inside: avoid; }
    body.printing .sr-h { break-after: avoid; }
    body.printing { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
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
const UMGEBUNG_TYPEN = ['Natur', 'Stadt', 'Therme'];
// Umgebung ist mehrfach wählbar (kommagetrennt gespeichert). Alter Wert "Beides" = Natur + Stadt.
function umgebungListe(wert) {
  const liste = [];
  (wert || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => {
    (x === 'Beides' ? ['Natur', 'Stadt'] : [x]).forEach(y => { if (!liste.includes(y)) liste.push(y); });
  });
  return liste;
}
const SIGNAL_STUFEN = ['Kein Empfang', 'Schwach', 'Mittel', 'Gut', 'Stark'];
const STROM_KOSTEN_TYPEN = ['Inbegriffen', 'Kostenpflichtig'];

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
  vorlageId: null,
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
  statModus: 'monat', // monat | jahr
  statPeriode: '',
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
// Alle bisher verwendeten Platznamen (Touren + ToDrive), häufigste zuerst
function bekannteOrte() {
  const zaehler = new Map();
  [...state.touren.map(t => t.ort), ...state.favoriten.map(f => f.ort)].forEach(o => {
    if (!o || !o.trim()) return;
    const key = o.trim().toLowerCase();
    const e = zaehler.get(key) || { name: o.trim(), n: 0 };
    e.n++;
    zaehler.set(key, e);
  });
  return [...zaehler.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'de')).map(e => e.name);
}
function fotoUrl(t) {
  return '/api/touren/' + encodeURIComponent(t.id) + '/foto?v=' + encodeURIComponent(t.foto_stand || '');
}
function tourIconHtml(t) {
  if (t.foto_stand) return '<img class="card-thumb" src="' + fotoUrl(t) + '" alt="" loading="lazy" />';
  return '<div class="icon-circle">' + weatherEmoji((t.wetter || '').split(',')[0]) + '</div>';
}
// Bildausschnitt wählen: Bild mit dem Finger verschieben und zoomen (zwei Finger, Mausrad oder Regler),
// der Rahmen hat das gewählte Seitenverhältnis. Das Ergebnis wird gleich verkleinert (schneller, spart Speicher).
// Liefert eine JPEG-Data-URL, oder null wenn abgebrochen wurde.
function bildZuschneiden(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
    img.onload = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const ov = document.createElement('div');
      ov.className = 'crop-overlay';
      ov.innerHTML =
        '<div class="crop-head">Ausschnitt wählen</div>' +
        '<div class="crop-ratios">' +
          '<button type="button" class="crop-ratio sel" data-r="1.3333333">4:3</button>' +
          '<button type="button" class="crop-ratio" data-r="1.7777778">16:9</button>' +
          '<button type="button" class="crop-ratio" data-r="1">Quadrat</button>' +
        '</div>' +
        '<div class="crop-stage"><img class="crop-img" alt="" /><div class="crop-frame"></div></div>' +
        '<div class="crop-hint">Bild verschieben und mit zwei Fingern zoomen</div>' +
        '<input type="range" class="crop-zoom" min="0" max="100" value="0" aria-label="Zoom" />' +
        '<div class="crop-actions">' +
          '<button type="button" class="filter-toggle crop-cancel">Abbrechen</button>' +
          '<button type="button" class="btn-primary crop-ok">Übernehmen</button>' +
        '</div>';
      const stage = ov.querySelector('.crop-stage');
      const im = ov.querySelector('.crop-img');
      const frame = ov.querySelector('.crop-frame');
      const zoom = ov.querySelector('.crop-zoom');
      im.src = src;
      im.style.width = iw + 'px';
      im.style.height = ih + 'px';
      document.body.appendChild(ov);

      let ratio = 4 / 3, fw = 0, fh = 0, minS = 1, s = 1, tx = 0, ty = 0;
      function apply() {
        s = Math.max(minS, Math.min(minS * 5, s));
        const mx = Math.max(0, (iw * s - fw) / 2);
        const my = Math.max(0, (ih * s - fh) / 2);
        tx = Math.max(-mx, Math.min(mx, tx));
        ty = Math.max(-my, Math.min(my, ty));
        im.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
        zoom.value = Math.round((s / minS - 1) / 4 * 100);
      }
      function layout(behalten) {
        const sw = stage.clientWidth, sh = stage.clientHeight;
        fw = Math.min(sw - 32, (sh - 32) * ratio);
        fh = fw / ratio;
        frame.style.width = fw + 'px';
        frame.style.height = fh + 'px';
        im.style.left = (sw / 2 - iw / 2) + 'px';
        im.style.top = (sh / 2 - ih / 2) + 'px';
        minS = Math.max(fw / iw, fh / ih);
        if (!behalten || s < minS) s = minS;
        apply();
      }
      const beiResize = () => layout(true);
      window.addEventListener('resize', beiResize);
      layout(false);

      ov.querySelectorAll('.crop-ratio').forEach(btn => {
        btn.onclick = () => {
          ratio = Number(btn.dataset.r);
          ov.querySelectorAll('.crop-ratio').forEach(b => b.classList.toggle('sel', b === btn));
          layout(true);
        };
      });

      // Verschieben (ein Finger) und Zoomen (zwei Finger)
      const zeiger = new Map();
      stage.addEventListener('pointerdown', e => {
        stage.setPointerCapture(e.pointerId);
        zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY });
      });
      stage.addEventListener('pointermove', e => {
        const alt = zeiger.get(e.pointerId);
        if (!alt) return;
        const neu = { x: e.clientX, y: e.clientY };
        if (zeiger.size === 1) {
          tx += neu.x - alt.x;
          ty += neu.y - alt.y;
        } else if (zeiger.size === 2) {
          let andere = null;
          zeiger.forEach((p, id) => { if (id !== e.pointerId) andere = p; });
          const dAlt = Math.hypot(alt.x - andere.x, alt.y - andere.y);
          const dNeu = Math.hypot(neu.x - andere.x, neu.y - andere.y);
          if (dAlt > 0) {
            const f = dNeu / dAlt;
            s *= f; tx *= f; ty *= f;
          }
          tx += (neu.x - alt.x) / 2;
          ty += (neu.y - alt.y) / 2;
        }
        zeiger.set(e.pointerId, neu);
        apply();
      });
      const zeigerEnde = e => { zeiger.delete(e.pointerId); };
      stage.addEventListener('pointerup', zeigerEnde);
      stage.addEventListener('pointercancel', zeigerEnde);
      stage.addEventListener('wheel', e => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        s *= f; tx *= f; ty *= f;
        apply();
      }, { passive: false });
      zoom.oninput = () => {
        const alt = s;
        s = minS * (1 + Number(zoom.value) / 100 * 4);
        const f = s / alt;
        tx *= f; ty *= f;
        apply();
      };

      function schliessen(ergebnis) {
        window.removeEventListener('resize', beiResize);
        ov.remove();
        resolve(ergebnis);
      }
      ov.querySelector('.crop-cancel').onclick = () => schliessen(null);
      ov.querySelector('.crop-ok').onclick = () => {
        // Bereich des Originalbilds, der im Rahmen liegt
        const sw = fw / s, sh = fh / s;
        const sx = Math.max(0, Math.min(iw - sw, iw / 2 - tx / s - sw / 2));
        const sy = Math.max(0, Math.min(ih - sh, ih / 2 - ty / s - sh / 2));
        const versuch = (maxBreite, qualitaet) => {
          const w = Math.round(Math.min(maxBreite, sw));
          const h = Math.round(w * sh / sw);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
          return canvas.toDataURL('image/jpeg', qualitaet);
        };
        let daten = versuch(1280, 0.72);
        if (daten.length > 900000) daten = versuch(1000, 0.6);
        if (daten.length > 900000) daten = versuch(800, 0.5);
        schliessen(daten);
      };
    };
    img.src = src;
  });
}
// Gleicher Platz, nur anders geschrieben (Groß/klein, Leerzeichen)? Dann bekannte Schreibweise nehmen
function vereinheitlicheOrt(eingabe) {
  const key = (eingabe || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const treffer = state.touren.find(t => (t.ort || '').trim().replace(/\\s+/g, ' ').toLowerCase() === key);
  return treffer ? treffer.ort : (eingabe || '').trim().replace(/\\s+/g, ' ');
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
  else if (result.adresse) notizTeile.push(result.adresse);
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
    const vorlage = !editTour && state.vorlageId ? state.touren.find(x => x.id === state.vorlageId) : null;
    app.appendChild(renderForm(editTour, vorlage));
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
          <h1>Unterwegs<br/>mit Iva</h1>
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
  wrap.querySelector('#add-top-btn').onclick = () => { state.editingId = null; state.vorlageId = null; state.view = 'form'; state.error = ''; render(); };
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
      \${tourIconHtml(t)}
      <div class="card-body">
        <div class="card-title">\${escapeHtml(t.ort)}</div>
        <div class="card-bottom">
          <div class="card-meta"><span>\${fmtDate(t.datum_von)}</span><span>·</span><span>\${escapeHtml(t.typ)}</span>\${t.strom ? '<span>⚡</span>' : ''}\${t.sanitaer ? '<span>🚿</span>' : ''}\${t.broetchenservice ? '<span>🥐</span>' : ''}</div>
          <div class="card-actions">
            <div class="stars">\${starsStr(t.bewertung || 0)}</div>
            <button class="fav-star">\${t.favorit ? '★' : '☆'}</button>
          </div>
        </div>
      </div>
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
        <option value="Therme">Therme</option>
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
  if (state.tourenFilterUmgebung) list = list.filter(t => umgebungListe(t.umgebung).includes(state.tourenFilterUmgebung));
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
        \${tourIconHtml(t)}
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

// ---- Statistik (monatlich / jährlich) mit Druckfunktion ----
const MONATSNAMEN = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
function fmtEuro(n) { return Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function fmtZahl(n, stellen) { return Number(n).toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen }); }
function statPerioden(modus) {
  const set = new Set();
  state.touren.forEach(t => { if (t.datum_von) set.add(t.datum_von.slice(0, modus === 'jahr' ? 4 : 7)); });
  return [...set].sort((a, b) => b.localeCompare(a));
}
function statPeriodeLabel(modus, p) {
  if (modus === 'jahr') return p;
  return MONATSNAMEN[parseInt(p.slice(5, 7), 10) - 1] + ' ' + p.slice(0, 4);
}
function statVerteilung(touren, fn) {
  const z = {};
  touren.forEach(t => { fn(t).forEach(k => { z[k] = (z[k] || 0) + 1; }); });
  return Object.entries(z).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).map(e => e[0] + ' ' + e[1] + '×').join(' · ');
}
function statistikBerichtHtml(modus, periode) {
  const label = statPeriodeLabel(modus, periode);
  const touren = state.touren
    .filter(t => t.datum_von && t.datum_von.slice(0, modus === 'jahr' ? 4 : 7) === periode)
    .sort((a, b) => a.datum_von.localeCompare(b.datum_von));
  const kopf = '<div class="sr-head"><div class="sr-title">Unterwegs mit Iva – Statistik ' + escapeHtml(label) + '</div>' +
    '<div class="sr-sub">' + (modus === 'jahr' ? 'Jahresstatistik' : 'Monatsstatistik') + ' · erstellt am ' + new Date().toLocaleDateString('de-DE') + '</div></div>';
  if (!touren.length) return kopf + '<div class="empty">Keine Touren in diesem Zeitraum.</div>';

  const num = v => v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v));
  const mittel = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const naechte = touren.reduce((s, t) => s + exportNaechte(t), 0);
  const kosten = touren.reduce((s, t) => s + (parseFloat(t.kosten) || 0), 0);
  const plaetze = new Set(touren.map(t => t.ort.trim().toLowerCase())).size;
  const bew = touren.map(t => t.bewertung).filter(b => b);
  const avgBew = mittel(bew);
  const tage = touren.map(t => t.tagestemperatur).filter(num).map(parseFloat);
  const nachts = touren.map(t => t.nachttemperatur).filter(num).map(parseFloat);
  const avgTag = mittel(tage), avgNacht = mittel(nachts);

  const kachel = (wert, name) => '<div class="sr-tile"><span class="sr-val">' + wert + '</span><span class="sr-lab">' + name + '</span></div>';
  let html = kopf + '<div class="sr-tiles">' +
    kachel(touren.length, 'Touren') +
    kachel(naechte, 'Nächte') +
    kachel(plaetze, 'Verschiedene Plätze') +
    kachel(fmtEuro(kosten), 'Kosten gesamt') +
    kachel(naechte ? fmtEuro(kosten / naechte) : '–', 'Ø Kosten / Nacht') +
    kachel(avgBew !== null ? fmtZahl(avgBew, 1) + ' ★' : '–', 'Ø Bewertung' + (bew.length ? ' (' + bew.length + ' bewertet)' : '')) +
    kachel(avgTag !== null ? fmtZahl(avgTag, 1) + ' °C' : '–', 'Ø Tagestemp.') +
    kachel(avgNacht !== null ? fmtZahl(avgNacht, 1) + ' °C' : '–', 'Ø Nachttemp.') +
    (nachts.length ? kachel(fmtZahl(Math.min.apply(null, nachts), 1) + ' °C', 'Kälteste Nacht') : '') +
    (tage.length ? kachel(fmtZahl(Math.max.apply(null, tage), 1) + ' °C', 'Wärmster Tag') : '') +
    '</div>';

  // Highlights
  const ortZ = {};
  touren.forEach(t => { const k = t.ort.trim(); ortZ[k] = (ortZ[k] || 0) + 1; });
  const topOrt = Object.entries(ortZ).sort((a, b) => b[1] - a[1])[0];
  const beste = touren.filter(t => t.bewertung).sort((a, b) => b.bewertung - a.bewertung)[0];
  const teuerster = touren.filter(t => parseFloat(t.kosten) > 0).sort((a, b) => parseFloat(b.kosten) - parseFloat(a.kosten))[0];
  const hl = [];
  if (topOrt && topOrt[1] > 1) hl.push('<li><b>Lieblingsplatz:</b> ' + escapeHtml(topOrt[0]) + ' (' + topOrt[1] + '× besucht)</li>');
  if (beste) hl.push('<li><b>Bestbewertet:</b> ' + escapeHtml(beste.ort) + ' (' + starsStr(beste.bewertung) + ')</li>');
  if (teuerster) hl.push('<li><b>Teuerste Tour:</b> ' + escapeHtml(teuerster.ort) + ' (' + fmtEuro(teuerster.kosten) + ')</li>');
  if (hl.length) html += '<ul class="sr-list">' + hl.join('') + '</ul>';

  // Verteilungen
  const ausst = [];
  const anz = fn => touren.filter(fn).length;
  if (anz(t => t.strom)) ausst.push('Strom ' + anz(t => t.strom) + '×');
  if (anz(t => t.sanitaer)) ausst.push('Sanitär ' + anz(t => t.sanitaer) + '×');
  if (anz(t => t.broetchenservice)) ausst.push('Brötchenservice ' + anz(t => t.broetchenservice) + '×');
  if (anz(t => t.favorit)) ausst.push('Favoriten ' + anz(t => t.favorit) + '×');
  const verteil = [
    ['Platzart', statVerteilung(touren, t => [t.typ].filter(Boolean))],
    ['Umgebung', statVerteilung(touren, t => umgebungListe(t.umgebung))],
    ['Wetter', statVerteilung(touren, t => (t.wetter || '').split(',').filter(Boolean).map(k => weatherLabel(k)))],
    ['Ausstattung', ausst.join(' · ')],
    ['Boden', statVerteilung(touren, t => (t.boden || '').split(',').filter(Boolean))],
    ['Bezahlung', statVerteilung(touren, t => (t.bezahlung || '').split(',').filter(Boolean))],
  ].filter(v => v[1]);
  if (verteil.length) {
    html += '<div class="sr-h">Verteilung</div><table class="sr-table sr-small"><tbody>' +
      verteil.map(v => '<tr><th>' + v[0] + '</th><td>' + escapeHtml(v[1]) + '</td></tr>').join('') + '</tbody></table>';
  }

  // Jahresstatistik: Aufschlüsselung nach Monaten
  if (modus === 'jahr') {
    let zeilen = '';
    for (let m = 1; m <= 12; m++) {
      const key = periode + '-' + String(m).padStart(2, '0');
      const mt = touren.filter(t => t.datum_von.slice(0, 7) === key);
      if (!mt.length) continue;
      const mb = mt.map(t => t.bewertung).filter(b => b);
      zeilen += '<tr><td>' + MONATSNAMEN[m - 1] + '</td><td>' + mt.length + '</td><td>' + mt.reduce((s, t) => s + exportNaechte(t), 0) + '</td><td>' +
        fmtEuro(mt.reduce((s, t) => s + (parseFloat(t.kosten) || 0), 0)) + '</td><td>' + (mb.length ? fmtZahl(mittel(mb), 1) + ' ★' : '–') + '</td></tr>';
    }
    html += '<div class="sr-h">Nach Monaten</div><div class="sr-scroll"><table class="sr-table"><thead><tr><th>Monat</th><th>Touren</th><th>Nächte</th><th>Kosten</th><th>Ø Bewertung</th></tr></thead><tbody>' + zeilen + '</tbody></table></div>';
  }

  // Alle Touren mit allen Infos
  const zeilen = touren.map(t => {
    const bis = t.datum_bis && t.datum_bis !== t.datum_von ? ' – ' + fmtDate(t.datum_bis) : '';
    const temp = [];
    if (num(t.tagestemperatur)) temp.push('Tag ' + t.tagestemperatur + '°');
    if (num(t.nachttemperatur)) temp.push('Nacht ' + t.nachttemperatur + '°');
    const zeit = t.zeiten_24h ? '24 h' : [t.anreise_zeit ? 'an ' + t.anreise_zeit : '', t.abreise_zeit ? 'ab ' + t.abreise_zeit : ''].filter(Boolean).join(', ');
    const info = [];
    const aus = [];
    if (t.strom) aus.push('Strom' + (t.strom_kosten ? ' (' + t.strom_kosten + ')' : ''));
    if (t.sanitaer) aus.push('Sanitär');
    if (t.broetchenservice) aus.push('Brötchenservice');
    if (aus.length) info.push(aus.join(', '));
    const umg = umgebungListe(t.umgebung).join(', ');
    if (umg) info.push('Umgebung: ' + umg);
    if (t.boden) info.push('Boden: ' + t.boden.split(',').filter(Boolean).join(', '));
    if (t.bezahlung) info.push('Bezahlung: ' + t.bezahlung.split(',').filter(Boolean).join(', '));
    if (t.mobilfunk) info.push('Mobilfunk: ' + t.mobilfunk);
    if (t.wlan) info.push('WLAN: ' + t.wlan);
    if (zeit) info.push(zeit);
    return '<tr>' +
      '<td class="nw">' + fmtDate(t.datum_von) + bis + '</td>' +
      '<td><b>' + escapeHtml(t.ort) + '</b>' + (t.favorit ? ' ★' : '') + '<br/>' + escapeHtml(t.typ || '') + '</td>' +
      '<td>' + exportNaechte(t) + '</td>' +
      '<td class="nw">' + (num(t.kosten) ? fmtEuro(t.kosten) : '–') + '</td>' +
      '<td class="nw">' + (t.bewertung ? starsStr(t.bewertung) : '–') + '</td>' +
      '<td>' + escapeHtml(weatherLabel(t.wetter)) + (temp.length ? '<br/>' + temp.join(', ') : '') + '</td>' +
      '<td>' + escapeHtml(info.join(' · ')) + '</td>' +
      '<td>' + escapeHtml(t.notizen || '') + '</td></tr>';
  }).join('');
  html += '<div class="sr-h">Alle Touren</div><div class="sr-scroll"><table class="sr-table sr-touren"><thead><tr><th>Datum</th><th>Ort / Art</th><th>Nächte</th><th>Kosten</th><th>Bewertung</th><th>Wetter</th><th>Ausstattung &amp; Details</th><th>Notizen</th></tr></thead><tbody>' + zeilen + '</tbody></table></div>';
  return html;
}
function druckeStatistik(modus, periode) {
  const alt = document.getElementById('print-area');
  if (alt) alt.remove();
  const area = document.createElement('div');
  area.id = 'print-area';
  area.innerHTML = '<div class="stat-report">' + statistikBerichtHtml(modus, periode) + '</div>';
  document.body.appendChild(area);
  document.body.classList.add('printing');
  const aufraeumen = () => {
    document.body.classList.remove('printing');
    area.remove();
    window.removeEventListener('afterprint', aufraeumen);
  };
  window.addEventListener('afterprint', aufraeumen);
  setTimeout(() => window.print(), 100);
}
function renderStatistikKarte() {
  const card = el('<div class="stat-card"></div>');
  if (!state.statModus) state.statModus = 'monat';
  function zeichne() {
    const modus = state.statModus;
    const perioden = statPerioden(modus);
    if (!perioden.includes(state.statPeriode)) state.statPeriode = perioden[0] || '';
    card.innerHTML =
      '<div class="year-card-head">📈 Statistik</div>' +
      '<div class="stat-controls">' +
        '<button type="button" class="filter-toggle ' + (modus === 'monat' ? 'active' : '') + '" data-modus="monat">Monatlich</button>' +
        '<button type="button" class="filter-toggle ' + (modus === 'jahr' ? 'active' : '') + '" data-modus="jahr">Jährlich</button>' +
        '<select class="filter-select" id="stat-periode">' +
          perioden.map(p => '<option value="' + p + '"' + (p === state.statPeriode ? ' selected' : '') + '>' + escapeHtml(statPeriodeLabel(modus, p)) + '</option>').join('') +
        '</select>' +
        '<button type="button" class="btn-primary stat-print" id="stat-print">🖨️ Drucken / als PDF</button>' +
      '</div>' +
      '<div class="stat-report">' + (state.statPeriode ? statistikBerichtHtml(modus, state.statPeriode) : '') + '</div>';
    card.querySelectorAll('[data-modus]').forEach(b => { b.onclick = () => { state.statModus = b.dataset.modus; zeichne(); }; });
    card.querySelector('#stat-periode').onchange = (e) => { state.statPeriode = e.target.value; zeichne(); };
    card.querySelector('#stat-print').onclick = () => { if (state.statPeriode) druckeStatistik(modus, state.statPeriode); };
  }
  zeichne();
  return card;
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
  box.appendChild(renderStatistikKarte());

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

  const sicherung = el(\`
    <div class="sicherung-card">
      <div class="year-card-head">💾 Datensicherung</div>
      <p class="sicherung-text">Alle \${state.touren.length} Touren und die ToDrive-Liste als Datei herunterladen – zum Aufbewahren oder Weiterverarbeiten. Fotos sind nicht enthalten.</p>
      <div class="sicherung-buttons">
        <button class="btn-primary" id="export-xlsx" style="background: var(--sky); box-shadow: 3px 3px 0 var(--accent);">Excel-Datei</button>
        <button class="btn-primary" id="export-csv" style="background: var(--card); color: var(--sky); border: 2px solid var(--sky); box-shadow: 3px 3px 0 var(--sky);">CSV-Datei</button>
      </div>
    </div>
  \`);
  sicherung.querySelector('#export-xlsx').onclick = () => {
    try { exportiereXlsx(); } catch (e) { zeigeHinweis('Export fehlgeschlagen. Bitte nochmal versuchen.'); }
  };
  sicherung.querySelector('#export-csv').onclick = () => {
    try { exportiereCsv(); } catch (e) { zeigeHinweis('Export fehlgeschlagen. Bitte nochmal versuchen.'); }
  };
  box.appendChild(sicherung);

  return box;
}

function renderSucheTab() {
  const box = el('<div></div>');
  box.innerHTML = \`
    <div class="section-head"><h2>Plätze finden</h2></div>
    <div class="search-row">
      <input type="text" id="suche-input" placeholder="Platzname, Ort oder Region eingeben …" value="\${escapeHtml(state.sucheQuery)}" />
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
    state.sucheAddedIds = {};
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
    ergebnisse.appendChild(el('<div class="empty">Gib den Namen eines Camping- oder Stellplatzes ein (z. B. "Wohnmobilstellplatz Steinhude") oder einen Ort/eine Region, um Plätze in der Umgebung zu finden (Daten von OpenStreetMap).</div>'));
    return box;
  }
  if (state.sucheMessage && state.sucheResults.length === 0) {
    ergebnisse.appendChild(el(\`<div class="search-msg">\${escapeHtml(state.sucheMessage)}</div>\`));
    return box;
  }
  state.sucheResults.forEach((r, i) => {
    const platzKey = r.name + '|' + r.lat + '|' + r.lon;
    const already = state.favoriten.some(f => f.ort === r.name) || state.sucheAddedIds[platzKey];
    const metaTeile = [escapeHtml(r.typ)];
    if (r.distanzKm != null) metaTeile.push(r.distanzKm + ' km entfernt');
    else if (r.adresse) metaTeile.push(escapeHtml(r.adresse));
    if (r.website) metaTeile.push('Website vorhanden');
    const card = el(\`
      <div class="result-card">
        <div class="icon-circle pin-icon" title="Auf Google Maps öffnen">\${ICON_PIN}</div>
        <div class="result-body" title="Auf Google Maps öffnen">
          <div class="result-title">\${escapeHtml(r.name)}</div>
          <div class="result-meta">\${metaTeile.join(' · ')}</div>
        </div>
        <button class="add-todrive-btn" \${already ? 'disabled' : ''} title="Zur ToDrive-Liste hinzufügen">\${already ? '✓' : '+'}</button>
      </div>
    \`);
    card.querySelector('.icon-circle').onclick = () => openMaps({ lat: r.lat, lon: r.lon });
    card.querySelector('.result-body').onclick = () => openMaps({ lat: r.lat, lon: r.lon });
    if (!already) {
      card.querySelector('.add-todrive-btn').onclick = async (e) => {
        e.stopPropagation();
        state.sucheAddedIds[platzKey] = true;
        await zuToDriveHinzufuegen(r);
      };
    }
    ergebnisse.appendChild(card);
  });
  return box;
}

function renderForm(editTour, vorlage) {
  const isEdit = !!editTour;
  const form = isEdit ? {
    ort: editTour.ort || '',
    typ: editTour.typ || 'Stellplatz',
    datumVon: editTour.datum_von || '',
    datumBis: editTour.datum_bis || '',
    kosten: editTour.kosten != null ? String(editTour.kosten) : '',
    wetter: (editTour.wetter || 'sonnig').split(',').filter(Boolean),
    bewertung: editTour.bewertung || null,
    notizen: editTour.notizen || '',
    strom: !!editTour.strom,
    boden: (editTour.boden || '').split(',').filter(Boolean),
    sanitaer: !!editTour.sanitaer,
    bezahlung: (editTour.bezahlung || '').split(',').filter(Boolean),
    broetchenservice: !!editTour.broetchenservice,
    umgebung: umgebungListe(editTour.umgebung),
    nachttemperatur: editTour.nachttemperatur != null ? String(editTour.nachttemperatur) : '',
    tagestemperatur: editTour.tagestemperatur != null ? String(editTour.tagestemperatur) : '',
    anreiseZeit: editTour.anreise_zeit || '',
    abreiseZeit: editTour.abreise_zeit || '',
    zeiten24h: !!editTour.zeiten_24h,
    mobilfunk: editTour.mobilfunk || '',
    wlan: editTour.wlan || '',
    stromKosten: editTour.strom_kosten || '',
  } : vorlage ? {
    // "Nochmal hinfahren": nur Platzdaten übernehmen, alles Besuchsbezogene bleibt leer
    ort: vorlage.ort || '', typ: vorlage.typ || 'Stellplatz', datumVon: '', datumBis: '',
    kosten: '', wetter: ['sonnig'], bewertung: null, notizen: '',
    strom: !!vorlage.strom, boden: (vorlage.boden || '').split(',').filter(Boolean),
    sanitaer: !!vorlage.sanitaer, bezahlung: (vorlage.bezahlung || '').split(',').filter(Boolean),
    broetchenservice: !!vorlage.broetchenservice, umgebung: umgebungListe(vorlage.umgebung),
    nachttemperatur: '', tagestemperatur: '', anreiseZeit: '', abreiseZeit: '', zeiten24h: !!vorlage.zeiten_24h,
    mobilfunk: vorlage.mobilfunk || '', wlan: vorlage.wlan || '', stromKosten: vorlage.strom ? (vorlage.strom_kosten || '') : '',
  } : {
    ort: '', typ: 'Stellplatz', datumVon: '', datumBis: '',
    kosten: '', wetter: ['sonnig'], bewertung: null, notizen: '',
    strom: false, boden: [], sanitaer: false, bezahlung: [], broetchenservice: false, umgebung: [],
    nachttemperatur: '', tagestemperatur: '', anreiseZeit: '', abreiseZeit: '', zeiten24h: false,
    mobilfunk: '', wlan: '', stromKosten: '',
  };
  const [anreiseH, anreiseM] = (form.anreiseZeit || '').split(':');
  const [abreiseH, abreiseM] = (form.abreiseZeit || '').split(':');
  const wrap = el('<div></div>');
  wrap.innerHTML = \`
    <div class="top-row"><div class="top-row-left"><button class="btn-back">\${ICON_BACK}</button><h1>\${isEdit ? 'Tour bearbeiten' : vorlage ? 'Nochmal hinfahren' : 'Neue Tour eintragen'}</h1></div></div>
    \${vorlage ? \`<div class="vorlage-hinweis">Platzdaten von deinem letzten Besuch sind übernommen – trag noch Datum, Wetter und Bewertung ein.</div>\` : ''}
    <form id="tour-form">
      <label class="field"><span class="field-label">Ort / Platzname</span><input name="ort" required list="bekannte-orte" autocomplete="off" placeholder="z. B. Campingplatz Seeblick" value="\${escapeHtml(form.ort)}" /></label>
      <datalist id="bekannte-orte">\${bekannteOrte().map(o => \`<option value="\${escapeHtml(o)}"></option>\`).join('')}</datalist>
      <div class="field" style="margin-bottom:16px;">
        <span class="field-label">📷 Titelbild</span>
        <div class="foto-feld" id="foto-feld">
          <img id="foto-vorschau" class="foto-vorschau \${isEdit && editTour.foto_stand ? '' : 'hidden'}" src="\${isEdit && editTour.foto_stand ? fotoUrl(editTour) : ''}" alt="" />
          <div class="foto-buttons">
            <label class="filter-toggle foto-waehlen">
              <span id="foto-waehlen-text">\${isEdit && editTour.foto_stand ? 'Foto ändern' : 'Foto auswählen'}</span>
              <input type="file" accept="image/*" id="foto-input" hidden />
            </label>
            <button type="button" class="filter-toggle \${isEdit && editTour.foto_stand ? '' : 'hidden'}" id="foto-ausschnitt">Ausschnitt ändern</button>
            <button type="button" class="filter-toggle \${isEdit && editTour.foto_stand ? '' : 'hidden'}" id="foto-entfernen">Entfernen</button>
          </div>
          <div class="foto-status hidden" id="foto-status"></div>
        </div>
      </div>
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
          <button type="button" class="choice-btn \${form.broetchenservice ? 'sel' : ''}" data-flag="broetchenservice">🥐 Brötchen</button>
        </div>
        <div class="choice-row" id="strom-kosten-row" style="\${form.strom ? '' : 'display:none;'} margin-top:8px;">
          \${STROM_KOSTEN_TYPEN.map(s => \`<button type="button" class="choice-btn \${s === form.stromKosten ? 'sel' : ''}" data-stromkosten="\${s}">\${s}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">Bezahlen (mehrfach möglich)</span>
        <div class="choice-row" id="bezahlung-row">
          \${BEZAHLUNG_TYPEN.map(b => \`<button type="button" class="choice-btn \${form.bezahlung.includes(b) ? 'sel' : ''}" data-bezahlung="\${b}">\${b}</button>\`).join('')}
        </div>
      </label>
      <label class="field"><span class="field-label">Umgebung</span>
        <div class="choice-row" id="umgebung-row">
          \${UMGEBUNG_TYPEN.map(u => \`<button type="button" class="choice-btn \${form.umgebung.includes(u) ? 'sel' : ''}" data-umgebung="\${u}">\${u}</button>\`).join('')}
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
          \${WEATHER.map(w => \`<button type="button" class="choice-btn weather-btn \${form.wetter.includes(w.key) ? 'sel' : ''}" data-wetter="\${w.key}"><span style="font-size:20px">\${w.emoji}</span><span class="mono" style="font-size:12px;font-weight:700">\${w.label}</span></button>\`).join('')}
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
    if (vorlage) {
      state.activeId = vorlage.id;
      state.vorlageId = null;
      state.view = 'detail';
    } else {
      state.view = isEdit ? 'detail' : 'home';
    }
    render();
  };

  // Titelbild: auswählen, Ausschnitt festlegen (wird dabei verkleinert) oder entfernen
  let fotoNeu = null;
  let fotoEntfernen = false;
  const fotoInput = wrap.querySelector('#foto-input');
  const fotoVorschau = wrap.querySelector('#foto-vorschau');
  const fotoEntfernenBtn = wrap.querySelector('#foto-entfernen');
  const fotoAusschnittBtn = wrap.querySelector('#foto-ausschnitt');
  const fotoStatus = wrap.querySelector('#foto-status');
  fotoInput.onchange = async () => {
    const datei = fotoInput.files && fotoInput.files[0];
    if (!datei) return;
    fotoStatus.textContent = 'Foto wird geladen …';
    fotoStatus.classList.remove('hidden');
    const url = URL.createObjectURL(datei);
    try {
      const ergebnis = await bildZuschneiden(url);
      fotoStatus.classList.add('hidden');
      if (!ergebnis) { fotoInput.value = ''; return; }
      fotoNeu = ergebnis;
      fotoEntfernen = false;
      fotoVorschau.src = fotoNeu;
      fotoVorschau.classList.remove('hidden');
      fotoEntfernenBtn.classList.remove('hidden');
      fotoAusschnittBtn.classList.remove('hidden');
      wrap.querySelector('#foto-waehlen-text').textContent = 'Foto ändern';
    } catch (e) {
      fotoStatus.textContent = 'Dieses Bild konnte nicht gelesen werden. Bitte ein anderes wählen.';
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  // Ausschnitt des aktuellen Fotos (neu gewählt oder bereits gespeichert) nochmal anpassen
  fotoAusschnittBtn.onclick = async () => {
    const quelle = fotoNeu || (isEdit && editTour.foto_stand && !fotoEntfernen ? fotoUrl(editTour) : null);
    if (!quelle) return;
    fotoStatus.textContent = 'Foto wird geladen …';
    fotoStatus.classList.remove('hidden');
    try {
      const ergebnis = await bildZuschneiden(quelle);
      fotoStatus.classList.add('hidden');
      if (!ergebnis) return;
      fotoNeu = ergebnis;
      fotoEntfernen = false;
      fotoVorschau.src = fotoNeu;
    } catch (e) {
      fotoStatus.textContent = 'Das Foto konnte nicht geladen werden.';
    }
  };
  fotoEntfernenBtn.onclick = () => {
    fotoNeu = null;
    fotoEntfernen = isEdit && !!editTour.foto_stand;
    fotoInput.value = '';
    fotoVorschau.classList.add('hidden');
    fotoVorschau.removeAttribute('src');
    fotoEntfernenBtn.classList.add('hidden');
    fotoAusschnittBtn.classList.add('hidden');
    wrap.querySelector('#foto-waehlen-text').textContent = 'Foto auswählen';
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
      const val = btn.dataset.umgebung;
      if (form.umgebung.includes(val)) form.umgebung = form.umgebung.filter(u => u !== val);
      else form.umgebung.push(val);
      btn.classList.toggle('sel', form.umgebung.includes(val));
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
      if (flag === 'strom') {
        wrap.querySelector('#strom-kosten-row').style.display = form.strom ? '' : 'none';
        if (!form.strom) {
          form.stromKosten = '';
          wrap.querySelectorAll('#strom-kosten-row .choice-btn').forEach(b => b.classList.remove('sel'));
        }
      }
    };
  });
  wrap.querySelectorAll('#strom-kosten-row .choice-btn').forEach(btn => {
    btn.onclick = () => {
      form.stromKosten = form.stromKosten === btn.dataset.stromkosten ? '' : btn.dataset.stromkosten;
      wrap.querySelectorAll('#strom-kosten-row .choice-btn').forEach(b => b.classList.toggle('sel', b.dataset.stromkosten === form.stromKosten));
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
      // Nochmal auf den gewählten Stern tippen = Bewertung wieder entfernen
      const stern = parseInt(btn.dataset.star);
      form.bewertung = form.bewertung === stern ? null : stern;
      wrap.querySelectorAll('#star-picker button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.star) <= form.bewertung));
    };
  });

  wrap.querySelector('#tour-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      ort: vereinheitlicheOrt(fd.get('ort')),
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
      umgebung: form.umgebung.join(',') || null,
      nachttemperatur: fd.get('nachttemperatur') || null,
      tagestemperatur: fd.get('tagestemperatur') || null,
      anreiseZeit: fd.get('anreiseStunde') ? fd.get('anreiseStunde') + ':' + (fd.get('anreiseMinute') || '00') : null,
      abreiseZeit: fd.get('abreiseStunde') ? fd.get('abreiseStunde') + ':' + (fd.get('abreiseMinute') || '00') : null,
      zeiten24h: form.zeiten24h,
      mobilfunk: form.mobilfunk || null,
      wlan: form.wlan || null,
      stromKosten: form.strom ? (form.stromKosten || null) : null,
    };
    const errBox = wrap.querySelector('#form-err');
    if (!payload.ort || !payload.ort.trim() || !payload.datumVon) {
      errBox.textContent = 'Bitte mindestens Ort und Datum eintragen.';
      errBox.classList.remove('hidden');
      return;
    }
    if (payload.datumBis && payload.datumBis < payload.datumVon) {
      errBox.textContent = 'Das "Bis"-Datum liegt vor dem "Von"-Datum. Bitte prüfen.';
      errBox.classList.remove('hidden');
      errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const submitBtn = wrap.querySelector('#submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Speichern …';
    try {
      let tourId;
      if (isEdit) {
        await api('/api/touren/' + editTour.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        tourId = editTour.id;
        state.view = 'detail';
        state.activeId = editTour.id;
        state.editingId = null;
      } else {
        const neu = await api('/api/touren', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        tourId = neu.id;
        state.view = 'home';
        state.vorlageId = null;
      }
      // Titelbild separat speichern – schlägt das fehl, bleibt die Tour trotzdem gespeichert
      try {
        if (fotoNeu) {
          submitBtn.textContent = 'Foto wird hochgeladen …';
          await api('/api/touren/' + tourId + '/foto', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: fotoNeu, mime: 'image/jpeg' }) });
        } else if (fotoEntfernen) {
          await api('/api/touren/' + tourId + '/foto', { method: 'DELETE' });
        }
      } catch (fotoFehler) {
        zeigeHinweis('Tour gespeichert – das Foto konnte aber nicht hochgeladen werden. Über "Bearbeiten" nochmal versuchen.');
      }
      try {
        await loadData();
      } catch (ladeFehler) {
        // Gespeichert ist die Tour bereits – nur die Liste konnte nicht neu geladen werden
        render();
        zeigeHinweis('Gespeichert. Die Liste aktualisiert sich, sobald wieder Verbindung besteht.');
      }
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
    \${t.foto_stand ? \`<img class="detail-foto" src="\${fotoUrl(t)}" alt="Foto vom Platz" />\` : ''}
    <div style="display:flex; gap:10px; align-items:flex-start; margin-bottom:4px;">
      <span class="pin-icon" style="margin-top:2px;">\${ICON_PIN}</span>
      <h1 style="font-size:28px; margin:0;">\${escapeHtml(t.ort)}</h1>
    </div>
    <div class="mono" style="margin-left:32px; color: var(--muted); font-size:14px; font-weight:700; margin-bottom:22px;">\${escapeHtml(t.typ)} \${t.favorit ? ' · ★ Favorit' : ''}</div>
    <div class="detail-box">
      <div class="detail-row"><span class="detail-label">Datum</span><span>\${fmtDate(t.datum_von)}\${t.datum_bis && t.datum_bis !== t.datum_von ? ' – ' + fmtDate(t.datum_bis) : ''}</span></div>
      \${t.zeiten_24h ? \`<div class="detail-row"><span class="detail-label">Zeiten</span><span>🕐 Rund um die Uhr</span></div>\` : (t.anreise_zeit || t.abreise_zeit) ? \`<div class="detail-row"><span class="detail-label">Zeiten</span><span>\${t.anreise_zeit ? 'An ' + t.anreise_zeit + ' Uhr' : ''}\${t.anreise_zeit && t.abreise_zeit ? ' · ' : ''}\${t.abreise_zeit ? 'Ab ' + t.abreise_zeit + ' Uhr' : ''}</span></div>\` : ''}
      \${t.boden ? \`<div class="detail-row"><span class="detail-label">Boden</span><span>\${escapeHtml(t.boden.split(',').filter(Boolean).join(', '))}</span></div>\` : ''}
      \${t.umgebung ? \`<div class="detail-row"><span class="detail-label">Umgebung</span><span>\${escapeHtml(umgebungListe(t.umgebung).join(', '))}</span></div>\` : ''}
      \${t.mobilfunk ? \`<div class="detail-row"><span class="detail-label">Mobilfunk</span><span>📶 \${escapeHtml(t.mobilfunk)}</span></div>\` : ''}
      \${t.wlan ? \`<div class="detail-row"><span class="detail-label">WLAN</span><span>📡 \${escapeHtml(t.wlan)}</span></div>\` : ''}
      \${t.bezahlung ? \`<div class="detail-row"><span class="detail-label">Bezahlen</span><span>\${escapeHtml(t.bezahlung.split(',').filter(Boolean).join(', '))}</span></div>\` : ''}
      \${(t.kosten != null && t.kosten !== '') ? \`<div class="detail-row"><span class="detail-label">Kosten</span><span>\${parseFloat(t.kosten) === 0 ? 'kostenlos' : parseFloat(t.kosten).toFixed(2) + ' €'}</span></div>\` : ''}
      <div class="detail-row"><span class="detail-label">Wetter</span><span>\${weatherEmoji(t.wetter)} \${weatherLabel(t.wetter)}</span></div>
      \${t.tagestemperatur != null ? \`<div class="detail-row"><span class="detail-label">Tagestemp.</span><span>☀️ \${t.tagestemperatur}°C</span></div>\` : ''}
      \${t.nachttemperatur != null ? \`<div class="detail-row"><span class="detail-label">Nachttemp.</span><span>🌙 \${t.nachttemperatur}°C</span></div>\` : ''}
      <div class="detail-row"><span class="detail-label">Bewertung</span><span style="color:var(--accent)">\${starsStr(t.bewertung || 0)}</span></div>
      \${(t.strom || t.sanitaer || t.broetchenservice) ? \`<div class="detail-row"><span class="detail-label">Ausstattung</span><span>\${[t.strom ? '⚡ Strom' + (t.strom_kosten ? ' (' + t.strom_kosten + ')' : '') : '', t.sanitaer ? '🚿 Sanitär' : '', t.broetchenservice ? '🥐 Brötchen' : ''].filter(Boolean).join(' · ')}</span></div>\` : ''}
    </div>
    \${t.notizen ? \`<div style="margin-top:20px;"><div class="field-label">Notizen</div><p style="white-space:pre-wrap; line-height:1.6;">\${escapeHtml(t.notizen)}</p></div>\` : ''}
    <div style="display:flex; gap:10px; margin-top:24px; flex-wrap:wrap;">
      <button class="btn-primary" id="fav-toggle-btn" style="flex:1; min-width:180px; background: var(--sky); box-shadow: 3px 3px 0 var(--accent);">\${t.favorit ? '★ Aus Favoriten entfernen' : '☆ Zu Favoriten hinzufügen'}</button>
      <button class="btn-primary" id="maps-btn" style="flex:1; min-width:180px; background: var(--accent); box-shadow: 3px 3px 0 var(--sky); display:flex; align-items:center; justify-content:center; gap:8px;">\${ICON_PIN} Auf Google Maps öffnen</button>
    </div>
    <button class="btn-primary" id="nochmal-btn" style="margin-top:12px; background: var(--card); color: var(--sky); border: 2px solid var(--sky); box-shadow: 3px 3px 0 var(--sky);">🔁 Nochmal hinfahren</button>
  \`;
  wrap.querySelector('.btn-back').onclick = () => { state.view = 'home'; render(); };
  wrap.querySelector('#edit-toggle').onclick = () => { state.editingId = t.id; state.vorlageId = null; state.view = 'form'; render(); };
  wrap.querySelector('#nochmal-btn').onclick = () => { state.editingId = null; state.vorlageId = t.id; state.view = 'form'; render(); window.scrollTo(0, 0); };
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

// ---- Datensicherung: Excel (.xlsx) und CSV, ganz ohne externe Bibliothek ----

const EXPORT_SPALTEN = [
  { titel: 'Ort', breite: 30, wert: t => t.ort },
  { titel: 'Art', breite: 14, wert: t => t.typ },
  { titel: 'Von', breite: 12, typ: 'datum', wert: t => t.datum_von },
  { titel: 'Bis', breite: 12, typ: 'datum', wert: t => t.datum_bis },
  { titel: 'Nächte', breite: 8, typ: 'zahl', wert: t => exportNaechte(t) },
  { titel: 'Anreise', breite: 9, wert: t => t.zeiten_24h ? '24 h' : (t.anreise_zeit || '') },
  { titel: 'Abreise', breite: 9, wert: t => t.zeiten_24h ? '24 h' : (t.abreise_zeit || '') },
  { titel: 'Kosten (€)', breite: 11, typ: 'geld', wert: t => (t.kosten === null || t.kosten === undefined || t.kosten === '') ? null : Number(t.kosten) },
  { titel: 'Bewertung', breite: 10, typ: 'zahl', wert: t => t.bewertung },
  { titel: 'Favorit', breite: 8, wert: t => t.favorit ? 'ja' : '' },
  { titel: 'Wetter', breite: 18, wert: t => weatherLabel(t.wetter) },
  { titel: 'Tag °C', breite: 8, typ: 'zahl', wert: t => t.tagestemperatur },
  { titel: 'Nacht °C', breite: 9, typ: 'zahl', wert: t => t.nachttemperatur },
  { titel: 'Strom', breite: 8, wert: t => t.strom ? 'ja' : '' },
  { titel: 'Strom-Kosten', breite: 14, wert: t => t.strom ? (t.strom_kosten || '') : '' },
  { titel: 'Sanitär', breite: 8, wert: t => t.sanitaer ? 'ja' : '' },
  { titel: 'Brötchen', breite: 9, wert: t => t.broetchenservice ? 'ja' : '' },
  { titel: 'Boden', breite: 16, wert: t => (t.boden || '').split(',').filter(Boolean).join(', ') },
  { titel: 'Bezahlen', breite: 16, wert: t => (t.bezahlung || '').split(',').filter(Boolean).join(', ') },
  { titel: 'Umgebung', breite: 10, wert: t => umgebungListe(t.umgebung).join(', ') },
  { titel: 'Mobilfunk', breite: 13, wert: t => t.mobilfunk },
  { titel: 'WLAN', breite: 13, wert: t => t.wlan },
  { titel: 'Notizen', breite: 40, wert: t => t.notizen },
];

const TODRIVE_SPALTEN = [
  { titel: 'Platz', breite: 32, wert: f => f.ort },
  { titel: 'Notiz', breite: 50, wert: f => f.notiz },
  { titel: 'Breitengrad', breite: 12, typ: 'zahl', wert: f => f.lat },
  { titel: 'Längengrad', breite: 12, typ: 'zahl', wert: f => f.lon },
];

function exportNaechte(t) {
  if (!t.datum_von || !t.datum_bis) return 1;
  const diff = Math.round((new Date(t.datum_bis) - new Date(t.datum_von)) / 86400000);
  return Math.max(1, diff);
}

function exportTourenSortiert() {
  return [...state.touren].sort((a, b) => (a.datum_von || '').localeCompare(b.datum_von || ''));
}

function exportDateiname(endung) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return 'CamperLog-Sicherung-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.' + endung;
}

function dateiHerunterladen(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// --- CSV (Semikolon + BOM, damit deutsches Excel Spalten und Umlaute richtig erkennt) ---
function csvWert(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  if (/[";\\r\\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function baueCsv(zeilen, spalten) {
  const out = [spalten.map(s => csvWert(s.titel)).join(';')];
  zeilen.forEach(z => {
    out.push(spalten.map(s => {
      const w = s.wert(z);
      if (s.typ === 'datum' && w) return fmtDate(w);
      return csvWert(w);
    }).join(';'));
  });
  return '﻿' + out.join('\\r\\n');
}

function exportiereCsv() {
  const csv = baueCsv(exportTourenSortiert(), EXPORT_SPALTEN);
  dateiHerunterladen(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportDateiname('csv'));
}

// --- XLSX: Excel-Datei = ZIP-Archiv mit ein paar XML-Dateien ---
function xmlEsc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/g, '');
}

function spaltenBuchstabe(i) {
  let s = '';
  i++;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function excelDatum(iso) {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(iso || '');
  if (!m) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
}

function baueSheetXml(zeilen, spalten) {
  // Stile: 0 = normal, 1 = Überschrift fett, 2 = Datum, 3 = Geldbetrag
  let rows = '<row r="1">' + spalten.map((s, i) =>
    '<c r="' + spaltenBuchstabe(i) + '1" t="inlineStr" s="1"><is><t>' + xmlEsc(s.titel) + '</t></is></c>').join('') + '</row>';
  zeilen.forEach((z, zi) => {
    const r = zi + 2;
    let cells = '';
    spalten.forEach((s, i) => {
      const ref = spaltenBuchstabe(i) + r;
      let w = s.wert(z);
      if (w === null || w === undefined || w === '') return;
      if (s.typ === 'datum') {
        const serial = excelDatum(w);
        if (serial !== null) { cells += '<c r="' + ref + '" s="2"><v>' + serial + '</v></c>'; return; }
      }
      if ((s.typ === 'zahl' || s.typ === 'geld') && !isNaN(Number(w))) {
        cells += '<c r="' + ref + '"' + (s.typ === 'geld' ? ' s="3"' : '') + '><v>' + Number(w) + '</v></c>';
        return;
      }
      cells += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(w) + '</t></is></c>';
    });
    rows += '<row r="' + r + '">' + cells + '</row>';
  });
  const cols = '<cols>' + spalten.map((s, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + s.breite + '" customWidth="1"/>').join('') + '</cols>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    cols + '<sheetData>' + rows + '</sheetData></worksheet>';
}

const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABELLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Einfaches ZIP ohne Kompression ("stored") – reicht für Excel völlig
function baueZip(dateien) {
  const enc = new TextEncoder();
  const teile = [];
  const zentral = [];
  let offset = 0;
  dateien.forEach(d => {
    const name = enc.encode(d.name);
    const daten = enc.encode(d.inhalt);
    const crc = crc32(daten);
    const kopf = new DataView(new ArrayBuffer(30));
    kopf.setUint32(0, 0x04034b50, true);
    kopf.setUint16(4, 20, true);
    kopf.setUint16(6, 0x0800, true);
    kopf.setUint16(8, 0, true);
    kopf.setUint32(14, crc, true);
    kopf.setUint32(18, daten.length, true);
    kopf.setUint32(22, daten.length, true);
    kopf.setUint16(26, name.length, true);
    teile.push(new Uint8Array(kopf.buffer), name, daten);
    const z = new DataView(new ArrayBuffer(46));
    z.setUint32(0, 0x02014b50, true);
    z.setUint16(4, 20, true);
    z.setUint16(6, 20, true);
    z.setUint16(8, 0x0800, true);
    z.setUint32(16, crc, true);
    z.setUint32(20, daten.length, true);
    z.setUint32(24, daten.length, true);
    z.setUint16(28, name.length, true);
    z.setUint32(42, offset, true);
    zentral.push(new Uint8Array(z.buffer), name);
    offset += 30 + name.length + daten.length;
  });
  const zentralGroesse = zentral.reduce((s, b) => s + b.length, 0);
  const ende = new DataView(new ArrayBuffer(22));
  ende.setUint32(0, 0x06054b50, true);
  ende.setUint16(8, dateien.length, true);
  ende.setUint16(10, dateien.length, true);
  ende.setUint32(12, zentralGroesse, true);
  ende.setUint32(16, offset, true);
  return new Blob([...teile, ...zentral, new Uint8Array(ende.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function baueXlsx() {
  const kopf = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return baueZip([
    { name: '[Content_Types].xml', inhalt: kopf + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>' },
    { name: '_rels/.rels', inhalt: kopf + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>' },
    { name: 'xl/workbook.xml', inhalt: kopf + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Touren" sheetId="1" r:id="rId1"/><sheet name="ToDrive" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', inhalt: kopf + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>' },
    { name: 'xl/styles.xml', inhalt: kopf + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', inhalt: baueSheetXml(exportTourenSortiert(), EXPORT_SPALTEN) },
    { name: 'xl/worksheets/sheet2.xml', inhalt: baueSheetXml(state.favoriten, TODRIVE_SPALTEN) },
  ]);
}

function exportiereXlsx() {
  dateiHerunterladen(baueXlsx(), exportDateiname('xlsx'));
}

function zeigeHinweis(text) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(zeigeHinweis._timer);
  zeigeHinweis._timer = setTimeout(() => t.classList.remove('show'), 3500);
}

window.addEventListener('unhandledrejection', (ev) => {
  const msg = ev.reason && ev.reason.message ? ev.reason.message : '';
  ev.preventDefault();
  if (msg === 'Nicht angemeldet.') return;
  zeigeHinweis(navigator.onLine === false
    ? 'Keine Internetverbindung – Aktion konnte nicht gespeichert werden.'
    : 'Das hat nicht geklappt. Bitte nochmal versuchen.');
});

function zeigeLadefehler(e) {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const box = el(\`
    <div style="padding-top:60px; text-align:center;">
      <img src="/icon-192.jpg" class="logo-badge" style="width:64px;height:64px;margin-bottom:16px;" alt="" />
      <h1 style="font-size:24px;">Daten konnten nicht geladen werden</h1>
      <p style="color:var(--ink); font-size:15px; line-height:1.5; margin:12px 0 22px;">Prüfe die Internetverbindung und versuch es nochmal. Offline werden die zuletzt geladenen Daten angezeigt, sobald sie einmal geladen wurden.</p>
      <button class="btn-primary" id="retry-btn">Nochmal versuchen</button>
    </div>
  \`);
  box.querySelector('#retry-btn').onclick = () => starteApp();
  app.appendChild(box);
}

async function starteApp() {
  try {
    await loadData();
  } catch (e) {
    zeigeLadefehler(e);
  }
}

starteApp();
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

// Hintergrundbild (Herbstwiese), wird unter /hintergrund-1.jpg ausgeliefert
const BG_B64 = "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";

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
  if (url.pathname.startsWith('/icon-') || url.pathname.startsWith('/hintergrund-')) {
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
            "Set-Cookie": `camperlog_pw=${encodeURIComponent(pw)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
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
    if (url.pathname === "/hintergrund-1.jpg") {
      return new Response(b64ToBytes(BG_B64), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
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
