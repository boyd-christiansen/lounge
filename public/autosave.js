// Serialize preference writes. New edits override queued older values; a failed
// request keeps its draft, so neither a slow response nor a retry loses edits.
export function createAutosave({save,onSaved=()=>{},onStatus=()=>{},persist=()=>{},initial={},delayMs=450}){
  let pending={...initial},active=null,running=null,timer=null,error=null;
  const snapshot=()=>({...active,...pending});
  const changed=()=>persist(snapshot());
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}
    if(running)return running;
    if(!Object.keys(pending).length)return Promise.resolve();
    error=null;onStatus('saving');
    running=(async()=>{
      while(Object.keys(pending).length&&!timer){
        active=pending;pending={};changed();
        try{
          const result=await save(active),sent=active;active=null;changed();onSaved(result,sent);
        }catch(cause){pending={...active,...pending};active=null;error=cause;changed();onStatus('error',cause);return;}
      }
      onStatus(Object.keys(pending).length?'saving':'saved');
    })().finally(()=>{running=null;});
    return running;
  }
  return{
    snapshot, get error(){return error;},get dirty(){return !!Object.keys(snapshot()).length;},
    update(patch,{debounce=false}={}){pending={...pending,...patch};error=null;changed();onStatus('saving');if(timer)clearTimeout(timer);timer=null;if(debounce)timer=setTimeout(()=>{timer=null;flush();},delayMs);else flush();},
    flush,retry:flush,
  };
}
