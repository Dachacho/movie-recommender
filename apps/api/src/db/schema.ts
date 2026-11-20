import { integer, pgTable, real, text, vector } from 'drizzle-orm/pg-core';

export const movies = pgTable('movies', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  releaseYear: integer('release_year'),
  overview: text('overview'),
  tagline: text('tagline'),
  runtime: integer('runtime'),
  genres: text('genres').array().notNull().default([]),
  keywords: text('keywords').array().notNull().default([]),
  director: text('director'),
  cast: text('cast').array().notNull().default([]),
  posterPath: text('poster_path'),
  popularity: real('popularity'),
  voteAverage: real('vote_average'),
  voteCount: integer('vote_count'),
  embedding: vector('embedding', { dimensions: 384 }),
  embeddingVersion: text('embedding_version'),
});

export type Movie = typeof movies.$inferSelect;
export type NewMovie = typeof movies.$inferInsert;
