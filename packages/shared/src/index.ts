export * from './api.js';

export const RECOMMENDATION_SOURCES = ['catalog', 'watchlist', 'list'] as const;

export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];
