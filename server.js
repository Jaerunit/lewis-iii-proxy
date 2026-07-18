// ============================================================
//  LEWIS III — proxy + scheduler
//
//  Solves two things at once:
//   1. CORS. Your browser can't talk to AzuraCast directly (shared host
//      won't set the header). This server CAN — servers have no CORS limit —
//      and it adds the header for you. Point Lewis III at THIS instead of
//      AzuraCast and every call works: push, files, voice-track audio.
//   2. 24/7 scheduling. It also keeps the AzuraCast queue full on its own,
//      so your log plays around the clock with no browser open.
//
//  Environment variables (Railway -> Variables):
//    AZ_URL   https://a9.asurahosting.com
//    AZ_SID   red_cup_and_rnb
//    AZ_KEY   your AzuraCast API key
//    RUN_SCHEDULER  "1" to auto-push the log 24/7, else proxy-only (default off)
//    QUEUE_MIN      tracks to keep queued ahead (default 6)
// ============================================================

const http = require('http');
const { URL } = require('url');

const AZ_URL = (process.env.AZ_URL || 'https://a9.asurahosting.com').replace(/\/+$/, '');
const AZ_SID = process.env.AZ_SID || 'red_cup_and_rnb';
const AZ_KEY = process.env.AZ_KEY || '';
const RUN_SCHEDULER = process.env.RUN_SCHEDULER === '1';
const QUEUE_MIN = parseInt(process.env.QUEUE_MIN || '6', 10);
const PORT = process.env.PORT || 3000;

if (!AZ_KEY) console.warn('WARNING: AZ_KEY not set - authed calls will fail.');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Lewis III proxy up.\nForwarding to ' + AZ_URL + '\nScheduler: ' + (RUN_SCHEDULER ? 'ON' : 'off') + '\n');
    return;
  }

  if (u.pathname.startsWith('/proxy/')) {
    const target = AZ_URL + '/' + u.pathname.slice('/proxy/'.length) + u.search;
    try {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          'X-API-Key': AZ_KEY,
          'Accept': req.headers['accept'] || '*/*',
          ...(body ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {}),
        },
        body,
      });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy failed', detail: String(e.message) }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Lewis III proxy on :' + PORT + ' -> ' + AZ_URL + ' (scheduler ' + (RUN_SCHEDULER ? 'ON' : 'off') + ')');
});

// ---------- optional 24/7 scheduler ----------
if (RUN_SCHEDULER) {
  const CATS = { toh:{imaging:1}, gold:{}, throw:{}, uptempo:{}, slow:{}, vt:{imaging:1}, drop:{imaging:1}, id:{imaging:1} };
  const CLOCKS = {
    morning:['toh','gold','vt','gold','throw','gold','vt','drop','id','gold','uptempo','gold','vt','drop'],
    midday: ['toh','gold','vt','gold','throw','gold','vt','drop','drop','id','uptempo','gold','throw','gold','vt','drop','drop'],
    drive:  ['toh','uptempo','vt','uptempo','throw','gold','vt','drop','drop','id','uptempo','gold','throw','uptempo','vt','drop'],
    night:  ['toh','slow','vt','slow','gold','slow','drop','id','slow','slow','gold','slow'],
  };
  const DAY = Array.from({length:24}, (_,h)=> h>=6&&h<10?'morning':h>=10&&h<14?'midday':h>=14&&h<19?'drive':'night');
  const PL_TO_CAT = { 'l3 gold':'gold','l3 throwbacks':'throw','l3 uptempo':'uptempo','l3 slow jams':'slow','l3 top of hour':'toh','l3 voice track':'vt','l3 drop / promo':'drop','l3 sweeper / id':'id' };

  const azApi = async (path, opts={}) => {
    const r = await fetch(AZ_URL + path, { ...opts, headers:{ 'X-API-Key':AZ_KEY, 'Accept':'application/json', ...(opts.body?{'Content-Type':'application/json'}:{}) }});
    const t = await r.text(); let d; try{ d=JSON.parse(t);}catch{d=t;}
    if(!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
    return d;
  };
  const primary = a => !a ? '' : String(a).split(/\s*(?:feat\.?|ft\.?|featuring|with|&|,|\bx\b|\+|vs\.?|and)\s*/i)[0].toLowerCase().replace(/[^a-z0-9]/g,'');
  const played = new Map(); const recent = []; let slot = 0;
  const catOf = f => { for(const pl of (f.playlists||[])){ const k=String(pl.name||pl).toLowerCase(); if(PL_TO_CAT[k]) return PL_TO_CAT[k]; } return null; };
  const pick = pool => {
    if(!pool.length) return null;
    const byAge=[...pool].sort((a,b)=>(played.get(a.id)??-1e9)-(played.get(b.id)??-1e9));
    const p = byAge.find(m=>!recent.includes(primary(m.artist)))||byAge[0];
    played.set(p.id,slot); const pa=primary(p.artist); if(pa){recent.push(pa); if(recent.length>4)recent.shift();} slot++; return p;
  };
  async function buildHour(){
    const files = await azApi('/api/station/' + AZ_SID + '/files');
    const byCat={}; Object.keys(CATS).forEach(c=>byCat[c]=[]);
    for(const f of (Array.isArray(files)?files:[])){ const c=catOf(f); if(c) byCat[c].push({id:f.id,artist:f.artist||'',len:f.length||180}); }
    const clock = CLOCKS[DAY[new Date().getHours()]]||CLOCKS.midday;
    const ids=[]; let secs=0;
    for(const cat of clock){ const pl=byCat[cat]||[]; if(!pl.length) continue; const p=pick(pl); if(p){ids.push(p.id);secs+=p.len;} }
    const music=['gold','throw','uptempo','slow'].sort((a,b)=>(byCat[b]?.length||0)-(byCat[a]?.length||0));
    let g=0; while(secs<3580 && music.some(c=>byCat[c]?.length) && g++<60){ for(const c of music){ if(!byCat[c]?.length) continue; const p=pick(byCat[c]); if(p){ids.push(p.id);secs+=p.len;} break; } }
    return ids;
  }
  async function topUp(){
    let queued=0; try{ const q=await azApi('/api/station/' + AZ_SID + '/queue'); queued=Array.isArray(q)?q.length:0; }catch{}
    if(queued>=QUEUE_MIN) return;
    const ids=await buildHour(); let added=0;
    for(const id of ids){ if(queued+added>=QUEUE_MIN) break; try{ await azApi('/api/station/' + AZ_SID + '/queue',{method:'POST',body:JSON.stringify({media_id:id})}); added++; }catch(e){ console.error('push failed:',e.message); break; } }
    if(added) console.log('[' + new Date().toISOString() + '] queue ' + queued + ' -> +' + added);
  }
  setInterval(()=>topUp().catch(e=>console.error(e.message)), 60000);
  topUp().catch(e=>console.error(e.message));
}
