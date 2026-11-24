'use strict';
const http=require('node:http');
const bounded=(p)=>{let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test_listener_uncertain')),3000)})]).finally(()=>clearTimeout(timer));};
function listener(app){const server=http.createServer(app),sockets=new Set(),waiters=new Set();let closing=false,closePromise,settle;const startup=new Promise(resolve=>{settle=resolve});
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);if(!sockets.size){for(const done of waiters)done();waiters.clear();}});if(closing)socket.destroy();});
 const close=()=>closePromise??=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 server.once('error',()=>settle(false));server.once('listening',()=>{settle(true);if(closing)void close().catch(()=>{});});
 return {server,async start(){try{try{server.listen(0,'127.0.0.1')}catch(error){settle(false);throw error;}if(!await bounded(startup))throw Error('test_listener_failed');if(closing)throw Error('test_listener_closed');return server.address().port;}catch(error){closing=true;if(server.listening)void close().catch(()=>{});throw error;}},async stop(){closing=true;const listening=await bounded(startup);const closed=listening?close():Promise.resolve();let done;const drained=sockets.size?new Promise(resolve=>{done=resolve;waiters.add(resolve)}):Promise.resolve();for(const socket of sockets)socket.destroy();try{await bounded(Promise.all([closed,drained]));}finally{if(done)waiters.delete(done);}if(sockets.size||server.listening)throw Error('test_listener_uncertain');}};
}
module.exports={listener};
