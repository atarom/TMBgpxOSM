(() => {
const $ = (id) => document.getElementById(id);
const state = {map:null,simulationLayer:null,trackingLayer:null,trackingFeature:null,userLayer:null,userFeature:null,followedId:null,lastCenterAt:0};
const trackingStyle = new ol.style.Style({image:new ol.style.Circle({radius:22,fill:new ol.style.Fill({color:"rgba(0,0,0,0)"}),stroke:new ol.style.Stroke({color:"#fff",width:3})}),zIndex:1});
const userStyle = new ol.style.Style({image:new ol.style.Circle({radius:8,fill:new ol.style.Fill({color:"#36a3ff"}),stroke:new ol.style.Stroke({color:"#fff",width:3})}),zIndex:1});
const tools = document.createElement("div");
tools.className = "simulation-map-tools";
const locationButton = document.createElement("button");
locationButton.id = "simulation-location";
locationButton.type = "button";
locationButton.textContent = "La meva ubicació";
const locationStatus = document.createElement("span");
locationStatus.id = "simulation-location-status";
locationStatus.textContent = "Ubicació del dispositiu no consultada";
const followStatus = document.createElement("span");
followStatus.id = "simulation-follow-status";
followStatus.textContent = "Clica un pseudotorn al mapa per seguir-lo";
followStatus.setAttribute("aria-live", "polite");
tools.append(locationButton, locationStatus, followStatus);
document.querySelector(".simulation-legend")?.before(tools);
const speedControl = document.querySelector(".simulation-speeds");
const speedLabel = document.createElement("label");
speedLabel.htmlFor = "simulation-speed-range";
speedLabel.textContent = "Velocitat";
const speedRange = document.createElement("input");
speedRange.id = "simulation-speed-range";
speedRange.type = "range";
speedRange.min = "1";
speedRange.max = "120";
speedRange.step = "1";
speedRange.value = "1";
speedRange.setAttribute("aria-label", "Velocitat de simulació");
const speedValue = document.createElement("output");
speedValue.id = "simulation-speed-value";
speedValue.setAttribute("for", "simulation-speed-range");
speedValue.textContent = "×1";
const speedBridge = document.createElement("button");
speedBridge.type = "button";
speedBridge.hidden = true;
speedBridge.dataset.simulationSpeed = "1";
speedControl?.replaceChildren(speedLabel, speedRange, speedValue, speedBridge);
const setSimulationSpeedControl = (value, apply = true) => {
	const speed = Math.max(1, Math.min(120, Math.round(Number(value) || 1)));
	speedRange.value = String(speed);
	speedValue.textContent = `×${speed}`;
	speedBridge.dataset.simulationSpeed = String(speed);
	if (apply) speedBridge.click();
};
const syncSpeedAvailability = () => {
	speedRange.disabled = speedBridge.disabled;
};
speedRange.addEventListener("input", () => setSimulationSpeedControl(speedRange.value));
new MutationObserver(syncSpeedAvailability).observe(speedBridge, { attributes:true, attributeFilter:["disabled"] });
const featurePseudoId = (feature) => feature?.get("pseudoTurn")?.id ?? null;
const featurePseudoLabel = (feature) => feature?.get("pseudoTurn")?.label || "—";
const clearTrackingMarker = () => {
	state.trackingLayer?.getSource().clear();
	state.trackingFeature = null;
};
const clearFollow = () => {
	state.followedId = null;
	state.lastCenterAt = 0;
	clearTrackingMarker();
	followStatus.textContent = "Clica un pseudotorn al mapa per seguir-lo";
};
const centerOnFeature = (feature, force = false) => {
	if (!state.map || state.followedId === null || featurePseudoId(feature) !== state.followedId) return;
	const now = performance.now();
	if (!force && now - state.lastCenterAt < 40) return;
	state.lastCenterAt = now;
	const coordinate = feature.getGeometry()?.getCoordinates();
	if (!coordinate) return;
	const view = state.map.getView();
	view.setCenter(coordinate);
	if (force && (Number(view.getZoom()) || 0) < 15) view.setZoom(15);
};
const syncTrackingFeature = (feature, forceCenter = false) => {
	if (state.followedId === null || featurePseudoId(feature) !== state.followedId) return;
	const coordinate = feature.getGeometry()?.getCoordinates();
	if (!coordinate) return;
	if (!state.trackingFeature) {
		state.trackingFeature = new ol.Feature({geometry:new ol.geom.Point(coordinate)});
		state.trackingLayer.getSource().addFeature(state.trackingFeature);
	} else state.trackingFeature.getGeometry().setCoordinates(coordinate);
	followStatus.textContent = `Seguint pseudotorn ${featurePseudoLabel(feature)} · arrossega el mapa per aturar`;
	centerOnFeature(feature, forceCenter);
};
const findFollowedFeature = () => state.simulationLayer?.getSource().getFeatures().find((feature) => featurePseudoId(feature) === state.followedId) || null;
const toggleFollow = (feature) => {
	const id = featurePseudoId(feature);
	if (id === null) return;
	if (state.followedId === id) {
		clearFollow();
		return;
	}
	state.followedId = id;
	state.lastCenterAt = performance.now();
	clearTrackingMarker();
	syncTrackingFeature(feature);
	requestAnimationFrame(() => centerOnFeature(feature, true));
};
const setFollowUnavailable = (feature) => {
	if (state.followedId === null || featurePseudoId(feature) !== state.followedId) return;
	const label = featurePseudoLabel(feature);
	clearTrackingMarker();
	followStatus.textContent = `Pseudotorn ${label} no actiu en aquesta hora`;
};
const attachSimulationSource = () => {
	state.simulationLayer = window.TmbSimulation.getLayer();
	const source = state.simulationLayer?.getSource();
	if (!source) return;
	source.on("addfeature", (event) => syncTrackingFeature(event.feature, true));
	source.on("changefeature", (event) => syncTrackingFeature(event.feature));
	source.on("removefeature", (event) => setFollowUnavailable(event.feature));
	source.on("clear", () => {
		clearTrackingMarker();
		if (state.followedId !== null) followStatus.textContent = "Seguiment temporalment sense posició";
	});
};
const attachMap = (map) => {
	state.map = map;
	state.trackingLayer = new ol.layer.Vector({source:new ol.source.Vector(),style:trackingStyle,zIndex:190});
	state.userLayer = new ol.layer.Vector({source:new ol.source.Vector(),style:userStyle,zIndex:200,visible:false});
	map.addLayer(state.trackingLayer);
	map.addLayer(state.userLayer);
	attachSimulationSource();
	map.on("singleclick", (event) => {
		const feature = map.forEachFeatureAtPixel(event.pixel, (candidate) => candidate.get("type") === "simulation-bus" ? candidate : undefined, {hitTolerance:10,layerFilter:(layer) => layer === state.simulationLayer});
		if (feature) toggleFollow(feature);
	});
	map.on("pointerdrag", () => {
		if (state.followedId !== null) clearFollow();
	});
};
const NativeMap = ol.Map;
ol.Map = class extends NativeMap {
	constructor(options) {
		super(options);
		if (options?.target === "map" || options?.target === $("map")) {
			attachMap(this);
			ol.Map = NativeMap;
		}
	}
};
const locationErrorText = (error) => {
	if (error?.code === 1) return "Permís d’ubicació denegat";
	if (error?.code === 2) return "Ubicació no disponible";
	if (error?.code === 3) return "Temps d’ubicació esgotat";
	return "No s’ha pogut obtenir la ubicació";
};
const locateDevice = () => {
	clearFollow();
	if (!window.isSecureContext) {
		locationStatus.textContent = "Cal HTTPS per obtenir la ubicació";
		return;
	}
	if (!navigator.geolocation) {
		locationStatus.textContent = "Geolocalització no disponible en aquest dispositiu";
		return;
	}
	locationButton.disabled = true;
	locationButton.textContent = "Localitzant…";
	navigator.geolocation.getCurrentPosition((position) => {
		const {latitude, longitude, accuracy} = position.coords;
		const coordinate = ol.proj.fromLonLat([longitude, latitude]);
		if (!state.userFeature) {
			state.userFeature = new ol.Feature({geometry:new ol.geom.Point(coordinate),type:"device-location"});
			state.userLayer?.getSource().addFeature(state.userFeature);
		} else state.userFeature.getGeometry().setCoordinates(coordinate);
		state.userLayer?.setVisible(true);
		const view = state.map?.getView();
		if (view) view.animate({center:coordinate,zoom:Math.max(Number(view.getZoom()) || 0,16),duration:350});
		locationStatus.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)} · ±${Math.round(accuracy)} m`;
		locationButton.disabled = false;
		locationButton.textContent = "La meva ubicació";
	}, (error) => {
		locationStatus.textContent = locationErrorText(error);
		locationButton.disabled = false;
		locationButton.textContent = "La meva ubicació";
	}, {enableHighAccuracy:true,timeout:12000,maximumAge:15000});
};
locationButton.addEventListener("click", locateDevice);
$("simulation-service-date")?.addEventListener("change", clearFollow);
$("simulation-toggle")?.addEventListener("click", () => {
	const closing = $("simulation-toggle")?.getAttribute("aria-expanded") === "true";
	if (closing) {
		clearFollow();
		state.userLayer?.setVisible(false);
	} else state.userLayer?.setVisible(true);
});
const originalInit = window.TmbSimulation.init;
window.TmbSimulation.init = (options = {}) => {
	const result = originalInit(options);
	setSimulationSpeedControl(1);
	syncSpeedAvailability();
	return result;
};
const originalSelectRoute = window.TmbSimulation.selectRoute;
window.TmbSimulation.selectRoute = (route) => {
	clearFollow();
	state.userLayer?.setVisible(false);
	return originalSelectRoute(route);
};
})();
