// ==UserScript==
// @name         VRC-Video-Allowlist-QuickEdit
// @namespace    https://github.com/mmyo456/VRC-Video-Allowlist-QuickEdit
// @author       鸭鸭
// @version      0.0.4
// @description  用于快速批量编辑 VRChat 世界播放器域名白名单的 Tampermonkey 脚本
// @icon         https://i.ouo.chat/favicon.ico
// @match        https://vrchat.com/home
// @match        https://vrchat.com/home/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/mmyo456/VRC-Video-Allowlist-QuickEdit/main/vrc-video-allowlist-quickedit.user.js
// @updateURL    https://raw.githubusercontent.com/mmyo456/VRC-Video-Allowlist-QuickEdit/main/vrc-video-allowlist-quickedit.user.js
// ==/UserScript==

(() => {
  'use strict';

  // 世界编辑页地址示例：
  // /home/content/worlds/wrld_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/edit
  // 此正则只负责从当前地址中取出 wrld_ 开头的世界 ID。
  const WORLD_ID_RE = /\/worlds\/(wrld_[0-9a-f-]+)\/edit/i;

  const REQUEST_TIMEOUT_MS = 15_000;
  const UNCERTAIN_WRITE_GUARD_MS = 30_000;

  const getWorldId = () => location.pathname.match(WORLD_ID_RE)?.[1] ?? null;

  function inspectUncertainWrite(worldId, serverList) {
    const pending = uncertainWrites.get(worldId);
    if (!pending) return null;

    if (listsEqual(serverList, pending.expected)) {
      uncertainWrites.delete(worldId);

      // 尝试保存的原草稿已经落库；若用户此后又编辑过，则保留那份新草稿。
      const draft = draftsByWorld.get(worldId);
      try {
        if (draft !== undefined && listsEqual(analyzeInput(draft).values, pending.expected)) {
          draftsByWorld.delete(worldId);
        }
      } catch {
        // 无效草稿显然不是已经保存的目标值，应继续保留。
      }
      return { state: 'saved' };
    }

    if (Date.now() >= pending.releaseAfter) {
      uncertainWrites.delete(worldId);
      return { state: 'expired' };
    }

    return {
      state: 'waiting',
      seconds: Math.max(1, Math.ceil((pending.releaseAfter - Date.now()) / 1_000)),
    };
  }

  /**
   * 把用户输入转换成 VRChat urlList 所需的纯域名。
   *
   * 支持以下输入：
   *   example.com
   *   https://example.com/video/test
   *
   * 上述两种最终都会变成 example.com。协议、路径和末尾的点会被移除。
   */
  function normalizeEntry(value) {
    let text = value.trim();
    if (!text) return null;

    // 支持直接粘贴 JSON、JavaScript 或配置文件中的 "example.com" / 'example.com'。
    const quoteMatch = text.match(/^(["'])(.*)\1$/);
    if (quoteMatch) text = quoteMatch[2].trim();

    let parsed;
    try {
      parsed = new URL(text.includes('://') ? text : `https://${text}`);
    } catch {
      throw new Error(`无法识别：${value}`);
    }

    if (parsed.username || parsed.password) {
      throw new Error('域名中不能包含用户名或密码');
    }
    text = parsed.hostname;

    text = text.toLowerCase().replace(/\.$/, '');
    if (
      text.length > 253 ||
      !text.includes('.') ||
      !/^[a-z0-9.-]+$/i.test(text) ||
      text.split('.').some((part) => !part || part.length > 63 || part.startsWith('-') || part.endsWith('-'))
    ) {
      throw new Error(`不是有效域名：${value}`);
    }
    return text;
  }

  /**
   * 支持两种输入：
   * 1. 完整 JSON 字符串数组：["a.example.com", "b.example.com"]
   * 2. 使用换行、空格、中英文逗号或分号分隔的普通文本
   */
  function splitEntries(text) {
    const trimmed = text.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
          throw new Error('JSON 必须是仅包含字符串的数组');
        }
        return parsed.filter((item) => item.trim());
      } catch (error) {
        throw new Error(`JSON 格式错误：${error.message}`);
      }
    }

    return text.split(/[\s,，;；]+/).filter(Boolean);
  }

  const domainCollator = new Intl.Collator('en', {
    numeric: true,
    sensitivity: 'base',
  });

  /**
   * 从右向左逐级比较域名标签：
   *   video.example.co.uk -> uk / co / example / video
   *
   * 相同域名树会自然排列在一起，不需要维护不完整的公共后缀列表。
   * Intl.Collator 的 numeric 选项还能让 m7、m8、m10 按数字顺序排列。
   */
  function compareDomains(left, right) {
    const leftParts = left.split('.').reverse();
    const rightParts = right.split('.').reverse();
    const sharedLength = Math.min(leftParts.length, rightParts.length);

    for (let index = 0; index < sharedLength; index++) {
      const result = domainCollator.compare(leftParts[index], rightParts[index]);
      if (result) return result;
    }

    // 完全相同的父域排在其子域前，例如 example.com 在 www.example.com 前。
    return leftParts.length - rightParts.length;
  }

  // 按域名后缀层级相邻排列并自然排序，不声称识别可注册主域名。
  function sortDomains(domains) {
    return [...domains].sort(compareDomains);
  }

  /**
   * 所有输入操作共用的数据管线：拆分 -> 规范化 -> 去重。
   * 每个域名只解析一次，避免输入提示、排序和保存各自实现一套规则。
   */
  function analyzeInput(text) {
    const normalized = splitEntries(text).map(normalizeEntry);
    const unique = [...new Set(normalized)];

    return {
      values: unique,
      text: unique.join('\n'),
      duplicateCount: normalized.length - unique.length,
    };
  }

  // 服务器返回值只需要统一大小写和去重；它已经是 VRChat 接受过的域名，
  // 无须再次执行面向用户输入的严格校验。
  const normalizeServerList = (items) =>
    [
      ...new Set(
        (Array.isArray(items) ? items : [])
          .map((item) => String(item).trim().toLowerCase())
          .filter(Boolean),
      ),
    ];

  function getWorldList(world) {
    if (!Array.isArray(world?.urlList)) {
      throw new Error('服务器未返回有效的 urlList');
    }
    return normalizeServerList(world.urlList);
  }

  const listsEqual = (left, right) =>
    left.length === right.length && left.every((item, index) => item === right[index]);

  /**
   * 同源 API 请求封装。
   * credentials: 'include' 会使用 vrchat.com 当前登录会话，
   * 脚本中不需要保存 Cookie、密码或 Token。
   */
  async function api(path, options = {}) {
    const {
      signal: externalSignal,
      timeoutMs = REQUEST_TIMEOUT_MS,
      ...fetchOptions
    } = options;
    const method = (fetchOptions.method || 'GET').toUpperCase();
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromExternal = () => controller.abort(externalSignal?.reason);

    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

    let responseReceived = false;
    try {
      const response = await fetch(path, {
        credentials: 'include',
        ...(method === 'GET' ? { cache: 'no-store' } : {}),
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
          ...fetchOptions.headers,
        },
      });
      responseReceived = true;

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
        const responseError = new Error(message);
        responseError.status = response.status;
        throw responseError;
      }
      return body;
    } catch (error) {
      const requestError = timedOut ? new Error('请求超时，请稍后重试') : error;

      // PUT 在收到响应前超时或断网时，无法判断请求是否已经抵达服务器。
      // 给错误加标记，让保存逻辑延迟复核，而不是立刻允许第二次写入。
      if (
        method !== 'GET' &&
        (timedOut || !responseReceived || (requestError.status >= 500 && requestError.status <= 599))
      ) {
        requestError.writeUncertain = true;
      }
      throw requestError;
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }

  // 创建悬浮面板。使用原生 DOM，不依赖 VRChat 网站自己的 React 组件。
  function makePanel() {
    const panel = document.createElement('section');
    panel.id = 'vrc-url-list-editor';
    panel.hidden = true;
    panel.innerHTML = `
      <button id="vrc-ule-toggle" type="button" aria-expanded="false" aria-controls="vrc-ule-body">
        <span class="vrc-ule-heading">
          <span class="vrc-ule-title">播放器白名单</span>
          <span id="vrc-ule-count" class="vrc-ule-count">读取中</span>
        </span>
        <span class="vrc-ule-chevron" aria-hidden="true">⌃</span>
      </button>
      <div id="vrc-ule-body" class="vrc-ule-body" hidden>
        <a class="vrc-ule-repo"
          href="https://github.com/mmyo456/VRC-Video-Allowlist-QuickEdit"
          target="_blank" rel="noopener noreferrer">
          项目仓库 <span aria-hidden="true">↗</span>
        </a>
        <label class="vrc-ule-label" for="vrc-ule-input">
          允许的域名
          <span>每行一个，也支持逗号或空格</span>
        </label>
        <textarea id="vrc-ule-input" rows="10" spellcheck="false"
          placeholder="example.com&#10;cdn.example.com"></textarea>
        <div class="vrc-ule-actions">
          <button id="vrc-ule-load" class="vrc-ule-secondary" type="button">重新载入</button>
          <button id="vrc-ule-sort" class="vrc-ule-secondary" type="button">自动排序</button>
          <button id="vrc-ule-submit" class="vrc-ule-primary" type="button">保存修改</button>
        </div>
        <div id="vrc-ule-status" role="status" aria-live="polite"></div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #vrc-url-list-editor {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        width: min(380px, calc(100vw - 24px)); overflow: hidden;
        border: 1px solid #8f8364; border-radius: 14px;
        color: #302e24; background: #C8BB94;
        box-shadow: 0 14px 40px #0005, 0 2px 8px #0003;
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        transform-origin: right bottom;
      }
      #vrc-url-list-editor button, #vrc-url-list-editor textarea {
        box-sizing: border-box; color: #302e24; font: inherit;
      }
      #vrc-url-list-editor button {
        border: 1px solid #817951; border-radius: 8px;
        background: #DDD59E; cursor: pointer;
        transition: filter 120ms ease, transform 120ms ease, box-shadow 120ms ease;
      }
      #vrc-url-list-editor button:hover:not(:disabled) { filter: brightness(1.055); }
      #vrc-url-list-editor button:active:not(:disabled) { transform: translateY(1px); }
      #vrc-url-list-editor button:focus-visible, #vrc-url-list-editor textarea:focus-visible {
        outline: 3px solid #fff8cf; outline-offset: 2px;
      }
      #vrc-url-list-editor button:disabled, #vrc-url-list-editor textarea:disabled {
        cursor: wait; opacity: .58;
      }
      #vrc-ule-toggle {
        display: flex; align-items: center; justify-content: space-between;
        width: 100%; min-height: 48px; padding: 9px 12px;
        border: 0; border-radius: 0; text-align: left;
      }
      .vrc-ule-heading { display: flex; align-items: center; gap: 9px; min-width: 0; }
      .vrc-ule-title { font-size: 15px; font-weight: 750; letter-spacing: .01em; }
      .vrc-ule-count {
        padding: 2px 7px; border: 1px solid #a49b6f; border-radius: 999px;
        color: #58523d; background: #eee8bd; font-size: 11px; white-space: nowrap;
        transition: background-color 160ms ease, transform 160ms ease;
      }
      .vrc-ule-chevron {
        margin-left: 10px; font-size: 16px; transition: transform 160ms ease;
      }
      #vrc-ule-toggle[aria-expanded="false"] .vrc-ule-chevron { transform: rotate(180deg); }
      .vrc-ule-body {
        box-sizing: border-box; overflow: hidden;
        padding: 13px; border-top: 1px solid #a39775;
      }
      .vrc-ule-repo {
        display: inline-flex; align-items: center; gap: 4px;
        margin-bottom: 9px; color: #514b35; font-size: 12px;
        font-weight: 650; text-decoration: none;
      }
      .vrc-ule-repo:hover { color: #29271f; text-decoration: underline; }
      .vrc-ule-repo:focus-visible {
        border-radius: 3px; outline: 3px solid #fff8cf; outline-offset: 2px;
      }
      .vrc-ule-label {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 10px; margin-bottom: 6px; font-weight: 650;
      }
      .vrc-ule-label span { color: #464234; font-size: 11px; font-weight: 450; }
      #vrc-ule-body textarea {
        display: block; width: 100%; min-height: 170px; padding: 10px 11px; resize: vertical;
        border: 1px solid #8f8566; border-radius: 9px;
        color: #29271f; background: #f7f2d8;
        box-shadow: inset 0 1px 3px #5f57351c;
        font: 12.5px/1.55 ui-monospace, "Cascadia Code", Consolas, monospace;
      }
      #vrc-ule-body textarea::placeholder { color: #6d6653; }
      .vrc-ule-actions { display: flex; gap: 9px; margin-top: 11px; }
      .vrc-ule-actions button { flex: 1; }
      .vrc-ule-actions button { min-height: 38px; padding: 7px 11px; font-weight: 650; }
      .vrc-ule-secondary { background: #eee8c5 !important; }
      .vrc-ule-primary {
        border-color: #6f6947 !important; background: #DDD59E !important;
        box-shadow: 0 2px 5px #5f57352b;
      }
      #vrc-ule-status {
        min-height: 18px; margin-top: 8px; font-size: 12px; white-space: pre-wrap;
      }
      @keyframes vrc-ule-status-in {
        from { opacity: 0; transform: translateY(3px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #vrc-ule-status.vrc-ule-status-animate {
        animation: vrc-ule-status-in 180ms ease-out;
      }
      @media (max-width: 480px) {
        #vrc-url-list-editor { right: 12px; bottom: 12px; }
        .vrc-ule-label { align-items: flex-start; flex-direction: column; gap: 1px; }
      }
      @media (prefers-reduced-motion: reduce) {
        #vrc-url-list-editor *, #vrc-url-list-editor {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
    `;
    document.head.append(style);
    document.body.append(panel);
    return panel;
  }

  const panel = makePanel();
  const body = panel.querySelector('#vrc-ule-body');
  const input = panel.querySelector('#vrc-ule-input');
  const status = panel.querySelector('#vrc-ule-status');
  const submit = panel.querySelector('#vrc-ule-submit');
  const loadButton = panel.querySelector('#vrc-ule-load');
  const sortButton = panel.querySelector('#vrc-ule-sort');
  const toggleButton = panel.querySelector('#vrc-ule-toggle');
  const count = panel.querySelector('#vrc-ule-count');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let bodyAnimation = null;
  let deferredDuplicateCount = 0;
  let inputTouchedSinceLoad = false;

  // 当前读取请求的控制器。发起新读取或离开编辑页时会主动取消旧请求，
  // 避免无用网络传输，也避免旧世界的响应覆盖新世界的文本框。
  let loadController = null;
  let loadedWorldId = null;
  let loadedUrlList = [];
  let hasLoadedList = false;
  let submitSequence = 0;
  let isSubmitting = false;
  let pendingWrite = null;
  const draftsByWorld = new Map();
  const uncertainWrites = new Map();

  const isActiveSubmit = (sequence, worldId) =>
    sequence === submitSequence && worldId === getWorldId();

  function hasUnsavedChanges() {
    if (!hasLoadedList) return input.value.trim() !== '';

    try {
      return !listsEqual(analyzeInput(input.value).values, loadedUrlList);
    } catch {
      // 存在尚未完成或无效的输入时，也应视为未保存内容。
      return input.value.trim() !== loadedUrlList.join('\n');
    }
  }

  function saveDraftForLoadedWorld() {
    if (!loadedWorldId) return;

    // 服务器基线尚未读到时，不能仅凭当前内容为空就删除旧草稿；
    // 若用户确实编辑过，则连空字符串也要保存，才能表达“清空列表”的意图。
    if (!hasLoadedList) {
      if (inputTouchedSinceLoad || input.value.trim()) {
        draftsByWorld.set(loadedWorldId, input.value);
      }
      return;
    }

    if (hasUnsavedChanges()) draftsByWorld.set(loadedWorldId, input.value);
    else draftsByWorld.delete(loadedWorldId);
  }

  function restoreDraft(worldId) {
    const draft = draftsByWorld.get(worldId);
    if (draft === undefined) return false;

    input.value = draft;
    inputTouchedSinceLoad = false;
    try {
      updateCountFor(analyzeInput(draft).values);
    } catch {
      setCount('待检查');
    }
    return true;
  }

  // 统一维护控件状态，避免读取和提交的 finally 相互把按钮错误地重新启用。
  function updateControls() {
    const busy = isSubmitting || pendingWrite !== null || loadController !== null;
    const mustVerifyWrite = uncertainWrites.has(getWorldId());
    input.disabled = busy;
    submit.disabled = busy || mustVerifyWrite;
    sortButton.disabled = busy;
    loadButton.disabled = busy;
  }

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.style.color = isError ? '#8b1e1e' : '#294a30';

    // 重启 class 动画，使连续的状态变化也各自有一次轻微淡入。
    status.classList.remove('vrc-ule-status-animate');
    void status.offsetWidth;
    status.classList.add('vrc-ule-status-animate');
  };

  /**
   * 展开和收起使用 Web Animations API。
   * 除透明度外同时改变容器高度和内边距，外层卡片才会真正平滑撑开。
   */
  function setExpanded(expanded) {
    toggleButton.setAttribute('aria-expanded', String(expanded));

    if (reduceMotion.matches) {
      bodyAnimation?.cancel();
      bodyAnimation = null;
      body.hidden = !expanded;
      return;
    }

    // 反向点击时先读取正在播放的实际画面，再取消旧动画；新动画便会从当前帧继续，
    // 而不是瞬间跳回完全展开或完全收起的端点。
    let currentFrame = null;
    if (bodyAnimation) {
      const computed = getComputedStyle(body);
      currentFrame = {
        height: `${body.getBoundingClientRect().height}px`,
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        opacity: computed.opacity,
        transform: computed.transform === 'none' ? 'translateY(0)' : computed.transform,
      };
      bodyAnimation.cancel();
      bodyAnimation = null;
    }

    if (expanded) body.hidden = false;
    const expandedHeight = body.scrollHeight;
    const collapsedFrame = {
      height: '0px',
      paddingTop: '0px',
      paddingBottom: '0px',
      opacity: 0,
      transform: 'translateY(-5px)',
    };
    const expandedFrame = {
      height: `${expandedHeight}px`,
      paddingTop: '13px',
      paddingBottom: '13px',
      opacity: 1,
      transform: 'translateY(0)',
    };
    const destination = expanded ? expandedFrame : collapsedFrame;
    const keyframes = [currentFrame ?? (expanded ? collapsedFrame : expandedFrame), destination];

    const animation = body.animate(keyframes, {
      duration: expanded ? 280 : 210,
      easing: expanded ? 'cubic-bezier(.2,.8,.2,1)' : 'ease-in',
      fill: 'both',
    });
    bodyAnimation = animation;
    animation.addEventListener(
      'finish',
      () => {
        // 快速连点可能已经创建了更新的动画，旧回调不能修改新动画的状态。
        if (bodyAnimation !== animation) return;
        if (!expanded && toggleButton.getAttribute('aria-expanded') === 'false') body.hidden = true;
        // 清除 fill:both 留下的固定高度，恢复 CSS 的自动高度和 textarea 调整能力。
        animation.cancel();
        bodyAnimation = null;
      },
      { once: true },
    );
  }

  function showPanel() {
    if (!panel.hidden) return;
    panel.hidden = false;
    if (reduceMotion.matches) return;

    panel.animate(
      [
        { opacity: 0, transform: 'translateY(12px) scale(.97)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      {
        duration: 240,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      },
    );
  }

  function setCount(message) {
    if (count.textContent === message) return;
    count.textContent = message;
    if (!reduceMotion.matches) {
      count.animate(
        [
          { transform: 'scale(.92)', backgroundColor: '#f7f1c8' },
          { transform: 'scale(1)', backgroundColor: '#eee8bd' },
        ],
        { duration: 170, easing: 'ease-out' },
      );
    }
  }

  function updateCountFor(values) {
    setCount(
      hasLoadedList && listsEqual(values, loadedUrlList)
        ? `${values.length} 个`
        : `${values.length} 个 · 已编辑`,
    );
  }

  toggleButton.addEventListener('click', () => {
    setExpanded(toggleButton.getAttribute('aria-expanded') !== 'true');
  });

  /**
   * 删除重复项并重写文本框。
   * 仅在一个输入项已经结束后调用，避免用户输入 example.com.cn 的途中，
   * 因暂时匹配已有 example.com 而被提前删除。
   */
  function dedupeInput({ analysis = analyzeInput(input.value), announce = true } = {}) {
    if (analysis.duplicateCount > 0) {
      input.value = analysis.text;
      input.setSelectionRange(input.value.length, input.value.length);
      if (announce) setStatus(`已自动移除 ${analysis.duplicateCount} 个重复域名`);
    }

    updateCountFor(analysis.values);
    return analysis.values;
  }

  // 编辑时即时更新数量徽标；输入尚不完整时只提示“待检查”，不打断输入。
  input.addEventListener('input', (event) => {
    deferredDuplicateCount = 0;
    inputTouchedSinceLoad = true;
    try {
      const analysis = analyzeInput(input.value);

      // 粘贴或输入分隔符说明当前域名已经结束，此时才安全地自动去重。
      const entryFinished =
        event.inputType === 'insertFromPaste' ||
        event.inputType === 'insertLineBreak' ||
        event.inputType === 'insertParagraph' ||
        (typeof event.data === 'string' && /[\s,，;；]/.test(event.data));
      if (entryFinished) {
        dedupeInput({ analysis });
        return;
      }

      updateCountFor(analysis.values);
    } catch {
      setCount('待检查');
    }
  });

  // 用户离开文本框时，当前输入项已经完成，可以安全去重。
  input.addEventListener('blur', (event) => {
    try {
      const analysis = analyzeInput(input.value);
      const deferNotice = event.relatedTarget === sortButton || event.relatedTarget === submit;
      dedupeInput({ analysis, announce: !deferNotice });
      deferredDuplicateCount = deferNotice ? analysis.duplicateCount : 0;
    } catch {
      // 无效域名由排序或保存操作给出具体错误，不在失焦时打断用户。
    }
  });

  sortButton.addEventListener('click', () => {
    try {
      const current = analyzeInput(input.value);
      const removedDuplicates = deferredDuplicateCount + current.duplicateCount;
      deferredDuplicateCount = 0;
      const sortedValues = sortDomains(current.values);
      const sortedText = sortedValues.join('\n');

      if (listsEqual(current.values, sortedValues) && input.value.trim() === sortedText) {
        setStatus(
          removedDuplicates
            ? `已移除 ${removedDuplicates} 个重复域名，其余域名已经有序`
            : `无需调整，${sortedValues.length} 个域名已经有序`,
        );
        return;
      }

      input.value = sortedText;
      inputTouchedSinceLoad = true;
      input.setSelectionRange(input.value.length, input.value.length);
      updateCountFor(sortedValues);
      setStatus(
        `已按域名层级排序 ${sortedValues.length} 个域名` +
          (removedDuplicates ? `，并移除 ${removedDuplicates} 个重复项` : ''),
      );
    } catch (error) {
      setStatus(`无法排序：${error.message}`, true);
    }
  });

  /**
   * 从服务器读取当前世界的最新 urlList，并填入文本框。
   *
   * VRChat 网站是 SPA，切换页面时可能不会刷新浏览器，因此每次读取都
   * 根据 location.pathname 重新解析世界 ID，而不是只在脚本启动时读取一次。
   */
  async function loadCurrentList({ automatic = false, restoreSavedDraft = true } = {}) {
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;

    try {
      const worldId = getWorldId();
      if (!worldId) throw new Error('当前网址中没有世界 ID');
      updateControls();
      setStatus(automatic ? '正在自动读取当前列表……' : '正在读取……');
      const world = await api(`/api/1/worlds/${worldId}`, {
        signal: controller.signal,
      });

      // 若请求期间用户已切换到另一个世界，丢弃这个过期响应。
      if (controller.signal.aborted || worldId !== getWorldId()) return;

      loadedUrlList = getWorldList(world);
      const writeCheck = inspectUncertainWrite(worldId, loadedUrlList);
      hasLoadedList = true;
      inputTouchedSinceLoad = false;
      deferredDuplicateCount = 0;
      input.value = loadedUrlList.join('\n');
      loadedWorldId = worldId;
      const restoredDraft = restoreSavedDraft && restoreDraft(worldId);
      if (!restoredDraft) setCount(`${loadedUrlList.length} 个`);

      if (writeCheck?.state === 'waiting') {
        setStatus(`上次保存仍待确认，请约 ${writeCheck.seconds} 秒后重新载入；草稿已保留`, true);
      } else if (writeCheck?.state === 'saved') {
        setStatus(restoredDraft ? '已确认上次保存成功，并恢复之后的草稿' : '已确认上次保存成功');
      } else if (writeCheck?.state === 'expired') {
        setStatus(restoredDraft ? '等待期后未发现上次内容，已恢复草稿' : '等待期后未发现上次内容');
      } else {
        setStatus(restoredDraft ? '已载入服务器列表，并恢复未保存草稿' : `已载入 ${loadedUrlList.length} 个域名`);
      }
    } catch (error) {
      // AbortError 是正常的页面切换或重复读取，不显示成故障。
      if (error.name === 'AbortError') return;
      setStatus(`读取失败：${error.message}`, true);
    } finally {
      if (loadController === controller) {
        loadController = null;
        updateControls();
      }
    }
  }

  loadButton.addEventListener('click', () => {
    const worldId = getWorldId();

    // 写入结果未知时，“重新载入”只核对服务器状态，仍会恢复当前草稿。
    if (worldId && uncertainWrites.has(worldId)) {
      saveDraftForLoadedWorld();
      loadCurrentList();
      return;
    }

    if (hasUnsavedChanges() && !confirm('重新载入会丢弃尚未保存的编辑，确定继续吗？')) return;
    if (worldId) draftsByWorld.delete(worldId);
    loadCurrentList({ restoreSavedDraft: false });
  });

  // 接受已经由服务器确认的列表。若用户在请求期间去了别的页面，只清理该世界草稿，
  // 不触碰当前页面；若已经回到同一世界，则直接同步界面而不再发起多余请求。
  function applyServerList(worldId, values, message) {
    draftsByWorld.delete(worldId);
    uncertainWrites.delete(worldId);
    if (worldId !== getWorldId()) return;

    loadedWorldId = worldId;
    loadedUrlList = [...values];
    hasLoadedList = true;
    inputTouchedSinceLoad = false;
    deferredDuplicateCount = 0;
    input.value = values.join('\n');
    setCount(`${values.length} 个`);
    setStatus(message);
  }

  /**
   * PUT 成功响应若没有 urlList，不能直接假定写入成功，而是再 GET 一次核对。
   * PUT 超时或网络中断时，请求仍可能已抵达服务器，同样通过 GET 消除不确定性。
   */
  async function saveAndVerify(worldId, expected) {
    let response = null;
    let writeError = null;

    try {
      response = await api(`/api/1/worlds/${worldId}`, {
        method: 'PUT',
        body: JSON.stringify({ urlList: expected }),
      });
    } catch (error) {
      writeError = error;
    }

    if (Array.isArray(response?.urlList)) {
      const responseList = normalizeServerList(response.urlList);
      if (listsEqual(responseList, expected)) return responseList;
    }

    const writeUncertain = writeError?.writeUncertain === true;
    const verificationDelays = writeUncertain ? [0, 1_500, 3_500, 7_000] : [0];
    let verifiedList = null;
    let verificationError = null;

    if (writeUncertain && worldId === getWorldId()) {
      setStatus('请求中断，正在确认服务器是否已经保存……');
    }

    // 不确定写入采用递增间隔复核，期间 pendingWrite 始终保持，不能发起第二次 PUT。
    for (const delay of verificationDelays) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        verifiedList = getWorldList(
          await api(`/api/1/worlds/${worldId}`, {
            timeoutMs: writeUncertain ? 5_000 : REQUEST_TIMEOUT_MS,
          }),
        );
        verificationError = null;
        if (listsEqual(verifiedList, expected)) return verifiedList;
      } catch (error) {
        verificationError = error;
      }
    }

    if (writeUncertain) {
      const error = new Error('保存结果暂时无法确认，请点击“重新载入”核对服务器状态');
      error.resultUncertain = true;
      error.expected = [...expected];
      error.releaseAfter = Date.now() + UNCERTAIN_WRITE_GUARD_MS;
      throw error;
    }
    if (writeError) throw writeError;
    if (verificationError) throw new Error(`无法确认保存结果：${verificationError.message}`);
    throw new Error('服务器保存的白名单与提交内容不一致，请重新载入确认');
  }

  submit.addEventListener('click', async () => {
    if (isSubmitting || pendingWrite || uncertainWrites.has(getWorldId())) return;

    const sequence = ++submitSequence;
    const worldId = getWorldId();
    let writeToken = null;

    try {
      if (!worldId) throw new Error('当前网址中没有世界 ID');

      // 本地列表与最后载入的列表完全一致时立即停止。
      // 这一判断位于所有 API 调用之前，因此不会发送 GET 或 PUT 请求。
      const draftInput = analyzeInput(input.value);
      const removedDuplicates = deferredDuplicateCount + draftInput.duplicateCount;
      deferredDuplicateCount = 0;
      if (loadedWorldId === worldId && hasLoadedList && listsEqual(draftInput.values, loadedUrlList)) {
        input.value = draftInput.text;
        inputTouchedSinceLoad = false;
        draftsByWorld.delete(worldId);
        updateCountFor(draftInput.values);
        setStatus(
          removedDuplicates
            ? `已移除 ${removedDuplicates} 个重复域名，服务器无需更新`
            : `没有修改，已取消提交（${draftInput.values.length} 个域名）`,
        );
        return;
      }

      // 保存严格保留当前排列顺序；只有点击“自动排序”才会调整顺序。
      const entered = draftInput.values;
      input.value = draftInput.text;
      draftsByWorld.set(worldId, input.value);

      // 即便文本框已经自动载入，提交时仍重新 GET 一次。
      // 这样可以降低页面停留较久后覆盖掉其他修改的风险。
      isSubmitting = true;
      updateControls();
      setStatus('正在读取服务器上的最新数据……');
      const world = await api(`/api/1/worlds/${worldId}`);

      // 提交期间切换了路由：旧请求可以自然结束，但绝不能再更新新页面的面板。
      if (!isActiveSubmit(sequence, worldId)) return;

      let current = getWorldList(world);
      // 文本框就是最终列表；analyzeInput 已经完成规范化和去重。
      // 文本框为空时 next 也是空数组，即清空服务器上的 urlList。
      const next = entered;

      if (listsEqual(current, next)) {
        applyServerList(
          worldId,
          current,
          `服务器已是目标内容，无需提交（${current.length} 个域名）` +
            (removedDuplicates ? `；已移除 ${removedDuplicates} 个重复项` : ''),
        );
        return;
      }

      // 如果从“载入”到“提交”期间服务器列表被其他页面修改，
      // 确认框会明确提醒，但仍允许用户选择以当前文本框覆盖。
      let warning = hasLoadedList && !listsEqual(loadedUrlList, current)
        ? '⚠ 服务器列表在载入后已发生变化，本次保存会覆盖它。'
        : null;
      loadedWorldId = worldId;
      loadedUrlList = [...current];
      hasLoadedList = true;
      updateCountFor(next);

      while (true) {
        // Set 查询是 O(1)，列表较长时比反复使用 includes 更稳妥。
        const currentSet = new Set(current);
        const nextSet = new Set(next);
        const added = next.filter((item) => !currentSet.has(item));
        const removed = current.filter((item) => !nextSet.has(item));
        const summary = [
          `世界：${world.name ? `${world.name} (${worldId})` : worldId}`,
          `当前 ${current.length} 个 → 修改后 ${next.length} 个`,
          `新增 ${added.length} 个，删除 ${removed.length} 个`,
          ...(removedDuplicates ? [`自动移除 ${removedDuplicates} 个重复域名`] : []),
          ...(added.length === 0 && removed.length === 0 ? ['仅调整域名排序'] : []),
          ...(warning ? ['', warning] : []),
          '',
          '确定立即提交吗？',
        ].join('\n');

        if (!confirm(summary)) {
          setStatus(
            removedDuplicates
              ? `已取消提交；已在本地移除 ${removedDuplicates} 个重复域名`
              : '已取消，没有修改',
          );
          return;
        }

        if (!isActiveSubmit(sequence, worldId)) return;
        setStatus('正在进行保存前最终检查……');
        const latestWorld = await api(`/api/1/worlds/${worldId}`);
        if (!isActiveSubmit(sequence, worldId)) return;
        const latest = getWorldList(latestWorld);
        if (listsEqual(latest, current)) break;

        current = latest;
        loadedUrlList = [...current];
        updateCountFor(next);
        if (listsEqual(current, next)) {
          applyServerList(
            worldId,
            current,
            `确认期间服务器已变为目标内容，无需提交（${current.length} 个域名）`,
          );
          return;
        }
        warning = '⚠ 服务器列表在确认期间再次发生变化，请核对后重新确认。';
      }

      // HAR 中确认的更新方式：PUT /api/1/worlds/{worldId}
      // 仅发送 urlList，避免把预读取到的其他世界字段一并覆盖回服务器。
      writeToken = { worldId };
      pendingWrite = writeToken;
      updateControls();
      setStatus('正在提交……');
      let savedList;
      try {
        savedList = await saveAndVerify(worldId, next);
      } finally {
        if (pendingWrite === writeToken) {
          pendingWrite = null;
          updateControls();
        }
      }

      applyServerList(
        worldId,
        savedList,
        `修改成功：服务器现有 ${savedList.length} 个域名` +
          (removedDuplicates ? `；已移除 ${removedDuplicates} 个重复项` : ''),
      );
    } catch (error) {
      if (error.resultUncertain) {
        uncertainWrites.set(worldId, {
          expected: error.expected,
          releaseAfter: error.releaseAfter,
        });
        if (worldId === getWorldId()) {
          setStatus(`${error.message}；草稿已保留，确认前不能再次保存`, true);
        }
      } else if (isActiveSubmit(sequence, worldId)) {
        setStatus(`提交失败：${error.message}`, true);
      } else if (worldId === getWorldId()) {
        // 返回原世界时重新建立服务器基线，并恢复之前按世界保存的草稿。
        saveDraftForLoadedWorld();
        await loadCurrentList({ automatic: true });
      }
    } finally {
      if (pendingWrite === writeToken) pendingWrite = null;
      if (sequence === submitSequence) {
        isSubmitting = false;
      }
      updateControls();
    }
  });

  /**
   * 根据当前 SPA 路径同步面板状态：
   * - 位于世界编辑页：显示面板，必要时读取当前世界。
   * - 位于其他页面：立即隐藏面板并使进行中的旧请求失效。
   */
  function syncPanelWithCurrentPage() {
    const worldId = getWorldId();

    // 离开当前世界前按世界保存草稿；回到该世界时会在最新服务器列表之上恢复。
    if (worldId !== loadedWorldId) saveDraftForLoadedWorld();

    if (!worldId) {
      panel.hidden = true;
      loadedWorldId = null;
      loadedUrlList = [];
      hasLoadedList = false;
      input.value = '';
      inputTouchedSinceLoad = false;
      deferredDuplicateCount = 0;
      setCount('读取中');
      submitSequence++;
      isSubmitting = false;
      loadController?.abort();
      loadController = null;
      updateControls();
      return;
    }

    showPanel();
    if (worldId !== loadedWorldId) {
      setCount('读取中');
      // 切换世界时让旧世界尚未完成的提交停止操作当前界面。
      submitSequence++;
      isSubmitting = false;
      loadController?.abort();
      loadController = null;

      // 立即清除上一个世界的数据。即便新世界读取失败，也不会让用户误把
      // 上一个世界的白名单提交到当前世界。
      input.value = '';
      loadedUrlList = [];
      hasLoadedList = false;
      inputTouchedSinceLoad = false;
      deferredDuplicateCount = 0;
      setStatus('正在切换世界……');

      // 先标记，避免同一轮路由事件重复发起同一个 GET。若该世界仍有 PUT
      // 在执行，则等待其完成后直接同步，避免提前读取并显示旧列表。
      loadedWorldId = worldId;
      restoreDraft(worldId);
      if (pendingWrite?.worldId === worldId) {
        setStatus('正在等待上次保存完成……');
        updateControls();
      } else {
        loadCurrentList({ automatic: true });
      }
    }
  }

  const ROUTE_EVENT = 'vrc-url-list-route-change';
  let lastObservedUrl = '';
  let routeSyncQueued = false;

  /**
   * 所有路由来源共用同一个入口，并按完整 URL 去重。
   * pathname、查询参数或 hash 任一变化都会被识别，但同一次跳转只同步一次。
   */
  function syncRoute({ force = false } = {}) {
    const currentUrl = location.href;
    if (!force && currentUrl === lastObservedUrl) return;
    lastObservedUrl = currentUrl;
    syncPanelWithCurrentPage();
  }

  function queueRouteSync() {
    if (routeSyncQueued) return;
    routeSyncQueued = true;
    queueMicrotask(() => {
      routeSyncQueued = false;
      syncRoute();
    });
  }

  /**
   * VRChat 使用 History API 完成站内跳转，普通的 popstate 只覆盖
   * 前进/后退，捕获不到代码主动调用 pushState/replaceState 的情况。
   * 因此包装这两个方法，并派发一个仅供本脚本使用的路由事件。
   */
  const ROUTE_HOOK_KEY = '__vrcUrlListRouteHookInstalled';
  if (!window[ROUTE_HOOK_KEY]) {
    window[ROUTE_HOOK_KEY] = true;
    for (const methodName of ['pushState', 'replaceState']) {
      const originalMethod = history[methodName];
      history[methodName] = function (...args) {
        const result = originalMethod.apply(this, args);
        window.dispatchEvent(new Event(ROUTE_EVENT));
        return result;
      };
    }
  }

  window.addEventListener('popstate', queueRouteSync);
  window.addEventListener('hashchange', queueRouteSync);
  window.addEventListener(ROUTE_EVENT, queueRouteSync);

  // Chromium Navigation API 可更直接地捕获现代 SPA 跳转；不存在时自动跳过。
  if (window.navigation) {
    window.navigation.addEventListener('currententrychange', queueRouteSync);
  }

  /**
   * 兜底检测 URL 变化。
   * 某些 SPA 路由器会在本脚本加载前保存原始 History 方法，导致上面的
   * pushState/replaceState 包装捕获不到跳转。这里只比较 URL，不会定时请求 API。
   */
  setInterval(() => {
    syncRoute();
  }, 500);

  // 处理脚本首次注入时所在的页面。
  syncRoute({ force: true });
})();
