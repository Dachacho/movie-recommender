const HALF_STAR_POSITIONS = 10;

/** Maps one of the ten half-star zones (1-10) to a 0.5-5 rating. */
export function ratingFromHalfStarPosition(position: number): number {
  const steps = Number.isFinite(position)
    ? Math.min(Math.max(Math.round(position), 1), HALF_STAR_POSITIONS)
    : 1;

  return steps / 2;
}
