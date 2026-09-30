(()=>{
const OVERPASS_URL = "https://overpass-api.de/api/interpreter",
  OSM_API_URL = "https://www.openstreetmap.org/api/0.6/relation",
  OSM_OPERATOR = "Transports Metropolitans de Barcelona",
  DEFAULT_ROUTE_BUFFER_METERS = 20,
  ROUTE_SAMPLE_METERS = 10,
  DEFAULT_ROUTE_MATCH_PERCENT = 95,
  MIN_GEOMETRY_ERROR_SAMPLES = 2,
  DEFAULT_STOP_RADIUS_METERS = 45,
  STOP_FALLBACK_MIN_MATCHES = 2,
  STOP_FALLBACK_MIN_RATIO = 0.5,
  STOP_FALLBACK_MIN_LEAD = 0.15,
  EARTH_RADIUS_METERS = 6371008.8;
const makeOsmStyle = () => {
  const halo = new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "rgba(0,0,0,.85)",
        width: 7,
        lineCap: "round",
        lineJoin: "round"
      }),
      zIndex: 1
    }),
    line = new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "#fff",
        width: 3,
        lineDash: [9, 7],
        lineCap: "round",
        lineJoin: "round"
      }),
      zIndex: 2
    });
  return (f, resolution) => {
    const c = f.getGeometry().getCoordinates(),
      styles = [halo, line];
    if (c.length < 2) return styles;
    const spacing = Math.max(resolution * 110, 1);
    let remaining = spacing / 2;
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
              radius: 5,
              angle: Math.PI / 2,
              rotation: -rotation,
              rotateWithView: true,
              fill: new ol.style.Fill({ color: "#fff" }),
              stroke: new ol.style.Stroke({ color: "#0d0d0f", width: 2 })
            }),
            zIndex: 3
          })
        );
        offset += spacing;
      }
      remaining = offset - len;
    }
    return styles;
  };
};
const overpassValue = (v) =>
  String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const expectedFrom = (route, shape) => {
  const h = [
    ...new Set(
      route.shapes
        .map((s) => s.headsign)
        .filter((x) => x && x !== shape.headsign)
    )
  ];
  return h.length === 1 ? h[0] : null;
};
const findOsmRelations = async (route) => {
  const query = `[out:json][timeout:24][maxsize:16Mi];relation["type"="route"]["route"="bus"]["ref"="${overpassValue(route.shortName)}"]["operator"="${overpassValue(OSM_OPERATOR)}"];out tags;`,
    response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: `data=${encodeURIComponent(query)}`
    });
  if (!response.ok)
    throw new Error(`Overpass ha respost amb l’estat ${response.status}`);
  const data = await response.json();
  return (data.elements || [])
    .filter((e) => e.type === "relation")
    .map((e) => ({ id: e.id, tags: e.tags || {} }));
};
const getOsmRelations = async (route) => {
  if (state.qaRouteRelations.has(route.id))
    return state.qaRouteRelations.get(route.id);
  if (state.qaRequests.has(route.id)) return state.qaRequests.get(route.id);
  const request = findOsmRelations(route)
    .then((r) => {
      state.qaRouteRelations.set(route.id, r);
      return r;
    })
    .finally(() => state.qaRequests.delete(route.id));
  state.qaRequests.set(route.id, request);
  return request;
};
const parseOsmTags = (e) =>
  Object.fromEntries(
    [...e.querySelectorAll(":scope > tag")].map((t) => [
      t.getAttribute("k"),
      t.getAttribute("v")
    ])
  );
const parseOsmRelation = (xmlText, relationId) => {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror"))
    throw new Error("L’XML retornat per OSM no és vàlid");
  const nodeMap = new Map(),
    wayMap = new Map();
  for (const n of doc.querySelectorAll("node"))
    nodeMap.set(n.getAttribute("id"), {
      lat: Number(n.getAttribute("lat")),
      lon: Number(n.getAttribute("lon")),
      tags: parseOsmTags(n)
    });
  for (const w of doc.querySelectorAll("way")) {
    const nodeIds = [...w.querySelectorAll(":scope > nd")].map((n) =>
      n.getAttribute("ref")
    );
    wayMap.set(w.getAttribute("id"), {
      nodeIds,
      nodes: nodeIds.map((id) => nodeMap.get(id)).filter(Boolean),
      tags: parseOsmTags(w)
    });
  }
  const relation = [...doc.querySelectorAll("relation")].find(
    (r) => r.getAttribute("id") === String(relationId)
  );
  if (!relation) throw new Error("No s’ha trobat la relació OSM sol·licitada");
  return {
    nodeMap,
    wayMap,
    members: [...relation.querySelectorAll(":scope > member")].map((m) => ({
      type: m.getAttribute("type"),
      ref: m.getAttribute("ref"),
      role: m.getAttribute("role") || ""
    }))
  };
};
const isStopRole = (role) => /(^|_)(stop|platform)($|_)/i.test(role),
  isRouteWay = (m) => m.type === "way" && !isStopRole(m.role),
  nodeIdAtStart = (w) => w.nodeIds[0],
  nodeIdAtEnd = (w) => w.nodeIds[w.nodeIds.length - 1];
