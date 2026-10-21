import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {connect} from 'node:net';
import {_electron} from '@playwright/test';
import electron from 'electron';
import {developmentRuntime} from '../scripts/development-runtime.mjs';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {portableNode} from '../src/backend/portable-node-path.ts';
import {Store} from '../src/backend/store.ts';
import {DEFAULT_SETTINGS} from '../src/shared/defaults.ts';
import {zcodeCredentialCipher} from '../src/backend/zcode-login.ts';

const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());
delete env.ELECTRON_RUN_AS_NODE;env.AIROOM_NODE_EXE=portableNode(path.resolve('.airoom'))??process.execPath;
const cert=path.join(directory,'fixture-ca.pem'),certKey=path.join(directory,'fixture-ca.key');
await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',certKey,'-out',cert,'-sha256','-days','1','-subj','/CN=bigmodel.cn','-addext','subjectAltName=DNS:bigmodel.cn,DNS:api.z.ai','-addext','basicConstraints=critical,CA:TRUE'],{windowsHide:true});
env.NODE_EXTRA_CA_CERTS=cert;
const id='acp-catalogzcode',home=path.join(env.AIROOM_ACP_HOME,id),command=path.join(directory,'program','zcode.cjs'),provider='official-bigmodel',key='fixture-zcode-quota-key',nextKey='fixture-next-account-key';
await mkdir(path.join(home,'.zcode','v2'),{recursive:true});await mkdir(path.join(path.dirname(command),'provider'),{recursive:true});
await writeFile(path.join(path.dirname(command),'provider','zcode-builtin.json'),JSON.stringify({revision:1,config:{providerConfigRules:{providerRules:[{providerId:provider,config:{access:{type:'zhipu-account',accountType:'bigmodel',mode:'individual-coding-plan'},builtinModelIds:['test-model']}}]}}}));
await writeFile(path.join(home,'.zcode','v2','provider_config.json'),JSON.stringify({config:{defaultModelSelection:{providerId:provider,modelId:'test-model'}}}));
const cipher=zcodeCredentialCipher(home,env);
async function account(identity,apiKey){
  const values={'oauth:active_provider':'bigmodel','oauth:bigmodel:access_token':'fixture-oauth',zcodejwttoken:'fixture-jwt',[`account-provider:${provider}:identity`]:identity,[`account-provider:coding-plan:${provider}:account:${encodeURIComponent(identity)}:api-key`]:apiKey};
  await writeFile(path.join(home,'.zcode','v2','credentials.json'),JSON.stringify(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,cipher.encrypt(v)]))));
}
await account('fixture-account',key);
await writeFile(command,String.raw`
const readline=require('node:readline'),args=process.argv.slice(2);
if(args[0]==='doctor'){console.log(JSON.stringify({cli:{name:'zcode',version:'0.16.9'}}));process.exit(0);}
if(args[0]!=='app-server')throw Error('Quota test must not run model tasks');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const msg=JSON.parse(line);if(!['provider/updateAccountConfig','session/create','session/close'].includes(msg.method))throw Error('Unexpected model operation: '+msg.method);
const result=msg.method==='session/create'?{protocol:{name:'ZCode Protocol',version:1},session:{sessionId:'quota-fixture'},settings:{model:{current:{providerId:'official-bigmodel',modelId:'test-model'},available:[{ref:{providerId:'official-bigmodel',modelId:'test-model'},label:'Fixture model'}]}}}:{};
console.log(JSON.stringify({id:msg.id,result}));});
`);
let state='initial',expectedKey=key,app;
const requests=[],sockets=new Set();
const server=httpsServer({key:await readFile(certKey),cert:await readFile(cert)},(req,res)=>{
  requests.push({host:req.headers.host,path:req.url,credentialMatches:req.headers.authorization===expectedKey,state});
  if(req.url!=='/api/monitor/usage/quota/limit'||req.headers.authorization!==expectedKey){res.writeHead(401,{'content-type':'application/json'});res.end('{"code":401}');return;}
  res.writeHead(state==='unauthorized'?401:200,{'content-type':'application/json','connection':'close'});
  if(state==='malformed'){res.end('{"code":200,"success":true,"data":{"limits":[{"type":"UNKNOWN"}]}}');return;}
  if(state==='unauthorized'){res.end('{"code":401}');return;}
  const at=Date.now(),limits=[{type:'TOKENS_LIMIT',unit:3,number:5,percentage:state==='initial'?25:40,nextResetTime:at+3600_000},{type:'TIME_LIMIT',unit:5,number:1,percentage:100,nextResetTime:at+10*86400_000}];
  if(state!=='narrow')limits.push({type:'CREDIT_LIMIT',unit:6,number:1,percentage:10,nextResetTime:at+3*86400_000});
  res.end(JSON.stringify({code:200,success:true,data:{limits}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const proxy=httpServer((_req,res)=>{res.writeHead(502);res.end();});
proxy.on('connect',(req,client,head)=>{
  if(!['bigmodel.cn:443','api.z.ai:443'].includes(req.url)){client.destroy();return;}
  sockets.add(client);client.on('close',()=>sockets.delete(client));
  const upstream=connect(server.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const store=new Store(env.AIROOM_DATA_DIR);
store.put('settings','main',{...DEFAULT_SETTINGS,nodeRuntime:'local',theme:'dark',networkMode:'proxy',proxyUrl:`http://127.0.0.1:${proxy.address().port}`});
store.put('executors',id,{id,name:'ZCode CLI',catalogId:'zcode',command,args:[],env:{},authentication:'bigmodel',permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'});
store.put('members','member-glm',{id:'member-glm',executor:id,name:'GLM',templateId:'dsh',color:'#be4b8b',talkativeness:'quiet',createdAt:'2026-10-21'});store.close();
const executablePath=await developmentRuntime(electron);
async function launch(){
  app=await _electron.launch({executablePath,args:[process.cwd()],env,timeout:60_000});
  const page=await app.firstWindow();
  await page.waitForFunction(async id=>{try{return (await window.airoom.invoke('snapshot')).quotas?.[id]?.queryStatus==='ready';}catch{return false;}},id,{timeout:60_000});
  await page.getByRole('button',{name:'用量与额度',exact:true}).click();return page;
}
const snapshot=page=>page.evaluate(()=>window.airoom.invoke('snapshot'));
try{
  let page=await launch(),card;
  const section=()=>page.getByRole('dialog',{name:'用量与额度',exact:true}).locator('section').filter({hasText:'GLM'});card=section();
  await card.getByText('剩 75%',{exact:true}).waitFor();await card.getByText('每周',{exact:true}).waitFor();await card.getByText('每月 MCP',{exact:true}).waitFor();
  assert.equal(await card.getByText('MCP 工具额度已用完，不影响普通模型发言',{exact:false}).count(),1);
  assert.equal(await card.getByText(/自动发言已暂停/).count(),0);
  let value=await snapshot(page);assert.equal(value.quotas[id].kind,'coding-plan');assert.ok(!JSON.stringify(value).includes(key));
  await mkdir('tests/results',{recursive:true});await page.screenshot({path:'tests/results/zcode-quota-desktop.png',fullPage:true});
  async function refresh(next){
    state=next;const before=(await snapshot(page)).quotas?.[id]?.checkedAt;
    await card.getByRole('button',{name:'刷新额度',exact:true}).click();
    await page.waitForFunction(async ({id,before})=>(await window.airoom.invoke('snapshot')).quotas?.[id]?.checkedAt!==before,{id,before},{timeout:30_000});
  }
  await refresh('updated');await card.getByText('剩 60%',{exact:true}).waitFor();
  await refresh('malformed');await card.getByText(/暂未提供可验证的额度数据/).waitFor();assert.equal((await snapshot(page)).quotas[id].windows.length,0);
  await refresh('unauthorized');assert.equal((await snapshot(page)).quotas[id].windows.length,0);assert.equal((await snapshot(page)).providers.find(p=>p.id===id).auth,'subscription');
  expectedKey=nextKey;await account('fixture-next-account',nextKey);
  assert.equal((await snapshot(page)).quotas[id],undefined);
  await refresh('narrow');await card.getByText('剩 60%',{exact:true}).waitFor();assert.equal(await card.getByText('每周',{exact:true}).count(),0);
  await app.close();app=undefined;page=await launch();card=section();await card.getByText('剩 60%',{exact:true}).waitFor();
  const before=requests.length;
  await page.evaluate(()=>window.airoom.invoke('catalog.credentials',{id:'zcode',authentication:'custom-api',clear:true,model:'fixture-relay',baseUrl:'https://relay.example/v1'}));
  await card.getByText(/不查询 ZCode 官方 Coding Plan 额度/).waitFor();assert.equal(await card.getByRole('button',{name:'刷新额度',exact:true}).count(),0);
  const denied=await page.evaluate(async id=>{try{await window.airoom.invoke('provider.quota',{provider:id});return false;}catch{return true;}},id);assert.equal(denied,true);
  assert.equal(requests.length,before);assert.ok(requests.every(x=>x.host==='bigmodel.cn'&&x.path==='/api/monitor/usage/quota/limit'&&x.credentialMatches));
  const report={passed:true,scope:'real Electron, backend, encrypted fixture credentials and HTTPS quota client; simulated official host through local TLS proxy, no real account',checks:['official login probe publishes Coding Plan quota','5h, weekly and MCP display separately','tool-only exhaustion never claims model calls are paused','refresh changes values and malformed/401 responses clear old values without logging out','native credential changes invalidate old account cache','missing weekly window is hidden','restart refresh works','custom API mode hides official quota refresh and rejects official query','all requests stay on pinned official host and use exactly selected fixture account'],requests:requests.length,profile:directory,screenshot:path.resolve('tests/results/zcode-quota-desktop.png')};
  await writeFile('tests/results/zcode-quota-desktop.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await app?.close();for(const socket of sockets)socket.destroy();server.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>proxy.close(resolve))]);}
