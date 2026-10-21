import {stripVTControlCharacters} from 'node:util';
import {antigravityUsageRows} from './antigravity-quota';

/** /usage is a native command: do not interpret a model reply or exit code alone as authentication. */
export function antigravityAuthentication(result:{code:number|null;stdout:string;stderr:string}):'account'|'none'|'unknown'{
  const stdout=stripVTControlCharacters(result.stdout),stderr=stripVTControlCharacters(result.stderr),text=stdout+'\n'+stderr;
  if(/\b(?:authentication required|not logged (?:in|into)|not signed in|you are not authenticated|unauthenticated|please (?:log|sign) in|(?:authentication|credentials?) (?:expired|invalid|missing)|(?:invalid|expired|revoked) (?:access |refresh )?token)\b|未登录|请先登录|登录已(?:失效|过期)/i.test(text))return 'none';
  if(result.code!==0)return 'unknown';
  if(/\b(?:network|fetch|connection|request|refresh)\b.{0,80}\b(?:error|failed|failure|unavailable|timeout)\b|\b(?:failed|unable) to (?:fetch|refresh|retrieve|load)\b/i.test(stderr))return 'unknown';
  return antigravityUsageRows(stdout).length?'account':'unknown';
}
