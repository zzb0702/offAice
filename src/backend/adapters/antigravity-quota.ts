import {stripVTControlCharacters} from 'node:util';

/** Only native /usage TSV rows are accepted; model responses and token counters are not quota data. */
export function antigravityUsageRows(stdout:string){
  return stripVTControlCharacters(stdout).split(/\r?\n/).slice(0,200).flatMap(line=>{
    const fields=line.split('\t').map(value=>value.trim());
    if(fields.length!==4)return [];
    const [group,metric,value,reset]=fields;
    if(!group||group.length>120||/[\x00-\x1f\x7f]/.test(group)||metric.length>120||!/(?:limit|quota) remaining$/i.test(metric))return [];
    const percent=value.match(/^(\d+(?:\.\d+)?)%$/),remainingPercent=percent?Number(percent[1]):NaN;
    const resetsAt=Date.parse(reset)/1000;
    if(!Number.isFinite(remainingPercent)||remainingPercent<0||remainingPercent>100||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(reset)||!Number.isFinite(resetsAt)||resetsAt<=0)return [];
    const period=/^weekly (?:limit|quota) remaining$/i.test(metric)?'seven_day':/^five hour (?:limit|quota) remaining$/i.test(metric)?'five_hour':'current';
    return [{group,period,remainingPercent,resetsAt}];
  });
}
