const urlInput = document.getElementById("url-input");
const recentUrls = document.getElementById("recent-urls");
const layerGroup = document.getElementById("layer-group");
const layerSelect = document.getElementById("layer-select");
const choiceNotice = document.getElementById("choice-notice");
const nameInput = document.getElementById("name-input");
const formatSelect = document.getElementById("format-select");
const recordsInput = document.getElementById("records-input");
const whereInput = document.getElementById("where-input");
const tokenInput = document.getElementById("token-input");
const geometryCheckbox = document.getElementById("geometry-checkbox");
const mValuesCheckbox = document.getElementById("m-values-checkbox");
const zValuesCheckbox = document.getElementById("z-values-checkbox");
const progressBar = document.getElementById("progress-bar");
const statusElement = document.getElementById("status");
const optionsToggle = document.getElementById("options-toggle");
const advancedBody = document.getElementById("advanced-body");
const partialActions = document.getElementById("partial-actions");
const savePartialBtn = document.getElementById("save-partial-btn");
const discardBtn = document.getElementById("discard-btn");
const form = document.getElementById("download-form");
const downloadBtn = document.getElementById("download-btn");
const stopBtn = document.getElementById("stop-btn");
const tipButtons = Array.from(document.querySelectorAll(".tip"));

const RECENT_KEY = "esri-downloader-recent";
const LARGE_COUNT = 100000;
const GEOMETRY_LABELS = {
  esriGeometryPoint: "Point",
  esriGeometryMultipoint: "Multipoint",
  esriGeometryPolyline: "Polyline",
  esriGeometryPolygon: "Polygon",
  esriGeometryEnvelope: "Envelope",
};

let abortController = null;
let generation = 0;
let stopRequested = false;
let pendingLargeKey = "";
let partial = null;
let lastAutoFileBase = "";

form.addEventListener("submit", startDownload);
stopBtn.addEventListener("click", stopDownload);
savePartialBtn.addEventListener("click", savePartial);
discardBtn.addEventListener("click", discardPartial);
optionsToggle.addEventListener("click", () => {
  const expanded = optionsToggle.getAttribute("aria-expanded") === "true";
  optionsToggle.setAttribute("aria-expanded", String(!expanded));
  advancedBody.hidden = expanded;
});
tipButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opening = !button.classList.contains("is-open");
    closeTips();
    if (opening) button.classList.add("is-open");
  });
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".tip")) closeTips();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTips();
});
urlInput.addEventListener("input", () => {
  pendingLargeKey = "";
  hidePartial();
  clearBar();
  hideLayerPicker();
});
layerSelect.addEventListener("change", () => {
  pendingLargeKey = "";
  hidePartial();
  if (!layerSelect.value) {
    showChoiceNotice("Choose a layer, then click Download layer.");
    return;
  }
  const label = layerSelect.selectedOptions[0]
    ? layerSelect.selectedOptions[0].textContent
    : "that layer";
  showChoiceNotice(`Selected ${label}. Click Download layer.`, {
    focusDownload: true,
  });
});
loadRecentUrls();

function closeTips() {
  tipButtons.forEach((button) => button.classList.remove("is-open"));
}

function startDownload(event) {
  event.preventDefault();
  const runId = beginRun();
  hidePartial();
  clearBar();
  setBusy(true);
  setIndeterminate(true);
  updateStatus("Checking the service…");

  runDownload(runId)
    .catch((error) => {
      if (!isCurrent(runId)) return;
      if (error.name === "AbortError" || stopRequested) {
        clearBar();
        if (!partial) updateStatus("Stopped.");
        return;
      }
      showError(error.message || "The download failed.");
    })
    .finally(() => {
      if (!isCurrent(runId)) return;
      setBusy(false);
      if (!choiceNotice.hidden) {
        if (downloadBtn.dataset.choiceReady === "true") downloadBtn.focus();
        else layerSelect.focus();
      }
    });
}

