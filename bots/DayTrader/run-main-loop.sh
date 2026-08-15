#!/bin/bash
# Supervisor: keeps the hybrid Copilot strategist/game loop alive, restarting
# it after transient model, lite-client, or gateway failures.
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../.." || exit 1
while true; do
    echo "[supervisor] starting DayTrader main loop at $(date)"
    bun bots/DayTrader/daytrader.ts
    echo "[supervisor] main loop exited (code $?) at $(date), restarting in 5s"
    sleep 5
done
