import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {mkdir,open,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {fetch,ProxyAgent} from 'undici';
import {spawnCli} from './adapters/common';
import {antigravityEnvironment} from './adapters/antigravity-policy';
import {waitForNpmOutput,UnconfirmedNpmStop,type InstallProgress} from './member-versions';

export const ANTIGRAVITY_MANIFEST='https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json';
// Snapshot of the official Windows manifest, checked against Google's installer.
const PINNED={version:'1.4.3',url:'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.3-4577820882632704/windows-x64/cli_windows_x64.exe',sha512:'a9afa6f290b1fe91e75c363090d3c42995d086b63c65683030b2f81b073ea7d16c46156fa52746ea2109606465d9993c0ff02713646d75cb33b44a6780cb0cde'};
const MARKER='.airoom-install.json',ENTRY='agy.exe',VERSION=/^\d+\.\d+\.\d+$/;
export function antigravityRelease(metadata:unknown,expected?:string){
  const value=metadata as typeof PINNED;
  if(!value||typeof value.version!=='string'||typeof value.url!=='string'||typeof value.sha512!=='string'||!VERSION.test(value.version)||expected&&value.version!==expected||! /^[a-f0-9]{128}$/i.test(value.sha512))throw new Error('Antigravity 官方发行校验清单无效或版本不匹配。');
  const url=new URL(value.url);
  if(url.origin!=='https://storage.googleapis.com'||url.username||url.password||url.search||url.hash||!new RegExp('^/antigravity-public/antigravity-cli/'+value.version.replaceAll('.','\\.')+'-\\d+/windows-x64/cli_windows_x64\\.exe$').test(url.pathname))throw new Error('Antigravity 下载地址不属于官方 Windows 发行目录。');
  return {version:value.version,url:url.href,sha512:value.sha512.toLowerCase()};
}
const hashes=new Map<string,{stamp:string;hash:string}>();
function hashFile(file:string){
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Antigravity 程序文件不是普通文件。');
  const stamp=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');let cached=hashes.get(file);
  if(!cached||cached.stamp!==stamp){cached={stamp,hash:createHash('sha512').update(readFileSync(file)).digest('hex')};if(hashes.size>1000)hashes.clear();hashes.set(file,cached);}
  return {size:info.size,hash:cached.hash};
}
export function completeAntigravityEntry(prefix:string,version?:string):string|undefined{
  try{
    const markerFile=path.join(prefix,MARKER);
    if(lstatSync(prefix).isSymbolicLink()||!lstatSync(markerFile).isFile()||lstatSync(markerFile).isSymbolicLink())return;
    const marker=JSON.parse(readFileSync(markerFile,'utf8'));
    if(marker.schema!==1||marker.member!=='antigravity'||marker.entry!==ENTRY||version&&marker.version!==version)return;
    const release=antigravityRelease({version:marker.version,url:marker.source,sha512:marker.sha512},version);
    if(release.version===PINNED.version&&(release.sha512!==PINNED.sha512||release.url!==PINNED.url))return;
    const entry=path.join(prefix,ENTRY),facts=hashFile(entry);
    if(facts.size!==marker.entrySize||facts.hash!==release.sha512)return;
    return entry;
  }catch{return;}
}
export async function latestAntigravityVersion(env:NodeJS.ProcessEnv){
  const proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  try{
    const response=await fetch(ANTIGRAVITY_MANIFEST,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error('Antigravity 官方版本查询失败。');
    return antigravityRelease(await response.json()).version;
  }finally{await proxy?.close();}
}
export interface AntigravityInstallOptions {
  progress?:(value:InstallProgress)=>void;
  fetcher?:typeof fetch;
  verify?:(entry:string,version:string,env:NodeJS.ProcessEnv,cwd:string)=>Promise<void>;
  publish?:(source:string,target:string)=>Promise<void>;
}
/** Fetch and hash the native executable; never execute Google's PATH-changing installer. */
export async function installAntigravity(root:string,version:string,env:NodeJS.ProcessEnv,options:AntigravityInstallOptions={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Antigravity 自动下载目前支持 Windows x64。');
  if(!VERSION.test(version))throw new Error('Antigravity 版本号无效。');
  root=path.resolve(root);const target=path.join(root,version),existing=completeAntigravityEntry(target,version);if(existing)return {version,entry:existing};
  if(existsSync(target))throw new Error('这个 Antigravity 版本不完整，请先核对已有文件。');
  if(lstatSync(root).isSymbolicLink())throw new Error('Antigravity 安装目录不能是链接。');
  const stage=path.join(root,'.install-'+version+'-'+randomUUID()),proxy=env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined,download=options.fetcher??fetch;
  await mkdir(stage);let preserve=false;
  try{
    let release=PINNED;
    if(version!==PINNED.version){
      const manifest=await download(ANTIGRAVITY_MANIFEST,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(30_000)});
      if(!manifest.ok)throw new Error('Antigravity 官方发行清单下载失败。');
      release=antigravityRelease(await manifest.json(),version);
    }
    const response=await download(release.url,{dispatcher:proxy,redirect:'error',signal:AbortSignal.timeout(15*60_000)});
    if(!response.ok||!response.body)throw new Error('Antigravity 官方程序下载失败。');
    const file=await open(path.join(stage,ENTRY),'wx',0o600),hash=createHash('sha512');let size=0,last=0;
    try{for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>512*1024*1024)throw new Error('Antigravity 下载文件大小异常。');await file.writeFile(bytes);hash.update(bytes);if(Date.now()-last>1000){options.progress?.({phase:'installing',writtenBytes:size,lastProgressAt:new Date().toISOString()});last=Date.now();}}}finally{await file.close();}
    if(!size||hash.digest('hex')!==release.sha512)throw new Error('Antigravity 下载文件与官方 SHA-512 不一致，未启用。');
    options.progress?.({phase:'files',writtenBytes:size});const entry=path.join(stage,ENTRY);
    const {home,env:checkEnv}=antigravityEnvironment({id:'acp-agycheck00',name:'Check',adapter:'antigravity',command:entry,args:[],env:{},createdAt:'',permissions:{commands:'deny',fileScope:'workspace',network:false}}, {...env,AIROOM_ACP_HOME:path.join(stage,'.check-home')});await mkdir(home,{recursive:true});
    options.progress?.({phase:'launch'});
    if(options.verify)await options.verify(entry,version,checkEnv,home);
    else{
      const check=await waitForNpmOutput(spawnCli({command:entry,path:entry,prefix:[]},['--version'],{env:checkEnv,cwd:home}),30_000);
      if(check.code!==0||check.stdout.trim()!==version)throw new Error('Antigravity 官方程序版本启动检查失败。');
    }
    const checkRoot=path.join(stage,'.check-home');if(path.dirname(checkRoot)!==stage||lstatSync(checkRoot).isSymbolicLink())throw new Error('Antigravity 检查目录不安全。');
    await rm(checkRoot,{recursive:true,force:true});
    await writeFile(path.join(stage,MARKER),JSON.stringify({schema:1,member:'antigravity',version,entry:ENTRY,entrySize:size,source:release.url,sha512:release.sha512}));
    if(path.dirname(stage)!==root||path.dirname(target)!==root||lstatSync(root).isSymbolicLink())throw new Error('Antigravity 安装路径超出管理范围。');
    await (options.publish??rename)(stage,target);return {version,entry:path.join(target,ENTRY)};
  }catch(error){if(error instanceof UnconfirmedNpmStop)preserve=true;throw error;}
  finally{await proxy?.close();if(!preserve&&existsSync(stage)&&path.dirname(stage)===root&&!lstatSync(stage).isSymbolicLink())await rm(stage,{recursive:true,force:true});}
}
