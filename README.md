# ArcGIS REST Layer Downloader (Web Version)

# Created 4/22/2025 by Liang Zhai lzhai@kittelson.com

A web application for downloading one feature layer from an ArcGIS REST service. Open it from a local web server so the browser can call the service. File URLs often fail the service's cross-origin check.

## Features

- Download features from ArcGIS REST API endpoints
- Supports pagination to handle large datasets
- Configure advanced options like record count, where clauses, and geometry options
- Progress tracking and status updates
- Stop downloads in progress

## How to Use

1. Serve this folder (`python -m http.server 8765`) and open `http://127.0.0.1:8765/`
2. Paste a layer URL (`.../MapServer/0`) or a service URL (`.../MapServer`)
3. If the service has more than one layer, choose one. A single queryable layer is selected for you. Group layers ask for a sublayer.
4. Choose Esri JSON or GeoJSON. GeoJSON is requested in WGS 84 (EPSG:4326).
5. Set a where clause or token under Query options if you need them. Leave records per request blank to use the layer maximum.
6. Click Download. Stop keeps the features already retrieved and lets you save or discard them.

## Example URLs

Here are public CORS-enabled ArcGIS REST endpoints you can test with:

- https://sampleserver6.arcgisonline.com/arcgis/rest/services/SampleWorldCities/MapServer (service with multiple layers)
- https://sampleserver6.arcgisonline.com/arcgis/rest/services/SampleWorldCities/MapServer/0 (paginated point layer, 2,232 features)
- https://sampleserver6.arcgisonline.com/arcgis/rest/services/WorldTimeZones/MapServer/0 (non-paginated layer using object IDs, 2,539 features)
- https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/3 (US counties polygons, 3,141 features)
