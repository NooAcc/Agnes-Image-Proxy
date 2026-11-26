import { icon } from "../icons.ts";

export const API_KEYS_HTML = `
<section class="panel" data-section="api-keys" data-title="API 密钥">
  <div class="section-head">
    <div class="section-lead">
      <h2>生图 API 密钥</h2>
      <p>可为不同客户端创建独立密钥。密钥仅能调用生图和图片编辑接口，不能登录或管理后台。</p>
    </div>
    <button class="btn primary" data-action="create-api-key" type="button">${icon("plus")}新建密钥</button>
  </div>
  <p>客户端 API 地址：<code data-role="api-key-base-url">/v1</code></p>
  <p data-role="api-key-list-status" role="status">正在加载密钥…</p>
  <div class="account-grid" data-role="api-key-list"></div>
</section>`;

export const API_KEYS_DIALOG = `
<dialog data-role="create-api-key-dialog" aria-labelledby="create-api-key-title">
  <div class="dialog-body">
    <div class="dialog-head"><h2 id="create-api-key-title">新建生图密钥</h2></div>
    <form data-form="api-key" autocomplete="off">
      <div class="field">
        <label for="api-key-name">密钥名称</label>
        <input class="input" id="api-key-name" name="name" required maxlength="128" autofocus aria-describedby="api-key-name-hint">
        <span class="hint" id="api-key-name-hint">用名称区分使用方，例如「绘图客户端」。</span>
      </div>
      <p class="form-error" id="api-key-error" data-role="api-key-error" role="alert"></p>
      <div class="dialog-actions">
        <button class="btn" type="button" data-role="cancel-api-key">取消</button>
        <button class="btn primary" type="submit">创建密钥</button>
      </div>
    </form>
  </div>
</dialog>
<dialog data-role="copy-api-key-dialog" aria-labelledby="copy-api-key-title">
  <div class="dialog-body">
    <div class="dialog-head"><h2 id="copy-api-key-title">复制生图密钥</h2></div>
    <p class="dialog-desc">浏览器未能自动复制，请手动复制。请勿公开分享密钥。</p>
    <div class="field">
      <label for="api-key-secret">完整密钥</label>
      <input class="input mono" id="api-key-secret" data-role="api-key-secret" readonly autocomplete="off" spellcheck="false">
    </div>
    <form method="dialog" class="dialog-actions"><button class="btn primary" type="submit">完成</button></form>
  </div>
</dialog>`;

export const API_KEYS_SCRIPT = String.raw`
(function () {
  "use strict";
  var A = window.Agnes;
  var section = document.querySelector('[data-section="api-keys"]');
  var list = section.querySelector('[data-role="api-key-list"]');
  var status = section.querySelector('[data-role="api-key-list-status"]');
  var createButton = section.querySelector('[data-action="create-api-key"]');
  var dialog = document.querySelector('[data-role="create-api-key-dialog"]');
  var form = dialog.querySelector('form');
  var name = form.elements.namedItem('name');
  var errorNode = dialog.querySelector('[data-role="api-key-error"]');
  var cancel = dialog.querySelector('[data-role="cancel-api-key"]');
  var submit = form.querySelector('[type="submit"]');
  var copyDialog = document.querySelector('[data-role="copy-api-key-dialog"]');
  var secret = copyDialog.querySelector('[data-role="api-key-secret"]');
  var path = "/admin/api/api-keys";
  var pending = false;
  var request = 0;
  section.querySelector('[data-role="api-key-base-url"]').textContent = location.origin + '/v1';

  function renderKey(item) {
    var card = A.el('article', 'account-card api-key-card');
    var title = A.el('h3', 'account-name', item.name);
    var hint = A.el('code', 'account-key', item.keyHint);
    var stamp = A.el('time', 'account-key', '创建于 ' + A.fmtTime(item.createdAt));
    stamp.dateTime = item.createdAt;
    var buttons = A.el('div', 'toolbar');
    var copy = A.el('button', 'btn', '复制密钥');
    var revoke = A.el('button', 'btn danger', '撤销');
    copy.type = revoke.type = 'button';
    copy.setAttribute('aria-label', '复制密钥：' + item.name);
    revoke.setAttribute('aria-label', '撤销密钥：' + item.name);
    copy.addEventListener('click', async function () {
      A.setBusy(copy, true, '读取中…');
      try {
        var result = await A.api(path + '/' + item.id);
        if (await A.copyText(result.apiKey)) {
          A.toast('已复制生图密钥');
        } else {
          secret.value = result.apiKey;
          copyDialog.showModal();
          secret.select();
        }
      } catch (err) { A.toast('无法复制密钥：' + err.message, 'error'); }
      finally {
        A.setBusy(copy, false);
        if (copyDialog.open) secret.focus();
        else copy.focus();
      }
    });
    revoke.addEventListener('click', async function () {
      if (!await A.confirm({ title: '撤销生图密钥？', message: '「' + item.name + '」撤销后无法恢复，使用该密钥的新请求将被拒绝。', confirmLabel: '撤销密钥', tone: 'danger' })) return;
      A.setBusy(revoke, true, '撤销中…');
      try {
        await A.api(path + '/' + item.id, { method: 'DELETE' });
        card.remove();
        createButton.focus();
        A.toast('已撤销生图密钥');
        await load();
      } catch (err) { A.toast('无法撤销密钥：' + err.message, 'error'); }
      finally { A.setBusy(revoke, false); }
    });
    buttons.append(copy, revoke);
    card.append(title, hint, stamp, buttons);
    return card;
  }

  async function load() {
    var current = ++request;
    try {
      var result = await A.api(path);
      if (current !== request) return;
      list.replaceChildren(...result.items.map(renderKey));
      status.textContent = result.items.length ? '' : '还没有生图密钥，请先新建一个。';
    } catch (err) {
      if (current !== request) return;
      var retry = A.el('button', 'btn', '重试');
      retry.type = 'button';
      retry.addEventListener('click', load);
      status.replaceChildren(document.createTextNode('无法加载密钥：' + err.message + ' '), retry);
    }
  }

  function showError(message) {
    errorNode.textContent = message;
    errorNode.classList.toggle('is-visible', Boolean(message));
    if (message) {
      name.setAttribute('aria-invalid', 'true');
      name.setAttribute('aria-describedby', 'api-key-name-hint api-key-error');
    } else {
      name.removeAttribute('aria-invalid');
      name.setAttribute('aria-describedby', 'api-key-name-hint');
    }
  }

  createButton.addEventListener('click', function () {
    form.reset();
    showError('');
    dialog.showModal();
  });
  cancel.addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('cancel', function (event) { if (pending) event.preventDefault(); });
  copyDialog.addEventListener('close', function () { secret.value = ''; });
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (pending) return;
    var label = name.value.trim();
    if (!label) { showError('请输入密钥名称。'); name.focus(); return; }
    pending = true;
    cancel.disabled = true;
    A.setBusy(submit, true, '创建中…');
    showError('');
    try {
      await A.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: label }) });
      dialog.close();
      A.toast('生图密钥已创建，可以在列表中复制');
      await load();
    } catch (err) { showError('无法创建密钥：' + err.message); }
    finally {
      pending = false;
      cancel.disabled = false;
      A.setBusy(submit, false);
    }
  });
  document.addEventListener('agnes:section', function (event) {
    if (event.detail.name === 'api-keys') load();
  });
})();
`;
