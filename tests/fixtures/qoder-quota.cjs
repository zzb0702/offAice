const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),args=process.argv.slice(2);
const state=()=>{try{return fs.readFileSync(process.env.TEST_QUOTA_STATE,'utf8').trim();}catch{return 'initial';}};
const record=value=>{if(process.env.TEST_QUOTA_CALLS)fs.appendFileSync(process.env.TEST_QUOTA_CALLS,JSON.stringify(value)+'\n');};
record({kind:'launch',args});
if(!args.includes('--acp')&&!args.includes('--print'))throw Error('Quota fixture forbids other operations');
const input=readline.createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
input.on('line',line=>{
  const message=JSON.parse(line);record({kind:'input',message});
  if(args.includes('--acp')){
    if(message.method==='initialize')send({id:message.id,result:{protocolVersion:1,agentInfo:{name:'Qoder CN',version:'1.1.67'},agentCapabilities:{loadSession:true},authMethods:[]}});
    else if(message.method==='session/new')send({id:message.id,result:{sessionId:'fixture-acp-session'}});
    else throw Error('Quota probe must not send ACP prompts');
    return;
  }
  if(message.type!=='control_request')return;
  const type=message.request?.type,current=state();
  const response=value=>send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:value}});
  if(type==='initialize'){response({account:{accountType:'fixture'},capabilities:[]});return;}
  if(type!=='get_usage_info')throw Error('Unexpected quota control type');
  if(current==='timeout')return;
  if(current==='malformed'){process.stdout.write('{bad-json}\n');return;}
  if(current==='wrong-id'){send({type:'control_response',response:{subtype:'success',request_id:'wrong',response:{usage:{}}}});return;}
  if(current==='callback'){send({type:'control_request',request_id:'unsafe',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'forbidden'}}});return;}
  if(current==='unsupported'){send({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'fixture-secret-must-not-leak'}});return;}
  if(current==='session-only'){response({usage:null,session:{total_credits:42,model_usage:{test:{credits:42}}}});return;}
  if(current==='changed'){
    const config=process.env.QODERCN_CONFIG_DIR??process.env.QODER_CONFIG_DIR;
    fs.writeFileSync(path.join(config,'.auth','user'),'fixture-other-account');
  }
  const updated=current==='updated'||current==='changed';
  const usage={userId:'fixture-private-user',userType:'Pro',totalUsagePercentage:updated?50:70,isQuotaExceeded:current==='exhausted',expiresAt:Math.floor(Date.now()/1000)+86400,upgradeUrl:'https://private.example/upgrade',
    userQuota:{total:100,used:updated?80:100,remaining:updated?20:0,percentage:updated?80:100,unit:'Credits'},
    addOnQuota:{total:50,used:5,remaining:45,percentage:10,unit:'Credits',detailUrl:'https://private.example/details'},
    orgResourcePackage:{cap:200,used:20,remaining:180,percentage:10,available:true,unit:'Credits'}};
  if(current==='exhausted'){usage.totalUsagePercentage=100;usage.addOnQuota.remaining=0;usage.addOnQuota.used=50;usage.orgResourcePackage.remaining=0;usage.orgResourcePackage.used=200;}
  if(current==='narrow')delete usage.orgResourcePackage;
  response({usage,session:{total_credits:42}});
});
