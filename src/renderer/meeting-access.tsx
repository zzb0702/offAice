import {useState} from 'react';
import type {Project, Snapshot} from '../shared/types';
import {memberPermissions} from '../shared/permissions';
import {meetingMode, resolveRoomAccess, roomAccessText, type MeetingMode} from '../shared/room-permissions';
import type {Invoke} from './ui';
import './meeting-access.css';

export function MeetingAccess({project, snapshot, members, invoke}: {project:Project; snapshot:Snapshot; members:string[]; invoke:Invoke}) {
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const mode=meetingMode(project);
  async function change(value:MeetingMode) {
    setSaving(true);setError('');
    try {await invoke('project.update',{projectId:project.id,meetingMode:value});}
    catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }
  return <section className="meeting-access" aria-label="会议室实际权限">
    <label>会议权限<select aria-label="会议权限模式" value={mode} disabled={saving} onChange={e=>void change(e.target.value as MeetingMode)}>
      <option value="collaborate">协作工作 · 继承成员权限</option><option value="read-only">只读讨论 · 不修改文件</option>
    </select></label>
    <p>{mode==='collaborate'?'按成员设置调用工具，修改直接保存在项目目录。':'可以读取和搜索文件；禁止修改文件和执行命令。'} 模式修改从下一轮生效，在途请求保持原权限。</p>
    <details><summary>查看成员实际权限与工作目录</summary><p className="meeting-directory">工作目录：{project.directory}</p>
      <ul>{members.map(id=>{
        const member=snapshot.members.find(m=>m.id===id);if(!member)return null;
        const executor=snapshot.executors?.find(e=>e.id===member.executor);
        const permissions=memberPermissions(snapshot.settings,member,executor);
        const access=resolveRoomAccess(mode,project.directory,permissions,snapshot.settings.defaultAutoApprove);
        const info=snapshot.providers.find(p=>p.id===member.executor);
        return <li key={id}><strong>{member.name}</strong><span>{roomAccessText(access)}</span>
          {info?.permissionSupport?.commandWriteIsolation==='approval-only'&&<small>操作限制依赖执行端报告的审批；原生能力以执行端为准。</small>}
          {executor?.catalogId==='zcode'&&permissions.fileScope==='workspace'&&<small>ZCode 未提供可核对的项目读取隔离，本轮会在请求前说明限制。</small>}
        </li>;
      })}</ul>
    </details>
    {error&&<p role="alert" className="room-error">{error}</p>}
  </section>;
}
