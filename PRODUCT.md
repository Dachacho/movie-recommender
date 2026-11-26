# Movie recommender — product specification

## Goal
Remove the friction of choosing a movie. One click should yield one main pick and three alternatives. Aim for a decision within 60 seconds and a warm recommendation response within five seconds. Do not turn film discovery into a quiz or an AI film critic.

## MVP
- Responsive website; guest-first, persistent local profile. Optional accounts and guest migration after the core experience works.
- Three recommendation sources: entire catalog, personal watchlist, supplied Letterboxd list (URL only if permitted; otherwise CSV or pasted list contents).
- Optional natural-language direction and quick mood/runtime controls. No mandatory onboarding. Import Letterboxd CSV or supply initial preferences; allow immediate use without either.
- Show poster, title, year, director, runtime, spoiler-free synopsis and Letterboxd link when reliably resolved. Optional factual explanation; no fabricated match percentages.
- One main pick and three varied alternatives. Allow replacing one without changing the others, or refreshing all. Replaced movies are suppressed for seven days, not treated as disliked. Return fewer if the eligible pool is exhausted.
- Rate 0.5–5 stars, edit ratings, mark watched; exclude watched movies. Watchlist membership is not evidence of enjoyment. Explore outside usual taste and allow obscure or poorly rated films.
- Lightweight dashboard: ratings, watchlist, recommendation history and factual statistics. Import/export/delete profile data. Manual Letterboxd-compatible CSV export; no promise of direct sync.

## Out of scope
Streaming availability, native apps, browser extensions, mandatory quizzes, paid AI APIs, collaborative filtering, model training, social features. Direct Letterboxd integration is deferred pending permission and API eligibility.

## Success checks
Users can get a pick without signing in; imports are repeatable without duplicates; replacements respect cooldowns; hard filters are never violated; no fabricated movies. Compare held-out liked movies against popularity and genre baselines before adding recommendation complexity.
