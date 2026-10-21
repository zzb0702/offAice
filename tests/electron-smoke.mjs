import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {_electron} from '@playwright/test';

// The public repository snapshot omitted its original desktop tests. This smoke
// checks the built app and its real IPC using a disposable signed-out profile.
if(!process.env.AIROOM_TEST_PROFILE||!process.env.AIROOM_SMOKE_APP_ROOT||!process.env.AIROOM_ELECTRON_EXE)throw new Error('Use scripts/desktop-smoke.mjs with its isolated runtime.');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:env.AIROOM_ELECTRON_EXE,args:[env.AIROOM_SMOKE_APP_ROOT],env,timeout:60_000});
try{
  const page=await app.firstWindow();
  await page.waitForFunction(async()=>{
    try{return (await window.airoom.invoke('snapshot')).backendReady===true;}catch{return false;}
  },undefined,{timeout:60_000});
  await page.getByRole('button',{name:'设置与连接',exact:true}).click({timeout:60_000});
  assert.equal(await page.getByRole('button',{name:'手动添加',exact:true}).count(),0);
  if(!await page.getByRole('group',{name:'官方执行端清单',exact:true}).isVisible())await page.getByRole('button',{name:'从清单添加',exact:true}).click();
  await page.getByRole('group',{name:'官方执行端清单',exact:true}).getByRole('button',{name:/^Antigravity CLI/}).click();
  await page.getByRole('button',{name:'下载并自动配置',exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'我已了解并同意该厂商条款',exact:true}).check();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent?.includes('下载并自动配置')&&!button.disabled));
  const catalog=await page.evaluate(()=>window.airoom.invoke('catalog.list'));
  assert.ok(catalog.items.some(item=>item.entry.id==='antigravity'));
  assert.equal(await page.getByRole('button',{name:'选择本机 agy',exact:true}).count(),0);
  await mkdir('tests/results',{recursive:true});
  await page.screenshot({path:path.resolve('tests/results/antigravity-desktop.png')});
  assert.equal(await app.evaluate(({app})=>app.getPath('userData').includes(process.env.AIROOM_TEST_PROFILE)),true);
  console.log('Desktop smoke passed: built Electron app, actual IPC/settings UI and Antigravity catalog card. Isolated signed-out profile; no login or model task.');
}finally{await app.close();}
