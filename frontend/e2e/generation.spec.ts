import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, gotoSection, section, listGallery, waitForPrompt } from './helpers';

const preview = (page) => page.locator('[data-role="generation-image"]');
const generate = (page) => section(page, 'generate');
async function original(page) {
 const item=(await listGallery(page)).find(x=>x.archived)!;
 const response=await page.request.get(`/admin/api/gallery/${item.id}/content`);
 return {item,bytes:await response.body(),mime:response.headers()['content-type']};
}

test('manual generation shows large images, numbers and existing archived results', async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await login(page); await gotoSection(page,'generate');
 const prompt='console generation '+Date.now();
 await generate(page).getByLabel('提示词',{exact:true}).fill(prompt);
 await generate(page).getByLabel('数量',{exact:true}).fill('2');
 await generate(page).getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(preview(page)).toBeVisible();
 await expect(preview(page)).toHaveCSS('object-fit','contain');
 const first=await preview(page).getAttribute('src');
 const second=page.getByRole('button',{name:'显示第 2 张图片',exact:true});
 await second.click();await expect(second).toHaveAttribute('aria-pressed','true');
 await expect(preview(page)).not.toHaveAttribute('src',first!);
 const result=page.locator('[data-role="generation-result"]');
 await expect(result.getByRole('button',{name:'下载'})).toHaveCount(0);
 await expect(result.getByRole('button',{name:'作为参考图'})).toHaveCount(0);
 await waitForPrompt(page,prompt,2);
 await page.screenshot({path:'test-results/screenshots/generation-results-1440.png',fullPage:true});
 expect(errors).toEqual([]);
});

test('gallery detail has reference action next to copy and preserves generation form',async({page})=>{
 await login(page);await gotoSection(page,'generate');
 await generate(page).getByLabel('提示词',{exact:true}).fill('keep my prompt');
 await generate(page).getByLabel('数量',{exact:true}).fill('2');
 await gotoSection(page,'gallery');
 const item=(await listGallery(page)).find(x=>x.archived)!;
 await page.locator(`.gallery-card[data-id="${item.id}"] .gallery-open`).click();
 const dialog=page.locator('[data-role="gallery-dialog"]');await expect(dialog).toBeVisible();
 const reference=dialog.getByRole('button',{name:'作为参考图',exact:true});await expect(reference).toBeVisible();
 const order=await dialog.locator('.lightbox-actions').innerText();expect(order.indexOf('复制提示词')).toBeLessThan(order.indexOf('作为参考图'));expect(order.indexOf('作为参考图')).toBeLessThan(order.indexOf('下载'));
 await reference.click();await expect(generate(page)).toHaveClass(/is-active/);await expect(dialog).toBeHidden();
 await expect(generate(page).getByLabel('提示词',{exact:true})).toHaveValue('keep my prompt');
 await expect(generate(page).getByLabel('数量',{exact:true})).toHaveValue('2');
 await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 1 张参考图');
 await gotoSection(page,'gallery');await page.locator(`.gallery-card[data-id="${item.id}"] .gallery-open`).click();await reference.click();
 await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 1 张参考图');
});

test('gallery reference failure keeps detail open and form untouched',async({page})=>{
 await login(page);await gotoSection(page,'gallery');const item=(await listGallery(page)).find(x=>x.archived)!;
 await page.locator(`.gallery-card[data-id="${item.id}"] .gallery-open`).click();
 await page.route(`**/admin/api/gallery/${item.id}/content`,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{message:'original missing'}})}));
 const dialog=page.locator('[data-role="gallery-dialog"]');await dialog.getByRole('button',{name:'作为参考图',exact:true}).click();
 await expect(dialog).toBeVisible();await expect(page).toHaveURL(/#gallery$/);await expect(page.locator('.toast-stack')).toContainText('original missing');
});