async function runDownload(runId) {
  const rawUrl = urlInput.value.trim();
  if (!rawUrl) {
    showError("Paste a layer link or a Map Viewer page.");
    return;
  }

  const target = await resolveTarget(rawUrl);
  if (!isCurrent(runId) || stopRequested) {
    finishStopped([], null, formatSelect.value, "");
    return;
  }
  if (!target) {
    clearBar();
    return;
  }
  if (target.count === 0) {
    showError("That filter matches 0 features.");
    return;
  }

  const largeKey = `${target.layerUrl}|${target.where}|${target.count}`;
  if (target.count > LARGE_COUNT && pendingLargeKey !== largeKey) {
    pendingLargeKey = largeKey;
    clearBar();
    updateStatus(
      `This request matches ${formatNumber(target.count)} features. Click Download to start.`,
    );
    return;
  }
  pendingLargeKey = "";

  const collected = [];
  const seen = new Set();
  const shellHolder = { shell: null };
  let format = target.format;
  let fellBackFromGeoJson = false;
  if (format === "geojson" && !target.supportsGeoJson) {
    format = "json";
    fellBackFromGeoJson = true;
  }

  try {
    await collectFeatures(target, format, collected, seen, shellHolder);
  } catch (error) {
    if (!isCurrent(runId)) return;
    if (error.name === "AbortError" || stopRequested) {
      finishStopped(collected, shellHolder.shell, format, target.fileBase);
      return;
    }
    const canFallback =
      format === "geojson" && collected.length === 0 && target.supportsGeoJson;
    if (!canFallback) {
      const savedNote = collected.length
        ? ` ${formatNumber(collected.length)} features downloaded before the error can be saved.`
        : "";
      finishStopped(
        collected,
        shellHolder.shell,
        format,
        target.fileBase,
        `${error.message}${savedNote}`,
        true,
      );
      return;
    }
    format = "json";
    fellBackFromGeoJson = true;
    try {
      await collectFeatures(target, format, collected, seen, shellHolder);
    } catch (secondError) {
      if (!isCurrent(runId)) return;
      if (secondError.name === "AbortError" || stopRequested) {
        finishStopped(collected, shellHolder.shell, format, target.fileBase);
        return;
      }
      throw secondError;
    }
  }

  if (!isCurrent(runId)) return;
  if (stopRequested) {
    finishStopped(collected, shellHolder.shell, format, target.fileBase);
    return;
  }
  if (collected.length === 0) {
    showError("No features were downloaded. Check the filter.");
    return;
  }

  saveFeatures(collected, shellHolder.shell, format, target.fileBase);
  setProgress(100);
  const fallbackNote = fellBackFromGeoJson
    ? " This layer could not be saved as GeoJSON, so the file is Esri JSON in the layer’s own coordinates."
    : "";
  updateStatus(
    `Saved ${formatNumber(collected.length)} features.${fallbackNote}`,
  );
}

function stopDownload() {
  stopRequested = true;
  clearBar();
  updateStatus("Stopping…");
  stopBtn.disabled = true;
  if (abortController) abortController.abort();
}

function beginRun() {
  stopRequested = false;
  if (abortController) abortController.abort();
  abortController = new AbortController();
  generation += 1;
  return generation;
}

function isCurrent(runId) {
  return runId === generation;
}

