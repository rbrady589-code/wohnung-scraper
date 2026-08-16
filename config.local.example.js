/**
 * Minimal local config — no API keys, no network calls at startup.
 *
 *   cp config.local.example.js config.js
 *   npm run dev
 *
 * config.template.js is the full-featured version, but it fetches NextBike
 * and OSM Overpass overlays while loading and wants a Mapbox key, so it is a
 * poor starting point for just getting the app on screen. Start here, then
 * copy pieces across from the template as you want them.
 *
 * Adjust `dataFilter` and `filters.default` to your own search: those two
 * drive which listings are considered interesting.
 */

const { DateTime } = require("luxon");

module.exports = async () => ({
  baseUrl: "http://localhost:3000/",

  // Basic auth for the whole app. Change these.
  auth: {
    username: process.env.APP_USER || "admin",
    password: process.env.APP_PASS || "changeme"
  },

  database: "data/wohnungen.db",

  map: {
    initialView: { lat: 52.5065, lng: 13.3855, zoom: 12 },
    // Only the keyless OpenStreetMap layer. The template adds public
    // transport, satellite and noise layers, which need a Mapbox key.
    layers: [require("./map-content/layers/openstreetmap").Default],
    overlays: []
  },

  // The macro filter: listings within `radius` metres of these points are
  // the ones treated as relevant. Multiple entries are OR-ed together.
  dataFilter: [
    {
      lat: 52.5065,
      lng: 13.3855,
      radius: 6000
    }
  ],
  dataFilterRange: { min: 500, max: 12000, step: 100, ticks: 1000 },

  // Drives the map colour scale, low (green) to high (red).
  pricePerSqM: { min: 8, max: 24 },

  filters: {
    // Outer bounds of each slider.
    limits: {
      price: { min: 0, max: 3000 },
      rooms: { min: 1, max: 8 },
      size: { min: 0, max: 220 },
      free_from: {
        min: "now",
        max: DateTime.utc().startOf("month").plus({ months: 6 }).toISODate()
      },
      age: {
        min: DateTime.utc().startOf("month").plus({ months: -6 }).toISODate(),
        max: "now"
      }
    },
    // Where the sliders start. This is your actual search.
    default: {
      hideInactive: true,
      showOnlyFavs: false,
      price: { min: 0, max: 1600 },
      rooms: { min: 2, max: 5 },
      size: { min: 45, max: 160 },
      free_from: {
        min: "now",
        max: DateTime.utc().startOf("month").plus({ months: 3 }).toISODate()
      },
      age: {
        min: DateTime.utc().startOf("month").plus({ months: -3 }).toISODate(),
        max: "now"
      }
    }
  },

  // Notifications off. Add a key and set enabled:true when you want them.
  bots: [
    {
      id: "telegram",
      enabled: false,
      key: process.env.TELEGRAM_BOT_KEY || "",
      chats: [process.env.TELEGRAM_CHAT_ID || ""]
    }
  ],

  transportTimeMapnificentConfig: { cityid: "berlin" },
  defaultTransportTime: 30,
  defaultShowTransportRangeAutomatically: false,
  transportRoutes: { provider: "berlin_vbb", options: { berlin_vbb: {} } },

  cronTimes: {
    scrape: "0,20,45 * * * *",
    update: "30 * * * *"
  },

  city: "Berlin",

  // Only consulted when a scraper has to turn a free-text address into
  // coordinates. Kleinanzeigen and the ImmoScout mobile API both return
  // coordinates directly and never reach this.
  geocoder: {
    provider: "here",
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

  scraper: {
    kleinanzeigenapi: {
      name: "Kleinanzeigen",
      url: "https://api.kleinanzeigen.de/api/ads.json?adType=OFFERED&categoryId=203&distance=20&histograms=CATEGORY&includeTopAds=false&limitTotalResultCount=false&locationId=4252&size=100",
      username: process.env.KLEINANZEIGEN_USER || "ipad",
      password: process.env.KLEINANZEIGEN_PASS || "g4Zi9q10",
      maxPages: 1
    },
    wgGesucht: {
      name: "wg-gesucht.de",
      url: "https://www.wg-gesucht.de/wohnungen-in-Berlin.8.2.1.0.html",
      maxPages: 3
    }
    // immoscout24api needs clientId/clientSecret from the mobile app; leave
    // it out until those are available, or it just fails to authenticate.
  }
});
