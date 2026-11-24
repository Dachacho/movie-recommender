# Coding agent instructions

Operating contract for coding agents on this project. PRODUCT.md defines what is acceptable; ARCHITECTURE.md records approved technical decisions; BACKLOG.md sets implementation order. ARCHITECTURE.md is canonical for stack, schema, API and data handling; this file restates only the constraints a subagent must see without reading it.

## 1. Before acting

- The orchestrator reads PRODUCT.md, ARCHITECTURE.md and BACKLOG.md before planning or any code change. Implementer subagents do not re-read those three documents unless the step needs a decision not already in the plan; they read the plan step, the files they touch, the constraints passed to them and the AGENTS.md sections relevant to the step. Reviewers also read the review workflow and the repository to verify file:line claims.
- Precedence: PRODUCT.md defines what is acceptable and outranks the rest; ARCHITECTURE.md decides how and outranks BACKLOG.md order and your preference.
- If a request conflicts with PRODUCT.md or ARCHITECTURE.md, stop and state the conflict instead of implementing around it.
- Check `git status` first. Treat uncommitted changes as the user's work: never revert, overwrite or reformat them.

## 2. Scope

- Work on exactly one backlog item (or one explicitly approved change) per unit of work. If the request maps to no backlog item, ask before starting.
- Check that earlier backlog items the feature depends on exist. Do not build on missing pieces; report the dependency instead.
- Stop and ask before any of:
  - adding a dependency, dev tool or service;
  - changing the database schema or a migration;
  - changing an API route, request or response shape;
  - changing the embedding model, weights, pooling or vector dimension;
  - assuming dataset columns, IDs, licenses, model compatibility or API capabilities;
  - implementing accounts, authentication or server-side guest persistence;
  - changing PRODUCT.md or ARCHITECTURE.md.
- No drive-by changes: no unrelated refactors, renames, formatting, dependency bumps or "while I'm here" fixes. List them in the final report instead.
- Prefer the smallest design that satisfies the acceptance criteria. No speculative abstractions, no interface with one implementation, no config for values used once, no new layer without an approved need.

## 3. Workflow

### Inspect

- Base every claim on inspected code, schema rows, logs or linked documentation. Cite paths and line numbers or record the actual data you observed.
- For dataset/model work, verify files, IDs, license, duplicates, dimensions and provenance directly; never trust README claims. Respect upstream data rights.
- Reuse existing modules, patterns and naming. Read a comparable module before writing a new one.

### Plan

- For non-trivial work, state before coding: approach, files to add or change, tests, material tradeoffs, and what is explicitly out of scope. Wait for approval when a stop-and-ask trigger applies. For multi-step work, list the intended commit series.
- For small, unambiguous changes, state the plan and implement in the same turn.
- Keep ranking math pure and deterministic: pure functions, explicit inputs, no I/O or hidden state.
- Start ranking, exploration, diversity and taste/prompt weights from ARCHITECTURE.md; tune only against held-out evaluation evidence and document the chosen values.

### Implement

- Follow the stack, layout and module boundaries in ARCHITECTURE.md. Shared request/response schemas go in `packages/shared`.
- TypeScript strict; explicit types at module boundaries; Zod validation at every external boundary (HTTP, CSV, IndexedDB, env). Parse once, then pass typed values.
- Validate guest input server-side: finite 384-d vectors, bounded ID arrays, upload size, CSV shape. Parameterize all SQL. Return structured errors and explicit empty results.
- Guest data stays in IndexedDB. The API only receives the transient per-request inputs defined in ARCHITECTURE.md (taste ratings, recommendation id arrays and vectors, catalogue lookups by movie id); none are logged or persisted.
- Never log personal ratings, imports or other guest data. Secrets come from env and are never committed.
- Code must pass the configured ESLint and Prettier rules. Fix the cause of a violation; never add `eslint-disable`/`@ts-ignore` or weaken the config to silence a check without approval.
- Do not invent match percentages or explanatory facts. Recommendation output must contain only real catalog movies.

### Test

- Complex or high-risk logic: test-first. Cover edge cases, failure paths and relevant invariants, such as invalid input, empty pool, filter violations, cooldown boundaries and zero-norm taste. Load `test-driven-development`.
- Ordinary features and UI behaviour: tests need not come first, but meaningful behaviour changes need appropriate automated tests.
- Trivial changes: documentation, styling-only changes and non-behavioural refactoring need no new tests.
- Bug fixes: add a regression test that reproduces the bug when practical, then verify the fix.
- Do not add low-value tests merely to satisfy a rule. Prefer meaningful coverage and correctness over test quantity.
- Unit-test pure math and selection logic against small committed fixtures; no network in unit tests. Use integration tests for API routes and DB access.
- Completion claims require fresh evidence from the relevant checks. Run them before reporting completion, report each exact command and its actual result, and list skipped tests separately rather than counting them as passed. The detailed evidence rules are in the review workflow below.

