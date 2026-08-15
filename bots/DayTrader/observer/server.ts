import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BotSDK, deriveGatewayUrl } from '../../../sdk/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(__dirname, '..');
const DATA_DIR = join(BOT_DIR, 'data');
const ENV_PATH = join(BOT_DIR, 'bot.env');
const PORT = Number(process.env.DAYTRADER_OBSERVER_PORT ?? 4317);

function loadEnv(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator > 0) result[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    }
    return result;
}

const env = loadEnv();
const username = env.BOT_USERNAME || 'DayTrader';
const password = env.PASSWORD || '';
const serverHost = env.SERVER || 'rs-sdk-demo.fly.dev';
const gatewayUrl = deriveGatewayUrl(serverHost);
const gameUrl = new URL(`https://${serverHost}/bot`);
gameUrl.searchParams.set('bot', username);
gameUrl.searchParams.set('password', password);
gameUrl.searchParams.set('fps', '30');
gameUrl.searchParams.set('minimal', '1');

const sdk = new BotSDK({
    botUsername: username,
    password,
    gatewayUrl,
    connectionMode: 'observe',
    autoLaunchBrowser: false,
    autoReconnect: true,
    readyTimeout: 0,
});

let observerError: string | null = null;
sdk.connect().catch(error => {
    observerError = String(error);
    console.error('[observer] SDK observer connection failed:', error);
});

function readJson(name: string): unknown {
    const path = join(DATA_DIR, name);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        return { error: String(error) };
    }
}

function tailLines(path: string, maxLines: number, maxBytes = 256 * 1024): string[] {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    const bytes = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    const fd = openSync(path, 'r');
    try {
        readSync(fd, buffer, 0, bytes, size - bytes);
    } finally {
        closeSync(fd);
    }
    return buffer
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-maxLines);
}

function recentEvents(): unknown[] {
    const lines = tailLines(join(DATA_DIR, 'decisions.jsonl'), 60);
    return lines.flatMap(line => {
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            // Avoid echoing raw public chat/scam payloads in the dashboard.
            delete event.text;
            return [event];
        } catch {
            return [];
        }
    });
}

