require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const CLIP_MS = 10000;
const ANSWER_MS = 5000;
const REVEAL_MS = 3000;
const rooms = new Map();

app.use(express.json());
app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ ok: true }));

function decodeText(v = '') {
  return String(v).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}
function isoSeconds(v = 'PT0S') {
  const m = String(v).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? Number(m[1]||0)*3600 + Number(m[2]||0)*60 + Number(m[3]||0) : 0;
}
function shuffled(a) { return [...a].sort(() => Math.random() - 0.5); }
function roomCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out='';
  do { out=Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); } while(rooms.has(out));
  return out;
}
function cleanRoom(v){ return String(v||'').trim().toUpperCase(); }
function clearTimers(r){ (r.timers||[]).forEach(clearTimeout); r.timers=[]; }
function state(r){
  return {room:r.code,phase:r.phase,index:r.index,totalQuestions:r.quiz.length,playerCount:r.players.size,
    players:[...r.players.values()].map(p=>({name:p.name,score:p.score,answered:p.answered})).sort((a,b)=>b.score-a.score)};
}
function broadcast(r){ io.to(r.code).emit('room-state',state(r)); }
function publicQuestion(r){
  const q=r.quiz[r.index];
  return {title:'Listen to the 10-second clip',category:q.category,decade:q.decade,videoId:q.videoId,startSeconds:q.startSeconds,clipSeconds:10,index:r.index,total:r.quiz.length};
}
function answerQuestion(r){ const q=r.quiz[r.index]; return {choices:q.choices,answerSeconds:5}; }
function revealQuestion(r){ const q=r.quiz[r.index]; return {correctIndex:q.correctIndex,correctAnswer:q.choices[q.correctIndex],choices:q.choices}; }

async function generateYouTubeQuiz({decade='All',count=10}) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured');
  const wanted=Math.max(3,Math.min(Number(count)||10,20));
  const query=`${decade==='All'?'popular music':decade+' music'} official audio`;
  const u=new URL('https://www.googleapis.com/youtube/v3/search');
  u.searchParams.set('part','snippet'); u.searchParams.set('type','video'); u.searchParams.set('videoEmbeddable','true');
  u.searchParams.set('safeSearch','strict'); u.searchParams.set('maxResults',String(Math.min(50,wanted*4))); u.searchParams.set('q',query); u.searchParams.set('key',process.env.YOUTUBE_API_KEY);
  const sr=await fetch(u); const sd=await sr.json();
  if(!sr.ok) throw new Error(sd?.error?.message || 'YouTube search failed');
  const ids=(sd.items||[]).map(x=>x.id?.videoId).filter(Boolean);
  if(!ids.length) throw new Error('No matching YouTube videos found');
  const vu=new URL('https://www.googleapis.com/youtube/v3/videos');
  vu.searchParams.set('part','snippet,contentDetails,status'); vu.searchParams.set('id',ids.join(',')); vu.searchParams.set('key',process.env.YOUTUBE_API_KEY);
  const vr=await fetch(vu); const vd=await vr.json();
  if(!vr.ok) throw new Error(vd?.error?.message || 'YouTube video lookup failed');
  const pool=(vd.items||[]).map(v=>({id:v.id,title:decodeText(v.snippet?.title),seconds:isoSeconds(v.contentDetails?.duration),embeddable:v.status?.embeddable})).filter(v=>v.embeddable&&v.seconds>=45&&v.title);
  if(pool.length<4) throw new Error('Not enough embeddable music videos found');
  return shuffled(pool).slice(0,Math.min(wanted,pool.length)).map(v=>{
    const choices=shuffled([v.title,...shuffled(pool.filter(x=>x.id!==v.id)).slice(0,3).map(x=>x.title)]);
    const maxStart=Math.max(15,v.seconds-15);
    const start=15+Math.floor(Math.random()*Math.max(1,maxStart-14));
    return {category:'Music',decade,title:'Which YouTube video is this?',videoId:v.id,startSeconds:start,clipSeconds:10,choices,correctIndex:choices.indexOf(v.title)};
  });
}

