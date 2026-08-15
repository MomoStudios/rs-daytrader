#!/bin/bash
# Localhost-only visual RuneScape client + sanitized two-agent dashboard.
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/../.." || exit 1
exec bun bots/DayTrader/observer/server.ts
