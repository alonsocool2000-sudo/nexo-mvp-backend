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

const twoFactorChallenges=new Map();
const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer){let bits=0,value=0,out='';for(const byte of buffer){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=BASE32[(value>>>(bits-5))&31];bits-=5;}}if(bits>0)out+=BASE32[(value<<(5-bits))&31];return out;}
function base32Decode(input){const clean=String(input||'').replace(/=+$/,'').toUpperCase();let bits=0,value=0;const out=[];for(const char of clean){const index=BASE32.indexOf(char);if(index<0)continue;value=(value<<5)|index;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
function totp(secret,offset=0){const key=base32Decode(secret);const counter=Math.floor(Date.now()/30000)+offset;const buffer=Buffer.alloc(8);buffer.writeBigUInt64BE(BigInt(counter));const digest=crypto.createHmac('sha1',key).update(buffer).digest();const start=digest[digest.length-1]&15;const number=((digest[start]&127)<<24)|(digest[start+1]<<16)|(digest[start+2]<<8)|digest[start+3];return String(number%1000000).padStart(6,'0');}
function validTotp(secret,code){const normalized=String(code||'').replace(/\s/g,'');return [-1,0,1].some((offset)=>totp(secret,offset)===normalized);}
function newTwoFactorSecret(){return base32Encode(crypto.randomBytes(20));}
function backupCodes(){return Array.from({length:8},()=>crypto.randomBytes(4).toString('hex').toUpperCase());}
function otpUri(username,secret){return `otpauth://totp/Nexo:${encodeURIComponent(username)}?secret=${secret}&issuer=Nexo&algorithm=SHA1&digits=6&period=30`;}
function issueSession(username){const t=token();sessions.set(t,username);return t;}

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
  if(req.method==='POST'&&url.pathname==='/api/auth/login'){const b=await readBody(req,64000);const username=usernameOf(b.username);const u=db.users[username];if(!u||u.passwordHash!==hash(b.password))return err(res,401,'Неверный логин или пароль.');if(u.twoFactor?.enabled){const challenge=token();twoFactorChallenges.set(challenge,{username,expires:Date.now()+180000});return send(res,200,{requires2FA:true,challengeToken:challenge,user:{username,name:u.name,email:u.email}});}const t=issueSession(username);return send(res,200,{token:t,user:publicUser(username)});}
  if(req.method==='POST'&&url.pathname==='/api/auth/login/2fa'){const b=await readBody(req);const challenge=twoFactorChallenges.get(String(b.challengeToken||''));if(!challenge||challenge.expires<Date.now())return err(res,401,'Сессия двухфакторной проверки истекла.');const u=db.users[challenge.username];let accepted=validTotp(u.twoFactor.secret,b.code);if(!accepted&&Array.isArray(u.twoFactor.backupCodes)){const index=u.twoFactor.backupCodes.indexOf(String(b.code||'').trim().toUpperCase());if(index>=0){u.twoFactor.backupCodes.splice(index,1);accepted=true;saveDb();}}if(!accepted)return err(res,401,'Неверный код 2FA.');twoFactorChallenges.delete(String(b.challengeToken));const t=issueSession(challenge.username);return send(res,200,{token:t,user:publicUser(challenge.username)});}
  const username=auth(req);if(!username)return err(res,401,'Нужна авторизация.');
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){sessions.delete(String(req.headers.authorization||'').slice(7));setOnline(username,false);return send(res,200,{ok:true});}
  if(req.method==='GET'&&url.pathname==='/api/auth/2fa/status'){return send(res,200,{enabled:!!db.users[username].twoFactor?.enabled});}
  if(req.method==='POST'&&url.pathname==='/api/auth/2fa/setup'){const u=db.users[username];if(u.twoFactor?.enabled)return send(res,200,{enabled:true});const secret=newTwoFactorSecret();u.twoFactor={enabled:false,pendingSecret:secret,backupCodes:[]};saveDb();return send(res,200,{enabled:false,secret,otpauth:otpUri(username,secret)});}
  if(req.method==='POST'&&url.pathname==='/api/auth/2fa/enable'){const b=await readBody(req);const u=db.users[username];const secret=u.twoFactor?.pendingSecret;if(!secret||!validTotp(secret,b.code))return err(res,400,'Неверный код из приложения-аутентификатора.');const codes=backupCodes();u.twoFactor={enabled:true,secret,backupCodes:codes};saveDb();return send(res,200,{enabled:true,backupCodes:codes});}
  if(req.method==='POST'&&url.pathname==='/api/auth/2fa/disable'){const b=await readBody(req);const u=db.users[username];if(!u.twoFactor?.enabled||!validTotp(u.twoFactor.secret,b.code))return err(res,400,'Неверный код.');u.twoFactor={enabled:false,pendingSecret:null,backupCodes:[]};saveDb();return send(res,200,{enabled:false});}
  if(req.method==='GET'&&url.pathname==='/api/events')return openEvents(req,res,username);
  if(req.method==='GET'&&url.pathname==='/api/contacts'){const q=String(url.searchParams.get('q')||'').toLowerCase();const contacts=Object.keys(db.users).filter(x=>x!==username).map(publicUser).filter(x=>!q||x.username.includes(q)||x.name.toLowerCase().includes(q));return send(res,200,{contacts});}
  if(req.method==='GET'&&url.pathname==='/api/state')return send(res,200,{state:stateFor(username)});
  if(req.method==='POST'&&url.pathname==='/api/state'){const b=await readBody(req);const s=stateFor(username);if(b.profile)s.profile={...(s.profile||{}),...b.profile};if(b.settings)s.settings={...(s.settings||{}),...b.settings};if(b.chatMeta)s.chatMeta={...s.chatMeta,...b.chatMeta};saveDb();return send(res,200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/ai/reply'){const b=await readBody(req);return send(res,200,{reply:aiReply(b.text)});}
  const message=/^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname);
  if(message&&req.method==='POST'){const chatId=decodeURIComponent(message[1]);const b=await readBody(req);if(!b.text)return err(res,400,'Пустое сообщение.');const msg={id:b.clientMessageId||newId('msg'),from:'me',text:String(b.text).slice(0,20000),type:b.type||'text',rich:!!b.rich,time:b.time||new Date().toISOString()};if(chatId==='ai'){const s=stateFor(username);s.chats[chatId]=s.chats[chatId]||[];if(!s.chats[chatId].some(x=>x.id===msg.id))s.chats[chatId].push(msg);saveDb();return send(res,201,{ok:true,message:msg});}const users=dmUsers(chatId);if(!users.includes(username)||!users.every(x=>db.users[x]))return err(res,403,'Нет доступа к этому чату.');const s=stateFor(username);s.chats[chatId]=s.chats[chatId]||[];if(!s.chats[chatId].some(x=>x.id===msg.id))s.chats[chatId].push(msg);const other=users.find(x=>x!==username);const os=stateFor(other);os.chats[chatId]=os.chats[chatId]||[];const incoming={...msg,from:'them'};os.chats[chatId].push(incoming);sendEvent(other,'message',{chatId,message:incoming});saveDb();return send(res,201,{ok:true,message:msg});}
  const editMatch=/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/edit$/.exec(url.pathname);
  if(editMatch&&req.method==='POST'){const chatId=decodeURIComponent(editMatch[1]);const messageId=decodeURIComponent(editMatch[2]);const users=dmUsers(chatId);if(!users.includes(username)||!users.every(x=>db.users[x]))return err(res,403,'Нет доступа к этому чату.');const b=await readBody(req);const text=String(b.text||'').trim().slice(0,20000);if(!text)return err(res,400,'Пустое сообщение.');for(const owner of users){const list=stateFor(owner).chats[chatId]||[];const item=list.find(x=>x.id===messageId);if(item){item.text=text;item.edited=true;}}const other=users.find(x=>x!==username);sendEvent(other,'message_updated',{chatId,messageId,text,edited:true});saveDb();return send(res,200,{ok:true});}
  const deleteMatch=/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/delete$/.exec(url.pathname);
  if(deleteMatch&&req.method==='POST'){const chatId=decodeURIComponent(deleteMatch[1]);const messageId=decodeURIComponent(deleteMatch[2]);const users=dmUsers(chatId);if(!users.includes(username)||!users.every(x=>db.users[x]))return err(res,403,'Нет доступа к этому чату.');for(const owner of users){const state=stateFor(owner);state.chats[chatId]=(state.chats[chatId]||[]).filter(x=>x.id!==messageId);}const other=users.find(x=>x!==username);sendEvent(other,'message_deleted',{chatId,messageId});saveDb();return send(res,200,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/calls/signal'){const b=await readBody(req);const to=usernameOf(b.to);if(!db.users[to])return err(res,404,'Пользователь не найден.');sendEvent(to,'call',{from:username,fromName:db.users[username].name,callId:b.callId,kind:b.kind,data:b.data,mediaType:b.mediaType==='video'?'video':'audio'});return send(res,200,{ok:true});}
  return err(res,404,'Route not found.');
}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(!url.pathname.startsWith('/api/'))return send(res,404,{message:'Nexo MVP API'});await api(req,res,url);}catch(e){console.error(e);if(!res.headersSent)err(res,e.statusCode||500,e.message);else res.end();}});
server.listen(PORT,HOST,()=>console.log(`Nexo MVP backend: http://${HOST}:${PORT}`));
