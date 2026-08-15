// Zone-scoped updates: ground items and server-driven loc changes.
//
// Ported from Client.ts zonePacket(). The rendering-only branches (LOC_ANIM,
// MAP_ANIM, MAP_PROJANIM, and the model half of P_LOCMERGE) are consumed for
// framing but produce no state - nothing in BotWorldState is derived from them.

import LinkList from '#/datastruct/LinkList.js';
import ClientObj from '#/dash3d/ClientObj.js';
import { BuildArea } from '#/dash3d/CollisionMap.js';

import Packet from '#/io/Packet.js';
import { ServerProt } from '#/io/ServerProt.js';

import type { LiteClient } from '../LiteClient.js';

export function zonePacket(c: LiteClient, buf: Packet, opcode: number): void {
    const pos = buf.g1();
    const x = c.zoneUpdateX + ((pos >> 4) & 0x7);
    const z = c.zoneUpdateZ + (pos & 0x7);
    const inArea = x >= 0 && z >= 0 && x < BuildArea.SIZE && z < BuildArea.SIZE;
    const level = c.minusedlevel;

    switch (opcode) {
        case ServerProt.LOC_ADD_CHANGE: {
            const info = buf.g1();
            const id = buf.g2();
            if (inArea) {
                c.world.addLoc(level, c.mapBuildBaseX + x, c.mapBuildBaseZ + z, id, info >> 2, info & 0x3);
            }
            return;
        }

        case ServerProt.LOC_DEL: {
            const info = buf.g1();
            if (inArea) {
                c.world.delLoc(level, c.mapBuildBaseX + x, c.mapBuildBaseZ + z, info >> 2);
            }
            return;
        }

        case ServerProt.OBJ_ADD: {
            const type = buf.g2();
            const count = buf.g2();
            if (inArea) {
                if (!c.groundObj[level][x][z]) {
                    c.groundObj[level][x][z] = new LinkList();
                }
                c.groundObj[level][x][z]?.push(new ClientObj(type, count));
            }
            return;
        }

        case ServerProt.OBJ_DEL: {
            const type = buf.g2();
            if (inArea) {
                const objs = c.groundObj[level][x][z];
                if (objs) {
                    for (let obj = objs.head(); obj !== null; obj = objs.next()) {
                        if (obj.id === (type & 0x7fff)) {
                            obj.unlink();
                            break;
                        }
                    }
                    if (objs.head() === null) {
                        c.groundObj[level][x][z] = null;
                    }
                }
            }
            return;
        }

        case ServerProt.OBJ_COUNT: {
            const type = buf.g2();
            const oldCount = buf.g2();
            const count = buf.g2();
            if (inArea) {
                const objs = c.groundObj[level][x][z];
                if (objs) {
                    for (let obj = objs.head(); obj !== null; obj = objs.next()) {
                        if (obj.id === (type & 0x7fff) && obj.count === oldCount) {
                            obj.count = count;
                            break;
                        }
                    }
                }
            }
            return;
        }

        case ServerProt.OBJ_REVEAL: {
            const id = buf.g2();
            const count = buf.g2();
            const pid = buf.g2();
            // pid === selfSlot means this is our own drop being revealed to
            // everyone else; we already have it from OBJ_ADD.
            if (inArea && pid !== c.selfSlot) {
                if (!c.groundObj[level][x][z]) {
                    c.groundObj[level][x][z] = new LinkList();
                }
                c.groundObj[level][x][z]?.push(new ClientObj(id, count));
            }
            return;
        }

        // ---- consumed for framing only ------------------------------------
        case ServerProt.LOC_ANIM: {
            buf.g1();
            buf.g2();
            return;
        }
        case ServerProt.MAP_ANIM: {
            buf.g2();
            buf.g1();
            buf.g2();
            return;
        }
        case ServerProt.MAP_PROJANIM: {
            buf.g1b();
            buf.g1b();
            buf.g2b();
            buf.g2();
            buf.g1();
            buf.g1();
            buf.g2();
            buf.g2();
            buf.g1();
            buf.g1();
            return;
        }
        case ServerProt.P_LOCMERGE: {
            buf.g1();
            buf.g2();
            buf.g2();
            buf.g2();
            buf.g2();
            buf.g1b();
            buf.g1b();
            buf.g1b();
            buf.g1b();
            return;
        }

        default:
            return;
    }
}
