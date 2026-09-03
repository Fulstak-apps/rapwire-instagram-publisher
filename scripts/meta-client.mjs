export function metaClient(base, token, transport = fetch) {
  const redact=value=>[String(token||''),encodeURIComponent(String(token||''))].filter(Boolean)
    .reduce((message,secret)=>message.replaceAll(secret,'[redacted]'),String(value));
  async function request(method, endpoint, params) {
    const url=new URL(`${base}${endpoint}`);
    const options={method, signal:AbortSignal.timeout(30000)};
    if(method==='GET') for(const [key,value] of Object.entries({...params,access_token:token})) url.searchParams.set(key,value);
    else options.body=new URLSearchParams({...params,access_token:token});
    try {
      const response=await transport(url,options);
      const payload=await response.json();
      if(!response.ok || payload.error) throw Object.assign(new Error(String(payload.error?.message||`HTTP ${response.status}`)),
        {code:payload.error?.code,status:response.status,retryAfter:response.headers.get('retry-after'),definitiveRejection:Boolean(payload.error)&&response.status<500});
      return payload;
    } catch(error) {
      // Fetch and JSON-decoding errors can include the request URL or response
      // body too. Do not preserve a cause or stack containing the credential.
      throw Object.assign(new Error(redact(error?.message||error)),{
        name:redact(error?.name||'Error'),code:error?.code,status:error?.status,
        retryAfter:error?.retryAfter==null?error?.retryAfter:redact(error.retryAfter),
        definitiveRejection:error?.definitiveRejection,
      });
    }
  }
  return {get:(path,params={})=>request('GET',path,params),post:(path,params)=>request('POST',path,params)};
}
export function errorDelay(error, now=Date.now()) {
  const retry=Number(error.retryAfter)*1000 || Math.max(0,Date.parse(error.retryAfter||'')-now) || 0;
  return Math.max(retry,[10,190,200].includes(error.code)?86400000:3600000);
}
