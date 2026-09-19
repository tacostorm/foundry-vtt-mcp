---
name: ambient-banter-pr-tracking
description: Status of the ambient-banter feature branch and the maintainer's PR conventions, for when this is ready to upstream
metadata:
  type: project
---

## What this branch is

`feature/ambient-banter` (already pushed to origin, tip was `33d7220` before this work)
adds an ambient background-NPC-chatter system for the Blood Lords campaign (driven from
the sibling `bloodlords-campaign` repo, see that project's own memory for the runtime/
deployment picture). Built and iterated live against the real Oracle-hosted Foundry
server across several sessions.

## Tools added so far

- `create-chat-message` (pre-existing on the branch) — speak an in-character line as an
  actor. **Default delivery changed this session**: now bubble-only (floating speech
  bubble over the actor's placed token, nothing in the chat log) instead of always
  posting a ChatMessage. Pass `chatLog: true` for the old chat-log(+auto-bubble) behavior.
  Bubble-only requires the actor to have a placed token on the current scene (works fine
  with `hidden: true` tokens — hidden only affects visibility/rendering, not whether
  `getActiveTokens()` resolves the token).
- `get-ambient-banter-state` (pre-existing) — reads a scene's enabled-participant roster,
  the raw `/banter` director's-note log, and a rolling transcript flag, for a calling loop
  to decide what happens next.
- `play-banter-script` (added this session) — posts a whole pre-authored sequence of lines
  with real per-line `delayMs` timing in one call, for a choreographed bit (setup line +
  group punchline) that a single ambient-banter "beat" is too slow/coarse for. **Reuses the
  existing `createChatMessage` module-side query in a loop rather than adding a new query
  handler** — deliberately mirrors the "reuse an existing handler" pattern from PR #85
  rather than growing the module-side surface for something that's really just
  orchestration.

Confirmed learned pacing convention (user feedback, now also saved in the
bloodlords-campaign memory as `banter_script_timing`): ~8000ms minimum between any two
lines that are separate conversational beats; 0ms only between lines meant to land as a
single unison moment. The 8s floor applies to the gap immediately before a unison group
too, not just between sequential individual speakers.

## Maintainer's PR/commit conventions (reverse-engineered — no CONTRIBUTING.md exists)

Checked via `gh pr view` against merged PRs (#85, #94) since there's no written contributor
doc in the repo:

- Commit/PR titles: conventional-commit style (`feat:`, `fix:`, `chore:`), often with
  `(Closes #N)` / `(#N)` referencing an issue.
- PR body structure that shows up repeatedly: a short problem statement, one section per
  feature/tool group (bullet list: tool name + what it does), an **"Implementation notes"**
  section (which files changed and why, what patterns were reused), and a **"Testing"**
  section listing exact commands run (`npm run build -w ...`, `npm run typecheck`,
  `npm run test:mcp:schema`, `npm test` with pass count) plus a live-Foundry-testing
  narrative with concrete confirmed results, not just "tests pass."
- Explicit stated preference for a **small, deliberate tool surface** — PR #85 avoided a
  new top-level tool entirely by extending `manage-actors` with a `place` action ("matches
  the consolidation approach"); PR #94 introduced 5 new tools for a genuinely new capability
  domain (scene music + playlists) and called out in the PR description that the surface
  was "deliberately small... no new settings, no schema writes." Read: reuse/extend an
  existing tool when the capability is a natural extension of what it already does; a new
  top-level tool is fine for a genuinely new capability domain, but keep the count minimal
  and say so explicitly in the PR body.
- `module.json` version gets bumped as part of a release-worthy PR.
- PRs close with an invitation to adjust naming/validation "to house style."

## Cleanup done during full pre-session review (2026-09-17)

The original `33d7220` commit turned out to bundle two entirely unrelated changes
alongside the real banter work: a `tools/quest-creation.ts` journal-page rename+update fix
(**already merged upstream as PR #100** — and this branch's copy was actually incomplete,
missing the matching `data-access.ts` handler fix, so it would have reproduced the exact
bug #100 fixed) and a `webrtc-peer.ts` ICE-gathering-wait fix + unconditional debug SDP
logging (diagnostic scope creep, never exercised this session since testing used
WebSocket-Local-Only, not WebRTC). Both were reverted back to the fork's own pre-banter
baseline (verified `git diff origin/master` is empty for both files) and rebuilt/redeployed
locally. Also discovered and committed two features that had been sitting **uncommitted**
in the working tree this whole session (`play-banter-script`→`create-chat-message`
consolidation, `bubbleDurationMs`) — always check `git status`/`git diff --stat` before
calling a work session "done," don't assume every edit got committed along the way.

Ran the real test suite for the first time this session: `npm test` → 153/153 passing
(unchanged from before this branch existed — **zero new tests for anything added**),
`npm run typecheck` clean on both packages, `npm run test:mcp:schema` passes.

## What's left before this is PR-ready

- No automated tests exist yet for `tools/chat.ts` (`create-chat-message`,
  `get-ambient-banter-state`) or `data-access.ts`'s `padBubbleTextForDuration` — worth
  covering: the `lines`-vs-single-line union parsing, bubble-vs-`chatLog` branching, word-
  count/clamping math, and documenting the current "first active token wins" behavior for
  actors with multiple placed tokens (a pre-existing sharp edge in `findActorByIdentifier`/
  `getActiveTokens`, not introduced by this branch, but more load-bearing now).
- Still untested: whether a chat bubble on a `hidden: true` token is visible to a
  _non-GM/player_ client (only tested from the GM's own browser so far, where hidden
  tokens are always visible regardless). Worth checking before claiming bubble-only works
  for real player-facing sessions, not just GM-solo testing.
- `/banter start/add/remove/stop` roster-control sub-commands are still just a design
  (selected-tokens for the no-args path, `findActorByIdentifier`'s existing substring
  resolver for the named path) — **deliberately not built yet**, to avoid shipping
  untested roster-mutation code right before a live session. The GM's own private,
  unshipped macro is still the only way to set `participants` today. Build this calmly
  after, not under time pressure.
- This branch is still based on the fork's stale `origin/master`, ~20 PRs behind real
  `upstream/master` (added as a remote this session: `adambdooley/foundry-vtt-mcp`). A
  rebase onto real upstream should happen before actually opening a PR, separately from
  finishing the banter feature itself.
- `module.json` version not yet bumped.
- No PR description drafted yet — use the Gap/Feature-sections/Implementation
  notes/Testing structure above when it's time.
- Commits so far on this branch (none pushed to origin yet): `33d7220` (original banter
  tool add), `1f3f005` (play-banter-script + bubble-only default, since superseded),
  `49a6518` (this memory note), `33abea7` (revert libWrapper), and the just-committed
  consolidation + `bubbleDurationMs` commit.

## Future work / backlog (not started, post-launch)

Raised 2026-09-17 while scoping the multilingual-banter idea below; deliberately deferred
past tomorrow night's session per the code freeze. Three items:

1. **Polyglot-aware chat bubbles.** Bubble-only delivery (the default) never triggers
   Polyglot scrambling, because there's no real `ChatMessage` document for Polyglot's hooks
   to intercept - it just shows everyone the same plain text with a "(in necril)"
   annotation. The user's preferred fix (over always forcing `chatLog: true` for secret
   lines) is to make bubbles _themselves_ Polyglot-aware - likely hooking/intercepting
   Foundry's bubble rendering the way the reverted libWrapper patch did for duration, but
   for scrambling content per-viewer based on the viewing user's own character's known
   languages instead. Needs real design (Polyglot's own internals/hooks aren't something
   we've inspected yet) - this is what would make secret/exclusionary multilingual
   conversation mechanically real even in default bubble-only delivery.
2. **Character `languages` data model.** No Character file has a `languages:` field yet
   (vault-side, in `bloodlords-campaign`, not this repo). Needed for: picking the language
   two banter participants actually share instead of hardcoding Osiriani, letting a subset
   of participants exclude others who don't share a language, and a comedic
   doesn't-share-any-language failure beat. User specifically flagged this "may require
   pulling data from Foundry to populate" - i.e. reading each Actor's actual configured
   languages from their Foundry sheet (system-specific field, e.g. PF2e
   `actor.system.traits.languages`) rather than hand-authoring it twice. Check whether
   `get-character`/`get-character-entity` already expose this before building a new read
   path.
3. **Duplicate-actor/"mook" disambiguation.** E.g. six identical "Bandit" tokens around a
   campfire. Today's actor/token resolution (`findActorByIdentifier`,
   `getActiveTokens(false, false)[0]`) just picks the first match by name - no way to
   address "this specific one" of several tokens sharing an actor. Called out by the user
   for the case of players sneaking up on a group conversation before being noticed -
   probably needs token-id-based addressing (not just actor name) in `create-chat-message`,
   plus loop-reasoning changes for a stealth/noticing tension beat. This is also the same
   underlying gap flagged in the "What's left before PR-ready" section above re: the
   Crawling Hand swarm on the Bone Shards Hideout scene.
4. **Rebase this branch onto real `upstream/master`.** DONE 2026-09-19 on the local branch
   `feature/ambient-banter-rebased` (37 upstream commits absorbed, 0.8.4 base; the old
   pre-rebase state is kept locally as `backup/ambient-banter-pre-rebase`). Only one real
   conflict: `packages/mcp-server/src/backend.ts` tool registration/dispatch, where upstream
   had appended the playlist/music tools (#94) and we appended chat - resolved by keeping
   both. NOT related to #100. Gotcha worth remembering: replaying our old-base revert of
   `quest-creation.ts` onto the new base silently deleted upstream's own merged #100 fix (26
   lines) with no conflict - caught by diffing against `upstream/master` and fixed in a
   follow-up commit. Always check `git diff upstream/master --stat` after a rebase; the
   branch should be additive-only. After rebase: build, typecheck, 188/188 tests and the
   schema smoke test all pass. Still to do: push to the fork (nothing after `33d7220` is on
   GitHub yet), and split the `_claude_memory_backup/` note commits out of any upstream PR.
   **Deploy gotcha:** the module installed on the Oracle box has a manifest pointing at
   upstream's releases (`adambdooley/...`), so updating it through Foundry's UI installs
   upstream's zip and wipes the banter code. Deploy this fork's built `dist/` by scp instead
   (back up the remote `dist/` first), and do it together with the next local backend restart.
5. **Build out the `/banter` roster sub-commands** (`start`/`add`/`remove`/`stop`), per the
   design already worked out in conversation: `/banter start` with no arguments reads
   `canvas.tokens.controlled` (whatever's currently selected) and replaces the roster
   outright; `/banter add <name>` / `/banter remove <name>` reuse the existing
   `findActorByIdentifier` substring resolver for the named path, both also accepting the
   no-args selected-tokens form; `/banter stop` clears the roster (which also makes the
   Claude Code loop wind itself down within ~2 beats per `start-banter.md`'s existing
   fewer-than-2-participants logic). Anything else after `/banter` still falls through to
   today's freeform-directive-note behavior, unchanged. This is the fix for the still-open
   gap that nothing shipped in this module can actually populate `participants` -
   the GM's own private, unshipped macro is the only thing that can right now.
   Deliberately not built yet, same reasoning as the other items: avoid shipping untested
   roster-mutation code right before a live session.

## Related

Runtime/deployment details (SSH, WebRTC bridge, restart procedure for `backend.js` vs.
deploying `packages/foundry-module`'s `dist/` to the remote box) live in
`bloodlords-campaign/_claude_memory_backup/foundry_oracle_server.md`, not duplicated here.
