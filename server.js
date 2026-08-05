const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_ORIGIN = process.env.WEB_ORIGIN || '*';
const DATA_FILE = process.env.NEXO_DATA_FILE || path.join(__dirname, 'nexo-mvp-data.json');
const db = loadDb();
const sessions = new Map();
const pending = new Map();
const clients = new Map();
const online = new Set();

function loadDb(){
  try{return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch{return {users:{},states:{}};}
}
let saveTimer;
function saveDb(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{fs.writeFileSync(DATA_FILE+'.tmp',JSON.stringify(db,null,2));fs.renameSync(DATA_FILE+'.tmp',DATA_FILE);}catch(error){console.error(error.message);}},80);}
const usernameOf=(v)=>String(v||'').trim().toLowerCase();
const newId=(p='id')=>p+'_'+crypto.randomBytes(10).toString('hex');
const token=()=>crypto.randomBytes(32).toString('hex');
const hash=(v)=>crypto.createHash('sha256').update(String(v)).digest('hex');
function send(res,status,payload,extra={}){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':WEB_ORIGIN,'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Content-Length':Buffer.byteLength(body),...extra});res.end(body);}
function err(res,status,message,code='error'){return send(res,status,{error:message,code});}
function readBody(req,max=8*1024*1024){return new Promise((resolve,reject)=>{let body='';let size=0;req.setEncoding('utf8');req.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>max){reject(Object.assign(new Error('Слишком большой запрос'),{statusCode:413}));req.destroy();return;}body+=chunk;});req.on('end',()=>{if(!body)return resolve({});try{resolve(JSON.parse(body));}catch{reject(Object.assign(new Error('Некорректный JSON'),{statusCode:400}));}});req.on('error',reject);});}
function auth(req){const h=String(req.headers.authorization||'');const t=h.startsWith('Bearer ')?h.slice(7):'';return t&&sessions.get(t)||null;}
function stateFor(username){db.states[username]=db.states[username]||{chats:{},groups:[],chatMeta:{},profile:null,settings:null};return db.states[username];}
function dmUsers(chatId){const m=/^dm:([^:]+):([^:]+)$/.exec(chatId);return m?[m[1],m[2]]:[];}
function sendEvent(username,event,payload){for(const res of clients.get(username)||[]){try{res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);}catch{}}}
function setOnline(username,value){if(value)online.add(username);else online.delete(username);}
function openEvents(req,res,username){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','Access-Control-Allow-Origin':WEB_ORIGIN,'Access-Control-Allow-Headers':'Authorization','X-Accel-Buffering':'no'});res.write(': '+ ' '.repeat(2048)+'\n\n');res.write(`event: ready\ndata: ${JSON.stringify({username})}\n\n`);if(!clients.has(username))clients.set(username,new Set());clients.get(username).add(res);setOnline(username,true);const close=()=>{clients.get(username)?.delete(res);if(!clients.get(username)?.size){clients.delete(username);setOnline(username,false);}};req.on('close',close);}
function publicUser(username){const u=db.users[username];return u?{username,name:u.name,email:u.email,online:online.has(username)}:null;}
function aiReply(text){const t=String(text||'').trim().toLowerCase();if(!t)return 'Напиши вопрос — я помогу.';if(t.includes('что ты умеешь')||t==='help')return '🤖 Я помогу с планами, кодом, текстами, расчётами и идеями. Для настоящей модели AI позже подключим отдельный AI API.';if(/^[\d\s+\-*/().,^]+$/.test(t)&&/[+\-*/]/.test(t)){try{const r=Function('return ('+t.replace(/\^/g,'**')+')')();if(Number.isFinite(r))return '🧮 Результат: '+r;}catch{}}if(t.includes('привет'))return 'Привет! Backend подключён.';return 'Сообщение получено. Опиши задачу подробнее.';}
async function api(req,res,url){
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':WEB_ORIGIN,'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});return res.end();}
  if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,service:'nexo-mvp-backend',mode:'mvp-no-e2ee'});
  if(req.method==='POST'&&url.pathname==='/api/auth/register/start'){const b=await readBody(req,128000);const username=usernameOf(b.username);const email=String(b.email||'').trim().toLowerCase();const name=String(b.name||'').trim().slice(0,80);const password=String(b.password||'');if(!name||!email||!username||password.length<6)return err(res,400,'Заполни поля и используй пароль от 6 символов.');if(db.users[username])return err(res,409,'Логин уже занят.');const code=String(crypto.randomInt(100000,1000000));pending.set(username,{name,email,password,code,expires:Date.now()+600000});console.log('Код регистрации для',username,code);return send(res,200,{ok:true,devCode:code});}
  if(req.method==='POST'&&url.pathname==='/api/auth/register/confirm'){const b=await readBody(req,64000);const username=usernameOf(b.username);const p=pending.get(username);if(!p||p.expires<Date.now()||String(b.code)!==p.code)return err(res,400,'Неверный или просроченный код.');db.users[username]={name:p.name,email:p.email,passwordHash:hash(p.password),createdAt:new Date().toISOString()};stateFor(username);pending.delete(username);saveDb();return send(res,201,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/auth/login'){const b=await readBody(req,64000);const username=usernameOf(b.username);const u=db.users[username];if(!u||u.passwordHash!==hash(b.password))return err(res,401,'Неверный логин или пароль.');const t=token();sessions.set(t,username);return send(res,200,{token:t,user:publicUser(username)});}
  const username=auth(req);if(!username)return err(res,401,'Нужна авторизация.');
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){sessions.delete(String(req.headers.authorization||'').slice(7));setOnline(username,false);return send(res,200,{ok:true});}
  if(req.method==='GET'&&url.pathname==='/api/events')return openEvents(req,res,username);
  if(req.method==='GET'&&url.pathname==='/api/contacts'){const q=String(url.searchParams.get('q')||'').toLowerCase();const contacts=Object.keys(db.users).filter(x=>x!==username).map(publicUser).filter(x=>!q||x.username.includes(q)||x.name.toLowerCase().includes(q));return send(res,200,{contacts});}
  if(req.method==='GET'&&url.pathname==='/api/state')return send(res,200,{state:stateFor(username)});
  if(req.method==='POST'&&url.pathname==='/api/state'){const b=await readBody(req);const s=stateFor(username);if(b.profile)s.profile={...(s.profile||{}),...b.profile};if(b.settings)s.settings={...(s.settings||{}),...b.settings};if(b.chatMeta)s.chatMeta={...s.chatMeta,...b.chatMeta};saveDb();return send(res,200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/ai/reply'){const b=await readBody(req);return send(res,200,{reply:aiReply(b.text)});}
  const message=/^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname);
  if(message&&req.method==='POST'){const chatId=decodeURIComponent(message[1]);const users=dmUsers(chatId);if(!users.includes(username)||!users.every(x=>db.users[x]))return err(res,403,'Нет доступа к этому чату.');const b=await readBody(req);if(!b.text)return err(res,400,'Пустое сообщение.');const msg={id:b.clientMessageId||newId('msg'),from:'me',text:String(b.text).slice(0,20000),type:b.type||'text',rich:!!b.rich,time:b.time||new Date().toISOString()};const s=stateFor(username);s.chats[chatId]=s.chats[chatId]||[];if(!s.chats[chatId].some(x=>x.id===msg.id))s.chats[chatId].push(msg);const other=users.find(x=>x!==username);const os=stateFor(other);os.chats[chatId]=os.chats[chatId]||[];const incoming={...msg,from:'them'};os.chats[chatId].push(incoming);sendEvent(other,'message',{chatId,message:incoming});saveDb();return send(res,201,{ok:true,message:msg});}
  if(req.method==='POST'&&url.pathname==='/api/calls/signal'){const b=await readBody(req);const to=usernameOf(b.to);if(!db.users[to])return err(res,404,'Пользователь не найден.');sendEvent(to,'call',{from:username,fromName:db.users[username].name,callId:b.callId,kind:b.kind,data:b.data,mediaType:b.mediaType==='video'?'video':'audio'});return send(res,200,{ok:true});}
  return err(res,404,'Route not found.');
}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(!url.pathname.startsWith('/api/'))return send(res,404,{message:'Nexo MVP API'});await api(req,res,url);}catch(e){console.error(e);if(!res.headersSent)err(res,e.statusCode||500,e.message);else res.end();}});
server.listen(PORT,HOST,()=>console.log(`Nexo MVP backend: http://${HOST}:${PORT}`));
