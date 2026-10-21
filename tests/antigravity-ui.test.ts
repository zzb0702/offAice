import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {registerHooks} from 'node:module';
import type {AcpExecutor} from '../src/shared/types';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';

registerHooks({load(url,context,nextLoad){if(/\.(?:webp|png|jpe?g|svg|css)$/.test(url))return {format:'module',source:'export default '+JSON.stringify(url),shortCircuit:true};return nextLoad(url,context);}});
const {AcpFields,acpDraftOf}=await import('../src/renderer/executors');
const {ExecutorCatalog}=await import('../src/renderer/executor-catalog');

test('existing native connection editor does not request ACP arguments',()=>{
  const html=renderToStaticMarkup(React.createElement(AcpFields,{value:{name:'Antigravity',command:'agy.exe',args:'',env:'',adapter:'antigravity'},onChange:()=>{},invoke:async()=>undefined as any}));
  assert.match(html,/Antigravity CLI（agy）/);assert.match(html,/独立账号目录/);assert.match(html,/当前只支持文字/);assert.doesNotMatch(html,/aria-label="启动参数"/);
});

test('catalog is the only add entry and includes Antigravity without a local-program selector',()=>{
  const html=renderToStaticMarkup(React.createElement(ExecutorCatalog,{snapshot:{providers:[],executors:[],settings:DEFAULT_SETTINGS,backendReady:true} as any,invoke:async()=>undefined as any,notify:()=>{},beforeOperation:async()=>{},onSelected:()=>{},onNewMember:()=>{}}));
  assert.match(html,/Antigravity CLI/);assert.match(html,/从清单添加/);assert.doesNotMatch(html,/手动添加|选择本机 agy/);
});

test('editing keeps native connection type and preserves plain variables and encrypted placeholders',()=>{
  const executor:AcpExecutor={id:'acp-agytest00',adapter:'antigravity',name:'AGY',command:'agy.exe',args:[],env:{LANG:'zh_CN'},secretKeys:['CUSTOM_TOKEN'],permissions:{commands:'ask',fileScope:'workspace',network:true},createdAt:'2026-10-20'};
  const draft=acpDraftOf(executor);assert.equal(draft.adapter,'antigravity');assert.match(draft.env,/LANG=zh_CN/);assert.match(draft.env,/CUSTOM_TOKEN=（已加密保存）/);
  const html=renderToStaticMarkup(React.createElement(AcpFields,{value:draft,onChange:()=>{},invoke:async()=>undefined as any,lockAdapter:true}));assert.match(html,/<select[^>]*disabled=""/);
});
