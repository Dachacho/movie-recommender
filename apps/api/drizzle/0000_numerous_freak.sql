CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "movies" (
	"id" integer PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"release_year" integer,
	"overview" text,
	"tagline" text,
	"runtime" integer,
	"genres" text[] DEFAULT '{}' NOT NULL,
	"keywords" text[] DEFAULT '{}' NOT NULL,
	"director" text,
	"cast" text[] DEFAULT '{}' NOT NULL,
	"poster_path" text,
	"popularity" real,
	"vote_average" real,
	"vote_count" integer,
	"embedding" vector(384),
	"embedding_version" text
);
