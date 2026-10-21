import type {AccountCredits,CreditsBucket} from './types';
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:undefined;
const percent=(value:unknown)=>{const n=count(value);return n!==undefined&&n<=100?n:undefined;};
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length<=max&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():undefined;

/** Native account fields only: user IDs, avatar/upgrade URLs and session counters never leave the backend. */
export function projectQoderUsage(payload:unknown){
  const data=object(payload),result:Record<string,any>={};
  const plan=text(data.userType,80);if(plan)result.userType=plan;
  const overall=percent(data.totalUsagePercentage);if(overall!==undefined)result.totalUsagePercentage=overall;
  if(typeof data.isQuotaExceeded==='boolean')result.isQuotaExceeded=data.isQuotaExceeded;
  const expiry=count(data.expiresAt);if(expiry!==undefined)result.expiresAt=expiry;
  for(const name of ['userQuota','addOnQuota','orgResourcePackage']){
    const raw=object(data[name]),bucket:Record<string,any>={};
    for(const key of name==='orgResourcePackage'?['cap','used','remaining']:['total','used','remaining']){const value=count(raw[key]);if(value!==undefined)bucket[key]=value;}
    const ratio=percent(raw.percentage);if(ratio!==undefined)bucket.percentage=ratio;
    const unit=text(raw.unit,32);if(unit)bucket.unit=unit;
    if(typeof raw.available==='boolean')bucket.available=raw.available;
    if(Object.keys(bucket).some(key=>['total','cap','used','remaining','percentage'].includes(key)))result[name]=bucket;
  }
  return result;
}

export function qoderCreditsReport(payload:unknown,checkedAt:string):AccountCredits{
  const data=projectQoderUsage(payload),buckets:CreditsBucket[]=[];
  for(const [key,id,label]of [['userQuota','plan','套餐 Credits'],['addOnQuota','addon','附加 Credits'],['orgResourcePackage','organization','组织资源包']] as const){
    const row=data[key];if(!row)continue;
    const total=count(key==='orgResourcePackage'?row.cap:row.total),used=count(row.used),remaining=count(row.remaining);
    let usedPercent=percent(row.percentage);
    if(total!==undefined&&total>0&&used!==undefined)usedPercent=Math.min(100,used/total*100);
    else if(total!==undefined&&total>0&&remaining!==undefined&&remaining<=total)usedPercent=100-remaining/total*100;
    buckets.push({id,label,...(total!==undefined?{total}:{}),...(used!==undefined?{used}:{}),...(remaining!==undefined?{remaining}:{}),...(usedPercent!==undefined?{usedPercent}:{}),...(row.unit?{unit:row.unit}:{}),...(typeof row.available==='boolean'?{available:row.available}:{})});
  }
  const expiry=count(data.expiresAt),seconds=expiry!==undefined?(expiry>=1e12?expiry/1000:expiry):undefined;
  const expiresAt=seconds!==undefined&&seconds>=946684800&&seconds<=4102444800?seconds:undefined;
  const usedPercent=percent(data.totalUsagePercentage),exhausted=typeof data.isQuotaExceeded==='boolean'?data.isQuotaExceeded:undefined;
  return {status:buckets.length||usedPercent!==undefined||exhausted!==undefined?'ready':'unavailable',buckets,checkedAt,
    ...(data.userType?{plan:data.userType}:{}),...(expiresAt!==undefined?{expiresAt}:{}),...(usedPercent!==undefined?{usedPercent}:{}),...(exhausted!==undefined?{exhausted}:{})};
}

export function creditsFresh(credits:AccountCredits|undefined,now=Date.now()){
  if(!credits||credits.status!=='ready')return false;
  const at=Date.parse(credits.checkedAt);return Number.isFinite(at)&&now>=at&&now-at<=15*60_000;
}
/** Buckets can be alternatives. Only the native account aggregate may limit all model calls. */
export function creditsExhausted(credits:AccountCredits|undefined,now=Date.now()){
  return creditsFresh(credits,now)&&(credits!.exhausted===true||credits!.exhausted!==false&&credits!.usedPercent===100);
}
