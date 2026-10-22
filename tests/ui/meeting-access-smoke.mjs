import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';
import {resolveRoomAccess} from '../../src/shared/room-permissions.ts';

if(!process.env.AIROOM_TEST_PROFILE)throw Error('Use isolated test bootstrap.');
let browser,page;
const root=path.join(process.env.AIROOM_TEST_PROFILE,'meeting-ui'),cwd=path.join(root,'project');await mkdir(cwd,{recursive:true});
const engine=new Engine(path.join(root,'data'),event=>{if(page)void page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),event).catch(()=>{});},()=>{},()=>({async probe(){return {available:false};},async stop(){}}),{maintenanceOnly:true});
const at=new Date().toISOString(),project={id:'meeting-ui-project',name:'协作权限测试',directory:cwd,createdAt:at,collaborationPaused:false,memberIds:['meeting-ds']};
const full={commands:'auto',fileScope:'any',network:true};
const member={id:'meeting-ds',executor:'dsh',name:'DS',templateId:'dsh',createdAt:at};
engine.store.put('projects',project.id,project);engine.store.ensureProjectRoom(project.id);engine.store.put('members',member.id,member);
engine.settings={...engine.settings,permissions:{...engine.settings.permissions,dsh:full}};engine.store.put('settings','main',engine.settings);
const roomId='project:'+project.id,thread=engine.store.currentRoomThread(roomId),access=resolveRoomAccess('collaborate',cwd,full,true);
const session={id:'ui-meeting-session',projectId:project.id,provider:'dsh',memberId:member.id,title:'DS',createdAt:at,updatedAt:at,revision:1,writeMode:true};
const run={id:'ui-meeting-run',sessionId:session.id,projectId:project.id,provider:'dsh',revision:1,status:'ended',createdAt:at,updatedAt:at,bootId:'fixture',input:'UI fixture',delivery:'confirmed',roomAccess:access};
engine.store.put('sessions',session.id,session);engine.store.put('runs',run.id,run);engine.store.put('room_messages','meeting-result',{id:'meeting-result',threadId:thread.id,author:member.id,text:'已读取参考文件并完成检查。',at,status:'done',runId:run.id});
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0},logLevel:'error'});
try {
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(15_000);
  await page.exposeFunction('__invoke',(method,params)=>engine.invoke(method,params));
  await page.addInitScript(()=>{localStorage.setItem('airoom.theme','dark');window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>window.__listeners=window.__listeners.filter(x=>x!==fn);}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:project.name,exact:true}).click();
  const mode=page.getByLabel('会议权限模式');await mode.waitFor();assert.equal(await mode.inputValue(),'collaborate');
  await page.getByText('查看成员实际权限与工作目录',{exact:true}).click();
  const panel=page.getByRole('region',{name:'会议室实际权限'}); // section with accessible name
  await panel.locator('li').first().waitFor({state:'visible'});
  assert.match(await panel.innerText(),/DS.*命令自动允许.*文件范围不限制/s);
  assert.match(await page.locator('[data-message-id="meeting-result"] .room-access-receipt').innerText(),/本轮权限：协作工作/);
  await mode.selectOption('read-only');await page.waitForFunction(()=>document.querySelector('.meeting-access')?.textContent.includes('禁止命令'));
  assert.equal(engine.store.get('projects',project.id).meetingMode,'read-only');
  assert.match(await panel.innerText(),/禁止命令/);assert.equal(engine.settings.permissions.dsh.commands,'auto','room mode does not overwrite member defaults');
  assert.match(await page.locator('[data-message-id="meeting-result"] .room-access-receipt').innerText(),/协作工作/,'historical receipt retains the old admitted mode');
  await mkdir('tests/ui/results',{recursive:true});await page.screenshot({path:'tests/ui/results/meeting-access-readonly.png',fullPage:true});
  await mode.selectOption('collaborate');await page.waitForFunction(()=>document.querySelector('.meeting-access li')?.textContent.includes('命令自动允许'));
  await page.reload();await page.getByRole('button',{name:project.name,exact:true}).click();await mode.waitFor();assert.equal(await mode.inputValue(),'collaborate');
  await page.screenshot({path:'tests/ui/results/meeting-access-desktop.png',fullPage:true});
  await page.setViewportSize({width:700,height:900});
  const bounds=await mode.evaluate(el=>({right:el.getBoundingClientRect().right,width:innerWidth,panelRight:el.closest('.meeting-access').getBoundingClientRect().right}));assert.ok(bounds.right<=Math.min(bounds.width,bounds.panelRight)+1,'mode selector stays inside its room, not under the project board');
  await page.screenshot({path:'tests/ui/results/meeting-access-narrow.png',fullPage:true});
  // The real status bar distinguishes a one-round skip from a member needing manual rejoin.
  const discussion={id:'recovery-ui',members:[member.id],phase:'waiting_user',revision:1,style:'work',seen:{},lastSpoke:{},priority:[],calls:1,limit:0,allowance:0,minutes:0,deadline:0,questions:[],reviewRequired:[],noProgress:0,latestUserId:''};
  for(const [kind,failures,unknown,expected] of [['temporary',1,false,'下一次发消息时自动重新参与'],['repeated',3,false,'连续 3 次失败'],['unknown',1,true,'上次请求结果未知']]) {
    engine.store.put('room_states',roomId,{...engine.store.roomState(roomId),active:false,mode:'discuss',discussion:{...discussion,memberFailures:{[member.id]:failures},skippedMembers:{[member.id]:{reason:'模拟回复异常',runId:'previous-request',unknown}},...(unknown?{unknownRunId:'previous-request'}:{})}});
    await page.reload();await page.getByRole('button',{name:project.name,exact:true}).click();
    const presence=page.getByRole('region',{name:'在场与讨论状态'});await presence.getByText(new RegExp(expected)).waitFor();
    assert.match(await presence.innerText(),kind==='temporary'?/本轮跳过/:/待重新加入/);
    if(kind==='temporary')await page.screenshot({path:'tests/ui/results/discussion-recovery-narrow.png',fullPage:true});
  }
  await writeFile('tests/ui/results/meeting-access-verification.json',JSON.stringify({passed:true,scope:'real Engine and React UI with isolated synthetic project; no model calls',checks:['project mode visible','effective per-member permissions','mode persists across reload','read-only does not overwrite member permissions','historical per-turn permission receipt unchanged','narrow layout']},null,2)+'\n');
  console.log('Meeting access and discussion recovery UI smoke passed.');
} catch(e){await mkdir('tests/ui/results',{recursive:true});if(page){await page.screenshot({path:'tests/ui/results/meeting-access-error.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-1600));}throw e;
} finally {await browser?.close();await server.close();await engine.close();}