test('upload, drag, paste, URL and reference ordering form one accepted image request',async({page})=>{
 const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
 await login(page);const {bytes,mime}=await original(page);await gotoSection(page,'generate');
 await generate(page).getByLabel('提示词',{exact:true}).fill('references browser test');
 await page.locator('#generation-files').setInputFiles({name:'upload.png',mimeType:mime,buffer:bytes});
 await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 1 张参考图');
 await page.locator('[data-role="generation-drop"]').evaluate((node,{encoded,mime})=>{
  const binary=atob(encoded);const data=Uint8Array.from(binary,c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([data],'dropped.png',{type:mime}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
 },{encoded:bytes.toString('base64'),mime});
 await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 2 张参考图');
 await generate(page).evaluate((node,{encoded,mime})=>{const data=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([data],'pasted.png',{type:mime}));node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:transfer}));},{encoded:bytes.toString('base64'),mime});
 await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 3 张参考图');
 await generate(page).getByRole('button',{name:'添加图片 URL'}).click();const dialog=page.locator('[data-role="generation-url-dialog"]');
 await dialog.getByLabel('HTTP(S) 图片地址').fill('https://example.com/reference.png');await dialog.getByRole('button',{name:'添加参考图',exact:true}).click();
 await expect.poll(() => pageErrors).toEqual([]);
 await expect(dialog).toBeHidden();await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 4 张参考图');
 await page.getByRole('button',{name:'向前参考图 4',exact:true}).click();
 await generate(page).getByRole('checkbox',{name:'跟随第一张参考图',exact:true}).check();
 let payload;
 await page.route('**/admin/api/images/generations',async route=>{payload=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({created:1,size:'64x64',data:[{b64_json:bytes.toString('base64'),revised_prompt:null}]})})});
 await generate(page).getByRole('button',{name:'开始生成',exact:true}).click();await expect(preview(page)).toBeVisible();
 expect(payload.size).toBe('auto');expect(payload.images).toHaveLength(4);expect(payload.images[2]).toBe('https://example.com/reference.png');expect(payload.ratio).toBeUndefined();
 await expect(page.locator('[data-role="generation-numbers"]')).toBeHidden();
});

test('busy feedback stays in submit button and failed regeneration preserves previous image',async({page})=>{
 await login(page);const {bytes}=await original(page);await gotoSection(page,'generate');await generate(page).getByLabel('提示词',{exact:true}).fill('preserve results');
 let release;let mode='success';
 await page.route('**/admin/api/images/generations',async route=>{
  if(mode==='wait')await new Promise(r=>{release=r});
  await route.fulfill(mode==='failure'?{status:502,contentType:'application/json',body:JSON.stringify({error:{message:'upstream unavailable'}})}:{status:200,contentType:'application/json',body:JSON.stringify({created:1,size:'64x64',data:Array.from({length:3},()=>({b64_json:bytes.toString('base64'),revised_prompt:null}))})});
 });
 const submit=generate(page).getByRole('button',{name:'开始生成',exact:true});await submit.click();await expect(preview(page)).toBeVisible();await page.getByRole('button',{name:'显示第 2 张图片'}).click();const old=await preview(page).getAttribute('src');
 mode='wait';await submit.click();await expect(generate(page).getByRole('button',{name:'生成中…',exact:true})).toBeDisabled();await expect(generate(page).getByLabel('提示词',{exact:true})).toBeDisabled();await expect(preview(page)).toHaveAttribute('src',old!);
 await expect(page.locator('[data-role="generation-result"]')).not.toContainText('生成中');mode='failure';release();
 await expect(page.locator('[data-role="generation-error"]')).toContainText('upstream unavailable');await expect(submit).toBeEnabled();await expect(preview(page)).toHaveAttribute('src',old!);await expect(page.getByRole('button',{name:'显示第 2 张图片'})).toHaveAttribute('aria-pressed','true');
 mode='success';await submit.click();await expect(page.getByRole('button',{name:'显示第 1 张图片'})).toHaveAttribute('aria-pressed','true');
 await generate(page).getByRole('button',{name:'清空预览'}).click();await expect(preview(page)).toBeHidden();
});

