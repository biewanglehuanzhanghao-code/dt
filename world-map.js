(() => {
'use strict';
if (globalThis.__stwmV042) return;
globalThis.__stwmV042 = true;
const MODULE_NAME = 'st_world_map_mvp';
const ROOT_ID = 'st-world-map-mvp-root';
const ownScript = document.currentScript || [...document.scripts].find(el => {
    try { return new URL(el.src).pathname.endsWith('/world-map.js'); } catch { return false; }
});
const EXT_BASE_URL = ownScript?.src ? new URL('./', ownScript.src).href : null;
let localSettings = {};
let standaloneSelected = false;
function hasStory() {
    const ctx = getContext();
    // The home screen also has a welcome message; a nonempty chat alone is insufficient.
    const selected = ctx && (ctx.characterId !== undefined && ctx.characterId !== null || ctx.groupId);
    return Boolean(selected && ctx.chat?.length && ctx.chatMetadata);
}
function isStandalone() { return standaloneSelected || !hasStory(); }
function persistentSettings() {
    const ctx = getContext();
    const owner = ctx?.extensionSettings ?? localSettings;
    owner[MODULE_NAME] ??= { showLocations: true, arrivalNotifications: true };
    const settings = owner[MODULE_NAME];
    settings.characterPositions ??= {};
    settings.locationPositions ??= {};
    settings.standaloneState ??= emptyState();
    return settings;
}


let world = null;
let activeMapId = null;
let selectedCharacterId = null;
let selectedLocationId = null;
let editMode = false;
let avatarCache = new Map();
let initialized = false;
let refreshInFlight = false;
let initPromise = null;
let startupError = '';
let eventsBound = false;
let renderVersion = 0;
const emptyState = () => ({ userLocation: '未同步', lastSyncAt: null, stale: true, characters: {} });

function notify(message, error = false) {
    let host = document.getElementById('stwm-notices');
    if (!host) {
        host = document.createElement('div');
        host.id = 'stwm-notices';
        host.setAttribute('aria-live', 'polite');
        document.body.append(host);
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = error ? 'stwm-notice error' : 'stwm-notice';
    item.textContent = message;
    item.title = '点击关闭提醒';
    item.onclick = () => item.remove();
    host.append(item);
    while (host.children.length > 6) host.firstElementChild.remove();
    setTimeout(() => item.remove(), error ? 15000 : 7000);
}


function extBase() {
    return EXT_BASE_URL;
}

async function loadWorld() {
    if (!extBase()) throw new Error('无法定位 world-map.js，请截图扩展管理中的版本号');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    let data;
    try {
        res = await fetch(new URL('data/world.json', extBase()), { cache: 'no-cache', signal: controller.signal });
        if (!res.ok) throw new Error(`world.json 加载失败: ${res.status}`);
        data = await res.json();
    } finally { clearTimeout(timer); }

    if (!Array.isArray(data.maps) || !data.maps.length || data.maps.some(m => !m.id || !m.image)) {
        throw new Error('地图配置缺少有效的 maps / image');
    }
    world = data;
    world.locations ??= [];
    world.characters ??= [];
    activeMapId = world.maps?.[0]?.id ?? null;
}

function getContext() {
    try { return globalThis.SillyTavern?.getContext?.(); }
    catch { return null; }
}

function getSettings() {
    const settings = persistentSettings();
    const runtimeState = isStandalone() ? settings.standaloneState
        : (getContext().chatMetadata[MODULE_NAME] ??= emptyState());
    runtimeState.characters ??= {};
    return { ...settings, runtimeState };
}

function saveSettings() {
    const ctx = getContext();
    ctx?.saveSettingsDebounced?.();
    if (!isStandalone() && ctx?.saveMetadata) {
        Promise.resolve(ctx.saveMetadata()).catch(err => notify(`地图状态保存失败：${err.message}`, true));
    }
}

function clamp(v) {
    return Math.max(0, Math.min(100, v));
}

function getRuntimeCharacter(baseChar) {
    const settings = getSettings();
    const runtime = settings?.runtimeState?.characters?.[baseChar.id] ?? {};
    return { ...baseChar, ...runtime };
}

function formatSyncTime(value) {
    if (!value) return '尚未同步';
    try {
        return new Date(value).toLocaleString();
    } catch {
        return '已同步';
    }
}

function updateSyncStatus() {
    const settings = getSettings();
    const state = settings?.runtimeState;
    const el = document.querySelector('#stwm-sync-status');
    if (el) {
        if (startupError) {
            el.textContent = `加载失败：${startupError}。点击「刷新状态」重试加载。`;
        } else if (!initialized) {
            el.textContent = '正在加载地图…';
        } else if (isStandalone()) {
            el.textContent = `自由地图 · 第 ${state.turn || 0} 轮 · ${String(Math.floor((state.minutes ?? 540) / 60) % 24).padStart(2, '0')}:${String((state.minutes ?? 540) % 60).padStart(2, '0')} · 刷新推进半小时，不调用模型`;
        } else if (!state?.lastSyncAt) {
            el.textContent = '还没有剧情状态，点「刷新状态」让模型读取当前剧情。';
        } else if (state.stale) {
            el.textContent = `有新剧情尚未同步 · 上次：${formatSyncTime(state.lastSyncAt)}`;
        } else {
            el.textContent = `已同步 · ${formatSyncTime(state.lastSyncAt)}${state.userLocation ? ` · 你：${state.userLocation}` : ''}`;
        }
    }
    document.querySelectorAll('[data-stwm-refresh]').forEach(btn => {
        btn.disabled = refreshInFlight;
        btn.textContent = refreshInFlight ? '同步中…' : '刷新状态';
    });
}

function getCharacterPosition(char) {
    const settings = getSettings();
    const runtime = settings?.runtimeState?.characters?.[char.id];
    if (Number.isFinite(runtime?.x) && Number.isFinite(runtime?.y)) return { x: runtime.x, y: runtime.y };
    const saved = settings?.characterPositions?.[char.id];
    return saved ?? { x: char.x, y: char.y };
}

function saveCharacterPosition(charId, x, y) {
    const settings = getSettings();
    if (!settings) return;
    settings.characterPositions[charId] = { x: clamp(x), y: clamp(y) };
    const runtime = settings.runtimeState.characters[charId];
    if (runtime) { runtime.x = clamp(x); runtime.y = clamp(y); }
    saveSettings();
}

function getLocationPosition(location) {
    const settings = getSettings();
    const saved = settings?.locationPositions?.[location.id];
    return saved ?? { x: location.x, y: location.y };
}

function saveLocationPosition(locationId, x, y) {
    const settings = getSettings();
    if (!settings) return;
    settings.locationPositions[locationId] = { x: clamp(x), y: clamp(y) };
    saveSettings();
}

async function getAvatar(charId) {
    if (avatarCache.has(charId)) return avatarCache.get(charId);
    try {
        const localforage = globalThis.SillyTavern?.libs?.localforage;
        if (!localforage) return null;
        const value = await localforage.getItem(`${MODULE_NAME}:avatar:${charId}`);
        if (value) avatarCache.set(charId, value);
        return value ?? null;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] 读取头像失败`, err);
        return null;
    }
}

async function setAvatar(charId, dataUrl) {
    const localforage = globalThis.SillyTavern?.libs?.localforage;
    if (!localforage) throw new Error('当前 SillyTavern 未提供 localforage');
    await localforage.setItem(`${MODULE_NAME}:avatar:${charId}`, dataUrl);
    avatarCache.set(charId, dataUrl);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function makeRoot() {
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
        <button id="stwm-fab" type="button" title="打开世界地图" aria-label="打开世界地图">🗺️</button>
        <div id="stwm-overlay" aria-hidden="true">
            <div id="stwm-shell">
                <header id="stwm-header">
                    <div id="stwm-tabs"></div>
                    <div id="stwm-header-actions">
                        <button id="stwm-mode-toggle" class="stwm-action" type="button">自由地图</button>
                        <button class="stwm-action" data-stwm-refresh type="button">刷新状态</button>
                        <button id="stwm-location-toggle" class="stwm-action" type="button">隐藏地点</button>
                        <button id="stwm-edit-toggle" class="stwm-action" type="button">编辑位置</button>
                        <button id="stwm-close" class="stwm-action stwm-close" type="button" aria-label="关闭">✕</button>
                    </div>
                </header>
                <main id="stwm-stage-wrap">
                    <div id="stwm-sync-status"></div>
                    <div id="stwm-stage">
                        <img id="stwm-map-image" alt="地图" draggable="false" />
                        <div id="stwm-markers"></div>
                    </div>
                    <div id="stwm-edit-hint">编辑模式：人物头像和地点图标都可以拖动，松手自动保存。</div>
                </main>
                <aside id="stwm-card" aria-hidden="true"></aside>
            </div>
        </div>
    `;
    document.body.append(root);
    // The launcher remains visible even if a theme or stylesheet has not loaded.
    root.style.setProperty('z-index', '2147482000', 'important');
    const fab = root.querySelector('#stwm-fab');
    for (const [key, value] of Object.entries({ position: 'fixed', right: '16px', bottom: '110px', width: '58px', height: '58px', display: 'block', visibility: 'visible', opacity: '1', 'z-index': '2147482001', background: '#202831', color: '#fff', 'font-size': '26px', 'border-radius': '18px', border: '2px solid #c7a86b' })) fab.style.setProperty(key, value, 'important');
    fab.title = '世界地图 v0.4.2';

    root.querySelector('#stwm-mode-toggle').addEventListener('click', () => {
        if (refreshInFlight) { notify('请等本次刷新完成后再切换'); return; }
        if (!hasStory()) { notify('当前没有已打开的角色聊天，正在使用自由地图。'); return; }
        standaloneSelected = !standaloneSelected;
        closeCard(); syncHeaderControls(); updateSyncStatus(); renderMap();
    });
    root.querySelector('#stwm-fab').addEventListener('click', openMap);
    root.querySelector('#stwm-close').addEventListener('click', closeMap);
    root.querySelector('[data-stwm-refresh]').addEventListener('click', refreshStatusFromChat);
    root.querySelector('#stwm-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'stwm-overlay') closeMap();
    });
    root.querySelector('#stwm-location-toggle').addEventListener('click', () => {
        const settings = getSettings();
        if (!settings) return;
        persistentSettings().showLocations = !settings.showLocations;
        saveSettings();
        syncHeaderControls();
        renderMarkers();
    });
    root.querySelector('#stwm-edit-toggle').addEventListener('click', () => {
        editMode = !editMode;
        root.classList.toggle('stwm-editing', editMode);
        root.querySelector('#stwm-edit-toggle').textContent = editMode ? '完成编辑' : '编辑位置';
        renderMarkers();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root.querySelector('#stwm-overlay').classList.contains('open')) closeMap();
    });
    syncHeaderControls();
    updateSyncStatus();
}

function syncHeaderControls() {
    const settings = getSettings();
    const mode = document.querySelector('#stwm-mode-toggle');
    if (mode) mode.textContent = isStandalone() ? '自由地图' : '剧情地图';
    const btn = document.querySelector('#stwm-location-toggle');
    if (btn && settings) btn.textContent = settings.showLocations ? '隐藏地点' : '显示地点';
}

function openMap() {
    const overlay = document.querySelector('#stwm-overlay');
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
    syncHeaderControls();
    updateSyncStatus();
    renderMap();
    if (!initialized) void init();
}

function closeMap() {
    const overlay = document.querySelector('#stwm-overlay');
    overlay?.classList.remove('open');
    overlay?.setAttribute('aria-hidden', 'true');
    closeCard();
}

function renderTabs() {
    const tabs = document.querySelector('#stwm-tabs');
    tabs.innerHTML = '';
    for (const map of world.maps) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `stwm-tab ${map.id === activeMapId ? 'active' : ''}`;
        btn.textContent = map.name;
        btn.addEventListener('click', () => {
            activeMapId = map.id;
            const settings = getSettings();
            if (settings) {
                persistentSettings().lastMapId = map.id;
                saveSettings();
            }
            closeCard();
            renderMap();
        });
        tabs.append(btn);
    }
}

