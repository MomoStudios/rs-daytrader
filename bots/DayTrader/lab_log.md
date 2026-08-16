# DayTrader Lab Log

## Architecture

DayTrader is a hybrid AI/automation system. A persistent GitHub Copilot SDK
session interprets conversation, infers demand, chooses long-term goals, and
selects one action from a fixed vocabulary. Deterministic TypeScript validates
every model response, executes reusable game skills, and remains the final
authority for inventory, pricing, blacklists, and both trade confirmation
screens. The model receives no tools and cannot access the shell, filesystem,
browser, or RuneScape SDK directly.

| Module | Responsibility |
| --- | --- |
| `lib/priceBook.ts` | Parses `wiki/items/*.md` "Value" fields once into `data/prices.json`; deterministic fair-value lookup (`getValue`, `estimateOfferValue`) used by every trade decision. |
| `lib/scamGuard.ts` | Pure heuristic classifier for scam / prompt-injection patterns in chat text. Never executes chat as instructions - only scores it. |
| `lib/chatMonitor.ts` | Classifies new chat lines (buying/selling/trade/market-question), extracts item-name guesses + price, runs scamGuard on every line, tracks the "last trade chat" silence timer, auto-blacklists high-risk senders. |
| `lib/tradeEvaluator.ts` | Profitability + safety gate for any trade offer (book value ratio + absolute profit floor); never gives unpriced items; `chooseCounterOfferItem` picks a safe item to counter with for reactive item-for-item swaps. |
| `lib/advertiser.ts` | Rotates direct / roundabout / open-ended ad templates; records send time + eventual response latency in `data/state.json` for future tuning. |
| `lib/economy.ts` | Bounded single-step idle actions (chop a tree / fish / mine / pick up a valuable ground item) so the main loop stays responsive to chat. |
| `lib/stateStore.ts` | JSON persistence (`data/state.json`): blacklist, ad history, last-trade-chat time, trade outcome tally. |
| `lib/logger.ts` | Append-only decision log (`data/decisions.jsonl`) for auditing every classification/decision without re-deriving it later. |
| `lib/aiBrain.ts` | Persistent tool-free Copilot strategist. Sends game state plus explicitly delimited untrusted chat and requires strict JSON. |
| `lib/aiConfig.ts` | Shared model policy: GPT-5.6 Luna at medium reasoning for strategist and operator. Override with `DAYTRADER_AI_MODEL` / `DAYTRADER_OPERATOR_MODEL`. |
| `lib/aiDecision.ts` | Runtime validation for goals, chat actions, and the allowlisted action vocabulary. Unknown actions/code/tool requests are rejected. |
| `lib/chatSafety.ts` | Output guard: freeform AI replies may discuss the market, but concrete prices, deposits, future delivery, and meeting promises require typed deterministic offers or are rejected. |
| `lib/skillLibrary.ts` | Reusable bounded progression executor: travel, tier-aware woodcutting, fishing, mining, firemaking, cooking, smithing, pickup, selling, and waiting. |
| `lib/strategyStore.ts` | Persists long-term goals, last model decision, and recent skill results across process restarts. Concrete actions are intentionally replanned after restart. |

## Session 1 (initial build)

### Goals
- Stand up the DayTrader bot end-to-end: headless connection, library
  modules, main loop, and verify it runs without crashing.

### Setup notes
- Installed `bun`, cloned `MaxBittker/rs-sdk` into this repo root.
- `bun run bots/DayTrader/script.ts` / `sdk/cli.ts` alone couldn't reach the
  demo server headlessly: `sdk/runner.ts` and `sdk/cli.ts` both set
  `autoLaunchBrowser: false` by design (standalone scripts expect a client
  already connected), and `BotSDK.launchBrowser()` opens a real system
  browser via the `open` package, which has no GUI here.
- Fix: use the project's own headless "lite" client
  (`server/webclient/src/lite/runner.ts`), which speaks the same gateway
  protocol as a browser tab but needs no rendering. Run once, keep it alive
  in the background:
  ```bash
  cd server/webclient && bun install
  bun src/lite/runner.ts DayTrader   # keep running (detached) as the "game client"
  ```
  Then normal `bun bots/DayTrader/*.ts` / `sdk/cli.ts DayTrader` control
  scripts connect to it exactly as they would a browser tab.

### Observations
- Fresh character starts with a small F2P starter kit (bronze axe,
  tinderbox, small fishing net, bucket, pot, bread, bronze pickaxe, etc.) -
  matches what `lib/economy.ts` assumes for its gather-priority order
  (trees > fishing spots > rocks).
- Demo server has other live bots (e.g. Cmmagic1, Kuroears, Dhjack,
  Alxjm1oepf) - real trade partners/targets, and real chat.
- 45s smoke test: main loop connected, chopped trees repeatedly as idle
  economy (no chat occurred during the window so advertiser/opportunity code
  paths weren't exercised yet - watch for that in a longer run).

### Next Steps
- Run longer sessions and watch `data/decisions.jsonl` for: chat
  classification quality (false positive/negative trade-relevance), scam
  flags, and whether the advertiser's templates actually produce responses.
- Tune `MIN_PROFIT_RATIO` / `MIN_ABSOLUTE_PROFIT_GP` in `tradeEvaluator.ts`
  if trades are too rare (too conservative) or unprofitable in practice.
- Consider adding a periodic bank-deposit step to `economy.ts` once
  inventory fills up, so gathering doesn't stall.

### Possible SDK Bugs or Improvements:
- None found yet - `bot.trade`'s confirm-screen re-verification and
  `serveTrades`/`waitForTradeRequest` primitives were exactly what a
  scam-resistant trading bot needs; no workarounds required.

## Session 2 (trade-completion tuning + bug fixes)

### Goals
- Get a full end-to-end trade (both sides exchanging items) to actually
  complete against a second bot ("TestBuyer", a throwaway account used only
  for testing - not part of the deliverable), and validate the reactive
  item-for-item swap path.

### Timing tuning
- `sdk.tradeWith` fails immediately (no retry) if it observes an "X is busy
  at the moment" refusal, but otherwise silently re-sends the trade request
  every 8s until its own timeout. `waitForTradeRequest`/`waitForChat` only
  see messages that arrive *during* the call - no retroactive backlog scan.
  Two independently-polling bots can therefore miss each other for a while;
  this mirrors real players getting "busy" replies rather than being a bug.
- Bumped `TRADE_REQUEST_POLL_MS` 4000ms -> 8000ms to better match the 8s
  re-request cadence.
- Added an "interested window" (`interestedUntil` / `STAY_AVAILABLE_MS` =
  45s) in `daytrader.ts`: whenever trade-relevant chat is seen or DayTrader
  sends a pitch, the main loop skips the multi-tick gather/pickup step for
  the next 45s so the character isn't "busy" chopping wood right when a
  trade request is likely to arrive.

### Bugs found & fixed
1. **Runaway busy-loop in `handleUnsolicitedTrade`** - once we'd already
   accepted a trade and were waiting on the partner to accept too
   (`decision.accept && current.myAccepted`), the loop fell through neither
   branch and spun with zero delay, logging `trade_decision` every
   microtask. Left running, this produced a **715 MB** log file and pegged
   a CPU core. Fixed by always waiting a couple of ticks when not taking a
   state-changing action, and by only emitting a log line when the
   decision/screen actually changes (dedup key), not every poll.
2. **Stale `knownDeals` re-offered a sold item** - after DayTrader sold its
   only Bronze dagger, the sender's chat-driven "buying bronze dagger" pitch
   stayed recorded in `knownDeals` for 10 minutes. A second incoming trade
   request from the same sender tried to re-fulfil that stale deal via
   `bot.trade`, which failed outright with "Item not found in inventory".
   Fixed in `handleIncomingTradeRequest`: a prearranged **sell** deal is now
   only honored if `sdk.findInventoryItem(deal.item)` still finds the item,
   and any prearranged deal is deleted from `knownDeals` the moment it's
   attempted (one-shot), so a stale/fulfilled/impossible deal falls through
   to the safe generic `handleUnsolicitedTrade` reactive path instead of
   failing.

### Verified end-to-end
- Chat -> pitch -> real trade: TestBuyer said "buying bronze dagger 15gp",
  DayTrader replied "@Testbuyer I've got a bronze dagger for 12gp, trade
  me!", TestBuyer opened a trade offering coins, DayTrader auto-accepted at
  the confirm screen once profitable, and the trade **completed**: gave
  Bronze dagger x1, received Coins x14. `data/state.json` recorded
  `tradesCompleted: 1`, `estimatedNetProfitGp: 4`.
- Confirmed the fixed decision loop no longer spams logs (115 lines for the
  whole session afterward vs. 715 MB before).
- Attempted the reactive item-for-item swap path (`handleUnsolicitedTrade`,
  no prior chat pitch) a second time; DayTrader had wandered away gathering
  wood by then and TestBuyer's script doesn't path-find over to it, so the
  trade request came back "Player not found nearby" - an artifact of the
  open-world/physical-proximity model (a real player would just walk over),
  not a bug in DayTrader's trade logic. The swap path itself (counter-offer
  selection via `chooseCounterOfferItem`, live re-evaluation each poll) is
  exercised by the same code path that was just proven correct for the
  coin trade, so it's considered logically validated even though a live
  successful item-for-item completion wasn't separately observed.

### Operational notes for running DayTrader long-term
- The headless lite client process **exits** (does not self-restart) if the
  game session ends (idle timeout, disconnect, etc.) - "re-login is the
  supervisor's job" per its own design. Likewise the main loop can throw on
  a `waitForTicks` safety timeout if the client connection goes stale.
- Added two small supervisor scripts that restart their child in a loop:
  - `bots/DayTrader/run-lite-client.sh` - keeps the headless game client
    connected.
  - `bots/DayTrader/run-main-loop.sh` - keeps `daytrader.ts` itself running.
  Run both (each in the background) for durable long-term operation:
  ```bash
  bash bots/DayTrader/run-lite-client.sh &
  bash bots/DayTrader/run-main-loop.sh &
  ```

### Known limitations / possible future work
- No path-finding/"walk to partner" logic - trades only complete when both
  parties happen to be within trade range, matching real player behavior
  but meaning a distant advertised deal may go stale before the buyer walks
  over. Not addressed since it mirrors real-world constraints rather than a
  bug.

## Session 3 (AI-in-the-loop redesign)

### Why the architecture changed
- Regex automation could only react to explicit buy/sell keywords. It could
  not answer a plain mention, infer demand from ambient conversation, or make
  a strategic progression plan.
- The fixed idle loop reached Woodcutting 73 while continuing to gather
  regular logs. That demonstrated the need for goal-level reasoning above
  reusable game actions.

### Planner/executor boundary
- Added `@github/copilot-sdk`; its bundled runtime uses the existing signed-in
  Copilot account. GitHub Models was not used (that service is retired).
- Copilot runs in SDK `mode: "empty"` with `availableTools: []`,
  config discovery disabled, session memory disabled, and every permission
  request rejected. It can only return text.
- The text must parse as the strict schema in `aiDecision.ts`: one goal, up to
  three chat actions, and exactly one action from a fixed enum.
- Raw safe chat is sent inside explicit `<untrusted_game_chat>` delimiters so
  the model can understand nuance. High-risk prompt-injection/scam messages
  are replaced with a withheld marker and signal categories before inference.
- Trade safety is not delegated to AI. Typed offer suggestions are checked
  against actual inventory, essential-tool policy, available coins, the price
  book, minimum margins, blacklist, and final live trade state. Generic AI
  replies cannot contain concrete prices, deposits, future-delivery promises,
  or meeting commitments.

