/**
 * Coordinate + proximity-audio math for the ERLC (summer) map.
 *
 * The game reports world positions in Roblox studs. 1 stud ~= 0.28 meters.
 * Everything the UI shows the player is in meters.
 */

export const STUDS_PER_METER = 1 / 0.28;

/** Fully audible inside this radius. */
export const CLEAR_RADIUS_M = 50;
/** Volume fades to silence at this radius. */
export const MAX_RADIUS_M = 150;

/**
 * World bounds of the ERLC summer map in studs.
 * X grows to the east, Z grows to the south.
 * Tune these if marker placement drifts from the real map.
 */
export const MAP_BOUNDS = {
  minX: -1900,
  maxX: 1900,
  minZ: -1900,
  maxZ: 1900,
} as const;

/** Grid letters/numbers drawn over the map, like the in-game map grid. */
export const GRID_COLUMNS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export const GRID_ROWS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export type WorldPosition = { x: number; y: number; z: number };

/** Convert a world position to 0..1 coordinates on the map image. */
export function worldToMap(pos: WorldPosition): { u: number; v: number } {
  const { minX, maxX, minZ, maxZ } = MAP_BOUNDS;
  const u = (pos.x - minX) / (maxX - minX);
  const v = (pos.z - minZ) / (maxZ - minZ);
  return { u: clamp01(u), v: clamp01(v) };
}

/** Grid cell label, e.g. "D5". */
export function gridLabel(pos: WorldPosition): string {
  const { u, v } = worldToMap(pos);
  const col = GRID_COLUMNS[Math.min(GRID_COLUMNS.length - 1, Math.floor(u * GRID_COLUMNS.length))];
  const row = GRID_ROWS[Math.min(GRID_ROWS.length - 1, Math.floor(v * GRID_ROWS.length))];
  return `${col}${row}`;
}

/** Straight-line distance in meters between two world positions. */
export function distanceMeters(a: WorldPosition, b: WorldPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const studs = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return studs / STUDS_PER_METER;
}

/**
 * Volume for a voice stream at a given distance.
 * 1 inside the clear radius, then an ease-out curve down to 0.
 */
export function volumeForDistance(meters: number): number {
  if (meters <= CLEAR_RADIUS_M) return 1;
  if (meters >= MAX_RADIUS_M) return 0;
  const t = (meters - CLEAR_RADIUS_M) / (MAX_RADIUS_M - CLEAR_RADIUS_M);
  return clamp01(Math.pow(1 - t, 1.8));
}

/**
 * Stereo pan (-1 left .. 1 right) of `other` relative to `me`.
 * Uses raw world axes, since the game does not report camera yaw.
 */
export function panForPositions(me: WorldPosition, other: WorldPosition): number {
  const dx = other.x - me.x;
  const dz = other.z - me.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1) return 0;
  return Math.max(-1, Math.min(1, dx / dist));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Freshness window: positions older than this are treated as offline. */
export const POSITION_STALE_MS = 30_000;

export function isFresh(updatedAt: string | Date): boolean {
  const t = typeof updatedAt === "string" ? Date.parse(updatedAt) : updatedAt.getTime();
  return Date.now() - t < POSITION_STALE_MS;
}
