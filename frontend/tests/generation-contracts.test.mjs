import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const module = await import('../web/generation-contracts.ts').catch(() => ({}));
const form = {prompt:'  forest  ', model:'agnes-image-2.5-flash', n:1, customSize:false, tier:'2K', ratio:'4:3', dimensions:'1536x1024'};

test('generation payload trims prompt and uses the real Base64 delivery contract', () => {
 assert.equal(typeof module.generationPayload, 'function');
 assert.deepEqual(module.generationPayload(form, []), {prompt:'forest',model:form.model,n:1,size:'2K',ratio:'4:3',response_format:'b64_json'});
});
test('generation rejects invalid count, prompt, model and unsupported dimensions', () => {
 assert.equal(typeof module.generationPayload, 'function');
 for (const patch of [{n:0},{n:1.5},{n:''},{n:Infinity},{prompt:' '},{model:''},{tier:'8K'},{ratio:'5:7'},{customSize:true,dimensions:'0x1024'},{customSize:true,dimensions:'1000000x1024'},{customSize:true,dimensions:''},{customSize:true,dimensions:'1536'},{customSize:true,dimensions:'1.5x1024'},{customSize:true,dimensions:'-1x1024'},{customSize:true,dimensions:'1536x1024px'},{customSize:true,dimensions:'1024x0'}]) {
  assert.throws(() => module.generationPayload({...form,...patch}, []));
 }
 assert.equal(module.generationPayload({...form,n:100}, []).n,100);
});
test('auto uses first reference and custom dimensions omit independent ratio', () => {
 assert.equal(typeof module.generationPayload, 'function');
 assert.throws(()=>module.generationPayload({...form,followReferenceSize:true}, []));
 const refs=[{value:'https://images.example/first.png'},{value:'https://images.example/second.png'}];
 const body=module.generationPayload({...form,followReferenceSize:true},refs);
 assert.equal(body.size,'auto'); assert.equal(body.ratio,undefined);
 assert.deepEqual(body.images, refs.map(x=>x.value));
 const custom=module.generationPayload({...form,customSize:true}, []);
 assert.equal(custom.size,'1536x1024'); assert.equal(custom.ratio,undefined);
 const followedCustom=module.generationPayload({...form,customSize:true,dimensions:'invalid',followReferenceSize:true},refs);
 assert.equal(followedCustom.size,'auto'); assert.equal(followedCustom.ratio,undefined);
 assert.equal(module.generationPayload({...form,followReferenceSize:false},refs).size,'2K');
});
test('custom resolution accepts x, X and multiplication signs and normalizes dimensions',()=>{
 for(const dimensions of [' 1536x1024 ','1536 X 1024','1536 × 1024','001536x001024']) {
  assert.equal(module.generationPayload({...form,customSize:true,dimensions},[]).size,'1536x1024');
 }
 assert.equal(module.generationPayload({...form,customSize:true,dimensions:'999999x1'},[]).size,'999999x1');
});
test('all native tier and ratio combinations have independently specified expected dimensions',()=>{
 assert.equal(typeof module.expectedGenerationSize, 'function');
 const bases={'1:1':[1024,1024],'3:4':[864,1152],'4:3':[1152,864],'16:9':[1312,736],'9:16':[736,1312],'2:3':[832,1248],'3:2':[1248,832],'21:9':[1568,672]};
 for(const [ratio,[w,h]] of Object.entries(bases)) for(const scale of [1,2,3,4]) assert.deepEqual(module.expectedGenerationSize(scale+'K',ratio),{width:w*scale,height:h*scale});
});
test('UTF-8 JSON request boundary includes prompt and escaping, not just original file bytes',()=>{
 assert.equal(typeof module.generationPayload, 'function');
 const limit=32*1024*1024;
 const seed={...form,prompt:'中文"提示词'};
 const base=module.generationPayload(seed,[{value:''}]);
 const overhead=new TextEncoder().encode(JSON.stringify(base)).length;
 const exact=[{value:'a'.repeat(limit-overhead)}];
 assert.equal(new TextEncoder().encode(JSON.stringify(module.generationPayload(seed,exact))).length,limit);
 assert.throws(()=>module.generationPayload(seed,[{value:exact[0].value+'a'}]),/32/);
 assert.throws(()=>module.generationPayload(form,Array.from({length:17},()=>({value:'https://example.com/a.png'}))),/16/);
});
test('embedded exports work without imported module scope',()=>{
 assert.equal(typeof module.generationPayload,'function');
 const fn=vm.runInNewContext('('+module.generationPayload.toString()+')',{TextEncoder});
 assert.equal(fn(form,[]).size,'2K');
 const dimensions=vm.runInNewContext('('+module.expectedGenerationSize.toString()+')');
 assert.equal(dimensions('2K','4:3').width,2304);
});
