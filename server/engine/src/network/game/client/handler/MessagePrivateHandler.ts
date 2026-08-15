import Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import Packet from '#/io/Packet.js';
import ClientGameMessageHandler from '#/network/game/client/ClientGameMessageHandler.js';
import MessagePrivate from '#/network/game/client/model/MessagePrivate.js';
import Environment from '#/util/Environment.js';
import WordPack from '#/wordenc/WordPack.js';

export default class MessagePrivateHandler extends ClientGameMessageHandler<MessagePrivate> {
    handle(message: MessagePrivate, player: Player): boolean {
        const { username, input } = message;

        if (player.socialProtect || input.length > Environment.node.maxMessageLength) {
            return false;
        }

        if (player.muted_until !== null && player.muted_until > new Date()) {
            // todo: do we still log their attempt to chat?
            return false;
        }

        // alloc(1): packed chat can be ~250 bytes (maxMessageLength 400 + 2-nibble
        // chars), which overflows the 100-byte alloc(0) tier and kicks the player.
        const buf: Packet = Packet.alloc(1);
        buf.pdata(input, 0, input.length);
        buf.pos = 0;
        World.sendPrivateMessage(player, username, WordPack.unpack(buf, input.length));
        buf.release();

        player.socialProtect = true;
        return true;
    }
}