const orientationCandidates = (member, way) => {
  const forward = { nodeIds: way.nodeIds, nodes: way.nodes },
    backward = {
      nodeIds: [...way.nodeIds].reverse(),
      nodes: [...way.nodes].reverse()
    },
    role = member.role.toLowerCase();
  if (role === "forward") return [forward];
  if (role === "backward") return [backward];
  return [forward, backward];
};
const nextCandidates = (members, start, wayMap) => {
  for (let i = start + 1; i < members.length; i++) {
    const m = members[i],
      w = wayMap.get(m.ref);
    if (w && w.nodeIds.length > 1) return orientationCandidates(m, w);
  }
  return [];
};
const inferOrientation = (members, index, wayMap, previous) => {
  const member = members[index],
    way = wayMap.get(member.ref);
  if (!way || way.nodeIds.length < 2) return null;
  const c = orientationCandidates(member, way);
  if (c.length === 1) return c[0];
  const end = previous ? nodeIdAtEnd(previous) : null;
  if (end) {
    const hit = c.find((x) => nodeIdAtStart(x) === end);
    if (hit) return hit;
  }
  const next = nextCandidates(members, index, wayMap);
  if (next.length) {
    for (const x of c) {
      const e = nodeIdAtEnd(x);
      if (next.some((n) => nodeIdAtStart(n) === e)) return x;
    }
    for (const x of c) {
      const e = nodeIdAtEnd(x);
      if (next.some((n) => nodeIdAtStart(n) === e || nodeIdAtEnd(n) === e))
        return x;
    }
  }
  return c[0];
};
const orientRouteWays = (members, wayMap) => {
  const routeMembers = members.filter(isRouteWay),
    out = [];
  let previous = null;
  for (let i = 0; i < routeMembers.length; i++) {
    const item = inferOrientation(routeMembers, i, wayMap, previous);
    if (!item) continue;
    out.push(item);
    previous = item;
  }
  return out;
};
const buildTrackSegments = (ways) => {
  const out = [];
  let current = [];
  for (const item of ways) {
    if (!item.nodes.length) continue;
    const coords = item.nodes.map((n) => [n.lon, n.lat]);
    if (!current.length) {
      current = [...coords];
      continue;
    }
    const p = current[current.length - 1],
      f = coords[0];
    if (p[0] === f[0] && p[1] === f[1]) current.push(...coords.slice(1));
    else {
      out.push(current);
      current = [...coords];
    }
  }
  if (current.length) out.push(current);
  return out;
};
const loadFullOsmRelation = async (relationId) => {
  if (state.qaFullRelations.has(relationId))
    return state.qaFullRelations.get(relationId);
  if (state.qaFullRequests.has(relationId))
    return state.qaFullRequests.get(relationId);
  const request = fetch(`${OSM_API_URL}/${relationId}/full`)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(`OSM API ha respost amb l’estat ${response.status}`);
      const parsed = parseOsmRelation(await response.text(), relationId),
        orientedWays = orientRouteWays(parsed.members, parsed.wayMap);
      if (!orientedWays.length)
        throw new Error(
          "La relació OSM no conté ways utilitzables com a recorregut"
        );
      const segments = buildTrackSegments(orientedWays).filter(
        (s) => s.length > 1
      );
      if (!segments.length)
        throw new Error(
          "No s’ha pogut reconstruir la geometria de la relació OSM"
        );
      const result = { ...parsed, segments };
      state.qaFullRelations.set(relationId, result);
      return result;
    })
    .finally(() => state.qaFullRequests.delete(relationId));
  state.qaFullRequests.set(relationId, request);
  return request;
};
const drawOsmRelation = (shape, relationId, parsed) => {
  const old = state.osmLayers.get(shape.id);
  if (old) state.map.removeLayer(old);
  const layer = new ol.layer.Vector({
    source: new ol.source.Vector({
      features: parsed.segments.map(
        (segment) =>
          new ol.Feature({
            geometry: new ol.geom.LineString(
              segment.map(([lon, lat]) => ol.proj.fromLonLat([lon, lat]))
            ),
            type: "osm-route",
            relationId,
            shapeId: shape.id
          })
      )
    }),
    style: makeOsmStyle(),
    visible: visible(shape),
    zIndex: 70
  });
  state.map.addLayer(layer);
  state.osmLayers.set(shape.id, layer);
};
const makeLocalProjector = (lines) => {
  let latitude = 0,
    count = 0;
  for (const line of lines)
    for (const p of line)
      if (finite(p[0]) && finite(p[1])) {
        latitude += p[1];
        count++;
      }
  const ref = ((count ? latitude / count : 41.4) * Math.PI) / 180,
    scale = (EARTH_RADIUS_METERS * Math.PI) / 180,
    lonScale = scale * Math.cos(ref);
  return ([lon, lat]) => [lon * lonScale, lat * scale];
};
const pointSegmentDistance = (p, a, b) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  if (!dx && !dy) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
};
const distanceToPolylines = (p, lines) => {
  let min = Infinity;
  for (const line of lines)
    for (let i = 1; i < line.length; i++)
      min = Math.min(min, pointSegmentDistance(p, line[i - 1], line[i]));
  return min;
};
const samplePolyline = (line, project, spacing) => {
  if (!line.length) return [];
  if (line.length === 1)
    return [{ lon: line[0][0], lat: line[0][1], xy: project(line[0]) }];
  const projected = line.map(project),
    samples = [];
  let travelled = 0,
    nextDistance = 0;
  for (let i = 1; i < line.length; i++) {
    const a = projected[i - 1],
      b = projected[i],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    if (!length) continue;
    while (nextDistance <= travelled + length) {
      const t = (nextDistance - travelled) / length;
      samples.push({
        lon: line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
        lat: line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
        xy: [a[0] + dx * t, a[1] + dy * t]
      });
      nextDistance += spacing;
    }
    travelled += length;
  }
  const last = line[line.length - 1],
    lastXY = projected[projected.length - 1],
    previous = samples[samples.length - 1];
  if (
    !previous ||
    Math.hypot(lastXY[0] - previous.xy[0], lastXY[1] - previous.xy[1]) >
      spacing * 0.25
  )
    samples.push({ lon: last[0], lat: last[1], xy: lastXY });
  return samples;
};
const evaluateGeometry = (sourceLines, targetLines, project, bufferMeters) => {
  const target = targetLines
    .filter((l) => l.length > 1)
    .map((l) => l.map(project));
  let total = 0,
    matched = 0;
  const errors = [];
  for (const line of sourceLines) {
    const samples = samplePolyline(line, project, ROUTE_SAMPLE_METERS);
    let current = [];
    const flush = () => {
      if (current.length >= MIN_GEOMETRY_ERROR_SAMPLES)
        errors.push(current.map((s) => [s.lon, s.lat]));
      current = [];
    };
    for (const sample of samples) {
      sample.distance = distanceToPolylines(sample.xy, target);
      total++;
      if (sample.distance <= bufferMeters) {
        matched++;
        flush();
      } else current.push(sample);
    }
    flush();
  }
  return { percentage: total ? (matched / total) * 100 : 0, errors };
};
const lineLengthMeters = (line) => {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += geoDistance(line[i - 1], line[i]);
  return total;
};
const compareRouteGeometry = (shape, parsed) => {
  const gtfsLines = [
      shape.points
        .filter(([lat, lon]) => finite(lat) && finite(lon))
        .map(([lat, lon]) => [lon, lat])
    ].filter((l) => l.length > 1),
    osmLines = parsed.segments.filter((l) => l.length > 1);
  if (!gtfsLines.length || !osmLines.length)
    throw new Error("No hi ha prou geometria per comparar");
  const project = makeLocalProjector([...gtfsLines, ...osmLines]),
    gtfsToOsm = evaluateGeometry(
      gtfsLines,
      osmLines,
      project,
      DEFAULT_ROUTE_BUFFER_METERS
    ),
    osmToGtfs = evaluateGeometry(
      osmLines,
      gtfsLines,
      project,
      DEFAULT_ROUTE_BUFFER_METERS
    ),
    gtfsLengthMeters = gtfsLines.reduce(
      (total, line) => total + lineLengthMeters(line),
      0
    ),
    osmLengthMeters = osmLines.reduce(
      (total, line) => total + lineLengthMeters(line),
      0
    ),
    differenceMeters = osmLengthMeters - gtfsLengthMeters,
    differencePercent = gtfsLengthMeters
      ? (differenceMeters / gtfsLengthMeters) * 100
      : 0;
  return {
    gtfsToOsm,
    osmToGtfs,
    match: Math.min(gtfsToOsm.percentage, osmToGtfs.percentage),
    lengths: {
      gtfsMeters: gtfsLengthMeters,
      osmMeters: osmLengthMeters,
      differenceMeters,
      differencePercent
    }
  };
};
const drawGeometryErrors = (shape, result) => {
  clearShapeQaErrors(shape.id, "geometry");
  const features = [];
  for (const errors of [result.gtfsToOsm.errors, result.osmToGtfs.errors])
    for (const points of errors)
      if (points.length > 1)
        features.push(
          new ol.Feature({
            geometry: new ol.geom.LineString(
              points.map(([lon, lat]) => ol.proj.fromLonLat([lon, lat]))
            ),
            type: "qa-route-error",
            qaKind: "geometry",
            shapeId: shape.id
          })
        );
  state.qaErrorLayer?.getSource().addFeatures(features);
};
const geometryQaClass = (match) =>
  match >= DEFAULT_ROUTE_MATCH_PERCENT
    ? "qa-ok"
    : match >= 80
      ? "qa-warning"
      : "qa-error";
