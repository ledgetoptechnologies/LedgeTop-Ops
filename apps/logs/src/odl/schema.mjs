// The OpenDroneLog backup layout this importer understands (observed November 2026, written by DuckDB).
// Required columns must be present; extra columns are tolerated and reported as warnings.

export const ODL_TABLES = {
  'flights.parquet': {
    required: true,
    columns: ['id', 'file_name', 'display_name', 'file_hash', 'drone_model', 'drone_serial', 'aircraft_name', 'battery_serial',
      'start_time', 'end_time', 'duration_secs', 'total_distance', 'max_altitude', 'max_speed', 'home_lat', 'home_lon',
      'point_count', 'photo_count', 'video_count', 'imported_at', 'notes', 'color'],
    optional: ['cycle_count', 'rc_serial', 'battery_life'],
  },
  'telemetry.parquet': {
    required: true,
    columns: ['flight_id', 'timestamp_ms', 'latitude', 'longitude', 'altitude', 'height', 'speed', 'pitch', 'roll', 'yaw',
      'battery_percent', 'battery_voltage'],
    optional: ['vps_height', 'altitude_abs', 'velocity_x', 'velocity_y', 'velocity_z', 'gimbal_pitch', 'gimbal_roll', 'gimbal_yaw',
      'battery_current', 'battery_temp', 'cell_voltages', 'flight_mode', 'gps_signal', 'satellites', 'rc_signal', 'rc_uplink',
      'rc_downlink', 'rc_aileron', 'rc_elevator', 'rc_throttle', 'rc_rudder', 'is_photo', 'is_video', 'battery_full_capacity',
      'battery_remained_capacity'],
  },
  'flight_messages.parquet': { required: false, columns: ['flight_id', 'timestamp_ms', 'message_type', 'message'], optional: [] },
  'flight_tags.parquet': { required: false, columns: ['flight_id', 'tag', 'tag_type'], optional: [] },
  'flight_customizations.parquet': { required: false, columns: ['file_hash'], optional: ['display_name', 'notes', 'color', 'manual_tags', 'updated_at'] },
  'keychains.parquet': { required: false, columns: ['file_hash', 'encryption_key'], optional: ['fetched_at'] },
  'equipment_names.parquet': { required: false, columns: ['serial', 'equipment_type', 'display_name'], optional: ['updated_at'] },
  // ODL's own migration and donation flags. Read for completeness, never imported.
  'settings.parquet': { required: false, columns: [], optional: ['key', 'value', 'updated_at'], ignored: true },
};

/** Validates file presence and column sets. Returns { errors, warnings } with plain-language messages. */
export function validateLayout(columnsByFile) {
  const errors = [], warnings = [];
  for (const [file, spec] of Object.entries(ODL_TABLES)) {
    const present = columnsByFile.get(file);
    if (!present) { (spec.required ? errors : warnings).push(`${file} is missing from the backup.`); continue; }
    const missing = spec.columns.filter(column => !present.includes(column));
    if (missing.length) errors.push(`${file} is missing column(s): ${missing.join(', ')}. This OpenDroneLog version isn't supported yet.`);
    const known = new Set([...spec.columns, ...spec.optional]), extra = present.filter(column => !known.has(column));
    if (extra.length && !spec.ignored) warnings.push(`${file} has new column(s) that will not be imported: ${extra.join(', ')}.`);
  }
  for (const file of columnsByFile.keys()) if (!ODL_TABLES[file]) warnings.push(`${file} is not a known OpenDroneLog table and will be ignored.`);
  return { errors, warnings };
}