function renderMap() {
    if (!world) return;
    const settings = getSettings();
    if (settings?.lastMapId && world.maps.some(m => m.id === settings.lastMapId)) {
        activeMapId = settings.lastMapId;
    }
    renderTabs();
    const map = world.maps.find(m => m.id === activeMapId) ?? world.maps[0];
    const img = document.querySelector('#stwm-map-image');
    img.src = new URL(map.image, extBase()).href;
    img.alt = map.name;
    renderMarkers();
}

async function renderMarkers() {
    const layer = document.querySelector('#stwm-markers');
    if (!layer || !world) return;
    const version = ++renderVersion;
    layer.innerHTML = '';

    const settings = getSettings();
    if (settings?.showLocations) {
        const locations = world.locations.filter(l => l.mapId === activeMapId);
        for (const location of locations) {
            const pos = getLocationPosition(location);
            const marker = document.createElement('button');
            marker.type = 'button';
            marker.className = `stwm-location-marker ${editMode ? 'draggable' : ''}`;
            marker.dataset.locationId = location.id;
            marker.style.left = `${pos.x}%`;
            marker.style.top = `${pos.y}%`;
            marker.title = location.name;
            marker.setAttribute('aria-label', location.name);
            marker.innerHTML = `<span>${escapeHtml(location.icon ?? '📍')}</span>`;
            marker.addEventListener('click', (e) => {
                if (editMode) return;
                e.stopPropagation();
                openLocationCard(location.id);
            });
            marker.addEventListener('pointerdown', (e) => startDragLocation(e, marker, location));
            layer.append(marker);
        }
    }

    const chars = world.characters.map(getRuntimeCharacter).filter(c => c.mapId === activeMapId);
    for (const char of chars) {
        const pos = getCharacterPosition(char);
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = `stwm-marker ${editMode ? 'draggable' : ''}`;
        marker.dataset.characterId = char.id;
        marker.style.left = `${pos.x}%`;
        marker.style.top = `${pos.y}%`;
        marker.title = char.name;
        marker.setAttribute('aria-label', `${char.name}，${char.location}`);

        const avatar = await getAvatar(char.id);
        if (version !== renderVersion) return;
        if (avatar) {
            marker.innerHTML = `<img alt="" src="${avatar}"><span class="stwm-pin-tip"></span>`;
        } else {
            marker.innerHTML = `<span class="stwm-avatar-fallback">${escapeHtml(char.name.slice(0, 1))}</span><span class="stwm-pin-tip"></span>`;
        }

        marker.addEventListener('click', (e) => {
            if (editMode) return;
            e.stopPropagation();
            openCharacterCard(char.id);
        });
        marker.addEventListener('pointerdown', (e) => startDragCharacter(e, marker, char));
        layer.append(marker);
    }
}

