import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Response,type fetch} from 'undici';
import {ANTIGRAVITY_MANIFEST,antigravityRelease,installAntigravity,completeAntigravityEntry} from '../src/backend/antigravity-install';
import {installedVersions,UnconfirmedNpmStop} from '../src/backend/member-versions';
import {catalogCandidate} from '../src/backend/executor-catalog';
import {catalogEntry,EXECUTOR_CATALOG} from '../src/shared/executor-catalog';
import {normalizeExecutor} from '../src/shared/defaults';

const version='9.8.7',payload='fixture native executable, never launched';
const release={version,url:`https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1234/windows-x64/cli_windows_x64.exe`,sha512:createHash('sha512').update(payload).digest('hex')};
function download(metadata:unknown=release,body=payload){const requests:string[]=[];return {requests,fetcher:(async(input:unknown)=>{const url=String(input);requests.push(url);return url===ANTIGRAVITY_MANIFEST?Response.json(metadata):new Response(body);}) as typeof fetch};}
const root=()=>mkdtemp(path.join(tmpdir(),'airoom-agy-install-'));

test('release metadata pins version, official origin, file path and SHA-512',()=>{
  assert.deepEqual(antigravityRelease(release,version),release);
  for(const bad of [null,{}, {...release,version:'../bad'},{...release,version:['9.8.7']},{...release,sha512:'bad'},
    {...release,url:release.url+'?override=1'},{...release,url:release.url.replace('storage.googleapis.com','storage.googleapis.com.evil.test')},
    {...release,url:release.url.replace('/antigravity-public/','/another-bucket/')},{...release,url:release.url.replace('https://','https://user:pass@')},
    {...release,url:release.url.replace('windows-x64','linux-x64')}])assert.throws(()=>antigravityRelease(bad,version));
  assert.throws(()=>antigravityRelease(release,'1.2.3'),/不匹配/);
});

test('verified native download publishes only after checking hash and isolated launch; discovery detects tampering',async()=>{
  const data=await root(),dir=path.join(data,'members','antigravity'),d=download();await mkdir(dir,{recursive:true});let verified=0;
  const options={fetcher:d.fetcher,verify:async(file:string,v:string,env:NodeJS.ProcessEnv)=>{verified++;assert.equal(await readFile(file,'utf8'),payload);assert.equal(v,version);assert.ok(env.HOME?.startsWith(dir));assert.equal(env.AGY_TOKEN,undefined);}};
  const result=await installAntigravity(dir,version,{...process.env,AGY_TOKEN:'host'},options);
  assert.equal(verified,1);assert.equal(result.entry,path.join(dir,version,'agy.exe'));assert.equal(completeAntigravityEntry(path.join(dir,version),version),result.entry);
  assert.deepEqual(d.requests,[ANTIGRAVITY_MANIFEST,release.url]);
  assert.deepEqual(installedVersions(data,'antigravity'),[result]);
  await installAntigravity(dir,version,process.env,options);assert.equal(verified,1);assert.equal(d.requests.length,2);
  await writeFile(result.entry,'tampered');assert.equal(completeAntigravityEntry(path.join(dir,version)),undefined);
});

test('checksum failures never launch or publish a program and remove staging',async()=>{
  const dir=await root(),d=download(release,'wrong binary');let verified=false;
  await assert.rejects(installAntigravity(dir,version,process.env,{fetcher:d.fetcher,verify:async()=>{verified=true;}}),/SHA-512/);
  assert.equal(verified,false);assert.deepEqual(await readdir(dir),[]);
});

test('manifest mismatch cannot download a guessed release or replace incomplete files',async()=>{
  const dir=await root(),d=download({...release,version:'1.0.0'});
  await assert.rejects(installAntigravity(dir,version,process.env,{fetcher:d.fetcher}),/不匹配/);assert.equal(d.requests.length,1);assert.deepEqual(await readdir(dir),[]);
  await mkdir(path.join(dir,version));await writeFile(path.join(dir,version,'keep.txt'),'keep');
  await assert.rejects(installAntigravity(dir,version,process.env,{fetcher:d.fetcher}),/不完整/);assert.equal(await readFile(path.join(dir,version,'keep.txt'),'utf8'),'keep');
});

test('failed launch discards staging; unconfirmed process stop preserves it for inspection',async()=>{
  for(const uncertain of [false,true]){
    const dir=await root(),d=download();
    await assert.rejects(installAntigravity(dir,version,process.env,{fetcher:d.fetcher,verify:async()=>{throw uncertain?new UnconfirmedNpmStop('not stopped'):new Error('bad version');}}),uncertain?/not stopped/:/bad version/);
    const names=await readdir(dir);assert.equal(names.length,uncertain?1:0);if(uncertain)assert.ok(names[0].startsWith('.install-'));
  }
});

test('catalog native connection uses the Antigravity adapter and remains editable without changing protocol',()=>{
  const entry=catalogEntry('antigravity');assert.ok(EXECUTOR_CATALOG.includes(entry));assert.equal(entry.distribution,'antigravity-official');
  const candidate=catalogCandidate('antigravity',path.resolve('agy.exe'));
  assert.equal(candidate.adapter,'antigravity');assert.deepEqual(candidate.args,[]);assert.equal(candidate.authentication,'google');
  assert.equal(normalizeExecutor({...candidate,name:'Renamed'},candidate).adapter,'antigravity');
  assert.throws(()=>normalizeExecutor({...candidate,adapter:'acp'},candidate),/连接类型已绑定/);
  assert.throws(()=>normalizeExecutor({...candidate,command:path.resolve('other.exe')},candidate),/版本管理维护/);
});
