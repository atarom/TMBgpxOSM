window.TmbSimulation = (() => {
const model = {layer:null,route:null,date:"",availableDates:[],trips:[],pseudoTurns:[],features:new Map(),time:0,min:0,max:0,speed:30,playing:false,frame:0,lastFrame:0,open:false,prepared:false};
const $ = (id) => document.getElementById(id);
const finite = Number.isFinite;
const { formatDateKey } = window.TmbGtfs;
const el = (tag, className = "", text) => {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (text !== undefined) e.textContent = text;
	return e;
};
let shapeVisible = () => true, closePopup = () => {};
const makeSimulationStyle = () => {
	const cache = new Map();
	return (feature) => {
		const label = String(feature.get("pseudoTurnLabel") || ""),
			waiting = feature.get("status") === "waiting",
			key = `${waiting ? "waiting" : "running"}:${label}`;
		if (!cache.has(key))
			cache.set(key, new ol.style.Style({
				image: new ol.style.Circle({
					radius: 16,
					fill: new ol.style.Fill({ color: waiting ? "#f5b700" : "#e30613" }),
					stroke: new ol.style.Stroke({ color: "#fff", width: 3 })
				}),
				text: new ol.style.Text({
					text: label,
					font: "800 10px Arial, Helvetica, sans-serif",
					fill: new ol.style.Fill({ color: waiting ? "#111" : "#fff" }),
					stroke: new ol.style.Stroke({ color: waiting ? "rgba(255,255,255,.35)" : "#9f0009", width: 1 })
				}),
				zIndex: waiting ? 1 : 2
			}));
		return cache.get(key);
	};
};
const simulationBusPopupContent = (feature) => {
	const status = feature.get("status"),
		pseudoTurn = feature.get("pseudoTurn"),
		trip = feature.get("trip"),
		nextTrip = feature.get("nextTrip"),
		root = el("div", "popup-body"),
		code = el("span", "popup-code", pseudoTurn ? pseudoTurn.label : "—"),
		body = el("div", "popup-copy"),
		title = el("strong", "", `${feature.get("line") || ""} · pseudotorn ${pseudoTurn?.label || "—"}`);
	body.append(title);
	if (status === "waiting" && nextTrip) {
		body.append(
			el("span", "popup-normal-label", "Espera estimada a terminal"),
			el("span", "popup-normal-label", `Pròxima sortida ${formatSimulationTime(nextTrip.startTime)} · ${nextTrip.headsign || "sentit programat"}`),
			el("span", "popup-normal-label", "Continuïtat inferida pel GTFS; no és un torn oficial de TMB")
		);
	} else if (trip) {
		body.append(
			el("span", "popup-normal-label", `En servei · ${trip.headsign || "sentit programat"}`),
			el("span", "popup-normal-label", `${formatSimulationTime(trip.startTime)}–${formatSimulationTime(trip.endTime)}`),
			el("span", "popup-normal-label", `Expedició ${trip.id}`)
		);
	}
	root.append(code, body);
	return root;
};
const formatSimulationTime = (value) => {
	const seconds = Math.max(0, Math.round(Number(value) || 0)),
		hours = Math.floor(seconds / 3600),
		minutes = Math.floor((seconds % 3600) / 60);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};
const simulationDateLabel = (key, today) => {
	const date = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)))),
		weekday = new Intl.DateTimeFormat("ca-ES", { weekday: "short", timeZone: "UTC" }).format(date).replace(/\.$/, "");
	return `${weekday} ${formatDateKey(key)}${key === today ? " · avui" : ""}`;
};
const preferredSimulationDate = (route, requestedDate = "") => {
	const dates = route.simulationDates || [],
		today = route.simulationDate || "";
	if (requestedDate && dates.includes(requestedDate)) return requestedDate;
	if (today && dates.includes(today)) return today;
	return dates.find((date) => !today || date > today) || dates.at(-1) || "";
};
const barcelonaNow = () => {
	const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: "Europe/Madrid",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23"
		})
			.formatToParts(new Date())
			.filter((part) => part.type !== "literal"),
		values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return {
		date: `${values.year}${values.month}${values.day}`,
		seconds: Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second)
	};
};
const previousDateKey = (key) => {
	const date = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))) - 86400000);
	return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
};
const currentSimulationTarget = (route) => {
	const now = barcelonaNow(),
		dates = route.simulationDates || [],
		previousDate = previousDateKey(now.date),
		previousTime = now.seconds + 86400,
		previousActive = dates.includes(previousDate) && (route.simulationTrips || []).some((trip) => trip.serviceDates?.has(previousDate) && trip.startTime <= previousTime && trip.endTime >= previousTime);
	if (previousActive) return { date: previousDate, time: previousTime };
	if (dates.includes(now.date)) return { date: now.date, time: now.seconds };
	return { date: preferredSimulationDate(route), time: null };
};
const populateSimulationDates = (route, selectedDate) => {
	const select = $("simulation-service-date"),
		today = route.simulationDate || "",
		options = (route.simulationDates || []).map((date) => {
			const option = document.createElement("option");
			option.value = date;
			option.textContent = simulationDateLabel(date, today);
			return option;
		});
	select.replaceChildren(...options);
	select.disabled = !options.length;
	if (selectedDate) select.value = selectedDate;
};
const simulationPathForShape = (shape) => {
	if (shape.simulationPath) return shape.simulationPath;
	const coordinates = shape.points
		.filter(([lat, lon]) => finite(lat) && finite(lon))
		.map(([lat, lon]) => ol.proj.fromLonLat([lon, lat])),
		cumulative = [0];
	for (let i = 1; i < coordinates.length; i++)
		cumulative.push(cumulative[i - 1] + Math.hypot(coordinates[i][0] - coordinates[i - 1][0], coordinates[i][1] - coordinates[i - 1][1]));
	shape.simulationPath = { coordinates, cumulative, total: cumulative.at(-1) || 0 };
	return shape.simulationPath;
};
const projectSimulationAnchor = (path, anchor, minimumSegment = 0) => {
	const point = ol.proj.fromLonLat([anchor.lon, anchor.lat]),
		coordinates = path.coordinates;
	if (coordinates.length < 2) return null;
	let best = null,
		bestSquared = Infinity;
	for (let i = Math.min(Math.max(0, minimumSegment), coordinates.length - 2); i < coordinates.length - 1; i++) {
		const a = coordinates[i],
			b = coordinates[i + 1],
			dx = b[0] - a[0],
			dy = b[1] - a[1],
			lengthSquared = dx * dx + dy * dy,
			t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared)) : 0,
			x = a[0] + dx * t,
			y = a[1] + dy * t,
			distanceSquared = (point[0] - x) ** 2 + (point[1] - y) ** 2;
		if (distanceSquared >= bestSquared) continue;
		bestSquared = distanceSquared;
		best = {
			segment: i,
			distance: path.cumulative[i] + Math.sqrt(lengthSquared) * t
		};
	}
	return best;
};
const simulationCoordinateAtDistance = (path, value) => {
	const distance = Math.max(0, Math.min(path.total, value));
	if (!path.coordinates.length) return null;
	if (distance <= 0) return path.coordinates[0];
	if (distance >= path.total) return path.coordinates.at(-1);
	let low = 1,
		high = path.cumulative.length - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (path.cumulative[middle] < distance) low = middle + 1;
		else high = middle;
	}
	const index = low,
		a = path.coordinates[index - 1],
		b = path.coordinates[index],
		start = path.cumulative[index - 1],
		span = path.cumulative[index] - start,
		t = span ? (distance - start) / span : 0;
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
};
const prepareSimulationTrip = (trip, shape) => {
	if (!shape || trip.anchors.length < 2) return null;
	const path = simulationPathForShape(shape);
	if (path.coordinates.length < 2 || !path.total) return null;
	let minimumSegment = 0,
		minimumDistance = 0;
	const anchors = [];
	for (const anchor of trip.anchors) {
		const projected = projectSimulationAnchor(path, anchor, minimumSegment);
		if (!projected) continue;
		minimumSegment = projected.segment;
		minimumDistance = Math.max(minimumDistance, projected.distance);
		anchors.push({
			...anchor,
			arrival: finite(anchor.arrival) ? anchor.arrival : anchor.departure,
			departure: finite(anchor.departure) ? anchor.departure : anchor.arrival,
			distance: minimumDistance
		});
	}
	if (anchors.length < 2) return null;
	return { ...trip, shape, path, anchors };
};
const simulationTripDistanceAtTime = (trip, time) => {
	if (time < trip.startTime || time > trip.endTime) return null;
	const anchors = trip.anchors;
	if (time <= anchors[0].departure) return anchors[0].distance;
	for (let i = 0; i < anchors.length - 1; i++) {
		const current = anchors[i],
			next = anchors[i + 1];
		if (time <= current.departure) return current.distance;
		if (time < next.arrival) {
			const span = next.arrival - current.departure,
				ratio = span > 0 ? (time - current.departure) / span : 1;
			return current.distance + (next.distance - current.distance) * Math.max(0, Math.min(1, ratio));
		}
		if (time <= next.departure) return next.distance;
	}
	return anchors.at(-1).distance;
};
const simulationTripCoordinate = (trip, time) => {
	const distance = simulationTripDistanceAtTime(trip, time);
	return distance === null ? null : simulationCoordinateAtDistance(trip.path, distance);
};
const simulationAnchorDistance = (a, b) => {
	const x = ol.proj.fromLonLat([a.lon, a.lat]),
		y = ol.proj.fromLonLat([b.lon, b.lat]);
	return Math.hypot(x[0] - y[0], x[1] - y[1]);
};
const simulationTripSequence = (trip) => {
	const parts = String(trip.id || "").split(".");
	if (parts.length !== 5 || !/^\d+$/.test(parts[3])) return null;
	return { key: `${parts[0]}.${parts[1]}.${parts[2]}.${parts[4]}`, value: Number(parts[3]) };
};
const simulationContinuationCandidate = (previous, next) => {
	const end = previous.anchors.at(-1),
		start = next.anchors[0],
		gap = next.startTime - previous.endTime;
	if (gap < 0 || gap > 1200) return null;
	const exactStop = end.stopId === start.stopId,
		changesDirection = previous.direction !== next.direction,
		distance = simulationAnchorDistance(end, start),
		previousSequence = simulationTripSequence(previous),
		nextSequence = simulationTripSequence(next),
		sequenceMatch = !!previousSequence && !!nextSequence && exactStop && changesDirection && previousSequence.key === nextSequence.key && nextSequence.value === previousSequence.value + 1;
	if (!exactStop && (!changesDirection || gap > 600 || distance > 90)) return null;
	if (exactStop && !changesDirection && gap > 420) return null;
	return { previous, next, exactStop, changesDirection, gap, distance, sequenceMatch };
};
const compareSimulationContinuations = (a, b) => {
	if (a.next.startTime !== b.next.startTime) return a.next.startTime - b.next.startTime;
	if (a.exactStop !== b.exactStop) return a.exactStop ? -1 : 1;
	if (a.changesDirection !== b.changesDirection) return a.changesDirection ? -1 : 1;
	if (a.gap !== b.gap) return a.gap - b.gap;
	if (a.distance !== b.distance) return a.distance - b.distance;
	return a.previous.id.localeCompare(b.previous.id);
};
const simulationContinuationScore = (candidate) =>
	(candidate.exactStop ? 10000 : 0) +
	(candidate.changesDirection ? 5000 : 0) +
	Math.max(0, 1200 - candidate.gap) * 2 -
	Math.round(candidate.distance);