const geoDistance = (a, b) => {
  const lat1 = (a[1] * Math.PI) / 180,
    lat2 = (b[1] * Math.PI) / 180,
    dLat = lat2 - lat1,
    dLon = ((b[0] - a[0]) * Math.PI) / 180,
    h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};
const stopRestriction = (role) =>
  /entry_only/i.test(role)
    ? "entry_only"
    : /exit_only/i.test(role)
      ? "exit_only"
      : "normal";
const osmMemberPoint = (parsed, member) => {
  if (member.type === "node") {
    const n = parsed.nodeMap.get(member.ref);
    return n ? { lat: n.lat, lon: n.lon, tags: n.tags || {} } : null;
  }
  if (member.type === "way") {
    const w = parsed.wayMap.get(member.ref);
    if (!w?.nodes.length) return null;
    return {
      lat: w.nodes.reduce((s, n) => s + n.lat, 0) / w.nodes.length,
      lon: w.nodes.reduce((s, n) => s + n.lon, 0) / w.nodes.length,
      tags: w.tags || {}
    };
  }
  return null;
};
const extractOsmStopMembers = (parsed) => {
  const out = [];
  let rawIndex = 0;
  for (const m of parsed.members) {
    if (!isStopRole(m.role)) continue;
    const p = osmMemberPoint(parsed, m);
    if (!p) continue;
    out.push({
      rawIndex: rawIndex++,
      kind: /platform/i.test(m.role) ? "platform" : "stop",
      restriction: stopRestriction(m.role),
      type: m.type,
      osmId: m.ref,
      lat: p.lat,
      lon: p.lon,
      tags: p.tags
    });
  }
  return out;
};
const buildOsmLogicalStops = (parsed) => {
  const raw = extractOsmStopMembers(parsed),
    stops = raw.filter((x) => x.kind === "stop"),
    platforms = raw.filter((x) => x.kind === "platform"),
    candidates = [];
  for (const stop of stops)
    for (const platform of platforms) {
      const distance = geoDistance(
          [stop.lon, stop.lat],
          [platform.lon, platform.lat]
        ),
        gap = Math.abs(stop.rawIndex - platform.rawIndex),
        sameRef = stopRefMatches(stop.tags.ref, platform.tags.ref);
      if (gap <= 3 && (distance <= DEFAULT_STOP_RADIUS_METERS || sameRef))
        candidates.push({ stop, platform, distance, gap });
    }
  candidates.sort((a, b) => a.gap - b.gap || a.distance - b.distance);
  const usedStops = new Set(),
    usedPlatforms = new Set(),
    logical = [];
  for (const c of candidates) {
    if (usedStops.has(c.stop) || usedPlatforms.has(c.platform)) continue;
    usedStops.add(c.stop);
    usedPlatforms.add(c.platform);
    logical.push({ stopPosition: c.stop, platform: c.platform });
  }
  for (const s of stops)
    if (!usedStops.has(s)) logical.push({ stopPosition: s, platform: null });
  for (const p of platforms)
    if (!usedPlatforms.has(p))
      logical.push({ stopPosition: null, platform: p });
  logical.sort(
    (a, b) =>
      Math.min(
        a.stopPosition?.rawIndex ?? Infinity,
        a.platform?.rawIndex ?? Infinity
      ) -
      Math.min(
        b.stopPosition?.rawIndex ?? Infinity,
        b.platform?.rawIndex ?? Infinity
      )
  );
  return logical.map((x) => {
    const pr = x.platform?.tags.ref || "",
      sr = x.stopPosition?.tags.ref || "",
      pn = x.platform?.tags.name || "",
      sn = x.stopPosition?.tags.name || "",
      pa = x.platform?.restriction || null,
      sa = x.stopPosition?.restriction || null;
    return {
      ...x,
      ref: pr || sr,
      name: pn || sn,
      restriction: sa || pa || "normal",
      internalRefOk: !pr || !sr || stopRefMatches(pr, sr),
      internalNameOk: !pn || !sn || pn === sn,
      internalRestrictionOk: !pa || !sa || pa === sa
    };
  });
};
const osmLogicalPoint = (s) =>
  s.platform
    ? [s.platform.lon, s.platform.lat]
    : s.stopPosition
      ? [s.stopPosition.lon, s.stopPosition.lat]
      : null;
