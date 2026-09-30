const colors = ["#ff2633", "#00c8a5", "#ffd400", "#36a3ff", "#f06cff", "#ff8b2b"],
	state = {
		routes: [],
		selected: null,
		map: null,
		popup: null,
		shapeLayers: new Map(),
		osmLayers: new Map(),
		hiddenShapes: new Set(),
		expandedShapeGroups: new Set(),
		qaRouteRelations: new Map(),
		qaRequests: new Map(),
		qaFullRelations: new Map(),
		qaFullRequests: new Map(),
		qaErrorLayer: null,
		qaErrorsVisible: true,
		gtfsAgency: null,
		gtfsFeed: null
	},
	$ = (id) => document.getElementById(id),
	finite = Number.isFinite,
	el = (tag, className = "", text) => {
		const e = document.createElement(tag);
		if (className) e.className = className;
		if (text !== undefined) e.textContent = text;
		return e;
	},
	externalLink = (className, text, href) =>
		Object.assign(el("a", className, text), { href, target: "_blank", rel: "noopener noreferrer" }),
	appendExisting = (parent, nodes) => parent.append(...nodes.filter(Boolean)),
	{ formatDateKey, dateRanges, formatDateRange, calendarSummary } = window.TmbGtfs;
const setLoading = (title, detail) => {
		$("loading-title").textContent = title;
		$("loading-detail").textContent = detail;
	},
	manualVisible = (s) => !state.hiddenShapes.has(s.id),
	groupVisible = (s) => s.status === "active" || s.status === "unknown" || state.expandedShapeGroups.has(s.status),
	visible = (s) => manualVisible(s) && groupVisible(s);
const normalizeStopRef = (value) => {
		const ref = String(value ?? "").trim();
		return /^\d+$/.test(ref) ? ref.padStart(4, "0") : ref;
	},
	stopRefMatches = (a, b) => {
		const x = normalizeStopRef(a), y = normalizeStopRef(b);
		return !!x && !!y && x === y;
	},
	idEditUrl = (lat, lon, osmType = "", osmId = "") => {
		const target = osmType && osmId ? `&${osmType}=${encodeURIComponent(osmId)}` : "";
		return `https://www.openstreetmap.org/edit?editor=id${target}#map=22/${Number(lat).toFixed(7)}/${Number(lon).toFixed(7)}`;
	},
	osmObjectUrl = (osmType, osmId) => `https://www.openstreetmap.org/${encodeURIComponent(osmType)}/${encodeURIComponent(osmId)}`,
	osmMapUrl = (lat, lon) => `https://www.openstreetmap.org/#map=22/${Number(lat).toFixed(7)}/${Number(lon).toFixed(7)}`;
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
	setTimeout(() => { button.textContent = old; button.disabled = false; }, 900);
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
const infoValue = (value) => {
	if (value === undefined || value === null || value === "") return "—";
	return String(value);
};
const createInfoRows = (rows) => {
	const grid = el("div", "info-grid");
	for (const [label, value] of rows) {
		const row = el("div", "info-row"),
			key = el("span", "info-key", label),
			raw = infoValue(value),
			val = /^https?:\/\//i.test(raw)
				? externalLink("info-value", raw, raw)
				: el("span", "info-value", raw);
		row.append(key, val);
		grid.append(row);
	}
	return grid;
};
const createInfoSection = (title, rows) => {
	const section = el("section", "info-section");
	section.append(el("h3", "", title), createInfoRows(rows));
	return section;
};
const createRawDetails = (title, raw, open = false) => {
	if (!raw) return null;
	const details = el("details", "gtfs-raw"),
		summary = el("summary", "", title),
		rows = Object.entries(raw);
	details.open = open;
	details.append(summary, createInfoRows(rows));
	return details;
};
const polylineDistanceKm = (points) => {
	let meters = 0;
	for (let i = 1; i < points.length; i++) {
		const [lat1, lon1] = points[i - 1],
			[lat2, lon2] = points[i],
			p1 = (lat1 * Math.PI) / 180,
			p2 = (lat2 * Math.PI) / 180,
			dp = ((lat2 - lat1) * Math.PI) / 180,
			dl = ((lon2 - lon1) * Math.PI) / 180,
			a =
				Math.sin(dp / 2) ** 2 +
				Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
		meters += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	}
	return meters / 1000;
};
const pickupText = (value) =>
	({
		"0": "Permesa",
		"1": "No permesa",
		"2": "Cal contactar amb l’operador",
		"3": "Cal coordinar amb el conductor"
	})[String(value)] || `Codi ${infoValue(value)}`;
