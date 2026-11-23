import type { MovieCard, RecommendationRequest } from '@movie-recommender/shared';

/** Replaced picks are suppressed for seven days, never treated as disliked. */
export const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Mirrors the `excludeIds` limit in `recommendationRequestSchema`. */
export const MAX_EXCLUDE_IDS = 10_000;

/** Mirrors the `candidateIds` limit in `recommendationRequestSchema`. */
export const MAX_CANDIDATE_IDS = 10_000;

/** Ratings at or above four stars form the rewatch shortlist. */
export const REWATCH_MIN_RATING = 4;

/**
 * Interim "Surprise me" strength, pending held-out evaluation. The API draws
 * this fraction of the candidate pool from deep similarity ranks (beyond the
 * top taste matches), so picks can come from outside the usual neighborhood.
 * Pools too small to supply the deep rows fall back to the plain top pool.
 */
export const EXPLORATION_STRENGTH = 0.5;

/**
 * Where a round's picks come from. `rewatch` and `paste` are guest-facing
 * sources that ride the API's `list` source: rewatch candidates are the
 * guest's rated films, paste candidates are the imported list's matches.
 */
export type RecommendationSourceKind = 'catalog' | 'watchlist' | 'rewatch' | 'paste';

export type SourceSelection =
  | { kind: 'catalog' }
  | { kind: 'watchlist'; candidateIds: readonly number[] }
  | { kind: 'rewatch'; candidateIds: readonly number[] }
  | { kind: 'paste'; candidateIds: readonly number[] };

interface RequestBase {
  /**
   * Every rated movie id, uncapped. Used only for exclusions: rating a film
   * implies having seen it. Deliberately separate from the capped ratings
   * payload sent to `/taste`, which cannot stand in for this set.
   */
  ratedIds: readonly number[];
  watchedIds: readonly number[];
  tasteVector: readonly number[] | null;
  prompt: string;
  /** Defaults to the catalog. Pool sources carry their own candidate ids. */
  source?: SourceSelection;
  /** Omitted unless the guest turned on "Surprise me". */
  exploration?: number;
}

export interface RoundRequestInput extends RequestBase {
  cooldownIds?: readonly number[];
}

export interface RecommendationRequestResult {
  request: RecommendationRequest;
  /** Exclusion ids that did not fit the 10,000-id cap, sorted ascending. */
  droppedIds: number[];
  /** Candidate ids dropped from the pool by the same cap, sorted ascending. */
  poolDroppedIds: number[];
}

export interface ReplacementRequestInput extends RequestBase {
  /** Every pick currently on screen, including the one being replaced. */
  visibleMovieIds: readonly number[];
  replacedMovieId: number;
  /** Active guest cooldowns, already filtered by the profile. */
  cooldownIds: readonly number[];
}

export interface RefreshAllRequestInput extends RequestBase {
  visibleMovieIds: readonly number[];
  cooldownIds: readonly number[];
}