function dragWithinStage(event, marker, onSave, toastText) {
    if (!editMode) return;
    event.preventDefault();
    marker.setPointerCapture?.(event.pointerId);
    const stage = document.querySelector('#stwm-stage');

    const move = (e) => {
        const rect = stage.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        marker.style.left = `${clamp(x)}%`;
        marker.style.top = `${clamp(y)}%`;
    };

    const up = (e) => {
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        marker.removeEventListener('pointercancel', up);
        const rect = stage.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        onSave(clamp(x), clamp(y));
        globalThis.toastr?.success?.(toastText);
    };

    marker.addEventListener('pointermove', move);
    marker.addEventListener('pointerup', up);
    marker.addEventListener('pointercancel', up);
}

function startDragCharacter(event, marker, char) {
    dragWithinStage(event, marker, (x, y) => saveCharacterPosition(char.id, x, y), `${char.name} 的地图位置已保存`);
}

function startDragLocation(event, marker, location) {
    dragWithinStage(event, marker, (x, y) => saveLocationPosition(location.id, x, y), `${location.name} 的地点位置已保存`);
}

async function openCharacterCard(charId) {
    const baseChar = world.characters.find(c => c.id === charId);
    if (!baseChar) return;
    const char = getRuntimeCharacter(baseChar);
    selectedCharacterId = charId;
    selectedLocationId = null;
    const card = document.querySelector('#stwm-card');
    const avatar = await getAvatar(char.id);
    const avatarMarkup = avatar
        ? `<img class="stwm-card-avatar" src="${avatar}" alt="${escapeHtml(char.name)}">`
        : `<div class="stwm-card-avatar stwm-card-avatar-fallback">${escapeHtml(char.name.slice(0, 1))}</div>`;

    card.innerHTML = `
        <button class="stwm-card-x" type="button" aria-label="关闭角色信息">✕</button>
        <div class="stwm-card-head">
            ${avatarMarkup}
            <div>
                <div class="stwm-card-name">${escapeHtml(char.name)}</div>
                <div class="stwm-card-role">${escapeHtml(char.role)}</div>
            </div>
        </div>
        <div class="stwm-info-list">
            <div><span>📍</span><b>当前位置</b><em>${escapeHtml(char.location)}</em></div>
            <div><span>📏</span><b>距你</b><em>${escapeHtml(char.distance)}</em></div>
            <div><span>👥</span><b>随行</b><em>${escapeHtml(char.companions)}</em></div>
            <div><span>🎯</span><b>当前</b><em>${escapeHtml(char.activity)}</em></div>
            <div><span>➜</span><b>动向</b><em>${escapeHtml(char.destination)}</em></div>
            <div><span>🏷️</span><b>状态</b><em>${escapeHtml(char.status)}</em></div>
            <div><span>🎲</span><b>最近遭遇</b><em>${escapeHtml(char.encounter)}</em></div>
        </div>
        <label class="stwm-avatar-button">
            更换地图头像
            <input id="stwm-avatar-input" type="file" accept="image/png,image/jpeg,image/webp" hidden>
        </label>
        <div class="stwm-card-note">只更换地图上的定位头像，不修改你的角色卡头像。</div>
    `;
    card.classList.add('open');
    card.setAttribute('aria-hidden', 'false');
    card.querySelector('.stwm-card-x').addEventListener('click', closeCard);
    card.querySelector('#stwm-avatar-input').addEventListener('change', handleAvatarUpload);
}

