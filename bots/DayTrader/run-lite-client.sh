#!/bin/bash
# Supervisor: keeps the headless lite client alive for DayTrader.
# The lite runner exits (non-zero) whenever the game session ends for any
# reason other than an explicit stop (idle timeout, disconnect, error), and
# does not restart itself by design - "re-login is the supervisor's job".
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../../server/webclient" || exit 1
while true; do
    echo "[supervisor] starting lite client for DayTrader at $(date)"
    bun src/lite/runner.ts DayTrader
    echo "[supervisor] lite client exited (code $?) at $(date), restarting in 5s"
    sleep 5
done
