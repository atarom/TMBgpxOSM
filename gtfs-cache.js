(() => {
	if (!("caches" in window)) return;
	const nativeFetch = window.fetch.bind(window),
		gtfsUrl = new URL("./gtfs.zip", location.href),
		versionUrl = new URL("./gtfs-version.txt", location.href),
		cacheName = "tmb-gtfs-cache-v1";
	const cachedGtfs = async (cache) => {
		for (const request of (await cache.keys()).reverse()) {
			const url = new URL(request.url);
			if (url.origin !== gtfsUrl.origin || url.pathname !== gtfsUrl.pathname) continue;
			const response = await cache.match(request);
			if (!response) continue;
			return { response, version: url.searchParams.get("v") || "" };
		}
		return null;
	};
	const useCachedGtfs = async (cache) => {
		const cached = await cachedGtfs(cache);
		if (!cached) return null;
		window.TmbGtfsVersion = cached.version;
		return cached.response;
	};
	const loadGtfs = async (input, init) => {
		let cache;
		try {
			cache = await caches.open(cacheName);
		} catch {
			return nativeFetch(input, init);
		}
		let version = "";
		try {
			const response = await nativeFetch(versionUrl.href, { cache: "no-store" });
			if (response.ok) version = (await response.text()).trim();
		} catch {}
		if (!version) return (await useCachedGtfs(cache)) || nativeFetch(input, init);
		const cacheKey = new URL(gtfsUrl.href);
		cacheKey.searchParams.set("v", version);
		const cached = await cache.match(cacheKey.href);
		if (cached) {
			window.TmbGtfsVersion = version;
			return cached;
		}
		try {
			const response = await nativeFetch(input, { ...(init || {}), cache: "no-store" });
			if (!response.ok) return (await useCachedGtfs(cache)) || response;
			await cache.put(cacheKey.href, response.clone());
			window.TmbGtfsVersion = version;
			for (const request of await cache.keys())
				if (request.url !== cacheKey.href) await cache.delete(request);
			return response;
		} catch (error) {
			const fallback = await useCachedGtfs(cache);
			if (fallback) return fallback;
			throw error;
		}
	};
	window.fetch = (input, init) => {
		const requestedUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
		return requestedUrl.origin === gtfsUrl.origin && requestedUrl.pathname === gtfsUrl.pathname
			? loadGtfs(input, init)
			: nativeFetch(input, init);
	};
})();