const osmEditTarget = (s) => {
  const candidates = [s.stopPosition, s.platform].filter(Boolean),
    x = candidates.find((item) => item.type === "node") || candidates[0];
  return x ? { osmType: x.type, osmId: x.osmId, lat: x.lat, lon: x.lon } : null;
};
const osmPopupTarget = (s) => {
  const candidates = [s.platform, s.stopPosition].filter(Boolean),
    x = candidates.find((item) => item.type === "node") || candidates[0];
  return x ? { osmType: x.type, osmId: x.osmId, lat: x.lat, lon: x.lon } : null;
};
const gtfsRestriction = (s) => {
  const p = String(s.pickupType ?? "0"),
    d = String(s.dropOffType ?? "0");
  if (p === "0" && d === "0") return { code: "normal", special: false };
  if (p === "0" && d === "1") return { code: "entry_only", special: false };
  if (p === "1" && d === "0") return { code: "exit_only", special: false };
  return { code: `${p}/${d}`, special: true };
};
const stopMatchCost = (g, o) => {
  const p = osmLogicalPoint(o),
    distance = p ? geoDistance([g.lon, g.lat], p) : Infinity;
  let cost = finite(distance)
    ? Math.min(distance / DEFAULT_STOP_RADIUS_METERS, 3)
    : 3;
  cost += g.code && o.ref ? (stopRefMatches(g.code, o.ref) ? -1.2 : 1.2) : 0.8;
  cost += g.name && o.name ? (g.name === o.name ? -0.8 : 0.8) : 0.6;
  return Math.max(0, cost);
};
const alignStops = (gtfs, osm) => {
  const n = gtfs.length,
    m = osm.length,
    gap = 2.4,
    dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0)),
    path = Array.from({ length: n + 1 }, () => Array(m + 1).fill(""));
  for (let i = 1; i <= n; i++) {
    dp[i][0] = i * gap;
    path[i][0] = "g";
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = j * gap;
    path[0][j] = "o";
  }
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const match = dp[i - 1][j - 1] + stopMatchCost(gtfs[i - 1], osm[j - 1]),
        missing = dp[i - 1][j] + gap,
        extra = dp[i][j - 1] + gap;
      if (match <= missing && match <= extra) {
        dp[i][j] = match;
        path[i][j] = "m";
      } else if (missing <= extra) {
        dp[i][j] = missing;
        path[i][j] = "g";
      } else {
        dp[i][j] = extra;
        path[i][j] = "o";
      }
    }
  const out = [];
  let i = n,
    j = m;
  while (i || j) {
    const op = path[i][j];
    if (op === "m") {
      out.push({ type: "match", gtfsIndex: i - 1, osmIndex: j - 1 });
      i--;
      j--;
    } else if (op === "g") {
      out.push({ type: "missing", gtfsIndex: i - 1 });
      i--;
    } else {
      out.push({ type: "extra", osmIndex: j - 1 });
      j--;
    }
  }
  return out.reverse();
};
const uniqueRefPositions = (stops) => {
  const counts = new Map(),
    positions = new Map();
  stops.forEach((s, i) => {
    const ref = normalizeStopRef(s.code ?? s.ref ?? "");
    if (!ref) return;
    counts.set(ref, (counts.get(ref) || 0) + 1);
    positions.set(ref, i);
  });
  for (const [ref, count] of counts) if (count !== 1) positions.delete(ref);
  return positions;
};
const orderErrorRefs = (gtfs, osm) => {
  const g = uniqueRefPositions(gtfs),
    o = uniqueRefPositions(osm),
    common = [...g.keys()]
      .filter((ref) => o.has(ref))
      .sort((a, b) => g.get(a) - g.get(b)),
    errors = new Set();
  let max = -1,
    maxRef = null;
  for (const ref of common) {
    const pos = o.get(ref);
    if (pos < max) {
      errors.add(ref);
      if (maxRef) errors.add(maxRef);
    } else {
      max = pos;
      maxRef = ref;
    }
  }
  return errors;
};
const lcsLength = (a, b) => {
  if (!a.length || !b.length) return 0;
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++)
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    previous = current;
  }
  return previous[b.length];
};
const stopSequenceScore = (shape, parsed) => {
  const gtfs = shape.stops.map((s) => normalizeStopRef(s.code)).filter(Boolean),
    osm = buildOsmLogicalStops(parsed)
      .map((s) => normalizeStopRef(s.ref))
      .filter(Boolean),
    matches = lcsLength(gtfs, osm),
    score =
      gtfs.length && osm.length
        ? (2 * matches) / (gtfs.length + osm.length)
        : 0;
  return { matches, score };
};
const relationWarnings = (shape, from, relation) => {
  const warnings = [];
  if (from !== null && relation.tags.from !== from)
    warnings.push({
      key: "from",
      expected: from,
      actual: relation.tags.from || ""
    });
  if (relation.tags.to !== shape.headsign)
    warnings.push({
      key: "to",
      expected: shape.headsign,
      actual: relation.tags.to || ""
    });
  return warnings;
};
const relationWarningText = (warnings) =>
  warnings
    .map((w) => `${w.key} WARN · GTFS "${w.expected}" ≠ OSM "${w.actual}"`)
    .join(" · ");
