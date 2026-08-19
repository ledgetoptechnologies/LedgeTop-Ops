# 3D processing ground control workflow

The Ground control tab is part of the default-off 3D processing control plane. Ops obtains a short-lived Viewer administrative bearer in memory and then sends all GCP metadata and private dataset-image reads directly to `viewer.ledgetopdroneservices.com`. GCP bytes never pass through the Operations Worker.

The workflow lets an authorized operator:

1. Select a finalized reusable dataset and one of its processing tasks.
2. Import a documented `generic-csv-v1` or `generic-geojson-v1` GCP set (at most 2 MiB and 5,000 points).
3. Select a GCP on the satellite map or accessible point list.
4. Review dataset images ranked by indexed camera GPS proximity.
5. Inspect an image and record the GCP's pixel coordinates.
6. Correct or remove points and image marks without changing their stable IDs.

The UI always labels proximity results as suggestions. It never asserts that a nearby image contains or sees the selected target.

Canonical elevations, altitudes, and distances remain metric in Viewer. Ops uses the staff member's imperial-default or metric preference only for display. Raw source files, dataset images, GCP sets, and correspondences are administrative and are absent from all public-share and client-session contracts.

The exact generic schemas and administrative route matrix are documented in the Viewer's `docs/GCP_WORKFLOW.md`. The user-supplied Rome Dam Emlid all-columns export now anchors the `emlid-all-columns-v1` adapter: Name is the stable point identifier; CS name is required and consistent across rows; Easting, Northing, and Elevation are authoritative survey coordinates; Latitude and Longitude are cross-checks; ellipsoidal height remains distinct from the declared vertical datum. Metric and US-survey-foot systems are converted explicitly and ambiguous units require operator confirmation instead of being guessed.