const accessibilityText = (value) =>
	({ "0": "Sense informació", "1": "Accessible", "2": "No accessible" })[
		String(value)
	] || `Codi ${infoValue(value)}`;
const bikesText = (value) =>
	({ "0": "Sense informació", "1": "Permeses", "2": "No permeses" })[
		String(value)
	] || `Codi ${infoValue(value)}`;
const tripPatternKindText = (kind) =>
	({
		full: "Principal",
		"partial-start": "Parcial inicial",
		"partial-end": "Parcial final",
		partial: "Parcial intermedi",
		unknown: "Patró"
	})[kind] || "Patró";
const tripPatternRows = (shape) =>
	(shape.tripPatterns || []).map((pattern) => {
		const range =
				finite(pattern.firstSequence) && finite(pattern.lastSequence)
					? `${pattern.firstSequence}–${pattern.lastSequence}`
					: "seq. desconeguda",
			stops = `${pattern.stopCount} ${pattern.stopCount === 1 ? "parada" : "parades"}`,
			trips = `${pattern.tripCount} ${pattern.tripCount === 1 ? "viatge" : "viatges"}`,
			endpoints =
				pattern.firstStopName || pattern.lastStopName
					? `${pattern.firstStopName || pattern.firstStopId || "—"} → ${pattern.lastStopName || pattern.lastStopId || "—"}`
					: "";
		return [
			`${tripPatternKindText(pattern.kind)} · ${trips}`,
			`${range} · ${stops}${endpoints ? ` · ${endpoints}` : ""}`
		];
	});