### Review

- Follow the review workflow at the end of this file. The writer always re-reads its full diff before reporting.
- Update BACKLOG.md status only after the definition of done is met. Change ARCHITECTURE.md only for an approved decision, and call it out in the report.

### Skills

The skill registry includes built-in skills such as `opencode` and `report` as well as the project-local skills in `.agents/skills/`. OpenCode advertises each description; load a skill when its description matches the task and the conditions below. PRODUCT.md, ARCHITECTURE.md, this file and the §2 approval gates override any skill; a skill never justifies a new dependency, schema change or scope expansion.

- **test-driven-development** — load for complex or high-risk logic: taste-vector math, ranking, diversity, filters, cooldown edges, CSV and list matching. Write the failing test first; cover edge cases, failure paths and relevant invariants. Ordinary features and UI behaviour need appropriate tests but not test-first; trivial changes need none. Bug fixes get a regression test when practical.
- **systematic-debugging** — load for every bug, failing test or unexpected result before proposing a fix. Find the root cause first. After three failed fixes, stop and raise the architectural question instead of trying a fourth.
- **verification-before-completion** — load before any claim that work is done or passing, and before the final report. Run the exact command, read the full output and state only what it proves. Reviewers check the supplied raw output instead, because their permissions deny shell.
- **receiving-code-review** — load when acting on reviewer findings: verify each finding against the code, push back with reasoning if it is wrong, and fix one item at a time.
- **frontend-design** — load when building or reshaping the recommendation screen, dashboard or other user-facing UI. Produce a short design plan (palette, type, layout, principles) before writing code, then stay within the approved plain-CSS stack and accessibility requirements.
- **apple-design** — load when adding or reviewing motion, gestures or interaction feel. It describes Apple's fluid-interface approach (springs, velocity, interruptibility) for the web: translate it to the existing plain CSS and Web Animations API, keep it under frontend-design's restraint rules (motion answers a user action, one orchestrated moment), and never treat it as grounds for adding an animation library.
- **writing-for-agents** — load when creating, editing or auditing AGENTS.md, agent definitions, skill definitions or other instructions agents read. Keep instructions minimal and point to detail rather than duplicating it.
- **find-skills** — load when a task is large, unfamiliar or likely to recur, or before building custom tooling. Search `npx skills find` or skills.sh, prefer maintained sources, and report the best candidate and why it fits. Do not search for small, routine work. If nothing relevant exists, proceed with the approved stack and say so. Installing requires approval and is always project-local: run `npx skills add <package> -y` after approval, never with `-g`.

## 4. Definition of done

- Requested behaviour works and failure paths are handled.
- Test coverage matches §3 Test; skipped tests are listed, not counted as passed.
- Lint, format check, typecheck and relevant tests pass (or failures are reported with output).
- No lint rule disabled, suppression comment added or configuration weakened without approval.
- No unapproved dependency, schema, API, architecture or embedding change.
- No unrelated diff, no secrets, no guest data in logs.
- Backlog status and any approved documentation update are done.
- Each commit unit is committed after its checks pass and any required review is clean; nothing is pushed without explicit approval.
- Final report delivered in the format below.

## 5. Final report format

Use these headings, kept brief:

- **Changed** — what the feature now does.
- **Files** — paths added or modified.
- **Tests** — commands run and their actual results.
- **Decisions** — choices made and why; flag any that need confirmation.
- **Open issues** — unresolved problems, risks or follow-ups.
- **Manual verification** — steps the user should run.
- **Commits** — hash, message and files for each unit committed; state that nothing was pushed.

## 6. Git workflow

