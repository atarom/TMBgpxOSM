(() => {
	const safeName = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
		escapeXml = (value) => String(value).replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]),
		make = (route, shape) => {
			const title = `Línia ${route.shortName} — ${shape.label}`,
				desc = `Direcció GTFS ${shape.direction}. Geometria i parades oficials GTFS TMB. shape_id=${shape.id}`,
				waypoints = shape.stops.map((stop) => `\n\t<wpt lat="${stop.lat}" lon="${stop.lon}">\n\t\t<name>${escapeXml(stop.name)}</name>\n\t\t<desc>${escapeXml(`Parada ${stop.code || stop.id}`)}</desc>\n\t\t<sym>Bus Stop</sym>\n\t\t<type>Parada TMB</type>\n\t</wpt>`).join(""),
				trackPoints = shape.points.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join("");
			return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="TMB Recorreguts GPX">\n\t<metadata>\n\t\t<name>${escapeXml(title)}</name>\n\t\t<desc>${escapeXml(desc)}</desc>\n\t</metadata>\n\t${waypoints}\n\t<trk>\n\t\t<name>${escapeXml(title)}</name>\n\t\t<desc>${escapeXml(desc)}</desc>\n\t\t<trkseg>${trackPoints}</trkseg>\n\t</trk>\n</gpx>`;
		},
		download = (route, shape) => {
			const url = URL.createObjectURL(new Blob([make(route, shape)], { type: "application/gpx+xml;charset=utf-8" })),
				a = Object.assign(document.createElement("a"), { href: url, download: `tmb-${safeName(route.shortName)}-${safeName(shape.label)}.gpx` });
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 500);
		};
	window.TmbGpx = { make, download };
})();