const setInfoPanelOpen = (open) => {
	const panel = $("info-panel"),
		toggle = $("info-panel-toggle");
	if (!panel || !toggle) return;
	panel.classList.toggle("is-open", open);
	toggle.setAttribute("aria-expanded", String(open));
};
const panelHeader = (eyebrow, title, subtitle = "") => {
	const head = el("div", "info-context-head");
	head.append(el("span", "eyebrow", eyebrow), el("h2", "", title));
	if (subtitle) head.append(el("p", "", subtitle));
	return head;
};
const showRouteInfo = (route, openMobile = false) => {
	if (!route) return;
	const panel = $("info-panel"),
		content = $("info-panel-content"),
		active = route.shapes.filter((shape) => shape.status === "active"),
		future = route.shapes.filter((shape) => shape.status === "future"),
		past = route.shapes.filter((shape) => shape.status === "past"),
		relevant = active.length ? active : route.shapes,
		uniqueStops = new Set(relevant.flatMap((shape) => shape.stops.map((stop) => stop.id))),
		head = panelHeader("Línia", route.shortName, route.longName),
		summary = createInfoSection("Resum", [
			["Recorreguts actius avui", active.length],
			["Pròxims recorreguts", future.length],
			["Recorreguts passats", past.length],
			["Parades", uniqueStops.size]
		]),
		shapeSection = el("section", "info-section"),
		shapeList = el("div", "info-shape-list");
	shapeSection.append(el("h3", "", "Recorreguts"));
	for (const shape of route.shapes) {
		const button = el("button", "info-shape-button"),
			strong = el("strong", "", shape.label),
			meta = el(
				"span",
				"",
				`${statusText(shape)} · ${shape.stops.length} parades · ${polylineDistanceKm(shape.points).toFixed(1)} km`
			);
		button.type = "button";
		button.onclick = () => showShapeInfo(route, shape, true);
		button.append(strong, meta);
		shapeList.append(button);
	}
	shapeSection.append(shapeList);
	const technical = el("section", "info-technical");
	appendExisting(technical, [
		createRawDetails("routes.txt · tots els camps", route.raw),
		createRawDetails("agency.txt · operador", state.gtfsAgency),
		createRawDetails("feed_info.txt · font", state.gtfsFeed)
	]);
	content.replaceChildren(head, summary, shapeSection, technical);
	$("info-panel-caption").textContent = `Línia ${route.shortName}`;
	panel.hidden = false;
	$("application").classList.add("has-info");
	setInfoPanelOpen(openMobile);
};
const showShapeInfo = (route, shape, openMobile = true) => {
	if (!route || !shape) return;
	const panel = $("info-panel"),
		content = $("info-panel-content"),
		back = el("button", "info-back", `← Línia ${route.shortName}`),
		head = panelHeader("Recorregut", shape.label, statusText(shape)),
		summary = createInfoSection("Servei", [
			["Dates", calendarSummary(shape.serviceDates)],
			["Parades del patró principal", shape.stops.length],
			["Longitud aproximada", `${polylineDistanceKm(shape.points).toFixed(1)} km`],
			["Direcció GTFS", shape.direction],
			["shape_id", shape.id],
			["trip_id de mostra", shape.representativeTrip]
		]),
		patternRows = tripPatternRows(shape),
		patterns = patternRows.length
			? createInfoSection("Patrons de viatge", patternRows)
			: null,
		stops = el("details", "info-stop-list"),
		stopSummary = el("summary", "", `Parades (${shape.stops.length})`),
		stopButtons = el("div", "info-stop-buttons");
	back.type = "button";
	back.onclick = () => showRouteInfo(route, true);
	shape.stops.forEach((stop) => {
		const button = el(
			"button",
			"info-stop-button",
			`${stop.sequence}. ${stop.code || stop.id} · ${stop.name}`
		);
		button.type = "button";
		button.onclick = () => showStopInfo(route, shape, stop, true);
		stopButtons.append(button);
	});
	stops.append(stopSummary, stopButtons);
	const technical = el("section", "info-technical");
	technical.append(
		createInfoSection("Identificadors", [
			["service_id", shape.serviceIds.join(" · ")],
			["Punts de geometria", shape.points.length],
			["shape_dist_traveled màxim", shape.distance || "—"]
		])
	);
	appendExisting(technical, [
		createRawDetails("trips.txt · viatge de mostra", shape.tripRaw),
		createRawDetails("routes.txt · línia", route.raw)
	]);
	content.replaceChildren(
		back,
		head,
		summary,
		...(patterns ? [patterns] : []),
		stops,
		technical
	);
	$("info-panel-caption").textContent = shape.label;
	panel.hidden = false;
	setInfoPanelOpen(openMobile);
};
const osmTargetForStop = (stop) => {
	const qa = stop?.osmQa,
		exists = !!(qa?.checked && qa.exists && qa.osmType && qa.osmId);
	return {
		checked: !!qa?.checked,
		exists,
		osmType: exists ? qa.osmType : "",
		osmId: exists ? qa.osmId : "",
		lat: exists && finite(qa.lat) ? qa.lat : stop?.lat,
		lon: exists && finite(qa.lon) ? qa.lon : stop?.lon
	};
};
const osmActionUrls = (target) => [
		idEditUrl(
			target.lat,
			target.lon,
			target.exists ? target.osmType : "",
			target.exists ? target.osmId : ""
		),
		target.exists
			? osmObjectUrl(target.osmType, target.osmId)
			: osmMapUrl(target.lat, target.lon)
	],
	createPopupOsmActions = (target) => {
		const actions = el("div", "popup-actions"),
			[editUrl, viewUrl] = osmActionUrls(target);
		actions.append(
			externalLink(
				"popup-edit",
				target.exists ? "Editar en iD" : "Editar zona en iD",
				editUrl
			),
			externalLink(
				"popup-edit",
				target.exists ? "Veure en OSM" : "Veure zona OSM",
				viewUrl
			)
		);
		return actions;
	};