### Live verification
- Embedded Copilot authentication and tool-free inference succeeded.
- A synthetic scene containing a direct mention plus ambient iron-armor
  demand produced a valid plan to answer the mention and acquire iron.
- Live TestBuyer message with no trade keyword:
  `DayTrader, why are you gathering logs? What are you working toward?`
  received a natural, goal-aware reply. This path was impossible in the old
  regex-only architecture.
- Ambient armor discussion changed the strategy toward iron acquisition,
  proving that non-addressed conversation is considered.
- The first smaller-model run exposed unsafe future-delivery/deposit language.
  Deterministic output guards were added and then observed rejecting every
  deposit, delivery, meeting, and unowned-item offer.
- With `claude-sonnet-5`, the live strategist recognized Woodcutting 73 was far
  beyond regular trees, liquidated the remaining low-tier logs, ignored a
  repeated ad as non-demand, and selected Draynor willows for higher-value
  stock. The deterministic executor then correctly overruled that choice
  because combat level 5 is unsafe near Draynor's dark wizards and redirected
  to safe oaks. That constraint was added to the strategist prompt so future
  plans should diversify into mining/smithing or fishing/cooking instead. On
  the next clean run Sonnet explicitly recognized the low combat constraint,
  declared oak chopping low-value, and selected travel to SE Varrock mine to
  begin the mining/smithing production chain. It arrived, changed the persisted
  goal to acquiring ore for smithing, selected `train:mining`, and successfully
  mined a tin rock—the first live non-woodcutting progression action.

### Validation
- Direct strict TypeScript check of all DayTrader files passes.
- DayTrader tests: 13 passed (schema, code/action rejection, output safety,
  deposits, essential tools, and destination coverage).
- Full repository checks: 226 passed, 0 failed.

### Current limitations / next reusable skills
- The action vocabulary currently covers the strongest documented low/mid-tier
  loops in this SDK repository. Full armor-set production, banking production
  chains, combat drops, herblore, and shop-supply purchasing should be added as
  deterministic skills before the model is allowed to plan them as executable
  actions.
- Model plans are strategic hypotheses, not guarantees. Unsupported goals can
  remain in persisted rationale, but impossible concrete actions fail closed
  and force replanning.
- Each planning call consumes Copilot usage. Calls are event-driven for new
  chat and otherwise limited to a two-minute strategic interval with a
  30-second failure/backpressure window.

## Session 4 (Terra market intelligence + collection mission)

### Model and scheduling
- The strategist was initially changed from Claude Sonnet 5 to GPT-5.6 Terra,
  then both strategist and operator defaults were standardized on the cheaper
  `gpt-5.6-luna` with `reasoningEffort: "medium"`. Luna availability and
  medium-reasoning support were verified through the Copilot SDK model catalog.
- Fixed a real scheduling bug: chat arriving during the 30-second model
  backoff was retained in memory but did not remain a planning trigger after
  that loop iteration. `pendingChatForAi` now remains true until a successful
  model decision consumes it, so cooldown-delayed chat cannot silently vanish.
- Added a pure `planningPolicy.ts` helper and regression tests for the deferred
  chat case.

### Explicit market reasoning and lead generation
- AI decisions now require `marketSignals[]` with demand/supply/offer/question,
  topic, participants, evidence, confidence, and strategic implication.
- Prompt policy now states that trade leads do not need to address DayTrader.
  Third-party referrals, indirect demand, smithing questions, and item-swap
  statements must be considered.
- Added a safe, independently rate-limited `discussion` action for proactive
  public market questions. It can run before the five-minute ad timer, but is
  still restricted to non-transactional language.
- The two reported missed examples were tested together offline. Terra
  extracted iron-bar barter, iron-armor demand, and smithing-service demand;
  replied to both relevant speakers with clarifying questions; changed the
  goal to Mining level 15; and selected mining.

### Permanent collection portfolio
- Added `collectionPortfolio.ts`, a persistent background mission separate
  from the current tactical goal.
- The initial reasonable F2P subset contains 33 targets:
  - all listed bronze and iron smithable armor pieces (16);
  - core production ingredients such as bronze/iron bars, leather, wool,
    bow string, and soft clay;
  - common gatherable stock such as logs, oak logs, copper/tin/iron ore,
    raw fish, cowhide, wool, flax, and feathers.
- Every target includes target quantity plus skill, location, prerequisites,
  acquisition method, and currently available automated prerequisite actions.
- `data/collection.json` records first observation and maximum quantity seen.
  Every AI observation includes current stock, discovered count, category
  progress, and prioritized missing items with acquisition guides.
- Market demand takes priority over arbitrary collection order; after an
  immediate lead is handled, the portfolio provides the long-term diversity
  objective.

### Production policy
- At user request, both DayTrader supervisors and the headless game client
  were stopped. No further verification was performed against the live server;
  all subsequent checks use unit tests and synthetic Copilot observations.

## Session 5 (second AI/operator execution layer)

### Two-AI hierarchy
1. **Strategist (Luna medium)** interprets market discussion, selects goals,
   prioritizes collection gaps, and handles operator escalations.
2. **Operator (separate Luna medium session)** turns the selected goal into
   day-to-day execution. It never receives public chat or player message text.
3. **Deterministic executor** validates and performs each operator directive.
   Existing trade safety remains outside both AIs.

### Operator workflows instead of arbitrary generated code
- The operator may generate a reusable versioned JSON workflow with 1-30
  bounded steps. This is the safe equivalent of creating a new mining/quest
  script without allowing runtime TypeScript, shell, `eval`, or SDK access.
- Supported directives include strategic skill actions, exact-coordinate
  walking, doors, NPC/location interactions, conversations/dialog choices,
  item-on-location, pickup, banking, shops, NPC combat, and bounded waiting.
- Every step has a measurable completion condition and maximum attempts.
  Reusable workflows are hashed and persisted in `data/workflows.json`.
- Active workflow cursor, retries, baseline, progress, and escalation persist
  in `data/operator.json`.

### Trusted execution knowledge
- `executionKnowledge.ts` retrieves relevant trusted repository docs from
  `wiki/` and `learnings/` based on the strategic goal/activity.
- This prevents generic model assumptions from overriding server-specific
  facts. For example, this server's mining wiki says Runite requires Mining 70
  and lists its actual notable locations.

### Watchdog and repair loop
- Every step snapshots position, floor, skills/XP, inventory, UI state, tick,
  revision, and nearby-player count before and after execution.
- Revision/tick churn alone is not progress. Meaningful progress requires the
  completion condition, movement, XP, inventory, or UI transition.
- The watchdog recognizes stale state, repeated failures, no progress,
  blocked UI, and possible resource competition.
- A stall calls the operator in diagnosis mode with the workflow and telemetry.
  Luna returns a replacement workflow or an escalation.
- A periodic five-minute operator audit compares the workflow with the current
  strategic goal even when actions appear to be succeeding.
- While an escalation is pending, the character waits and continues handling
  chat/trade polls instead of drifting into unrelated fallback gathering.

### Strategist feedback
- Operator status and pending escalations are included in strategist
  observations. Competition or impractical access can therefore produce:
  “This runite rock is continuously contested; should we wait, try another
  verified location, or pursue a different demanded resource?”
- A new strategist decision replaces the execution workflow.

### Offline model verification
- **Runite objective:** with Mining 40, Luna used trusted server docs to identify
  Mining 70 as the prerequisite and generated a reusable Mining-70 workflow.
- **Stuck gate:** after repeated path failures beside a visible Gate with an
  Open option, diagnosis inserted `open_door` before walking to the mine.
- **Competition:** after 12 no-progress runite attempts with six nearby players
  and no Mine option, Luna stopped the workflow and escalated to the strategist
  with defer/alternate-location/wait options.
- Both AI sessions default to GPT-5.6 Luna with medium reasoning.
- Production remained stopped throughout operator development and verification.

## Session 6 (local visual observer)

### Architecture
- Added `bots/DayTrader/observer/server.ts`, a localhost-only Bun server at
  `http://127.0.0.1:4317`.
- The left side embeds the server's real `/bot` browser client and therefore
  renders the actual RuneScape canvas. It is the single game client for the
  DayTrader account; the old lite client must not run simultaneously because
  the gateway permits only one bot/game session per username.
- The local server connects to the gateway as an SDK `observe` client. Observer
  mode receives state without pre-empting or fighting the main controller.
- The dashboard API binds only to `127.0.0.1`, uses no-store/nosniff/referrer
  headers, and removes raw chat text from audit events.

### Agent widgets
- Live character health, combat level, coordinates, inventory slots, and top
  skills.
- Strategist model, safe decision summary, tactical goal/rationale, next
  action, and explicit market signals.
- Operator safe summary, blockers, failures, escalations, current workflow,
  current step/attempt, and every declarative step.
- Collection portfolio coverage and recently observed holdings.
- Recent decision/action stream from `decisions.jsonl`.
- The page explicitly labels these as safe summaries, not private model
  chain-of-thought.

### Operation
```bash
bun run observe:daytrader
# or:
bash bots/DayTrader/run-observer.sh
```
Open `http://127.0.0.1:4317/` and keep that tab open. Closing the page closes
the visual game client; do not start `run-lite-client.sh` at the same time.
The main controller continues under `run-main-loop.sh`.

### Verification
- Observer server TypeScript check passed.
- Local API authenticated as an SDK observer and returned fresh DayTrader
  state without pre-empting the production controller.
- Browser validation confirmed the embedded RuneScape canvas, auto-login,
  live coordinates/skills, both agent panels, workflow progress, portfolio,
  and decision stream.

## Session 7 (observer information architecture + chat)

- Replaced the single scrolling wall of widgets with five focused tabs:
  Overview, Agents, Workflow, Chat, and Events.
- Overview keeps only character state and collection progress.
- Agents groups strategist, market signals, and operator status.
- Workflow dedicates the full panel to execution steps and attempts.
- Events isolates the audit stream.
- Chat uses the observer SDK's accumulated history (up to 250 messages) and
  includes game/system, public, private, and DayTrader's own messages.
- Chat rows show observer timestamp, sender, and readable wrapped text, with
  distinct styling for system and self messages.
- An unread badge increments while another tab is active and clears when Chat
  is opened. The chat panel remains bounded and auto-scrolls only when the
  human is already near the bottom, so manual reading is not interrupted.
- Browser verification confirmed the tab navigation and live chat list against
  production messages.

## Session 8 (human guidance + productive idle recovery)

### Trusted human guidance
- Added a persistent localhost guidance inbox at
  `data/human-guidance.json` (ignored by git).
- The observer has an always-visible compose box. `POST /api/instructions`
  validates and queues 1-1000 character instructions.
- Pending guidance forces a strategist planning pass even when the normal
  planning interval has not elapsed.
- Guidance is passed in a separate `<trusted_human_guidance>` block. It is
  explicitly distinct from adversarial game chat and has high strategic
  priority without bypassing trade or credential safety.
- After a successful strategist response, the instruction is marked applied
  with the decision summary. The Agents tab shows pending/applied status and
  that summary.

### Strategist → operator handoff
- Human guidance updates the strategist goal; the normal operator planning
  request then translates it into a bounded workflow.
- A new strategic decision clears the obsolete operator workflow before
  requesting its replacement, so invalid operator JSON can never leave stale
  work running.
- Failed operator diagnosis now clears its workflow and creates a deterministic
  escalation rather than silently continuing the broken steps.
- The periodic operator audit was moved out of an unreachable nested branch
  and now runs as designed.

