const HALF_STAR_POSITIONS = 10;

export type StarFill = 'empty' | 'half' | 'full';

/** Maps one of the ten half-star zones (1-10) to a 0.5-5 rating. */
export function ratingFromHalfStarPosition(position: number): number {
  const steps = Number.isFinite(position)
    ? Math.min(Math.max(Math.round(position), 1), HALF_STAR_POSITIONS)
    : 1;

  return steps / 2;
}

/** How much of a single star is filled for the given 0-5 rating. */
export function starFill(rating: number, star: number): StarFill {
  if (rating >= star) {
    return 'full';
  }

  if (rating >= star - 0.5) {
    return 'half';
  }

  return 'empty';
}