function uniqueSortedIds(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function requestSource(source: SourceSelection): RecommendationRequest['source'] {
  switch (source.kind) {
    case 'catalog':
      return 'catalog';
    case 'watchlist':
      return 'watchlist';
    case 'rewatch':
      return 'list';
    case 'paste':
      return 'list';
  }
}

/**
 * The rewatch shortlist: every film the guest rated four stars or higher,
 * deduplicated and sorted ascending. The request builder applies the
 * endpoint's 10,000-id limit and reports what it trimmed.
 */
export function rewatchCandidateIds(
  ratings: readonly { readonly movieId: number; readonly rating: number }[],
): number[] {
  const ids = new Set<number>();

  for (const { movieId, rating } of ratings) {
    if (rating >= REWATCH_MIN_RATING) {
      ids.add(movieId);
    }
  }

  return [...ids].sort((left, right) => left - right);
}

/**
 * Builds a request from one round's taste data. Exclusions are capped at the
 * endpoint's 10,000-id limit (`recommendationRequestSchema`):
 *
 *   1. visible + replaced ids, unconditionally. They are at most five ids and
 *      a pick must never be dropped from its own exclusion list.
 *   2. rated ids, lowest first (catalog and watchlist only).
 *   3. watched ids, lowest first (catalog and watchlist only).
 *   4. active cooldowns, lowest first.
 *
 * Re-watch candidates are themselves rated films, so excluding rated ids would
 * empty the pool. A rewatch round therefore excludes only visible/replaced ids
 * and cooldowns; `candidateIds` already bounds everything else.
 *
 * Classes 2-4 fill the remaining room lowest-first. Ids that do not fit are
 * dropped from each class's own high-id tail and reported in `droppedIds`, so
 * trimming is never silent. The union never exceeds the cap. Pool ids beyond
 * the same cap are trimmed from their high-id tail and reported separately in
 * `poolDroppedIds`, because they mean "cannot be picked", not "may reappear".
 */
function buildRequest(
  base: RequestBase,
  requiredIds: readonly number[],
  cooldownIds: readonly number[],
): RecommendationRequestResult {
  const source: SourceSelection = base.source ?? { kind: 'catalog' };
  const normalizedCandidates =
    source.kind === 'catalog' ? null : uniqueSortedIds(source.candidateIds);

  if (normalizedCandidates !== null && normalizedCandidates.length === 0) {
    throw new Error(`candidateIds must not be empty for a ${source.kind} request.`);
  }

  const candidateIds =
    normalizedCandidates === null ? null : normalizedCandidates.slice(0, MAX_CANDIDATE_IDS);
  const poolDroppedIds =
    normalizedCandidates === null ? [] : normalizedCandidates.slice(MAX_CANDIDATE_IDS);

  const trimmedPrompt = base.prompt.trim();
  const excluded = new Set<number>();
  const droppedIds = new Set<number>();
  const fill = (ids: readonly number[]): void => {
    for (const id of ids) {
      if (excluded.has(id)) {
        continue;
      }

      if (excluded.size >= MAX_EXCLUDE_IDS) {
        droppedIds.add(id);
        continue;
      }

      excluded.add(id);
    }
  };

  fill(uniqueSortedIds(requiredIds));

  if (source.kind !== 'rewatch') {
    fill(uniqueSortedIds(base.ratedIds));
    fill(uniqueSortedIds(base.watchedIds));
  }

  fill(uniqueSortedIds(cooldownIds));

  const excludeIds = [...excluded].sort((left, right) => left - right);
  // The vector is sent only while the guest still has rated films to match.
  // This uses the uncapped rated ids, not the 500-entry taste payload.
  const tasteVector = base.ratedIds.length > 0 ? base.tasteVector : null;

  return {
    request: {
      source: requestSource(source),
      limit: 4,
      ...(candidateIds === null ? {} : { candidateIds }),
      ...(trimmedPrompt === '' ? {} : { prompt: trimmedPrompt }),
      ...(tasteVector === null ? {} : { tasteVector: [...tasteVector] }),
      ...(excludeIds.length === 0 ? {} : { excludeIds }),
      ...(base.exploration === undefined ? {} : { exploration: base.exploration }),
    },
    droppedIds: [...droppedIds].sort((left, right) => left - right),
    poolDroppedIds,
  };
}

/**
 * Pure assembly of one round's request. `ratedIds` is the full rated id set,
 * so a film rated outside the taste endpoint's 500-rating payload is still
 * excluded; the taste vector comes from that payload and is omitted when the
 * guest has no rated films. Active cooldowns keep replaced films out for seven
 * days.
 */
export function buildRecommendationInput(input: RoundRequestInput): RecommendationRequestResult {
  return buildRequest(input, [], input.cooldownIds ?? []);
}

/**
 * Replaces one visible pick. Every visible pick is excluded along with the
 * rejected one, the active cooldowns and the usual rated/watched ids, so the
 * rejected film and its neighbours cannot come back in the same round.
 */
export function buildReplacementInput(input: ReplacementRequestInput): RecommendationRequestResult {
  return buildRequest(input, [input.replacedMovieId, ...input.visibleMovieIds], input.cooldownIds);
}

/**
 * Refresh all is a full round change: every currently visible pick is
 * treated as "not tonight" and excluded, together with earlier cooldowns and
 * the usual rated/watched ids. The caller cools the visible picks after the
 * new response arrives, so a failed refresh leaves the screen untouched.
 */
export function buildRefreshAllInput(input: RefreshAllRequestInput): RecommendationRequestResult {
  return buildRequest(input, input.visibleMovieIds, input.cooldownIds);
}

/**
 * A replacement changes exactly one slot: the first movie of the response
 * takes the rejected slot, further movies are discarded because the other
 * picks must not move, and an empty response removes the slot so the screen
 * shows fewer picks when the pool is exhausted. An out-of-range index, which
 * can only follow a concurrent merge, appends instead of overwriting.
 */
export function mergeReplacement(
  currentMovies: readonly MovieCard[],
  index: number,
  newMovies: readonly MovieCard[],
): MovieCard[] {
  const replacement = newMovies.slice(0, 1);

  if (index < 0 || index >= currentMovies.length) {
    return [...currentMovies, ...replacement];
  }

  return [...currentMovies.slice(0, index), ...replacement, ...currentMovies.slice(index + 1)];
}