- **Branching:** commit directly to `main`. No feature branches, no pull requests, no merge commits. For a genuinely risky change (e.g. a destructive migration), use a throwaway local branch and delete it afterwards; never leave stale branches.
- **Your role:** commit each unit yourself once its checks pass and any required review is clean; the user can review local commits afterwards. Report each hash. Never push without explicit approval.
- **Staging:** `git add` explicit paths only; never `git add -A`, `git add .` or `git commit -a`. Stage only files belonging to the change. Never stage unrelated user work, generated files, `.env` files or secrets. Shell permissions deny blanket adds and ask before `git push`; `git commit` is allowed for the orchestrator, while implementer subagents remain denied. Do not attempt to bypass these rules.
- **Unit:** the smallest coherent, independently revertable step. Never commit a whole backlog item at once; split it into a short series (for example workspace config → shared types → module with its tests → wiring). Each commit must leave the repo typechecking and passing relevant tests, even if the feature is not yet reachable. If a commit spans unrelated areas or would not revert cleanly, split it. Keep refactors and formatting separate. No WIP commits on `main`.
- **Staging order:** when work spans several commits, commit them in order as each unit passes checks and any required review. Stage explicit paths for the current unit only and never batch units into one commit. Report the planned commit series so nothing is lost.
- **Message format:**
  ```
  feat: add pure taste-vector calculation

  Explain why, note tradeoffs or follow-ups.
  Tests: npm test -w @movie-recommender/api
  ```
  Subject: `type: lowercase imperative summary`, at most 72 characters, no trailing period. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `schema`, `perf`. Body only when the diff is not self-explanatory, wrapped at 72. Reference the backlog item by name when it maps to one.
- **Attribution:** commits belong to the user. Never add `Co-authored-by`, "Generated with", an agent name, emoji or any AI credit to the message. Never pass `--author` or set `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
- **Identity check:** before committing, confirm `git var GIT_AUTHOR_IDENT` resolves to the user's name and email; after, verify with `git log -1 --format='%an <%ae>'`. If identity is unexpected, stop and report instead of committing.
- **History:** linear only. Do not amend or force-push commits that were already pushed. Do not add a remote or push without explicit approval.

<!-- review-workflow:start -->
## Review workflow
This section defines routing, implementation and review mechanics. PRODUCT.md, ARCHITECTURE.md and the §2 approval gates take precedence over it.

Commands:
- Build: `npm run build` (web only; API and shared have no build step)
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Format check: `npm run format:check`
- Test: `npm test` (all workspaces); `npm test -w @movie-recommender/api` or `-w @movie-recommender/web` for one. Database tests skip unless `DATABASE_URL` is set; use the value in `.env.example` whenever the step touches the database.

Routing:
| Class | Criteria | Flow |
| --- | --- | --- |
| SIMPLE | At most 20 changed lines and no logic or behaviour change: renames, copy, formatting, comments, docs. | Orchestrator plans inline without waiting for approval, implements, self-checks, runs the §4 checks and commits the unit. No independent review. |
| STANDARD | Any non-trivial change that is not HIGH-RISK. | Orchestrator plans and waits for approval; delegates each step to `implementer`; runs `reviewer` after each step; fixes BLOCKERs and re-reviews. |
| HIGH-RISK | Ranking/taste-vector math, diversity, filters, cooldown logic, vector search, data-transforming migrations, security-sensitive logic, or uncertainty between STANDARD and HIGH-RISK. | Same as STANDARD, but `reviewer-strict` replaces `reviewer`. |

- §2 approval gates apply at every class; HIGH-RISK only changes which reviewer runs.

Rules:
- Keep `plan` available for manual use. Do not invoke it automatically; the orchestrator plans in `build`.
- Split plans into small steps, each with one clear acceptance criterion and the files it will touch.
- Delegate planned implementation steps to `implementer`. Inline work is limited to SIMPLE changes.
- Reviewer models are configured in `.opencode/agents/reviewer.md` and `.opencode/agents/reviewer-strict.md`; use strict only for HIGH-RISK. Check the session and agent models before relying on independence: the configured build model is not proof. If the chosen reviewer shares the writer's actual model, ask the user for another independent reviewer.
- Code is never reviewed by the model that wrote it. The writer's self-check still runs; it is not a substitute for independent review.
- Reviewers receive only the plan step, the diff and the raw check output, never the full implementer session. They may read the repository to verify file:line claims; their permissions deny edit, shell, skills and subagents.
- Review checks: acceptance criterion, unrelated edits, invented columns or IDs, unvalidated input, unsafe SQL, guest data leaks, lint suppressions, stack drift and stale docs.
- Findings must have file:line and a label: BLOCKER, SHOULD-FIX or NIT. Findings without file:line are ignored. Skipped tests are not passed; list them.
- Fix every BLOCKER and re-review. A fix round is one attempt to resolve all open BLOCKERs. Stop and ask the user after 3 failed fix rounds or 2 review rounds with open BLOCKERs, whichever comes first.
- Act on reviewer findings using `receiving-code-review`: verify each finding against the code, push back with reasoning if it is wrong, and fix one item at a time.
- Use the configured reviewer agents for step reviews. Do not dispatch a general-purpose reviewer.
- Commit only after the required review passes. Never push without explicit approval.
- Keep sessions short. Compact or start a fresh subagent before the context gets to about 250K tokens.

A step is not done until §4 is met and the raw check output is shown.
<!-- review-workflow:end -->