async function resolveTarget(rawUrl) {
  hideChoiceNotice();
  const located = await locateLayerUrl(rawUrl);
  if (!located) return null;
  if (located.rewritten) urlInput.value = located.url;
  const url = located.url;
  const kind = classifyUrl(url);
  if (!kind) {
    throw new Error(
      "Paste a layer link (it contains MapServer or FeatureServer), or a Map Viewer page that includes one.",
    );
  }

  const token = tokenValue();
  let layerUrl = url;
  let meta;

  if (kind === "service") {
    const service = await getJson(url, { f: "json", token });
    const leaves = leafLayers(service, url);
    if (leaves.length === 0) {
      throw new Error("This link has no layer to download.");
    }
    const selectedId = layerSelect.value;
    if (leaves.length === 1) {
      showLayerPicker(leaves, leaves[0].id);
      layerUrl = leaves[0].url;
      updateStatus(`Using layer ${leaves[0].id} — ${leaves[0].name}.`);
    } else {
      const selected = leaves.find((layer) => String(layer.id) === selectedId);
      showLayerPicker(leaves, selected ? selected.id : "");
      if (!selected) {
        showChoiceNotice(
          `This link has ${leaves.length} layers. Choose one, then click Download layer.`,
        );
        return null;
      }
      layerUrl = selected.url;
    }
    meta = await getJson(layerUrl, { f: "json", token });
  } else {
    meta = await getJson(layerUrl, { f: "json", token });
    if (isGroupLayer(meta)) {
      const serviceUrl = parentServiceUrl(layerUrl);
      const service = await getJson(serviceUrl, { f: "json", token });
      const leaves = descendantLeaves(service, serviceUrl, meta.id);
      const choices = leaves.length ? leaves : leafLayers(service, serviceUrl);
      const selected = choices.find(
        (layer) => String(layer.id) === layerSelect.value,
      );
      showLayerPicker(choices, selected ? selected.id : "");
      if (!selected) {
        showChoiceNotice(
          `${meta.name || "This layer"} is a folder of layers. Choose one layer inside it, then click Download layer.`,
        );
        return null;
      }
      layerUrl = selected.url;
      meta = await getJson(layerUrl, { f: "json", token });
    } else if (!located.keepPicker) {
      hideLayerPicker();
    }
  }

  if (isGroupLayer(meta)) {
    throw new Error(
      "Choose a feature layer or table. Group layers cannot be queried.",
    );
  }
  if (!canQuery(meta)) {
    throw new Error(`“${meta.name || "This layer"}” does not allow queries.`);
  }

  const where = whereClause();
  const maxRecordCount =
    Number(meta.maxRecordCount) > 0 ? Number(meta.maxRecordCount) : 1000;
  const pageSize = pageSizeFor(maxRecordCount);
  if (recordsInput.value && Number(recordsInput.value) > maxRecordCount) {
    recordsInput.value = String(maxRecordCount);
  }
  const count = await tryCount(layerUrl, where, token);
  const fileBase = outputBase(meta);
  const currentName = nameInput.value.trim();
  if (!currentName || currentName === lastAutoFileBase) {
    nameInput.value = fileBase;
    lastAutoFileBase = fileBase;
  }
  rememberUrl(url);

  const countText =
    count == null ? "count unavailable" : `${formatNumber(count)} features`;
  const geometry = geometryLabel(meta.geometryType);
  updateStatus(
    `${meta.name || "Layer"}${geometry ? ` (${geometry})` : ""}. ${countText}. Pages of ${formatNumber(pageSize)}.`,
  );

  return {
    layerUrl,
    meta,
    where,
    token,
    returnGeometry: geometryCheckbox.checked,
    returnM: mValuesCheckbox.checked,
    returnZ: zValuesCheckbox.checked,
    count,
    pageSize,
    oidField: objectIdFieldOf(meta),
    supportsPagination: Boolean(
      (meta.advancedQueryCapabilities &&
        meta.advancedQueryCapabilities.supportsPagination) ||
      meta.supportsPagination,
    ),
    supportsStatistics: Boolean(
      meta.advancedQueryCapabilities &&
      meta.advancedQueryCapabilities.supportsStatistics,
    ),
    supportsGeoJson: /geojson/i.test(meta.supportedQueryFormats || ""),
    format: formatSelect.value === "geojson" ? "geojson" : "json",
    fileBase: nameInput.value.trim() || fileBase,
  };
}

function isTransferLimitExceeded(data) {
  return Boolean(
    data &&
    (data.exceededTransferLimit === true ||
      (data.properties && data.properties.exceededTransferLimit === true)),
  );
}

function isTransferLimitExplicitlyFalse(data) {
  return Boolean(
    data &&
    (data.exceededTransferLimit === false ||
      (data.properties && data.properties.exceededTransferLimit === false)),
  );
}

async function collectFeatures(target, format, collected, seen, shellHolder) {
  if (format === "geojson" && !target.supportsGeoJson) {
    throw new Error(
      "This layer cannot be saved as GeoJSON. Choose Esri JSON instead.",
    );
  }
  if (target.supportsPagination) {
    await pageByOffset(target, format, collected, seen, shellHolder);
    return;
  }
  await pageWithoutPagination(target, format, collected, seen, shellHolder);
}

async function pageByOffset(target, format, collected, seen, shellHolder) {
  let offset = 0;
  while (!stopRequested) {
    const data = await postQuery(target.layerUrl, {
      ...featureParams(target, format),
      resultOffset: String(offset),
      resultRecordCount: String(target.pageSize),
      orderByFields: `${target.oidField} ASC`,
    });
    const added = takeBatch(
      data,
      collected,
      seen,
      target.oidField,
      shellHolder,
    );
    if (added === 0) break;
    offset += added;
    reportProgress(collected.length, target.count, target.pageSize);
    if (added < target.pageSize && !isTransferLimitExceeded(data)) break;
    if (target.count != null && collected.length >= target.count) break;
  }
}