function finishRoom(r){ clearTimers(r); r.phase='finished'; io.to(r.code).emit('finished',state(r)); broadcast(r); }
function startQuestion(r){
  clearTimers(r); r.index++;
  if(r.index>=r.quiz.length) return finishRoom(r);
  r.phase='clip'; r.answered.clear(); for(const p of r.players.values()) p.answered=false;
  io.to(r.code).emit('question',publicQuestion(r)); broadcast(r);
  r.timers.push(setTimeout(()=>{
    if(!rooms.has(r.code)) return;
    r.phase='answer'; io.to(r.code).emit('answer-open',answerQuestion(r)); broadcast(r);
    r.timers.push(setTimeout(()=>{
      if(!rooms.has(r.code)) return;
      r.phase='reveal'; io.to(r.code).emit('reveal',revealQuestion(r)); broadcast(r);
      r.timers.push(setTimeout(()=>startQuestion(r),REVEAL_MS));
    },ANSWER_MS));
  },CLIP_MS));
}

io.on('connection', socket=>{
  socket.on('host-create', async ({decade='All',count=10}={}, ack=()=>{})=>{
    try {
      const quiz=await generateYouTubeQuiz({decade,count});
      const code=roomCode(); const origin=(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/,'');
      const joinUrl=`${origin}/join.html?room=${code}`;
      const r={code,hostId:socket.id,phase:'lobby',index:-1,quiz,players:new Map(),answered:new Set(),timers:[]};
      rooms.set(code,r); socket.join(code); socket.data={role:'host',room:code};
      const qr=await QRCode.toDataURL(joinUrl,{width:360,margin:2,errorCorrectionLevel:'M'});
      ack({ok:true,room:code,joinUrl,qr,state:state(r)}); broadcast(r);
    } catch(e){ ack({ok:false,error:e.message}); }
  });
  socket.on('player-join',({room,name}={},ack=()=>{})=>{
    room=cleanRoom(room); name=String(name||'').trim().slice(0,24); const r=rooms.get(room);
    if(!r) return ack({ok:false,error:'Room not found'}); if(!name) return ack({ok:false,error:'Enter a display name'}); if(r.phase==='finished') return ack({ok:false,error:'Quiz finished'});
    r.players.set(socket.id,{name,score:0,answered:false}); socket.join(room); socket.data={role:'player',room}; ack({ok:true}); broadcast(r);
  });
  socket.on('host-start',({room}={},ack=()=>{})=>{
    room=cleanRoom(room); const r=rooms.get(room); if(!r||socket.id!==r.hostId) return ack({ok:false,error:'Host session not found'});
    if(r.phase!=='lobby') return ack({ok:false,error:'Quiz already started'}); startQuestion(r); ack({ok:true});
  });
  socket.on('answer',({room,choice}={},ack=()=>{})=>{
    room=cleanRoom(room); const r=rooms.get(room); const p=r?.players.get(socket.id);
    if(!r||!p) return ack({ok:false,error:'Player session not found'}); if(r.phase!=='answer') return ack({ok:false,error:'Answering is closed'}); if(r.answered.has(socket.id)) return ack({ok:false,error:'Answer already submitted'});
    const q=r.quiz[r.index]; const correct=Number(choice)===q.correctIndex; r.answered.add(socket.id); p.answered=true; if(correct)p.score+=100; ack({ok:true,correct}); broadcast(r);
  });
  socket.on('disconnect',()=>{
    const {room,role}=socket.data||{}; const r=rooms.get(room); if(!r)return;
    if(role==='player'){r.players.delete(socket.id);broadcast(r);} else if(role==='host'){clearTimers(r);io.to(room).emit('host-left');rooms.delete(room);}
  });
});
server.listen(PORT,'0.0.0.0',()=>console.log(`YoutubeClipQuiz running on port ${PORT}`));
