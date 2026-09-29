(() => {
  if (!("caches" in window)) return;

  const nativeFetch = window.fetch.bind(window);
  const gtfsUrl = new URL("./gtfs.zip", location.href);
  const versionUrl = new URL("./gtfs-version.txt", location.href);
  const cacheName = "tmb-gtfs-cache-v1";

  const loadGtfs = async (input, init) => {
    const versionResponse = await nativeFetch(versionUrl.href, {
      cache: "no-store"
    });

    if (!versionResponse.ok)
      return nativeFetch(input, init);

    const version = (await versionResponse.text()).trim();

    if (!version)
      return nativeFetch(input, init);

    const cache = await caches.open(cacheName);
    const cacheKey = new URL(gtfsUrl.href);
    cacheKey.searchParams.set("v", version);

    const cached = await cache.match(cacheKey.href);

    if (cached)
      return cached;

    const response = await nativeFetch(input, {
      ...(init || {}),
      cache: "no-store"
    });

    if (!response.ok)
      return response;

    await cache.put(cacheKey.href, response.clone());

    for (const request of await cache.keys())
      if (request.url !== cacheKey.href)
        await cache.delete(request);

    return response;
  };

  window.fetch = (input, init) => {
    const requestedUrl = new URL(
      input instanceof Request ? input.url : String(input),
      location.href
    );

    if (
      requestedUrl.origin === gtfsUrl.origin &&
      requestedUrl.pathname === gtfsUrl.pathname
    )
      return loadGtfs(input, init);

    return nativeFetch(input, init);
  };
})();
