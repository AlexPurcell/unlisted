/* Unlisted — find local businesses with no website.
 *
 * Runs entirely in the browser. No backend, no API keys, no build step.
 * Two public OpenStreetMap services are used directly, both CORS-open:
 *   Nominatim  — turns a typed place name into a bounding box
 *   Overpass   — returns the mapped businesses inside that box
 *
 * Both are volunteer-funded. This file caches aggressively and rate-limits
 * itself so that a popular tool does not become a burden on them. Anyone
 * running this at real volume should point OVERPASS_ENDPOINTS at their own
 * Overpass instance — see README.
 */
(function () {
  "use strict";

  var NOMINATIM = "https://nominatim.openstreetmap.org/search";
  var OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];

  var GEOCODE_TIMEOUT_MS = 12000;
  var QUERY_TIMEOUT_MS = 30000;
  var MAX_CACHE_BYTES = 2000000; // don't try to stuff a huge city into localStorage

  var CACHE_PREFIX = "unlisted:v1:";
  var CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // a week; business data moves slowly
  var MAX_BBOX_DEG2 = 0.6;   // guard against continent-sized queries
  var MIN_GAP_MS = 3000;     // minimum spacing between outbound searches

  // OSM tag selectors: "a business a website would plausibly help".
  // Explicit rather than everything-with-a-name, so the list stays a credible
  // prospect list instead of including parks and bus stops.
  var SELECTORS = [
    'nwr["shop"]',
    'nwr["craft"]',
    'nwr["amenity"~"^(restaurant|cafe|bar|pub|fast_food|ice_cream|dentist|doctors|veterinary|pharmacy|clinic|bank|fuel|car_wash|car_rental|driving_school|childcare|funeral_directors)$"]',
    'nwr["office"~"^(insurance|estate_agent|lawyer|accountant|financial|employment_agency|travel_agent|company)$"]',
    'nwr["leisure"~"^(fitness_centre|sports_centre|dance|golf_course)$"]',
    'nwr["tourism"~"^(hotel|motel|guest_house|bed_and_breakfast)$"]',
    'nwr["healthcare"]'
  ];

  // Categories where a working site most directly drives revenue. A scoring
  // nudge, not a hard filter.
  var HIGH_VALUE = {
    restaurant:1, cafe:1, bar:1, pub:1, fast_food:1, ice_cream:1, bakery:1, butcher:1,
    hairdresser:1, beauty:1, nails:1, tattoo:1, massage:1, spa:1, optician:1,
    car_repair:1, car_parts:1, tyres:1, motorcycle_repair:1,
    hvac:1, plumber:1, electrician:1, carpenter:1, roofer:1, painter:1, builder:1,
    gardener:1, landscaper:1, cleaning:1, locksmith:1,
    dentist:1, doctors:1, veterinary:1, clinic:1, physiotherapist:1,
    insurance:1, estate_agent:1, lawyer:1, accountant:1, financial:1, travel_agent:1,
    hotel:1, motel:1, guest_house:1, bed_and_breakfast:1,
    fitness_centre:1, sports_centre:1, dance:1, driving_school:1, childcare:1,
    florist:1, jewelry:1, furniture:1, boutique:1, clothes:1, photo:1, gift:1,
    funeral_directors:1
  };

  var SOCIAL_KEYS = [
    "contact:facebook", "facebook", "contact:instagram", "instagram"
  ];

  // ---------- tiny DOM helpers ----------

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  var ui = {
    form:    $("#searchForm"),
    input:   $("#placeInput"),
    btn:     $("#searchBtn"),
    status:  $("#status"),
    shell:   $("#resultsShell"),
    statbar: $("#statbar"),
    body:    $("#resultsBody"),
    note:    $("#tableNote"),
    cat:     $("#catFilter"),
    phone:   $("#phoneOnly"),
    chains:  $("#includeChains"),
    exportBtn: $("#exportBtn")
  };

  var state = {
    all: [],
    place: "",
    presence: "none",
    category: "",
    phoneOnly: false,
    includeChains: false,
    sortKey: "score",
    sortDir: -1,
    lastRun: 0
  };

  function setStatus(msg, kind) {
    ui.status.innerHTML = "";
    if (!msg) return;
    var span = el("span", kind || "", msg);
    ui.status.appendChild(span);
  }

  // ---------- cache ----------

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || (Date.now() - obj.t) > CACHE_TTL_MS) return null;
      return obj.v;
    } catch (e) { return null; }
  }

  function cacheSet(key, value) {
    try {
      var payload = JSON.stringify({ t: Date.now(), v: value });
      if (payload.length > MAX_CACHE_BYTES) return; // a dense city can exceed the quota alone
      localStorage.setItem(CACHE_PREFIX + key, payload);
    } catch (e) { /* quota or private mode — caching is an optimisation, not a requirement */ }
  }

  // fetch() has no built-in timeout: a hung mirror would otherwise leave the
  // whole app spinning with no feedback and no way to fall through to the next
  // endpoint. Every outbound request goes through here.
  function fetchWithTimeout(url, opts, ms) {
    opts = opts || {};
    if (typeof AbortController === "undefined") return fetch(url, opts);
    var ctrl = new AbortController();
    opts.signal = ctrl.signal;
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, opts).then(
      function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  // ---------- geocoding ----------

  function geocode(place) {
    var key = "geo:" + place.toLowerCase().trim();
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);

    var url = NOMINATIM + "?" + new URLSearchParams({
      q: place, format: "jsonv2", limit: "1", addressdetails: "0"
    }).toString();

    return fetchWithTimeout(url, { headers: { "Accept": "application/json" } }, GEOCODE_TIMEOUT_MS)
      .then(function (r) {
        if (!r.ok) throw new Error("Geocoder returned HTTP " + r.status);
        return r.json();
      })
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error("NOTFOUND");
        var r = rows[0];
        // Nominatim boundingbox is [south, north, west, east] as strings.
        var bb = r.boundingbox.map(Number);
        var out = {
          label: r.display_name,
          south: bb[0], north: bb[1], west: bb[2], east: bb[3]
        };
        cacheSet(key, out);
        return out;
      });
  }

  // ---------- overpass ----------

  function buildQuery(bb) {
    var box = [bb.south, bb.west, bb.north, bb.east].join(",");
    var parts = SELECTORS.map(function (s) { return "  " + s + "(" + box + ");"; }).join("\n");
    return "[out:json][timeout:60];\n(\n" + parts + "\n);\nout center tags;";
  }

  function overpass(query, onTry) {
    var idx = 0;
    function attempt() {
      if (idx >= OVERPASS_ENDPOINTS.length) {
        throw new Error("Every public OpenStreetMap query server is busy or " +
          "unreachable right now. This happens — wait a minute and try again.");
      }
      var endpoint = OVERPASS_ENDPOINTS[idx++];
      if (onTry) onTry(idx, OVERPASS_ENDPOINTS.length);
      return fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }).toString()
      }, QUERY_TIMEOUT_MS)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(function (text) {
          // Overpass answers with an HTML error page when overloaded.
          if (text.slice(0, 40).indexOf("{") === -1) throw new Error("server busy");
          return JSON.parse(text);
        })
        .catch(function () { return attempt(); });
    }
    return Promise.resolve().then(attempt);
  }

  // ---------- shaping ----------

  function pickCategory(tags) {
    var keys = ["shop", "craft", "amenity", "office", "leisure", "tourism", "healthcare"];
    for (var i = 0; i < keys.length; i++) {
      if (tags[keys[i]]) return tags[keys[i]];
    }
    return "";
  }

  function normalizeWebsite(tags) {
    var raw = tags.website || tags["contact:website"] || tags.url || "";
    raw = String(raw).split(";")[0].trim();
    if (!raw || /^(no|none|n\/a)$/i.test(raw)) return "";
    // A website tag that just points at Facebook is not a website.
    if (/^(https?:\/\/)?(www\.)?(facebook|instagram|linktr)\./i.test(raw)) return "";
    return raw;
  }

  function socialOf(tags) {
    for (var i = 0; i < SOCIAL_KEYS.length; i++) {
      if (tags[SOCIAL_KEYS[i]]) return String(tags[SOCIAL_KEYS[i]]).trim();
    }
    // A website tag pointing at a social profile counts as social presence.
    var raw = String(tags.website || tags["contact:website"] || "").trim();
    if (/^(https?:\/\/)?(www\.)?(facebook|instagram|linktr)\./i.test(raw)) return raw;
    return "";
  }

  // A franchise of a national chain shows up with no `website` tag on its local
  // node, but the brand obviously has a website — and head office, not the
  // store manager, buys the web work. OSM marks these with brand/operator tags,
  // which makes them cleanly removable. Measured on one real US test town: 27
  // of 52 websiteless restaurants were chains. Left in, they ruin the list.
  function isChain(t) {
    return !!(t.brand || t["brand:wikidata"] || t.operator || t["operator:wikidata"]);
  }

  function toRecord(e) {
    var t = e.tags || {};
    var name = (t.name || "").trim();
    if (!name) return null;

    var website = normalizeWebsite(t);
    var social = socialOf(t);
    var presence = website ? "site" : (social ? "social" : "none");

    var street = [t["addr:housenumber"], t["addr:street"]]
      .filter(Boolean).join(" ").trim();

    return {
      id: e.type + "/" + e.id,
      name: name,
      category: pickCategory(t),
      presence: presence,
      chain: isChain(t),
      brand: (t.brand || t.operator || "").trim(),
      website: website,
      social: social,
      street: street,
      city: (t["addr:city"] || "").trim(),
      postcode: (t["addr:postcode"] || "").trim(),
      phone: (t.phone || t["contact:phone"] || "").trim(),
      email: (t.email || t["contact:email"] || "").trim(),
      lat: e.lat || (e.center && e.center.lat),
      lon: e.lon || (e.center && e.center.lon)
    };
  }

  function score(r) {
    var s = 0;
    if (r.presence === "none") s += 40;
    else if (r.presence === "social") s += 32;

    if (r.phone) s += 14;
    if (r.email) s += 8;
    if (!r.phone && !r.email) s -= 6;
    if (r.street) s += 5;
    if (HIGH_VALUE[r.category]) s += 10;
    return s;
  }

  function dedupe(records) {
    var seen = {};
    var out = [];
    records.forEach(function (r) {
      // OSM commonly holds both a node and a building way for one business.
      var key = (r.name.toLowerCase() + "|" + r.street.toLowerCase());
      var prev = seen[key];
      if (prev === undefined) {
        seen[key] = out.length;
        out.push(r);
        return;
      }
      var richer = function (x) {
        return (x.website ? 1 : 0) + (x.phone ? 1 : 0) + (x.email ? 1 : 0) + (x.street ? 1 : 0);
      };
      if (richer(r) > richer(out[prev])) out[prev] = r;
    });
    return out;
  }

  // ---------- rendering ----------

  function prettyCat(c) {
    return c ? c.replace(/_/g, " ") : "—";
  }

  // Everything the current chain setting allows. Stats and the table share this
  // so the numbers on screen always describe the rows on screen.
  function base() {
    return state.includeChains
      ? state.all
      : state.all.filter(function (r) { return !r.chain; });
  }

  function visible() {
    return base().filter(function (r) {
      if (state.presence !== "all" && r.presence !== state.presence) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.phoneOnly && !r.phone) return false;
      return true;
    }).sort(function (a, b) {
      // sortDir consistently means -1 = descending, +1 = ascending for every
      // column, so the visible sort-arrow indicator is never lying about
      // which way a column is actually sorted.
      var k = state.sortKey;
      if (k === "name") return a.name.localeCompare(b.name) * state.sortDir;
      return (a.score - b.score) * state.sortDir;
    });
  }

  function renderStats() {
    var all = base();
    var none = all.filter(function (r) { return r.presence === "none"; }).length;
    var social = all.filter(function (r) { return r.presence === "social"; }).length;
    var site = all.filter(function (r) { return r.presence === "site"; }).length;
    var pct = all.length ? Math.round(((none + social) / all.length) * 100) : 0;
    var chains = state.all.length - all.length;

    var cells = [
      [state.includeChains ? "Businesses mapped" : "Independents mapped", all.length, false],
      ["No website", none, true],
      ["Social only", social, false],
      ["Has a website", site, false],
      ["Without a real site", pct + "%", true]
    ];
    if (chains > 0) cells.push(["Chains filtered out", chains, false]);

    ui.statbar.innerHTML = "";
    cells.forEach(function (c) {
      var d = el("div", "stat" + (c[2] ? " hot" : ""));
      d.appendChild(el("span", "v", String(c[1])));
      d.appendChild(el("span", "k", c[0]));
      ui.statbar.appendChild(d);
    });
  }

  function renderCategories() {
    var counts = {};
    base().forEach(function (r) {
      if (r.category) counts[r.category] = (counts[r.category] || 0) + 1;
    });
    var names = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    ui.cat.innerHTML = "";
    ui.cat.appendChild(new Option("All categories", ""));
    names.forEach(function (n) {
      ui.cat.appendChild(new Option(prettyCat(n) + " (" + counts[n] + ")", n));
    });
    ui.cat.value = state.category;
  }

  // Visual feedback for which column is sorted and which direction -- the
  // click behavior existed already but gave no indication of current state.
  function updateSortIndicators() {
    Array.prototype.forEach.call(document.querySelectorAll(".sortbtn"), function (b) {
      if (b.dataset.sort === state.sortKey) {
        b.setAttribute("data-dir", state.sortDir === -1 ? "desc" : "asc");
      } else {
        b.removeAttribute("data-dir");
      }
    });
  }

  function renderTable() {
    var rows = visible();
    ui.body.innerHTML = "";

    updateSortIndicators();

    if (!rows.length) {
      var tr = el("tr", "empty-row");
      var td = el("td", "empty", "No businesses match these filters.");
      td.colSpan = 6;
      tr.appendChild(td);
      ui.body.appendChild(tr);
      ui.note.textContent = "";
      return;
    }

    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var tr = el("tr");

      var tdS = el("td"); tdS.setAttribute("data-label", "Score");
      tdS.appendChild(el("span", "score", String(r.score)));
      tr.appendChild(tdS);

      var tdN = el("td"); tdN.setAttribute("data-label", "Business");
      tdN.appendChild(el("div", "bname", r.name));
      if (r.chain) {
        tdN.appendChild(el("div", "baddr", "chain" + (r.brand ? ": " + r.brand : "")));
      }
      if (r.social) {
        tdN.appendChild(el("div", "baddr", "social: " + r.social.replace(/^https?:\/\//, "")));
      } else if (r.website) {
        tdN.appendChild(el("div", "baddr", r.website.replace(/^https?:\/\//, "")));
      }
      tr.appendChild(tdN);

      var tdC = el("td", "bcat", prettyCat(r.category));
      tdC.setAttribute("data-label", "Type");
      tr.appendChild(tdC);

      var tdP = el("td"); tdP.setAttribute("data-label", "Presence");
      var label = r.presence === "none" ? "No website"
        : r.presence === "social" ? "Social only" : "Has a site";
      tdP.appendChild(el("span", "tag " + r.presence, label));
      tr.appendChild(tdP);

      var addr = [r.street, r.city, r.postcode].filter(Boolean).join(", ");
      var tdA = el("td", "baddr", addr || "—");
      tdA.setAttribute("data-label", "Address");
      tr.appendChild(tdA);

      var tdPh = el("td", "bphone", r.phone || "—");
      tdPh.setAttribute("data-label", "Phone");
      tr.appendChild(tdPh);

      frag.appendChild(tr);
    });
    ui.body.appendChild(frag);

    ui.note.textContent = "Showing " + rows.length + " of " + base().length +
      (state.includeChains ? " mapped businesses in " : " independent businesses in ") +
      state.place +
      ". “No website” means no website recorded in OpenStreetMap — worth one call to confirm before you pitch.";
  }

  function renderAll() {
    renderStats();
    renderCategories();
    renderTable();
    ui.shell.hidden = false;
  }

  // ---------- csv ----------

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    // Guard against spreadsheet formula injection: OSM is world-editable, so a
    // name field could hold =HYPERLINK(...) or @SUM(...).
    //
    // Deliberately narrow. Blanket-escaping anything starting with + or -
    // mangles real data: every negative longitude (-88.69) imports as text and
    // breaks mapping, and every international phone (+1-270-...) picks up a
    // stray apostrophe. So + and - only trip the guard when the value could
    // actually name a function — i.e. it contains a letter or an opening paren.
    var risky = /^[=@\t\r]/.test(s) ||
                (/^[+\-]/.test(s) && /[A-Za-z(]/.test(s));
    if (risky) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    var rows = visible();
    if (!rows.length) { setStatus("Nothing to export with these filters.", "err"); return; }

    var head = ["score", "name", "category", "web_presence", "website_or_social",
                "is_chain", "brand", "street", "city", "postcode", "phone", "email",
                "latitude", "longitude", "osm_id"];
    var lines = [head.join(",")];
    rows.forEach(function (r) {
      lines.push([
        r.score, r.name, r.category, r.presence, r.website || r.social,
        r.chain ? "yes" : "no", r.brand,
        r.street, r.city, r.postcode, r.phone, r.email,
        r.lat, r.lon, r.id
      ].map(csvCell).join(","));
    });
    lines.push("");
    lines.push(csvCell("Business data (c) OpenStreetMap contributors, ODbL. Exported by Unlisted."));

    var blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "unlisted-" + state.place.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 40) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---------- shareable URL ----------
  //
  // A search someone spent real time filtering is worth sending to a
  // colleague or bookmarking. Without this, "?place=" never existed, so a
  // shared link or the back button after searching just landed back on the
  // bare homepage with no way to recover what was being looked at.

  function placeFromLocation() {
    var p = new URLSearchParams(window.location.search).get("place");
    return p ? p.trim() : "";
  }

  function pushPlaceUrl(place) {
    var url = new URL(window.location.href);
    if (place) url.searchParams.set("place", place);
    else url.searchParams.delete("place");
    history.pushState({ place: place || "" }, "", url.pathname + url.search);
  }

  // ---------- search ----------

  function run(place, opts) {
    opts = opts || {};
    var since = Date.now() - state.lastRun;
    if (since < MIN_GAP_MS) {
      setStatus("Give the OpenStreetMap servers a moment — try again in " +
        Math.ceil((MIN_GAP_MS - since) / 1000) + "s.", "err");
      return;
    }
    state.lastRun = Date.now();
    if (opts.pushState !== false) pushPlaceUrl(place);

    ui.btn.disabled = true;
    setStatus("Looking up " + place + "…", "working");

    geocode(place)
      .then(function (bb) {
        var area = Math.abs(bb.north - bb.south) * Math.abs(bb.east - bb.west);
        if (area > MAX_BBOX_DEG2) {
          throw new Error("TOOBIG");
        }
        state.place = place;
        setStatus("Reading the map around " + bb.label.split(",").slice(0, 2).join(",") +
          "… this can take a few seconds.", "working");

        var cacheKey = "ov:" + [bb.south, bb.west, bb.north, bb.east].join(",");
        var cached = cacheGet(cacheKey);
        if (cached) return { data: cached, cached: true };

        return overpass(buildQuery(bb), function (n, total) {
          if (n > 1) {
            setStatus("First map server was busy — trying mirror " + n + " of " +
              total + "…", "working");
          }
        }).then(function (data) {
          cacheSet(cacheKey, data);
          return { data: data, cached: false };
        });
      })
      .then(function (res) {
        var elements = (res.data && res.data.elements) || [];
        var records = dedupe(
          elements.map(toRecord).filter(Boolean)
        );
        records.forEach(function (r) { r.score = score(r); });
        state.all = records;

        if (!records.length) {
          ui.shell.hidden = true;
          setStatus("No mapped businesses found there. Coverage in OpenStreetMap varies — " +
            "try a nearby larger town, or a more specific place name.", "err");
          return;
        }
        renderAll();
        var shown = base();
        var gaps = shown.filter(function (r) { return r.presence !== "site"; }).length;
        setStatus(gaps + " of " + shown.length + " independent businesses have no real website" +
          (res.cached ? " (from your local cache)" : "") + ".");
      })
      .catch(function (err) {
        ui.shell.hidden = true;
        if (err && err.message === "NOTFOUND") {
          setStatus("Couldn't find that place. Try adding the state or country — " +
            "“Asheville, North Carolina” rather than “Asheville”.", "err");
        } else if (err && err.message === "TOOBIG") {
          setStatus("That area is too large to query in one go. Search a single town or " +
            "city rather than a whole state or country.", "err");
        } else {
          setStatus((err && err.message) || "Something went wrong.", "err");
        }
      })
      .then(function () { ui.btn.disabled = false; });
  }

  // ---------- wiring ----------

  ui.form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = ui.input.value.trim();
    if (v) run(v);
  });

  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
    c.addEventListener("click", function () {
      ui.input.value = c.dataset.place;
      run(c.dataset.place);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll(".seg-btn"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".seg-btn"), function (x) {
        x.classList.remove("is-on");
      });
      b.classList.add("is-on");
      state.presence = b.dataset.presence;
      renderTable();
    });
  });

  ui.cat.addEventListener("change", function () {
    state.category = ui.cat.value;
    renderTable();
  });

  ui.phone.addEventListener("change", function () {
    state.phoneOnly = ui.phone.checked;
    renderTable();
  });

  ui.chains.addEventListener("change", function () {
    state.includeChains = ui.chains.checked;
    // Chain filtering changes the denominator, so the stats and the category
    // counts have to be rebuilt too, not just the rows.
    renderAll();
  });

  Array.prototype.forEach.call(document.querySelectorAll(".sortbtn"), function (b) {
    b.addEventListener("click", function () {
      var k = b.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = -1; }
      renderTable();
    });
  });

  ui.exportBtn.addEventListener("click", exportCsv);

  // Back/forward should feel like undo/redo through searches, not a dead end
  // that dumps the visitor back on a blank homepage.
  window.addEventListener("popstate", function (e) {
    var place = (e.state && e.state.place) || placeFromLocation();
    if (place) {
      ui.input.value = place;
      run(place, { pushState: false });
    } else {
      ui.input.value = "";
      ui.shell.hidden = true;
      setStatus("");
      state.all = [];
    }
  });

  // A link like unlisted.example/?place=Bozeman,%20Montana should actually
  // show Bozeman's results, not just prefill the box -- that's the whole
  // point of putting the search in the URL.
  (function initFromUrl() {
    var place = placeFromLocation();
    if (place) {
      ui.input.value = place;
      run(place, { pushState: false });
    }
  })();
})();
