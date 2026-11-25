import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const module=await import('../web/generation-references.ts').catch(()=>({}));
const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,4,0,0,0,4]);
function file(bytes=png,name='image.png',type='image/png'){return new File([bytes],name,{type});}
function env(api=async()=>new Blob([png],{type:'image/png'})) {
 const revoked=[];let next=0;
 class Reader { readAsDataURL(blob){blob.arrayBuffer().then(data=>{this.result='data:'+blob.type+';base64,'+Buffer.from(data).toString('base64');this.onload();}).catch(error=>{this.error=error;this.onerror();});} }
 const win={FileReader:Reader,Blob,URL:{createObjectURL(){return 'blob:test/'+(++next)},revokeObjectURL(url){revoked.push(url)}},TextEncoder};
 assert.equal(typeof module.createGenerationReferences,'function');
 return {refs:module.createGenerationReferences(win,api),revoked,win};
}
test('reference files are sniffed rather than trusting extension or declared MIME',async()=>{
 const {refs}=env();
 await refs.addFiles([file(png,'renamed.txt','text/plain'),file(Uint8Array.from([255,216,255,224]),'photo.jpg'),file(new TextEncoder().encode('RIFFxxxxWEBPxxxx'),'photo.webp')]);
 assert.deepEqual(refs.items.map(x=>x.value.split(';')[0]),['data:image/png','data:image/jpeg','data:image/webp']);
 assert.equal(refs.items[0].name,'renamed.txt');
 await assert.rejects(()=>refs.addFiles([file(new TextEncoder().encode('<svg/>'),'bad.png')]),/PNG|JPEG|WebP/);
 assert.equal(refs.items.length,3);
 refs.dispose();
});
test('references order moves first auto input and removal revokes only owned previews',async()=>{
 const {refs,revoked}=env();await refs.addFiles([file()]);await refs.addURL(' https://example.com/a.png ');
 refs.move(refs.items[1].id,-1);assert.equal(refs.items[0].value,'https://example.com/a.png');
 refs.remove(refs.items[1].id);assert.deepEqual(revoked,['blob:test/1']);
 refs.dispose();refs.dispose();assert.equal(revoked.length,1);
});
test('remote URL references reject credentials and protocols without browser fetch',async()=>{
 const {refs}=env();
 for(const value of ['javascript:alert(1)','https://user:password@example.com/a','not a url']) await assert.rejects(()=>refs.addURL(value));
 await refs.addURL('https://example.com/a.png');assert.equal(refs.items[0].previewURL,'');
});
test('gallery reads protected original and duplicate id reuses reference',async()=>{
 const calls=[];const {refs}=env(async(path,options)=>{calls.push([path,options]);return new Blob([png]);});
 await Promise.all([refs.addGalleryImage({id:42}),refs.addGalleryImage({id:42})]);
 assert.equal(refs.items.length,1);assert.equal(refs.items[0].galleryId,42);
 assert.deepEqual(calls,[['/admin/api/gallery/42/content',{responseType:'blob'}]]);
});
test('reference batch is atomic at count and byte limits',async()=>{
 const {refs,revoked}=env();await refs.addURL('https://example.com/a');
 await assert.rejects(()=>refs.addFiles(Array.from({length:16},()=>file())),/16/);
 assert.equal(refs.items.length,1);
 const oversized=new Uint8Array(20*1024*1024+1);oversized.set(png);
 await assert.rejects(()=>refs.addFiles([file(),file(oversized)]),/20/);
 assert.equal(refs.items.length,1);
 const exact=new Uint8Array(20*1024*1024);exact.set(png);await refs.addFiles([file(exact)]);
 assert.equal(refs.items.length,2);
 const additional=new Uint8Array(5*1024*1024);additional.set(png);
 await assert.rejects(()=>refs.addFiles([file(additional)]),/32/);
 assert.equal(refs.items.length,2);refs.dispose();assert.ok(revoked.length>=1);
});
test('failed addition does not poison serial queue and stale completion is discarded',async()=>{
 let resolve;const {refs,revoked}=env(()=>new Promise(r=>{resolve=r}));
 const late=refs.addGalleryImage({id:1});await new Promise(r=>setImmediate(r));refs.dispose();resolve(new Blob([png]));
 await assert.rejects(()=>late,/关闭|释放|不可用/);assert.equal(refs.items.length,0);
 const second=env();await assert.rejects(()=>second.refs.addURL('bad'));await second.refs.addURL('https://example.com/a');assert.equal(second.refs.items.length,1);
 assert.ok(revoked.length<=1);
});
test('embedded reference manager has no hidden import dependencies',async()=>{
 const {win}=env();const factory=vm.runInNewContext('('+module.createGenerationReferences.toString()+')',{URL,Uint8Array,TextEncoder,Promise});
 const refs=factory(win,async()=>new Blob([png]));await refs.addURL('https://example.com/a');assert.equal(refs.items.length,1);refs.dispose();
});