test('reference size checkbox overrides dimensions and clear preview resets the entire console',async({page})=>{
 await login(page);const {bytes,mime}=await original(page);await gotoSection(page,'generate');
 const panel=generate(page),follow=panel.getByRole('checkbox',{name:'跟随第一张参考图',exact:true});
 const tier=panel.getByRole('combobox',{name:'分辨率',exact:true}),dimensions=panel.getByRole('textbox',{name:'分辨率',exact:true}),ratio=panel.getByLabel('宽高比',{exact:true}),model=panel.getByLabel('模型',{exact:true});
 await expect(model).toHaveValue('agnes-image-2.5-flash');const defaultTier=await tier.inputValue(),defaultModel=await model.inputValue();
 await expect(panel.locator('.generation-reference-head').getByRole('checkbox')).toBeVisible();await expect(follow).not.toBeChecked();
 await panel.getByLabel('提示词',{exact:true}).fill('reset console');await panel.getByLabel('数量',{exact:true}).fill('2');
 await tier.selectOption('4K');await ratio.selectOption('16:9');
 const custom=panel.getByRole('checkbox',{name:'自定义尺寸',exact:true});await expect(panel.getByLabel('尺寸模式')).toHaveCount(0);await expect(panel.locator('.generation-resolution').getByRole('checkbox')).toBeVisible();
 await expect(custom).not.toBeChecked();await expect(dimensions).toBeHidden();const initialBox=await tier.boundingBox();
 await custom.check();await expect(tier).toBeHidden();await expect(ratio).toBeDisabled();const customBox=await dimensions.boundingBox();expect(customBox!.x).toBe(initialBox!.x);expect(customBox!.width).toBe(initialBox!.width);expect(customBox!.height).toBe(initialBox!.height);
 await expect(panel.getByLabel('宽度',{exact:true})).toHaveCount(0);await expect(panel.getByLabel('高度',{exact:true})).toHaveCount(0);
 await dimensions.fill('2048x1024');
 await custom.uncheck();await expect(tier).toBeEnabled();await expect(tier).toHaveValue('4K');await expect(ratio).toHaveValue('16:9');await expect(dimensions).toBeHidden();
 await custom.check();await expect(dimensions).toHaveValue('2048x1024');
 await follow.check();await expect(custom).toBeDisabled();await expect(dimensions).toBeDisabled();await expect(ratio).toBeDisabled();
 await panel.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.locator('[data-role="generation-error"]')).toContainText('至少一张参考图');
 await follow.uncheck();await expect(custom).toBeEnabled();await expect(custom).toBeChecked();await expect(dimensions).toHaveValue('2048x1024');
 await page.locator('#generation-files').setInputFiles({name:'reference.png',mimeType:mime,buffer:bytes});await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 1 张参考图');
 let payload;
 await page.route('**/admin/api/images/generations',async route=>{payload=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[{b64_json:bytes.toString('base64')}]})})});
 await panel.getByRole('button',{name:'开始生成',exact:true}).click();await expect(preview(page)).toBeVisible();expect(payload.size).toBe('2048x1024');expect(payload.ratio).toBeUndefined();
 await follow.check();
 await panel.getByRole('button',{name:'开始生成',exact:true}).click();await expect(panel.getByRole('button',{name:'开始生成',exact:true})).toBeEnabled();expect(payload.size).toBe('auto');expect(payload.ratio).toBeUndefined();
 await panel.getByRole('button',{name:'添加图片 URL'}).click();await page.locator('#generation-url-input').fill('https://example.com/draft.png');await page.keyboard.press('Escape');
 await panel.getByRole('button',{name:'清空预览'}).click();await expect(preview(page)).toBeHidden();await expect(preview(page)).not.toHaveAttribute('src');
 await expect(panel.getByLabel('提示词',{exact:true})).toHaveValue('');await expect(panel.getByLabel('数量',{exact:true})).toHaveValue('1');await expect(model).toHaveValue(defaultModel);
 await expect(tier).toHaveValue(defaultTier);await expect(ratio).toHaveValue('1:1');await expect(tier).toBeEnabled();await expect(ratio).toBeEnabled();await expect(follow).not.toBeChecked();
 await expect(custom).not.toBeChecked();await expect(custom).toBeEnabled();await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('未添加参考图');await expect(panel.locator('.generation-reference')).toHaveCount(0);await expect(page.locator('[data-role="generation-error"]')).toBeHidden();
 await expect(dimensions).toBeHidden();await expect(page.locator('#generation-url-input')).toHaveValue('');
 await custom.check();await expect(dimensions).toHaveValue('1536x1024');
 await page.setViewportSize({width:375,height:812});await expect(follow).toBeVisible();await expect(custom).toBeVisible();
 expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 await page.setViewportSize({width:812,height:375});await expect(follow).toBeVisible();
 expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});