async function pageWithoutPagination(
  target,
  format,
  collected,
  seen,
  shellHolder,
) {
  const idData = await postQuery(target.layerUrl, {
    where: target.where,
    returnIdsOnly: "true",
    returnGeometry: "false",
    f: "json",
    token: target.token,
  });
  const ids = Array.isArray(idData.objectIds) ? idData.objectIds : [];
  const truncated =
    isTransferLimitExceeded(idData) ||
    (target.count != null && ids.length < target.count);
  if (!truncated && ids.length === 0) return;
  if (truncated) {
    await pageByObjectIdRanges(target, format, collected, seen, shellHolder);
    return;
  }

  const totalExpected = target.count || ids.length;
  const queue = [];
  for (let index = 0; index < ids.length; index += target.pageSize) {
    queue.push(ids.slice(index, index + target.pageSize));
  }
  while (queue.length > 0 && !stopRequested) {
    const chunk = queue.shift();
    const data = await postQuery(target.layerUrl, {
      ...featureParams(target, format),
      objectIds: chunk.join(","),
    });
    const added = takeBatch(
      data,
      collected,
      seen,
      target.oidField,
      shellHolder,
    );
    reportProgress(collected.length, totalExpected, target.pageSize);
    if (added < chunk.length && isTransferLimitExceeded(data)) {
      const remaining = chunk.filter((id) => !seen.has(String(id)));
      if (remaining.length === chunk.length && chunk.length === 1) {
        throw new Error(
          "A single feature exceeded the server transfer limit and could not be downloaded.",
        );
      }
      const nextStep = Math.max(
        1,
        Math.floor((remaining.length || chunk.length) / 2),
      );
      const source = remaining.length > 0 ? remaining : chunk;
      const split = [];
      for (let i = 0; i < source.length; i += nextStep) {
        split.push(source.slice(i, i + nextStep));
      }
      queue.unshift(...split);
    }
  }
}

async function pageByObjectIdRanges(
  target,
  format,
  collected,
  seen,
  shellHolder,
) {
  if (!target.supportsStatistics) {
    throw new Error(
      "This layer cannot page results and did not return every object id. Narrow the where clause and try again.",
    );
  }
  const stats = await postQuery(target.layerUrl, {
    where: target.where,
    returnGeometry: "false",
    f: "json",
    token: target.token,
    outStatistics: JSON.stringify([
      {
        statisticType: "min",
        onStatisticField: target.oidField,
        outStatisticFieldName: "minOid",
      },
      {
        statisticType: "max",
        onStatisticField: target.oidField,
        outStatisticFieldName: "maxOid",
      },
    ]),
  });
  const attributes =
    stats.features && stats.features[0] && stats.features[0].attributes;
  const minOid =
    attributes &&
    (attributes.minOid != null ? attributes.minOid : attributes.minoid);
  const maxOid =
    attributes &&
    (attributes.maxOid != null ? attributes.maxOid : attributes.maxoid);
  if (!isWholeNumber(minOid) || !isWholeNumber(maxOid)) {
    throw new Error(
      "This layer cannot page results and did not return every object id. Narrow the where clause and try again.",
    );
  }

  let low = Number(minOid);
  const highLimit = Number(maxOid);
  let windowSize = target.pageSize;
  let stuck = 0;
  while (low <= highLimit && !stopRequested) {
    const high = Math.min(low + windowSize - 1, highLimit);
    const data = await postQuery(target.layerUrl, {
      ...featureParams(target, format),
      where: `(${target.where}) AND ${target.oidField} >= ${low} AND ${target.oidField} <= ${high}`,
    });
    const batch = Array.isArray(data.features) ? data.features : [];
    const windowSpan = high - low + 1;
    const capped =
      isTransferLimitExceeded(data) ||
      (!isTransferLimitExplicitlyFalse(data) &&
        batch.length >= target.pageSize &&
        windowSpan > target.pageSize);
    if (capped && high > low) {
      const nextWindow = Math.max(1, Math.floor(windowSpan / 2));
      if (nextWindow === windowSize) stuck += 1;
      else stuck = 0;
      if (stuck > 5) {
        throw new Error(
          "Object-id paging stopped because the page size did not shrink.",
        );
      }
      windowSize = nextWindow;
      continue;
    }
    takeBatch(data, collected, seen, target.oidField, shellHolder);
    reportProgress(collected.length, target.count, target.pageSize);
    stuck = 0;
    low = high + 1;
    if (!capped)
      windowSize = Math.min(
        target.pageSize * 20,
        Math.max(windowSize * 2, target.pageSize),
      );
  }
}

function featureParams(target, format) {
  const params = {
    where: target.where,
    outFields: "*",
    returnGeometry: target.returnGeometry ? "true" : "false",
    returnM: target.returnM ? "true" : "false",
    returnZ: target.returnZ ? "true" : "false",
    f: format === "geojson" ? "geojson" : "json",
  };
  if (format === "geojson") params.outSR = "4326";
  if (target.token) params.token = target.token;
  return params;
}

