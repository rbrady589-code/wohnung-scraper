#!/usr/bin/env node
/**
 * Seed the database with sample listings across every provider.
 *
 *   node scripts/seed.js                 # 60 listings into data/wohnungen.db
 *   node scripts/seed.js --count 200
 *   node scripts/seed.js --db data/demo.db
 *
 * This exists so the map and the list view can be developed and demoed
 * without waiting on a working scraper. The rows have the same shape a real
 * scrape produces -- same columns, same `data` JSON blob, same provider ids --
 * so anything built against them works unchanged on real data.
 *
 * Every seeded row carries "[SAMPLE]" in its title and a websiteId prefixed
 * with "seed-", so it is obvious on screen and easy to delete:
 *
 *   DELETE FROM wohnungen WHERE websiteId LIKE 'seed-%';
 */

const fs = require("fs");
const path = require("path");
const sqlite = require("sqlite");
const sqlite3 = require("sqlite3");
const DBMigrate = require("db-migrate");
const moment = require("moment");

const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};
const count = parseInt(flag("count") || "60", 10);
const dbPath = flag("db") || path.join(ROOT, "data", "wohnungen.db");

// Berlin districts with rough centre coordinates and a rent multiplier, so
// the price-per-m2 colouring on the map shows realistic variation.
const DISTRICTS = [
  { name: "Mitte", lat: 52.5200, lng: 13.4050, factor: 1.25 },
  { name: "Prenzlauer Berg", lat: 52.5390, lng: 13.4240, factor: 1.20 },
  { name: "Friedrichshain", lat: 52.5150, lng: 13.4540, factor: 1.10 },
  { name: "Kreuzberg", lat: 52.4980, lng: 13.4030, factor: 1.15 },
  { name: "Neukölln", lat: 52.4810, lng: 13.4350, factor: 0.95 },
  { name: "Charlottenburg", lat: 52.5050, lng: 13.3070, factor: 1.10 },
  { name: "Wedding", lat: 52.5490, lng: 13.3660, factor: 0.85 },
  { name: "Schöneberg", lat: 52.4830, lng: 13.3550, factor: 1.05 },
  { name: "Lichtenberg", lat: 52.5150, lng: 13.4980, factor: 0.80 },
  { name: "Steglitz", lat: 52.4560, lng: 13.3320, factor: 0.90 }
];

const PROVIDERS = [
  { id: "kleinanzeigenapi", weight: 4, rich: true },
  { id: "wgGesucht", weight: 3, rich: false },
  { id: "immoscout24api", weight: 3, rich: true }
];

const STREETS = [
  "Kastanienallee", "Danziger Str.", "Sonnenallee", "Torstr.", "Boxhagener Str.",
  "Wrangelstr.", "Bergmannstr.", "Seestr.", "Hauptstr.", "Frankfurter Allee",
  "Oranienstr.", "Kantstr.", "Gneisenaustr.", "Schönhauser Allee", "Turmstr."
];

const CONDITIONS = [
  "Erstbezug", "Erstbezug nach Sanierung", "Neuwertig", "Saniert",
  "Modernisiert", "Gepflegt", "Renovierungsbedürftig", "Altbau"
];

const rnd = (min, max) => Math.random() * (max - min) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

function weightedProvider() {
  const total = PROVIDERS.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of PROVIDERS) {
    if ((r -= p.weight) <= 0) return p;
  }
  return PROVIDERS[0];
}

