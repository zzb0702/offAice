type Selection={providerId:string;modelId:string;options?:{reasoningLevel?:string}};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** ZCode's decoder requires both rule containers, even for an account-only profile.
 * Older AIROOM logins wrote just defaultModelSelection; native recovery then discarded
 * the entire file, including a per-run model override, and used the catalog fallback.
 */
export function zcodeProviderConfig(value:unknown,selection:Selection):{schemaVersion:1;config:Record<string,any>&{defaultModelSelection:Selection}}{
  const fail=()=>{throw new Error('ZCode 模型配置格式或版本不受支持，未发送任务；请检查执行端配置。');};
  if(!object(value))return fail();
  if(value.schemaVersion!==undefined&&value.schemaVersion!==1)return fail();
  if(Object.keys(value).some(key=>!['schemaVersion','config'].includes(key)))return fail();
  const config=value.config===undefined?{}:value.config;
  if(!object(config)||Object.keys(config).some(key=>!['providerOrder','providerConfigRules','modelConfigRules','defaultModelSelection'].includes(key)))return fail();
  const providers=config.providerConfigRules===undefined?{providerRules:[]}:config.providerConfigRules;
  const models=config.modelConfigRules===undefined?{providerModelRules:[],manualProviderModelRules:[]}:config.modelConfigRules;
  if(!object(providers)||!Array.isArray(providers.providerRules)||!object(models)||!Array.isArray(models.providerModelRules)||!Array.isArray(models.manualProviderModelRules))return fail();
  return {schemaVersion:1,config:{...config,providerConfigRules:providers,modelConfigRules:models,defaultModelSelection:selection}};
}
