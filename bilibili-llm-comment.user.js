// ==UserScript==
// @name         B 站嘴替小助手
// @namespace    https://github.com/codertesla/bili-comment-buddy
// @version      0.5.1
// @description  为当前 B 站视频生成可编辑的相关评论，默认测试模式，支持受限自动发布。
// @author       codertesla
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*/dynamic*
// @match        https://space.bilibili.com/*/video*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP = Object.freeze({
    prefix: '[B 站嘴替小助手]',
    panelId: 'bllmc-panel',
    version: '0.5.1',
    requestTimeoutMs: 30000,
    requestRetries: 1,
    maxComments: 10,
    maxDescriptionChars: 1200,
    maxCommentContextChars: 1800,
    minPublishIntervalMs: 10 * 60 * 1000,
    routeDebounceMs: 800,
  });

  const COMMENT_STYLE_PRESETS = Object.freeze({
    relaxed: {
      label: '轻松活泼',
      prompt: '轻松、活泼，观点可以新颖、视角可以独特；贴近 B 站网友放松、调侃，甚至可以有点戏谑的风格，不需要太过于正式，读起来可能会让人会心一笑。像认真看过视频的普通观众；默认不使用 emoji。',
    },
    formal: {
      label: '理性正式',
      prompt: '表达克制、清晰、偏正式，像认真看完视频后给出的理性反馈；可以指出亮点、结构或信息价值，不夸张吹捧，不使用网络梗，默认不使用 emoji。',
    },
    warm: {
      label: '友好鼓励',
      prompt: '语气友好、真诚、有鼓励感，像普通观众自然留下的正向反馈；可以适度表达认可，但避免空泛夸赞和营销感，默认不使用 emoji。',
    },
    sharp: {
      label: '犀利观点',
      prompt: '观点鲜明、简洁、有一点犀利，但保持礼貌和建设性；可以从视频内容里挑出一个具体角度做判断，不引战、不攻击创作者或其他观众，默认不使用 emoji。',
    },
    custom: {
      label: '自定义',
      prompt: '',
    },
  });

  const DEFAULT_CONFIG = Object.freeze({
    schemaVersion: 3,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4-flash',
    temperature: 1.0,
    stylePreset: 'relaxed',
    style: COMMENT_STYLE_PRESETS.relaxed.prompt,
    dailyAutoPublishLimit: 5,
    autoPublish: false,
    testMode: true,
  });

  const SYSTEM_PROMPT = `你负责为 B 站视频撰写一条中文评论。严格遵守：
1. 只返回评论正文，不要引号、标签、解释或前后缀。
2. 长度为 20～100 个中文字符（标点计入即可，不必机械计数）。
3. 评论必须关联给定视频的具体内容，但不要直接复述标题。
4. 不要声称“作为 AI”，不要编造输入中没有的事实。
5. 不要模仿、改写或拼接已有评论。
6. 避免空洞套话、夸张吹捧、引战和营销语气。
7. 默认不使用 emoji。`;

  // 页面结构可能变化；所有 DOM 选择器集中在此，失败时会显示明确错误。
  const SELECTORS = Object.freeze({
    title: ['h1.video-title', 'h1[title]', '.video-title', 'meta[property="og:title"]'],
    description: ['.desc-info-text', '.video-desc-container .desc-info-text', '#v_desc .desc-info-text', 'meta[name="description"]'],
    uploader: ['.up-name', '.up-info-container .name', '.members-info .up-name', 'meta[name="author"]'],
    commentItems: ['.reply-item', '.root-reply-container', 'bili-comment-thread-renderer'],
    commentText: ['.reply-content', '.root-reply .reply-content', '.content-warp .content', 'bili-rich-text'],
    commentLike: ['#like #count', '.like .count', '.reply-like .count', '.like span', '[data-like-count]'],
    commentEditors: [
      '.brt-editor[contenteditable="true"]',
      '#editor[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
      'bili-comment-box textarea',
      'bili-comment-box [contenteditable="true"]',
      '.comment-box textarea',
      '.comment-box [contenteditable="true"]',
      '.reply-box textarea',
      '.reply-box [contenteditable="true"]',
      'textarea[placeholder*="评论"]',
      '[contenteditable="true"][data-placeholder*="评论"]',
    ],
    commentContainers: ['bili-comments', '#commentapp', '.video-comments', '.comment-container'],
    commentActivators: [
      'bili-comment-rich-textarea',
      '.brt-placeholder',
      'bili-comment-box .placeholder',
      '#commentbox .placeholder',
      '.commentbox-placeholder',
      '[class*="placeholder"]',
    ],
    sendButtons: [
      'button.reply-box-send',
      'button.send-btn',
      'button.pub',
      'bili-comment-box button[type="submit"]',
      'bili-comment-box .send-button',
      '.comment-box button[type="submit"]',
      '.comment-box .send-button',
      '.reply-box .send-button',
      '.reply-box button[type="submit"]',
      'button[class*="send"]',
    ],
    loginButtons: ['.header-login-entry', '.login-entry', '[class*="login-entry"]'],
    loggedInAvatars: ['.header-avatar-wrap', '.v-popover-wrap .header-avatar', '.mini-avatar'],
    riskIndicators: ['.geetest_panel', '.geetest_holder', '[class*="captcha"]', '[class*="risk-control"]'],
    closedCommentText: ['.comment-closed', '.no-comment', '.reply-restriction'],
    discoveryRoots: ['main', '#app', '.bili-dyn-list', '.space-main'],
  });

  const Util = {
    sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    },
    normalizeText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    },
    truncate(value, max) {
      const text = this.normalizeText(value);
      return text.length > max ? `${text.slice(0, max)}…` : text;
    },
    escapeHtml(value) {
      return String(value || '').replace(/[&<>'"]/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
      })[char]);
    },
    parseCount(value) {
      const text = this.normalizeText(value).toLowerCase();
      const number = Number.parseFloat(text.replace(/[^\d.]/g, '')) || 0;
      if (text.includes('万')) return Math.round(number * 10000);
      if (text.includes('k')) return Math.round(number * 1000);
      return Math.round(number);
    },
    dateKey(timestamp = Date.now()) {
      const date = new Date(timestamp);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    },
    findFirst(selectors, root = document) {
      for (const selector of selectors) {
        const element = root.querySelector(selector);
        if (element) return element;
      }
      return null;
    },
    openRoots(root = document) {
      const roots = [root];
      for (let index = 0; index < roots.length; index += 1) {
        for (const element of roots[index].querySelectorAll('*')) {
          if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
        }
      }
      return roots;
    },
    findFirstDeep(selectors, root = document) {
      for (const currentRoot of this.openRoots(root)) {
        const element = this.findFirst(selectors, currentRoot);
        if (element) return element;
      }
      return null;
    },
    findAllDeep(selectors, root = document) {
      const matches = new Set();
      for (const currentRoot of this.openRoots(root)) {
        for (const selector of selectors) {
          currentRoot.querySelectorAll(selector).forEach((element) => matches.add(element));
        }
      }
      return Array.from(matches);
    },
    isVisible(element) {
      if (!element?.isConnected) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    },
    findFirstVisibleDeep(selectors, root = document) {
      return this.findAllDeep(selectors, root).find((element) => this.isVisible(element)) || null;
    },
    ancestorRoots(element) {
      const roots = [];
      let current = element;
      while (current) {
        const root = current.getRootNode?.();
        if (!root || roots.includes(root)) break;
        roots.push(root);
        current = root.host || null;
      }
      return roots;
    },
    readElement(element) {
      if (!element) return '';
      const shadowContent = element.shadowRoot?.querySelector('#contents, [part="contents"]');
      if (shadowContent) return this.normalizeText(shadowContent.textContent);
      return this.normalizeText(element.content || element.getAttribute?.('content')
        || element.textContent);
    },
    waitForAny(selectors, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const existing = this.findFirst(selectors);
        if (existing) return resolve(existing);
        const observer = new MutationObserver(() => {
          const element = this.findFirst(selectors);
          if (element) {
            cleanup();
            resolve(element);
          }
        });
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error(`等待页面元素超时：${selectors.join(', ')}`));
        }, timeoutMs);
        const cleanup = () => {
          observer.disconnect();
          window.clearTimeout(timer);
        };
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    },
    waitForAnyDeep(selectors, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
          const element = this.findFirstDeep(selectors);
          if (element) {
            cleanup();
            resolve(element);
          } else if (Date.now() - startedAt >= timeoutMs) {
            cleanup();
            reject(new Error(`等待 Shadow DOM 页面元素超时：${selectors.join(', ')}`));
          }
        };
        const timer = window.setInterval(check, 300);
        const cleanup = () => window.clearInterval(timer);
        check();
      });
    },
    waitForAnyVisibleDeep(selectors, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
          const element = this.findFirstVisibleDeep(selectors);
          if (element) {
            cleanup();
            resolve(element);
          } else if (Date.now() - startedAt >= timeoutMs) {
            cleanup();
            reject(new Error(`等待可见的 Shadow DOM 页面元素超时：${selectors.join(', ')}`));
          }
        };
        const timer = window.setInterval(check, 300);
        const cleanup = () => window.clearInterval(timer);
        check();
      });
    },
  };

  const Store = {
    keys: Object.freeze({
      config: 'bllmc_config_v1',
      processed: 'bllmc_processed_v1',
      publishStats: 'bllmc_publish_stats_v1',
    }),
    getConfig() {
      const saved = GM_getValue(this.keys.config, {});
      const migrated = saved && typeof saved === 'object' ? { ...saved } : {};
      if (migrated.schemaVersion !== DEFAULT_CONFIG.schemaVersion) {
        if (!migrated.model || migrated.model === 'deepseek-chat') migrated.model = DEFAULT_CONFIG.model;
        if (migrated.temperature === undefined || migrated.temperature === 0.7) {
          migrated.temperature = DEFAULT_CONFIG.temperature;
        }
        if (!migrated.stylePreset) migrated.stylePreset = 'custom';
        if (!migrated.style) migrated.style = DEFAULT_CONFIG.style;
        if (migrated.dailyAutoPublishLimit === undefined) {
          migrated.dailyAutoPublishLimit = DEFAULT_CONFIG.dailyAutoPublishLimit;
        }
        migrated.schemaVersion = DEFAULT_CONFIG.schemaVersion;
        GM_setValue(this.keys.config, { ...DEFAULT_CONFIG, ...migrated });
      }
      return this.normalizeConfig({ ...DEFAULT_CONFIG, ...migrated });
    },
    normalizeConfig(config) {
      const safe = { ...DEFAULT_CONFIG, ...config };
      safe.temperature = Math.max(0, Math.min(2, Number(safe.temperature) || DEFAULT_CONFIG.temperature));
      safe.dailyAutoPublishLimit = Math.max(1, Math.min(100, Math.floor(Number(safe.dailyAutoPublishLimit) || DEFAULT_CONFIG.dailyAutoPublishLimit)));
      if (!COMMENT_STYLE_PRESETS[safe.stylePreset]) safe.stylePreset = 'custom';
      safe.style = Util.normalizeText(safe.style) || COMMENT_STYLE_PRESETS[safe.stylePreset]?.prompt || DEFAULT_CONFIG.style;
      return safe;
    },
    setConfig(config) {
      const safe = this.normalizeConfig(config);
      GM_setValue(this.keys.config, safe);
      return safe;
    },
    getProcessed() {
      const value = GM_getValue(this.keys.processed, {});
      return value && typeof value === 'object' ? value : {};
    },
    isProcessed(bvid) {
      return Boolean(bvid && this.getProcessed()[bvid]);
    },
    markProcessed(video, mode) {
      const records = this.getProcessed();
      records[video.bvid] = {
        title: Util.truncate(video.title, 120),
        url: video.url,
        mode,
        processedAt: Date.now(),
      };
      const entries = Object.entries(records).sort((a, b) => b[1].processedAt - a[1].processedAt).slice(0, 500);
      GM_setValue(this.keys.processed, Object.fromEntries(entries));
    },
    getPublishStats() {
      const fallback = { date: Util.dateKey(), count: 0, lastPublishedAt: 0 };
      const value = GM_getValue(this.keys.publishStats, fallback);
      if (!value) return fallback;
      if (value.date !== Util.dateKey()) {
        return { ...fallback, lastPublishedAt: Number(value.lastPublishedAt) || 0 };
      }
      return { ...fallback, ...value };
    },
    recordPublish() {
      const stats = this.getPublishStats();
      GM_setValue(this.keys.publishStats, {
        date: Util.dateKey(), count: stats.count + 1, lastPublishedAt: Date.now(),
      });
    },
  };

  const Page = {
    getBvid(url = location.href) {
      return new URL(url, location.origin).pathname.match(/\/video\/(BV[\w]+)/i)?.[1] || '';
    },
    isVideoPage() {
      return Boolean(this.getBvid());
    },
    isDiscoveryPage() {
      return location.hostname === 't.bilibili.com'
        || /\/dynamic(?:\/|$)/.test(location.pathname)
        || /\/video(?:\/|$)/.test(location.pathname) && location.hostname === 'space.bilibili.com';
    },
    hasRiskPrompt() {
      const element = Util.findFirst(SELECTORS.riskIndicators);
      const bodyText = Util.normalizeText(document.body?.innerText).slice(-3000);
      return Boolean(element && element.offsetParent !== null)
        || /验证码|操作频繁|账号存在风险|风控验证/.test(bodyText);
    },
    loginState() {
      const initial = window.__INITIAL_STATE__;
      const mid = initial?.mid || initial?.loginInfo?.mid || initial?.userInfo?.mid;
      if (Number(mid) > 0) return 'logged-in';
      const loginButton = Util.findFirst(SELECTORS.loginButtons);
      if (loginButton && loginButton.offsetParent !== null) return 'logged-out';
      if (Util.findFirst(SELECTORS.loggedInAvatars)) return 'logged-in';
      return 'unknown';
    },
  };

  const Extractor = {
    jsonLd() {
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(node.textContent);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          const video = items.find((item) => /VideoObject/i.test(item?.['@type'] || ''));
          if (video) return video;
        } catch (_) {
          // Ignore malformed third-party JSON-LD and continue with DOM extraction.
        }
      }
      return {};
    },
    /** Read video metadata from B站's __INITIAL_STATE__ hydration data. */
    initialState() {
      const s = window.__INITIAL_STATE__;
      if (!s) return null;
      const vd = s.videoData || s;
      return {
        aid: Number(vd.aid) || 0,
        title: Util.normalizeText(vd.title),
        description: Util.normalizeText(vd.desc),
        uploader: Util.normalizeText(vd.owner?.name),
      };
    },
    /** Promise-wrapped GM_xmlhttpRequest for internal use. */
    gmFetch(url, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          anonymous: false,
          timeout: timeoutMs,
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
          },
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
        });
      });
    },
    /** Resolve the numeric aid for the current video (needed by the comment API). */
    async getAid(bvid) {
      // 1. Try __INITIAL_STATE__ first (instant, no request).
      const state = this.initialState();
      if (state?.aid) return state.aid;
      // 2. Try data-aid attribute on the page.
      const aidAttr = document.querySelector('[data-aid]')?.dataset?.aid;
      if (aidAttr && Number(aidAttr)) return Number(aidAttr);
      // 3. Fallback: call B站 view API to convert bvid → aid.
      try {
        const data = await this.gmFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        if (data?.data?.aid) return data.data.aid;
      } catch (_) { /* will return 0 below */ }
      return 0;
    },
    /** Fetch hot comments via B站's public reply API (no DOM / scrolling needed). */
    async fetchCommentsViaAPI(aid) {
      if (!aid) return [];
      try {
        const data = await this.gmFetch(
          `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=${APP.maxComments}`
        );
        const replies = data?.data?.replies;
        if (!Array.isArray(replies)) return [];
        const seen = new Set();
        return replies
          .map((r) => ({ text: Util.normalizeText(r?.content?.message), likes: Number(r?.like) || 0 }))
          .filter((c) => {
            const key = c.text.toLowerCase();
            return this.isUsefulComment(c.text) && !seen.has(key) && seen.add(key);
          })
          .sort((a, b) => b.likes - a.likes)
          .slice(0, APP.maxComments);
      } catch (_) {
        return [];
      }
    },
    /** DOM-based comment extraction (fallback when API is unavailable). */
    extractComments() {
      const itemSet = new Set(Util.findAllDeep(SELECTORS.commentItems));
      const seen = new Set();
      const comments = [];
      for (const item of itemSet) {
        const itemRoot = item.shadowRoot || item;
        const text = Util.readElement(Util.findFirstDeep(SELECTORS.commentText, itemRoot));
        const normalized = text.toLowerCase();
        if (!this.isUsefulComment(text) || seen.has(normalized)) continue;
        seen.add(normalized);
        const likeElement = Util.findFirstDeep(SELECTORS.commentLike, itemRoot);
        comments.push({ text: Util.truncate(text, 260), likes: Util.parseCount(Util.readElement(likeElement)) });
      }
      return comments.sort((a, b) => b.likes - a.likes).slice(0, APP.maxComments);
    },
    isUsefulComment(text) {
      if (!text || text.length < 6) return false;
      if (!/[\u3400-\u9fffA-Za-z0-9]/.test(text)) return false;
      if (/^(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}\s~～!！?？。,.，])+$/u.test(text)) return false;
      if (/(加群|VX|微信|兼职|代刷|返利|点击链接|私信.*领取|课程优惠)/i.test(text)) return false;
      return true;
    },
    async currentVideo() {
      if (!Page.isVideoPage()) throw new Error('当前不是可识别的 B 站视频页。');
      await Util.waitForAny(SELECTORS.title, 12000);

      // Collect metadata from multiple sources for robustness.
      const ldData = this.jsonLd();
      const stateData = this.initialState();
      const title = Util.readElement(Util.findFirst(SELECTORS.title))
        || (stateData?.title) || Util.normalizeText(ldData.name);
      const description = Util.readElement(Util.findFirst(SELECTORS.description))
        || (stateData?.description) || Util.normalizeText(ldData.description);
      let uploader = Util.readElement(Util.findFirst(SELECTORS.uploader));
      if (!uploader) uploader = stateData?.uploader || Util.normalizeText(ldData.author?.name || ldData.author);
      const bvid = Page.getBvid();
      if (!title) throw new Error('未找到视频标题，B 站页面结构可能已变化。');
      if (!uploader) throw new Error('未找到 UP 主名称，B 站页面结构可能已变化。');

      // Fetch comments: prefer API (reliable, no scrolling), then DOM fallback.
      const aid = await this.getAid(bvid);
      let comments = await this.fetchCommentsViaAPI(aid);
      let commentsSource = comments.length ? 'API' : 'none';
      if (!comments.length) {
        comments = this.extractComments();
        commentsSource = comments.length ? 'DOM' : 'none';
      }
      return {
        bvid,
        title: Util.truncate(title.replace(/_哔哩哔哩.*$/i, ''), 200),
        description: Util.truncate(description, APP.maxDescriptionChars),
        uploader: Util.truncate(uploader, 100),
        url: `${location.origin}/video/${bvid}`,
        comments,
        commentsSource,
      };
    },
  };

  const Discovery = {
    scanRenderedVideos() {
      const root = Util.findFirst(SELECTORS.discoveryRoots) || document;
      const links = Array.from(root.querySelectorAll('a[href*="/video/BV"]'));
      const seen = new Set();
      return links.map((link) => {
        const absoluteUrl = new URL(link.href, location.origin);
        const bvid = Page.getBvid(absoluteUrl.href);
        const card = link.closest('article, [class*="card"], [class*="item"], [class*="dyn"]');
        const title = Util.normalizeText(link.title || link.textContent || card?.querySelector('[title]')?.getAttribute('title'));
        const uploader = Util.normalizeText(card?.querySelector('[class*="name"], [class*="author"]')?.textContent);
        return { bvid, title: title || '页面未提供标题', uploader, url: `${absoluteUrl.origin}/video/${bvid}` };
      }).filter((video) => video.bvid && !seen.has(video.bvid) && seen.add(video.bvid));
    },
    newestUnprocessed() {
      return this.scanRenderedVideos().find((video) => !Store.isProcessed(video.bvid)) || null;
    },
  };

  const LLM = {
    endpoint(baseUrl) {
      const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\//i.test(clean)) throw new Error('API 地址必须使用 HTTPS。');
      return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
    },
    buildUserPrompt(video, style) {
      const commentLines = video.comments.length
        ? video.comments.map((item, index) => `${index + 1}. ${item.text}`).join('\n')
        : '（当前页面尚未加载到可用评论；不要据此猜测视频内容。）';
      return `请根据以下信息写一条评论。\n\nUP 主：${video.uploader}\n标题：${video.title}\n简介：${video.description || '未提供'}\n评论风格：${style}\n\n已有高赞评论（仅用于避免重复观点和措辞，不得模仿）：\n${Util.truncate(commentLines, APP.maxCommentContextChars)}`;
    },
    request(config, video, attempt = 0) {
      const endpoint = this.endpoint(config.baseUrl);
      const payload = {
        model: config.model.trim(),
        temperature: config.temperature,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: this.buildUserPrompt(video, config.style) },
        ],
      };
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: endpoint,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey.trim()}` },
          data: JSON.stringify(payload),
          timeout: APP.requestTimeoutMs,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              const detail = response.responseText ? Util.truncate(response.responseText, 300) : '无响应正文';
              reject(new Error(`LLM API 返回 HTTP ${response.status}：${detail}`));
              return;
            }
            try {
              const data = JSON.parse(response.responseText);
              const content = data?.choices?.[0]?.message?.content;
              resolve(this.validate(content));
            } catch (error) {
              reject(new Error(`LLM 响应解析失败：${error.message}`));
            }
          },
          ontimeout: () => reject(new Error('LLM 请求超时。')),
          onerror: () => reject(new Error('LLM 网络请求失败。')),
        });
      }).catch(async (error) => {
        if (attempt >= APP.requestRetries || /HTTP 4\d\d/.test(error.message)) throw error;
        await Util.sleep(1000 * (attempt + 1));
        return this.request(config, video, attempt + 1);
      });
    },
    validate(content) {
      let text = Util.normalizeText(content).replace(/^(?:```\w*|[“"']+)|(?:```|[”"']+)$/g, '').trim();
      if (!text) throw new Error('LLM 未返回评论正文。');
      if (/作为(?:一个)?AI|语言模型/i.test(text)) throw new Error('LLM 返回了禁止的 AI 自述，请重新生成。');
      if (text.length < 20 || text.length > 100) throw new Error(`LLM 评论长度为 ${text.length}，要求 20～100 字。`);
      if (/\n/.test(text)) text = text.replace(/\s+/g, ' ');
      return text;
    },
  };

  const Publisher = {
    sessionPublishCount: 0,
    captureScroll() {
      return { x: window.scrollX, y: window.scrollY };
    },
    restoreScroll(scroll) {
      if (!scroll) return;
      window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
    },
    isOwnPanelElement(element) {
      const panel = document.getElementById(APP.panelId);
      let current = element;
      while (current) {
        if (current === panel) return true;
        const root = current.getRootNode?.();
        current = root?.host || current.parentElement;
      }
      return false;
    },
    findCommentAnchor() {
      return Util.findAllDeep(SELECTORS.commentContainers)
        .find((element) => !this.isOwnPanelElement(element))
        || Array.from(document.querySelectorAll('#commentapp, bili-comments, [class*="reply"], [class*="comment"]'))
          .find((element) => !this.isOwnPanelElement(element) && element.getBoundingClientRect().top > 0);
    },
    hasCommentEntry() {
      return Boolean(Util.findFirstVisibleDeep(SELECTORS.commentEditors)
        || Util.findFirstVisibleDeep(SELECTORS.commentActivators));
    },
    async waitForCommentEntry(timeoutMs = 1200) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (this.hasCommentEntry()) return true;
        await Util.sleep(250);
      }
      return this.hasCommentEntry();
    },
    async ensureCommentAreaLoaded() {
      if (this.hasCommentEntry()) return false;
      const prevScroll = this.captureScroll();

      try {
        const anchor = this.findCommentAnchor();
        if (anchor) {
          anchor.scrollIntoView({ block: 'center', behavior: 'instant' });
          if (await this.waitForCommentEntry(7000)) return true;
        }

        const scroller = document.scrollingElement || document.documentElement;
        const startY = window.scrollY;
        const maxY = Math.max(0, scroller.scrollHeight - window.innerHeight);
        for (let step = 1; step <= 7; step += 1) {
          const y = Math.min(maxY, startY + window.innerHeight * 0.75 * step);
          window.scrollTo({ left: window.scrollX, top: y, behavior: 'instant' });
          if (await this.waitForCommentEntry(1200)) return true;
          if (y >= maxY) break;
        }
        return false;
      } finally {
        this.restoreScroll(prevScroll);
      }
    },
    validate(video, text, config, isAutomatic) {
      if (Page.hasRiskPrompt()) throw new Error('检测到验证码或风险提示，已停止发布流程。');
      const loginState = Page.loginState();
      if (loginState !== 'logged-in') {
        throw new Error(loginState === 'logged-out' ? '当前未登录 B 站。' : '无法确认登录状态，请确认登录并刷新后重试。');
      }
      if (!video?.bvid || video.bvid !== Page.getBvid()) throw new Error('视频信息与当前页面不一致，请重新检查。');
      if (Store.isProcessed(video.bvid)) throw new Error(`视频 ${video.bvid} 已处理，拒绝重复发布。`);
      const comment = Util.normalizeText(text);
      if (comment.length < 2 || comment.length > 1000) throw new Error('评论为空或长度超出 B 站常规限制。');
      if (isAutomatic) {
        if (!config.autoPublish || config.testMode) throw new Error('自动发布要求开启自动发布并关闭测试模式。');
        if (this.sessionPublishCount >= 1) throw new Error('本次脚本运行已经发布过 1 条，已停止。');
        const stats = Store.getPublishStats();
        if (stats.count >= config.dailyAutoPublishLimit) {
          throw new Error(`今天已达到自动发布上限 ${config.dailyAutoPublishLimit} 条。`);
        }
        const remaining = APP.minPublishIntervalMs - (Date.now() - stats.lastPublishedAt);
        if (remaining > 0) throw new Error(`距离上次发布不足 10 分钟，还需等待 ${Math.ceil(remaining / 60000)} 分钟。`);
      }
      return comment;
    },
    async findEditor() {
      const closed = Util.findFirstDeep(SELECTORS.closedCommentText);
      if (closed && /关闭|禁止|不可评论/.test(Util.readElement(closed))) throw new Error('该视频评论区可能已关闭。');

      let editor = Util.findFirstVisibleDeep(SELECTORS.commentEditors);
      if (!editor) await this.ensureCommentAreaLoaded();
      editor = Util.findFirstVisibleDeep(SELECTORS.commentEditors);
      if (!editor) {
        const activator = await Util.waitForAnyVisibleDeep(SELECTORS.commentActivators, 10000);
        // Preserve scroll position so the activator click does not jump the page.
        const prevScroll = { x: window.scrollX, y: window.scrollY };
        activator.click();
        window.scrollTo({ left: prevScroll.x, top: prevScroll.y, behavior: 'instant' });
        editor = await Util.waitForAnyVisibleDeep(SELECTORS.commentEditors, 5000);
        window.scrollTo({ left: prevScroll.x, top: prevScroll.y, behavior: 'instant' });
      }
      return editor;
    },
    fillEditor(editor, text) {
      editor.focus({ preventScroll: true });
      if ('value' in editor) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter ? setter.call(editor, text) : (editor.value = text);
      } else {
        editor.textContent = text;
      }
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: text,
      }));
      editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    },
    findVisibleSendButton(editor) {
      const roots = Util.ancestorRoots(editor);
      for (const root of roots) {
        const selectorMatches = SELECTORS.sendButtons.flatMap((selector) =>
          Array.from(root.querySelectorAll(selector)));
        const textMatches = Array.from(root.querySelectorAll('button')).filter((button) =>
          /^发布(?:评论)?$/.test(Util.normalizeText(button.textContent)));
        const button = [...new Set([...selectorMatches, ...textMatches])].find((candidate) =>
          Util.isVisible(candidate));
        if (button) return button;
      }

      return Util.findAllDeep(['button']).find((button) =>
        Util.isVisible(button) && /^发布(?:评论)?$/.test(Util.normalizeText(button.textContent)))
        || Util.findFirstVisibleDeep(SELECTORS.sendButtons);
    },
    async waitForSendButton(editor, timeoutMs = 4000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const button = this.findVisibleSendButton(editor);
        if (button) return button;
        await Util.sleep(200);
      }
      return null;
    },
    async fillOnly(video, text, config) {
      const comment = this.validate(video, text, config, false);
      const prevScroll = this.captureScroll();
      try {
        const editor = await this.findEditor();
        this.fillEditor(editor, comment);
        this.restoreScroll(prevScroll);
        return editor;
      } finally {
        this.restoreScroll(prevScroll);
      }
    },
    async publish(video, text, config, isAutomatic = false) {
      const comment = this.validate(video, text, config, isAutomatic);
      const prevScroll = this.captureScroll();
      try {
        const editor = await this.findEditor();
        this.fillEditor(editor, comment);
        this.restoreScroll(prevScroll);
        if (config.testMode) return { mode: 'test', message: '测试模式：已填入评论框，未点击发送。' };
        if (Page.hasRiskPrompt()) throw new Error('发送前检测到验证码或风险提示，已停止。');
        const sendButton = await this.waitForSendButton(editor);
        if (!sendButton) throw new Error('未找到评论发送按钮，页面结构可能已变化。评论已保留在输入框中。');
        if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') throw new Error('发送按钮不可用，评论区可能受限。');
        sendButton.click();
        this.restoreScroll(prevScroll);
        this.sessionPublishCount += 1;
        await Util.sleep(1800);
        if (Page.hasRiskPrompt()) throw new Error('发送后出现验证码或风险提示，已停止；请人工确认评论状态。');
        const currentValue = 'value' in editor ? editor.value : editor.textContent;
        if (Util.normalizeText(currentValue) === comment) {
          throw new Error('点击发送后输入框未清空，无法确认发布成功；未写入已处理记录，请人工检查。');
        }
        Store.recordPublish();
        Store.markProcessed(video, isAutomatic ? 'automatic' : 'manual');
        return { mode: 'published', message: '页面已接受发送操作，并已记录为已处理。' };
      } finally {
        this.restoreScroll(prevScroll);
      }
    },
  };

  const UI = {
    elements: {},
    currentVideo: null,
    busy: false,
    config: Store.getConfig(),
    logs: [],
    settingsCleanup: null,
    mount() {
      document.getElementById(APP.panelId)?.remove();
      const panel = document.createElement('aside');
      panel.id = APP.panelId;
      panel.innerHTML = `
        <div class="bllmc-header">
          <button data-action="collapse" type="button" aria-expanded="true">
            <span><strong>B 站嘴替小助手</strong><small>智能生成 · 审慎发布</small></span><span class="bllmc-collapse">−</span>
          </button>
          <button data-action="settings" class="bllmc-settings-button" type="button" title="打开设置">设置</button>
        </div>
        <div class="bllmc-body">
          <div class="bllmc-topline">
            <button data-action="check" class="bllmc-secondary">检查最新视频</button>
            <span data-role="status">就绪</span>
          </div>
          <div class="bllmc-modebar">
            <div class="bllmc-switches">
              <label><input data-field="testMode" type="checkbox"> 测试模式</label>
              <label><input data-field="autoPublish" type="checkbox"> 生成后自动发布</label>
            </div>
            <div data-role="modeHint" class="bllmc-mode-hint"></div>
            <div data-role="quota" class="bllmc-quota"></div>
          </div>
          <section class="bllmc-section"><h3>视频</h3><div data-role="video" class="bllmc-muted">尚未检查</div></section>
          <section class="bllmc-section"><h3>生成评论</h3><textarea data-field="comment" rows="4" placeholder="生成后可在此编辑"></textarea>
            <div class="bllmc-actions"><button data-action="generate" class="bllmc-secondary">生成评论</button><button data-action="publish" data-role="publishButton" class="bllmc-primary">填入评论框</button></div>
          </section>
          <details data-role="logDetails" class="bllmc-details">
            <summary>运行日志</summary>
            <div class="bllmc-log-toolbar">
              <button data-action="copyLogs" type="button">复制日志</button>
              <button data-action="clearLogs" type="button">清空日志</button>
            </div>
            <div data-role="logs" class="bllmc-logs"></div>
          </details>
        </div>`;
      document.body.appendChild(panel);
      this.cache(panel);
      this.loadConfigIntoForm();
      this.updateModeUI();
      this.bind();
      this.log(`脚本 v${APP.version} 已加载。`);
      this.setStatus(Page.isVideoPage() ? '当前视频模式' : Page.isDiscoveryPage() ? '动态页发现模式' : '等待支持的页面');
    },
    cache(panel) {
      this.elements.panel = panel;
      panel.querySelectorAll('[data-role]').forEach((el) => { this.elements[el.dataset.role] = el; });
      panel.querySelectorAll('[data-field]').forEach((el) => { this.elements[el.dataset.field] = el; });
    },
    loadConfigIntoForm() {
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        const input = this.elements[key];
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = Boolean(this.config[key]);
        else input.value = this.config[key];
      }
    },
    readAndSaveConfig() {
      this.config = Store.setConfig({
        ...this.config,
        autoPublish: this.elements.autoPublish.checked,
        testMode: this.elements.testMode.checked,
      });
      this.updateQuotaUI();
      return this.config;
    },
    bind() {
      const panel = this.elements.panel;
      panel.querySelector('[data-action="collapse"]').addEventListener('click', (event) => {
        const body = panel.querySelector('.bllmc-body');
        const isExpanded = body.classList.toggle('bllmc-body-collapsed');
        event.currentTarget.setAttribute('aria-expanded', String(!isExpanded));
        panel.querySelector('.bllmc-collapse').textContent = isExpanded ? '+' : '−';
      });
      panel.querySelector('[data-action="settings"]').addEventListener('click', () => this.openSettings());
      panel.querySelector('[data-action="check"]').addEventListener('click', () => this.run(() => this.check()));
      panel.querySelector('[data-action="generate"]').addEventListener('click', () => this.run(() => this.generate()));
      panel.querySelector('[data-action="publish"]').addEventListener('click', () => this.run(() => this.publish(false)));
      panel.querySelector('[data-action="copyLogs"]').addEventListener('click', () => this.copyLogs());
      panel.querySelector('[data-action="clearLogs"]').addEventListener('click', () => {
        this.logs = [];
        this.elements.logs.textContent = '';
      });
      panel.querySelectorAll('[data-field]:not([data-field="comment"])').forEach((input) => {
        input.addEventListener('change', () => {
          const previous = this.config;
          const next = this.readAndSaveConfig();
          if (input.dataset.field === 'autoPublish' && next.autoPublish && !previous.autoPublish) {
            this.log('自动发布已开启；仅在关闭测试模式后生效。', 'warn');
          }
          this.updateModeUI();
        });
      });
    },
    openSettings() {
      this.settingsCleanup?.();
      const overlay = document.createElement('div');
      const styleOptions = Object.entries(COMMENT_STYLE_PRESETS)
        .map(([value, preset]) => `<option value="${value}">${Util.escapeHtml(preset.label)}</option>`)
        .join('');
      overlay.className = 'bllmc-settings-overlay';
      overlay.innerHTML = `
        <div class="bllmc-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="bllmc-settings-title">
          <div class="bllmc-settings-header">
            <div><strong id="bllmc-settings-title">B 站嘴替小助手设置</strong><small>模型、风格与自动发布安全阈值</small></div>
            <button data-settings-action="close" type="button" aria-label="关闭设置">×</button>
          </div>
          <div class="bllmc-settings-content">
            <div class="bllmc-settings-group">
              <h3>模型服务</h3>
              <label>API 地址<input data-setting="baseUrl" type="url"></label>
              <label>模型名称<input data-setting="model" type="text"></label>
            </div>
            <div class="bllmc-settings-row">
              <label>API Key<input data-setting="apiKey" type="password" autocomplete="off"></label>
              <label>Temperature<input data-setting="temperature" type="number" min="0" max="2" step="0.1"></label>
            </div>
            <div class="bllmc-settings-group">
              <h3>生成偏好</h3>
              <div class="bllmc-settings-row">
                <label>评论风格预设<select data-setting="stylePreset">${styleOptions}</select></label>
                <label>每日自动评论上限<input data-setting="dailyAutoPublishLimit" type="number" min="1" max="100" step="1"></label>
              </div>
              <label>风格提示词<textarea data-setting="style" rows="4"></textarea></label>
            </div>
            <div class="bllmc-warning">API Key 保存在 Tampermonkey 脚本配置中，建议使用限额且可撤销的专用 Key。</div>
            <div data-settings-role="error" class="bllmc-settings-error"></div>
          </div>
          <div class="bllmc-settings-footer">
            <button data-settings-action="cancel" type="button">取消</button>
            <button data-settings-action="save" class="bllmc-primary" type="button">保存设置</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      for (const key of ['baseUrl', 'model', 'apiKey', 'temperature', 'stylePreset', 'dailyAutoPublishLimit', 'style']) {
        overlay.querySelector(`[data-setting="${key}"]`).value = this.config[key];
      }
      overlay.querySelector('[data-setting="stylePreset"]').addEventListener('change', (event) => {
        const preset = COMMENT_STYLE_PRESETS[event.target.value];
        if (preset?.prompt) overlay.querySelector('[data-setting="style"]').value = preset.prompt;
      });
      overlay.querySelector('[data-setting="style"]').addEventListener('input', () => {
        const presetSelect = overlay.querySelector('[data-setting="stylePreset"]');
        const preset = COMMENT_STYLE_PRESETS[presetSelect.value];
        if (preset?.prompt && overlay.querySelector('[data-setting="style"]').value.trim() !== preset.prompt) {
          presetSelect.value = 'custom';
        }
      });
      const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKeydown);
        if (this.settingsCleanup === close) this.settingsCleanup = null;
      };
      const onKeydown = (event) => { if (event.key === 'Escape') close(); };
      overlay.querySelector('[data-settings-action="close"]').addEventListener('click', close);
      overlay.querySelector('[data-settings-action="cancel"]').addEventListener('click', close);
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
      overlay.querySelector('[data-settings-action="save"]').addEventListener('click', () => {
        const next = {
          ...this.config,
          baseUrl: overlay.querySelector('[data-setting="baseUrl"]').value.trim(),
          model: overlay.querySelector('[data-setting="model"]').value.trim(),
          apiKey: overlay.querySelector('[data-setting="apiKey"]').value.trim(),
          temperature: Number(overlay.querySelector('[data-setting="temperature"]').value),
          stylePreset: overlay.querySelector('[data-setting="stylePreset"]').value,
          dailyAutoPublishLimit: Number(overlay.querySelector('[data-setting="dailyAutoPublishLimit"]').value),
          style: overlay.querySelector('[data-setting="style"]').value.trim(),
        };
        const errorElement = overlay.querySelector('[data-settings-role="error"]');
        try {
          LLM.endpoint(next.baseUrl);
          if (!next.model) throw new Error('模型名称不能为空。');
          if (!next.style) throw new Error('评论风格不能为空。');
          if (!Number.isFinite(next.dailyAutoPublishLimit) || next.dailyAutoPublishLimit < 1) {
            throw new Error('每日自动评论上限必须至少为 1。');
          }
          this.config = Store.setConfig(next);
          this.updateQuotaUI();
          this.log('API 与生成设置已保存。', 'success');
          close();
        } catch (error) {
          errorElement.textContent = error.message;
        }
      });
      this.settingsCleanup = close;
      document.addEventListener('keydown', onKeydown);
      overlay.querySelector('[data-setting="baseUrl"]').focus();
    },
    updateModeUI() {
      const testMode = this.elements.testMode.checked;
      const autoPublish = this.elements.autoPublish.checked;
      this.elements.publishButton.textContent = testMode ? '填入评论框' : '立即发布';
      if (testMode) {
        this.elements.modeHint.textContent = autoPublish
          ? '测试模式开启：只填入评论框，自动发布暂不生效。'
          : '测试模式开启：只填入评论框，不会发送。';
      } else {
        this.elements.modeHint.textContent = autoPublish
          ? '实发模式：生成完成后将直接发布，不再确认。'
          : '实发模式：点击“立即发布”后直接发送，不再确认。';
      }
      this.elements.modeHint.classList.toggle('bllmc-live-mode', !testMode);
      this.updateQuotaUI();
    },
    updateQuotaUI() {
      if (!this.elements.quota) return;
      const stats = Store.getPublishStats();
      this.elements.quota.textContent = `今日自动发布：${stats.count}/${this.config.dailyAutoPublishLimit} · 间隔 ≥ 10 分钟`;
    },
    async run(operation) {
      if (this.busy) return;
      this.busy = true;
      this.elements.panel.classList.add('bllmc-busy');
      const busyButtons = Array.from(this.elements.panel.querySelectorAll('.bllmc-body button'));
      busyButtons.forEach((button) => { button.disabled = true; });
      try {
        await operation();
      } catch (error) {
        console.error(APP.prefix, error);
        this.setStatus('操作失败', true);
        this.log(error.message || String(error), 'error');
      } finally {
        this.busy = false;
        this.elements.panel.classList.remove('bllmc-busy');
        busyButtons.forEach((button) => { button.disabled = false; });
      }
    },
    async check() {
      this.readAndSaveConfig();
      if (Page.isVideoPage()) {
        this.setStatus('正在提取视频信息…');
        const video = await Extractor.currentVideo();
        this.currentVideo = video;
        this.renderVideo(video);
        const suffix = Store.isProcessed(video.bvid) ? '（已处理）' : '';
        this.setStatus(`已识别 ${video.bvid}${suffix}`);
        const sourceText = video.commentsSource === 'API' ? 'API 热门评论'
          : video.commentsSource === 'DOM' ? '页面 DOM 评论' : '无评论上下文';
        this.log(`提取完成：${video.comments.length} 条可用评论（${sourceText}）。`);
        if (Store.isProcessed(video.bvid)) this.log('该 BV 号已有处理记录，不会重复发布。', 'warn');
        return;
      }
      if (Page.isDiscoveryPage()) {
        this.setStatus('正在扫描当前页面…');
        const video = Discovery.newestUnprocessed();
        if (!video) throw new Error('当前已渲染区域未发现未处理的视频链接；可向下滚动加载更多后重试。');
        this.currentVideo = null;
        this.renderDiscovery(video);
        this.setStatus(`发现 ${video.bvid}`);
        this.log('发现功能仅扫描当前页面已渲染内容；打开视频后才能提取简介和评论。');
        return;
      }
      throw new Error('此页面不支持视频识别或动态发现。');
    },
    async generate() {
      const config = this.readAndSaveConfig();
      if (!this.currentVideo || this.currentVideo.bvid !== Page.getBvid()) await this.check();
      if (!this.currentVideo) throw new Error('请先打开发现的视频，再生成评论。');
      if (Store.isProcessed(this.currentVideo.bvid)) throw new Error('该视频已处理，拒绝再次生成发布流程。');
      if (!config.apiKey) {
        this.openSettings();
        throw new Error('请先在设置页面填写 API Key。');
      }
      if (!config.model) throw new Error('请填写模型名称。');
      this.setStatus('正在调用 LLM…');
      const comment = await LLM.request(config, this.currentVideo);
      this.elements.comment.value = comment;
      this.setStatus('评论已生成，可编辑');
      this.log(`生成完成，共 ${comment.length} 字。`);
      if (config.autoPublish && !config.testMode) {
        this.log('满足自动发布开关条件，正在执行限频检查。', 'warn');
        await this.publish(true);
      }
    },
    async publish(isAutomatic) {
      const config = this.readAndSaveConfig();
      if (!this.currentVideo) throw new Error('请先在当前视频页检查视频信息。');
      const text = this.elements.comment.value;
      this.setStatus(config.testMode ? '正在填入评论框…' : '正在准备发布…');
      const result = await Publisher.publish(this.currentVideo, text, config, isAutomatic);
      this.setStatus(result.message);
      this.log(result.message, result.mode === 'published' ? 'success' : 'info');
      this.updateQuotaUI();
    },
    renderVideo(video) {
      this.elements.video.innerHTML = `<div class="bllmc-video-title">${Util.escapeHtml(video.title)}</div>
        <div class="bllmc-video-meta"><span class="bllmc-tag">${Util.escapeHtml(video.uploader)}</span><span class="bllmc-tag">${Util.escapeHtml(video.bvid)}</span></div>
        <div class="bllmc-video-desc">简介：${Util.escapeHtml(video.description || '未提供')}</div>
        <div class="bllmc-video-meta"><span class="bllmc-badge">${video.comments.length} 条可用评论</span></div>`;
    },
    renderDiscovery(video) {
      this.elements.video.innerHTML = `<strong>${Util.escapeHtml(video.title)}</strong>
        <div>${Util.escapeHtml(video.uploader || 'UP 主待进入视频页识别')} · ${Util.escapeHtml(video.bvid)}</div>
        <a class="bllmc-open" href="${Util.escapeHtml(video.url)}">打开视频并继续</a>`;
    },
    setStatus(text, isError = false) {
      this.elements.status.textContent = text;
      this.elements.status.classList.toggle('bllmc-error', isError);
    },
    log(message, level = 'info') {
      const LEVELS = { info: 1, warn: 1, error: 1, success: 1 };
      const safeLevel = LEVELS[level] ? level : 'info';
      let safeMessage = String(message).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
      if (this.config.apiKey) safeMessage = safeMessage.split(this.config.apiKey).join('[REDACTED]');
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      this.logs.unshift({ time: `${hh}:${mm}:${ss}`, message: safeMessage, level: safeLevel });
      this.logs = this.logs.slice(0, 40);
      this.elements.logs.innerHTML = this.logs.map((item) =>
        `<div class="bllmc-log-${item.level}">[${item.time}] ${Util.escapeHtml(item.message)}</div>`).join('');
      if (safeLevel === 'error') this.elements.logDetails.open = true;
    },
    logText() {
      return this.logs.map((item) => `[${item.time}] ${item.message}`).join('\n');
    },
    async copyLogs() {
      const text = this.logText();
      if (!text) {
        this.setStatus('暂无日志可复制');
        return;
      }
      try {
        if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(text, 'text');
        } else {
          await navigator.clipboard.writeText(text);
        }
        this.setStatus('日志已复制');
      } catch (error) {
        this.setStatus('复制日志失败', true);
        this.log(`复制日志失败：${error.message || error}`, 'error');
      }
    },
  };

  GM_addStyle(`
    /* Panel shell */
    #${APP.panelId}{position:fixed;right:18px;bottom:18px;width:392px;max-height:calc(100vh - 36px);z-index:2147483646;overflow:auto;background:#ffffff;color:#18191c;border:1px solid rgba(148,153,160,.36);border-radius:8px;box-shadow:0 18px 46px rgba(15,23,42,.18);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    #${APP.panelId} *,.bllmc-settings-overlay *{box-sizing:border-box}
    #${APP.panelId}::-webkit-scrollbar,#${APP.panelId} *::-webkit-scrollbar,.bllmc-settings-dialog::-webkit-scrollbar,.bllmc-settings-dialog *::-webkit-scrollbar{width:8px;height:8px}
    #${APP.panelId}::-webkit-scrollbar-thumb,#${APP.panelId} *::-webkit-scrollbar-thumb,.bllmc-settings-dialog::-webkit-scrollbar-thumb,.bllmc-settings-dialog *::-webkit-scrollbar-thumb{background:rgba(99,110,123,.38);border-radius:999px}
    #${APP.panelId}::-webkit-scrollbar-track,#${APP.panelId} *::-webkit-scrollbar-track,.bllmc-settings-dialog::-webkit-scrollbar-track,.bllmc-settings-dialog *::-webkit-scrollbar-track{background:transparent}

    /* Header */
    #${APP.panelId} .bllmc-header{position:sticky;top:0;z-index:2;width:100%;display:flex;align-items:stretch;justify-content:space-between;background:linear-gradient(135deg,#fb7299 0%,#ff8bad 54%,#22b8ef 140%);color:#fff}
    #${APP.panelId} .bllmc-header button{border:0;background:transparent;color:#fff;cursor:pointer}
    #${APP.panelId} .bllmc-header [data-action="collapse"]{flex:1;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;text-align:left}
    #${APP.panelId} .bllmc-header strong{display:block;font-size:15px;letter-spacing:0}
    #${APP.panelId} .bllmc-header small{display:block;margin-top:1px;font-size:11px;font-weight:500;opacity:.82}
    #${APP.panelId} .bllmc-collapse{font-size:18px;line-height:1}
    #${APP.panelId} .bllmc-settings-button{min-width:58px;padding:0 13px;font-size:12px;border-left:1px solid rgba(255,255,255,.28)!important;background:rgba(255,255,255,.1)!important}

    /* Body and sections */
    #${APP.panelId} .bllmc-body{max-height:calc(100vh - 96px);overflow:hidden;padding:12px;opacity:1;transition:max-height .24s ease,padding .24s ease,opacity .18s ease}
    #${APP.panelId} .bllmc-body-collapsed{max-height:0;padding-top:0;padding-bottom:0;opacity:0;pointer-events:none}
    #${APP.panelId} .bllmc-section{margin:11px 0 0;padding-top:11px;border-top:1px solid #eef0f2}
    #${APP.panelId} h3{margin:0 0 8px;font-size:12px;font-weight:700;color:#61666d}

    /* Inputs */
    #${APP.panelId} textarea,#${APP.panelId} input[type="text"],#${APP.panelId} input[type="url"],#${APP.panelId} input[type="password"],#${APP.panelId} input[type="number"]{width:100%;padding:9px 10px;border:1px solid #d6d9df;border-radius:6px;background:#fff;color:#18191c;font:inherit;outline:none;transition:border-color .12s ease,box-shadow .12s ease,background .12s ease}
    #${APP.panelId} textarea:focus,#${APP.panelId} input[type]:focus,.bllmc-settings-content input:focus,.bllmc-settings-content textarea:focus,.bllmc-settings-content select:focus{border-color:#00aeec;box-shadow:0 0 0 3px rgba(0,174,236,.14)}
    #${APP.panelId} textarea{min-height:94px;resize:vertical}

    /* Buttons and links */
    #${APP.panelId} .bllmc-body button,.bllmc-settings-dialog button{position:relative;padding:7px 12px;border:1px solid #d6d9df;border-radius:6px;background:#fff;color:#18191c;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease,filter .12s ease,opacity .12s ease,border-color .12s ease}
    #${APP.panelId} .bllmc-body button:hover:not(:disabled),.bllmc-settings-dialog button:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.02)}
    #${APP.panelId} .bllmc-body button:active:not(:disabled),.bllmc-settings-dialog button:active:not(:disabled){transform:translateY(0) scale(.98)}
    #${APP.panelId} .bllmc-primary,#${APP.panelId} .bllmc-open,.bllmc-settings-dialog .bllmc-primary{background:#00aeec!important;color:#fff!important;border-color:#00aeec!important;box-shadow:0 7px 18px rgba(0,174,236,.24)}
    #${APP.panelId} .bllmc-secondary{background:#f7f9fb!important;border-color:#d6d9df!important}
    #${APP.panelId} .bllmc-open{display:inline-block;margin-top:7px;padding:6px 10px;border-radius:6px;text-decoration:none;transition:transform .12s ease,box-shadow .12s ease}
    #${APP.panelId} .bllmc-open:hover{transform:translateY(-1px);box-shadow:0 6px 14px rgba(0,174,236,.26)}
    #${APP.panelId}.bllmc-busy .bllmc-body button:disabled{padding-right:28px;pointer-events:none;opacity:.72}
    #${APP.panelId}.bllmc-busy .bllmc-body button:disabled::after{content:"";position:absolute;right:9px;top:50%;width:12px;height:12px;margin-top:-6px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:bllmc-spin .75s linear infinite}

    /* Controls and status */
    #${APP.panelId} .bllmc-topline{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px}
    #${APP.panelId} .bllmc-topline [data-role="status"]{min-width:0;text-align:right;color:#61666d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${APP.panelId} .bllmc-actions{display:flex;align-items:center;gap:8px;justify-content:space-between}
    #${APP.panelId}.bllmc-busy{cursor:progress}
    #${APP.panelId}.bllmc-busy [data-role="status"]::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:#00aeec;animation:bllmc-pulse 1s ease-in-out infinite;vertical-align:1px}
    #${APP.panelId} label{display:block;color:#61666d}
    #${APP.panelId} .bllmc-modebar{margin:11px 0 0;padding:10px;background:#f7f9fb;border:1px solid #eef0f2;border-radius:7px}
    #${APP.panelId} .bllmc-switches{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 6px}
    #${APP.panelId} .bllmc-switches label{display:inline-flex;align-items:center;gap:5px;color:#3f444b}
    #${APP.panelId} .bllmc-mode-hint,#${APP.panelId} .bllmc-quota{font-size:11px;color:#61666d}
    #${APP.panelId} .bllmc-quota{margin-top:3px;color:#9499a0}
    #${APP.panelId} .bllmc-live-mode{color:#c43c58;font-weight:600}
    #${APP.panelId} .bllmc-warning,.bllmc-settings-dialog .bllmc-warning{padding:9px 10px;background:#fff6d6;color:#805b10;border:1px solid rgba(221,154,0,.22);border-radius:6px}

    /* Video summary */
    #${APP.panelId} [data-role="video"]{max-height:148px;overflow:auto;word-break:break-word}
    #${APP.panelId} .bllmc-video-title{margin-bottom:7px;color:#18191c;font-size:14px;font-weight:700;line-height:1.35}
    #${APP.panelId} .bllmc-video-meta{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0}
    #${APP.panelId} .bllmc-tag{display:inline-flex;align-items:center;max-width:100%;padding:3px 8px;border:1px solid #e3e5e7;border-radius:999px;background:#f7f9fb;color:#61666d;font-size:11px}
    #${APP.panelId} .bllmc-badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:#e8f7ff;color:#0077a8;font-size:11px;font-weight:600}
    #${APP.panelId} .bllmc-video-desc{color:#61666d;font-size:12px;line-height:1.45}

    /* Logs */
    #${APP.panelId} .bllmc-details{margin-top:11px;border-top:1px solid #eef0f2}
    #${APP.panelId} .bllmc-details>summary{padding:10px 2px 8px;cursor:pointer;font-weight:700;color:#3f444b;list-style-position:inside}
    #${APP.panelId} .bllmc-log-toolbar{display:flex;justify-content:flex-end;gap:6px;margin:0 0 5px}
    #${APP.panelId} .bllmc-log-toolbar button{padding:3px 7px!important;font-size:11px}
    #${APP.panelId} .bllmc-logs{height:92px;overflow:auto;padding:8px;background:#f7f9fb;border:1px solid #eef0f2;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55}
    #${APP.panelId} .bllmc-log-error,#${APP.panelId} .bllmc-error{color:#d03050}
    #${APP.panelId} .bllmc-log-warn{color:#a15c00}
    #${APP.panelId} .bllmc-log-success{color:#18864b}

    /* Settings dialog */
    .bllmc-settings-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.52);backdrop-filter:blur(3px);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .bllmc-settings-dialog{width:min(620px,100%);max-height:calc(100vh - 40px);overflow:auto;background:#fff;color:#18191c;border:1px solid rgba(148,153,160,.34);border-radius:8px;box-shadow:0 22px 60px rgba(15,23,42,.35)}
    .bllmc-settings-header,.bllmc-settings-footer{display:flex;align-items:center;justify-content:space-between;padding:14px 18px}
    .bllmc-settings-header{border-bottom:1px solid #eef0f2}
    .bllmc-settings-header strong{display:block;font-size:16px}
    .bllmc-settings-header small{display:block;margin-top:2px;color:#9499a0;font-size:12px}
    .bllmc-settings-footer{justify-content:flex-end;gap:8px;border-top:1px solid #eef0f2;background:#fbfcfd}
    .bllmc-settings-header button{width:36px;height:36px;padding:0;border:0;background:#f1f3f5;font-size:24px;line-height:1}
    .bllmc-settings-content{display:grid;gap:14px;padding:16px 18px 18px}
    .bllmc-settings-group{display:grid;gap:10px}
    .bllmc-settings-group h3{margin:0;color:#3f444b;font-size:13px}
    .bllmc-settings-content label{display:block;color:#61666d}
    .bllmc-settings-content input,.bllmc-settings-content textarea,.bllmc-settings-content select{width:100%;margin-top:5px;padding:9px 10px;border:1px solid #d6d9df;border-radius:6px;background:#fff;color:#18191c;font:inherit;outline:none;transition:border-color .12s ease,box-shadow .12s ease,background .12s ease}
    .bllmc-settings-content textarea{resize:vertical}
    .bllmc-settings-row{display:grid;grid-template-columns:2fr 1fr;gap:12px}
    .bllmc-settings-error{min-height:20px;color:#d03050}

    /* Animations */
    @keyframes bllmc-spin{to{transform:rotate(360deg)}}
    @keyframes bllmc-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}

    /* Dark mode */
    @media (prefers-color-scheme:dark){
      #${APP.panelId},.bllmc-settings-dialog{background:#202124;color:#f1f2f3;border-color:#4b4f56}
      #${APP.panelId} .bllmc-section,#${APP.panelId} .bllmc-details,.bllmc-settings-header,.bllmc-settings-footer{border-color:#3a3d42}
      #${APP.panelId} textarea,#${APP.panelId} input[type],.bllmc-settings-content input,.bllmc-settings-content textarea,.bllmc-settings-content select{background:#2b2d31;color:#f1f2f3;border-color:#555b63}
      #${APP.panelId} .bllmc-body button,.bllmc-settings-dialog button{background:#2b2d31;color:#f1f2f3;border-color:#555b63}
      #${APP.panelId} .bllmc-secondary{background:#2b2d31!important;border-color:#555b63!important}
      #${APP.panelId} .bllmc-logs,#${APP.panelId} .bllmc-modebar,.bllmc-settings-footer,.bllmc-settings-header button{background:#181a1f;border-color:#3a3d42}
      #${APP.panelId} label,#${APP.panelId} .bllmc-topline [data-role="status"],#${APP.panelId} .bllmc-mode-hint,#${APP.panelId} .bllmc-quota,#${APP.panelId} .bllmc-video-desc,.bllmc-settings-content label,.bllmc-settings-header small{color:#b8bcc4}
      #${APP.panelId} h3,#${APP.panelId} .bllmc-details>summary,.bllmc-settings-group h3{color:#d9dde4}
      #${APP.panelId} .bllmc-video-title{color:#f1f2f3}
      #${APP.panelId} .bllmc-tag{background:#2b2d31;border-color:#555b63;color:#d9dde4}
      #${APP.panelId} .bllmc-badge{background:#12384a;color:#7bd6ff}
      #${APP.panelId} .bllmc-warning,.bllmc-settings-dialog .bllmc-warning{background:#3a3018;color:#f0ce7a}
    }

    /* Narrow screens */
    @media(max-width:520px){
      #${APP.panelId}{right:8px;bottom:8px;width:calc(100vw - 16px)}
      .bllmc-settings-overlay{padding:10px}
      .bllmc-settings-row{grid-template-columns:1fr}
      #${APP.panelId} .bllmc-topline{grid-template-columns:1fr}
      #${APP.panelId} .bllmc-topline [data-role="status"]{text-align:left;white-space:normal}
    }
  `);

  let lastUrl = location.href;
  let routeTimer = 0;
  const routeObserver = new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    window.clearTimeout(routeTimer);
    routeTimer = window.setTimeout(() => {
      UI.currentVideo = null;
      UI.elements.comment.value = '';
      UI.elements.video.textContent = '页面已切换，请重新检查';
      UI.setStatus('检测到 SPA 页面切换');
      UI.log('URL 已变化，已清除当前视频上下文。');
    }, APP.routeDebounceMs);
  });

  function cleanup() {
    routeObserver.disconnect();
    window.clearTimeout(routeTimer);
    document.getElementById(APP.panelId)?.remove();
    UI.settingsCleanup?.();
  }

  UI.mount();
  GM_registerMenuCommand('打开 B 站嘴替小助手设置', () => UI.openSettings());
  routeObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pagehide', cleanup, { once: true });
})();