function takeBatch(data, collected, seen, oidField, shellHolder) {
  const batch = Array.isArray(data.features) ? data.features : [];
  const keys = [];
  for (const feature of batch) {
    const id = featureObjectId(feature, oidField);
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) {
      throw new Error("The server repeated features, so the download stopped.");
    }
    keys.push(key);
  }
  keys.forEach((key) => seen.add(key));
  if (batch.length > 0 && !shellHolder.shell) shellHolder.shell = data;
  collected.push(...batch);
  return batch.length;
}

async function tryCount(layerUrl, where, token) {
  try {
    const data = await postQuery(layerUrl, {
      where,
      returnCountOnly: "true",
      f: "json",
      token,
    });
    return typeof data.count === "number" ? data.count : null;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return null;
  }
}

async function postQuery(layerUrl, params) {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") body.set(key, String(value));
  });
  const response = await fetchWithRetry(`${layerUrl}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: abortController.signal,
  });
  return readEsri(response);
}

async function getJson(url, params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") query.set(key, String(value));
  });
  const response = await fetchWithRetry(`${url}?${query.toString()}`, {
    method: "GET",
    signal: abortController.signal,
  });
  return readEsri(response);
}

async function fetchWithRetry(url, options) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await wait(400 * 2 ** attempt);
        continue;
      }
      return response;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      if (attempt === 2) break;
      await wait(400 * 2 ** attempt);
    }
  }
  throw lastError || new Error("The request failed.");
}

async function readEsri(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(
      `Server returned status ${response.status} and the body was not JSON.`,
    );
  }
  if (json && json.error) {
    const details = Array.isArray(json.error.details)
      ? json.error.details.filter(Boolean).join("; ")
      : "";
    const message = json.error.message || "The query failed.";
    throw new Error(details ? `${message} (${details})` : message);
  }
  if (!response.ok) {
    throw new Error(`Server returned status code ${response.status}.`);
  }
  return json || {};
}

function wait(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortController)
        abortController.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (abortController && abortController.signal.aborted) onAbort();
    else if (abortController)
      abortController.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function decodeRepeated(value) {
  let current = String(value);
  for (let i = 0; i < 3; i += 1) {
    if (!/%[0-9a-f]{2}/i.test(current)) break;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch (error) {
      break;
    }
  }
  return current;
}

function restEndpointFromText(piece) {
  const clipped = piece
    .split(/[\s"'<>]/)[0]
    .replace(/&.*$/, "")
    .replace(/[),.;]+$/, "");
  if (!/^https?:\/\//i.test(clipped)) return "";
  try {
    const parsed = new URL(clipped);
    const path = parsed.pathname.replace(/\/+$/, "");
    const match = path.match(
      /^(.*\/(?:FeatureServer|MapServer)(?:\/\d+)?)(?:\/query)?$/i,
    );
    if (!match) return "";
    return `${parsed.origin}${match[1]}`;
  } catch (error) {
    return "";
  }
}

function restUrlsIn(text) {
  const pieces = decodeRepeated(text).split(/(?=https?:\/\/)/i);
  const urls = [];
  pieces.forEach((piece) => {
    const endpoint = restEndpointFromText(piece);
    if (
      endpoint &&
      !urls.some((item) => item.toLowerCase() === endpoint.toLowerCase())
    ) {
      urls.push(endpoint);
    }
  });
  return urls;
}

function preferredRestUrl(urls) {
  return urls.find((url) => /\/\d+$/.test(url)) || urls[0] || "";
}

function sharingBase(parsed) {
  const portal = parsed.pathname.match(/^(.*?)\/(?:apps|home)\//i);
  if (portal && /\/portal$/i.test(portal[1])) {
    return `${parsed.origin}${portal[1]}/sharing/rest`;
  }
  return `${parsed.origin}/sharing/rest`;
}

function addLayerUrl(layers, url, name) {
  const endpoint = restEndpointFromText(url || "");
  if (!endpoint) return;
  if (
    layers.some((layer) => layer.url.toLowerCase() === endpoint.toLowerCase())
  )
    return;
  layers.push({ url: endpoint, name: name || "Layer" });
}

async function layerUrlsFromMapPage(raw) {
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch (error) {
    return null;
  }
  const params = new URLSearchParams(parsed.search);
  if (parsed.hash.includes("=")) {
    new URLSearchParams(parsed.hash.replace(/^#\??/, "")).forEach(
      (value, key) => {
        if (!params.has(key)) params.append(key, value);
      },
    );
  }
  const itemId = [
    params.get("webmap"),
    params.get("id"),
    params.get("layers"),
  ].find((value) => value && /^[a-f0-9]{32}$/i.test(value));
  const looksLikeMapPage =
    /arcgis\.com$/i.test(parsed.hostname) ||
    /\/(?:apps\/mapviewer|home\/webmap|home\/item)/i.test(parsed.pathname);
  if (!itemId || !looksLikeMapPage) return null;

  const base = sharingBase(parsed);
  const token = tokenValue();
  const layers = [];
  let lastError = null;
  function collectWebMapLayers(items) {
    if (!Array.isArray(items)) return;
    items.forEach((layer) => {
      if (!layer) return;
      addLayerUrl(layers, layer.url, layer.title || layer.name);
      collectWebMapLayers(layer.layers);
    });
  }
  try {
    const data = await getJson(`${base}/content/items/${itemId}/data`, {
      f: "json",
      token,
    });
    collectWebMapLayers(data.operationalLayers);
    collectWebMapLayers(data.tables);
    addLayerUrl(layers, data.url, data.title || data.name);
  } catch (error) {
    lastError = error;
  }
  if (layers.length === 0) {
    try {
      const item = await getJson(`${base}/content/items/${itemId}`, {
        f: "json",
        token,
      });
      addLayerUrl(layers, item.url, item.title || item.name);
    } catch (error) {
      lastError = error;
    }
  }
  if (layers.length === 0) {
    if (lastError) throw lastError;
    throw new Error(
      "That map page has no layer we can download. Paste the layer link instead.",
    );
  }
  return layers;
}

async function locateLayerUrl(raw) {
  const own = preferredRestUrl(restUrlsIn(raw.split("#")[0].split("?")[0]));
  if (own) return { url: sanitizeServiceUrl(own), rewritten: false };

  const embedded = preferredRestUrl(restUrlsIn(raw));
  if (embedded) return { url: sanitizeServiceUrl(embedded), rewritten: true };

  const fromMap = await layerUrlsFromMapPage(raw);
  if (!fromMap) return { url: sanitizeServiceUrl(raw), rewritten: false };
  if (fromMap.length === 1) {
    return { url: sanitizeServiceUrl(fromMap[0].url), rewritten: true };
  }

  const selected = fromMap.find((layer) => layer.url === layerSelect.value);
  showLayerPicker(
    fromMap.map((layer) => ({
      id: layer.url,
      name: layer.name,
      geometryType: "",
    })),
    selected ? selected.url : "",
  );
  if (!selected) {
    showChoiceNotice(
      `This map has ${fromMap.length} layers. Choose one, then click Download layer.`,
    );
    return null;
  }
  return {
    url: sanitizeServiceUrl(selected.url),
    rewritten: false,
    keepPicker: true,
  };
}

function sanitizeServiceUrl(raw) {
  let value = raw.trim().replace(/\s+/g, "");
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    value = parsed.toString();
  } catch (error) {
    value = value.split("#")[0].split("?")[0];
  }
  return value.replace(/\/+$/, "").replace(/\/query$/i, "");
}

function classifyUrl(url) {
  if (/\/(?:MapServer|FeatureServer)\/\d+$/i.test(url)) return "layer";
  if (/\/(?:MapServer|FeatureServer)$/i.test(url)) return "service";
  return "";
}

function parentServiceUrl(layerUrl) {
  return layerUrl.replace(/\/\d+$/, "");
}

function isGroupLayer(layer) {
  if (!layer) return false;
  if (/group/i.test(String(layer.type || ""))) return true;
  if (Array.isArray(layer.subLayerIds) && layer.subLayerIds.length > 0)
    return true;
  if (Array.isArray(layer.subLayers) && layer.subLayers.length > 0) return true;
  return false;
}

function canQuery(meta) {
  if (!meta.capabilities) return true;
  return meta.capabilities
    .split(",")
    .some((item) => item.trim().toLowerCase() === "query");
}

function leafLayers(service, serviceUrl) {
  const tables = new Set((service.tables || []).map((table) => table.id));
  return [...(service.layers || []), ...(service.tables || [])]
    .filter((layer) => !isGroupLayer(layer))
    .map((layer) => ({
      id: layer.id,
      name: layer.name || `Layer ${layer.id}`,
      geometryType: layer.geometryType || (tables.has(layer.id) ? "table" : ""),
      url: `${serviceUrl}/${layer.id}`,
    }));
}

function descendantLeaves(service, serviceUrl, groupId) {
  const all = [...(service.layers || []), ...(service.tables || [])];
  const byId = new Map(all.map((layer) => [layer.id, layer]));
  const under = new Set();
  function walk(id) {
    const layer = byId.get(id);
    if (!layer) return;
    const childIds = [
      ...(Array.isArray(layer.subLayerIds) ? layer.subLayerIds : []),
      ...(Array.isArray(layer.subLayers)
        ? layer.subLayers.map((child) => child.id)
        : []),
    ];
    childIds.forEach((childId) => {
      if (under.has(childId)) return;
      under.add(childId);
      walk(childId);
    });
  }
  walk(groupId);
  const byParent = leafLayers(service, serviceUrl).filter((layer) => {
    let current = byId.get(layer.id);
    const guard = new Set();
    while (
      current &&
      current.parentLayerId != null &&
      current.parentLayerId !== -1
    ) {
      if (guard.has(current.id)) return false;
      guard.add(current.id);
      if (current.parentLayerId === groupId) return true;
      current = byId.get(current.parentLayerId);
    }
    return false;
  });
  const fromTree = leafLayers(service, serviceUrl).filter((layer) =>
    under.has(layer.id),
  );
  return fromTree.length ? fromTree : byParent;
}

function objectIdFieldOf(meta) {
  if (meta.objectIdField) return meta.objectIdField;
  if (meta.objectIdFieldName) return meta.objectIdFieldName;
  const field = (meta.fields || []).find(
    (item) => item.type === "esriFieldTypeOID",
  );
  return field ? field.name : "OBJECTID";
}

function pageSizeFor(maxRecordCount) {
  const requested = parseInt(recordsInput.value, 10);
  if (!Number.isFinite(requested) || requested <= 0) return maxRecordCount;
  return Math.min(requested, maxRecordCount);
}

function whereClause() {
  return whereInput.value.trim() || "1=1";
}

function tokenValue() {
  return tokenInput.value.trim();
}

function outputBase(meta) {
  const source = (meta.name || "arcgis_layer").trim().replace(/\s+/g, "_");
  return safeFileBase(source);
}

function safeFileBase(name) {
  const cleaned = name
    .trim()
    .replace(/\.(json|geojson)$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "_");
  return cleaned || "arcgis_layer";
}

function geometryLabel(type) {
  if (!type || type === "table") return type === "table" ? "Table" : "";
  return GEOMETRY_LABELS[type] || type;
}

function featureObjectId(feature, oidField) {
  if (feature && feature.attributes && feature.attributes[oidField] != null)
    return feature.attributes[oidField];
  if (feature && feature.properties && feature.properties[oidField] != null)
    return feature.properties[oidField];
  if (feature && feature.id != null) return feature.id;
  return null;
}

function isWholeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function reportProgress(done, total, pageSize) {
  if (total && total > 0) {
    const pct = Math.min(100, (done / total) * 100);
    setProgress(pct);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pages, Math.max(1, Math.ceil(done / pageSize)));
    updateStatus(
      `Page ${page} of ${pages} · ${formatNumber(done)} / ${formatNumber(total)} features`,
    );
    return;
  }
  setIndeterminate(true);
  updateStatus(`Retrieved ${formatNumber(done)} features`);
}

function finishStopped(features, shell, format, fileBase, message, isError) {
  clearBar();
  if (!features.length) {
    hidePartial();
    updateStatus(message || "Stopped.", isError ? "error" : undefined);
    return;
  }
  partial = {
    features: features.slice(),
    shell,
    format,
    fileBase: fileBase || nameInput.value.trim() || "arcgis_layer",
  };
  partialActions.hidden = false;
  savePartialBtn.textContent = `Save ${formatNumber(features.length)} features`;
  updateStatus(
    message || `Stopped. ${formatNumber(features.length)} features downloaded.`,
    isError ? "error" : undefined,
  );
}

function savePartial() {
  if (!partial) return;
  saveFeatures(
    partial.features,
    partial.shell,
    partial.format,
    partial.fileBase,
  );
  updateStatus(`Saved ${formatNumber(partial.features.length)} features.`);
  hidePartial();
}

function discardPartial() {
  partial = null;
  hidePartial();
  clearBar();
  updateStatus("Discarded the partial download.");
}

function hidePartial() {
  partial = null;
  partialActions.hidden = true;
}

function saveFeatures(features, shell, format, fileBase) {
  const extension = format === "geojson" ? "geojson" : "json";
  const filename = `${safeFileBase(fileBase)}.${extension}`;
  const blob =
    format === "geojson"
      ? buildGeoBlob(features)
      : buildEsriBlob(shell, features);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function buildEsriBlob(shell, features) {
  const meta = { ...(shell || {}) };
  delete meta.features;
  delete meta.exceededTransferLimit;
  const parts = [];
  if (Object.keys(meta).length === 0) {
    parts.push('{"features":[');
  } else {
    parts.push(JSON.stringify(meta).slice(0, -1));
    parts.push(',"features":[');
  }
  features.forEach((feature, index) => {
    if (index > 0) parts.push(",");
    parts.push(JSON.stringify(feature));
  });
  parts.push("]}");
  return new Blob(parts, { type: "application/json" });
}

function buildGeoBlob(features) {
  const parts = ['{"type":"FeatureCollection","features":['];
  features.forEach((feature, index) => {
    if (index > 0) parts.push(",");
    parts.push(JSON.stringify(feature));
  });
  parts.push("]}");
  return new Blob(parts, { type: "application/geo+json" });
}

function showChoiceNotice(message, options = {}) {
  choiceNotice.hidden = false;
  choiceNotice.textContent = message;
  layerSelect.classList.toggle("needs-choice", !options.focusDownload);
  updateStatus(message);
  if (options.focusDownload) {
    downloadBtn.textContent = "Download layer";
    downloadBtn.dataset.choiceReady = "true";
    downloadBtn.focus();
  } else {
    downloadBtn.textContent = "Download";
    delete downloadBtn.dataset.choiceReady;
    layerSelect.focus();
  }
  layerGroup.scrollIntoView({ block: "center" });
}

function hideChoiceNotice() {
  choiceNotice.hidden = true;
  choiceNotice.textContent = "";
  layerSelect.classList.remove("needs-choice");
  downloadBtn.textContent = "Download";
  delete downloadBtn.dataset.choiceReady;
}

function showLayerPicker(layers, selectedId) {
  layerGroup.hidden = false;
  layerSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a layer";
  layerSelect.appendChild(placeholder);
  layers.forEach((layer) => {
    const option = document.createElement("option");
    option.value = String(layer.id);
    const geometry = geometryLabel(layer.geometryType);
    const namedOnly = /^https?:/i.test(String(layer.id));
    option.textContent = namedOnly
      ? layer.name
      : geometry
        ? `${layer.id} — ${layer.name} (${geometry})`
        : `${layer.id} — ${layer.name}`;
    layerSelect.appendChild(option);
  });
  if (
    selectedId != null &&
    layers.some((layer) => String(layer.id) === String(selectedId))
  ) {
    layerSelect.value = String(selectedId);
  }
}

function hideLayerPicker() {
  layerGroup.hidden = true;
  layerSelect.innerHTML = "";
  hideChoiceNotice();
}

function rememberUrl(url) {
  try {
    const existing = loadRecentList().filter((item) => item !== url);
    existing.unshift(url);
    localStorage.setItem(RECENT_KEY, JSON.stringify(existing.slice(0, 8)));
  } catch (error) {
    return;
  }
  loadRecentUrls();
}

function loadRecentList() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch (error) {
    return [];
  }
}

function loadRecentUrls() {
  recentUrls.innerHTML = "";
  loadRecentList().forEach((url) => {
    const option = document.createElement("option");
    option.value = url;
    recentUrls.appendChild(option);
  });
}

function setBusy(busy) {
  downloadBtn.disabled = busy;
  stopBtn.disabled = !busy;
  urlInput.disabled = busy;
  layerSelect.disabled = busy;
  formatSelect.disabled = busy;
}

function setIndeterminate(on) {
  progressBar.classList.remove("error");
  progressBar.classList.toggle("indeterminate", on);
  if (on) {
    progressBar.style.width = "";
    progressBar.removeAttribute("aria-valuenow");
  }
}

function setProgress(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  progressBar.classList.remove("indeterminate", "error");
  progressBar.style.width = `${clamped}%`;
  progressBar.setAttribute("aria-valuenow", String(Math.round(clamped)));
}

function clearBar() {
  progressBar.classList.remove("indeterminate", "error");
  progressBar.style.width = "0%";
  progressBar.setAttribute("aria-valuenow", "0");
}

function showError(message) {
  clearBar();
  progressBar.classList.add("error");
  progressBar.style.width = "100%";
  progressBar.removeAttribute("aria-valuenow");
  updateStatus(message, "error");
}

function updateStatus(message, tone) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", tone === "error");
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}