function statusPayload(): object {
    const state = sdk.getState();
    const strategy = readJson('strategy.json') as any;
    const operator = readJson('operator.json') as any;
    const collection = readJson('collection.json') as any;
    const player = state?.player;
    return {
        now: Date.now(),
        observer: {
            connected: sdk.isConnected(),
            authenticated: sdk.isAuthenticated(),
            error: observerError,
            stateAgeMs: sdk.getStateAge(),
        },
        runtime: {
            strategistModel: 'gpt-5.6-luna',
            operatorModel: 'gpt-5.6-luna',
            reasoningEffort: 'medium',
        },
        game: state
            ? {
                  tick: state.tick,
                  inGame: state.inGame,
                  player: player
                      ? {
                            name: player.name,
                            x: player.worldX,
                            z: player.worldZ,
                            level: player.level,
                            hp: player.hp,
                            maxHp: player.maxHp,
                            combatLevel: player.combatLevel,
                            runEnergy: player.runEnergy,
                            inCombat: player.combat.inCombat,
                        }
                      : null,
                  skills: state.skills
                      .map(skill => ({
                          name: skill.name,
                          level: skill.baseLevel,
                          xp: skill.experience,
                      }))
                      .sort((a, b) => b.level - a.level),
                  inventory: state.inventory.map(item => ({ name: item.name, count: item.count })),
                  nearbyPlayers: state.nearbyPlayers.map(item => ({
                      name: item.name,
                      combatLevel: item.combatLevel,
                      distance: item.distance,
                  })),
                  nearbyNpcs: [...new Set(state.nearbyNpcs.map(item => item.name))].slice(0, 15),
                  dialog: {
                      open: state.dialog.isOpen,
                      text: state.dialog.text,
                      options: state.dialog.options.map(option => option.text),
                  },
                  interface: { open: state.interface.isOpen, id: state.interface.interfaceId },
              }
            : null,
        strategist: {
            currentGoal: strategy?.currentGoal ?? null,
            summary: strategy?.lastDecision?.summary ?? null,
            marketSignals: strategy?.lastDecision?.marketSignals ?? [],
            nextAction: strategy?.lastDecision?.nextAction ?? null,
            chatActions: strategy?.lastDecision?.chatActions ?? [],
            lastPlannedAt: strategy?.lastPlannedAt ?? 0,
        },
        operator: {
            summary: operator?.decision?.summary ?? null,
            blockers: operator?.decision?.blockers ?? [],
            workflow: operator?.workflow
                ? {
                      name: operator.workflow.name,
                      goal: operator.workflow.goal,
                      version: operator.workflow.version,
                      successCriteria: operator.workflow.successCriteria,
                      steps: operator.workflow.steps,
                      stepIndex: operator.stepIndex ?? 0,
                      stepAttempts: operator.stepAttempts ?? 0,
                  }
                : null,
            lastFailure: operator?.lastFailure ?? null,
            recentEvidence: operator?.recentEvidence ?? [],
            escalation: operator?.pendingEscalation ?? operator?.decision?.escalation ?? null,
            lastProgressAt: operator?.lastProgressAt ?? 0,
        },
        collection: {
            observedCount: collection?.observed ? Object.keys(collection.observed).length : 0,
            recentlyObserved: collection?.observed
                ? Object.entries(collection.observed)
                      .sort(([, a]: any, [, b]: any) => b.firstSeenAt - a.firstSeenAt)
                      .slice(0, 12)
                      .map(([name, value]) => ({ name, ...(value as object) }))
                : [],
        },
        events: recentEvents(),
    };
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DayTrader Observer</title>
<style>
:root{color-scheme:dark;--bg:#080b0c;--panel:#101617;--panel2:#151d1e;--line:#263233;--text:#e7ece8;--muted:#8d9b95;--gold:#d4ad52;--green:#6ebd84;--red:#e27676;--blue:#77a9c7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
header{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--line);background:#0c1112}
.brand{display:flex;align-items:center;gap:10px;font-weight:750;letter-spacing:.02em}.coin{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffe596,#c49126 60%,#6e4a13);box-shadow:0 0 18px #d4ad5244}
.status{font-size:12px;color:var(--muted);display:flex;gap:14px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--red)}.dot.ok{background:var(--green);box-shadow:0 0 8px #6ebd8877}
main{height:calc(100vh - 56px);display:grid;grid-template-columns:minmax(620px,1.7fr) minmax(390px,1fr);gap:1px;background:var(--line)}
.game-shell{position:relative;background:#000;min-width:0}.game-shell iframe{border:0;width:100%;height:100%;display:block;background:#000}
.game-label{position:absolute;left:12px;top:12px;z-index:2;padding:6px 9px;border:1px solid #ffffff22;border-radius:6px;background:#050707cc;color:#c9d2cd;font-size:11px;pointer-events:none}
.dash{overflow:auto;background:var(--bg);padding:12px;display:grid;gap:10px;align-content:start}
.card{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:10px;padding:12px;box-shadow:0 8px 22px #0003}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--gold);margin:0 0 10px}.summary{font-size:14px;line-height:1.45}.muted{color:var(--muted)}.small{font-size:11px}
.goal{font-size:17px;font-weight:700;margin-bottom:4px}.tag{display:inline-block;padding:3px 7px;margin:2px 3px 2px 0;border:1px solid var(--line);border-radius:999px;font-size:10px;color:#b9c5c0;background:#0b1011}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.metric{background:#0b1011;border-radius:7px;padding:8px}.metric b{display:block;font-size:17px}.metric span{font-size:10px;color:var(--muted)}
.signal,.blocker,.event,.step{padding:8px 0;border-top:1px solid var(--line)}.signal:first-child,.blocker:first-child,.event:first-child,.step:first-child{border-top:0}.signal b,.blocker b{font-size:12px}.confidence{float:right;color:var(--blue);font-size:10px}
.workflow-head{display:flex;justify-content:space-between;gap:8px}.progress{height:5px;background:#070a0b;border-radius:5px;overflow:hidden;margin:8px 0}.progress>i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),var(--green))}
.step.active{color:#fff}.step.done{color:var(--green)}.step.future{color:var(--muted)}.step-code{font-family:ui-monospace,monospace;font-size:10px;color:#9bb0a8;margin-top:3px}
.event{font-size:11px}.event time{color:var(--muted);margin-right:6px}.event .type{color:var(--gold);font-weight:650}.event pre{white-space:pre-wrap;margin:4px 0 0;color:#acb8b3;font-family:inherit}
.warning{border-color:#674444;background:#211516}.good{color:var(--green)}.bad{color:var(--red)}
@media(max-width:1050px){main{grid-template-columns:1fr;grid-template-rows:58vh auto;height:auto}.game-shell{height:58vh}.dash{overflow:visible}.grid2{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<header><div class="brand"><span class="coin"></span>DayTrader Observer</div><div class="status"><span id="conn"><i class="dot"></i>connecting</span><span id="age">state —</span><span>safe summaries, not private chain-of-thought</span></div></header>
<main>
  <section class="game-shell"><div class="game-label">LIVE GAME CLIENT · visual session</div><iframe src="${gameUrl.toString()}" allow="autoplay; fullscreen" title="DayTrader RuneScape client"></iframe></section>
  <aside class="dash">
    <div class="card" id="player"></div>
    <div class="card" id="strategist"></div>
    <div class="card" id="signals"></div>
    <div class="card" id="operator"></div>
    <div class="card" id="workflow"></div>
    <div class="card" id="collection"></div>
    <div class="card" id="events"></div>
  </aside>
</main>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=t=>!t?'—':Math.max(0,Math.round((Date.now()-t)/1000))+'s ago';
const compact=v=>JSON.stringify(v??{}).replace(/[{}"]/g,'').replace(/,/g,', ');
function render(d){
 const ok=d.observer.connected&&d.observer.authenticated&&d.game;
 document.querySelector('#conn').innerHTML='<i class="dot '+(ok?'ok':'')+'"></i>'+(ok?'live':'waiting');
 document.querySelector('#age').textContent='state '+(Number.isFinite(d.observer.stateAgeMs)?Math.round(d.observer.stateAgeMs/1000)+'s':'—');
 const p=d.game?.player;
 document.querySelector('#player').innerHTML='<h2>Character</h2>'+(p?'<div class="goal">'+esc(p.name)+'</div><div class="grid2"><div class="metric"><b>'+p.hp+'/'+p.maxHp+'</b><span>hitpoints</span></div><div class="metric"><b>'+p.combatLevel+'</b><span>combat</span></div><div class="metric"><b>'+p.x+', '+p.z+'</b><span>position</span></div><div class="metric"><b>'+d.game.inventory.length+'/28</b><span>inventory slots</span></div></div><div style="margin-top:8px">'+d.game.skills.slice(0,6).map(s=>'<span class="tag">'+esc(s.name)+' '+s.level+'</span>').join('')+'</div>':'<div class="muted">Waiting for game state…</div>');
 const s=d.strategist,g=s.currentGoal;
 document.querySelector('#strategist').innerHTML='<h2>Strategist · '+esc(d.runtime.strategistModel)+' / '+esc(d.runtime.reasoningEffort)+'</h2>'+(g?'<div class="goal">'+esc(g.target)+'</div><div class="small muted">'+esc(g.kind)+' · target '+esc(g.targetValue)+' · '+ago(s.lastPlannedAt)+'</div><p class="summary">'+esc(s.summary)+'</p><div class="small muted">'+esc(g.rationale)+'</div><div style="margin-top:8px"><span class="tag">next '+esc(compact(s.nextAction))+'</span></div>':'<div class="muted">No strategic decision yet.</div>');
 document.querySelector('#signals').innerHTML='<h2>Market signals</h2>'+((s.marketSignals||[]).length?(s.marketSignals||[]).map(x=>'<div class="signal"><span class="confidence">'+esc(x.confidence)+'%</span><b>'+esc(x.kind)+' · '+esc(x.topic)+'</b><div class="small muted">'+esc(x.evidence)+'</div><div class="small">'+esc(x.implication)+'</div></div>').join(''):'<div class="muted small">No current market signal.</div>');
 const o=d.operator;
 document.querySelector('#operator').innerHTML='<h2>Operator · '+esc(d.runtime.operatorModel)+' / '+esc(d.runtime.reasoningEffort)+'</h2><p class="summary">'+esc(o.summary||'Waiting for execution plan…')+'</p>'+(o.lastFailure?'<div class="bad small">Last failure: '+esc(o.lastFailure)+'</div>':'<div class="good small">No active failure</div>')+(o.escalation?'<div class="blocker warning"><b>Escalation · '+esc(o.escalation.reason)+'</b><div class="small">'+esc(o.escalation.question)+'</div></div>':'')+(o.blockers||[]).map(x=>'<div class="blocker"><b>'+esc(x.kind)+' · '+esc(x.target)+'</b><div class="small muted">'+esc(x.evidence)+'</div></div>').join('');
 const w=o.workflow; let wh='<h2>Execution workflow</h2>';
 if(w){const pct=Math.round(100*Math.min(w.stepIndex,w.steps.length)/Math.max(1,w.steps.length));wh+='<div class="workflow-head"><b>'+esc(w.name)+' v'+esc(w.version)+'</b><span class="small muted">step '+(w.stepIndex+1)+'/'+w.steps.length+' · attempt '+w.stepAttempts+'</span></div><div class="small muted">'+esc(w.goal)+'</div><div class="progress"><i style="width:'+pct+'%"></i></div>'+w.steps.map((x,i)=>'<div class="step '+(i<w.stepIndex?'done':i===w.stepIndex?'active':'future')+'"><b>'+(i<w.stepIndex?'✓ ':i===w.stepIndex?'▶ ':'○ ')+esc(x.description)+'</b><div class="step-code">'+esc(compact(x.directive))+' → '+esc(compact(x.completion))+'</div></div>').join('')}else wh+='<div class="muted small">No active workflow.</div>';document.querySelector('#workflow').innerHTML=wh;
 document.querySelector('#collection').innerHTML='<h2>Collection portfolio</h2><div class="grid2"><div class="metric"><b>'+esc(d.collection.observedCount)+'</b><span>items ever observed</span></div><div class="metric"><b>33</b><span>portfolio targets</span></div></div><div style="margin-top:8px">'+(d.collection.recentlyObserved||[]).map(x=>'<span class="tag">'+esc(x.name)+' ×'+esc(x.maxHeld)+'</span>').join('')+'</div>';
 const visible=(d.events||[]).filter(e=>['ai_plan','operator_plan','operator_step','operator_stall','operator_escalation','trade_result','ad_sent','skill_action','error','ai_error'].includes(e.type)).slice(-24).reverse();
 document.querySelector('#events').innerHTML='<h2>Decision & action stream</h2>'+visible.map(e=>{const copy={...e};delete copy.ts;delete copy.type;const text=copy.summary||copy.message||copy.question||compact(copy);return '<div class="event"><time>'+new Date(e.ts).toLocaleTimeString()+'</time><span class="type">'+esc(e.type)+'</span><pre>'+esc(text)+'</pre></div>'}).join('');
}
async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'});render(await r.json())}catch(e){document.querySelector('#conn').innerHTML='<i class="dot"></i>dashboard error'}finally{setTimeout(poll,1000)}}poll();
</script>
</body></html>`;

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    fetch(request) {
        const url = new URL(request.url);
        const headers = {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
        };
        if (url.pathname === '/api/status') {
            return Response.json(statusPayload(), { headers });
        }
        if (url.pathname === '/' || url.pathname === '/observer') {
            return new Response(html, {
                headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
            });
        }
        return new Response('Not found', { status: 404, headers });
    },
});

console.log(`[observer] DayTrader observer running at http://127.0.0.1:${server.port}`);
console.log('[observer] Opening this page replaces the headless lite client with the visual browser client.');

process.on('SIGINT', () => {
    sdk.disconnect();
    server.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    sdk.disconnect();
    server.stop();
    process.exit(0);
});
