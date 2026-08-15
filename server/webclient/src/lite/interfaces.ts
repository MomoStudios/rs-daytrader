// Per-client interface state.
//
// `IfType.list` is a STATIC array of component objects, and the interface packets
// (IF_SETTEXT, UPDATE_INV_FULL, ...) mutate those objects in place. In the browser
// that is safe: every tab is its own JS realm, so a tab's `IfType.list` belongs to
// exactly one Client. Headless, N LiteClients share one module registry - so
// without this, every bot in a process writes its inventory, bank, shop and dialog
// text into the same components, and `StateCollector` reads back whichever bot's
// packet happened to land last. Silently, with no error and plausible-looking
// state.
//
// So each client gets its own *reference* table: 11k slots, ~88KB, pointing at the
// shared read-only components until the server mutates one for this bot, at which
// point that component is cloned into the client's slot (copy-on-write). Only what
// the server actually changes gets duplicated - typically the inventory, whichever
// modal is open, and a handful of dialog text lines - so the marginal cost stays
// in the tens of KB rather than the ~3MB a full clone of the table would cost.
//
// The switch itself is `activate()`, which repoints `IfType.list`. Every public
// LiteClient method activates its own table on entry (see the prototype wrapper at
// the bottom of LiteClient.ts) and `dispatch()` does the same before touching a
// packet, so no caller has to remember to do it.

import IfType from '#/config/IfType.js';

/** The pristine table produced by IfType.init, captured before any client mutates it. */
let base: IfType[] | null = null;

/**
 * Snapshot the freshly-initialised component table. Must be called once, right
 * after IfType.init and before any InterfaceTable exists - otherwise a client
 * created later would inherit an earlier client's mutations as its baseline.
 */
export function captureBaseInterfaces(): void {
    if (!base) {
        base = IfType.list;
    }
}

/**
 * Forget the captured baseline so the next loadCache() recaptures it — used by
 * invalidateCache() after a server content redeploy, and by test suites that
 * re-init the cache. Existing InterfaceTables keep their old lists.
 */
export function resetBaseInterfaces(): void {
    base = null;
}

export class InterfaceTable {
    /** What `IfType.list` points at while this client is active. */
    readonly list: IfType[];

    /** Ids this table has cloned; everything else is still the shared component. */
    private readonly owned = new Set<number>();

    constructor() {
        if (!base) {
            throw new Error('lite: InterfaceTable created before the interface archive was loaded (call loadCache first)');
        }
        this.list = base.slice();
    }

    /** Point the shared static at this client's table. */
    activate(): void {
        IfType.list = this.list;
    }

    /**
     * The component `id` as this client may mutate it, cloned on first write.
     *
     * Everything a component owns is either immutable in this client (scripts,
     * children, iop, sprites - shared by reference on purpose) or one of the two
     * inventory arrays, which are copied because the packet handlers write into
     * them slot by slot.
     */
    mutable(id: number): IfType | undefined {
        const current = this.list[id];
        if (!current || this.owned.has(id)) {
            return current;
        }

        const copy: IfType = Object.assign(Object.create(IfType.prototype) as IfType, current);
        if (current.linkObjType) {
            copy.linkObjType = current.linkObjType.slice();
        }
        if (current.linkObjNumber) {
            copy.linkObjNumber = current.linkObjNumber.slice();
        }

        this.list[id] = copy;
        this.owned.add(id);
        return copy;
    }

    /** Number of components this client has diverged from the shared table. */
    get clonedCount(): number {
        return this.owned.size;
    }

    /**
     * Whether this client has its own copy of `id`. A component nobody has
     * written is still the pristine shared one - which is correct, and is why
     * "two clients share this object" only indicates a bug when both own it.
     */
    owns(id: number): boolean {
        return this.owned.has(id);
    }
}