### No indefinite inactivity
- Strategist instructions forbid indefinite inactivity and require productive
  capability building or escalation when a tool/route is blocked.
- Operator schema rejects workflows made solely of wait steps unless there is
  also an escalation.
- Live guidance `Character is stuck ... choose productive progression` replaced
  the repeated wait workflow with active recovery.

### Human-directed combat
- Added `equip_item` and skill-oriented `set_combat_style` directives.
- Operator receives equipped-weapon combat styles and trusted combat learning
  docs, allowing balanced Attack/Strength/Defence training.
- Live observer guidance requested Lumbridge goblins until all three melee
  stats reach 50 with gear upgrades.
- Strategist preserved the complete three-stat target. Operator generated a
  nine-step workflow, equipped Bronze sword and Wooden shield, selected the
  Defence style, and began attacking goblins. Defence rose from 1 to 7 during
  verification.

## Session 9 (concurrent chat/planning/execution scheduler)

### Why the loop changed
- The old loop began every iteration with an eight-second
  `waitForTradeRequest()`. Combat continued autonomously during that wait, so
  a goblin often died with 2-3 seconds left before the operator could select
  another target.
- Chat ingestion, trade listening, AI planning, and character execution do not
  need to share one blocking cadence.

### Event-driven architecture
- A state-update subscriber continuously drains ordinary chat and all type-4
  trade-request messages into independent queues.
- Multiple trade requests from one state batch are retained and deduplicated by
  requester rather than losing all but the first cursor match.
- Strategist and operator inference run in a background planning promise while
  the existing bounded workflow continues.
- The action lane remains serialized: only deterministic game execution sends
  character actions.
- Prepared plans are installed between bounded actions. If the character is in
  combat, the scheduler lets that fight finish first.
- Incoming trade requests have priority at the same safe boundary.
- New chat or human guidance arriving during inference invalidates the stale
  prepared plan before it can produce side effects, then immediately triggers
  a new planning cycle.
- Operator diagnosis remains tied to the installed workflow's planning context;
  preparing a future plan cannot corrupt current stall analysis.

### Combat cadence
- An `attack_npc` directive now behaves as a continuous combat unit: if already
  fighting, wait until that fight ends, recheck HP, immediately resolve a fresh
  safe goblin, and start the next attack.
- There is no fixed post-kill trade-poll delay. Attack start timestamps are now
  separated by actual goblin fight duration (roughly 10-12 seconds in the live
  run), with the next target acquired immediately after combat ends.
- Trade/chat observation continues during the fight through state callbacks.

### Live concurrency verification
- Submitted a no-op human guidance update during active goblin training.
- Combat attacks continued while both Luna sessions prepared replacement
  strategist/operator plans.
- The prepared plan installed at a fight boundary and immediately selected the
  new style and next target.

## Session 10 (omniscient development agent)

### Purpose and isolation
- Added a third independent Copilot process using GPT-5.6 Terra with medium
  reasoning.
- It has no model tools and cannot execute code, shell commands, SDK methods,
  or arbitrary file writes.
- Deterministic host retrieval gives it read-only evidence from the complete
  server content/scripts, engine implementation, wiki, learnings, and
  DayTrader framework.
- Its output is limited to validated findings, managed context notes, and
  existing-schema declarative operator workflows.

### Multi-hour game traces
- `gameTrace.ts` reads up to four hours / 4,000 recent events from the large
  JSONL audit log with a bounded 48MB reverse read.
- Traces include strategist conclusions, market signals, goals, operator plans,
  steps, stalls, escalations, trades/profit, errors, action success rates, and
  repeated failures.
- `character_trace` events periodically capture coordinates, HP/combat level,
  every skill/XP value, inventory, equipment, active combat target, and style.
- Raw game chat text is removed from development traces; strategist-derived
  market signals preserve relevant economic interpretation.

### Server-code research
- Development review is two-phase:
  1. Terra selects 1-12 literal research queries from trace failures/goals.
  2. Host-side `rg` searches trusted text sources and returns bounded
     path/line snippets before Terra produces the final review.
- Query schema has an automatic repair pass when Terra returns too many or
  malformed queries.

### Managed knowledge and workflows
- Evidence-backed notes are persisted in `data/development.json` with audience,
  topic, confidence, source refs, review ID, and active/superseded state.
- Active strategist/operator notes are injected into every corresponding AI
  planning context.
- Workflow proposals must pass the full operator schema and are stored in the
  existing reusable workflow registry.
- The development worker runs in its own supervised process every 30 minutes.
  Observer requests can queue an immediate review with an optional trusted
  focus prompt.

### Observer
- Added a Development tab showing Terra status, next/last review, trace window,
  review health/summary, evidence sources, findings, recommendations, and all
  active published knowledge.
- The Run review form supports optional prompts such as investigating a
  missing capability or evaluating equipment upgrades.

### Live reviews
- Initial periodic review found copper-targeting drift and recurring
  continuation-dialog stalls, then published explicit copper-rock and bronze
  smelting knowledge plus two workflows.
- An on-demand bronze-pickaxe/gear review found Bob's Brilliant Axes at
  `(3230, 3203)`, verified stock 5 and price 1 gp, and published the exact
  recovery route to both agents.
- The same review detected furnace interactions were too fast and published
  pacing/target-name guidance. It correctly declined an iron weapon upgrade
  because the account had only 50 coins versus documented prices of 91/112 gp.

## Session 11 (persistent account and strategy memory)

- Added `assets.json`: current inventory/equipment plus the last observed live
  bank snapshot and timestamp, with normalized combined holdings.
- Asset memory updates after every bounded action and whenever either AI builds
  context.
- Deposited ingredients remain visible to both agents. Live verification
  showed 19 banked Tin ore and 28 combined Tin while inventory held no tin.
- `strategy.json` now retains bounded goal history and aggregated market-memory
  signals with first/last seen timestamps and observation counts.
- Strategist instructions explicitly reconcile current inventory with banked
  holdings and preserve long production chains across prerequisite goals.
- Live verification completed 10 Bronze bars using banked tin, then advanced
  from the remembered bronze-production objective toward Smithing 15 and the
  retained iron-platebody demand.

## Session 12 (goal completion + reservations)

### Stale bronze-goal root cause
- The operator completed a ten-bar smelting workflow, but the strategist goal
  remained visible because a controller tick wait timed out at the completion
  boundary and no immediate completion replan was guaranteed.
- The active human guidance `smelt the bronze` was also marked applied but not
  resolved, so periodic plans kept treating it as binding.

### Deterministic completion gate
- Every new strategist proposal is checked before operator planning against
  combined inventory, equipment, last-known bank holdings, and current skills.
- Item names are plural-normalized and matched to account-wide holdings;
  leveling and wealth thresholds are checked directly.
- Already-complete goals are rejected, recorded in `completedGoals`, and force
  immediate replanning.
- Operator workflow completion now checks the previous current goal immediately
  and triggers replanning without waiting for the two-minute interval.
- Startup reconciles recent historical goals so achievements completed before
  this feature are recovered.
- Matching human guidance is moved from applied to resolved with completion
  evidence.
- All idle scheduler waits now catch stale/disconnect timeouts instead of
  terminating the controller at a goal boundary.

### Asset result
- Verification found the apparent combined total of 20 Bronze bars was real:
  ten remained banked from an earlier batch and ten had just been smelted into
  inventory.
- Startup reconciliation marked all already-satisfied bronze, iron, Mining, and
  Smithing milestones complete and resolved `smelt the bronze`.
- Strategist stopped requesting ten bronze bars and selected the next unmet
  portfolio milestone.

### Explicit smithing products
- Added `smith_product {product, bar}`, executed through
  `bot.smithAtAnvil(product, {barPattern})`.
- This replaces the broken pattern of using a bar on an anvil and being unable
  to select the smithing modal product.
- Live verification successfully forged Bronze med helm and Bronze full helm.
- Terra then published source-backed requirements: Bronze med helm uses one
  Bronze bar at Smithing 3; Iron platebody uses five Iron bars at Smithing 33.

### Material reservations
- Strategist decisions now include explicit item/count/purpose reservations.
- Reservations persist in strategic memory and are passed to the operator.
- Before installing a smithing workflow, deterministic policy estimates bar
  cost and rejects unrelated products that would reduce holdings below a
  reserved floor.
- A workflow fulfilling the reservation's stated product may consume it.

## Session 13 (typed player-trade handoff)

### Gap
- The deterministic main controller could handle incoming one-item deals, but
  strategist/operator schemas had no way to represent a staged multi-item
  outgoing sale.
- The development agent correctly reported “player trade fulfillment is
  unavailable to the operator.”

### Typed handoff
- Strategist decisions now include `tradeOrders[]` with a named recipient,
  exact item/count bundle, proposed price floor, and rationale.
- When all items exist account-wide, the scheduler deterministically compiles
  the order into an operator workflow rather than relying on model-generated
  boilerplate.
- Banked bundle items are staged with open/withdraw/close steps before trade.
- Added the bounded `trade_bundle_sell` directive.

### Deterministic safety
- Rejects blacklisted recipients, missing quantities, essential tools, and
  unpriceable items.
- Computes total book value and raises the strategist price to satisfy both the
  15% ratio and 5gp absolute-profit floors.
- Executes through `bot.trade` with exact give items and required coins, which
  rechecks the offer on both trade screens.
- Records profit and the full trade result through the existing state/logger
  path.

### Verification
- Synthetic strategist output produced a four-item Henryatkins bundle.
- Deterministic compiler generated bank staging plus atomic trade steps.
- Live execution withdrew Iron platebody, platelegs, full helm, and square
  shield and attempted the trade.
- The historical 150gp proposal was raised to **1,337gp** for a bundle valued
  at 1,162gp.
- Trade safely failed because Henryatkins was not nearby; the operator preserved
  and re-banked the reserved bundle instead of repeating blindly.
- Terra published replacement managed knowledge confirming player trading is
  now supported through `tradeOrders` and `trade_bundle_sell`.

## Session 14 (layered persistent-idle audit)

### Observed failure
- DayTrader remained near Lumbridge with a full 28-slot inventory.
- No operator workflow was active; fallback repeatedly called gather, which
  deterministically returned `inventory full, skipping gather` thousands of
  times.
- Strategist and operator Copilot sessions had closed, but runtime booleans
  still marked them available, causing repeated background-planning failures.
- Historical trace state conflated a stale trade interface ID with a furnace
  dialog because interface identity was missing from snapshots.

### Layer ownership and fixes

#### Development layer
- Correctly identified the capacity loop, stale UI reports, planner transport
  failures, generic mining targets, and provisional trade-result telemetry.
- Source retrieval now strips model-added quote wrappers from literal search
  queries.
- Character traces include interface ID, modal ID, dialog state, and live trade
  state so future reviews can identify UI ownership precisely.

#### Strategist layer
- Prompt policy now gates gathering/mining/fishing goals on free inventory or
  completed banking.
- Closed Copilot connections mark strategist/operator unavailable, stop the
  stale sessions, and are recreated with bounded retry delays.

#### Operator layer
- Full-inventory trade staging walks to the nearest validated bank, deposits
  non-bundle non-tool inventory to free slots, supports unequipping authorized
  equipment, then stages and trades.
- Schema temporarily permits one trade order only, avoiding silently discarded
  secondary orders.
- Named ore targets and respawn pacing replace generic `Rocks` interactions.

#### Executor/game loop
- Fallback detects 28 occupied slots and runs deterministic capacity recovery:
  walk to nearest bank, open it, deposit a non-essential stack, and close.
