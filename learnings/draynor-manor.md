# Draynor Manor

## DANGER: One-Way Front Door

The front door of Draynor Manor **cannot be opened from inside**. The quest script (`quest_haunted.rs2`) checks `if(coordz(coord) > coordz(loc_coord))` — only players on the north (outside) side can open it.

**If the pathfinder routes you through the front door, you will be trapped inside.**

### How to Escape (If Trapped)

The manor has internal doors that connect rooms. Two key doors form an escape path through the east wing:

1. **Door at (3119, 3356) id:1530** — connects the SE room to the warehouse area
2. **Door at (3123, 3360) id:136** — connects warehouse to the courtyard

The SDK pathfinder can't open these doors automatically because `sendInteractLoc` relies on server-side pathfinding, which blocks on closed doors. Use raw `sendWalk` to get adjacent, then interact:

```typescript
// Step 1: Raw-walk to a tile adjacent to the door
sdk.sendWalk(doorX, doorZ - 1); // south side
await sdk.waitForTicks(2);

// Step 2: Interact to open
sdk.sendInteractLoc(doorX, doorZ, doorId, 1);
await sdk.waitForTicks(3);

// Step 3: Walk through
sdk.sendWalk(doorX, doorZ + 1); // north side
await sdk.waitForTicks(2);
```

### Avoidance

Avoid routing through Draynor Manor entirely. If you need to pass through the area, use coordinates that stay well clear of the manor grounds (x < 3090 or x > 3130).

## Draynor Manor Underground

- **Stairs down** at (3115, 3357) → crypt at (3077, 9771)
- Crypt is a separate area from the puzzle basement — no walking connection between them
- **Magic door** exit at (2874, 9750) leads to the Wilderness — avoid unless you know what you're doing

## Key Coordinates

| Location | Coordinates | Notes |
|----------|-------------|-------|
| Front door (one-way) | (3108, 3353) | DO NOT ENTER |
| East wing doors | (3119, 3356), (3123, 3360) | Escape route |
| Crypt stairs | (3115, 3357) | Goes to (3077, 9771) |
| Courtyard | (3125, 3370) | North of east wing |
