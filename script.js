const GTFS_URL = "./gtfs.zip",
  colors = ["#ff2633", "#00c8a5", "#ffd400", "#36a3ff", "#f06cff", "#ff8b2b"],
  state = {
    routes: [],
    selected: null,
    map: null,
    popup: null,
    shapeLayers: new Map(),
    osmLayers: new Map(),
    hiddenShapes: new Set(),
    qaRouteRelations: new Map(),
    qaRequests: new Map(),
    qaFullRelations: new Map(),
    qaFullRequests: new Map(),
    qaErrorLayer: null,
    qaErrorsVisible: true
  },
  $ = (id) => document.getElementById(id),
  finite = Number.isFinite,
  el = (tag, className = "", text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
const setLoading = (title, detail) => {
    $("loading-title").textContent = title;
    $("loading-detail").textContent = detail;
  },
  indexes = (h) => Object.fromEntries(h.map((v, i) => [v, i])),
  bump = (m, v) => m.set(v, (m.get(v) || 0) + 1),
  mostCommon = (m) => {
    let v = "",
      c = -1;
    for (const [x, n] of m)
      if (n > c) {
        v = x;
        c = n;
      }
    return v;
  },
  safeName = (v) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase(),
  escapeXml = (v) =>
    String(v).replace(
      /[<>&'"]/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          "'": "&apos;",
          '"': "&quot;"
        })[c]
    ),
  visible = (s) => !state.hiddenShapes.has(s.id);
const normalizeStopRef = (value) => {
    const ref = String(value ?? "").trim();
    return /^\d+$/.test(ref) ? ref.padStart(4, "0") : ref;
  },
  stopRefMatches = (a, b) => {
    const x = normalizeStopRef(a),
      y = normalizeStopRef(b);
    return !!x && !!y && x === y;
  },
  idEditUrl = (lat, lon, osmType = "", osmId = "") => {
    const target =
      osmType && osmId ? `&${osmType}=${encodeURIComponent(osmId)}` : "";
    return `https://www.openstreetmap.org/edit?editor=id${target}#map=22/${Number(lat).toFixed(7)}/${Number(lon).toFixed(7)}`;
  };
const copyText = async (value, button) => {
  const text = String(value ?? "");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  const old = button.textContent;
  button.textContent = "Copiat";
  button.disabled = true;
  setTimeout(() => {
    button.textContent = old;
    button.disabled = false;
  }, 900);
};
const parseCsvLine = (line) => {
  const out = [];
  let v = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        v += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(v);
      v = "";
    } else v += c;
  }
  out.push(v);
  return out;
};
const streamCsv = (file, onRow) =>
  new Promise((resolve, reject) => {
    if (!file)
      return reject(new Error("Falta un fitxer necessari dins del GTFS"));
    let buffer = "",
      headers;
    const process = (line) => {
      if (!line) return;
      const values = parseCsvLine(line);
      if (!headers) {
        headers = values.map((v) => v.replace(/^\uFEFF/, "").trim());
        return;
      }
      onRow(values, headers);
    };
    file
      .internalStream("string")
      .on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(process);
      })
      .on("error", reject)
      .on("end", () => {
        process(buffer);
        resolve();
      })
      .resume();
  });
