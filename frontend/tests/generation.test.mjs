import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {renderAdminPage} from '../web/ui.ts';
import {safeAdminDestination} from '../web/contracts.ts';
import {generationPayload,expectedGenerationSize} from '../web/generation-contracts.ts';
import {createGenerationReferences} from '../web/generation-references.ts';
const module=await import('../web/generation-controller.ts').catch(()=>({}));
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,4,0,0,0,4]);
const jpeg=Buffer.from([255,216,255,224]);
const webp=Buffer.from('RIFFxxxxWEBPxxxx');
function environment(responder,ready=Promise.resolve(true)){
 assert.equal(typeof module.createGenerationController,'function');
 let sequence=0;const revoked=[],calls=[];
 class Reader{readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result='data:'+blob.type+';base64,'+Buffer.from(b).toString('base64');this.onload()})}}
 const win={Agnes:{ready,api:async(path,options)=>{calls.push([path,options]);if(path==='/v1/models')return {data:[{id:'agnes-image-2.5-flash'}]};if(path==='/admin/api/settings')return {defaultSize:'2K'};if(path.endsWith('/content'))return new Blob([png]);return responder(path,options)}},FileReader:Reader,Blob,TextEncoder,URL:{createObjectURL(){return 'blob:image/'+(++sequence)},revokeObjectURL(url){revoked.push(url)}},atob};
 const helpers={generationPayload,expectedGenerationSize,createGenerationReferences,generationResultBlob:module.generationResultBlob};
 const controller=module.createGenerationController(win,helpers,()=>{});
 return {controller,calls,revoked,win,helpers};
}
function response(){return {data:[{b64_json:png.toString('base64')},{b64_json:jpeg.toString('base64')},{b64_json:webp.toString('base64')}],size:'4x4',created:1};}
test('generate is reachable in both navigation and safe login return',()=>{
 const html=renderAdminPage();assert.match(html,/data-section="generate"/);assert.match(html,/data-nav="generate"/);assert.match(html,/data-bottom-nav="generate"/);
 assert.equal(safeAdminDestination('/admin/generate'),'/admin#generate');assert.equal(safeAdminDestination('#generate'),'/admin#generate');
});
test('controller waits for readiness and applies server defaults only once',async()=>{
 let resolve;const env=environment(()=>response(),new Promise(r=>{resolve=r}));
 const pending=env.controller.initialize();assert.equal(env.calls.length,0);resolve(true);await pending;
 assert.equal(env.controller.snapshot().form.tier,'2K');assert.equal(env.controller.snapshot().form.model,'agnes-image-2.5-flash');
 env.controller.setForm({tier:'3K',prompt:'first'});await env.controller.initialize();assert.equal(env.controller.snapshot().form.tier,'3K');
});
test('submit preserves form, sends budgeted request and selects first actual returned image',async()=>{
 const env=environment(()=>response());await env.controller.initialize();env.controller.setForm({prompt:'  forest  ',n:1});
 await env.controller.submit();const state=env.controller.snapshot();assert.equal(state.form.prompt,'  forest  ');assert.equal(state.results.length,3);assert.equal(state.selected,0);
 const request=env.calls.find(x=>x[0].endsWith('/generations'));const payload=JSON.parse(request[1].body);assert.equal(payload.prompt,'forest');assert.equal(payload.response_format,'b64_json');assert.equal(payload.n,1);
 env.controller.selectResult(2);assert.equal(env.controller.snapshot().selected,2);env.controller.clearPreview();assert.equal(env.controller.snapshot().results.length,0);assert.equal(env.revoked.length,3);
 assert.equal(env.calls.filter(x=>x[1]?.method==='DELETE').length,0);
});
test('clear preview resets all form state and frees references and results without deleting archives',async()=>{
 const env=environment(()=>response());await env.controller.initialize();const defaults=env.controller.snapshot().form;
 await env.controller.addFiles([new Blob([png])]);await env.controller.addGalleryImage({id:5});await env.controller.addURL('https://example.com/ref');
 env.controller.setForm({prompt:'reset me',model:'another-model',n:3,customSize:true,tier:'4K',ratio:'16:9',dimensions:'2048x1024',followReferenceSize:true});
 await env.controller.submit();env.controller.selectResult(2);
 env.controller.setForm({prompt:''});await assert.rejects(()=>env.controller.submit(),/提示词/);
 env.controller.clearPreview();const state=env.controller.snapshot();
 assert.deepEqual(state.form,defaults);assert.deepEqual(state.references,[]);assert.deepEqual(state.results,[]);assert.equal(state.selected,0);assert.equal(state.error,'');assert.equal(state.initialized,true);
 assert.equal(env.revoked.length,5);assert.equal(new Set(env.revoked).size,5);assert.equal(env.calls.filter(x=>x[1]?.method==='DELETE').length,0);
 env.controller.clearPreview();assert.equal(env.revoked.length,5);
 await env.controller.addGalleryImage({id:5});env.controller.setForm({prompt:'after reset'});await env.controller.submit();assert.equal(env.controller.snapshot().results.length,3);
});
test('busy duplicate submission and reference mutation are blocked while old image remains',async()=>{
 let resolve;let current=()=>response();const env=environment(()=>current());await env.controller.initialize();env.controller.setForm({prompt:'forest'});await env.controller.submit();
 current=()=>new Promise(r=>{resolve=r});const pending=env.controller.submit();assert.equal(env.controller.snapshot().busy,true);assert.equal(env.controller.snapshot().results.length,3);
 env.controller.clearPreview();assert.equal(env.controller.snapshot().results.length,3);assert.equal(env.controller.snapshot().form.prompt,'forest');
 await assert.rejects(()=>env.controller.submit());await assert.rejects(()=>env.controller.addGalleryImage({id:1}));env.controller.setForm({prompt:'changed'});assert.equal(env.controller.snapshot().form.prompt,'forest');resolve(response());await pending;assert.equal(env.controller.snapshot().busy,false);
});
test('request failure retains old image selection, references and form and permits retry',async()=>{
 let failed=false;const env=environment(()=>{if(failed)throw new Error('upstream timeout');return response()});await env.controller.initialize();env.controller.setForm({prompt:'forest'});await env.controller.addURL('https://example.com/a');await env.controller.submit();env.controller.selectResult(1);const old=env.controller.snapshot().results[1].url;
 failed=true;await assert.rejects(()=>env.controller.submit(),/timeout/);const state=env.controller.snapshot();assert.equal(state.results[1].url,old);assert.equal(state.selected,1);assert.equal(state.references.length,1);assert.equal(state.form.prompt,'forest');assert.equal(state.busy,false);
 failed=false;await env.controller.submit();assert.equal(env.controller.snapshot().selected,0);
});
test('malformed output keeps old results and frees only incomplete new previews',async()=>{
 let data=response();const env=environment(()=>data);await env.controller.initialize();env.controller.setForm({prompt:'forest'});await env.controller.submit();const old=env.controller.snapshot().results[0].url;
 data={...response(),data:[{b64_json:png.toString('base64')},{b64_json:'bad!'}]};await assert.rejects(()=>env.controller.submit());assert.equal(env.controller.snapshot().results[0].url,old);assert.equal(env.revoked.length,1);
 env.controller.dispose();assert.equal(env.revoked.length,4);
});
test('gallery admission appends without changing form and is deduplicated',async()=>{
 const env=environment(()=>response());await env.controller.initialize();env.controller.setForm({prompt:'unchanged',n:2});await env.controller.addURL('https://example.com/ref');await env.controller.addGalleryImage({id:5});await env.controller.addGalleryImage({id:5});
 assert.equal(env.controller.snapshot().references.length,2);assert.equal(env.controller.snapshot().form.prompt,'unchanged');assert.equal(env.controller.snapshot().form.n,2);
});
test('result MIME is determined by PNG/JPEG/WebP bytes, not assumed PNG',async()=>{
 assert.equal(typeof module.generationResultBlob,'function');
 for(const [bytes,mime]of [[png,'image/png'],[jpeg,'image/jpeg'],[webp,'image/webp']])assert.equal(module.generationResultBlob(bytes.toString('base64'),{atob,Blob}).type,mime);
 assert.throws(()=>module.generationResultBlob('invalid!',{atob,Blob}));
 const large=Buffer.alloc(21*1024*1024);png.copy(large);assert.equal(module.generationResultBlob(large.toString('base64'),{atob,Blob}).size,large.length);
});
test('initialization can recover after the bootstrap readiness promise first resolves false',async()=>{
 const env=environment(()=>response(),Promise.resolve(false));
 await env.controller.initialize();assert.equal(env.calls.length,0);
 env.win.Agnes.ready=Promise.resolve(true);
 await env.controller.initialize();
 assert.equal(env.controller.snapshot().initialized,true);
 assert.equal(env.controller.snapshot().form.model,'agnes-image-2.5-flash');
});

test('controller and result decoder are self-contained when embedded',async()=>{
 const env=environment(()=>response());const create=vm.runInNewContext('('+module.createGenerationController.toString()+')',{Promise,Error,Object,Array,Number,Uint8Array});
 const c=create(env.win,{...env.helpers,generationResultBlob:module.generationResultBlob},()=>{});await c.initialize();c.setForm({prompt:'forest'});await c.submit();assert.equal(c.snapshot().results.length,3);c.dispose();
});
