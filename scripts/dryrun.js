#!/usr/bin/env node
/**
 * Standalone scraper dry-run.
 *
 * Runs a single scraper without the express server, the cron schedule, the
 * telegram bot or the map frontend, so you can find out whether a provider
 * still works in about a minute.
 *
 *   node scripts/dryrun.js kleinanzeigenapi
 *   node scripts/dryrun.js wgGesucht
 *   node scripts/dryrun.js wgGesucht --fixture fixtures/wg-gesucht-results.html
 *
 * Flags:
 *   --fixture <path>  Parse a saved HTML file instead of hitting the network.
 *                     Use this to verify selectors offline.
 *   --db <path>       SQLite file to use (default: data/dryrun.db).
 *   --keep            Keep the database between runs. Default is to start
 *                     fresh, so every listing counts as "new" and gets printed.
 *
 * Nothing here sends a message to anybody. It only reads and writes SQLite.
 */

const fs = require("fs");
const path = require("path");
const sqlite = require("sqlite");
const sqlite3 = require("sqlite3");
const DBMigrate = require("db-migrate");

const ROOT = path.resolve(__dirname, "..");

// ── Args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const scraperId = argv.find((a) => !a.startsWith("--"));

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}
const fixturePath = flag("fixture");
const dbPath = flag("db") || path.join(ROOT, "data", "dryrun.db");
const keepDb = argv.includes("--keep");

// Maps a scraper config id to the module that implements it.
const MODULES = {
  wgGesucht: "WgGesuchtScraper",
  studentenWg: "StudentenWgScraper",
  immoscout24: "ImmoscoutScraper",
  immoscout24api: "ImmoscoutApiScraper",
  immonet: "ImmonetScraper",
  kleinanzeigenapi: "KleinanzeigenApiScraper"
};

if (!scraperId || !MODULES[scraperId]) {
  console.error(
    `Usage: node scripts/dryrun.js <${Object.keys(MODULES).join("|")}> [--fixture <path>] [--db <path>] [--keep]`
  );
  process.exit(1);
}

// ── Minimal config ────────────────────────────────────────────────────────
//
// Deliberately not config.template.js: that one fetches NextBike and OSM
// Overpass overlays at module load, which is slow and irrelevant here.
//
// The Kleinanzeigen credentials below are the ones already published in
// config.template.js. Override them with KLEINANZEIGEN_USER / _PASS if they
// have rotated.

const config = {
  // Only consulted if a scraper needs to geocode a free-text address.
  // Kleinanzeigen and the ImmoScout mobile API both return coordinates
  // directly, so they never reach this.
  geocoder: {
    provider: process.env.GEOCODER_PROVIDER || "here",
    options: {
      here: {
        appId: process.env.HERE_APP_ID || "",
        appCode: process.env.HERE_APP_CODE || ""
      },
      google: { apiKey: process.env.GOOGLE_MAPS_KEY || "" },
      mapquest: { apiKey: process.env.MAPQUEST_KEY || "" }
    }
  },

  httpOptions: {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8"
    }
  },

  // Empty list => no notifications are ever sent, whatever the scraper finds.
  bots: [],

  scraper: {
    wgGesucht: {
      name: "wg-gesucht.de",
      url: "https://www.wg-gesucht.de/wohnungen-in-Berlin.8.2.1.0.html",
      maxPages: 1
    },
    studentenWg: {
      name: "studenten-wg.de",
      url: "https://www.studenten-wg.de/angebote_lesen.html?stadt=Berlin",
      maxPages: 1
    },
    immoscout24: {
      name: "immobilienscout24.de",
      url: "https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten",
      maxPages: 1
    },
    immoscout24api: {
      name: "immobilienscout24.de",
      url: "https://api.mobile.immobilienscout24.de/search?searchType=region&realestatetype=apartmentrent&pagesize=20&sorting=-firstactivation",
      clientId: process.env.IS24_CLIENT_ID || "",
      clientSecret: process.env.IS24_CLIENT_SECRET || "",
      userAgent: process.env.IS24_USER_AGENT || "",
      maxPages: 1
    },
    immonet: {
      name: "immonet.de",
      url: "https://www.immonet.de/immobiliensuche/sel.do?city=87372&sortby=19",
      maxPages: 1
    },
    kleinanzeigenapi: {
      name: "Kleinanzeigen",
      url: "https://api.kleinanzeigen.de/api/ads.json?adType=OFFERED&categoryId=203&distance=20&histograms=CATEGORY&includeTopAds=false&limitTotalResultCount=false&locationId=4252&size=50",
      username: process.env.KLEINANZEIGEN_USER || "ipad",
      password: process.env.KLEINANZEIGEN_PASS || "g4Zi9q10",
      maxPages: 1
    }
  }
};