const buildSimulationSequenceChains = (orderedTrips, candidates) => {
	const incoming = new Map(),
		outgoing = new Map(),
		tripById = new Map(orderedTrips.map((trip) => [trip.id, trip]));
	for (const candidate of candidates.filter((item) => item.sequenceMatch).sort(compareSimulationContinuations)) {
		if (incoming.has(candidate.next.id) || outgoing.has(candidate.previous.id)) continue;
		incoming.set(candidate.next.id, candidate.previous.id);
		outgoing.set(candidate.previous.id, candidate.next.id);
	}
	const chains = [],
		visited = new Set();
	for (const trip of orderedTrips) {
		if (incoming.has(trip.id) || visited.has(trip.id)) continue;
		const chainTrips = [];
		let current = trip;
		while (current && !visited.has(current.id)) {
			chainTrips.push(current);
			visited.add(current.id);
			current = tripById.get(outgoing.get(current.id)) || null;
		}
		chains.push({ id: chains.length, trips: chainTrips });
	}
	for (const trip of orderedTrips)
		if (!visited.has(trip.id)) chains.push({ id: chains.length, trips: [trip] });
	return chains;
};
const simulationChainContinuation = (previousChain, nextChain) => {
	const candidate = simulationContinuationCandidate(previousChain.trips.at(-1), nextChain.trips[0]);
	if (!candidate || candidate.sequenceMatch) return null;
	if (candidate.exactStop && candidate.changesDirection && candidate.gap <= 600) return candidate;
	if (candidate.exactStop && !candidate.changesDirection && candidate.gap <= 180) return candidate;
	if (!candidate.exactStop && candidate.changesDirection && candidate.gap <= 300 && candidate.distance <= 90) return candidate;
	return null;
};
const matchSimulationChains = (chains) => {
	const options = new Map();
	for (const previousChain of chains) {
		const list = [];
		for (const nextChain of chains) {
			if (previousChain === nextChain) continue;
			const candidate = simulationChainContinuation(previousChain, nextChain);
			if (candidate) list.push({ nextId: nextChain.id, candidate, score: simulationContinuationScore(candidate) });
		}
		list.sort((a, b) => b.score - a.score || compareSimulationContinuations(a.candidate, b.candidate));
		options.set(previousChain.id, list);
	}
	const matchedStart = new Map();
	const assign = (previousId, seen) => {
		for (const option of options.get(previousId) || []) {
			if (seen.has(option.nextId)) continue;
			seen.add(option.nextId);
			const currentPrevious = matchedStart.get(option.nextId);
			if (currentPrevious === undefined || assign(currentPrevious, seen)) {
				matchedStart.set(option.nextId, previousId);
				return true;
			}
		}
		return false;
	};
	const order = [...chains].sort((a, b) => {
		const aScore = options.get(a.id)?.[0]?.score || -Infinity,
			bScore = options.get(b.id)?.[0]?.score || -Infinity;
		return bScore - aScore || a.trips.at(-1).endTime - b.trips.at(-1).endTime || a.id - b.id;
	});
	for (const chain of order) assign(chain.id, new Set());
	const outgoing = new Map(),
		incoming = new Map();
	for (const [nextId, previousId] of matchedStart) {
		outgoing.set(previousId, nextId);
		incoming.set(nextId, previousId);
	}
	return { outgoing, incoming };
};
const buildSimulationPseudoTurns = (trips) => {
	const orderedTrips = [...trips].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id)),
		candidates = [];
	for (let nextIndex = 0; nextIndex < orderedTrips.length; nextIndex++)
		for (let previousIndex = 0; previousIndex < nextIndex; previousIndex++) {
			const candidate = simulationContinuationCandidate(orderedTrips[previousIndex], orderedTrips[nextIndex]);
			if (candidate) candidates.push(candidate);
		}
	const chains = buildSimulationSequenceChains(orderedTrips, candidates),
		{ outgoing, incoming } = matchSimulationChains(chains),
		chainById = new Map(chains.map((chain) => [chain.id, chain])),
		pseudoTurns = [],
		visited = new Set();
	for (const chain of chains) {
		if (incoming.has(chain.id) || visited.has(chain.id)) continue;
		const chainTrips = [];
		let current = chain;
		while (current && !visited.has(current.id)) {
			chainTrips.push(...current.trips);
			visited.add(current.id);
			current = chainById.get(outgoing.get(current.id)) || null;
		}
		pseudoTurns.push({ id: pseudoTurns.length + 1, label: "", trips: chainTrips });
	}
	for (const chain of chains)
		if (!visited.has(chain.id)) pseudoTurns.push({ id: pseudoTurns.length + 1, label: "", trips: [...chain.trips] });
	return pseudoTurns;
};
const simulationPseudoTurnStateAtTime = (pseudoTurn, time) => {
	for (let i = 0; i < pseudoTurn.trips.length; i++) {
		const trip = pseudoTurn.trips[i],
			nextTrip = pseudoTurn.trips[i + 1];
		if (time >= trip.startTime && time <= trip.endTime) {
			const distance = simulationTripDistanceAtTime(trip, time),
				coordinate = distance === null ? null : simulationCoordinateAtDistance(trip.path, distance);
			return coordinate ? { status: "running", coordinate, distance, trip, nextTrip } : null;
		}
		if (nextTrip && time > trip.endTime && time < nextTrip.startTime) {
			const distance = simulationTripDistanceAtTime(trip, trip.endTime),
				coordinate = distance === null ? null : simulationCoordinateAtDistance(trip.path, distance);
			return coordinate ? { status: "waiting", coordinate, distance, trip, nextTrip } : null;
		}
	}
	return null;
};
const simulationPseudoTurnBounds = (pseudoTurn) => [pseudoTurn.trips[0].startTime, pseudoTurn.trips.at(-1).endTime];
let simulationDiagnosticMinute = null;
const ensureSimulationDiagnostics = () => {
	let details = $("simulation-diagnostics");
	if (details) return details;
	const legend = document.querySelector(".simulation-legend");
	if (!legend) return null;
	details = el("details", "simulation-diagnostics");
	details.id = "simulation-diagnostics";
	const summary = el("summary", "simulation-diagnostics-toggle"),
		title = el("span", "", "Diagnòstic de pseudotorns"),
		count = el("span", "simulation-diagnostics-summary", "—"),
		list = el("div", "simulation-diagnostics-list");
	count.id = "simulation-diagnostics-summary";
	list.id = "simulation-diagnostics-list";
	summary.append(title, count);
	details.append(summary, list);
	legend.before(details);
	details.addEventListener("toggle", () => {
		if (!details.open) return;
		simulationDiagnosticMinute = null;
		renderSimulationDiagnostics(true);
	});
	return details;
};
const simulationDiagnosticState = (pseudoTurn, time) => {
	const active = simulationPseudoTurnStateAtTime(pseudoTurn, time),
		[start, end] = simulationPseudoTurnBounds(pseudoTurn);
	if (active?.status === "running") return ["running", "En servei"];
	if (active?.status === "waiting") return ["waiting", "En espera"];
	if (time < start) return ["future", "Encara no iniciat"];
	if (time > end) return ["past", "Finalitzat"];
	return ["unknown", "Sense posició"];
};
const renderSimulationDiagnostics = (force = false) => {
	const details = ensureSimulationDiagnostics(),
		count = $("simulation-diagnostics-summary");
	if (!details || !count) return;
	count.textContent = `${model.pseudoTurns.length} del dia`;
	if (!details.open) return;
	const minute = Math.floor(model.time / 60);
	if (!force && minute === simulationDiagnosticMinute) return;
	simulationDiagnosticMinute = minute;
	const list = $("simulation-diagnostics-list");
	if (!list) return;
	const rows = [...model.pseudoTurns]
		.sort((a, b) => Number(a.label) - Number(b.label))
		.map((pseudoTurn) => {
			const [start, end] = simulationPseudoTurnBounds(pseudoTurn),
				[state, stateText] = simulationDiagnosticState(pseudoTurn, model.time),
				row = el("div", "simulation-diagnostic-row"),
				number = el("strong", "simulation-diagnostic-number", pseudoTurn.label),
				times = el("span", "simulation-diagnostic-times", `${formatSimulationTime(start)}–${formatSimulationTime(end)}`),
				status = el("span", `simulation-diagnostic-state simulation-diagnostic-state-${state}`, stateText),
				trips = el("span", "simulation-diagnostic-trips", `${pseudoTurn.trips.length} exp.`);
			row.dataset.state = state;
			row.append(number, times, status, trips);
			return row;
		});
	list.replaceChildren(...rows);
};
const clearSimulationDiagnostics = () => {
	simulationDiagnosticMinute = null;
	const count = $("simulation-diagnostics-summary"),
		list = $("simulation-diagnostics-list");
	if (count) count.textContent = "0 del dia";
	list?.replaceChildren();
};
const assignSimulationPseudoTurnLabels = (pseudoTurns) => {
	const ordered = [...pseudoTurns].sort((a, b) => a.trips[0].startTime - b.trips[0].startTime || a.trips[0].endTime - b.trips[0].endTime || a.id - b.id);
	ordered.forEach((pseudoTurn, index) => {
		pseudoTurn.label = String(index + 1).padStart(2, "0");
	});
	return pseudoTurns;
};
const renderSimulationVehicles = () => {
	const simulation = model,
		source = simulation.layer?.getSource();
	if (!source || !simulation.route || !simulation.open) return;
	const active = new Set();
	let running = 0,
		waiting = 0;
	for (const pseudoTurn of simulation.pseudoTurns) {
		const pseudoTurnState = simulationPseudoTurnStateAtTime(pseudoTurn, simulation.time);
		if (!pseudoTurnState) continue;
		const relevant = pseudoTurnState.status === "waiting"
			? shapeVisible(pseudoTurnState.trip.shape) || shapeVisible(pseudoTurnState.nextTrip.shape)
			: shapeVisible(pseudoTurnState.trip.shape);
		if (!relevant) continue;
		let feature = simulation.features.get(pseudoTurn.id);
		if (!feature) {
			feature = new ol.Feature({ geometry: new ol.geom.Point(pseudoTurnState.coordinate), type: "simulation-bus" });
			simulation.features.set(pseudoTurn.id, feature);
			source.addFeature(feature);
		} else feature.getGeometry().setCoordinates(pseudoTurnState.coordinate);
		feature.setProperties({
			line: simulation.route.shortName,
			pseudoTurnLabel: pseudoTurn.label,
			pseudoTurn,
			status: pseudoTurnState.status,
			trip: pseudoTurnState.trip,
			nextTrip: pseudoTurnState.nextTrip || null
		});
		active.add(pseudoTurn.id);
		if (pseudoTurnState.status === "waiting") waiting++;
		else running++;
	}
	for (const [pseudoTurnId, feature] of simulation.features)
		if (!active.has(pseudoTurnId)) {
			source.removeFeature(feature);
			simulation.features.delete(pseudoTurnId);
		}
	$("simulation-time").textContent = formatSimulationTime(simulation.time);
	$("simulation-count").textContent = waiting ? `${running} en servei · ${waiting} en espera` : `${running} ${running === 1 ? "autobús" : "autobusos"} en servei`;
	$("simulation-range").value = String(Math.round(simulation.time));
	renderSimulationDiagnostics();
};
const setSimulationTime = (value) => {
	const simulation = model;
	if (!simulation.trips.length) return;
	simulation.time = Math.max(simulation.min, Math.min(simulation.max, Number(value) || simulation.min));
	renderSimulationVehicles();
};
const setSimulationSpeed = (speed) => {
	model.speed = speed;
	for (const button of document.querySelectorAll("[data-simulation-speed]")) {
		const selected = Number(button.dataset.simulationSpeed) === speed;
		button.setAttribute("aria-pressed", String(selected));
	}
};
const setSimulationPlaying = (playing) => {
	const simulation = model,
		button = $("simulation-play");
	if (simulation.frame) cancelAnimationFrame(simulation.frame);
	simulation.frame = 0;
	simulation.playing = !!playing && simulation.open && simulation.trips.length > 0;
	button.textContent = simulation.playing ? "⏸" : "▶";
	button.setAttribute("aria-label", simulation.playing ? "Pausa" : "Reprodueix");
	if (!simulation.playing) return;
	if (simulation.time >= simulation.max) setSimulationTime(simulation.min);
	simulation.lastFrame = performance.now();
	const tick = (now) => {
		if (!simulation.playing) return;
		const elapsed = Math.min(0.25, Math.max(0, (now - simulation.lastFrame) / 1000));
		simulation.lastFrame = now;
		setSimulationTime(simulation.time + elapsed * simulation.speed);
		if (simulation.time >= simulation.max) {
			setSimulationPlaying(false);
			return;
		}
		simulation.frame = requestAnimationFrame(tick);
	};
	simulation.frame = requestAnimationFrame(tick);
};
const setupSimulation = (route, requestedDate = "") => {
	setSimulationPlaying(false);
	const target = requestedDate ? { date: preferredSimulationDate(route, requestedDate), time: null } : currentSimulationTarget(route),
		simulation = model,
		range = $("simulation-range"),
		play = $("simulation-play"),
		shapeById = new Map(route.shapes.map((shape) => [shape.id, shape])),
		selectedDate = target.date;
	simulation.layer?.getSource().clear();
	simulation.features.clear();
	simulation.route = route;
	simulation.date = selectedDate;
	simulation.availableDates = route.simulationDates || [];
	populateSimulationDates(route, selectedDate);
	simulation.trips = (route.simulationTrips || [])
		.filter((trip) => trip.serviceDates?.has(selectedDate))
		.map((trip) => prepareSimulationTrip(trip, shapeById.get(trip.shapeId)))
		.filter(Boolean);
	simulation.pseudoTurns = assignSimulationPseudoTurnLabels(buildSimulationPseudoTurns(simulation.trips));
	simulation.prepared = true;
	if (!simulation.trips.length) {
		$("simulation-date").textContent = selectedDate ? `Servei programat · ${formatDateKey(selectedDate)}` : "Servei programat";
		play.disabled = true;
		range.disabled = true;
		$("simulation-time").textContent = "—";
		$("simulation-count").textContent = "Sense servei programat per a aquesta data";
		$("simulation-start").textContent = "—";
		$("simulation-end").textContent = "—";
		for (const button of document.querySelectorAll("[data-simulation-speed]")) button.disabled = true;
		clearSimulationDiagnostics();
		return;
	}
	const pseudoTurnText = `${simulation.pseudoTurns.length} ${simulation.pseudoTurns.length === 1 ? "pseudotorn estimat" : "pseudotorns estimats"}`;
	$("simulation-date").textContent = `Servei programat · ${pseudoTurnText}`;
	simulation.min = Math.min(...simulation.trips.map((trip) => trip.startTime));
	simulation.max = Math.max(...simulation.trips.map((trip) => trip.endTime));
	simulation.time = finite(target.time) ? Math.max(simulation.min, Math.min(simulation.max, target.time)) : simulation.min;
	play.disabled = false;
	range.disabled = false;
	range.min = String(Math.floor(simulation.min));
	range.max = String(Math.ceil(simulation.max));
	range.step = "1";
	$("simulation-start").textContent = formatSimulationTime(simulation.min);
	$("simulation-end").textContent = formatSimulationTime(simulation.max);
	for (const button of document.querySelectorAll("[data-simulation-speed]")) button.disabled = false;
	setSimulationSpeed(simulation.speed);
	simulationDiagnosticMinute = null;
	renderSimulationVehicles();
};
const createLayer = () => {
	if (!model.layer) model.layer = new ol.layer.Vector({source:new ol.source.Vector(),style:makeSimulationStyle(),visible:false,zIndex:180});
	return model.layer;
};
const clearFeatures = () => {
	model.layer?.getSource().clear();
	model.features.clear();
};
const setOpen = (open) => {
	const panel = $("simulation-panel"), content = $("simulation-content"), toggle = $("simulation-toggle"), label = $("simulation-toggle-label");
	model.open = !!open && !!model.route;
	panel?.classList.toggle("is-open", model.open);
	if (content) content.hidden = !model.open;
	if (toggle) toggle.setAttribute("aria-expanded", String(model.open));
	if (label) label.textContent = model.open ? "Ocultar" : "Mostrar";
	model.layer?.setVisible(model.open);
	if (!model.open) {
		setSimulationPlaying(false);
		clearFeatures();
		closePopup();
		return;
	}
	if (!model.prepared) setupSimulation(model.route);
	else renderSimulationVehicles();
};
const selectRoute = (route) => {
	setSimulationPlaying(false);
	model.route = route;
	model.date = "";
	model.availableDates = [];
	model.trips = [];
	model.pseudoTurns = [];
	model.time = 0;
	model.min = 0;
	model.max = 0;
	model.prepared = false;
	clearFeatures();
	const panel = $("simulation-panel");
	if (panel) panel.hidden = false;
	setOpen(false);
};
const refresh = () => {
	if (model.open) renderSimulationVehicles();
};
const getLayer = () => model.layer;
const popupContent = (feature) => simulationBusPopupContent(feature);
const init = (options = {}) => {
	if (typeof options.isShapeVisible === "function") shapeVisible = options.isShapeVisible;
	if (typeof options.closePopup === "function") closePopup = options.closePopup;
	ensureSimulationDiagnostics();
	$("simulation-toggle")?.addEventListener("click", () => setOpen(!model.open));
	$("simulation-play")?.addEventListener("click", () => setSimulationPlaying(!model.playing));
	$("simulation-service-date")?.addEventListener("change", (event) => {
		if (model.route && model.open) setupSimulation(model.route, event.target.value);
	});
	$("simulation-range")?.addEventListener("input", (event) => {
		model.lastFrame = performance.now();
		setSimulationTime(Number(event.target.value));
	});
	for (const button of document.querySelectorAll("[data-simulation-speed]")) button.addEventListener("click", () => {
		setSimulationSpeed(Number(button.dataset.simulationSpeed));
		model.lastFrame = performance.now();
	});
};
return {init,createLayer,getLayer,popupContent,selectRoute,refresh};
})();
