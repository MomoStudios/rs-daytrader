// The client's monotonic frame counter, in a module of its own.
//
// rs-sdk local addition, purely to break an import cycle-by-weight: ClientPlayer
// reads this counter once, and importing Client to get it drags the whole
// 14k-line Client (plus Pix3D, MapView, WebAudio, localStorage) into anything
// touching a ClientPlayer. The headless lite client needs ClientPlayer's decode
// behaviour without any of that. Client keeps `static loopCycle` as an accessor
// pair over this box, so existing reads and writes behave exactly as before.
//
// This box is browser-client state, one per JS realm. N LiteClients share one
// module registry, so a shared counter would advance N times too fast; each owns
// a CycleCounter of its own (`LiteClient.cycle`) and lite code reads that.

export interface CycleCounter {
    value: number;
}

export const LoopCycle: CycleCounter = { value: 0 };