function openLocationCard(locationId) {
    const location = world.locations.find(l => l.id === locationId);
    if (!location) return;
    selectedCharacterId = null;
    selectedLocationId = locationId;
    const card = document.querySelector('#stwm-card');
    const charsHere = world.characters.map(getRuntimeCharacter).filter(c => c.mapId === location.mapId && c.locationId === location.id);
    const people = charsHere.length ? charsHere.map(c => c.name).join('、') : '暂无';

    card.innerHTML = `
        <button class="stwm-card-x" type="button" aria-label="关闭地点信息">✕</button>
        <div class="stwm-place-head">
            <div class="stwm-place-icon">${escapeHtml(location.icon ?? '📍')}</div>
            <div>
                <div class="stwm-card-name">${escapeHtml(location.name)}</div>
                <div class="stwm-card-role">${escapeHtml(location.type ?? '地点')}</div>
            </div>
        </div>
        <div class="stwm-info-list">
            <div><span>👥</span><b>当前人数</b><em>${charsHere.length}</em></div>
            <div><span>👤</span><b>当前人物</b><em>${escapeHtml(people)}</em></div>
            <div><span>🌿</span><b>环境</b><em>${escapeHtml(location.environment ?? '未设置')}</em></div>
            <div><span>🛡️</span><b>治安</b><em>${escapeHtml(location.security ?? '未设置')}</em></div>
        </div>
        <div class="stwm-card-note">地点按钮的“赶人 / 收保护费 / 邀请角色”等剧情操作会在后续版本接入。</div>
    `;
    card.classList.add('open');
    card.setAttribute('aria-hidden', 'false');
    card.querySelector('.stwm-card-x').addEventListener('click', closeCard);
}