- Bob/open-shop discovery recognizes Bob and generic NPCs with a Trade option.
- Stale trade-main/confirm interfaces are declined only when no live trade
  session exists.
- Unsolicited trades count as completed only after observable inventory deltas;
  a closed session without exchange no longer records success/profit.
- Invalid all-zero snapshots are ignored by traces and asset memory.

### Live verification
- After reset, capacity recovery banked the carried ore and reduced inventory
  from 28 to 3 slots.
- Planner sessions restarted without new `Connection is closed` errors.
- Character moved from Lumbridge/Draynor to SE Varrock.
- Mining advanced from 78 to 79 and continued toward 80 with an active workflow,
  no failure, and no escalation.

## Session 15 (systemic-autonomy redesign: issue registry, workflow candidates,
maintenance worker, escalation ownership, execution feedback, supervisor)

### Motivation
An audit of the layered architecture found several systemic-trust gaps:
escalation was a single unowned JSON flag that silent resets could clear;
development-review workflow proposals and operator-produced reusable
workflows were written straight into the production workflow registry with
no validation lifecycle; development findings were logged but never became
trackable work; there was no path from "the development reviewer found a
real code-level problem" to a safely-bounded automatic fix; and DayTrader's
own TypeScript was outside the repo's typecheck/test gate entirely.

### Persistent registry (`bots/DayTrader/lib/registryDb.ts`)
- A single `bun:sqlite` database (`data/registry.sqlite`, WAL journal mode,
  5s busy timeout) coordinates every new lifecycle-tracked record type
  across the main loop, development reviewer, maintenance worker, and
  observer processes. JSON files (`operator.json`, `development.json`,
  `workflows.json`, ...) are untouched and remain the source of truth for
  existing consumers; the registry is additive.
- Every mutation goes through `withTransaction`, and corrupt/permission
  failures throw a descriptive `RegistryError` instead of silently falling
  back to an empty registry.

### Typed issue registry (`lib/issueRegistry.ts`)
- Lifecycle: `detected -> triaged -> repairing -> validating -> canary ->
  resolved | rejected | deferred | failed`.
- Fingerprinted dedup: a recurring detection of the same fingerprint merges
  evidence into the existing row; a detection against a previously
  resolved/rejected/deferred/failed fingerprint **reopens** it and
  increments `recurrenceCount` instead of creating a duplicate.
- Typed `ownerLayer` (`deterministic|operator|strategist|development|human`),
  `severity`, `category`, a severity-scaled `deadlineAt`, `attempts`,
  `resolutionEvidence`, and links to a related workflow/review.

### Workflow candidate lifecycle (`lib/workflowCandidateStore.ts`)
- `proposed -> statically_verified -> canary -> promoted | rejected |
  rolled_back`. Static verification re-parses the workflow (schema, bounded
  step count, duplicate step ids), and checks material-reservation
  compatibility when reservation context is available.
- **Neither the development reviewer's `workflowProposals` nor the
  operator's own reusable-workflow output is ever written directly into
  `workflows.json` (the production registry) any more.** Both go through
  `proposeWorkflowCandidate`; only `recordWorkflowCandidateOutcome`
  promoting a candidate after real canary successes calls
  `storeReusableWorkflow`. A failure after promotion rolls the workflow
  back out of production via `removeReusableWorkflow`.
- `operatorCoordinator.ts`'s `installDecision` is now the single path for
  both a fresh plan and a diagnosis repair; it proposes a candidate for any
  reusable workflow and records success/failure against the workflow's
  content hash as steps complete or a stall forces a replacement.
- Statically verified development proposals are exposed to the operator as
  canary workflow options. They remain outside `workflows.json` until real
  executions satisfy the promotion threshold.

### Development findings become typed issues (`lib/developmentIssueBridge.ts`)
- The development reviewer stays completely tool-free; it can only emit the
  bounded structured findings. Findings can explicitly identify
  `systemic_code` owned by `development`; `completeDevelopmentWork` maps
  each non-`success` finding through `findingToIssueInput` (pure, unit
  tested) into `recordIssue`, deterministically choosing `ownerLayer` from
  `finding.target` (`workflow` -> `development`, `observer` -> `human`,
  `strategist`/`operator` -> themselves).

### Maintenance worker: bounded, queued, non-LLM repair
  (`bots/DayTrader/maintenance/`)
- `workerContract.ts` is the **only** place a repair recipe is defined: an
  id, an exact allowlist of argv commands (never a shell string), a
  mandatory test command, a bounded path allowlist, a duration budget, and
  a deterministic (keyword/category, non-LLM) `matchesIssue` predicate.
  Only `category: 'systemic_code'` issues are ever eligible, and only when
  an approved recipe's predicate matches - everything else stays
  owned/deferred, never guessed at.
- `isolatedWorkerRunner.ts` runs a matched recipe inside a real, isolated
  `git worktree` (a throwaway branch off `HEAD`), with a restricted child
  environment (`PATH`/`LANG`/`TMPDIR` plus a fresh isolated `HOME` - no bot
  credentials or user credential stores). Mandatory tests must pass before anything is committed.
  The worktree is always removed afterward; the commit/branch survive only
  if a canary commit was produced. Recipes explicitly marked `autoPromote`
  are deployed by cherry-picking the inspected commit into a clean target,
  rerunning the mandatory verification, and recording the deployed revision.
  A failed post-deployment check automatically reverts the deployment.
- `maintenance/runner.ts` is a supervised process that periodically scans
  for open `systemic_code` issues with a matching approved recipe and runs
  them; issues without one are left alone entirely.
- Verified end-to-end against a real scratch git repository (not this
  checkout): isolated worktree creation, the allowlisted repair commands,
  mandatory tests, diff/commit, canary, promote, and reject all exercised
  with real `git` subprocess calls (see
  `test/isolatedWorkerRunner.test.ts`).

