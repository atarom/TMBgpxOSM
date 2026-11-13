(() => {
	const name = "tmb-gtfs-processed-v1";
	const schema = 1;
	const storeName = "datasets";
	const originalLoad = window.TmbGtfs.load;
	const todayKey = () => {
		const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
		const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
		return `${values.year}${values.month}${values.day}`;
	};
	const versionFromServer = async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		try {
			const response = await fetch("./gtfs-version.txt", { cache: "no-store", signal: controller.signal });
			if (!response.ok) return "";
			const version = (await response.text()).trim();
			return /^[a-f0-9]{64}$/i.test(version) ? version : "";
		} catch {
			return "";
		} finally {
			clearTimeout(timer);
		}
	};
	let dbPromise = null;
	const database = () => {
		if (!window.indexedDB) return Promise.reject(Error("IndexedDB no disponible"));
		if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(storeName);
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => db.close();
				resolve(db);
			};
			request.onerror = () => reject(request.error || Error("No es pot obrir IndexedDB"));
		}).catch((error) => {
			dbPromise = null;
			throw error;
		});
		return dbPromise;
	};
	const read = async () => {
		const db = await database();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(storeName, "readonly");
			const request = transaction.objectStore(storeName).get("current");
			request.onsuccess = () => resolve(request.result || null);
			request.onerror = () => reject(request.error || Error("No es poden llegir les dades"));
			transaction.onabort = () => reject(transaction.error || Error("Lectura cancel·lada"));
		});
	};
	const write = async (version, date, data) => {
		const db = await database();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(storeName, "readwrite");
			transaction.objectStore(storeName).put({ schema, version, date, data }, "current");
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error || Error("Escriptura cancel·lada"));
			transaction.onerror = () => reject(transaction.error || Error("No es poden desar les dades"));
		});
	};
	const valid = (entry, version, date) => entry?.schema === schema && entry.date === date && entry.version && (!version || entry.version === version) && Array.isArray(entry.data?.routes) && entry.data.routes.length > 0 && entry.data.routes.every((route) => Array.isArray(route.shapes) && Array.isArray(route.simulationTrips));
	window.TmbGtfs.load = async (url, progress = () => {}) => {
		progress("Comprovant les dades GTFS", "Consultant la versió disponible…");
		const date = todayKey();
		const version = await versionFromServer();
		let cached = null;
		try {
			cached = await read();
		} catch {}
		if (valid(cached, version, date)) {
			window.TmbGtfsVersion = cached.version;
			progress("Carregant dades preparades", "Recuperant les línies i els recorreguts d'IndexedDB…");
			return cached.data;
		}
		const data = await originalLoad(url, progress);
		const resolvedVersion = window.TmbGtfsVersion || version || data.version;
		if (resolvedVersion && Array.isArray(data.routes) && data.routes.length) {
			progress("Desant dades preparades", "El pròxim inici podrà reutilitzar els recorreguts…");
			try {
				await write(resolvedVersion, date, data);
			} catch {}
		}
		return data;
	};
})();
