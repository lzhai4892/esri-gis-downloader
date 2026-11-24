# ArcGIS REST Layer Downloader — final review and fix list

Corrected roadmap for the browser downloader. The earlier draft misstated a few ArcGIS behaviors. Those corrections are in the rules below, and the unsafe “stop on a short page” rule is gone. Items marked **Done** are in the current `index.html`, `script.js`, and `styles.css`.

## What was going wrong

- The page sent `layer/query` as GET and advanced `resultOffset` by the requested page size. When the server returned fewer rows than that (its `maxRecordCount` is lower), the next page skipped the gap.
- Layers that ignore `resultOffset` would repeat page 1. Nothing compared object ids, so that loop could run until the tab ran out of memory. Pages were also unordered.
- An ArcGIS error is often HTTP 200 with `{ "error": { "code", "message", "details" } }`. A later page that failed looked like the last page, and the partial extract was saved as a finished file. A failure on the first page did not save a file; it reported that no features were retrieved.
- Stop called `abort()`, and the code that removed the `indeterminate` progress class ran only after the paging loop. The abort threw before that line, so the bar kept animating. Features already in memory were discarded.
- A `MapServer` or `FeatureServer` URL with no layer id was sent to `/query`. The same happened for a group layer such as `/0` when the features are on `/1` or `/2`.

## Rules the fixes follow

- Read the layer first: `maxRecordCount`, object-id field, `capabilities`, `advancedQueryCapabilities.supportsPagination`, and `supportedQueryFormats`.
- Cap every page at `maxRecordCount`. Advance an offset by `features.length`, not by the number you asked for. Always set `orderByFields` to the object-id field ascending.
- Stop offset paging when a page is empty, when it is shorter than that capped page size, or when the downloaded count reaches `returnCountOnly`. Do not stop just because `features.length` is below the user’s original number, and do not stop just because `exceededTransferLimit` is false. A full last page can still have `exceededTransferLimit` false when the count is an exact multiple of the page size; the following empty page, or the known count, ends the loop.
- If `supportsPagination` is false, ask for object ids. If that list is shorter than the count or comes back with `exceededTransferLimit`, do not treat it as complete. Walk numeric object-id ranges instead. Keep each id batch at or under `maxRecordCount`.
- `returnCountOnly` does not require `supportsStatistics`. Use the same where clause for the count and the extract. If the count request fails, keep going without a percentage.
- POST queries as `application/x-www-form-urlencoded`. That avoids long URLs. It does not skip CORS: a host that allows GET can still omit `Access-Control-Allow-Origin` on POST.
- Treat a JSON `error` object as a failure even when the HTTP status is 200. On failure or Stop, keep the pages already fetched and ask before saving them. Strip `exceededTransferLimit` from a finished Esri JSON file.
- GeoJSON for other software needs `f=geojson` and `outSR=4326`. Save one FeatureCollection, not the raw page bodies. If the layer does not list GeoJSON, do not send that format. If it lists GeoJSON and still rejects the request, say so and save Esri JSON in the layer spatial reference.
- A service URL has no layer id. One queryable layer can be chosen automatically (often `/0`). Several layers need a choice before Download runs. A group layer (`type` contains “Group”, or it has sublayer ids) is not a download target; offer its sublayers. Include tables.

## Fix list

### P0 — the file must match the service

| Fix                                                                                                 | Status |
| --------------------------------------------------------------------------------------------------- | ------ |
| Reject HTTP 200 bodies that contain `error`                                                         | Done   |
| Cap page size at `maxRecordCount` and advance the offset by the rows returned                       | Done   |
| Page with `orderByFields` on the object-id field when pagination is supported                       | Done   |
| If pagination is not supported, use object ids, then object-id ranges when the id list is truncated | Done   |
| Stop if a page repeats an object id already saved                                                   | Done   |
| POST query requests, and retry 429 / 502 / 503 / 504 from the last successful point                 | Done   |
| On Stop or a mid-run error, offer to save the features already retrieved                            | Done   |

### P1 — know which layer, and show real progress

| Fix                                                                                           | Status |
| --------------------------------------------------------------------------------------------- | ------ |
| Sanitize the URL: trim, drop the query string, drop a trailing `/query`                       | Done   |
| Service URL with one queryable layer: use it and name the id                                  | Done   |
| Service URL with several layers: picker with id, name, and geometry; Download waits           | Done   |
| Group layer: list sublayers instead of querying the group id                                  | Done   |
| `returnCountOnly` with the user’s where clause; show features and page size before paging     | Done   |
| Block a queryable-capability miss and a zero count. A count over 100,000 needs a second click | Done   |
| Progress text `Page x of y · downloaded / total`, and a bar driven by that ratio              | Done   |
| Stop removes the indeterminate animation in the Stop handler, before the abort settles        | Done   |
| Default file name from the layer name, without a second `.json`                               | Done   |
| Optional token on metadata and query requests                                                 | Done   |
| Esri JSON or GeoJSON. GeoJSON requests EPSG:4326. `returnZ` is available next to M            | Done   |
| Remember the last few URLs in this browser                                                    | Done   |

### P2 — still open

- Choose an output WKID for Esri JSON, not only 4326 for GeoJSON.
- Choose fields instead of always requesting `outFields=*`.
- Write straight to disk with the File System Access API. The app already builds the file from chunked JSON parts so it does not stringify one giant string, and those parts still sit in memory.
- Split the single form into a clearer Connect, then Inspect, then Export sequence. The layer picker and the status line cover the decision, and the page is still one form.
- Done. The page and tab use the layer-stack `favicon.svg`, with `favicon.ico` for older clients. The old globe is kept as `favicon-old.ico`.

### P3 — interface polish

| Fix                                                                                         | Status |
| ------------------------------------------------------------------------------------------- | ------ |
| Primary action uses Kittelson orange `#feae5c` with dark label text, darker orange on hover | Done   |
| Same orange on the progress bar. Stop clears the animation                                  | Done   |
| Query options start collapsed. Records and where stack below 700px                          | Done   |
| The form submits with Enter. Status is a live region. Focus rings are visible               | Done   |
| No sample layer is prefilled. No `alert()`                                                  | Done   |
| Header mark matches the favicon: two stacked layers on the orange tile                      | Done   |

## Download flow

```
Paste URL
  → strip ?query, #hash, and a trailing /query
  → MapServer or FeatureServer?
       no  → error
       service (no id)
            → one leaf layer: use it
            → several: wait for a choice
       layer id
            → group layer: wait for a sublayer
            → otherwise use that id
  → layer metadata
  → returnCountOnly with the same where clause
  → supportsPagination?
       yes → POST pages of min(request, maxRecordCount), ordered by object id
       no  → object ids, or object-id ranges when that list is truncated
  → empty page, short capped page, or count reached → write the file
  → Stop or error → bar idle, Save or Discard if any rows are in memory
```

## Checks still worth doing by hand

- A layer with `supportsPagination: false` and a truncated `returnIdsOnly` response. The range walk is in the script and was not exercised against a live server in this pass.
- A secured layer with a token.
- A host that allows browser GET and blocks POST.