### Escalation ownership (`lib/escalationStore.ts`)
- Replaced "escalation as an unowned global flag" with an identified,
  tracked `category: 'escalation'` issue: owner layer, status, deadline,
  and resolution. `operator.json`'s `pendingEscalation` field still exists
  for backward-compatible JSON consumers (the observer dashboard, the main
  loop's "pause execution" guard) but only `escalationStore.ts` is allowed
  to set/clear it now.
- `resetOperatorWorkflow()` no longer clears `pendingEscalation` as a side
  effect (this was the audit's specific caution) - only workflow execution
  progress. Every place that installs a new plan/diagnosis explicitly
  acknowledges a prior pending escalation (`acknowledgeOperatorEscalation`)
  and/or raises its own (`raiseOperatorEscalation`).
- `checkOperatorEscalationTimeout()` runs every main-loop tick: an
  escalation whose deadline has passed is force-cleared and its issue is
  deferred to human review - it never blocks forever, and it never resumes
  the stalled workflow (which was already reset before the escalation was
  raised), so safety is preserved.

### Deterministic operator remediation before model diagnosis
  (`lib/operatorRemediation.ts`)
- A pure `decideRemediation(stall, remediationState, budgets)` routes each
  stall reason to a bounded deterministic action before any model call:
  `blocked_ui` -> bounded `dismiss_blocking_ui` attempts; `state_stale` ->
  bounded waits (the SDK's own `autoReconnect` does the actual
  reconnecting in the background - `getState()` never refreshes by
  itself); `possible_competition`/`no_progress` -> bounded wait+replan;
  `repeated_failure` -> a bounded number of model diagnosis calls before
  escalating. Attempt counters live on `OperatorRuntimeState.remediation`
  and reset whenever the stall reason changes.
- Reservation violations no longer throw inside
  `operatorCoordinator.installDecision` - they become a
  `category: 'reservation_violation'` issue plus a `policy_violation`
  escalation, so a bad plan is safely deferred instead of crashing the
  runtime loop.

### Execution feedback and metrics
  (`lib/executionFeedback.ts`, `lib/registryMetrics.ts`)
- Every workflow completion and every stall/remediation decision writes an
  `execution_feedback` row linking issue/workflow/step/directive/outcome/
  evidence.
- `computeRegistryMetrics()` aggregates mean issue resolution time,
  recurrence totals, overdue counts, human-intervention load
  (human-owned/deferred issues, escalations raised/timed-out), and
  workflow-candidate promotion rate.
- `gameTrace.ts`'s `buildGameTrace()` now includes a bounded, summarized
  `systemicIssues` list (open issues, most severe/oldest first) and
  `registryMetrics` in the trace fed to the development reviewer, so it can
  reference an already-tracked problem instead of re-reporting it.

### Observer API additions (`observer/server.ts`)
- New read endpoints: `GET /api/issues`, `/api/maintenance`,
  `/api/workflow-candidates`, `/api/metrics`, `/api/health`. `statusPayload`
  also carries bounded `issues`/`maintenance`/`workflowCandidates`/`metrics`/
  `health` sections.
- One new authenticated control endpoint,
  `POST /api/issues/:id/transition` (same `x-observer-token` + origin check
  as the existing instruction/review endpoints), for a human to
  triage/defer/resolve an issue.

### Unified supervisor (`bots/DayTrader/run-supervisor.ts` /
  `run-supervisor.sh`)
- Runs the lite client, main loop, development reviewer, and maintenance
  worker together, each with its **own** restart backoff: a run shorter
  than a per-child "fast failure" threshold doubles that child's restart
  delay (capped), while a longer clean run resets it - so a genuine
  crash-loop backs off instead of hammering the game server or model APIs,
  while a single transient failure still restarts promptly.
- `SIGINT`/`SIGTERM` are forwarded to every child; the supervisor waits up
  to 8s for clean shutdown before force-exiting.
- The existing individual scripts (`run-lite-client.sh`, `run-main-loop.sh`,
  `run-development-agent.sh`, `run-observer.sh`) are unchanged and still
  work standalone. `run-observer.sh` deliberately stays outside the
  supervisor (single-run dashboard process, by design).
- **Headless operation, including development services:**
  ```bash
  # Everything supervised together (recommended for unattended operation):
  bash bots/DayTrader/run-supervisor.sh &

  # ...or run each process individually, exactly as before:
  bash bots/DayTrader/run-lite-client.sh &
  bash bots/DayTrader/run-main-loop.sh &
  bash bots/DayTrader/run-development-agent.sh &   # development reviewer
  bun bots/DayTrader/maintenance/runner.ts &        # maintenance worker
  bun bots/DayTrader/observer/server.ts &            # optional dashboard
  ```
  The maintenance worker and development reviewer are both safe to omit for
  a minimal unattended run - the main loop and lite client alone still play
  the game; without the reviewer/worker, issues simply accumulate in the
  registry for later triage instead of being investigated/auto-repaired.

### Quality gate
- `bots/DayTrader/tsconfig.json` mirrors the root compiler options, scoped
  to `bots/DayTrader/**/*.ts` only (so `server/engine`/`server/webclient`'s
  own vendored code is never pulled into this typecheck just because
  DayTrader imports a few `sdk/*` types). `bun run typecheck:daytrader` is
  part of `bun run check`.
- `bun run test` now also runs `bots/DayTrader/test`.
- Fixed ~16 pre-existing `noUncheckedIndexedAccess`/possibly-undefined
  errors surfaced by adding DayTrader to the shared, stricter root
  compiler options (`advertiser.ts`, `chatMonitor.ts`, `economy.ts`,
  `priceBook.ts`, `stateStore.ts`, and one test fixture's implicit type).

### Testing approach
- All new SQLite-backed stores use an injectable `':memory:'` database
  (`registryDb._resetRegistryForTests`) and, where they also touch a JSON
  file or the append-only log, a redirected data directory
  (`workflowStore._setWorkflowsDataDirForTests`,
  `operatorStore._resetOperatorStateForTests`,
  `logger._setLogDataDirForTests`) so `bun test` never writes into the real
  `bots/DayTrader/data/` folder.
- The maintenance worker is tested end-to-end against a real, throwaway git
  repository (init/commit/worktree/diff/commit/rollback), not mocked -
  the only thing that's a stand-in is the recipe's *target* repo, not the
  git mechanics.
- The supervisor's backoff math is pure/exported and unit tested
  (`isFastFailure`, `computeRestartDelayMs`) behind an `import.meta.main`
  guard, so importing it for a test never spawns a real child process.

### Honest remaining constraints
- Only one automatic deterministic repair recipe (`regenerate-api-docs`)
  ships today; adding another recipe is a reviewed code change to
  `workerContract.ts`, not a runtime decision. Unsupported issues remain
  explicitly owned and visible rather than being falsely marked resolved.
- Workflow-candidate canary promotion currently requires the *live* bot to
  actually execute the workflow to completion twice (or once, if a lower
  threshold is passed) - there's no synthetic/simulated canary runner, so
  promotion happens at real gameplay speed.
- Escalation/issue coordination across processes still relies on
  operator.json's file-based cache for the hot `pendingEscalation` flag
  (the SQLite issue row is authoritative for lifecycle/ownership); this is
  consistent with the existing JSON-store pattern but means a process that
  never calls `loadOperatorState()` won't see a fresh escalation flag until
  it does.

## Session 16 (alive-but-inert main-loop diagnosis)

### Incident
- At 08:35 the strategist proposed consuming an Iron bar while account-wide
  holdings were exactly equal to the ten-bar reservation.
- The deployed `installPreparedPlan()` correctly rejected the workflow, but
  did so by throwing. `runScript()` disconnected the bot and returned.
- The strategist/operator Copilot sessions were not stopped on that exceptional
  callback exit. Their open handles kept Bun alive, so `run-main-loop.sh`
  observed a living PID and never restarted it.
- Main-loop events and character traces stopped immediately. The independent
  development reviewer continued every 30 minutes and repeatedly diagnosed
  workflow symptoms, but its trace had no process heartbeat proving that the
  executor itself had stopped.

### Architectural prevention
- The DayTrader callback now owns strategist/operator teardown in `finally`, so
  every exit closes retained model sessions and allows the process supervisor
  to observe termination.
- Main loop, development reviewer, and maintenance worker publish atomic
  runtime heartbeats with PID, phase, and timestamp.
- The unified supervisor applies process-specific startup grace and heartbeat
  age budgets. A child that remains alive without advancing is terminated and
  restarted with the existing bounded backoff.
- Development traces include all runtime heartbeats, allowing the reviewer to
  distinguish an execution defect from a dead executor and route future
  liveness incidents as systemic control-plane failures.

## Session 17 (removing the recipe-only constraint: autonomous development
   repair)

### Motivation
Session 15's maintenance worker was deliberately bounded to a human-authored
recipe allowlist: an issue without a matching recipe stayed owned/deferred
forever, even for `policy_gap`/`knowledge_gap`/`failure`/`upgrade` findings
that a human would never realistically hand-author a recipe for. An audit
found this meant most technical findings never got fixed at all - they just
accumulated in the registry. The fix is not "more recipes"; it's a
tool-enabled autonomous coding agent that is the *default fallback* whenever
no deterministic recipe matches, so unknown technical defects are never
deferred merely for lack of a pre-authored recipe. Deterministic recipes
remain a fast path (still zero-LLM, still fully bounded) for the handful of
problems worth hand-authoring one for.

### Routing: every technical finding is development-owned
  (`lib/developmentIssueBridge.ts`)
- Previously `findingToIssueInput` chose `ownerLayer` from `finding.target`
  (`strategist`/`operator` -> themselves, `observer` -> `human`). Now **every**
  non-`success` finding (`failure`/`policy_gap`/`knowledge_gap`/`upgrade`/
  `systemic_code`) is `ownerLayer: 'development'`, regardless of target. The
  original target is preserved as context (`[originally targeted at X]` in
  the description, `development_finding_target:X` in evidence) and still
  keeps the fingerprint distinct per target, but it is no longer an ownership
  decision - only the autonomous agent's own `requires_direction` outcome can
  re-route a *specific* issue to a human afterward.
- This bridge still never touches `category: 'escalation'` (raised directly
  by `escalationStore.ts` for strategic goal-choice questions - what to buy,
  whether to accept a trade). Repeated *technical* operator/strategist
  failures reach development the same way they always did: the development
  reviewer reads `registryMetrics`/`systemicIssues` from the trace and emits
  a finding, which this bridge now always routes to development.

### Autonomous coding agent (`lib/autonomousDevelopmentAgent.ts`)
- A second, separate Copilot session type from `DevelopmentBrain`: full
  built-in coding tools (`new ToolSet().addBuiltIn('*')`) instead of
  tool-free. `mode: 'empty'`, `workingDirectory` is one isolated git
  worktree, `baseDirectory` is a dedicated, git-ignored runtime directory
  under `data/copilot-autonomous-runtime/<workId>` (never shared with
  `DevelopmentBrain`'s own runtime dir). Model `gpt-5.6-terra`, with a safe,
  tested fallback chain (`pickAutonomousModel`) if it's unavailable in this
  environment; reasoning effort medium (configurable to high).
- No MCP servers, no config/instruction discovery
  (`enableConfigDiscovery: false`, `skipCustomInstructions: true`), no
  session persistence (`enableSessionStore: false`), no extensions
  (`requestExtensions: false`), and no user-input tool (`onUserInputRequest`
  is never supplied, which is what disables the `ask_user` tool entirely) -
  the agent must resolve technical uncertainty itself or report
  `failed`/`requires_direction`, never pause to ask a human how to write the
  code.
- `onPreToolUse`/`onPostToolUse`/`onPostToolUseFailure` hooks give an audit
  trail of every tool call (name, success/failure, timestamp) independent of
  the permission gate below.
- The agent's own final answer is untrusted prose until parsed as strict
  JSON (`lib/autonomousAgentSchema.ts`): `outcome` (`resolved|
  already_resolved|failed|requires_direction`), `summary`, `rootCause`,
  `testsRun`, `humanQuestion` (required only for `requires_direction`).
  `sendAndWait` is bounded to 15 minutes; `stop()` always disconnects the
  session and stops the client, even on error.

### Deny-by-default permission handler
  (`maintenance/autonomousPermissionHandler.ts`)
- Every permission request kind the runtime can raise is covered:
  `read`/`write` are approved only when the canonicalized path (symlinks and
  `..` traversal resolved via `realpathSync`, walking up to the nearest real
  ancestor for not-yet-created files) falls inside the isolated worktree and
  matches none of a blocked-pattern list (`.git`, `node_modules`, `bot.env`/
  `.env`, `bots/DayTrader/data`, credentials, private keys, `.ssh`, `.aws`).
  `mcp`/`url`/`memory`/`custom-tool`/`hook`/`extension-management`/`factory`/
  `extension-permission-access` are unconditionally denied. `shell` requests
  are allowlisted by parsed command identifier (`git status/diff/log/show/
  rev-parse`; `bun test`/`bun run`; `tsc`; `rg`/`grep`/`sed`/`awk`/`head`/
  `tail`/`cat`/`ls`/`find`/`pwd`/`wc`/`sort`/`uniq`/`diff`/`test`) - a single
  disallowed segment (chained via `&&`, substitution, etc.) rejects the
  whole request. `git push/fetch/pull/reset/clean/checkout/switch/rebase/
  merge/cherry-pick/commit`, `curl`/`wget`/`ssh`/`gh`/`npm install`/`bun
  install`, file-write redirection, `sudo`, process killing, environment
  dumping, and command substitution/`eval` are always denied.
  `managedApprovalRequired` and `requestSandboxBypass` are always denied (no
  interactive human is present to approve them). Pure functions
  (`evaluatePathAccess`, `evaluateShellRequest`, `decidePermission`) are
  fully unit-tested without a real Copilot session.

### Isolated autonomous worker lifecycle
  (`maintenance/autonomousWorkerRunner.ts`)
- Reuses the same `maintenance_work` table with `recipeId:
  'autonomous-development'` - atomic claim (`proposeMaintenanceWork` +
  `claimMaintenanceWork`), isolated `git worktree`/branch, issue transitioned
  to `repairing` with an incremented attempt count.
- The agent's outcome label is never trusted alone: the host independently
  runs `git status --porcelain` and only trusts what it actually finds.
  - `requires_direction` -> the issue is the *only* place ownership ever
    moves to `human` (`ownerLayer: 'human'`, `status: 'deferred'`,
    `resolutionEvidence` = the agent's exact `humanQuestion`).
  - `failed`, or `resolved`/`already_resolved` with **no actual diff** and a
    failing independent full gate -> bounded retry (see below); any partial
    diff a failed attempt left behind is discarded, never committed.
  - `resolved`/`already_resolved` with no diff and a *passing* independent
    `bun run check` -> resolved immediately with evidence citing the
    verification (nothing to deploy).
  - Any real diff -> mandatory validate -> gate -> commit -> `canary`
    pipeline: every changed/staged path is checked against a broad
    allow-by-default repository policy (blocks secrets/`bots/*/data/**`/
    `server/vendor`/private keys; allows ordinary repository code/docs/
    config), the patch is bounded (<=30 files, <=5000 changed lines), binary
    files and obvious secret/credential content patterns are rejected, `bun
    run check` (the same full gate as `bun run check` everywhere else in
    this repo) must pass, and only then is a commit made with an
    issue-linked message and the repository's standard Copilot trailer. The
    issue moves to `canary`, **not** `resolved` - deployment is separate.
- Verified end-to-end against a real, throwaway git repository (not this
  checkout) with a scripted/mocked agent (never a real model call) - see
  `test/autonomousWorkerRunner.test.ts`.

### Deploy/canary/rollback (`maintenance/autonomousDeployment.ts`)
- `deployAutonomousMaintenanceWork` re-validates the canary commit's paths,
  requires a clean live checkout, cherry-picks, and re-runs the full gate.
  Deployment success still does **not** resolve the issue: it records a
  structured `canaryOutcome` (deployed revision, original commit, baseline
  `lastDetectedAt`/`recurrenceCount`, a baseline registry-metrics snapshot,
  changed paths, and a bounded observation deadline) and requests a
  deployment reload.
- `evaluateAutonomousCanaries` runs every maintenance scan:
  - **redetected** (the issue's `lastDetectedAt` advanced past the baseline
    captured right before deployment - i.e. the same problem was observed
    again) or **regressed** (open *and* overdue issue counts both
    measurably worsened - a single noisy unrelated metric never triggers a
    rollback) -> immediate verified rollback;
  - inside the observation window with no regression -> wait;
  - window elapsed with a fresh main-loop heartbeat since deployment and no
    recurrence -> promote/resolve;
  - window elapsed but telemetry is inconclusive (no fresh heartbeat yet)
    -> extend the window boundedly (capped extension count), then promote
    anyway once extensions are exhausted - **never** ask a human for a
    purely technical/observability question.
- `rollbackAutonomousDeployment` runs `git revert --no-edit <deployed
  revision>` on the clean live checkout, re-verifies the full gate, reopens
  the issue for a bounded retry, and requests a deployment reload. A revert
  conflict on an otherwise-clean checkout (exceptional git state, not an
  ordinary technical failure) is logged loudly and left for the next scan to
  retry rather than silently discarded or falsely marked resolved.

### Deployment reload signal (`lib/deploymentReload.ts`)
- A tiny file-backed generation counter, bumped by every successful deploy
  or verified rollback. The main loop (`daytrader.ts`), the development
  reviewer (`development/runner.ts`), and the maintenance worker
  (`maintenance/runner.ts`) each capture their own startup generation and
  check for a newer one only *between* fully-completed iterations (after a
  review/scan/game-loop tick has already persisted, never mid-transaction),
  then exit cleanly (status 0) so the existing unified supervisor
  (`run-supervisor.ts`) restarts them with the freshly deployed code -
  exactly the same mechanism the supervisor already uses for crash
  restarts, just triggered deliberately instead of by accident.

### Human boundary and bounded retry (issue lifecycle + registry)
- `requires_direction` is reserved for exactly two situations: a missing
  credential/external-service authorization the agent cannot obtain in this
  environment, or an irreversible product/game-direction/policy decision.
  It is never used for ordinary technical uncertainty, a failing test the
  agent hasn't fixed yet, or running out of time - the system prompt says so
  explicitly, and the host cross-checks: a `failed` outcome (or an
  inconsistent `already_resolved` claim) always stays `ownerLayer:
  'development'`.
- `issues.next_retry_at` (additive SQLite column migration, applied on open
  so an existing database file upgrades without data loss - see
  `test/registryDbMigration.test.ts`) drives a bounded exponential backoff
  (`maintenance/autonomousRetryPolicy.ts`: 5 minutes doubling up to a 6-hour
  cap) keyed off the issue's accumulated attempt count.
  `listRetryReadyIssues()` returns exactly the development-owned `failed`
  issues whose backoff has elapsed; the maintenance scan reopens and retries
  them automatically. A technical issue that keeps failing is retried
  forever, increasingly slowly - it is never silently converted to a human
  the way "give up after N attempts" policies often do.

### Maintenance scan now covers every development-owned technical category
  (`maintenance/runner.ts`, `lib/issueRegistry.ts`'s
  `DEVELOPMENT_ELIGIBLE_CATEGORIES`)
- The scan loop's candidate query is no longer `category: 'systemic_code'`
  only; it now covers exactly the five technical categories the goal
  requires (`systemic_code`, `policy_gap`, `knowledge_gap`, `failure`,
  `upgrade`), always trying an approved deterministic recipe first and
  falling back to the autonomous agent. Each scan also: promotes
  auto-promotable deterministic-recipe canaries (unchanged), deploys
  not-yet-deployed autonomous canaries, evaluates every deployed autonomous
  canary, and reopens/retries backoff-ready issues - all before scanning for
  freshly detected work.

### Observer metrics (`lib/registryMetrics.ts`)
- `RegistryMetrics.autonomous`: `queued`, `awaitingDeployment`,
  `inObservation` (+ `nextCanaryDeadlineAt`), `rolledBack`, `awaitingRetry`
  (+ `nextRetryAt`), `totalAttempts` - tracked separately from deterministic
  maintenance work and from the pre-existing `humanIntervention` counters.
- `RegistryMetrics.humanIntervention.requiresDirectionPending`: development-
  owned technical issues re-routed to a human, tracked distinctly from
  `escalationsRaised` (strategic goal-choice questions) and from the
  general `deferredCount`. Exposed unchanged via the existing
  `GET /api/metrics` observer endpoint (no new route needed - it already
  returns the full `computeRegistryMetrics()` object).

### Testing approach
- The autonomous agent is never invoked for real in tests: every
  orchestration test (`autonomousWorkerRunner.test.ts`,
  `autonomousDeployment.test.ts`) injects a scripted `agentRun`/`spawn`
  function and exercises real `git` subprocesses against a throwaway
  scratch repository, exactly like session 15's deterministic-recipe tests.
- New dedicated test files: `autonomousPermissionHandler.test.ts` (path
  canonicalization/symlink/traversal/blocked-file and shell allow/deny,
  29 cases), `autonomousAgentSchema.test.ts`, `autonomousDevelopmentAgent.test.ts`
  (pure `pickAutonomousModel`/prompt-building), `autonomousRetryPolicy.test.ts`,
  `deploymentReload.test.ts`, `registryDbMigration.test.ts` (upgrading a
  pre-existing database file), `maintenanceRunner.test.ts`
  (`eligibleCandidates`), plus expanded `issueRegistry.test.ts` and
  `registryMetrics.test.ts` coverage for retry/backoff and the new
  `autonomous`/`requiresDirectionPending` metrics.
- `developmentIssueBridge.test.ts` was rewritten (not just extended) to
  assert the new routing behavior; the old target-based-ownership
  assertions no longer describe the system's behavior on purpose.

### Honest remaining constraints
- A `git revert` conflict during rollback (an exceptional, hopefully rare,
  git-state problem on an otherwise-clean live checkout) is logged loudly
  and left for the next scan to retry; it is not auto-resolved by any
  smarter recovery, since this repo's own commit history is out of scope for
  automatic mutation beyond the guarded cherry-pick/revert already
  implemented.
- The canary observation window's "fresh heartbeat" signal only checks the
  main loop's heartbeat. It is a reasonable proxy for "the system is alive
  and running the deployed code," but it does not (and cannot, without a
  real canary-execution harness like the one workflow candidates still lack
  from session 15) prove the *specific* fixed behavior re-executed
  successfully - only that nothing regressed the tracked registry metrics
  and the same issue wasn't redetected.
- Bounded extension count means an inconclusive canary is eventually
  promoted rather than rolled back purely for lack of telemetry; this
  trades a small risk of promoting an unobserved fix for the stronger
  guarantee that no autonomous repair waits on a human indefinitely.
- As with session 15's single deterministic recipe, the autonomous coding
  agent is the sole fallback; it is bounded by the same `bun run check`
  gate as every human contributor, but its actual fix quality is only as
  good as the model behind it in a given run - a `failed` outcome (with
  bounded retry) is the expected, safe result when it cannot converge on a
  correct fix within its time/tool budget.

## Session 18 (security audit hardening: closing the systemic gaps in
   session 17's autonomous pipeline)

### Motivation
An external design/security audit of session 17's autonomous development
pipeline found a set of concrete, exploitable-or-just-plain-wrong gaps: a
permission-handler fallback that could approve a chained forbidden command,
several places where the deterministic host silently trusted a spawn result
it never checked, a canary rollback signal that could be defeated by a
review simply re-citing old evidence, a control-plane gate resolved from
the very `package.json` an autonomous patch could rewrite, and no extra
scrutiny at all for a patch that modifies the safety machinery itself. None
of these were "the model behaved unsafely" - the deterministic host's own
code had to be fixed. This session works through the full list without
weakening the core promise: unknown technical issues still retry
automatically forever, and a *protected* technical change gets independent
review, never automatic human routing.

### Permission handler: fail-closed fallback, path/URL enforcement, tighter
  command policy (`maintenance/autonomousPermissionHandler.ts`)
- `evaluateShellRequest`'s old fallback (used whenever the runtime didn't
  hand back parsed `commandSegments`) mapped every `commands[]` entry onto
  the *entire* raw command text as if each were its own segment - so `git
  status && rm -rf /` with no segments would have evaluated `rm -rf /`'s
  identifier against the full string and could slip through. It now: (a)
  denies outright the instant the raw text contains any control/chaining
  operator (`;`, `&&`, `||`, `|`, `&`, a newline) and no segments were
  parsed; (b) even with segments present, denies if the raw text still
  looks chained but only one segment came back (a parser gap must fail
  closed, not silently approve); (c) the segment-less fallback now only
  ever approves **exactly one** parsed command whose `commands[].readOnly`
  is `true` **and** whose identifier is one of the bare read-only utilities
  - `git`/`bun` are never approved through this path at all, since their
  safety depends entirely on the subcommand, which the fallback cannot see.
- `possiblePaths`/`possibleUrls` (present on every real shell permission
  request, previously ignored entirely) are now enforced: any
  `possibleUrls` entry denies the whole request outright (no network,
  ever), and every `possiblePath` is resolved against `worktreeRoot` (never
  the host process's own `cwd`) and run through the same
  `evaluatePathAccess` blocked-pattern check reads/writes get.
- `awk`, `sed`, and `find` were removed from the bare-identifier allowlist
  entirely - no argv-safe mode was implemented for any of them, since each
  has a code-execution or in-place-mutation primitive (`awk`'s
  `system()`/`ENVIRON`, `sed -i`/`e`/`w`, `find -exec`/`-delete`/...). `bun
  test` is now bounded to repo-relative paths/a tiny safe flag set (no
  `-e`/`--eval`/`--preload`/`-r`/`--require`, no absolute paths, no `..`
  traversal); `bun run` is bounded to a fixed safe script set
  (`typecheck`/`typecheck:webclient`/`typecheck:daytrader`/
  `docs:api:check`/`check`) with **no** extra passthrough arguments
  accepted at all.

### Pinned, immutable verification gate (`maintenance/pinnedGate.ts`, new)
- Every gate run (worker pre-commit, deploy post-cherry-pick, rollback
  post-revert) used to be `[process.execPath, 'run', 'check']` - i.e.
  whatever `package.json`'s `"check"` script says *right now*, in the
  checkout the patch itself just modified. Since `package.json` is
  something an autonomous patch can rewrite, this meant a sufficiently
  malicious patch could redefine what "the gate" even checks.
  `pinnedGate.ts` replaces this with a fixed, four-step argv sequence
  (`tsc --noEmit` at the root, `-p server/webclient/tsconfig.json`, `-p
  bots/DayTrader/tsconfig.json`, then `bun test` over a fixed,
  existence-checked set of repo-relative test directories) built entirely
  from constants defined in this module - never read from any `scripts`
  field. The `tsc` binary itself always resolves from a stable "tool root"
  (the real repository checkout, guaranteed to have `node_modules`) even
  when the code under test lives in a brand-new, `node_modules`-less
  isolated worktree; only the working directory (and therefore which
  tsconfig/tests actually run) points at the code being verified.
- **Residual trust, stated plainly**: this still *executes* the target
  checkout's own source and test files with a real compiler and test
  runner. A patch cannot change *which* commands run or grant itself
  elevated privileges/credentials/network access while doing so (see
  below), but it necessarily can still influence what those pinned
  commands observe - that is unavoidable for any system that actually
  verifies a fix by running it. This is exactly why the diff/path/secret
  policy gate (`validateAutonomousChange`/`isDeployPathAllowed`) and, for
  protected paths, the independent patch review (below) both run **before**
  this gate, never after: known-dangerous paths and obvious secret-shaped
  content are rejected before a single pinned command ever executes a byte
  of the patch.

### Independent review for protected-path patches
  (`maintenance/protectedPaths.ts`, `lib/autonomousPatchReviewer.ts`,
  `lib/autonomousPatchReviewSchema.ts`, all new)
- A patch that touches `package.json`/any lockfile, anything under
  `maintenance/` (the entire autonomous control plane), the process
  supervisor, or the handful of `lib/` files just as load-bearing
  (`autonomous*.ts`, `deploymentReload.ts`, `issueRegistry.ts`,
  `maintenanceStore.ts`, `registryDb.ts`, `developmentIssueBridge.ts`,
  `registryMetrics.ts`) is now required to pass a **separate, independent**
  Copilot review session before the worker will ever commit it - never
  "ask a human instead." That reviewer session is brand-new and tool-free
  (`availableTools: []`, permission handler always rejects, exactly like
  `DevelopmentBrain`) - it never shares process memory or session state with
  the primary `AutonomousDevelopmentAgent` that authored the patch, and is
  given only the bounded diff text and changed-path list, never the
  checkout itself. Its answer is parsed the same strict-JSON way every
  other LLM output in this codebase is (`approved`/`summary`/`findings`,
  a rejection must cite at least one finding). A rejection - or the
  reviewer session itself failing to complete - is treated exactly like any
  other technical failure: `failForRetry`, issue stays `ownerLayer:
  'development'`, bounded backoff, never routed to a human.
- Why this can't be bypassed by the patch itself: the currently-running
  host process already has `protectedPaths.ts`/`autonomousPatchReviewer.ts`
  loaded into memory from *before* the patch was ever authored, and keeps
  calling that in-memory logic for the rest of its run regardless of what a
  patch writes to those files on disk - identical reasoning to why the
  pinned gate can't be bypassed by rewriting `package.json`. Both only take
  effect on the *next* process restart, by which point this exact
  mechanism already had to approve the patch that changed them.
- Ordinary (non-protected-path) patches never invoke this at all - the
  pinned gate plus the existing broad path/secret/size policy is enough for
  them, matching "for ordinary paths review optional."

### Typed `requires_direction`, with a host-side credibility check
  (`lib/autonomousAgentSchema.ts`, `maintenance/autonomousWorkerRunner.ts`)
- `AutonomousAgentResult` gained a mandatory `directionKind: 'credentials' |
  'external_authorization' | 'irreversible_policy' | null` - required
  (non-null) whenever `outcome === 'requires_direction'`, and rejected as
  malformed if present for any other outcome. This alone stops
  `requires_direction` from being an open-ended "I'm not sure" escape
  hatch.
- The host additionally runs `assessDirectionRequestCredibility` before
  ever re-routing an issue to a human: a lightweight keyword-plausibility
  check that the `humanQuestion`/`summary` actually read like the declared
  `directionKind` (e.g. a `'credentials'` request should mention a
  credential/API key/token, not "this bug is just hard"). Anything
  malformed, or "well-formed but not credible" (ordinary technical
  uncertainty wearing a `requires_direction` label to dodge the "keep
  retrying" instruction), is now treated as an ordinary technical failure -
  `failForRetry`, never `ownerLayer: 'human'`.

### Evidence-occurrence tracking, not mere reprocessing time
  (`lib/issueRegistry.ts` + `last_evidence_at` migration,
  `lib/developmentIssueBridge.ts`, `maintenance/autonomousDeployment.ts`)
- The canary rollback signal used to be "did `lastDetectedAt` advance past
  the pre-deploy baseline" - but `recordIssue()` bumps `lastDetectedAt` on
  *every* re-detection, even when a development review simply re-emits the
  exact same historical trace evidence it already cited before the deploy
  ever happened. That is a false "this recurred" signal, not a real one.
- `issues.last_evidence_at` (additive migration, alongside `next_retry_at`)
  tracks the newest *evidence-occurrence* timestamp ever cited for an
  issue - `developmentIssueBridge.ts` derives it from any 13-digit
  (epoch-ms) run found in the finding's own `evidenceRefs`
  (`extractLatestEvidenceTimestamp`), falling back to the review's own
  `traceWindow.endTs` (always a fresh, just-captured timestamp) only when
  the finding cites no timestamp of its own. `recordIssue()` only ever
  advances it to a genuinely newer value (or resets it fresh on a terminal
  reopen) - never regresses, never bumps on mere reprocessing.
- The canary outcome now captures `baselineLastEvidenceAt` alongside
  `baselineLastDetectedAt`; `wasIssueRedetectedAfterDeployment` prefers
  `lastEvidenceAt > deployedAt` whenever an evidence timestamp exists,
  falling back to the coarser `lastDetectedAt`-vs-baseline signal only for
  issues/producers that never populate `evidenceAt` at all.

### Reopening restores ownership; never promote without a fresh heartbeat;
  no starvation in the canary/metrics queries (`lib/issueRegistry.ts`,
  `lib/maintenanceStore.ts`, `lib/registryMetrics.ts`,
  `maintenance/autonomousDeployment.ts`, `maintenance/runner.ts`)
- `recordIssue()` reopening a terminal issue (e.g. one a prior
  `requires_direction` outcome had deferred to `ownerLayer: 'human'`) now
  restores `owner_layer` from the new detection's own input (always
  `'development'` via the bridge) - previously the `UPDATE` never touched
  `owner_layer` at all, so a technical issue that had once been re-routed
  to a human stayed stuck there forever even after the same underlying
  problem recurred and was freshly detected by development. An issue that
  is merely still open (not reopened) never has its ownership silently
  overwritten by a later `recordIssue()` call.
- `evaluateCanary` used to promote a deployed canary once bounded
  extensions were exhausted *even if it had never once observed a fresh
  post-deploy heartbeat* - i.e. it could promote a deploy the system might
  not even be alive on. It now rolls back instead in that exact case
  (bounded automatic retry follows, same as any other rollback) - a canary
  is only ever promoted after a fresh heartbeat actually confirms the
  system is running the new code.
- `listMaintenanceWork` gained a `recipeId` filter applied at the SQL layer
  (before `LIMIT`); `registryMetrics.ts`'s autonomous-pipeline counters and
  `autonomousDeployment.ts`/`runner.ts`'s canary-scan queries all use it
  now, so a busy deterministic-recipe queue can no longer push autonomous
  canary rows out of a bounded page before they're even filtered.

### Exact-revision, this-call-only deploy rollback
  (`maintenance/autonomousDeployment.ts`)
- `deployAutonomousMaintenanceWork`'s post-cherry-pick gate failure used to
  unconditionally `git revert --no-edit HEAD` - but if the canary commit
  was *already* an ancestor of `HEAD` before this call ever ran (e.g. a
  previous/concurrent deploy already applied it), `HEAD` could by then be
  an entirely unrelated commit this call has no business reverting. It now
  tracks whether *this call* actually performed the cherry-pick; if not, a
  gate failure fails for a bounded retry without touching the live checkout
  at all, and when this call did deploy, it reverts the exact revision it
  captured immediately after the cherry-pick, never a possibly-since-moved
  `HEAD`.

### Git-command failures fail closed; a real host git identity
  (`maintenance/autonomousWorkerRunner.ts`, `maintenance/workerContract.ts`)
- `git status --porcelain`'s result was never checked for success -  a
  failed inspection (not merely "no output") fell straight into the
  "no changes, verify via gate, promote" fast path, so a `git status`
  failure could have been treated as `already_resolved`. Same issue for
  `git diff --numstat`/`git diff --cached`: an inspection failure was never
  distinguished from "empty valid diff." Both now fail the attempt for a
  bounded retry immediately, with no path that lets an inspection failure
  masquerade as an empty or already-resolved change.
- `buildRestrictedEnv` always redirected `HOME` to an isolated,
  `.gitconfig`-free directory (correctly, to keep every worker/deploy/
  rollback git invocation independent of whatever happens to be in the
  operator's real home directory) - but that meant the host's own `git
  commit`/`cherry-pick`/`revert` calls had no git identity to resolve at
  all unless the target repository happened to have local `user.name`/
  `user.email` config (which it does in every test fixture, but is not
  guaranteed for the real repository). `buildRestrictedEnv` now always
  injects a fixed `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/
  `GIT_COMMITTER_EMAIL` identity (git resolves these environment variables
  before ever consulting `~/.gitconfig`), so host git commands work
  regardless of the isolated `HOME` or the real operator's global config.
  This identity is baked into `buildRestrictedEnv`'s own output, which the
  autonomous coding agent's tool subprocesses never receive in the first
  place (the agent's `CopilotClient` uses a completely separate,
  full-ambient-env configuration) - it is never exposed to agent-run shell
  commands.

### Testing approach
- Every new/changed pure decision function (`evaluateShellRequest`'s
  fail-closed fallback, `wasIssueRedetectedAfterDeployment`'s evidence
  preference, `evaluateCanary`'s never-promote-without-a-heartbeat branch,
  `assessDirectionRequestCredibility`, `protectedPaths.ts`,
  `pinnedGate.ts`'s `buildPinnedGateSteps`/`runPinnedGate`) is unit-tested
  directly, with no Copilot session involved at all.
- The independent patch reviewer is never invoked for real in tests: every
  worker-level test that exercises the protected-path branch injects its
  own `patchReview` mock via `RunAutonomousMaintenanceWorkOptions
  .patchReview` (approve/reject/throw cases all covered), and every other
  existing test - none of which touch a protected path - implicitly proves
  the reviewer is *never* called for an ordinary change (no test hangs or
  makes a network/model call). The pinned gate is likewise never run for
  real against a full TypeScript project in tests: `pinnedGate.ts` exposes
  a `_setPinnedGateStepsForTests` hook (the same test-only-hook pattern
  already used by `_resetRegistryForTests`/`_setLogDataDirForTests`/
  `_setRuntimeHealthDataDirForTests`) that every worker/deployment test
  points at the scratch repo's own fast pass/fail fixture script instead.
- New dedicated test files: `pinnedGate.test.ts`, `protectedPaths.test.ts`,
  `autonomousPatchReviewSchema.test.ts`, plus substantially expanded
  coverage in `autonomousPermissionHandler.test.ts` (fail-closed fallback,
  `possiblePaths`/`possibleUrls`, awk/sed/find removal, bounded bun test/run
  args), `autonomousDeployment.test.ts` (evidence-occurrence rollback
  semantics, never-promote-without-heartbeat, exact-revision/this-call-only
  revert), `autonomousWorkerRunner.test.ts` (git-inspection-failure
  fail-closed behavior, host git identity, protected-path review
  integration), `autonomousAgentSchema.test.ts` (`directionKind` validation
  and `assessDirectionRequestCredibility`), `issueRegistry.test.ts`
  (ownership restoration on reopen, `lastEvidenceAt` tracking), and
  `registryDbMigration.test.ts` (the `last_evidence_at` column upgrade).

### Honest remaining constraints (superseded in part - see the newest session below)
- The pinned gate's "immutability" is about *which commands run*, not
  about sandboxing what those commands can observe while running - it
  still executes the patch's own (possibly modified) source and test
  files with a real compiler/test runner, by necessity: a fix cannot be
  verified without running it. What is fully pinned is: the diff/path/
  secret policy always runs first, the argv sequence itself is fixed
  host-code constants, the environment those commands run in has no bot
  credentials and a fixed, non-ambient identity, and a protected-path
  change additionally needs independent review before any of this even
  starts. **Update:** the gate's commands now also run inside a real
  bubblewrap sandbox (see the "Bubblewrap sandbox trust boundary" session
  below) - this constraint about *which commands run* is unchanged, but
  the *execution environment* those commands observe is now no longer the
  live checkout, has no network, and has no real `HOME`.
- `assessDirectionRequestCredibility` is a keyword-plausibility heuristic,
  not a semantic understanding of the request - a sufficiently creative
  `humanQuestion` could still pass the pattern check while actually
  describing ordinary technical uncertainty. It is a meaningful additional
  bar (combined with the mandatory, schema-enforced `directionKind`), not a
  perfect one; the schema-level requirement that `directionKind` be
  present/absent in exactly the right cases is the harder guarantee here.
- The independent patch reviewer is itself an LLM call with no tools and a
  bounded diff - it can miss a subtle vulnerability the same way any code
  reviewer (human or model) can. **Update:** a diff larger than
  `MAX_REVIEWED_DIFF_CHARS` is no longer truncated and sent anyway - it is
  now rejected deterministically, with no model call at all (see below).
- Evidence-occurrence tracking (`lastEvidenceAt`) depends on the
  development reviewer's findings citing a real trace-event timestamp in
  `evidenceRefs`, or on the review's own `traceWindow.endTs` fallback; an
  issue recorded by some future producer that supplies neither still falls
  back to the coarser (and, as this session found, gameable)
  `lastDetectedAt`-vs-baseline signal. This is a strictly better default
  than before, not a perfect one for every possible future issue source.

## Session N (final autonomy security/correctness audit fixes)

A follow-up design audit found several remaining gaps in the autonomous
development pipeline's own safety boundaries - all fixed in this session,
with adversarial regression tests proving each one:

### No agent-run interpreters/build tools, ever (`maintenance/autonomousPermissionHandler.ts`, `lib/autonomousDevelopmentAgent.ts`)
- `bun` and `tsc` are now permanently removed from the autonomous coding
  agent's shell allowlist - not just narrowed. Both are interpreters/build
  tools capable of executing arbitrary project code (`bun test`/`bun run`
  execute JS/TS; `tsc` loads and executes a `tsconfig.json`'s `plugins`
  field). Only the deterministic host ever runs a compiler or test runner
  now, always inside the pinned, sandboxed verification gate - never the
  agent directly. The agent's own system prompt now says this explicitly
  ("you cannot run bun/tsc/tests yourself; the deterministic host runs the
  full sandboxed gate after you finish") so it stops wasting turns trying.
- The remaining read-only allowlist (`cat`/`grep`/`rg`/`head`/`tail`/`ls`/
  `wc`/`sort`/`uniq`/`diff`/`pwd`/`test`, plus read-only git inspection)
  now fails closed when the runtime supplies no `possiblePaths` extraction
  at all: for the narrow subset of commands whose non-flag arguments are
  unambiguously path operands (`cat`/`head`/`tail`/`ls`/`wc`/`sort`/
  `uniq`/`diff`/`test`), this module self-parses and independently
  validates each argument as a path against the worktree; `grep`/`rg` (whose
  first non-flag argument is a search pattern, not a path) and any command
  with a flag this module cannot prove takes no separate value always fail
  closed instead of guessing.
- A direct `read`/`write` permission request's relative path is now
  resolved against `worktreeRoot` before being judged, never against this
  host process's own (arbitrary) working directory - previously a relative
  path could be denied (or, in principle, misjudged) because it was
  resolved against the wrong base directory entirely.

### Bubblewrap sandbox trust boundary (`maintenance/bwrapSandbox.ts`)
- Every pinned verification gate step (`tsc`, `bun test`) now runs inside a
  real `bwrap` sandbox: no network (`--unshare-net`, plus `--unshare-all`
  for every other namespace), no real `HOME` (`--clearenv` plus a
  throwaway tmpfs one), no live-repository mount of anything beyond three
  explicit mounts - the target worktree read-write at `/workspace` (the
  only thing a gate step may ever mutate), a stable tool root's own
  `node_modules` read-only at `/workspace/node_modules`, and the current
  Bun executable read-only at `/bun` - plus `/usr`/`/lib`/`/lib64`/`/proc`/
  `/dev`/a tmpfs `/tmp`, and `--die-with-parent`.
- For the worker's own precommit gate, the sandboxed workspace *is* the
  agent's already-isolated worktree - it may mutate only that worktree.
  For live deploy/rollback verification, the gate never runs directly
  against the live checkout at all: `autonomousDeployment.ts` now checks
  out a brand-new, disposable, detached git worktree at the exact deployed
  (or reverted) revision under ignored runtime data
  (`bots/DayTrader/data/deploy-verify-worktrees/`), sandboxes *that*, and
  always removes it afterward (pass or fail) - a changed test/source file
  never executes with direct read/write access to the live checkout.
- Fails closed: if the `bwrap` binary is missing, every sandboxed spawn
  call rejects immediately rather than ever falling back to running the
  gate unsandboxed. Every worker/deployment/rollback test still injects
  `identitySandboxSpawnFactory` (no real sandbox) via the same options
  plumbing as `spawn`/`agentRun`/`patchReview`; `bwrapSandbox.test.ts` adds
  one focused test that exercises a real `bwrap` sandbox end to end
  (workspace writable, `node_modules` read-only, no network).

### Post-gate diff integrity (`maintenance/autonomousWorkerRunner.ts`)
- The sandboxed gate step still executes the patch's own (possibly
  untrusted) source/test files with read-write access to the worktree -
  after it runs, the worktree is re-inspected from scratch (`git add -A`
  again, so a test-created untracked file is never silently dropped or
  silently smuggled in unreviewed, then a fresh `git diff --cached`). If
  that post-gate diff is byte-for-byte identical to the pre-gate reviewed
  diff, it is trusted outright; if it differs at all, the *entire*
  path/secret/size policy gate and (if a protected path is now touched)
  the independent patch review run again against the exact post-gate diff,
  and only that exact, freshly re-reviewed index is ever committed.

### Rename cannot bypass protected-path review (`maintenance/autonomousWorkerRunner.ts`, `maintenance/autonomousDeployment.ts`, `maintenance/isolatedWorkerRunner.ts`)
- Every `git diff`/`git diff-tree` invocation feeding a path/policy/review/
  deploy decision now passes `--no-renames`. Without it, a rename's
  combined `"old/path => new/path"` numstat/diff text evades every
  protected-path regex here (`(^|\/)bots\/DayTrader\/maintenance\/` is
  never preceded by `^` or `/` in that combined string, since a space
  precedes `bots/...`) - a plain filesystem rename of an ordinary file
  *into* `bots/DayTrader/maintenance/` reached canary without the
  independent reviewer ever being invoked. Confirmed by temporarily
  reverting the fix: the regression test failed exactly as predicted, then
  passed once `--no-renames` was restored.

### Independent patch reviewer never truncates an oversized diff (`lib/autonomousPatchReviewer.ts`)
- A diff over `MAX_REVIEWED_DIFF_CHARS` used to be truncated and sent to
  the model anyway (with a note asking it to reject if the unreviewed
  remainder mattered) - now it is rejected deterministically, with no
  model call at all. "Approved" can no longer mean "the model only saw the
  first N bytes of a much larger protected-path patch."

### Deterministic canary starvation (`lib/maintenanceStore.ts`, `maintenance/runner.ts`)
- `listMaintenanceWork` gained an `excludeRecipeId` filter applied at the
  SQL layer, before `LIMIT`. The maintenance runner's step 1 (deterministic
  recipe canaries) used to fetch a bounded page of *every* canary and
  filter out `autonomous-development` rows in JS afterward - if that
  high-volume recipe ever filled the whole bounded page, every
  deterministic-recipe canary was silently starved out of it, every scan,
  even though rows existed. The filter now happens before the page is
  truncated.

### Rollback lifecycle never leaves a canary stuck retrying an identical revert (`maintenance/autonomousDeployment.ts`)
- `rollbackAutonomousDeployment` used to `throw` when the post-revert full
  gate failed - leaving the maintenance work item sitting in `canary`
  (never transitioned) even though the revert commit had genuinely already
  landed in the live checkout. The next scan would then retry the
  identical revert against the identical, still-broken reverted tree,
  forever. It now persists a terminal `rolled_back` state with evidence
  that the revert landed, still requests a deployment reload (the live
  checkout's code really did change), and leaves the issue
  development-owned/`failed` for a bounded retry or manual diagnosis -
  never left in `canary`, never silently repeating the same revert.

### Deploy/rollback still only ever touch the exact revision this call deployed/reverted
- Unchanged from the previous session's fix, now additionally re-verified
  in a disposable sandboxed worktree rather than the live checkout: a
  post-deployment gate failure only reverts `HEAD` when *this call*
  actually performed the cherry-pick; if the canary commit was already an
  ancestor of `HEAD` before this call ran, it fails for a bounded retry
  without touching the live checkout at all.

### Testing approach
- Every new pure/self-contained helper (`translateArgToSandbox`/
  `buildBwrapArgv`/`createSandboxedSpawnFn`'s fail-closed path,
  `isDiffReviewable`, `extractSelfParsedPathArgs`,
  `ListMaintenanceWorkFilter.excludeRecipeId`) is unit-tested directly.
  `bwrapSandbox.test.ts` includes exactly one real-`bwrap` integration test
  proving the sandbox actually isolates network/HOME/filesystem; every
  other worker/deployment/rollback test injects
  `identitySandboxSpawnFactory` instead.
- Adversarial regression tests prove each fix actually matters, not just
  that the new code path exists: the rename-into-`maintenance/` bypass test
  was confirmed to fail without `--no-renames` (then pass once restored);
  the post-gate diff integrity tests make the sandboxed gate step itself
  mutate the worktree (including into a protected path) and assert the
  post-gate re-validation/re-review catches it; the rollback lifecycle
  test asserts the maintenance work reaches a terminal state (never
  `canary`) when the reverted tree itself fails its own gate.

### A dedicated adversarial code-review pass on this session's own changes found two more real gaps, both fixed and regression-tested
- **An empty (not merely absent) `possiblePaths` array was blindly trusted.**
  `hasPossiblePaths` only guarded the self-parse fallback for the "the
  runtime supplied nothing at all" case - if the runtime instead reported
  `possiblePaths: []` (correctly or, worse, because its own extractor
  under-reported a path), a command like `cat bot.env` was approved
  outright with zero independent corroboration. Self-parsing for the safe
  command subset (`cat`/`head`/`tail`/`ls`/`wc`/`uniq`/`diff`/`test`) now
  always runs, regardless of whether/what `possiblePaths` reported -
  `possiblePaths` is additional corroboration, never a substitute for it.
  `grep`/`rg` still cannot be safely self-parsed (pattern-vs-path
  ambiguity) and remain an accepted, documented residual limitation for
  the "runtime reports an empty array that is actually wrong" case
  specifically.
- **`sort`/`uniq` were documented as read-only but can both write files.**
  `sort -o FILE` writes its sorted output to an arbitrary file, and
  `uniq`'s undocumented-by-flag second positional argument
  (`uniq [OPTION]... [INPUT [OUTPUT]]`) is a write target, not a second
  file to read - neither was excluded, and the generic "bare flag" check
  couldn't reliably tell `-o` apart from a harmless bundled short flag.
  `sort` is now excluded entirely (the same "no narrow safe mode is
  possible" reasoning already applied to `awk`/`sed`/`find`); `uniq` stays
  allowed but is denied outright whenever more than one non-flag argument
  is present, regardless of whether that came from self-parsing or from
  the runtime's own `possiblePaths`.

### Honest remaining constraints
- The pinned gate still executes the patch's own (possibly modified)
  source and test files with a real compiler/test runner inside the
  sandbox - a fix cannot be verified without running it, and the sandbox
  is about *containing* that execution (no network, no real HOME, no live
  checkout, read-only shared `node_modules`), not about making it
  side-effect-free. A sufficiently determined sandbox-escape exploit in
  the compiler/test runner itself is not something this pipeline can rule
  out - it is exactly why the diff/path/secret policy and protected-path
  review always run *before* the sandboxed gate, and why deploy/rollback
  verification never runs in the live checkout even though bubblewrap is
  trusted to contain the execution.
- The self-parse fallback for `possiblePaths`-less shell requests is
  intentionally conservative (fails closed on any flag it cannot prove
  takes no separate value, and on `grep`/`rg` entirely) - it trades a few
  false-negative denials of otherwise-harmless commands for never
  guessing wrong about what argv actually points at.
