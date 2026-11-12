export function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return new Date(Number(value / 1000n)).toISOString(); // microseconds
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