const createStopRoutesSection = (stop, currentRoute) => {
	const section = el("section", "info-section"),
		list = el("div", "info-shape-list"),
		routes = (stop.routeIds || [])
			.map((id) => state.routes.find((route) => route.id === id))
			.filter(Boolean);
	section.append(el("h3", "", "Línies GTFS en aquesta parada"));
	for (const route of routes) {
		const button = el("button", "info-shape-button"),
			name = el("strong", "", route.shortName),
			meta = el(
				"span",
				"",
				`${route.longName}${route.id === currentRoute.id ? " · línia seleccionada" : ""}`
			);
		button.type = "button";
		button.onclick = () => selectRoute(route);
		button.append(name, meta);
		list.append(button);
	}
	section.append(list);
	return section;
};
const showStopInfo = (route, shape, stop, openMobile = true) => {
	if (!route || !shape || !stop) return;
	const panel = $("info-panel"),
		content = $("info-panel-content"),
		back = el("button", "info-back", `← ${shape.label}`),
		head = panelHeader(
			"Parada",
			stop.code || stop.id,
			stop.name
		),
		trip = shape.tripRaw || {},
		osmTarget = osmTargetForStop(stop),
		summary = createInfoSection("En aquest recorregut", [
			["Ordre", stop.sequence],
			["Arribada", stop.stopTimeRaw?.arrival_time],
			["Sortida", stop.stopTimeRaw?.departure_time],
			["Pujada", pickupText(stop.pickupType)],
			["Baixada", pickupText(stop.dropOffType)],
			["Destinació a la parada", stop.stopTimeRaw?.stop_headsign],
			["Distància acumulada", stop.stopTimeRaw?.shape_dist_traveled]
		]),
		location = createInfoSection("Parada", [
			["Nom", stop.name],
			["Codi", stop.code],
			["stop_id", stop.id],
			["Latitud", stop.lat],
			["Longitud", stop.lon],
			["Accessibilitat parada", accessibilityText(stop.raw?.wheelchair_boarding)]
		]),
		lines = createStopRoutesSection(stop, route),
		tripInfo = createInfoSection("Viatge", [
			["Línia", `${route.shortName} · ${route.longName}`],
			["Recorregut", shape.label],
			["Accessibilitat vehicle", accessibilityText(trip.wheelchair_accessible)],
			["Bicicletes", bikesText(trip.bikes_allowed)],
			["service_id", trip.service_id],
			["trip_id", shape.representativeTrip]
		]),
		osmInfo = createInfoSection("OpenStreetMap", [
			[
				"Estat",
				!osmTarget.checked
					? "OSM_QA pendent"
					: osmTarget.exists
						? "Parada localitzada a OSM"
						: "Parada no trobada a OSM"
			],
			[
				"Objecte",
				osmTarget.exists ? `${osmTarget.osmType} ${osmTarget.osmId}` : "—"
			]
		]),
		[editUrl, viewUrl] = osmActionUrls(osmTarget),
		edit = externalLink(
			"info-edit",
			osmTarget.exists ? "Editar parada en iD" : "Editar zona en iD",
			editUrl
		),
		view = externalLink(
			"info-edit",
			osmTarget.exists ? "Veure parada en OSM" : "Veure zona en OSM",
			viewUrl
		),
		technical = el("section", "info-technical");
	back.type = "button";
	back.onclick = () => showShapeInfo(route, shape, true);
	appendExisting(technical, [
		createRawDetails("stops.txt · tots els camps", stop.raw),
		createRawDetails("stop_times.txt · tots els camps", stop.stopTimeRaw),
		createRawDetails("trips.txt · tots els camps", shape.tripRaw),
		createRawDetails("routes.txt · tots els camps", route.raw)
	]);
	content.replaceChildren(
		back,
		head,
		summary,
		location,
		lines,
		tripInfo,
		osmInfo,
		edit,
		view,
		technical
	);
	$("info-panel-caption").textContent = `Parada ${stop.code || stop.id}`;
	panel.hidden = false;
	setInfoPanelOpen(openMobile);
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
		const stop = f.get("stop"),
			target = osmTargetForStop(stop),
			label = !target.checked
				? "Parada TMB · OSM_QA pendent"
				: target.exists
					? `Parada TMB · OSM ${target.osmType} ${target.osmId}`
					: "Parada TMB · no trobada a OSM";
		body.append(
			el("span", "popup-normal-label", label),
			createPopupOsmActions(target)
		);
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
		target = {
			checked: true,
			exists: !!(osmType && osmId),
			osmType,
			osmId,
			lat: f.get("editLat"),
			lon: f.get("editLon")
		};
	body.append(createPopupOsmActions(target));
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
		const shape = state.selected?.shapes.find(
			(candidate) => candidate.id === f.get("shapeId")
		);
		if (shape && !visible(shape)) return null;
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
				(f) =>
					f.get("type") === "stop" || f.get("type") === "route-shape"
						? f
						: undefined,
				{ hitTolerance: 8, layerFilter: (l) => l !== state.qaErrorLayer }
			),
		hit = (e) => hitQa(e) || hitGtfs(e);
	state.map.on("singleclick", (e) => {
		const f = hit(e);
		if (!f) {
			popup.hidden = true;
			state.popup.setPosition();
			if (state.selected) showRouteInfo(state.selected, false);
			return;
		}
		if (f.get("type") === "qa-stop-error") {
			popup.replaceChildren(popupContent(f));
			popup.hidden = false;
			state.popup.setPosition(f.getGeometry().getCoordinates());
			return;
		}
		const shape = f.get("shape");
		if (f.get("type") === "stop") {
			popup.replaceChildren(popupContent(f));
			popup.hidden = false;
			state.popup.setPosition(f.getGeometry().getCoordinates());
			showStopInfo(state.selected, shape, f.get("stop"), false);
		} else {
			popup.hidden = true;
			state.popup.setPosition();
			showShapeInfo(state.selected, shape, true);
		}
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
const fitVisibleRoute = (route, duration = 400) => {
	const extent = ol.extent.createEmpty();
	for (const shape of route.shapes) {
		if (!visible(shape)) continue;
		const layer = state.shapeLayers.get(shape.id)?.route,
			feature = layer?.getSource().getFeatures()[0];
		if (feature) ol.extent.extend(extent, feature.getGeometry().getExtent());
	}
	if (!ol.extent.isEmpty(extent))
		state.map
			.getView()
			.fit(extent, { padding: [45, 45, 45, 45], maxZoom: 15, duration });
};
const drawRoute = (route) => {
	clearRouteLayers();
	route.shapes.forEach((shape) => {
		const color = colors[shape.colorIndex % colors.length],
			coords = shape.points
				.filter(([lat, lon]) => finite(lat) && finite(lon))
				.map(([lat, lon]) => ol.proj.fromLonLat([lon, lat]));
		if (coords.length < 2) return;
		const geometry = new ol.geom.LineString(coords),
			routeFeature = new ol.Feature({
				geometry,
				type: "route-shape",
				shapeId: shape.id,
				shape
			}),
			routeLayer = new ol.layer.Vector({
				source: new ol.source.Vector({
					features: [routeFeature]
				}),
				style: makeRouteStyle(color),
				visible: visible(shape),
				zIndex: 20 + shape.colorIndex
			}),
			stops = shape.stops
				.filter((stop) => finite(stop.lon) && finite(stop.lat))
				.map(
					(stop) =>
						new ol.Feature({
							geometry: new ol.geom.Point(
								ol.proj.fromLonLat([stop.lon, stop.lat])
							),
							type: "stop",
							code: stop.code || stop.id,
							name: stop.name,
							shapeId: shape.id,
							shape,
							stop
						})
				),
			stopLayer = new ol.layer.Vector({
				source: new ol.source.Vector({ features: stops }),
				style: makeStopStyle(color),
				visible: visible(shape),
				zIndex: 100 + shape.colorIndex
			});
		state.map.addLayer(routeLayer);
		state.map.addLayer(stopLayer);
		state.shapeLayers.set(shape.id, { route: routeLayer, stops: stopLayer });
	});
	state.map.updateSize();
	fitVisibleRoute(route, 600);
};
const showMap = (route) => {
	state.map || initializeMap();
	requestAnimationFrame(() => {
		state.map.updateSize();
		drawRoute(route);
	});
};
const refreshShapeLayerVisibility = (shape) => {
	const isVisible = visible(shape),
		layers = state.shapeLayers.get(shape.id);
	if (layers) {
		layers.route.setVisible(isVisible);
		layers.stops.setVisible(isVisible);
	}
	state.osmLayers.get(shape.id)?.setVisible(isVisible);
};
const setShapeVisibility = (shape, isVisible) => {
	isVisible
		? state.hiddenShapes.delete(shape.id)
		: state.hiddenShapes.add(shape.id);
	refreshShapeLayerVisibility(shape);
	state.qaErrorLayer?.changed();
	const card = document.querySelector(
		`[data-shape-id="${CSS.escape(shape.id)}"]`
	);
	if (!card) return;
	card.classList.toggle("is-hidden", !manualVisible(shape));
	const button = card.querySelector(".visibility-toggle");
	button.setAttribute("aria-pressed", String(manualVisible(shape)));
	button.textContent = manualVisible(shape) ? "Ocultar" : "Mostrar";
};
const setShapeGroupExpanded = (route, status, expanded) => {
	expanded
		? state.expandedShapeGroups.add(status)
		: state.expandedShapeGroups.delete(status);
	const section = document.querySelector(
			`[data-shape-group="${CSS.escape(status)}"]`
		),
		body = section?.querySelector(".shape-group-grid"),
		button = section?.querySelector(".shape-group-toggle"),
		shapes = route.shapes.filter((shape) => shape.status === status);
	if (body) body.hidden = !expanded;
	if (button) {
		button.setAttribute("aria-expanded", String(expanded));
		const noun = status === "past" ? "recorreguts passats" : "pròxims recorreguts";
		button.textContent = `${expanded ? "Ocultar" : "Mostrar"} ${noun} (${shapes.length})`;
	}
	for (const shape of shapes) refreshShapeLayerVisibility(shape);
	state.qaErrorLayer?.changed();
	if (state.map) fitVisibleRoute(route);
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
const statusText = (shape) => {
		if (shape.status === "active") return "Actiu avui";
		if (shape.status === "future")
			return shape.nextDate
				? `Pròxim servei ${formatDateKey(shape.nextDate)}`
				: "Pròxim servei";
		if (shape.status === "past")
			return shape.lastDate
				? `Últim servei ${formatDateKey(shape.lastDate)}`
				: "Recorregut passat";
		return "Calendari no disponible";
	},
	createDateDetails = (shape) => {
		const dates = shape.serviceDates,
			ranges = dateRanges(dates),
			summary = el(
				"p",
				"shape-service-dates",
				`Dates de servei: ${calendarSummary(dates)}`
			);
		if (ranges.length <= 6) return [summary];
		const details = el("details", "shape-date-details"),
			toggle = el("summary", "", "Veure totes les dates"),
			full = el(
				"p",
				"",
				ranges.map(formatDateRange).join(" · ")
			);
		details.append(toggle, full);
		return [summary, details];
	};
const createShapeCard = (route, shape) => {
	const isManualVisible = manualVisible(shape),
		card = el("article", `shape-card${isManualVisible ? "" : " is-hidden"}`),
		swatch = el("span", "shape-swatch"),
		info = el("div", "shape-information"),
		titleRow = el("div", "shape-title-row"),
		status = el(
			"span",
			`shape-status shape-status-${shape.status}`,
			statusText(shape)
		),
		qaStatus = el("p", "qa-status"),
		actions = el("div", "shape-actions"),
		toggle = el(
			"button",
			"visibility-toggle",
			isManualVisible ? "Ocultar" : "Mostrar"
		),
		detailsButton = el("button", "info-button", "Info"),
		download = el("button", "download", "GPX"),
		qa = el("button", "qa-button", "OSM_QA");
	card.dataset.shapeId = shape.id;
	swatch.style.background = colors[shape.colorIndex % colors.length];
	qaStatus.hidden = true;
	titleRow.append(el("h3", "", shape.label), status);
	info.append(
		titleRow,
		el(
			"p",
			"",
			`${shape.points.length} punts · ${shape.stops.length} parades · dir. ${shape.direction}`
		),
		...createDateDetails(shape),
		qaStatus
	);
	toggle.type = detailsButton.type = download.type = qa.type = "button";
	toggle.setAttribute("aria-pressed", String(isManualVisible));
	toggle.onclick = () => setShapeVisibility(shape, !manualVisible(shape));
	detailsButton.onclick = () => showShapeInfo(route, shape, true);
	download.onclick = () => window.TmbGpx.download(route, shape);
	qa.onclick = () => runLazyOsmQa(route, shape, qa, qaStatus);
	actions.append(detailsButton, toggle, download, qa);
	card.append(swatch, info, actions);
	return card;
};
const createShapeGroup = (route, status, shapes) => {
	const section = el("section", `shape-group shape-group-${status}`),
		grid = el("div", "shape-group-grid");
	section.dataset.shapeGroup = status;
	grid.append(...shapes.map((shape) => createShapeCard(route, shape)));
	if (status === "active" || status === "unknown") {
		const title = status === "active" ? "Actius avui" : "Sense calendari",
			header = el("div", "shape-group-header");
		header.append(
			el("strong", "", title),
			el("span", "shape-group-count", String(shapes.length))
		);
		section.append(header, grid);
		return section;
	}
	const expanded = state.expandedShapeGroups.has(status),
		noun = status === "past" ? "recorreguts passats" : "pròxims recorreguts",
		button = el(
			"button",
			"shape-group-toggle",
			`${expanded ? "Ocultar" : "Mostrar"} ${noun} (${shapes.length})`
		);
	button.type = "button";
	button.setAttribute("aria-expanded", String(expanded));
	button.onclick = () =>
		setShapeGroupExpanded(
			route,
			status,
			!state.expandedShapeGroups.has(status)
		);
	grid.hidden = !expanded;
	section.append(button, grid);
	return section;
};
const selectRoute = (route) => {
	state.selected = route;
	state.hiddenShapes.clear();
	state.expandedShapeGroups.clear();
	state.qaRouteRelations.clear();
	state.qaRequests.clear();
	resetQaErrorsToggle();
	renderRoutes($("line-search").value);
	$("selected-badge").textContent = route.shortName;
	$("selected-name").textContent = route.longName;
	const groups = new Map([
			["active", []],
			["future", []],
			["past", []],
			["unknown", []]
		]),
		content = [];
	for (const shape of route.shapes) groups.get(shape.status).push(shape);
	if (!groups.get("active").length)
		content.push(
			el("p", "shape-empty-active", "Cap recorregut actiu avui.")
		);
	for (const status of ["active", "future", "past", "unknown"])
		if (groups.get(status).length)
			content.push(createShapeGroup(route, status, groups.get(status)));
	$("shape-list").replaceChildren(...content);
	$("placeholder").hidden = true;
	$("route-view").hidden = false;
	showRouteInfo(route, false);
	showMap(route);
	if (innerWidth < 980)
		$("results").scrollIntoView({ behavior: "smooth", block: "start" });
};
const startApplication = async () => {
	$("loading").hidden = false;
	$("error-view").hidden = true;
	$("application").hidden = true;
	try {
		const gtfs = await window.TmbGtfs.load("./gtfs.zip", setLoading);
		state.routes = gtfs.routes;
		state.gtfsAgency = gtfs.agency;
		state.gtfsFeed = gtfs.feed;
		const version = (gtfs.feed?.feed_version || gtfs.version || "").trim();
		$("dataset-date").textContent = version
			? `GTFS oficial · versió ${version.slice(0, 12)}`
			: "GTFS oficial";
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
$("download-all").addEventListener("click", () => {
	const route = state.selected,
		shapes = route?.shapes.filter(visible) || [];
	shapes.forEach((shape, index) =>
		setTimeout(() => window.TmbGpx.download(route, shape), index * 250)
	);
});
$("qa-errors-toggle").addEventListener("click", () =>
	setQaErrorsVisible(!state.qaErrorsVisible)
);
$("info-panel-toggle").addEventListener("click", () => {
	const open = $("info-panel-toggle").getAttribute("aria-expanded") === "true";
	setInfoPanelOpen(!open);
});
$("retry").addEventListener("click", startApplication);
startApplication();
