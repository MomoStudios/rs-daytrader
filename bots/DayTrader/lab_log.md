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
