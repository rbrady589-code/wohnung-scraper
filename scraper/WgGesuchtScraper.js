var AbstractScraper = require("./AbstractScraper"),
  request = require("request-promise"),
  cheerio = require("cheerio"),
  urlLib = require("url"),
  moment = require("moment");

/**
 * WG-Gesucht has changed its results markup at least twice: an old table
 * ("#table-compact-list" with .ang_spalte_* cells) and a newer card layout
 * (".wgg_card"). Rather than pin one, `_extractListings` tries each strategy
 * in turn and uses the first that yields rows, reporting which one hit so a
 * silent zero-result run is distinguishable from a layout change.
 *
 * Values are pulled by regex over each row's text rather than by column
 * position, because the column order has changed between layouts and
 * positional parsing quietly mislabels fields when it does.
 */
module.exports = class WgGesuchtScraper extends AbstractScraper {
  constructor(db, globalConfig) {
    super(db, globalConfig, "wgGesucht");
    this.cookieJar = request.jar();
  }

  // ── field parsing ───────────────────────────────────────────────────────

  _parseId(href) {
    if (!href) return null;
    const m = href.match(/\.([0-9]+)\.html/);
    return m ? m[1] : null;
  }

  /**
   * German number formatting: "." groups thousands and "," is the decimal
   * separator, so "1.100" is 1100 and "82,5" is 82.5. Parsing naively turns
   * a 1.100 EUR rent into 1.1.
   */
  _parseGermanNumber(raw) {
    if (!raw) return NaN;
    let s = raw.trim();
    if (/^[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?$/.test(s)) {
      s = s.replace(/\./g, "");           // 1.100.000,50 -> 1100000,50
    }
    return parseFloat(s.replace(",", "."));
  }

  _parseNumber(text, unitPattern) {
    if (!text) return NaN;
    const m = text.match(
      new RegExp(`([0-9]{1,3}(?:\\.[0-9]{3})*(?:,[0-9]+)?|[0-9]+(?:[.,][0-9]+)?)\\s*${unitPattern}`, "i")
    );
    if (!m) return NaN;
    return this._parseGermanNumber(m[1]);
  }

  _parseFreeFrom(text) {
    if (!text) return moment();
    if (/sofort/i.test(text)) return moment();
    const m = text.match(/([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{2,4})/);
    return m ? moment(m[1], "DD.MM.YYYY") : moment();
  }

  // ── extraction strategies ───────────────────────────────────────────────

  _fromCards($) {
    const out = [];
    $("div.wgg_card, .offer_list_item").each((_, el) => {
      const card = $(el);
      if (card.hasClass("housinganywhere_ad")) return;

      const link =
        card.find("h3.truncate_title a").attr("href") ||
        card.find("a.detailansicht").attr("href") ||
        card.find("a[href*='.html']").attr("href");
      const itemId = this._parseId(link);
      if (!itemId) return;

      const text = card.text().replace(/\s+/g, " ").trim();
      out.push({
        itemId,
        href: link,
        title: card.find("h3.truncate_title").text().trim(),
        price: this._parseNumber(text, "€"),
        size: this._parseNumber(text, "m²"),
        rooms: this._parseNumber(text, "Zimmer"),
        freeFrom: this._parseFreeFrom(text),
        hasFreeBis: /bis\s+[0-9]{1,2}\.[0-9]{1,2}\./i.test(text),
        isTagesmiete: /tagesmiete/i.test(text) || card.find('img[alt="Tagesmiete"]').length > 0,
        isTauschangebot: /tauschangebot/i.test(text) || card.find('img[alt="Tauschangebot"]').length > 0,
        isTeaser: card.hasClass("inlistTeaser"),
        isVermietet: card.hasClass("listenansicht-inactive") || /vermietet/i.test(text)
      });
    });
    return out;
  }

  _fromLegacyTable($) {
    const out = [];
    $("#table-compact-list tbody tr").each((_, el) => {
      const row = $(el);
      const href = row.attr("adid");
      const itemId = this._parseId(href);
      if (!itemId) return;
      out.push({
        itemId,
        href,
        title: "",
        price: this._parseNumber(row.find(".ang_spalte_miete").text(), "€?"),
        size: this._parseNumber(row.find(".ang_spalte_groesse").text(), "m²?"),
        rooms: parseInt(row.find(".ang_spalte_zimmer").text().trim(), 10),
        freeFrom: this._parseFreeFrom(row.find(".ang_spalte_freiab").text()),
        hasFreeBis: row.find(".ang_spalte_freibis").text().trim().length > 0,
        isTagesmiete: row.find('img[alt="Tagesmiete"]').length > 0,
        isTauschangebot: row.find('img[alt="Tauschangebot"]').length > 0,
        isTeaser: row.hasClass("inlistTeaser"),
        isVermietet: row.hasClass("listenansicht-inactive")
      });
    });
    return out;
  }

  /**
   * Last resort: any anchor whose href looks like a WG-Gesucht detail page.
   * Yields ids and urls only, so the detail page supplies everything else.
   */
  _fromLinks($) {
    const seen = new Set();
    const out = [];
    $("a[href*='.html']").each((_, el) => {
      const href = $(el).attr("href");
      const itemId = this._parseId(href);
      if (!itemId || seen.has(itemId)) return;
      if (!/wohnung|wg-zimmer|1-zimmer-wohnung|haus/i.test(href)) return;
      seen.add(itemId);
      out.push({
        itemId,
        href,
        title: $(el).text().trim(),
        price: NaN, size: NaN, rooms: NaN,
        freeFrom: moment(),
        hasFreeBis: false,
        isTagesmiete: false, isTauschangebot: false,
        isTeaser: false, isVermietet: false
      });
    });
    return out;
  }

  _extractListings($) {
    const strategies = [
      ["cards", () => this._fromCards($)],
      ["legacy-table", () => this._fromLegacyTable($)],
      ["link-scan", () => this._fromLinks($)]
    ];
    for (const [name, run] of strategies) {
      let rows = [];
      try {
        rows = run();
      } catch (e) {
        console.warn(`[${this.id}] strategy "${name}" threw: ${e.message}`);
        continue;
      }
      if (rows.length > 0) {
        console.log(`[${this.id}] extracted ${rows.length} listing(s) via "${name}"`);
        return rows;
      }
    }
    console.warn(
      `[${this.id}] no listings found by any strategy — the results page layout ` +
        `has changed, or the request was blocked/redirected to a captcha.`
    );
    return [];
  }

  _getNextPage(url, $) {
    const candidates = [
      $("#main_column .pagination-bottom-wrapper ul li a:contains('»')"),
      $("a.next, a[rel='next']"),
      $(".pagination a:contains('»')")
    ];
    for (const c of candidates) {
      if (c && c.length > 0 && c.attr("href")) {
        return urlLib.resolve(url, c.attr("href"));
      }
    }
    return false;
  }

  // ── db mapping ──────────────────────────────────────────────────────────

  async _getDbObject(url, listing, exists) {
    const itemUrl = urlLib.resolve(url, listing.href);
    const data = await this.scrapeItemDetails(itemUrl, exists);

    data.websiteId = listing.itemId;
    data.url = itemUrl;
    data.active = true;
    if (!data.title && listing.title) data.title = listing.title;

    // Detail-page values win; list values fill the gaps.
    if (!Number.isFinite(data.rooms) && Number.isFinite(listing.rooms)) data.rooms = listing.rooms;
    if (!Number.isFinite(data.size) && Number.isFinite(listing.size)) data.size = listing.size;
    if (!Number.isFinite(data.price)) {
      const detailMiete = data.data && data.data.miete;
      data.price = Number.isFinite(detailMiete) ? detailMiete : listing.price;
    }
    data.rooms = Number.isFinite(data.rooms) ? Math.round(data.rooms) : null;
    data.size = Number.isFinite(data.size) ? Math.round(data.size) : null;
    data.price = Number.isFinite(data.price) ? Math.round(data.price) : null;
    data.free_from = listing.freeFrom.toISOString();
    return data;
  }

  async _scrapeItem(url, listing) {
    const isInDb = await this.hasItemInDb(listing.itemId);

    const ignore =
      listing.isTagesmiete ||
      listing.isTauschangebot ||
      listing.isTeaser ||
      listing.hasFreeBis;

    if (ignore) {
      if (isInDb) {
        await this.removeFromDb(listing.itemId);
        return true;
      }
      return false;
    }

    if (listing.isVermietet) {
      if (!isInDb) return false;
      const data = await this._getDbObject(url, listing, true);
      await this.updateInDb(data);
      return { type: "updated", data };
    }

    if (isInDb) return false;
    const data = await this._getDbObject(url, listing, false);
    const { lastID } = await this.insertIntoDb(data);
    return { type: "added", id: lastID, data };
  }

  _getRequestOptions() {
    return {
      resolveWithFullResponse: true,
      jar: this.cookieJar,
      ...this.globalConfig.httpOptions
    };
  }

  async scrapeItemDetails(url, exists) {
    const { body, statusCode } = await this.doRequest(
      url,
      request.get(url, this._getRequestOptions())
    );

    const result = {};
    result.gone = statusCode !== 200;
    try {
      const latLngParts = String(body).match(
        /"lat"\s*:\s*"?([0-9.]+)"?\s*,\s*"lng"\s*:\s*"?([0-9.]+)"?/
      );
      if (latLngParts) {
        result.latitude = parseFloat(latLngParts[1]);
        result.longitude = parseFloat(latLngParts[2]);
      } else {
        result.latitude = NaN;
        result.longitude = NaN;
      }

      const $ = cheerio.load(body);

      result.title =
        $("#sliderTopTitle").text().trim() ||
        $("h1").first().text().trim();

      const kosten = $('.headline-detailed-view-panel-title:contains("Kosten")+table');
      const cost = (label) => {
        const raw = kosten.find(`td:contains('${label}')+td`).text().trim();
        const n = parseInt(raw.replace(/[^0-9]/g, ""), 10);
        return Number.isNaN(n) ? null : n;
      };

      const adresse =
        $('.headline-detailed-view-panel-title:contains("Adresse")+a').text().trim() ||
        $("a[href*='maps.google'], a[href*='openstreetmap']").first().text().trim();

      result.data = {
        miete: cost("Miete"),
        nebenkosten: cost("Nebenkosten"),
        sonstigeKosten: cost("Sonstige Kosten"),
        kaution: cost("Kaution"),
        adresse
      };
    } catch (ex) {
      console.log("CAUGHT error while scraping item", this.id, url, ex);
      result.gone = true;
      if (result.removed == null) result.removed = new Date();
    }

    if (result.gone || exists) return result;

    if (Number.isNaN(result.latitude) || Number.isNaN(result.longitude)) {
      try {
        const resolved = await this.getLocationOfAddress(result.data.adresse);
        result.latitude = resolved.latitude;
        result.longitude = resolved.longitude;
      } catch (_) {
        // Leave coordinates unset; the row is still stored and can be
        // located later via the /update/location endpoint.
      }
    }
    return result;
  }

  async scrapeSite(url) {
    const { body } = await this.doRequest(
      url,
      request.get(url, this._getRequestOptions())
    );

    const $ = cheerio.load(body);
    const listings = this._extractListings($);

    const results = [];
    for (const listing of listings) {
      try {
        results.push(await this._scrapeItem(url, listing));
      } catch (e) {
        console.warn(`[${this.id}] item ${listing.itemId} failed: ${e.message}`);
      }
    }

    const nextPageUrl = this._getNextPage(url, $);
    if (nextPageUrl !== false && this.scrapeSiteCounter < this.config.maxPages) {
      this.scrapeSiteCounter++;
      results.push(await this.scrapeSite(nextPageUrl));
    }
    return results;
  }
};