const routeOrder = (r) => {
  const n = String(r.shortName).match(/^\d+/);
  return [n ? Number(n[0]) : 1e4, r.shortName];
};
const compareRoutes = (a, b) => {
  const [an, as] = routeOrder(a),
    [bn, bs] = routeOrder(b);
  return (
    an - bn ||
    as.localeCompare(bs, "ca", { numeric: true, sensitivity: "base" })
  );
};
const loadGtfs = async () => {
  setLoading(
    "Descarregant el GTFS oficial",
    "Rebent el fitxer des de T-mobilitat…"
  );
  const response = await fetch(GTFS_URL);
  if (!response.ok)
    throw new Error(`No s’ha pogut descarregar el GTFS (HTTP ${response.status})`);
  const data = await response.arrayBuffer();
  setLoading(
    "Obrint el fitxer GTFS",
    `${(data.byteLength / 1048576).toFixed(1)} MB descarregats`
  );
  const zip = await JSZip.loadAsync(data),
    routeMap = new Map(),
    stopMap = new Map(),
    shapeMeta = new Map(),
    shapePoints = new Map(),
    tripStops = new Map();
  let idx;
  setLoading("Llegint les línies", "Processant routes.txt…");
  await streamCsv(zip.file("routes.txt"), (r, h) => {
    idx ||= indexes(h);
    if (r[idx.agency_id] !== "TMB_" || r[idx.route_type] !== "3") return;
    const id = r[idx.route_id];
    routeMap.set(id, {
      id,
      shortName: r[idx.route_short_name],
      longName: r[idx.route_long_name],
      shapes: []
    });
  });
  setLoading("Llegint les parades", `${routeMap.size} línies TMB trobades`);
  idx = null;
  await streamCsv(zip.file("stops.txt"), (r, h) => {
    idx ||= indexes(h);
    const id = r[idx.stop_id],
      lat = Number(r[idx.stop_lat]),
      lon = Number(r[idx.stop_lon]);
    if (!id || !finite(lat) || !finite(lon)) return;
    stopMap.set(id, {
      id,
      code: r[idx.stop_code],
      name: r[idx.stop_name],
      lat,
      lon
    });
  });
  setLoading("Identificant els recorreguts", "Processant trips.txt…");
  idx = null;
  await streamCsv(zip.file("trips.txt"), (r, h) => {
    idx ||= indexes(h);
    const routeId = r[idx.route_id],
      shapeId = r[idx.shape_id];
    if (!routeMap.has(routeId) || !shapeId) return;
    if (!shapeMeta.has(shapeId))
      shapeMeta.set(shapeId, {
        routeId,
        headsigns: new Map(),
        directions: new Map(),
        representativeTrip: ""
      });
    const m = shapeMeta.get(shapeId);
    bump(m.headsigns, r[idx.trip_headsign] || "Recorregut");
    bump(m.directions, r[idx.direction_id] || "0");
    m.representativeTrip ||= r[idx.trip_id];
  });
  setLoading(
    "Construint les geometries",
    `${shapeMeta.size} recorreguts trobats`
  );
  idx = null;
  await streamCsv(zip.file("shapes.txt"), (r, h) => {
    idx ||= indexes(h);
    const id = r[idx.shape_id];
    if (!shapeMeta.has(id)) return;
    const lat = Number(r[idx.shape_pt_lat]),
      lon = Number(r[idx.shape_pt_lon]),
      seq = Number(r[idx.shape_pt_sequence]);
    if (!finite(lat) || !finite(lon)) return;
    if (!shapePoints.has(id)) shapePoints.set(id, []);
    shapePoints.get(id).push([seq, lat, lon]);
  });
  const representativeTrips = new Set();
  for (const m of shapeMeta.values()) {
    representativeTrips.add(m.representativeTrip);
    tripStops.set(m.representativeTrip, []);
  }
  setLoading(
    "Assignant les parades",
    "Processant stop_times.txt"
  );
  idx = null;
  await streamCsv(zip.file("stop_times.txt"), (r, h) => {
    idx ||= indexes(h);
    const tripId = r[idx.trip_id];
    if (!representativeTrips.has(tripId)) return;
    const stop = stopMap.get(r[idx.stop_id]);
    if (!stop) return;
    tripStops.get(tripId).push({
      sequence: Number(r[idx.stop_sequence]),
      pickupType:
        idx.pickup_type === undefined ? "0" : r[idx.pickup_type] || "0",
      dropOffType:
        idx.drop_off_type === undefined ? "0" : r[idx.drop_off_type] || "0",
      stop
    });
  });
  setLoading("Preparant l’aplicació", "Ordenant recorreguts i parades…");
  const repeats = new Map();
  for (const [id, m] of shapeMeta) {
    const route = routeMap.get(m.routeId),
      headsign = mostCommon(m.headsigns) || "Recorregut",
      direction = mostCommon(m.directions) || "0",
      key = `${m.routeId}:${headsign}`,
      n = (repeats.get(key) || 0) + 1;
    repeats.set(key, n);
    const points = (shapePoints.get(id) || [])
      .sort((a, b) => a[0] - b[0])
      .map(([, lat, lon]) => [lat, lon]);
    if (!points.length) continue;
    route.shapes.push({
      id,
      label: `Sentit ${headsign}${n > 1 ? ` · variant ${n}` : ""}`,
      headsign,
      direction,
      points,
      stops: (tripStops.get(m.representativeTrip) || [])
        .sort((a, b) => a.sequence - b.sequence)
        .map((x) => ({
          ...x.stop,
          sequence: x.sequence,
          pickupType: x.pickupType,
          dropOffType: x.dropOffType
        }))
    });
  }
  state.routes = [...routeMap.values()]
    .filter((r) => r.shapes.length)
    .map((r) => ({
      ...r,
      shapes: r.shapes.sort(
        (a, b) =>
          a.direction.localeCompare(b.direction) ||
          a.label.localeCompare(b.label, "ca")
      )
    }))
    .sort(compareRoutes);
  const modified = response.headers.get("Last-Modified");
  $("dataset-date").textContent =
    `GTFS oficial · ${(modified ? new Date(modified) : new Date()).toLocaleDateString("ca-ES")}`;
};
const makeGpx = (route, shape) => {
  const title = `Línia ${route.shortName} — ${shape.label}`,
    desc = `Direcció GTFS ${shape.direction}. Geometria i parades oficials GTFS TMB. shape_id=${shape.id}`,
    waypoints = shape.stops
      .map(
        (s) => `
	<wpt lat="${s.lat}" lon="${s.lon}">
		<name>${escapeXml(s.name)}</name>
		<desc>${escapeXml(`Parada ${s.code || s.id}`)}</desc>
		<sym>Bus Stop</sym>
		<type>Parada TMB</type>
	</wpt>`
      )
      .join(""),
    trackPoints = shape.points
      .map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`)
      .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="TMB Recorreguts GPX">
	<metadata>
		<name>${escapeXml(title)}</name>
		<desc>${escapeXml(desc)}</desc>
	</metadata>
	${waypoints}
	<trk>
		<name>${escapeXml(title)}</name>
		<desc>${escapeXml(desc)}</desc>
		<trkseg>${trackPoints}</trkseg>
	</trk>
</gpx>`;
};
const downloadShape = (route, shape) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([makeGpx(route, shape)], {
      type: "application/gpx+xml;charset=utf-8"
    })
  );
  a.download = `tmb-${safeName(route.shortName)}-${safeName(shape.label)}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
};
const renderRoutes = (query = "") => {
  const search = query.trim().toLocaleLowerCase("ca"),
    routes = state.routes.filter((r) =>
      `${r.shortName} ${r.longName}`.toLocaleLowerCase("ca").includes(search)
    );
  $("line-count").textContent = routes.length;
  $("empty").hidden = !!routes.length;
  $("line-list").replaceChildren(
    ...routes.map((route) => {
      const b = el("button", "line-option", route.shortName);
      Object.assign(b, {
        type: "button",
        role: "option",
        title: route.longName,
        onclick: () => selectRoute(route)
      });
      b.setAttribute("aria-selected", String(state.selected?.id === route.id));
      return b;
    })
  );
};
const popupContent = (f) => {
  const qa = f.get("type") === "qa-stop-error",
    root = el("div", "popup-body"),
    code = el("span", "popup-code", qa ? f.get("code") || "QA" : f.get("code")),
    body = el("div", "popup-copy"),
    name = el(
      "strong",
      "",
      qa ? f.get("name") || "Incidència de parada" : f.get("name")
    );
  body.append(name);
  if (!qa) {
    body.append(el("span", "popup-normal-label", "Parada TMB"));
    root.append(code, body);
    return root;
  }
  const issues = f.get("issues") || [],
    list = el("div", "popup-issues");
  for (const issue of issues) {
    const block = el("div", "popup-issue");
    block.append(el("div", "popup-issue-title", issue.label || "INCIDÈNCIA"));
    if (issue.rows?.length) {
      for (const [source, value] of issue.rows) {
        const text = String(value ?? ""),
          row = el("div", "popup-value-row"),
          copy = el("button", "popup-copy-button", "Copiar");
        copy.type = "button";
        copy.hidden = !text;
        copy.onclick = () => copyText(text, copy);
        row.append(
          el("span", "popup-value-source", source),
          el("span", "popup-value", text || "—"),
          copy
        );
        block.append(row);
      }
    } else
      block.append(
        el("div", "popup-issue-text", issue.text || issue.label || "Incidència")
      );
    list.append(block);
  }
  if (!issues.length)
    list.append(
      el("div", "popup-issue-text", f.get("details") || "Incidència OSM")
    );
  body.append(list);
  const osmType = f.get("osmType") || "",
    osmId = f.get("osmId") || "",
    link = el(
      "a",
      "popup-edit",
      osmType && osmId ? "Editar en iD" : "Editar zona en iD"
    );
  link.href = idEditUrl(f.get("editLat"), f.get("editLon"), osmType, osmId);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  body.append(link);
  root.append(code, body);
  return root;
};
const makeQaErrorStyle = () => {
  const geometry = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: "rgba(0,0,0,.9)",
          width: 8,
          lineCap: "round",
          lineJoin: "round"
        }),
        zIndex: 1
      }),
      new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: "#ff8b2b",
          width: 4,
          lineCap: "round",
          lineJoin: "round"
        }),
        zIndex: 2
      })
    ],
    distance = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: "rgba(0,0,0,.85)",
          width: 5,
          lineCap: "round"
        }),
        zIndex: 3
      }),
      new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: "#ff8b2b",
          width: 2,
          lineDash: [6, 5],
          lineCap: "round"
        }),
        zIndex: 4
      })
    ],
    osmPoint = new ol.style.Style({
      image: new ol.style.Circle({
        radius: 6,
        fill: new ol.style.Fill({ color: "#fff" }),
        stroke: new ol.style.Stroke({ color: "#ff8b2b", width: 3 })
      }),
      zIndex: 5
    }),
    gtfsPoint = new ol.style.Style({
      image: new ol.style.Circle({
        radius: 9,
        fill: new ol.style.Fill({ color: "#ff8b2b" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 2 })
      }),
      zIndex: 6
    });
  return (f) => {
    if (state.hiddenShapes.has(f.get("shapeId"))) return null;
    const type = f.get("type");
    if (type === "qa-stop-error") return gtfsPoint;
    if (type === "qa-stop-distance-line") return distance;
    if (type === "qa-stop-distance-osm") return osmPoint;
    return geometry;
  };
};
const initializeMap = () => {
  const popup = $("map-popup");
  state.popup = new ol.Overlay({
    element: popup,
    positioning: "bottom-center",
    offset: [0, -12],
    stopEvent: true
  });
  state.qaErrorLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    style: makeQaErrorStyle(),
    visible: state.qaErrorsVisible,
    zIndex: 220
  });
  state.map = new ol.Map({
    target: "map",
    layers: [
      new ol.layer.Tile({
        className: "dark-base-layer",
        source: new ol.source.OSM()
      }),
      state.qaErrorLayer
    ],
    overlays: [state.popup],
    view: new ol.View({
      center: ol.proj.fromLonLat([2.17, 41.4]),
      zoom: 11,
      minZoom: 9,
      maxZoom: 19
    })
  });
  const hitQa = (e) =>
      state.map.forEachFeatureAtPixel(
        e.pixel,
        (f) => (f.get("type") === "qa-stop-error" ? f : undefined),
        { hitTolerance: 14, layerFilter: (l) => l === state.qaErrorLayer }
      ),
    hitGtfs = (e) =>
      state.map.forEachFeatureAtPixel(
        e.pixel,
        (f) => (f.get("type") === "stop" ? f : undefined),
        { hitTolerance: 8, layerFilter: (l) => l !== state.qaErrorLayer }
      ),
    hit = (e) => hitQa(e) || hitGtfs(e);
  state.map.on("singleclick", (e) => {
    const f = hit(e);
    if (!f) {
      popup.hidden = true;
      state.popup.setPosition();
      return;
    }
    popup.replaceChildren(popupContent(f));
    popup.hidden = false;
    state.popup.setPosition(f.getGeometry().getCoordinates());
  });
  state.map.on("pointermove", (e) => {
    if (!e.dragging)
      state.map.getTargetElement().style.cursor = hit(e) ? "pointer" : "";
  });
};
const rgba = (color, alpha) => {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};
const makeRouteStyle = (color) => {
  const base = [
    new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: rgba(color, 0.28),
        width: 12,
        lineCap: "round",
        lineJoin: "round"
      }),
      zIndex: 1
    }),
    new ol.style.Style({
      stroke: new ol.style.Stroke({
        color,
        width: 5,
        lineCap: "round",
        lineJoin: "round"
      }),
      zIndex: 2
    })
  ];
  return (f, resolution) => {
    const c = f.getGeometry().getCoordinates(),
      styles = [...base];
    if (c.length < 2) return styles;
    const spacing = Math.max(resolution * 75, 1);
    let remaining = spacing / 2,
      arrows = 0;
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1],
        b = c[i],
        dx = b[0] - a[0],
        dy = b[1] - a[1],
        len = Math.hypot(dx, dy);
      if (!len) continue;
      const rotation = Math.atan2(dy, dx);
      let offset = remaining;
      while (offset <= len) {
        const t = offset / len;
        styles.push(
          new ol.style.Style({
            geometry: new ol.geom.Point([a[0] + dx * t, a[1] + dy * t]),
            image: new ol.style.RegularShape({
              points: 3,
              radius: 7,
              angle: Math.PI / 2,
              rotation: -rotation,
              rotateWithView: true,
              fill: new ol.style.Fill({ color: "#fff" }),
              stroke: new ol.style.Stroke({ color, width: 2 })
            }),
            zIndex: 3
          })
        );
        arrows++;
        offset += spacing;
      }
      remaining = offset - len;
    }
    if (!arrows) {
      const i = Math.floor((c.length - 1) / 2),
        a = c[i],
        b = c[Math.min(i + 1, c.length - 1)],
        dx = b[0] - a[0],
        dy = b[1] - a[1];
      styles.push(
        new ol.style.Style({
          geometry: new ol.geom.Point([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]),
          image: new ol.style.RegularShape({
            points: 3,
            radius: 7,
            angle: Math.PI / 2,
            rotation: -Math.atan2(dy, dx),
            rotateWithView: true,
            fill: new ol.style.Fill({ color: "#fff" }),
            stroke: new ol.style.Stroke({ color, width: 2 })
          }),
          zIndex: 3
        })
      );
    }
    return styles;
  };
};
const makeStopStyle = (color) =>
  new ol.style.Style({
    image: new ol.style.Circle({
      radius: 5,
      fill: new ol.style.Fill({ color: "#0d0d0f" }),
      stroke: new ol.style.Stroke({ color, width: 3 })
    })
  });
const setQaErrorsVisible = (v) => {
  state.qaErrorsVisible = v;
  state.qaErrorLayer?.setVisible(v);
  const b = $("qa-errors-toggle");
  if (!b) return;
  b.setAttribute("aria-pressed", String(v));
  b.textContent = v ? "Errors: ON" : "Errors: OFF";
  if (!v) {
    $("map-popup").hidden = true;
    state.popup?.setPosition();
  }
};
const revealQaErrorsToggle = () => {
  const b = $("qa-errors-toggle");
  if (b) b.hidden = false;
};
const resetQaErrorsToggle = () => {
  const b = $("qa-errors-toggle");
  state.qaErrorsVisible = true;
  state.qaErrorLayer?.setVisible(true);
  if (!b) return;
  b.hidden = true;
  b.setAttribute("aria-pressed", "true");
  b.textContent = "Errors: ON";
};
const clearShapeQaErrors = (shapeId, kind = null) => {
  const src = state.qaErrorLayer?.getSource();
  if (!src) return;
  for (const f of [...src.getFeatures()])
    if (f.get("shapeId") === shapeId && (!kind || f.get("qaKind") === kind))
      src.removeFeature(f);
};
const clearRouteLayers = () => {
  if (!state.map) return;
  for (const l of state.osmLayers.values()) state.map.removeLayer(l);
  state.osmLayers.clear();
  state.qaErrorLayer?.getSource().clear();
  for (const l of state.shapeLayers.values()) {
    state.map.removeLayer(l.route);
    state.map.removeLayer(l.stops);
  }
  state.shapeLayers.clear();
  state.popup?.setPosition();
  $("map-popup").hidden = true;
};
const drawRoute = (route) => {
  clearRouteLayers();
  const extent = ol.extent.createEmpty();
  route.shapes.forEach((shape, index) => {
    const color = colors[index % colors.length],
      coords = shape.points
        .filter(([lat, lon]) => finite(lat) && finite(lon))
        .map(([lat, lon]) => ol.proj.fromLonLat([lon, lat]));
    if (coords.length < 2) return;
    const geometry = new ol.geom.LineString(coords);
    ol.extent.extend(extent, geometry.getExtent());
    const routeLayer = new ol.layer.Vector({
        source: new ol.source.Vector({
          features: [new ol.Feature({ geometry })]
        }),
        style: makeRouteStyle(color),
        visible: visible(shape),
        zIndex: 20 + index
      }),
      stops = shape.stops
        .filter((s) => finite(s.lon) && finite(s.lat))
        .map(
          (s) =>
            new ol.Feature({
              geometry: new ol.geom.Point(ol.proj.fromLonLat([s.lon, s.lat])),
              type: "stop",
              code: s.code || s.id,
              name: s.name
            })
        ),
      stopLayer = new ol.layer.Vector({
        source: new ol.source.Vector({ features: stops }),
        style: makeStopStyle(color),
        visible: visible(shape),
        zIndex: 100 + index
      });
    state.map.addLayer(routeLayer);
    state.map.addLayer(stopLayer);
    state.shapeLayers.set(shape.id, { route: routeLayer, stops: stopLayer });
  });
  state.map.updateSize();
  if (!ol.extent.isEmpty(extent))
    state.map
      .getView()
      .fit(extent, { padding: [45, 45, 45, 45], maxZoom: 15, duration: 600 });
};
const showMap = (route) => {
  state.map || initializeMap();
  requestAnimationFrame(() => {
    state.map.updateSize();
    drawRoute(route);
  });
};
const setShapeVisibility = (shape, isVisible) => {
  isVisible
    ? state.hiddenShapes.delete(shape.id)
    : state.hiddenShapes.add(shape.id);
  const l = state.shapeLayers.get(shape.id);
  if (l) {
    l.route.setVisible(isVisible);
    l.stops.setVisible(isVisible);
  }
  state.osmLayers.get(shape.id)?.setVisible(isVisible);
  state.qaErrorLayer?.changed();
  const card = document.querySelector(
    `[data-shape-id="${CSS.escape(shape.id)}"]`
  );
  if (!card) return;
  card.classList.toggle("is-hidden", !isVisible);
  const b = card.querySelector(".visibility-toggle");
  b.setAttribute("aria-pressed", String(isVisible));
  b.textContent = isVisible ? "Ocultar" : "Mostrar";
};
let osmQaLoader = null;
const loadOsmQa = () => {
  if (typeof window.runOsmQa === "function") return Promise.resolve();
  if (osmQaLoader) return osmQaLoader;
  osmQaLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "osm-qa.js";
    script.async = true;
    script.onload = () =>
      typeof window.runOsmQa === "function"
        ? resolve()
        : reject(new Error("OSM_QA no s’ha inicialitzat"));
    script.onerror = () => reject(new Error("No s’ha pogut carregar OSM_QA"));
    document.head.append(script);
  }).catch((error) => {
    osmQaLoader = null;
    throw error;
  });
  return osmQaLoader;
};
const runLazyOsmQa = async (route, shape, button, status) => {
  button.disabled = true;
  button.textContent = "OSM…";
  try {
    await loadOsmQa();
    await window.runOsmQa(route, shape, button, status);
  } catch (error) {
    status.hidden = false;
    status.className = "qa-status qa-error";
    status.textContent =
      error instanceof Error ? error.message : "Error carregant OSM_QA";
    button.className = "qa-button qa-error";
    button.disabled = false;
    button.textContent = "OSM_QA";
  }
};
const createShapeCard = (route, shape, index) => {
  const isVisible = visible(shape),
    card = el("article", `shape-card${isVisible ? "" : " is-hidden"}`),
    swatch = el("span", "shape-swatch"),
    info = el("div", "shape-information"),
    qaStatus = el("p", "qa-status"),
    actions = el("div", "shape-actions"),
    toggle = el(
      "button",
      "visibility-toggle",
      isVisible ? "Ocultar" : "Mostrar"
    ),
    download = el("button", "download", "GPX"),
    qa = el("button", "qa-button", "OSM_QA");
  card.dataset.shapeId = shape.id;
  swatch.style.background = colors[index % colors.length];
  qaStatus.hidden = true;
  info.append(
    el("h3", "", shape.label),
    el(
      "p",
      "",
      `${shape.points.length} punts · ${shape.stops.length} parades · dir. ${shape.direction}`
    ),
    qaStatus
  );
  toggle.type = download.type = qa.type = "button";
  toggle.setAttribute("aria-pressed", String(isVisible));
  toggle.onclick = () => setShapeVisibility(shape, !visible(shape));
  download.onclick = () => downloadShape(route, shape);
  qa.onclick = () => runLazyOsmQa(route, shape, qa, qaStatus);
  actions.append(toggle, download, qa);
  card.append(swatch, info, actions);
  return card;
};
const selectRoute = (route) => {
  state.selected = route;
  state.hiddenShapes.clear();
  state.qaRouteRelations.clear();
  state.qaRequests.clear();
  resetQaErrorsToggle();
  renderRoutes($("line-search").value);
  $("selected-badge").textContent = route.shortName;
  $("selected-name").textContent = route.longName;
  $("shape-list").replaceChildren(
    ...route.shapes.map((shape, index) => createShapeCard(route, shape, index))
  );
  $("placeholder").hidden = true;
  $("route-view").hidden = false;
  showMap(route);
  if (innerWidth < 980)
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
};
const startApplication = async () => {
  $("loading").hidden = false;
  $("error-view").hidden = true;
  $("application").hidden = true;
  try {
    await loadGtfs();
    $("loading").hidden = true;
    $("application").hidden = false;
    renderRoutes();
  } catch (error) {
    $("loading").hidden = true;
    $("application").hidden = true;
    $("error-view").hidden = false;
    $("error-message").textContent =
      error instanceof Error
        ? error.message
        : "S’ha produït un error inesperat";
  }
};
$("line-search").addEventListener("input", (e) => renderRoutes(e.target.value));
$("download-all").addEventListener("click", () =>
  state.selected?.shapes.forEach((shape, index) =>
    setTimeout(() => downloadShape(state.selected, shape), index * 250)
  )
);
$("qa-errors-toggle").addEventListener("click", () =>
  setQaErrorsVisible(!state.qaErrorsVisible)
);
$("retry").addEventListener("click", startApplication);
startApplication();