function closeCard() {
    selectedCharacterId = null;
    selectedLocationId = null;
    const card = document.querySelector('#stwm-card');
    card?.classList.remove('open');
    card?.setAttribute('aria-hidden', 'true');
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function handleAvatarUpload(event) {
    const file = event.target.files?.[0];
    if (!file || !selectedCharacterId) return;
    if (file.size > 5 * 1024 * 1024) {
        globalThis.toastr?.error?.('头像请控制在 5MB 以内');
        return;
    }
    try {
        const dataUrl = await readFileAsDataUrl(file);
        await setAvatar(selectedCharacterId, dataUrl);
        globalThis.toastr?.success?.('地图头像已更换');
        await renderMarkers();
        await openCharacterCard(selectedCharacterId);
    } catch (err) {
        console.error(`[${MODULE_NAME}] 保存头像失败`, err);
        globalThis.toastr?.error?.('头像保存失败');
    }
}

function parseModelJson(text) {
    const cleaned = String(text ?? '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
}

function buildRefreshPrompt() {
    const maps = world.maps.map(m => ({ id: m.id, name: m.name }));
    const locations = world.locations.map(l => ({ id: l.id, name: l.name, mapId: l.mapId, type: l.type }));
    const characters = world.characters.map(c => ({ id: c.id, name: c.name, role: c.role, currentLocationId: getRuntimeCharacter(c).locationId }));
    return `你是一个只负责更新地图状态的后台分析器。请根据当前 SillyTavern 聊天剧情判断 user 和已登记角色的位置与状态。

规则：
1. 当前正在与 user 同场互动的角色必须剧情锁定，绝不能为了随机移动而离开。
2. 正文明确的位置优先级最高。
3. 对没有被剧情占用的角色，最多选择 3-6 个做符合身份、性格、时间与地点的变化；登记角色不足时可少于 3 个。
4. 不要创造列表之外的地图 ID 或地点 ID。无法判断时保留原地点。
5. 随机遭遇可以荒诞，但不能破坏正在进行的主剧情。
6. 只输出一个 JSON 对象，不要解释，不要 Markdown。

地图：${JSON.stringify(maps)}
地点：${JSON.stringify(locations)}
角色：${JSON.stringify(characters)}

严格输出：
{
  "user": {"mapId": "已知地图ID或空字符串", "locationId": "已知地点ID或空字符串", "location": "可读位置或未确定"},
  "characters": [
    {"id": "角色ID", "mapId": "地图ID", "locationId": "地点ID", "location": "可读位置", "companions": "随行人", "activity": "当前行为", "destination": "动向", "status": "短状态标签", "distance": "若剧情和地图不足以可靠计算则写未计算", "encounter": "最近遭遇或暂无"}
  ]
}`;
}

function applyRuntimePayload(payload) {
    const settings = getSettings();
    if (!settings) return;
    const validMaps = new Set(world.maps.map(m => m.id));
    const validLocations = new Map(world.locations.map(l => [l.id, l]));
    const validChars = new Map(world.characters.map(c => [c.id, c]));
    if (!payload || !Array.isArray(payload.characters) ||
        !payload.characters.some(item => validChars.has(item?.id))) {
        throw new Error('模型没有返回已登记角色的有效状态，请重试');
    }
    const runtime = settings.runtimeState;
    const arrivals = [];
    const seen = new Set();

    if (payload?.user && typeof payload.user === 'object') {
        runtime.userLocation = String(payload.user.location || '未确定').slice(0, 120);
        runtime.userMapId = validMaps.has(payload.user.mapId) ? payload.user.mapId : '';
        runtime.userLocationId = validLocations.has(payload.user.locationId) ? payload.user.locationId : '';
    }

    for (const item of Array.isArray(payload?.characters) ? payload.characters : []) {
        const base = validChars.get(item?.id);
        if (!base || seen.has(base.id)) continue;
        seen.add(base.id);
        const previous = getRuntimeCharacter(base);
        const next = { ...runtime.characters[base.id] };
        if (validMaps.has(item.mapId)) next.mapId = item.mapId;
        if (validLocations.has(item.locationId)) {
            const loc = validLocations.get(item.locationId);
            next.locationId = loc.id;
            next.mapId = loc.mapId;
            next.location = loc.name;
            if (previous.locationId !== loc.id) arrivals.push(`${base.name} 已经抵达 ${loc.name}`);
            Object.assign(next, getLocationPosition(loc));
        }
        for (const key of ['location', 'companions', 'activity', 'destination', 'status', 'distance', 'encounter']) {
            if (typeof item[key] === 'string' && item[key].trim()) next[key] = item[key].trim().slice(0, 240);
        }
        runtime.characters[base.id] = next;
    }
    runtime.lastSyncAt = new Date().toISOString();
    runtime.stale = false;
    saveSettings();
    if (settings.arrivalNotifications !== false) arrivals.forEach(message => notify(message));
}

function advanceStandalone() {
    const settings = getSettings();
    const state = settings.runtimeState;
    const minutes = (state.minutes ?? 540) + 30;
    const hour = Math.floor(minutes / 60) % 24;
    const candidates = world.characters.filter(c => Array.isArray(c.routine) && c.routine.length);
    // Shuffle without changing the configured list. At most 3–6 characters update.
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const count = Math.min(candidates.length, 3 + Math.floor(Math.random() * 4));
    const changes = [];
    for (const base of candidates.slice(0, count)) {
        const current = getRuntimeCharacter(base);
        const options = base.routine.filter(r => {
            const inTime = !r.hours || (r.hours[0] <= r.hours[1]
                ? hour >= r.hours[0] && hour < r.hours[1]
                : hour >= r.hours[0] || hour < r.hours[1]);
            return inTime && world.locations.some(l => l.id === r.locationId);
        });
        if (!options.length) continue;
        // Dwell for configured ticks before reconsidering a destination.
        const remaining = Number(current.remainingTurns) || 0;
        if (remaining > 0 && options.some(r => r.locationId === current.locationId)) {
            state.characters[base.id] = { ...state.characters[base.id], remainingTurns: remaining - 1 };
            continue;
        }
        const total = options.reduce((sum, r) => sum + Math.max(1, Number(r.weight) || 1), 0);
        let roll = Math.random() * total;
        const choice = options.find(r => (roll -= Math.max(1, Number(r.weight) || 1)) < 0) ?? options[0];
        const location = world.locations.find(l => l.id === choice.locationId);
        changes.push({ id: base.id, locationId: location.id, mapId: location.mapId,
            location: choice.label || location.name, activity: choice.activity || '停留',
            status: choice.status || '日常', destination: '暂无', distance: '未计算' });
        state.characters[base.id] = { ...state.characters[base.id], remainingTurns: Math.max(0, (choice.durationTurns || 1) - 1) };
    }
    if (changes.length) applyRuntimePayload({ characters: changes });
    state.minutes = minutes;
    state.turn = (state.turn || 0) + 1;
    state.lastSyncAt = new Date().toISOString();
    state.stale = false;
    saveSettings();
    renderMap(); updateSyncStatus();
    if (selectedCharacterId) void openCharacterCard(selectedCharacterId);
    if (selectedLocationId) openLocationCard(selectedLocationId);
    notify(changes.length ? '自由地图已推进半小时' : '自由地图已推进半小时，角色暂时继续当前活动');
}

async function refreshStatusFromChat() {
    if (refreshInFlight) return;
    if (!initialized) { await init(); return; }
    if (!world) return;
    const ctx = getContext();
    if (isStandalone()) { advanceStandalone(); return; }
    if (ctx.isGenerating === true || ctx.is_send_press === true) {
        notify('请等当前聊天回复完成后再刷新。', true);
        return;
    }
    const sourceChat = ctx.chat;
    const sourceMetadata = ctx.chatMetadata;
    if (typeof ctx?.generateQuietPrompt !== 'function') {
        notify('当前酒馆没有可用的后台生成接口，请提供酒馆版本号。', true);
        return;
    }
    refreshInFlight = true;
    updateSyncStatus();
    try {
        const result = await ctx.generateQuietPrompt({ quietPrompt: buildRefreshPrompt() });
        if (getContext()?.chat !== sourceChat || getContext()?.chatMetadata !== sourceMetadata) {
            notify('你已切换聊天，本次刷新结果已丢弃，请在当前聊天重新刷新。');
            return;
        }
        const payload = parseModelJson(result);
        applyRuntimePayload(payload);
        renderMap();
        updateSyncStatus();
        if (selectedCharacterId) await openCharacterCard(selectedCharacterId);
        if (selectedLocationId) openLocationCard(selectedLocationId);
        notify('地图状态已刷新');
    } catch (err) {
        console.error(`[${MODULE_NAME}] 刷新状态失败`, err);
        notify(`地图状态刷新失败：${err?.message ?? err}`, true);
    } finally {
        refreshInFlight = false;
        updateSyncStatus();
    }
}

function makeSettingsPanel() {
    if (document.getElementById('stwm-settings-panel')) return;
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;
    const panel = document.createElement('div');
    panel.id = 'stwm-settings-panel';
    panel.className = 'stwm-settings-panel';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>世界地图 v0.4.2</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>酒馆首页也显示地图悬浮标。自由地图无需聊天或 API，点击刷新推进角色生活；剧情地图使用当前聊天同步。</p>
                <div class="stwm-settings-actions">
                    <button type="button" class="menu_button" id="stwm-settings-open">打开地图</button>
                    <button type="button" class="menu_button" data-stwm-refresh>刷新状态</button>
                </div>
                <label><input id="stwm-arrival-toggle" type="checkbox"> 角色抵达地点时弹出提醒</label>
                <small>自由地图不调用模型；剧情地图刷新会使用当前 API 和聊天上下文。两种地图的进度分别保存。</small>
            </div>
        </div>`;
    host.append(panel);
    const arrivalToggle = panel.querySelector('#stwm-arrival-toggle');
    arrivalToggle.checked = getSettings()?.arrivalNotifications !== false;
    arrivalToggle.addEventListener('change', () => {
        const settings = persistentSettings();
        if (settings) { settings.arrivalNotifications = arrivalToggle.checked; saveSettings(); }
    });
    panel.querySelector('#stwm-settings-open')?.addEventListener('click', openMap);
    panel.querySelector('[data-stwm-refresh]')?.addEventListener('click', refreshStatusFromChat);
    updateSyncStatus();
}

function markStateStale() {
    const settings = getSettings();
    if (!settings?.runtimeState) return;
    settings.runtimeState.stale = true;
    saveSettings();
    updateSyncStatus();
}

function waitForDomReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
}

function bindEvents() {
        const ctx = getContext();
        if (!eventsBound && ctx?.eventSource?.on) {
            const types = ctx.eventTypes ?? ctx.event_types ?? {};
            if (types.CHAT_CHANGED) ctx.eventSource.on(types.CHAT_CHANGED, () => {
                closeCard();
                syncHeaderControls();
                updateSyncStatus();
                renderMap();
            });
            if (types.MESSAGE_RECEIVED) ctx.eventSource.on(types.MESSAGE_RECEIVED, markStateStale);
            for (const type of [types.APP_READY, types.APP_INITIALIZED].filter(Boolean)) {
                ctx.eventSource.on(type, () => { setTimeout(makeSettingsPanel, 0); });
            }
            eventsBound = true;
        }
}

function init() {
    if (initialized) return Promise.resolve();
    if (initPromise) return initPromise;
    initPromise = initialize().finally(() => { initPromise = null; });
    return initPromise;
}

async function initialize() {
    try {
        await waitForDomReady();
        if (extBase() && !document.getElementById('stwm-style')) {
            const link = document.createElement('link');
            link.id = 'stwm-style'; link.rel = 'stylesheet';
            link.href = new URL('world-map.css?v=0.4.2', extBase()).href;
            document.head.append(link);
        }
        makeRoot();
        makeSettingsPanel();
        document.getElementById('stwm-bootstrap')?.remove();
        startupError = '';
        updateSyncStatus();
        await loadWorld();
        getSettings();
        makeSettingsPanel();
        bindEvents();
        initialized = true;
        renderMap();
        updateSyncStatus();
        console.log(`[${MODULE_NAME}] v0.4.2 loaded from ${EXT_BASE_URL}`);
    } catch (err) {
        initialized = false;
        startupError = String(err?.message ?? err);
        updateSyncStatus();
        notify(`世界地图加载失败：${startupError}。点击地图内「刷新状态」重试。`, true);
        console.error(`[${MODULE_NAME}] 初始化失败`, err);
    }
}

// Settings containers can be inserted after extension scripts execute.
void waitForDomReady().then(() => {
    const observer = new MutationObserver(() => {
        bindEvents();
        if (!document.getElementById('stwm-settings-panel')) makeSettingsPanel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
void init();

})();
