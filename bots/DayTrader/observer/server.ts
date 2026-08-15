import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BotSDK, deriveGatewayUrl } from '../../../sdk/index';
import {
    addHumanGuidance,
    listHumanGuidance,
} from '../lib/humanGuidance';

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

const chatSeenAt = new Map<string, number>();

function readableChat(): object[] {
    const messages = sdk.getChat({
        limit: 250,
        types: [0, 1, 2, 3, 6, 7],
        includeSelf: true,
    });
    const now = Date.now();
    return messages.map(message => {
        const key = `${message.observationId ?? message.tick}:${message.type}:${message.sender}:${message.text}`;
        if (!chatSeenAt.has(key)) chatSeenAt.set(key, now);
        return {
            type: message.type,
            sender: message.sender || (message.type === 0 ? 'Game' : 'Unknown'),
            text: message.text,
            tick: message.tick,
            fromSelf: message.fromSelf,
            seenAt: chatSeenAt.get(key),
        };
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
        guidance: listHumanGuidance().slice(-20).reverse(),
        chat: readableChat(),
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
.dash{overflow:hidden;background:var(--bg);display:grid;grid-template-rows:auto auto 1fr;min-height:0}
.tabs{display:flex;gap:5px;padding:10px;border-bottom:1px solid var(--line);background:#0c1112;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tab{appearance:none;border:1px solid var(--line);background:#101617;color:var(--muted);border-radius:7px;padding:7px 10px;font:600 11px/1 inherit;white-space:nowrap;cursor:pointer}.tab:hover{color:var(--text);border-color:#3b4b4c}.tab.active{background:#252211;border-color:#6b5727;color:#f2d07e}.badge{display:inline-block;min-width:17px;margin-left:4px;padding:1px 5px;border-radius:10px;background:#263233;color:#dce5e1;font-size:9px;text-align:center}
.panels{overflow:auto;padding:12px;min-height:0}.panel-page{display:none;gap:10px;align-content:start}.panel-page.active{display:grid}.panel-title{margin:2px 2px 0;font-size:18px}.panel-subtitle{margin:-4px 2px 4px;color:var(--muted);font-size:11px}
.command-bar{padding:9px 10px;border-bottom:1px solid var(--line);background:#0a0f10;display:grid;grid-template-columns:1fr auto;gap:7px}.command-bar textarea{resize:vertical;min-height:42px;max-height:130px;border:1px solid var(--line);border-radius:7px;background:#070b0c;color:var(--text);padding:8px 9px;font:12px/1.35 inherit;outline:none}.command-bar textarea:focus{border-color:#7b652e;box-shadow:0 0 0 2px #d4ad5218}.command-bar button{border:1px solid #7b652e;border-radius:7px;background:#302914;color:#f2d07e;padding:0 12px;font-weight:700;cursor:pointer}.command-status{grid-column:1/-1;font-size:10px;color:var(--muted);min-height:12px}.command-status.good{color:var(--green)}.command-status.bad{color:var(--red)}
.card{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:10px;padding:12px;box-shadow:0 8px 22px #0003}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--gold);margin:0 0 10px}.summary{font-size:14px;line-height:1.45}.muted{color:var(--muted)}.small{font-size:11px}
.goal{font-size:17px;font-weight:700;margin-bottom:4px}.tag{display:inline-block;padding:3px 7px;margin:2px 3px 2px 0;border:1px solid var(--line);border-radius:999px;font-size:10px;color:#b9c5c0;background:#0b1011}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.metric{background:#0b1011;border-radius:7px;padding:8px}.metric b{display:block;font-size:17px}.metric span{font-size:10px;color:var(--muted)}
.signal,.blocker,.event,.step{padding:8px 0;border-top:1px solid var(--line)}.signal:first-child,.blocker:first-child,.event:first-child,.step:first-child{border-top:0}.signal b,.blocker b{font-size:12px}.confidence{float:right;color:var(--blue);font-size:10px}
.workflow-head{display:flex;justify-content:space-between;gap:8px}.progress{height:5px;background:#070a0b;border-radius:5px;overflow:hidden;margin:8px 0}.progress>i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),var(--green))}
.step.active{color:#fff}.step.done{color:var(--green)}.step.future{color:var(--muted)}.step-code{font-family:ui-monospace,monospace;font-size:10px;color:#9bb0a8;margin-top:3px}
.event{font-size:11px}.event time{color:var(--muted);margin-right:6px}.event .type{color:var(--gold);font-weight:650}.event pre{white-space:pre-wrap;margin:4px 0 0;color:#acb8b3;font-family:inherit}
.chat-log{display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - 205px);overflow:auto;scrollbar-color:#344443 transparent}.chat-line{display:grid;grid-template-columns:68px minmax(80px,auto) 1fr;gap:8px;padding:7px 8px;border-radius:6px;font-size:12px;line-height:1.35}.chat-line:hover{background:#ffffff08}.chat-time{color:#62716b;font-variant-numeric:tabular-nums}.chat-sender{color:#d8b966;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chat-text{color:#dfe6e2;overflow-wrap:anywhere}.chat-line.self .chat-sender{color:var(--green)}.chat-line.system{background:#0b1011}.chat-line.system .chat-sender{color:#85948e}.chat-line.system .chat-text{color:#a9b5b0;font-style:italic}
.section-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.wide{grid-column:1/-1}
.warning{border-color:#674444;background:#211516}.good{color:var(--green)}.bad{color:var(--red)}
@media(max-width:1200px){.section-grid{grid-template-columns:1fr}}
@media(max-width:1050px){main{grid-template-columns:1fr;grid-template-rows:58vh minmax(600px,auto);height:auto}.game-shell{height:58vh}.dash{min-height:600px}.panels{overflow:visible}.grid2{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<header><div class="brand"><span class="coin"></span>DayTrader Observer</div><div class="status"><span id="conn"><i class="dot"></i>connecting</span><span id="age">state —</span><span>safe summaries, not private chain-of-thought</span></div></header>
<main>
  <section class="game-shell"><div class="game-label">LIVE GAME CLIENT · visual session</div><iframe src="${gameUrl.toString()}" allow="autoplay; fullscreen" title="DayTrader RuneScape client"></iframe></section>
  <aside class="dash">
    <nav class="tabs" aria-label="Observer sections">
      <button class="tab active" data-tab="overview">Overview</button>
      <button class="tab" data-tab="agents">Agents</button>
      <button class="tab" data-tab="workflow">Workflow</button>
      <button class="tab" data-tab="chat">Chat <span class="badge" id="chat-count">0</span></button>
      <button class="tab" data-tab="events">Events</button>
    </nav>
    <form class="command-bar" id="guidance-form">
      <textarea id="guidance-input" maxlength="1000" placeholder="Guide DayTrader… e.g. Character is stuck—diagnose and fix it."></textarea>
      <button type="submit">Send guidance</button>
      <div class="command-status" id="guidance-status">Trusted local guidance goes to the strategist, then the operator.</div>
    </form>
    <div class="panels">
      <section class="panel-page active" data-panel="overview">
        <h1 class="panel-title">Live overview</h1>
        <p class="panel-subtitle">Character state and collection coverage</p>
        <div class="section-grid"><div class="card" id="player"></div><div class="card" id="collection"></div></div>
      </section>
      <section class="panel-page" data-panel="agents">
        <h1 class="panel-title">AI control room</h1>
        <p class="panel-subtitle">Safe decision summaries and explicit rationale—not private chain-of-thought</p>
        <div class="card" id="strategist"></div>
        <div class="card" id="signals"></div>
        <div class="card" id="operator"></div>
        <div class="card" id="guidance"></div>
      </section>
      <section class="panel-page" data-panel="workflow">
        <h1 class="panel-title">Execution</h1>
        <p class="panel-subtitle">Current declarative workflow and progress</p>
        <div class="card" id="workflow"></div>
      </section>
      <section class="panel-page" data-panel="chat">
        <h1 class="panel-title">Game chat</h1>
        <p class="panel-subtitle">Accumulated public, private, self, and game messages</p>
        <div class="card"><div class="chat-log" id="chat"></div></div>
      </section>
      <section class="panel-page" data-panel="events">
        <h1 class="panel-title">Audit stream</h1>
        <p class="panel-subtitle">Agent decisions, workflow repairs, actions, and trade outcomes</p>
        <div class="card" id="events"></div>
      </section>
    </div>
  </aside>
</main>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=t=>!t?'—':Math.max(0,Math.round((Date.now()-t)/1000))+'s ago';
const compact=v=>JSON.stringify(v??{}).replace(/[{}"]/g,'').replace(/,/g,', ');
let activeTab='overview',lastChatKey='',chatInitialized=false,unreadChat=0;
function showTab(name){
 activeTab=name;
 document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===name));
 document.querySelectorAll('.panel-page').forEach(x=>x.classList.toggle('active',x.dataset.panel===name));
 if(name==='chat'){unreadChat=0;document.querySelector('#chat-count').textContent='0';const c=document.querySelector('#chat');requestAnimationFrame(()=>c.scrollTop=c.scrollHeight)}
}
document.querySelectorAll('.tab').forEach(x=>x.addEventListener('click',()=>showTab(x.dataset.tab)));
document.querySelector('#guidance-form').addEventListener('submit',async event=>{
 event.preventDefault();const input=document.querySelector('#guidance-input'),status=document.querySelector('#guidance-status'),text=input.value.trim();
 if(!text)return;status.className='command-status';status.textContent='Sending…';
 try{const response=await fetch('/api/instructions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});const body=await response.json();if(!response.ok)throw new Error(body.error||'Request failed');input.value='';status.className='command-status good';status.textContent='Queued for strategist: '+body.instruction.id}
 catch(error){status.className='command-status bad';status.textContent=String(error)}
});
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
 document.querySelector('#guidance').innerHTML='<h2>Human guidance</h2>'+((d.guidance||[]).length?(d.guidance||[]).map(x=>'<div class="signal"><span class="confidence '+(x.status==='pending'?'bad':x.status==='resolved'?'muted':'good')+'">'+esc(x.status==='applied'?'active':x.status)+'</span><b>'+new Date(x.createdAt).toLocaleTimeString()+'</b><div class="small">'+esc(x.text)+'</div>'+(x.appliedSummary?'<div class="small muted">Applied: '+esc(x.appliedSummary)+'</div>':'')+'</div>').join(''):'<div class="muted small">No human guidance submitted.</div>');
 const w=o.workflow; let wh='<h2>Execution workflow</h2>';
 if(w){const pct=Math.round(100*Math.min(w.stepIndex,w.steps.length)/Math.max(1,w.steps.length));wh+='<div class="workflow-head"><b>'+esc(w.name)+' v'+esc(w.version)+'</b><span class="small muted">step '+(w.stepIndex+1)+'/'+w.steps.length+' · attempt '+w.stepAttempts+'</span></div><div class="small muted">'+esc(w.goal)+'</div><div class="progress"><i style="width:'+pct+'%"></i></div>'+w.steps.map((x,i)=>'<div class="step '+(i<w.stepIndex?'done':i===w.stepIndex?'active':'future')+'"><b>'+(i<w.stepIndex?'✓ ':i===w.stepIndex?'▶ ':'○ ')+esc(x.description)+'</b><div class="step-code">'+esc(compact(x.directive))+' → '+esc(compact(x.completion))+'</div></div>').join('')}else wh+='<div class="muted small">No active workflow.</div>';document.querySelector('#workflow').innerHTML=wh;
 document.querySelector('#collection').innerHTML='<h2>Collection portfolio</h2><div class="grid2"><div class="metric"><b>'+esc(d.collection.observedCount)+'</b><span>items ever observed</span></div><div class="metric"><b>33</b><span>portfolio targets</span></div></div><div style="margin-top:8px">'+(d.collection.recentlyObserved||[]).map(x=>'<span class="tag">'+esc(x.name)+' ×'+esc(x.maxHeld)+'</span>').join('')+'</div>';
 const chat=d.chat||[],latest=chat.at(-1),latestKey=latest?(latest.tick+':'+latest.type+':'+latest.sender+':'+latest.text):'';
 if(chatInitialized&&latestKey&&latestKey!==lastChatKey&&activeTab!=='chat'){const previousIndex=chat.findIndex(x=>(x.tick+':'+x.type+':'+x.sender+':'+x.text)===lastChatKey);unreadChat+=previousIndex>=0?chat.length-previousIndex-1:1}
 if(latestKey)lastChatKey=latestKey;chatInitialized=true;document.querySelector('#chat-count').textContent=String(unreadChat);
 const chatBox=document.querySelector('#chat'),nearBottom=chatBox.scrollHeight-chatBox.scrollTop-chatBox.clientHeight<80;
 chatBox.innerHTML=chat.length?chat.map(x=>'<div class="chat-line '+(x.fromSelf?'self ':'')+(x.type===0?'system':'')+'"><span class="chat-time">'+new Date(x.seenAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'</span><span class="chat-sender">'+esc(x.sender)+'</span><span class="chat-text">'+esc(x.text)+'</span></div>').join(''):'<div class="muted small">No chat observed in this dashboard session yet.</div>';
 if(activeTab==='chat'&&nearBottom)requestAnimationFrame(()=>chatBox.scrollTop=chatBox.scrollHeight);
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
        if (url.pathname === '/api/instructions' && request.method === 'POST') {
            return request
                .json()
                .then(body => {
                    const text =
                        typeof body === 'object' &&
                        body !== null &&
                        'text' in body &&
                        typeof body.text === 'string'
                            ? body.text
                            : '';
                    const instruction = addHumanGuidance(text);
                    return Response.json({ instruction }, { status: 201, headers });
                })
                .catch(error =>
                    Response.json({ error: String(error) }, { status: 400, headers })
                );
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