// ── Runner ────────────────────────────────────────────────────────────────

async function openDb() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!keepDb && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  const dbm = DBMigrate.getInstance(true, {
    cwd: ROOT,
    config: { dryrun: { driver: "sqlite3", filename: dbPath } },
    env: "dryrun"
  });
  dbm.silence(true);
  await dbm.up();
  return sqlite.open({ filename: dbPath, driver: sqlite3.Database });
}

function summarise(db) {
  return db.all(
    `SELECT websiteId, title, price, size, rooms, latitude, longitude, free_from, url
       FROM wohnungen ORDER BY rowid`
  );
}

async function main() {
  console.log(`\n▶ dry run: ${scraperId}`);
  console.log(`  db      : ${dbPath}${keepDb ? " (kept)" : " (fresh)"}`);
  console.log(`  source  : ${fixturePath ? `fixture ${fixturePath}` : config.scraper[scraperId].url}`);
  console.log("");

  const db = await openDb();
  const Klass = require(path.join(ROOT, "scraper", MODULES[scraperId]));
  const scraper = await new Klass(db, config).init();

  if (!scraper) {
    console.error(`✗ ${scraperId} has no config entry — nothing to run.`);
    process.exit(1);
  }

  const started = Date.now();

  if (fixturePath) {
    // Feed a saved page straight into the scraper's parser by intercepting
    // the single network call it makes for the results page. Detail-page
    // requests still go out, so use this to check list selectors only.
    const html = fs.readFileSync(path.resolve(fixturePath), "utf8");
    const realDoRequest = scraper.doRequest.bind(scraper);
    let servedFixture = false;
    scraper.doRequest = async (url, req) => {
      if (!servedFixture) {
        servedFixture = true;
        console.log(`  (serving fixture in place of ${url})`);
        // Swallow the real request so it never leaves the machine.
        Promise.resolve(req).catch(() => {});
        return { statusCode: 200, body: html, status: 200 };
      }
      return realDoRequest(url, req);
    };
  }

  try {
    await scraper.scrape();
  } catch (e) {
    console.error(`\n✗ scrape threw: ${e.message}`);
    console.error(e.stack);
  }

  const rows = await summarise(db);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${"─".repeat(72)}`);
  if (rows.length === 0) {
    console.log(`✗ 0 listings stored after ${elapsed}s.`);
    console.log("");
    console.log("  That means one of:");
    console.log("    • the selectors no longer match the page (most likely for HTML scrapers)");
    console.log("    • credentials were rejected (API scrapers)");
    console.log("    • the request was blocked");
    console.log("");
    console.log("  Re-run with a saved copy of the results page to tell those apart:");
    console.log(`    node scripts/dryrun.js ${scraperId} --fixture <saved.html>`);
  } else {
    console.log(`✓ ${rows.length} listing(s) stored in ${elapsed}s\n`);
    for (const r of rows.slice(0, 15)) {
      const geo =
        r.latitude && r.longitude
          ? `${r.latitude.toFixed(4)},${r.longitude.toFixed(4)}`
          : "no geo";
      console.log(
        `  ${String(r.price ?? "?").padStart(5)} €  ` +
          `${String(r.size ?? "?").padStart(4)} m²  ` +
          `${String(r.rooms ?? "?").padStart(3)} Zi  ` +
          `${geo.padEnd(18)}  ${(r.title || "").slice(0, 40)}`
      );
    }
    if (rows.length > 15) console.log(`  … and ${rows.length - 15} more`);

    const noGeo = rows.filter((r) => !r.latitude || !r.longitude).length;
    if (noGeo > 0) {
      console.log(
        `\n  ⚠ ${noGeo} listing(s) have no coordinates — those are invisible to the ` +
          `radius filter and to the map.`
      );
    }
  }
  console.log(`${"─".repeat(72)}\n`);

  // Prepared statements hold the connection open; finalize them or close()
  // fails with SQLITE_BUSY.
  await Promise.all(
    Object.values(scraper.statements || {}).map((s) =>
      s.finalize().catch(() => {})
    )
  );
  await db.close();
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
