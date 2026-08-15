#!/bin/bash
# Supervisor for the periodic/on-demand omniscient development reviewer.
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../.." || exit 1
while true; do
    echo "[supervisor] starting DayTrader development agent at $(date)"
    bun bots/DayTrader/development/runner.ts
    echo "[supervisor] development agent exited (code $?) at $(date), restarting in 10s"
    sleep 10
done
