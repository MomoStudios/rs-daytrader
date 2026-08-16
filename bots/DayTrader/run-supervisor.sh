#!/bin/bash
# Unified supervisor: runs the lite client, main loop, development
# reviewer, and maintenance worker together with per-process health-aware
# restart/backoff. The individual run-*.sh scripts remain available and
# unchanged for running any one process standalone.
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../.." || exit 1
exec bun bots/DayTrader/run-supervisor.ts
