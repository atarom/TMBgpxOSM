(() => {
	const finite = Number.isFinite,
		indexes = (h) => Object.fromEntries(h.map((v, i) => [v, i])),
		rowObject = (r, h) => Object.fromEntries(h.map((v, i) => [v, r[i] ?? ""])),
		bump = (m, v) => m.set(v, (m.get(v) || 0) + 1),
		mostCommon = (m) => {
			let v = "", c = -1;
			for (const [x, n] of m) if (n > c) { v = x; c = n; }
			return v;
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
const DAY_MS = 86400000,
	weekdayFields = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const serviceTodayKey = () => {
		const parts = new Intl.DateTimeFormat("en-CA", {
				timeZone: "Europe/Madrid",
				year: "numeric",
				month: "2-digit",
				day: "2-digit"
			})
			.formatToParts(new Date())
			.filter((p) => p.type !== "literal"),
			values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
		return `${values.year}${values.month}${values.day}`;
	},
	dateKeyToUtc = (key) =>
		Date.UTC(
			Number(key.slice(0, 4)),
			Number(key.slice(4, 6)) - 1,
			Number(key.slice(6, 8))
		),
	utcToDateKey = (time) => {
		const d = new Date(time);
		return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
	},
	formatDateKey = (key) =>
		key
			? `${key.slice(6, 8)}/${key.slice(4, 6)}/${key.slice(0, 4)}`
			: "",
	dateRanges = (dates) => {
		if (!dates.length) return [];
		const ranges = [];
		let start = dates[0],
			previous = dates[0];
		for (let i = 1; i < dates.length; i++) {
			const current = dates[i];
			if (dateKeyToUtc(current) - dateKeyToUtc(previous) === DAY_MS) {
				previous = current;
				continue;
			}
			ranges.push([start, previous]);
			start = previous = current;
		}
		ranges.push([start, previous]);
		return ranges;
	},
	formatDateRange = ([start, end]) =>
		start === end
			? formatDateKey(start)
			: `${formatDateKey(start)}–${formatDateKey(end)}`,
	calendarSummary = (dates) => {
		if (!dates.length) return "Sense dates de servei";
		const ranges = dateRanges(dates);
		if (ranges.length <= 6) return ranges.map(formatDateRange).join(" · ");
		return `${formatDateKey(dates[0])}–${formatDateKey(dates.at(-1))} · ${dates.length} dies de servei`;
	},
	classifyDates = (dates, today) => {
		const sorted = [...dates].sort(),
			active = dates.has(today),
			nextDate = sorted.find((date) => date > today) || "",
			lastDate = [...sorted].reverse().find((date) => date < today) || "";
		return {
			dates: sorted,
			status: active ? "active" : nextDate ? "future" : lastDate ? "past" : "unknown",
			nextDate,
			lastDate,
			firstDate: sorted[0] || "",
			finalDate: sorted.at(-1) || ""
		};
	},
	candidateTripsForSchedule = (meta, serviceDates, today, status) => {
		const serviceCandidates = [];
		if (status === "active") {
			for (const serviceId of meta.serviceIds)
				if (serviceDates.get(serviceId)?.has(today)) serviceCandidates.push(serviceId);
		} else if (status === "future") {
			let nearest = "";
			for (const serviceId of meta.serviceIds) {
				const next = [...(serviceDates.get(serviceId) || [])]
					.sort()
					.find((date) => date > today);
				if (next && (!nearest || next < nearest)) nearest = next;
			}
			if (nearest)
				for (const serviceId of meta.serviceIds)
					if (serviceDates.get(serviceId)?.has(nearest)) serviceCandidates.push(serviceId);
		} else if (status === "past") {
			let nearest = "";
			for (const serviceId of meta.serviceIds) {
				const previous = [...(serviceDates.get(serviceId) || [])]
					.sort()
					.reverse()
					.find((date) => date < today);
				if (previous && (!nearest || previous > nearest)) nearest = previous;
			}
			if (nearest)
				for (const serviceId of meta.serviceIds)
					if (serviceDates.get(serviceId)?.has(nearest)) serviceCandidates.push(serviceId);
		}
		if (!serviceCandidates.length) serviceCandidates.push(...meta.serviceIds);
		return serviceCandidates.flatMap(
			(serviceId) => meta.tripsByService.get(serviceId) || []
		);
	},
	analyzeTripPatterns = (meta, tripStats, stopMap) => {
		const trips = (meta.candidateTrips || [])
			.map((tripId) => ({ tripId, ...(tripStats.get(tripId) || {}) }))
			.filter((trip) => trip.count);
		if (!trips.length)
			return {
				representativeTrip: meta.candidateTrips?.[0] || "",
				patterns: []
			};
		const withSequence = trips.filter(
				(trip) => finite(trip.firstSequence) && finite(trip.lastSequence)
			),
			routeFirstSequence = withSequence.length
				? Math.min(...withSequence.map((trip) => trip.firstSequence))
				: null,
			routeLastSequence = withSequence.length
				? Math.max(...withSequence.map((trip) => trip.lastSequence))
				: null,
			groups = new Map();
		for (const trip of trips) {
			const key = [
				trip.firstSequence ?? "",
				trip.lastSequence ?? "",
				trip.count,
				trip.firstStopId || "",
				trip.lastStopId || ""
			].join("|");
			if (!groups.has(key))
				groups.set(key, {
					firstSequence: trip.firstSequence,
					lastSequence: trip.lastSequence,
					stopCount: trip.count,
					firstStopId: trip.firstStopId || "",
					lastStopId: trip.lastStopId || "",
					tripIds: []
				});
			groups.get(key).tripIds.push(trip.tripId);
		}
		const patterns = [...groups.values()].map((pattern) => {
			const hasSequence =
					finite(pattern.firstSequence) && finite(pattern.lastSequence),
				beginsRoute =
					hasSequence && pattern.firstSequence === routeFirstSequence,
				endsRoute = hasSequence && pattern.lastSequence === routeLastSequence;
			let kind = "unknown";
			if (beginsRoute && endsRoute) kind = "full";
			else if (beginsRoute) kind = "partial-start";
			else if (endsRoute) kind = "partial-end";
			else if (hasSequence) kind = "partial";
			return {
				...pattern,
				kind,
				tripCount: pattern.tripIds.length,
				firstStopName: stopMap.get(pattern.firstStopId)?.name || "",
				lastStopName: stopMap.get(pattern.lastStopId)?.name || "",
				sequenceSpan: hasSequence
					? pattern.lastSequence - pattern.firstSequence
					: -1
			};
		});
		const kindOrder = {
			full: 0,
			"partial-start": 1,
			"partial-end": 2,
			partial: 3,
			unknown: 4
		};
		patterns.sort(
			(a, b) =>
				kindOrder[a.kind] - kindOrder[b.kind] ||
				b.tripCount - a.tripCount ||
				b.sequenceSpan - a.sequenceSpan ||
				b.stopCount - a.stopCount
		);
		const full = patterns.filter((pattern) => pattern.kind === "full"),
			representativePattern =
				full.sort(
					(a, b) =>
						b.tripCount - a.tripCount ||
						b.stopCount - a.stopCount ||
						b.sequenceSpan - a.sequenceSpan
				)[0] ||
				[...patterns].sort(
					(a, b) =>
						b.sequenceSpan - a.sequenceSpan ||
						b.stopCount - a.stopCount ||
						b.tripCount - a.tripCount
				)[0];
		return {
			representativeTrip: representativePattern?.tripIds[0] || trips[0].tripId,
			patterns
		};
	};
const streamCalendarDates = (file, serviceIds, serviceDates) =>
	new Promise((resolve, reject) => {
		if (!file) return resolve();
		let buffer = "",
			first = true;
		const process = (line) => {
			if (!line) return;
			if (first) {
				first = false;
				return;
			}
			const a = line.indexOf(","),
				b = line.indexOf(",", a + 1);
			if (a < 0 || b < 0) return;
			const serviceId = line.slice(0, a);
			if (!serviceIds.has(serviceId)) return;
			const date = line.slice(a + 1, b),
				exceptionType = line.slice(b + 1).trim(),
				dates = serviceDates.get(serviceId);
			if (exceptionType === "1") dates.add(date);
			else if (exceptionType === "2") dates.delete(date);
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
const load = async (url = "./gtfs.zip", progress = () => {}) => {
	progress(
		"Carregant el GTFS oficial",
		"Carregant la còpia sincronitzada amb T-mobilitat…"
	);
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`No s’ha pogut descarregar el GTFS (HTTP ${response.status})`);
	const data = await response.arrayBuffer();
	progress(
		"Obrint el fitxer GTFS",
		`${(data.byteLength / 1048576).toFixed(1)} MB descarregats`
	);
	let agency = null, feed = null;
	const zip = await JSZip.loadAsync(data),
		routeMap = new Map(),
		stopMap = new Map(),
		shapeMeta = new Map(),
		shapePoints = new Map(),
		tripStops = new Map(),
		tripRaw = new Map(),
		serviceIds = new Set(),
		serviceDates = new Map(),
		today = serviceTodayKey();
	let idx;
	progress("Llegint metadades", "Processant operador i font GTFS…");
	idx = null;
	const agencyFile = zip.file("agency.txt");
	if (agencyFile)
		await streamCsv(agencyFile, (r, h) => {
			idx ||= indexes(h);
			if (r[idx.agency_id] === "TMB_") agency = rowObject(r, h);
		});
	idx = null;
	const feedFile = zip.file("feed_info.txt");
	if (feedFile)
		await streamCsv(feedFile, (r, h) => {
			if (!feed) feed = rowObject(r, h);
		});
	progress("Llegint les línies", "Processant routes.txt…");
	await streamCsv(zip.file("routes.txt"), (r, h) => {
		idx ||= indexes(h);
		if (r[idx.agency_id] !== "TMB_" || r[idx.route_type] !== "3") return;
		const id = r[idx.route_id];
		routeMap.set(id, {
			id,
			shortName: r[idx.route_short_name],
			longName: r[idx.route_long_name],
			raw: rowObject(r, h),
			shapes: []
		});
	});
	progress("Llegint les parades", `${routeMap.size} línies TMB trobades`);
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
			lon,
			raw: rowObject(r, h)
		});
	});
	progress("Identificant els recorreguts", "Processant trips.txt…");
	idx = null;
	await streamCsv(zip.file("trips.txt"), (r, h) => {
		idx ||= indexes(h);
		const routeId = r[idx.route_id],
			shapeId = r[idx.shape_id],
			serviceId = r[idx.service_id];
		if (!routeMap.has(routeId) || !shapeId || !serviceId) return;
		tripRaw.set(r[idx.trip_id], rowObject(r, h));
		if (!shapeMeta.has(shapeId))
			shapeMeta.set(shapeId, {
				routeId,
				headsigns: new Map(),
				directions: new Map(),
				serviceIds: new Set(),
				tripsByService: new Map(),
				candidateTrips: [],
				representativeTrip: "",
				shapeDistance: 0
			});
		const m = shapeMeta.get(shapeId);
		bump(m.headsigns, r[idx.trip_headsign] || "Recorregut");
		bump(m.directions, r[idx.direction_id] || "0");
		m.serviceIds.add(serviceId);
		if (!m.tripsByService.has(serviceId)) m.tripsByService.set(serviceId, []);
		m.tripsByService.get(serviceId).push(r[idx.trip_id]);
		serviceIds.add(serviceId);
	});
	for (const serviceId of serviceIds) serviceDates.set(serviceId, new Set());
	progress("Llegint el calendari", "Processant calendar.txt…");
	idx = null;
	const calendarFile = zip.file("calendar.txt");
	if (calendarFile)
		await streamCsv(calendarFile, (r, h) => {
			idx ||= indexes(h);
			const serviceId = r[idx.service_id];
			if (!serviceIds.has(serviceId)) return;
			const start = dateKeyToUtc(r[idx.start_date]),
				end = dateKeyToUtc(r[idx.end_date]),
				dates = serviceDates.get(serviceId);
			if (!finite(start) || !finite(end)) return;
			for (let time = start; time <= end; time += DAY_MS) {
				const d = new Date(time),
					field = weekdayFields[d.getUTCDay()];
				if (r[idx[field]] === "1") dates.add(utcToDateKey(time));
			}
		});
	progress("Llegint el calendari", "Processant excepcions i serveis especials…");
	await streamCalendarDates(zip.file("calendar_dates.txt"), serviceIds, serviceDates);
	for (const m of shapeMeta.values()) {
		const dates = new Set();
		for (const serviceId of m.serviceIds)
			for (const date of serviceDates.get(serviceId) || []) dates.add(date);
		m.schedule = classifyDates(dates, today);
		m.candidateTrips = candidateTripsForSchedule(
			m,
			serviceDates,
			today,
			m.schedule.status
		);
	}
	progress(
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
			seq = Number(r[idx.shape_pt_sequence]),
			distance = Number(r[idx.shape_dist_traveled]);
		if (!finite(lat) || !finite(lon)) return;
		if (!shapePoints.has(id)) shapePoints.set(id, []);
		shapePoints.get(id).push([seq, lat, lon]);
		if (finite(distance))
			shapeMeta.get(id).shapeDistance = Math.max(shapeMeta.get(id).shapeDistance, distance);
	});
	const candidateTrips = new Set(),
		tripStats = new Map();
	for (const m of shapeMeta.values())
		for (const tripId of m.candidateTrips) candidateTrips.add(tripId);
	progress(
		"Analitzant els patrons de servei",
		"Identificant l’inici i el final dels viatges…"
	);
	idx = null;
	await streamCsv(zip.file("stop_times.txt"), (r, h) => {
		idx ||= indexes(h);
		const tripId = r[idx.trip_id];
		if (!candidateTrips.has(tripId)) return;
		const sequence = Number(r[idx.stop_sequence]),
			stopId = r[idx.stop_id];
		if (!tripStats.has(tripId))
			tripStats.set(tripId, {
				count: 0,
				firstSequence: Infinity,
				lastSequence: -Infinity,
				firstStopId: "",
				lastStopId: ""
			});
		const stat = tripStats.get(tripId);
		stat.count++;
		if (finite(sequence) && sequence < stat.firstSequence) {
			stat.firstSequence = sequence;
			stat.firstStopId = stopId;
		}
		if (finite(sequence) && sequence > stat.lastSequence) {
			stat.lastSequence = sequence;
			stat.lastStopId = stopId;
		}
		if (!finite(sequence)) {
			if (!stat.firstStopId) stat.firstStopId = stopId;
			stat.lastStopId = stopId;
		}
	});
	const representativeTrips = new Set();
	for (const m of shapeMeta.values()) {
		const analysis = analyzeTripPatterns(m, tripStats, stopMap);
		m.representativeTrip = analysis.representativeTrip;
		m.tripPatterns = analysis.patterns;
		if (!m.representativeTrip) continue;
		representativeTrips.add(m.representativeTrip);
		tripStops.set(m.representativeTrip, []);
	}
	progress("Assignant les parades", "Processant stop_times.txt…");
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
			raw: rowObject(r, h),
			stop
		});
	});
	progress("Preparant l’aplicació", "Ordenant recorreguts i parades…");
	for (const [id, m] of shapeMeta) {
		const route = routeMap.get(m.routeId),
			headsign = mostCommon(m.headsigns) || "Recorregut",
			direction = mostCommon(m.directions) || "0",
			points = (shapePoints.get(id) || [])
				.sort((a, b) => a[0] - b[0])
				.map(([, lat, lon]) => [lat, lon]);
		if (!points.length) continue;
		route.shapes.push({
			id,
			label: `Sentit ${headsign}`,
			headsign,
			direction,
			status: m.schedule.status,
			serviceDates: m.schedule.dates,
			nextDate: m.schedule.nextDate,
			lastDate: m.schedule.lastDate,
			firstDate: m.schedule.firstDate,
			finalDate: m.schedule.finalDate,
			points,
			distance: m.shapeDistance,
			representativeTrip: m.representativeTrip,
			tripPatterns: m.tripPatterns || [],
			serviceIds: [...m.serviceIds],
			tripRaw: tripRaw.get(m.representativeTrip) || null,
			stops: (tripStops.get(m.representativeTrip) || [])
				.sort((a, b) => a.sequence - b.sequence)
				.map((x) => ({
					...x.stop,
					sequence: x.sequence,
					pickupType: x.pickupType,
					dropOffType: x.dropOffType,
					stopTimeRaw: x.raw
				}))
		});
	}
	const statusOrder = { active: 0, future: 1, past: 2, unknown: 3 };
	const routes = [...routeMap.values()]
		.filter((r) => r.shapes.length)
		.map((route) => {
			const shapes = route.shapes.sort((a, b) => {
				const status = statusOrder[a.status] - statusOrder[b.status];
				if (status) return status;
				if (a.status === "future" && a.nextDate !== b.nextDate)
					return a.nextDate.localeCompare(b.nextDate);
				if (a.status === "past" && a.lastDate !== b.lastDate)
					return b.lastDate.localeCompare(a.lastDate);
				return (
					a.direction.localeCompare(b.direction) ||
					a.headsign.localeCompare(b.headsign, "ca", { sensitivity: "base" }) ||
					a.id.localeCompare(b.id, "ca", { numeric: true })
				);
			});
			const duplicates = new Map();
			for (const shape of shapes) {
				const key = `${shape.status}:${shape.direction}:${shape.headsign}`;
				if (!duplicates.has(key)) duplicates.set(key, []);
				duplicates.get(key).push(shape);
			}
			for (const list of duplicates.values())
				if (list.length > 1)
					list.forEach((shape, index) => {
						shape.label = `Sentit ${shape.headsign} · recorregut ${index + 1}`;
					});
			shapes.forEach((shape, index) => {
				shape.colorIndex = index;
			});
			return { ...route, shapes };
		})
		.sort(compareRoutes);
	return { routes, agency, feed, modified: response.headers.get("Last-Modified") };
};
	window.TmbGtfs = { load, formatDateKey, dateRanges, formatDateRange, calendarSummary };
})();