test('scrollbar visibility does not resize the console or its generation controls',async({page})=>{
 await page.setViewportSize({width:1440,height:1100});await login(page);await gotoSection(page,'generate');
 const panel=generate(page),custom=panel.getByRole('checkbox',{name:'自定义尺寸',exact:true});
 const measure=()=>panel.locator('.generation-parameters').evaluate(node=>{const rect=node.getBoundingClientRect();return {x:rect.x,width:rect.width,height:rect.height};});
 await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarGutter)).toBe('stable');
 const before=await measure();await custom.check();expect(await measure()).toEqual(before);await custom.uncheck();expect(await measure()).toEqual(before);
 await page.evaluate(()=>{const spacer=document.createElement('div');spacer.id='scrollbar-test-spacer';spacer.style.height='2000px';document.querySelector('.main')!.append(spacer);});
 expect(await page.evaluate(()=>document.documentElement.scrollHeight>window.innerHeight)).toBe(true);expect(await measure()).toEqual(before);
 await page.evaluate(()=>{document.getElementById('scrollbar-test-spacer')!.remove();document.documentElement.style.overflowY='hidden';});
 expect(await measure()).toEqual(before);await page.evaluate(()=>document.documentElement.style.removeProperty('overflow-y'));
});

test('bootstrap failure followed by retry restores a usable generation page',async({page})=>{
 await login(page);
 let fail=true;
 await page.route('**/admin/api/storage',async route=>{
  if(fail)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'temporarily unavailable',code:'service_unavailable'}})});
  else await route.continue();
 });
 await page.goto('/admin/generate');
 const retry=page.locator('[data-action="boot-retry"]');await expect(retry).toBeVisible();
 await expect(generate(page).getByRole('button',{name:'开始生成',exact:true})).toBeDisabled();
 fail=false;await retry.click();await expect(retry).toBeHidden();
 await expect(generate(page).getByLabel('模型',{exact:true})).toHaveValue('agnes-image-2.5-flash');
 await generate(page).getByLabel('提示词',{exact:true}).fill('bootstrap retry generation');
 await generate(page).getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(preview(page)).toBeVisible();
});

test('late gallery reference admission does not close a newer image detail or force navigation',async({page})=>{
 await login(page);await gotoSection(page,'gallery');
 const items=(await listGallery(page)).filter(item=>item.archived);
 const first=items[0],second=items[1];
 const dialog=page.locator('[data-role="gallery-dialog"]');
 await page.locator(`.gallery-card[data-id="${first.id}"] .gallery-open`).click();
 await expect(dialog.locator('img')).toHaveAttribute('src',first.imageUrl!);
 let release;let started=false;
 await page.route(`**/admin/api/gallery/${first.id}/content`,async route=>{started=true;await new Promise(resolve=>{release=resolve});await route.continue();});
 await dialog.getByRole('button',{name:'作为参考图',exact:true}).click();
 await expect.poll(()=>started).toBe(true);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator(`.gallery-card[data-id="${second.id}"] .gallery-open`).click();
 release();
 await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 1 张参考图');
 await expect(dialog).toBeVisible();
 await expect(dialog.locator('img')).toHaveAttribute('src',second.imageUrl!);
 await expect(page).toHaveURL(/#gallery$/);
});

test('restored browser cache entry reinitializes the disposed console safely',async({page})=>{
 await login(page);await gotoSection(page,'generate');
 await page.evaluate(() => {
  window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
  (window as any).__restorationMarker=true;
  window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
 });
 await expect.poll(async () => {
  try { return await page.evaluate(() => Boolean((window as any).__restorationMarker)); }
  catch (error) { if (String(error).includes('Execution context was destroyed')) return true; throw error; }
 }).toBe(false);
 await expect(generate(page).getByRole('button',{name:'开始生成',exact:true})).toBeEnabled();
 await generate(page).getByLabel('提示词',{exact:true}).fill('restored console');
 await generate(page).getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(preview(page)).toBeVisible();
});

test('gallery picker and URL modal are keyboard accessible without serious axe violations',async({page})=>{
 await login(page);await gotoSection(page,'generate');await generate(page).getByRole('button',{name:'从图库选择'}).click();
 const picker=page.locator('[data-role="generation-gallery-dialog"]');await expect(picker).toBeVisible();await expect(picker.getByRole('button',{name:/选择图库图片/}).first()).toBeVisible();
 const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical');expect(violations).toEqual([]);
 await picker.getByRole('button',{name:/选择图库图片/}).first().click();await expect(picker).toBeHidden();await expect(page.locator('[data-role="generation-reference-count"]')).toHaveText('已添加 1 张参考图');
 await generate(page).getByRole('button',{name:'添加图片 URL'}).click();await expect(page.locator('[data-role="generation-url-dialog"]')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('[data-role="generation-url-dialog"]')).toBeHidden();
});
