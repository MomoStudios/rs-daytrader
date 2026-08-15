import { ScriptOpcode } from '#/engine/script/ScriptOpcode.js';
import { CommandHandlers } from '#/engine/script/ScriptRunner.js';
import Environment from '#/util/Environment.js';

const DebugOps: CommandHandlers = {
    [ScriptOpcode.ERROR]: state => {
        throw new Error(state.popString());
    },

    [ScriptOpcode.CONSOLE]: state => {
        console.log(state.popString());
    },

    [ScriptOpcode.MAP_RANDOM_EVENTS]: state => {
        state.pushInt(Environment.NODE_RANDOM_EVENTS ? 1 : 0);
    },

    [ScriptOpcode.TIMESPENT]: state => {
        state.timespent = performance.now();
    },

    [ScriptOpcode.GETTIMESPENT]: state => {
        const elapsed = performance.now() - state.timespent;

        if (state.popInt() === 1) {
            // microseconds
            state.pushInt(elapsed * 1000);
        } else {
            // milliseconds
            state.pushInt(elapsed);
        }
    }
};

export default DebugOps;