const identifyRelationByStops = async (route, shape, relations, from) => {
  const scored = (
    await Promise.all(
      relations.map(async (relation) => {
        try {
          const parsed = await loadFullOsmRelation(relation.id),
            score = stopSequenceScore(shape, parsed),
            textScore =
              (relation.tags.to === shape.headsign ? 1 : 0) +
              (from !== null && relation.tags.from === from ? 1 : 0);
          return { relation, parsed, textScore, ...score };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);
  scored.sort(
    (a, b) =>
      b.matches - a.matches || b.score - a.score || b.textScore - a.textScore
  );
  const best = scored[0],
    second = scored[1];
  if (!best) return null;
  const strong =
      best.matches >= STOP_FALLBACK_MIN_MATCHES &&
      best.score >= STOP_FALLBACK_MIN_RATIO,
    clear =
      !second ||
      best.matches > second.matches ||
      best.score - second.score >= STOP_FALLBACK_MIN_LEAD;
  return strong && clear ? best : null;
};
const resolveOsmRelation = async (route, shape, relations) => {
  const from = expectedFrom(route, shape),
    exact = relations.filter(
      (relation) =>
        relation.tags.to === shape.headsign &&
        (from === null || relation.tags.from === from)
    );
  if (exact.length === 1) return { relation: exact[0], warnings: [] };
  const byStops = await identifyRelationByStops(route, shape, relations, from);
  if (byStops)
    return {
      relation: byStops.relation,
      parsed: byStops.parsed,
      warnings: relationWarnings(shape, from, byStops.relation)
    };
  const endpointMatches = relations.filter(
    (relation) =>
      relation.tags.to === shape.headsign ||
      (from !== null && relation.tags.from === from)
  );
  if (endpointMatches.length === 1)
    return {
      relation: endpointMatches[0],
      warnings: relationWarnings(shape, from, endpointMatches[0])
    };
  if (relations.length === 1)
    return {
      relation: relations[0],
      warnings: relationWarnings(shape, from, relations[0])
    };
  throw new Error(
    "No es pot identificar inequívocament la relació OSM d’aquest sentit"
  );
};
const compareStops = (shape, parsed) => {
  const gtfs = shape.stops,
    osm = buildOsmLogicalStops(parsed),
    alignment = alignStops(gtfs, osm),
    orderErrors = orderErrorRefs(gtfs, osm),
    errors = [],
    summary = {
      totalGtfs: gtfs.length,
      ok: 0,
      specialRestrictions: 0,
      errorCount: 0
    };
  for (const stop of gtfs)
    stop.osmQa = {
      checked: true,
      exists: false,
      osmType: "",
      osmId: "",
      lat: stop.lat,
      lon: stop.lon
    };
  for (const item of alignment) {
    if (item.type === "missing") {
      const g = gtfs[item.gtfsIndex],
        issues = [{ label: "PARADA", text: "Falta a OSM" }];
      summary.errorCount++;
      errors.push({
        code: g.code || g.id,
        name: g.name,
        issues,
        lon: g.lon,
        lat: g.lat,
        editLon: g.lon,
        editLat: g.lat,
        osmType: "",
        osmId: "",
        osmLon: null,
        osmLat: null
      });
      continue;
    }
    if (item.type === "extra") {
      const o = osm[item.osmIndex],
        p = osmLogicalPoint(o),
        target = osmEditTarget(o),
        issues = [{ label: "PARADA", text: "Parada extra a OSM" }];
      summary.errorCount++;
      if (p)
        errors.push({
          code: o.ref || "OSM",
          name: o.name || "Parada extra OSM",
          issues,
          lon: p[0],
          lat: p[1],
          editLon: target?.lon ?? p[0],
          editLat: target?.lat ?? p[1],
          osmType: target?.osmType || "",
          osmId: target?.osmId || "",
          osmLon: null,
          osmLat: null
        });
      continue;
    }
    const g = gtfs[item.gtfsIndex],
      o = osm[item.osmIndex],
      popupTarget = osmPopupTarget(o),
      issues = [];
    if (popupTarget)
      g.osmQa = {
        checked: true,
        exists: true,
        osmType: popupTarget.osmType,
        osmId: popupTarget.osmId,
        lat: popupTarget.lat,
        lon: popupTarget.lon
      };
    let positionTarget = null;
    if (!o.platform) issues.push({ label: "PLATFORM", text: "Falta platform" });
    else {
      const d = geoDistance([g.lon, g.lat], [o.platform.lon, o.platform.lat]);
      if (d > DEFAULT_STOP_RADIUS_METERS) {
        positionTarget = o.platform;
        issues.push({
          label: "POSICIÓ",
          text: `Platform a ${d.toFixed(1)} m de la parada GTFS`
        });
      }
    }
    if (!o.stopPosition)
      issues.push({ label: "STOP_POSITION", text: "Falta stop_position" });
    if (!stopRefMatches(g.code, o.ref))
      issues.push({
        label: "REF",
        rows: [
          ["GTFS", g.code || ""],
          ["OSM", o.ref || ""]
        ]
      });
    if (g.name !== o.name)
      issues.push({
        label: "NOM",
        rows: [
          ["GTFS", g.name || ""],
          ["OSM", o.name || ""]
        ]
      });
    if (!o.internalRefOk)
      issues.push({
        label: "REF OSM",
        rows: [
          ["PLATFORM", o.platform?.tags.ref || ""],
          ["STOP", o.stopPosition?.tags.ref || ""]
        ]
      });
    if (!o.internalNameOk)
      issues.push({
        label: "NOM OSM",
        rows: [
          ["PLATFORM", o.platform?.tags.name || ""],
          ["STOP", o.stopPosition?.tags.name || ""]
        ]
      });
    if (!o.internalRestrictionOk)
      issues.push({
        label: "ROL OSM",
        rows: [
          ["PLATFORM", o.platform?.restriction || ""],
          ["STOP", o.stopPosition?.restriction || ""]
        ]
      });
    const expected = gtfsRestriction(g);
    if (expected.special) summary.specialRestrictions++;
    else if (expected.code !== o.restriction)
      issues.push({
        label: "PUJADA / BAIXADA",
        rows: [
          ["GTFS", expected.code],
          ["OSM", o.restriction]
        ]
      });
    const normalizedCode = normalizeStopRef(g.code);
    if (normalizedCode && orderErrors.has(normalizedCode))
      issues.push({
        label: "ORDRE",
        text: "Ordre incorrecte a la relació OSM"
      });
    if (issues.length) {
      summary.errorCount += issues.length;
      const target = positionTarget || osmEditTarget(o);
      errors.push({
        code: g.code || g.id,
        name: g.name,
        issues,
        lon: g.lon,
        lat: g.lat,
        editLon: target?.lon ?? g.lon,
        editLat: target?.lat ?? g.lat,
        osmType: target?.osmType || "",
        osmId: target?.osmId || "",
        osmLon: positionTarget?.lon ?? null,
        osmLat: positionTarget?.lat ?? null
      });
    } else summary.ok++;
  }
  return { errors, summary };
};
const drawStopErrors = (shape, result) => {
  clearShapeQaErrors(shape.id, "stop");
  const features = [];
  for (const e of result.errors) {
    features.push(
      new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([e.lon, e.lat])),
        type: "qa-stop-error",
        qaKind: "stop",
        shapeId: shape.id,
        code: e.code,
        name: e.name,
        issues: e.issues,
        editLat: e.editLat,
        editLon: e.editLon,
        osmType: e.osmType,
        osmId: e.osmId
      })
    );
    if (finite(e.osmLon) && finite(e.osmLat)) {
      const gtfs = ol.proj.fromLonLat([e.lon, e.lat]),
        osm = ol.proj.fromLonLat([e.osmLon, e.osmLat]);
      features.push(
        new ol.Feature({
          geometry: new ol.geom.LineString([gtfs, osm]),
          type: "qa-stop-distance-line",
          qaKind: "stop",
          shapeId: shape.id
        }),
        new ol.Feature({
          geometry: new ol.geom.Point(osm),
          type: "qa-stop-distance-osm",
          qaKind: "stop",
          shapeId: shape.id
        })
      );
    }
  }
  state.qaErrorLayer?.getSource().addFeatures(features);
};
const formatSignedDistance = (meters) => {
  const absolute = Math.abs(meters),
    sign = meters > 0.5 ? "+" : meters < -0.5 ? "−" : "";
  return absolute < 1000
    ? `${sign}${absolute.toFixed(0)} m`
    : `${sign}${(absolute / 1000).toFixed(2)} km`;
};
const formatSignedPercent = (value) =>
  `${value > 0.05 ? "+" : value < -0.05 ? "−" : ""}${Math.abs(value).toFixed(1)}%`;
const renderQaStatus = (status, relationId, warnings, geometry, stops) => {
  status.replaceChildren(el("span", "qa-status-id", `OSM ${relationId}`));
  for (const w of warnings) {
    const block = el("span", "qa-status-warning");
    block.append(
      el("b", "", `${w.key.toUpperCase()} WARN`),
      el("span", "", `GTFS  ${w.expected || "—"}`),
      el("span", "", `OSM   ${w.actual || "—"}`)
    );
    status.append(block);
  }
  status.append(
    el(
      "span",
      "qa-status-line",
      `Longitud  GTFS ${(geometry.lengths.gtfsMeters / 1000).toFixed(2)} km · OSM ${(geometry.lengths.osmMeters / 1000).toFixed(2)} km`
    ),
    el(
      "span",
      "qa-status-line",
      `Diferència OSM−GTFS  ${formatSignedDistance(geometry.lengths.differenceMeters)} · ${formatSignedPercent(geometry.lengths.differencePercent)}`
    ),
    el(
      "span",
      "qa-status-line",
      `Geometria  G→O ${geometry.gtfsToOsm.percentage.toFixed(1)}% · O→G ${geometry.osmToGtfs.percentage.toFixed(1)}%`
    ),
    el(
      "span",
      "qa-status-line",
      `Parades  ${stops.summary.ok}/${stops.summary.totalGtfs} OK · ${stops.summary.errorCount} ${stops.summary.errorCount === 1 ? "incidència" : "incidències"}`
    )
  );
};
window.runOsmQa = async (route, shape, button, status) => {
  button.disabled = true;
  button.textContent = "OSM…";
  status.hidden = false;
  status.className = "qa-status";
  status.textContent = "Consultant Overpass…";
  status.title = "";
  try {
    const relations = await getOsmRelations(route);
    if (state.selected?.id !== route.id) return;
    if (!relations.length)
      throw new Error("No s’han trobat relacions OSM per a aquesta línia");
    status.textContent = "Identificant la relació OSM…";
    const resolved = await resolveOsmRelation(route, shape, relations),
      relation = resolved.relation,
      warningText = relationWarningText(resolved.warnings);
    if (warningText) status.title = warningText;
    status.textContent = `OSM ${relation.id} · descarregant la relació…`;
    const parsed = resolved.parsed || (await loadFullOsmRelation(relation.id));
    if (state.selected?.id !== route.id) return;
    drawOsmRelation(shape, relation.id, parsed);
    clearShapeQaErrors(shape.id);
    status.textContent = `OSM ${relation.id} · comparant geometria i parades…`;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const geometry = compareRouteGeometry(shape, parsed),
      stops = compareStops(shape, parsed);
    drawGeometryErrors(shape, geometry);
    drawStopErrors(shape, stops);
    revealQaErrorsToggle();
    const routeClass = geometryQaClass(geometry.match),
      textWarning = !!resolved.warnings.length,
      qaClass = stops.summary.errorCount
        ? "qa-error"
        : routeClass === "qa-error"
          ? "qa-error"
          : textWarning ||
              stops.summary.specialRestrictions ||
              routeClass === "qa-warning"
            ? "qa-warning"
            : "qa-ok";
    status.className = `qa-status ${qaClass}`;
    renderQaStatus(status, relation.id, resolved.warnings, geometry, stops);
    button.className = `qa-button ${qaClass}`;
  } catch (error) {
    const old = state.osmLayers.get(shape.id);
    if (old) {
      state.map.removeLayer(old);
      state.osmLayers.delete(shape.id);
    }
    clearShapeQaErrors(shape.id);
    status.className = "qa-status qa-error";
    status.textContent =
      error instanceof Error ? error.message : "Error executant OSM_QA";
    status.title = "";
    button.className = "qa-button qa-error";
  } finally {
    button.disabled = false;
    button.textContent = "OSM_QA";
  }
};
})();
