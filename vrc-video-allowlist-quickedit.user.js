// ==UserScript==
// @name         VRC-Video-Allowlist-QuickEdit
// @namespace    https://github.com/mmyo456/VRC-Video-Allowlist-QuickEdit
// @author       鸭鸭
// @version      0.0.3
// @description  用于快速批量编辑 VRChat 世界播放器域名白名单的Tampermonkey脚本
// @icon         https://i.ouo.chat/favicon.ico
// @match        https://vrchat.com/home*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/mmyo456/VRC-Video-Allowlist-QuickEdit/main/vrc-video-allowlist-quickEdit.user.js
// @updateURL    https://raw.githubusercontent.com/mmyo456/VRC-Video-Allowlist-QuickEdit/main/vrc-video-allowlist-quickEdit.user.js
// ==/UserScript==

(() => {
  'use strict';

  // 世界编辑页地址示例：
  // /home/content/worlds/wrld_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/edit
  // 此正则只负责从当前地址中取出 wrld_ 开头的世界 ID。
  const WORLD_ID_RE = /\/worlds\/(wrld_[0-9a-f-]+)\/edit/i;

  // VRChat 网页保存世界资料时会把这些可编辑字段一起发送。
  // 提交前先 GET 最新世界资料，再仅复制这些字段，可以避免把
  // visits、favorites、authorId 等只读字段误发回服务器。
  const EDITABLE_FIELDS = [
    'capacity',
    'description',
    'name',
    'previewYoutubeId',
    'recommendedCapacity',
    'releaseStatus',
    'tags',
    'urlList',
    'disabledPropAbilities',
  ];

  const getWorldId = () => location.pathname.match(WORLD_ID_RE)?.[1] ?? null;

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

  const listsEqual = (left, right) =>
    left.length === right.length && left.every((item, index) => item === right[index]);

  /**
   * 同源 API 请求封装。
   * credentials: 'include' 会使用 vrchat.com 当前登录会话，
   * 脚本中不需要保存 Cookie、密码或 Token。
   */
  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return body;
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
      .vrc-ule-label span { color: #625c49; font-size: 11px; font-weight: 450; }
      #vrc-ule-body textarea {
        display: block; width: 100%; min-height: 170px; padding: 10px 11px; resize: vertical;
        border: 1px solid #8f8566; border-radius: 9px;
        color: #29271f; background: #f7f2d8;
        box-shadow: inset 0 1px 3px #5f57351c;
        font: 12.5px/1.55 ui-monospace, "Cascadia Code", Consolas, monospace;
      }
      #vrc-ule-body textarea::placeholder { color: #89816a; }
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

  // 当前读取请求的控制器。发起新读取或离开编辑页时会主动取消旧请求，
  // 避免无用网络传输，也避免旧世界的响应覆盖新世界的文本框。
  let loadController = null;
  let loadedWorldId = null;
  let loadedUrlList = [];
  let submitSequence = 0;
  let isSubmitting = false;

  const isActiveSubmit = (sequence, worldId) =>
    sequence === submitSequence && worldId === getWorldId();

  function hasUnsavedChanges() {
    try {
      return !listsEqual(analyzeInput(input.value).values, loadedUrlList);
    } catch {
      // 存在尚未完成或无效的输入时，也应视为未保存内容。
      return input.value.trim() !== loadedUrlList.join('\n');
    }
  }

  // 统一维护控件状态，避免读取和提交的 finally 相互把按钮错误地重新启用。
  function updateControls() {
    const busy = isSubmitting || loadController !== null;
    input.disabled = busy;
    submit.disabled = busy;
    sortButton.disabled = busy;
    loadButton.disabled = isSubmitting || loadController !== null;
  }

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.style.color = isError ? '#8b1e1e' : '#365b3c';

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
    bodyAnimation?.cancel();
    bodyAnimation = null;

    if (reduceMotion.matches) {
      body.hidden = !expanded;
      return;
    }

    if (expanded) body.hidden = false;
    const expandedHeight = body.scrollHeight;
    const currentHeight = body.offsetHeight;
    const keyframes = expanded
      ? [
          {
            height: '0px',
            paddingTop: '0px',
            paddingBottom: '0px',
            opacity: 0,
            transform: 'translateY(-5px)',
          },
          {
            height: `${expandedHeight}px`,
            paddingTop: '13px',
            paddingBottom: '13px',
            opacity: 1,
            transform: 'translateY(0)',
          },
        ]
      : [
          {
            height: `${currentHeight}px`,
            paddingTop: '13px',
            paddingBottom: '13px',
            opacity: 1,
            transform: 'translateY(0)',
          },
          {
            height: '0px',
            paddingTop: '0px',
            paddingBottom: '0px',
            opacity: 0,
            transform: 'translateY(-5px)',
          },
        ];

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
    setCount(listsEqual(values, loadedUrlList) ? `${values.length} 个` : `${values.length} 个 · 已编辑`);
  }

  toggleButton.addEventListener('click', () => {
    setExpanded(toggleButton.getAttribute('aria-expanded') !== 'true');
  });

  /**
   * 删除重复项并重写文本框。
   * 仅在一个输入项已经结束后调用，避免用户输入 example.com.cn 的途中，
   * 因暂时匹配已有 example.com 而被提前删除。
   */
  function dedupeInput({ analysis = analyzeInput(input.value) } = {}) {
    if (analysis.duplicateCount > 0) {
      input.value = analysis.text;
      input.setSelectionRange(input.value.length, input.value.length);
      setStatus(`已自动移除 ${analysis.duplicateCount} 个重复域名`);
    }

    updateCountFor(analysis.values);
    return analysis.values;
  }

  // 编辑时即时更新数量徽标；输入尚不完整时只提示“待检查”，不打断输入。
  input.addEventListener('input', (event) => {
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
  input.addEventListener('blur', () => {
    try {
      dedupeInput();
    } catch {
      // 无效域名由排序或保存操作给出具体错误，不在失焦时打断用户。
    }
  });

  sortButton.addEventListener('click', () => {
    try {
      const current = analyzeInput(input.value);
      const sortedValues = sortDomains(current.values);
      const sortedText = sortedValues.join('\n');

      if (listsEqual(current.values, sortedValues) && input.value.trim() === sortedText) {
        setStatus(`无需调整，${sortedValues.length} 个域名已经有序`);
        return;
      }

      input.value = sortedText;
      input.setSelectionRange(input.value.length, input.value.length);
      updateCountFor(sortedValues);
      setStatus(`已按域名层级排序 ${sortedValues.length} 个域名`);
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
  async function loadCurrentList({ automatic = false } = {}) {
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

      loadedUrlList = normalizeServerList(world.urlList);
      input.value = loadedUrlList.join('\n');
      setCount(`${loadedUrlList.length} 个`);
      loadedWorldId = worldId;
      setStatus(`已载入 ${loadedUrlList.length} 个域名`);
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
    if (hasUnsavedChanges() && !confirm('重新载入会丢弃尚未保存的编辑，确定继续吗？')) return;
    loadCurrentList();
  });

  submit.addEventListener('click', async () => {
    const sequence = ++submitSequence;
    const worldId = getWorldId();

    try {
      if (!worldId) throw new Error('当前网址中没有世界 ID');

      // 本地列表与最后载入的列表完全一致时立即停止。
      // 这一判断位于所有 API 调用之前，因此不会发送 GET 或 PUT 请求。
      const draftInput = analyzeInput(input.value);
      if (listsEqual(draftInput.values, loadedUrlList)) {
        updateCountFor(draftInput.values);
        setStatus(`没有修改，已取消提交（${draftInput.values.length} 个域名）`);
        return;
      }

      // 保存严格保留当前排列顺序；只有点击“自动排序”才会调整顺序。
      const entered = draftInput.values;
      input.value = draftInput.text;

      // 即便文本框已经自动载入，提交时仍重新 GET 一次。
      // 这样可以降低页面停留较久后覆盖掉其他修改的风险。
      isSubmitting = true;
      updateControls();
      setStatus('正在读取服务器上的最新数据……');
      const world = await api(`/api/1/worlds/${worldId}`);

      // 提交期间切换了路由：旧请求可以自然结束，但绝不能再更新新页面的面板。
      if (!isActiveSubmit(sequence, worldId)) return;

      const current = normalizeServerList(world.urlList);
      // 文本框就是最终列表；analyzeInput 已经完成规范化和去重。
      // 文本框为空时 next 也是空数组，即清空服务器上的 urlList。
      const next = entered;

      // Set 查询是 O(1)，列表较长时比在 filter 中反复使用 includes 更稳妥。
      const currentSet = new Set(current);
      const nextSet = new Set(next);
      const added = next.filter((item) => !currentSet.has(item));
      const removed = current.filter((item) => !nextSet.has(item));
      if (listsEqual(current, next)) {
        setStatus(`没有变化，当前仍为 ${current.length} 个域名`);
        return;
      }

      // 如果从“载入”到“提交”期间服务器列表被其他页面修改，
      // 确认框会明确提醒，但仍允许用户选择以当前文本框覆盖。
      const serverChanged = !listsEqual(loadedUrlList, current);

      const summary = [
        `世界：${world.name} (${worldId})`,
        `当前 ${current.length} 个 → 修改后 ${next.length} 个`,
        `新增 ${added.length} 个，删除 ${removed.length} 个`,
        ...(added.length === 0 && removed.length === 0 ? ['仅调整域名排序'] : []),
        ...(serverChanged ? ['', '⚠ 服务器列表在载入后已发生变化，本次保存会覆盖它。'] : []),
        '',
        '确定立即提交吗？',
      ].join('\n');
      if (!confirm(summary)) {
        setStatus('已取消，没有修改');
        return;
      }

      // confirm 弹窗打开时也可能发生脚本导航，发送 PUT 前再检查一次。
      if (!isActiveSubmit(sequence, worldId)) return;

      const payload = {};
      for (const key of EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(world, key)) payload[key] = world[key];
      }
      payload.urlList = next;

      // HAR 中确认的更新方式：PUT /api/1/worlds/{worldId}
      setStatus('正在提交……');
      const updated = await api(`/api/1/worlds/${worldId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      // PUT 期间若用户离开后又返回同一世界，之前触发的 GET 可能读到了
      // PUT 完成前的旧列表。此时重新读取一次，确保面板与服务器一致。
      if (!isActiveSubmit(sequence, worldId)) {
        if (worldId === getWorldId()) loadCurrentList({ automatic: true });
        return;
      }

      const savedList = normalizeServerList(Array.isArray(updated?.urlList) ? updated.urlList : next);
      loadedUrlList = [...savedList];
      input.value = savedList.join('\n');
      setCount(`${savedList.length} 个`);
      setStatus(`修改成功：服务器现有 ${savedList.length} 个域名`);
    } catch (error) {
      if (isActiveSubmit(sequence, worldId)) {
        setStatus(`提交失败：${error.message}`, true);
      } else if (worldId === getWorldId()) {
        // 请求失败时服务器是否已处理 PUT 未必可知，返回原世界后同样重新确认。
        loadCurrentList({ automatic: true });
      }
    } finally {
      if (sequence === submitSequence) {
        isSubmitting = false;
        updateControls();
      }
    }
  });

  /**
   * 根据当前 SPA 路径同步面板状态：
   * - 位于世界编辑页：显示面板，必要时读取当前世界。
   * - 位于其他页面：立即隐藏面板并使进行中的旧请求失效。
   */
  function syncPanelWithCurrentPage() {
    const worldId = getWorldId();

    if (!worldId) {
      panel.hidden = true;
      loadedWorldId = null;
      loadedUrlList = [];
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
      updateControls();

      // 立即清除上一个世界的数据。即便新世界读取失败，也不会让用户误把
      // 上一个世界的白名单提交到当前世界。
      input.value = '';
      loadedUrlList = [];
      setStatus('正在切换世界……');

      // 先标记，避免同一轮路由事件重复发起同一个 GET。
      // 若自动读取失败，仍可点击“载入当前列表”手动重试。
      loadedWorldId = worldId;
      loadCurrentList({ automatic: true });
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
