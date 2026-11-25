import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {RUNTIME_SCRIPT} from '../web/runtime.ts';
function runtime(fetch){
 const win={};vm.runInNewContext(RUNTIME_SCRIPT,{window:win,fetch,document:{documentElement:{setAttribute(){}},querySelector(){return null},addEventListener(){}},localStorage:{getItem(){return null}},setTimeout,clearTimeout,setInterval(){return 0},clearInterval,console});return win.Agnes;
}
test('runtime reads authenticated gallery originals as Blob without forwarding internal option',async()=>{
 let init;
 const blob=new Blob(['original']);
 const A=runtime(async(_path,options)=>{init=options;return {ok:true,status:200,blob:async()=>blob,json:async()=>{throw new Error('binary')}}});
 assert.equal(await A.api('/admin/api/gallery/1/content',{responseType:'blob'}),blob);
 assert.equal(init.credentials,'same-origin');assert.equal(init.responseType,undefined);
});
test('runtime binary failures retain JSON error and status for bootstrap redirect',async()=>{
 const A=runtime(async()=>({ok:false,status:401,json:async()=>({error:{message:'expired',code:'unauthorized'}})}));
 await assert.rejects(()=>A.api('/admin/api/gallery/1/content',{responseType:'blob'}),e=>e.status===401&&e.message==='expired');
});
