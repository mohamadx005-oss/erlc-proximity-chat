/**
 * Coordinate + proximity-audio math for the ERLC SUMMER map (erlc-tools.com).
 *
 * The ER:LC server API reports Location.LocationX / LocationZ in in-game map
 * units (2 studs each). We convert them to world studs, then to summer map px.
 */

export const STUDS_PER_METER = 1 / 0.28;

/** Fully audible inside this radius. */
export const CLEAR_RADIUS_M = 15;
/** Volume fades to silence at this radius. */
export const MAX_RADIUS_M = 60;

/** Summer map tile pyramid (erlc-tools.com/map-tiles/summer/meta.json). */
export const SUMMER_MAP = {
  mapPx: 29700,
  tileSize: 990,
  maxLevel: 5,
  grid: [1, 2, 4, 8, 15, 30] as const,
  originX: -6112,
  originZ: -5472,
  pxPerStud: 2.75,
  tileUrl: (z: number, x: number, y: number) =>
    `https://erlc-tools.com/map-tiles/summer/z${z}/${x}_${y}.webp`,
} as const;

export type WorldPosition = { x: number; y: number; z: number };

/** ER:LC API Location -> world studs (summer expansion). */
export function apiLocationToWorld(locationX: number, locationZ: number): WorldPosition {
  return {
    x: 4641.842 - 2 * locationZ,
    y: 0,
    z: -5426.232 + 2 * locationX,
  };
}

/** World studs -> summer map pixels (map turned a quarter turn CCW). */
export function worldToMapPx(pos: { x: number; z: number }): { px: number; py: number } {
  return {
    px: (pos.z - SUMMER_MAP.originZ) * SUMMER_MAP.pxPerStud,
    py: SUMMER_MAP.mapPx - (pos.x - SUMMER_MAP.originX) * SUMMER_MAP.pxPerStud,
  };
}

/** Straight-line distance in meters between two world positions. */
export function distanceMeters(a: WorldPosition, b: WorldPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / STUDS_PER_METER;
}

/** 1 inside the clear radius, then an ease-out curve down to 0. */
export function volumeForDistance(meters: number): number {
  if (meters <= CLEAR_RADIUS_M) return 1;
  if (meters >= MAX_RADIUS_M) return 0;
  const t = (meters - CLEAR_RADIUS_M) / (MAX_RADIUS_M - CLEAR_RADIUS_M);
  return clamp01(Math.pow(1 - t, 1.8));
}

/** Stereo pan (-1 left .. 1 right) using screen/map east-west. */
export function panForPositions(me: WorldPosition, other: WorldPosition): number {
  const a = worldToMapPx(me);
  const b = worldToMapPx(other);
  const dx = b.px - a.px;
  const dy = b.py - a.py;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return 0;
  return Math.max(-1, Math.min(1, dx / dist));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export const POSITION_STALE_MS = 30_000;

export function isFresh(updatedAt: string | Date): boolean {
  const t = typeof updatedAt === "string" ? Date.parse(updatedAt) : updatedAt.getTime();
  return Date.now() - t < POSITION_STALE_MS;
}
