-- Optional, bounded GeoJSON scope selected by a client for a service request.
-- The Worker accepts only a validated single Polygon ring; no untrusted GIS
-- query or rendering input is executed from this column.
ALTER TABLE client_service_requests ADD COLUMN area_geojson TEXT;