function makeListing(i) {
  const provider = weightedProvider();
  const district = pick(DISTRICTS);

  const rooms = Math.floor(rnd(1, 6));
  const size = Math.round(rnd(28, 45 + rooms * 22));
  const pricePerSqm = rnd(11, 24) * district.factor;
  const price = Math.round((size * pricePerSqm) / 10) * 10;

  // Scatter around the district centre, roughly +/- 1.5km.
  const latitude = district.lat + rnd(-0.014, 0.014);
  const longitude = district.lng + rnd(-0.021, 0.021);

  const kaltmiete = Math.round(price * 0.78);
  const nebenkosten = Math.round(price * 0.14);
  const heizkosten = price - kaltmiete - nebenkosten;

  const freeFrom = moment()
    .add(Math.floor(rnd(0, 120)), "days")
    .startOf("day");
  const added = moment().subtract(Math.floor(rnd(0, 45)), "days");

  const street = `${pick(STREETS)} ${Math.floor(rnd(1, 180))}`;
  const condition = pick(CONDITIONS);

  // Richer providers expose structured features; WG-Gesucht does not, which
  // mirrors the real gap in coverage.
  const features = provider.rich
    ? {
        condition,
        etage: Math.floor(rnd(0, 6)),
        balcony: chance(0.55),
        terrace: chance(0.15),
        built_in_kitchen: chance(0.45),
        bathtub: chance(0.35),
        celler_loft: chance(0.6),
        garage: chance(0.2),
        pets_allowed: chance(0.3),
        lift: chance(0.35),
        wg_possible: chance(0.25),
        wohnungstyp: pick(["Etagenwohnung", "Altbau", "Dachgeschoss", "Erdgeschoss", "Maisonette"])
      }
    : { condition: chance(0.3) ? condition : undefined };

  const data = {
    adresse: `${street}, ${10000 + Math.floor(rnd(115, 999))} Berlin ${district.name}`,
    kaltmiete,
    nebenkosten,
    heizkosten,
    warmmiete: price,
    features,
    description:
      `${condition}. ${rooms}-Zimmer-Wohnung in ${district.name}` +
      `${features.balcony ? " mit Balkon" : ""}` +
      `${features.lift ? ", Aufzug im Haus" : ""}.`,
    publicUrl: `https://example.invalid/${provider.id}/${i}`
  };

  return {
    website: provider.id,
    websiteId: `seed-${i}`,
    url: `https://example.invalid/${provider.id}/${i}`,
    latitude,
    longitude,
    rooms,
    size,
    price,
    data: JSON.stringify(data),
    free_from: freeFrom.toISOString(),
    active: 1,
    gone: 0,
    favorite: chance(0.08) ? 1 : 0,
    added: added.toISOString(),
    title: `[SAMPLE] ${rooms} Zi. ${size} m² ${district.name} — ${condition}`
  };
}

async function main() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const dbm = DBMigrate.getInstance(true, {
    cwd: ROOT,
    config: { seed: { driver: "sqlite3", filename: dbPath } },
    env: "seed"
  });
  dbm.silence(true);
  await dbm.up();

  const db = await sqlite.open({ filename: dbPath, driver: sqlite3.Database });

  const removed = await db.run("DELETE FROM wohnungen WHERE websiteId LIKE 'seed-%'");
  if (removed.changes) {
    console.log(`removed ${removed.changes} existing sample row(s)`);
  }

  const stmt = await db.prepare(
    `INSERT INTO wohnungen
       (website, websiteId, url, latitude, longitude, rooms, size, price,
        data, free_from, active, gone, favorite, added, title)
     VALUES
       ($website, $websiteId, $url, $latitude, $longitude, $rooms, $size, $price,
        $data, $free_from, $active, $gone, $favorite, $added, $title)`
  );

  for (let i = 0; i < count; i++) {
    const r = makeListing(i);
    await stmt.run(
      Object.fromEntries(Object.entries(r).map(([k, v]) => [`$${k}`, v]))
    );
  }
  await stmt.finalize();

  const byProvider = await db.all(
    `SELECT website, COUNT(*) n, MIN(price) lo, MAX(price) hi
       FROM wohnungen WHERE websiteId LIKE 'seed-%' GROUP BY website`
  );

  console.log(`\n✓ seeded ${count} listing(s) into ${dbPath}\n`);
  for (const p of byProvider) {
    console.log(`  ${p.website.padEnd(18)} ${String(p.n).padStart(3)} listings   ${p.lo}–${p.hi} €`);
  }
  console.log(`\n  start the app:  npm run dev     →  http://localhost:3000`);
  console.log(`  remove samples: DELETE FROM wohnungen WHERE websiteId LIKE 'seed-%';\n`);

  await db.close();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
