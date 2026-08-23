# CamperLog – Cloudflare-Version

Euer Wohnmobil-Reisetagebuch als Cloudflare Worker mit D1-Datenbank.
Die Datenbank (`camperlog-db`) ist bereits in eurem Cloudflare-Account angelegt
und in `wrangler.toml` verknüpft (database_id: `23a199d0-d245-4c10-87a1-7ae56ceeaba3`).

## Was drin ist
- **Startseite** mit Stempel-Zähler (Plätze / Touren / Nächte / Ø Nachttemperatur)
  und direkt sichtbarer ToDrive-Liste
- **Touren-Tab**: alle bisherigen Fahrten, chronologisch
- **★ Favoriten-Tab**: besuchte Plätze, die ihr mit dem Stern markiert habt
- Neue Tour eintragen: Ort, Art (Campingplatz/Stellplatz/Wildcamping), Datum,
  Boden (mehrfach möglich), Ausstattung (⚡ Strom / 🚿 Sanitär /
  🥐 Brötchenservice), Bezahlen, Umgebung, Wetter (mehrfach möglich),
  Nachttemperatur (°C), Kosten, Bewertung, Notizen
- **Bearbeiten**: Stift-Button in der Detailansicht
- **Echte Platzsuche** (Tab "🔍 Suche"): Ort/Region eingeben, echte Camping-
  und Stellplätze aus OpenStreetMap in der Umgebung werden angezeigt
  (Entfernung, Website), kein API-Key nötig. Mit "+" landen sie auf der
  ToDrive-Liste.
- **Plätze-Zähler**: zählt eindeutige Orte – ein zweiter Besuch am selben
  Platz lässt die Zahl nicht weiter steigen
- **Google Maps**: Klick auf einen ToDrive-Eintrag, ein Suchergebnis oder den
  Maps-Button in der Tour-Detailansicht öffnet den Ort direkt in Google Maps
- **Logo**: euer Wohnmobil-Foto ist jetzt Icon in der Kopfzeile und Favicon
- Design in Himmelblau + Sandtönen, saubere SVG-Icons
- **Passwortschutz**: einfaches Passwort schützt die ganze App (siehe unten)
- **Installierbar (PWA)**: App lässt sich aufs Homescreen installieren und
  zeigt zuletzt geladene Daten auch ohne Internetverbindung an
- **📊 Rückblick-Tab**: Jahresstatistik (Touren, Nächte, Kosten,
  Temperaturspanne, bestbewerteter Platz), Kosten-Balkendiagramm über die
  Jahre, Abzeichen für den meistbesuchten Platz
- **Filter & Sortierung** im Touren-Tab: nach Datum, Bewertung oder Kosten
  sortieren, nach Umgebung filtern, nur Favoriten anzeigen

## Passwortschutz

Die App ist mit einem einfachen Passwort geschützt (Standard: `iva2026`,
in `wrangler.toml` unter `[vars] APP_PASSWORD` hinterlegt). Ändert es vor
dem Deploy einfach im Code, oder danach im Cloudflare-Dashboard unter
**Workers & Pages → euer Worker → Settings → Variables and Secrets**
(Variable `APP_PASSWORD` bearbeiten, kein Redeploy nötig). Nach der ersten
Anmeldung merkt sich der Browser das Passwort ein Jahr lang (Cookie).

## Einmalig deployen

1. Ordner entpacken / öffnen, dann im Terminal:
   ```bash
   npm install
   npx wrangler login
   npm run deploy
   ```
2. Wrangler zeigt euch danach eine URL wie
   `https://camperlog.<euer-account>.workers.dev` – das ist die App.
   Diese URL könnt ihr euch beide auf dem Homescreen speichern (iOS/Android:
   "Zum Startbildschirm hinzufügen"), dann fühlt sie sich wie eine echte App an.

## Update: neue Spalten (falls App schon läuft)

Falls ihr schon eine ältere Version deployed hattet, fehlen euch eventuell
noch Spalten in der Datenbank. Das geht mit:
```bash
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN strom INTEGER DEFAULT 0"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN boden TEXT"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN sanitaer INTEGER DEFAULT 0"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN bezahlung TEXT"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN broetchenservice INTEGER DEFAULT 0"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN umgebung TEXT"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE touren ADD COLUMN nachttemperatur REAL"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE favoriten ADD COLUMN lat REAL"
npx wrangler d1 execute camperlog-db --remote --command "ALTER TABLE favoriten ADD COLUMN lon REAL"
```
Falls ihr dieses Paket zum ersten Mal nutzt: schon erledigt, die Datenbank in
eurem Account wurde bereits entsprechend aktualisiert.

## Danach ändern

Für Änderungen am Code einfach `src/index.js` bearbeiten und erneut
`npm run deploy` ausführen, oder den Code im Cloudflare-Dashboard unter
"Edit code" ersetzen und dort deployen.

Die Datenbank selbst könnt ihr jederzeit im Cloudflare-Dashboard unter
**Workers & Pages → D1 → camperlog-db** einsehen oder mit
`npx wrangler d1 execute camperlog-db --command "SELECT * FROM touren"`
direkt abfragen.

## Wichtig
- Da beide von unterschiedlichen Geräten auf dieselbe URL zugreifen, seht ihr
  automatisch die gleichen Daten – ohne extra Sync-Einrichtung.
- Es gibt aktuell keinen Login/Passwortschutz. Wer die URL kennt, kann die App
  nutzen. Falls gewünscht, kann ich Cloudflare Access oder ein einfaches
  Passwort ergänzen.
