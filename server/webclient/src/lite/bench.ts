import { startSession, type LiteSession } from './session.js';

const N = Number(process.argv[2] ?? 8);
const readEnv = async (n: string) => Object.fromEntries(
  (await Bun.file(`/Users/max/workplace/rs-sdk/bots/${n}/bot.env`).text())
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const mb = () => process.memoryUsage().rss / 1048576;
const heap = () => process.memoryUsage().heapUsed / 1048576;

console.log(`baseline rss=${mb().toFixed(1)}MB`);
const sessions: LiteSession[] = [];
const marks: number[] = [];

for (let i = 1; i <= N; i++) {
  const env = await readEnv(`litetest${i}`);
  const s = await startSession({ host: env.SERVER!, username: env.BOT_USERNAME!, password: env.PASSWORD!, quiet: true });
  sessions.push(s);
  await Bun.sleep(1500);
  marks.push(mb());
  console.log(`  ${i} bot(s) connected: rss=${mb().toFixed(1)}MB heap=${heap().toFixed(1)}MB`);
}

console.log('\nsettling 8s...');
await Bun.sleep(8000);

// CPU: measure how much wall time the process actually burns over 10s
const cpu0 = process.cpuUsage();
const t0 = performance.now();
await Bun.sleep(10000);
const cpu = process.cpuUsage(cpu0);
const wall = performance.now() - t0;
const cpuPct = ((cpu.user + cpu.system) / 1000 / wall) * 100;

let live = 0;
// Isolation check: any bot the server has sent inventory data for must own its
// own component. Bots that never received one still share the pristine base,
// which is the copy-on-write design working, not a leak.
const ownedInvComponents = new Set<unknown>();
let botsWithOwnInv = 0;
for (let i = 0; i < sessions.length; i++) {
  const c = sessions[i].client;
  const st = c.collectBotState(0);
  if (st.inGame && st.player) live++;
  if (c.interfaces.owns(3214)) {
    botsWithOwnInv++;
    ownedInvComponents.add(c.ifType(3214));
  }
  if (i < 3) console.log(`  bot${i+1}: ${st.player?.name} @${st.player?.worldX},${st.player?.worldZ} npcs=${st.nearbyNpcs.length} locs=${st.nearbyLocs.length} inv=${st.inventory.length} cloned=${c.interfaces.clonedCount}`);
}

console.log(`\n=== ${N} bots, one Bun process ===`);
console.log(`live sessions   : ${live}/${N}`);
console.log(`rss             : ${mb().toFixed(1)} MB total`);
console.log(`marginal per bot: ${((marks[marks.length-1]-marks[0])/Math.max(1,N-1)).toFixed(1)} MB`);
console.log(`cpu             : ${cpuPct.toFixed(1)}% of one core for all ${N} (${(cpuPct/N).toFixed(2)}%/bot)`);
const isolated = ownedInvComponents.size === botsWithOwnInv;
console.log(`interface tables: ${botsWithOwnInv} bot(s) wrote an inventory, ${ownedInvComponents.size} distinct component(s)${isolated ? '' : '  <-- SHARED STATE BUG'}`);

for (const s of sessions) s.stop();
await Promise.all(sessions.map(s => s.stopped));
