// ==UserScript==
// @name         FPVX.LOL EARLY ACCESS
// @namespace    https://bloxflip.com/
// @version      4.1
// @description  fpvx.lol early access
// @author       fpvx + ceddy
// @match        https://bloxflip.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      euievznhlctlzheqdljl.supabase.co
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      api.anthropic.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

function getDeviceId() {
  let deviceId = GM_getValue("device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    GM_setValue("device_id", deviceId);
  }
  return deviceId;
}

const deviceId = getDeviceId();

function getAuthToken() {
  const lsKeys = ['token', 'auth_token', 'authToken', 'x-auth-token', 'bf_token', 'user_token', 'accessToken'];
  for (const key of lsKeys) {
    try {
      const val = localStorage.getItem(key);
      if (val && val.length > 8) return val.replace(/^"(.*)"$/, '$1');
    } catch {}
  }
  for (const key of lsKeys) {
    try {
      const val = sessionStorage.getItem(key);
      if (val && val.length > 8) return val.replace(/^"(.*)"$/, '$1');
    } catch {}
  }
  try {
    const match = document.cookie.match(/(?:^|;\s*)(?:token|auth_token|authToken|bf_token)=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch {}
  try {
    const nuxt = window.__NUXT__ || window.__nuxt__;
    if (nuxt) {
      const str = JSON.stringify(nuxt);
      const m = str.match(/"(?:token|authToken|auth_token|x-auth-token)"\s*:\s*"([^"]{10,})"/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

(function () {
'use strict';

const SUPABASE_URL = 'https://euievznhlctlzheqdljl.supabase.co';

const AI_PROVIDERS = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4-turbo-preview' },
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-3-opus-20240229' }
};

let aiProvider = GM_getValue('fpvx_ai_provider', 'openai');
let aiApiKey = GM_getValue('fpvx_ai_api_key', '');
let aiEnabled = GM_getValue('fpvx_ai_enabled', true);
let licenseKey = GM_getValue('fpvx_license_key', '');
let licenseStatus = GM_getValue('fpvx_license_status', 'unverified');
let licenseExpiry = GM_getValue('fpvx_license_expiry', 'N/A');
let lastLicenseOk = 0;
let revalidating = false;
let currentSession = null;

async function callPredict(game, data) {
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1aWV2em5obGN0bHpoZXFkbGpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMjUzNzEsImV4cCI6MjA5NzcwMTM3MX0.dPYP6AnndRq5yCijj3eRzxHGkUUm40srrSplBdwlIQQ';
  if (!currentSession) throw new Error('No active session');
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SUPABASE_URL}/functions/v1/predict`,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_KEY}`, 'apikey': SB_KEY },
      data: JSON.stringify({ game, session_token: currentSession, data: { ...data, hwid: deviceId } }),
      timeout: 8000,
      onload(response) {
        try {
          const d = JSON.parse(response.responseText);
          if (d.error) reject(new Error(d.error));
          else resolve(d.result);
        } catch { reject(new Error('Invalid prediction response')); }
      },
      onerror() { reject(new Error('Prediction server unreachable')); },
      ontimeout() { reject(new Error('Prediction timed out')); }
    });
  });
}
const LICENSE_RECHECK_MS = 60000;

let safe = GM_getValue('fpvx_safe', 6);
let themeId = GM_getValue('fpvx_theme', 'fpvx');
let blurPrivate = GM_getValue('fpvx_blur_private', false);
let streamerMode = GM_getValue('fpvx_streamer_mode', false);
let lastPrediction = GM_getValue('fpvx_last_prediction', []);
let predictionHistory = GM_getValue('fpvx_prediction_history', []);
let busy = false;
let flipcoins = GM_getValue('fpvx_flipcoins', 0);
let rocoins = GM_getValue('fpvx_rocoins', 0);
let currentTab = 'mines';

const TOWER_ROWS = 8;
const TOWER_COLS = 3;
let towersGridHistory = (() => {
  try {
    const saved = GM_getValue('fpvx_towers_grid', null);
    if (saved) return JSON.parse(saved);
  } catch {}
  return Array.from({ length: TOWER_ROWS }, () =>
    Array.from({ length: TOWER_COLS }, () => ({ safe: 0, bombs: 0, recent: 0 }))
  );
})();
let towersColTransitions = (() => {
  try {
    const saved = GM_getValue('fpvx_towers_trans', null);
    if (saved) return JSON.parse(saved);
  } catch {}
  return Array.from({ length: TOWER_ROWS }, () =>
    Array.from({ length: TOWER_COLS }, () => Array(TOWER_COLS).fill(0))
  );
})();
let towersPathGenerated = false;
let towersConfidence = 0;
let towersTargetRows = GM_getValue('fpvx_tower_rows', 3);
let towersLockedPath = [];

let minesConfidence = 0;
let activeHighlights = [];
let predictedTiles = [];
let autoPlayEnabled = false;
let autoPlayActive = false;
let consecutiveLosses = 0;
let gameResetPending = false;
let isIdle = true;
let isPredicting = false;
let lastMinesState = 'none';
let towersStableCount = 0;
let gameWatcherInterval = null;
let isTowersMode = false;

let slideHistory = [];
let slidePrediction = null;
let autoSlideEnabled = false;
let slideAutoPlayInterval = null;
let slideAutoPlayRunning = false;
let slideRoundRunning = false;
let slideConfidence = 0;
let slideNonce = 0;
let slideClientSeed = '';
let slideNonceOffset = 0;
let _slideRoundPredicted = false;

let bjAutoPlayEnabled = false;
let bjAutoPlayInterval = null;
let bjLastAutoBetTime = 0;
let bjLastInsuranceNoClick = 0;
let bjRunningCount = 0;
let bjCardsDealt = 0;
const bjDecksInShoe = 8;
const bjBaseBetUnit = 10;
let bjIsActionPending = false;
let bjLastActionStateStr = '';
let bjActionLockTimeout = null;
let bjExpectingNewRound = true;

const DISCORD_CLIENT_ID = '1527060868720758945';
const DISCORD_GUILD_ID = '1515920566253650074';
const DISCORD_SCOPES = 'identify guilds.members.read';
const DISCORD_REDIRECT = window.location.origin + '/';
function _rid(a,b,c){return a.map(function(v,i){return String.fromCharCode(v)}).join('')}
const _rids=[_rid([49,53,49,53,57,50,51,54,57,48,55,55,53,49,49,55,57,48,52]),_rid([49,53,49,53,57,50,51,56,48,52,57,49,56,57,49,49,48,54,54]),_rid([49,53,49,53,57,50,51,57,54,51,52,53,57,54,54,53,57,56,49])];
const DISCORD_RANKS = [
  { id: '1525867158792310976', name: 'Lord', gradient: 'linear-gradient(90deg, var(--fpvx-accent), var(--fpvx-accent2), var(--fpvx-accent), var(--fpvx-accent2))', lord: true },
  { id: '1515923370506719382', name: 'Lord', gradient: 'linear-gradient(90deg, var(--fpvx-accent), var(--fpvx-accent2), var(--fpvx-accent), var(--fpvx-accent2))', lord: true },
  { id: _rids[0], name: 'Admin', gradient: 'linear-gradient(90deg, #1e40af, #3b82f6, #1d4ed8, #60a5fa, #1e40af)', animGradient: 'linear-gradient(90deg, #1e40af, #3b82f6, #1d4ed8, #60a5fa, #1e40af)' },
  { id: _rids[1], name: 'Mod', gradient: 'linear-gradient(90deg, #eab308, #fde047, #ca8a04, #facc15, #eab308)', animGradient: 'linear-gradient(90deg, #eab308, #fde047, #ca8a04, #facc15, #eab308)' },
  { id: _rids[2], name: 'Support', gradient: 'linear-gradient(90deg, #38bdf8, #bae6fd, #0ea5e9, #7dd3fc, #38bdf8)', animGradient: 'linear-gradient(90deg, #38bdf8, #bae6fd, #0ea5e9, #7dd3fc, #38bdf8)' },
  { id: '1516394958893093077', name: 'YouTuber', gradient: 'linear-gradient(90deg, #ef4444, #fff, #f87171, #fff, #ef4444)', animGradient: 'linear-gradient(90deg, #ef4444, #fff, #f87171, #fff, #ef4444)' },
  { id: '1519982030304055306', name: 'Lifetime Buyer', gradient: 'linear-gradient(90deg, #22c55e, #86efac, #16a34a, #4ade80, #22c55e)', animGradient: 'linear-gradient(90deg, #22c55e, #86efac, #16a34a, #4ade80, #22c55e)' },
  { id: '1516004910276018176', name: 'Buyer', gradient: 'linear-gradient(90deg, #a855f7, #c084fc, #7c3aed, #c084fc, #a855f7)', animGradient: 'linear-gradient(90deg, #a855f7, #c084fc, #7c3aed, #c084fc, #a855f7)' }
];
let discordToken = GM_getValue('fpvx_discord_token', null);
let discordUsername = GM_getValue('fpvx_discord_username', null);
let discordDiscriminator = GM_getValue('fpvx_discord_discriminator', null);
let discordAvatar = GM_getValue('fpvx_discord_avatar', null);
let discordRank = GM_getValue('fpvx_discord_rank', null);
let discordRankGradient = GM_getValue('fpvx_discord_rank_gradient', '');
let discordRankIsLord = GM_getValue('fpvx_discord_rank_is_lord', false);
let discordConnected = !!discordToken;

const _ActiveSlideSeed={
  _k:'__fpvx_active_slide_seed',_d:null,
  get(){if(!this._d){try{this._d=JSON.parse(localStorage.getItem(this._k)||'null');}catch{this._d=null;}}return this._d;},
  set(seed,cs,nonce){this._d={seed,cs,nonce,capturedAt:Date.now(),usedFor:0};try{localStorage.setItem(this._k,JSON.stringify(this._d));}catch{}},
  clear(){this._d=null;try{localStorage.removeItem(this._k);}catch{}},
  isValid(){const d=this.get();if(!d||!d.seed)return false;return Date.now()-d.capturedAt<3600000;},
  incrementUsed(){const d=this.get();if(d){d.usedFor++;try{localStorage.setItem(this._k,JSON.stringify(d));}catch{}}},
  advanceNonce(newNonce){const d=this.get();if(d){d.nonce=newNonce;try{localStorage.setItem(this._k,JSON.stringify(d));}catch{}this._d=d;}}
};

const bjDealerBustProb = { '2': 35.30, '3': 37.56, '4': 40.28, '5': 42.89, '6': 42.08, '7': 25.99, '8': 23.86, '9': 23.34, '10': 21.43, 'J': 21.43, 'Q': 21.43, 'K': 21.43, 'A': 11.65 };
const bjDealerIndexMap = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8, 'J': 8, 'Q': 8, 'K': 8, 'A': 9 };
const bjStyleMap = {
  H: { text: 'HIT', color: '#ef4444', border: '2px solid #ef4444', raw: 'Hit' },
  S: { text: 'STAND', color: '#22c55e', border: '2px solid #22c55e', raw: 'Stand' },
  D: { text: 'DOUBLE', color: '#f59e0b', border: '2px solid #f59e0b', raw: 'Double' },
  P: { text: 'SPLIT', color: '#a855f7', border: '2px solid #a855f7', raw: 'Split' }
};

function bjQs(sel, root) { return (root || document).querySelector(sel); }
function bjQsa(sel, root) { return (root || document).querySelectorAll(sel); }

function bjNormalizeCard(val) {
  if (!val) return null;
  const t = val.toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t === 'J' || t === 'Q' || t === 'K') return '10';
  if (t === 'A') return 'A';
  if (/^\d+$/.test(t)) return t;
  return null;
}

function bjCountCard(val) {
  bjCardsDealt++;
  const v = bjNormalizeCard(val);
  if (!v) return;
  if (['2','3','4','5','6'].includes(v)) bjRunningCount += 1;
  else if (['10','A'].includes(v)) bjRunningCount -= 1;
}

function bjResetCount() {
  bjRunningCount = 0;
  bjCardsDealt = 0;
  bjQsa('[data-bj-counted]').forEach(el => delete el.dataset.bjCounted);
}

function bjGetTrueCount() {
  const decksRemaining = Math.max(0.5, bjDecksInShoe - (bjCardsDealt / 52));
  return bjRunningCount / decksRemaining;
}

function bjCalcBustProb(upcard) {
  const base = bjDealerBustProb[upcard] || 23;
  const tc = bjGetTrueCount();
  const adjustment = tc * 0.8;
  return Math.max(5, Math.min(60, base + adjustment));
}

function bjCalcTenProb() {
  const totalCards = bjDecksInShoe * 52;
  const tensSeen = bjCardsDealt * (30.77 / 100);
  const lowCardsSeen = bjCardsDealt * (69.23 / 100);
  const tensRemaining = Math.max(1, (totalCards * 0.3077) - tensSeen + (bjRunningCount < 0 ? Math.abs(bjRunningCount) : 0));
  const totalRemaining = Math.max(1, totalCards - bjCardsDealt);
  return (tensRemaining / totalRemaining) * 100;
}

function bjCalcEdge() {
  const tc = bjGetTrueCount();
  if (tc <= 0) return -0.005 + (tc * 0.003);
  return -0.005 + (tc * 0.005) + (tc >= 3 ? 0.002 : 0);
}

function bjClickInsuranceNo() {
  const now = Date.now();
  if (now - bjLastInsuranceNoClick < 2000) return;
  const tc = bjGetTrueCount();
  if (tc >= 3) return;
  const declineBtn = bjQs('button[class*="insurance-module-scss-module"]');
  if (declineBtn) {
    const text = (declineBtn.innerText || declineBtn.textContent || '').trim().toLowerCase();
    if (text === 'decline' && getComputedStyle(declineBtn).opacity !== '0' && !declineBtn.disabled) {
      bjLastInsuranceNoClick = now;
      declineBtn.click();
      return;
    }
  }
  const buttons = bjQsa('button[class*="insurance"]');
  for (const btn of buttons) {
    if (btn.closest('#fpvx-bj-content-shell')) continue;
    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
    if (text !== 'decline') continue;
    if (getComputedStyle(btn).opacity === '0' || btn.disabled) continue;
    bjLastInsuranceNoClick = now;
    btn.click();
    return;
  }
}

function bjTriggerMoveAnimation() {
  const moveBox = bjQs('#fpvx-bj-move-box');
  if (!moveBox) return;
  moveBox.style.transform = 'translate3d(0, -2px, 0)';
  moveBox.style.boxShadow = '0 6px 20px rgba(255,255,255,0.15)';
  requestAnimationFrame(() => {
    setTimeout(() => {
      moveBox.style.transform = 'translate3d(0, 0, 0)';
      moveBox.style.boxShadow = 'none';
    }, 180);
  });
}

function bjUpdateUI(data) {
  const scanDealer = bjQs('#fpvx-bj-scan-dealer');
  const scanPlayer = bjQs('#fpvx-bj-scan-player');
  const probBust = bjQs('#fpvx-bj-prob-bust');
  const probTen = bjQs('#fpvx-bj-prob-ten');
  const cardCount = bjQs('#fpvx-bj-card-count');
  const moveBox = bjQs('#fpvx-bj-move-box');
  const moveText = bjQs('#fpvx-bj-auto-move');
  if (!scanDealer || !scanPlayer || !moveBox || !moveText) return;
  scanDealer.textContent = data.dealer;
  scanPlayer.innerHTML = data.player;
  if (probBust) {
    if (data.bustProb != null) {
      const c = data.bustProb > 40 ? '#22c55e' : (data.bustProb > 30 ? '#a855f7' : '#ef4444');
      probBust.innerHTML = '<span style="color:' + c + '">' + data.bustProb.toFixed(1) + '%</span>';
    } else { probBust.textContent = '\u2014'; }
  }
  if (probTen) {
    if (data.tenProb != null) {
      const t = data.tenProb > 33 ? '#ef4444' : (data.tenProb > 30 ? '#f59e0b' : '#22c55e');
      probTen.innerHTML = '<span style="color:' + t + '">' + data.tenProb.toFixed(1) + '%</span>';
    } else { probTen.textContent = '\u2014'; }
  }
  if (cardCount) {
    const tc = data.tc != null ? data.tc : bjGetTrueCount();
    const edge = data.edge != null ? data.edge : bjCalcEdge();
    const countCol = tc > 0 ? '#22c55e' : (tc < 0 ? '#ef4444' : '#f59e0b');
    cardCount.textContent = (tc > 0 ? '+' : '') + tc.toFixed(1) + ' (' + (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + '%)';
    cardCount.style.color = countCol;
  }
  const previous = moveText.textContent;
  if (typeof data.move === 'string') {
    moveBox.style.border = '1px solid rgba(255,255,255,0.08)';
    moveText.style.color = '#fff';
    moveText.textContent = data.move;
    moveText.style.textShadow = 'none';
  } else if (data.move && data.move.border && data.move.text) {
    moveBox.style.border = data.move.border;
    moveText.style.color = data.move.color;
    moveText.textContent = data.move.text;
    moveText.style.textShadow = '0 0 10px ' + data.move.color + '60';
  }
  if (previous !== moveText.textContent) bjTriggerMoveAnimation();
}

function bjAttemptAutoPlay(moveObj, playerStateStr) {
  if (!bjAutoPlayEnabled || !moveObj || typeof moveObj !== 'object' || !moveObj.raw) return;
  if (bjLastActionStateStr === playerStateStr && bjIsActionPending) return;
  const targetText = (moveObj.raw || '').toLowerCase().trim();
  if (!targetText) return;
  const delay = Math.floor(Math.random() * 400) + 200;
  let targetButton = null;
  const candidates = bjQsa('.blackjack-module button, .blackjack-module [role="button"], button, [role="button"], [class*="button" i], [class*="gameControl" i]');
  for (const btn of candidates) {
    if (btn.closest('#fpvx-bj-content-shell')) continue;
    const style = getComputedStyle(btn);
    if (btn.offsetWidth === 0 || btn.offsetHeight === 0 || style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none' || btn.disabled) continue;
    const text = (btn.innerText || btn.textContent || '').toLowerCase().trim();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (text.includes(targetText) || aria.includes(targetText)) { targetButton = btn; break; }
  }
  if (!targetButton) return;
  bjIsActionPending = true;
  bjLastActionStateStr = playerStateStr;
  if (bjActionLockTimeout) clearTimeout(bjActionLockTimeout);
  setTimeout(() => {
    try {
      if (!targetButton.disabled) {
        targetButton.click();
        bjActionLockTimeout = setTimeout(() => { bjLastActionStateStr = ''; bjIsActionPending = false; }, 1200);
      }
    } finally {
      setTimeout(() => { bjIsActionPending = false; }, 800);
    }
  }, delay);
}

function bjAttemptAutoBet() {
  if (!bjAutoPlayEnabled) return;
  const now = Date.now();
  if (now - bjLastAutoBetTime < 1500) return;
  const gameBetBlock = bjQs('.gameBet, [class*="gameBet"]');
  const betInput = gameBetBlock ? bjQs('input[type="number"]', gameBetBlock) : null;
  let betButton = null;
  const candidates = bjQsa('button.gameBetSubmit, .gameBet button, [class*="gameBet"] button');
  for (const btn of candidates) {
    if (btn.closest('#fpvx-bj-content-shell')) continue;
    if (btn.offsetWidth === 0 || btn.offsetHeight === 0 || getComputedStyle(btn).opacity === '0' || btn.disabled) continue;
    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
    if (text.includes('place') && text.includes('bet') || text.includes('start') && text.includes('new game') || text === 'rebet') {
      betButton = btn; break;
    }
  }
  if (!betButton) return;
  let chosenBet = Math.min(500, bjBaseBetUnit || 10);
  if (betInput) {
    const currentInputValue = parseFloat(betInput.value) || 0;
    if (currentInputValue !== chosenBet) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (setter) setter.call(betInput, chosenBet);
      else betInput.value = chosenBet;
      betInput.dispatchEvent(new Event('input', { bubbles: true }));
      betInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  bjLastAutoBetTime = now;
  setTimeout(() => { if (!betButton.disabled) betButton.click(); }, Math.floor(Math.random() * 500) + 300);
}

function bjStopAutoPlayCompletely() {
  clearInterval(bjAutoPlayInterval);
  bjAutoPlayInterval = null;
  bjAutoPlayEnabled = false;
  bjIsActionPending = false;
  bjLastActionStateStr = '';
  const btn = bjQs('#fpvx-bj-btn-autoplay');
  if (btn) {
    btn.classList.remove('bj-running-btn');
    btn.textContent = 'START AUTO-PLAY';
    btn.style.background = '';
    btn.style.color = '';
    btn.style.border = '';
    btn.style.boxShadow = '';
  }
}

function discordUpdateUI() {
  const statusEl = document.getElementById('val-status');
  const rankEl = document.getElementById('val-rank');
  if (statusEl) {
    if (discordConnected) {
      statusEl.textContent = '@' + discordUsername;
      statusEl.style.color = 'var(--fpvx-accent)';
    } else {
      statusEl.innerHTML = '<button id="fpvx-discord-connect" style="background:none;border:1px solid rgba(88,101,242,0.5);color:#5865F2;font-size:9px;font-weight:700;cursor:pointer;padding:3px 8px;border-radius:4px;font-family:inherit;">Connect Discord</button>';
      const btn = document.getElementById('fpvx-discord-connect');
      if (btn) btn.addEventListener('click', discordConnect);
    }
  }
  if (rankEl) {
    if (discordRank) {
      rankEl.textContent = discordRank;
      rankEl.style.background = discordRankGradient;
      rankEl.style.backgroundSize = '200% 200%';
      rankEl.style.webkitBackgroundClip = 'text';
      rankEl.style.webkitTextFillColor = 'transparent';
      rankEl.style.fontWeight = '900';
      rankEl.style.color = '';
      if (discordRankIsLord) {
        rankEl.style.animation = 'fpvxRankShimmer 2s ease infinite, fpvxLordGlow 2s ease-in-out infinite';
      } else {
        rankEl.style.animation = 'fpvxRankShimmer 2.5s ease infinite';
      }
    } else {
      rankEl.textContent = '\u2014';
      rankEl.style.background = '';
      rankEl.style.backgroundSize = '';
      rankEl.style.webkitBackgroundClip = '';
      rankEl.style.webkitTextFillColor = '';
      rankEl.style.animation = '';
      rankEl.style.color = '#718096';
    }
  }
}

function discordConnect() {
  const state = Math.random().toString(36).substring(2, 10);
  GM_setValue('fpvx_discord_state', state);
  const authUrl = 'https://discord.com/api/oauth2/authorize?' + new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT,
    response_type: 'token',
    scope: DISCORD_SCOPES,
    state: state
  }).toString();
  window.open(authUrl, '_blank');
}

function discordHandleCallback() {
  const hash = window.location.hash;
  if (!hash || !hash.includes('access_token')) return;
  const params = new URLSearchParams(hash.substring(1));
  const token = params.get('access_token');
  const returnedState = params.get('state');
  const savedState = GM_getValue('fpvx_discord_state', null);
  if (!token) return;
  if (savedState && returnedState && returnedState !== savedState) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  discordToken = token;
  GM_setValue('fpvx_discord_token', token);
  discordConnected = true;
  discordFetchUser();
}

function discordFetchUser() {
  if (!discordToken) return;
  GM_xmlhttpRequest({
    method: 'GET',
    url: 'https://discord.com/api/users/@me',
    headers: { 'Authorization': 'Bearer ' + discordToken },
    onload: function(resp) {
      if (resp.status !== 200) { discordDisconnect(); return; }
      const user = JSON.parse(resp.responseText);
      discordUsername = user.username;
      discordDiscriminator = user.discriminator;
      discordAvatar = user.avatar;
      GM_setValue('fpvx_discord_username', user.username);
      GM_setValue('fpvx_discord_discriminator', user.discriminator);
      GM_setValue('fpvx_discord_avatar', user.avatar);
      discordFetchRank(user.id);
    },
    onerror: function() { discordDisconnect(); }
  });
}

function discordFetchRank(userId) {
  if (!discordToken || !userId) return;
  GM_xmlhttpRequest({
    method: 'GET',
    url: 'https://discord.com/api/users/@me/guilds/' + DISCORD_GUILD_ID + '/member',
    headers: { 'Authorization': 'Bearer ' + discordToken },
    onload: function(resp) {
      if (resp.status !== 200) {
        discordRank = null;
        discordRankGradient = '';
        discordRankIsLord = false;
        GM_setValue('fpvx_discord_rank', null);
        GM_setValue('fpvx_discord_rank_gradient', '');
        GM_setValue('fpvx_discord_rank_is_lord', false);
        discordUpdateUI();
        return;
      }
      const raw = resp.responseText;
      let foundRank = null;
      let foundGradient = '';
      let foundLord = false;
      for (const rank of DISCORD_RANKS) {
        const searchId = String.fromCharCode.apply(null, rank.id.split('').map(function(c){ return c.charCodeAt(0); }));
        if (raw.indexOf('"' + searchId + '"') !== -1) {
          foundRank = rank.name;
          foundGradient = rank.animGradient || rank.gradient;
          foundLord = !!rank.lord;
          break;
        }
      }
      discordRank = foundRank;
      discordRankGradient = foundGradient;
      discordRankIsLord = foundLord;
      GM_setValue('fpvx_discord_rank', foundRank);
      GM_setValue('fpvx_discord_rank_gradient', foundGradient);
      GM_setValue('fpvx_discord_rank_is_lord', foundLord);
      discordUpdateUI();
    },
    onerror: function() {
      discordRank = null;
      discordRankGradient = '';
      discordUpdateUI();
    }
  });
}

function discordDisconnect() {
  discordToken = null;
  discordUsername = null;
  discordDiscriminator = null;
  discordAvatar = null;
  discordRank = null;
  discordRankGradient = '';
  discordRankIsLord = false;
  discordConnected = false;
  GM_setValue('fpvx_discord_token', null);
  GM_setValue('fpvx_discord_username', null);
  GM_setValue('fpvx_discord_discriminator', null);
  GM_setValue('fpvx_discord_avatar', null);
  GM_setValue('fpvx_discord_rank', null);
  GM_setValue('fpvx_discord_rank_gradient', '');
  GM_setValue('fpvx_discord_rank_is_lord', false);
  discordUpdateUI();
}

function bjScrapeBoard() {
  const result = { dealer: [], player: [] };
  bjClickInsuranceNo();
  const gameContainer = bjQs('[class*="gameLayout"]') || document.body;
  const allCards = bjQsa('.card-container, [class*="card"][class*="container"], [class*="Card"][class*="container"], [class*="playingCard"], [class*="playing-card"], [class*="gameCard"], [class*="game-card"]', gameContainer);
  let dealerCards = [];
  let playerCards = [];
  allCards.forEach(card => {
    const style = getComputedStyle(card);
    if (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none' || card.className.toLowerCase().includes('hidden')) return;
    const valueEl = bjQs('[class*="value"], [class*="Value"], [class*="rank"], [class*="Rank"], [class*="face"], [class*="Face"]', card);
    if (!valueEl) return;
    const raw = valueEl.innerText.trim();
    const cardValue = bjNormalizeCard(raw);
    if (!cardValue) return;
    if (!card.dataset.bjCounted) {
      bjCountCard(cardValue);
      card.dataset.bjCounted = 'true';
    }
    const cardRect = card.getBoundingClientRect();
    const gameRect = gameContainer.getBoundingClientRect();
    if (!gameRect.height) return;
    const relativeY = cardRect.top - gameRect.top;
    if (relativeY < gameRect.height * 0.45) {
      dealerCards.push(cardValue);
    } else {
      playerCards.push(cardValue);
    }
  });
  result.dealer = dealerCards;
  result.player = playerCards;
  return result;
}

function bjRunScrapeAndPredict() {
  if (!bjQs('#fpvx-bj-content-shell')) return;
  const data = bjScrapeBoard();
  const scanDealer = bjQs('#fpvx-bj-scan-dealer');
  const moveBox = bjQs('#fpvx-bj-move-box');
  const moveText = bjQs('#fpvx-bj-auto-move');
  if (!data.dealer.length && !data.player.length) {
    if (bjExpectingNewRound === false) {
      bjResetCount();
      bjExpectingNewRound = true;
    }
    bjIsActionPending = false;
    bjLastActionStateStr = '';
    if (scanDealer) scanDealer.textContent = '-';
    const scanPlayer = bjQs('#fpvx-bj-scan-player');
    if (scanPlayer) scanPlayer.textContent = '-';
    const probBust = bjQs('#fpvx-bj-prob-bust');
    if (probBust) probBust.textContent = '\u2014';
    const probTen = bjQs('#fpvx-bj-prob-ten');
    if (probTen) probTen.textContent = '\u2014';
    if (moveBox) { moveBox.style.border = '1px solid rgba(255,255,255,0.08)'; moveBox.style.boxShadow = 'none'; }
    if (moveText) { moveText.style.color = '#fff'; moveText.style.textShadow = 'none'; moveText.textContent = 'WAITING'; }
    return;
  }
  if (!data.dealer.length || data.player.length < 2) return;
  if (bjExpectingNewRound) bjExpectingNewRound = false;
  const dealerUpcard = data.dealer[0];
  const tc = bjGetTrueCount();

  callPredict('blackjack', {
    cards: data.player,
    dealerUpcard,
    isSplitHand: false,
    trueCount: tc
  }).then(res => {
    const bustProb = res.bustProb || 23;
    const tenProb = bjCalcTenProb();
    const edge = bjCalcEdge();
    const moveObj = bjStyleMap[res.move] || bjStyleMap.H;
    bjUpdateUI({ dealer: dealerUpcard, player: res.playerTotal ? String(res.playerTotal) : '?', move: moveObj, bustProb, tenProb, tc, edge });
    if (bjAutoPlayEnabled) {
      bjAttemptAutoPlay(moveObj, data.player.length + '-' + (res.playerTotal || 0) + '-' + dealerUpcard);
    }
  }).catch(() => {
    const bustProb = bjCalcBustProb(dealerUpcard);
    const tenProb = bjCalcTenProb();
    const edge = bjCalcEdge();
    bjUpdateUI({ dealer: dealerUpcard, player: '?', move: bjStyleMap.H, bustProb, tenProb, tc, edge });
  });
}

const THEMES = [
  { id: 'fpvx', name: 'Cyber Neon', accent: '#00f2fe', accent2: '#4facfe', preview: 'linear-gradient(135deg,#00f2fe,#4facfe)' },
  { id: 'amethyst', name: 'Amethyst', accent: '#d946ef', accent2: '#8b5cf6', preview: 'linear-gradient(135deg,#d946ef,#8b5cf6)' },
  { id: 'emerald', name: 'Emerald', accent: '#10b981', accent2: '#059669', preview: 'linear-gradient(135deg,#10b981,#059669)' },
  { id: 'crimson', name: 'Crimson', accent: '#f43f5e', accent2: '#e11d48', preview: 'linear-gradient(135deg,#f43f5e,#e11d48)' },
  { id: 'sunset', name: 'Sunset', accent: '#f97316', accent2: '#eab308', preview: 'linear-gradient(135deg,#f97316,#eab308)' },
  { id: 'ocean', name: 'Ocean', accent: '#0ea5e9', accent2: '#06b6d4', preview: 'linear-gradient(135deg,#0ea5e9,#06b6d4)' },
  { id: 'forest', name: 'Forest', accent: '#22c55e', accent2: '#84cc16', preview: 'linear-gradient(135deg,#22c55e,#84cc16)' },
  { id: 'grape', name: 'Grape', accent: '#a855f7', accent2: '#d946ef', preview: 'linear-gradient(135deg,#a855f7,#d946ef)' },
  { id: 'tangerine', name: 'Tangerine', accent: '#f97316', accent2: '#ef4444', preview: 'linear-gradient(135deg,#f97316,#ef4444)' },
  { id: 'ice', name: 'Ice', accent: '#38bdf8', accent2: '#e0f2fe', preview: 'linear-gradient(135deg,#38bdf8,#e0f2fe)' },
  { id: 'lime', name: 'Lime', accent: '#84cc16', accent2: '#a3e635', preview: 'linear-gradient(135deg,#84cc16,#a3e635)' },
  { id: 'coral', name: 'Coral', accent: '#f472b6', accent2: '#fbcfe8', preview: 'linear-gradient(135deg,#f472b6,#fbcfe8)' },
  { id: 'navy', name: 'Navy', accent: '#3b82f6', accent2: '#1e3a8a', preview: 'linear-gradient(135deg,#3b82f6,#1e3a8a)' },
  { id: 'mono', name: 'Monochrome', accent: '#ffffff', accent2: '#9ca3af', preview: 'linear-gradient(135deg,#ffffff,#9ca3af)' },
  { id: 'redblack', name: 'Red Black', accent: '#ef4444', accent2: '#1a1a1a', preview: 'linear-gradient(135deg,#ef4444,#1a1a1a)' }
];

function getTheme(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }
function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseStatNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^([+-]?\d+(?:,\d{3})*(?:\.\d+)?|\d*\.?\d+)\s*([kmb])?$/i);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g,''));
  if (!Number.isFinite(base)) return null;
  const s = (m[2]||'').toLowerCase();
  return s==='k'?base*1e3:s==='m'?base*1e6:s==='b'?base*1e9:base;
}

function formatNumber(v, decimals=0) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
  return n.toFixed(n % 1 ? 2 : 0);
}

const style = document.createElement('style');
document.head.appendChild(style);

function applyCSS() {
  const t = getTheme(themeId);
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap');

    :root {
      --fpvx-accent: ${t.accent};
      --fpvx-accent2: ${t.accent2};
      --fpvx-glow: ${rgba(t.accent, 0.25)};
      --fpvx-glass-bg: rgba(10, 14, 26, 0.65);
      --fpvx-glass-border: rgba(255, 255, 255, 0.08);
      --fpvx-glass-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }

    @keyframes fpvxFadeIn {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
      100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    @keyframes fpvxTilePulse {
      0%, 100% { box-shadow: inset 0 0 0 2000px ${rgba(t.accent, 0.15)}, 0 0 0 2px ${t.accent}, 0 0 25px ${rgba(t.accent, 0.4)} !important; }
      50% { box-shadow: inset 0 0 0 2000px ${rgba(t.accent, 0.25)}, 0 0 0 2px ${t.accent}, 0 0 40px ${rgba(t.accent, 0.6)} !important; }
    }

    .fpvx-site-tile {
      position: relative !important;
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1) !important;
    }
    .fpvx-site-tile.fpvx-predicted {
      box-shadow: inset 0 0 0 2000px ${rgba(t.accent, 0.15)}, 0 0 0 2px ${t.accent}, 0 0 25px ${rgba(t.accent, 0.4)} !important;
      animation: fpvxTilePulse 2s ease-in-out infinite !important;
      outline: none !important;
      border-color: ${t.accent} !important;
    }

    .fpvx-site-star {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      color: #fff;
      text-shadow: 0 0 30px var(--fpvx-accent), 0 0 60px var(--fpvx-accent);
      pointer-events: none;
      z-index: 5;
      animation: siteStarPop 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .fpvx-site-tile.fpvx-predicted .fpvx-site-star {
      display: flex;
    }
    @keyframes siteStarPop {
      0% { transform: scale(0) rotate(-45deg); opacity: 0; }
      60% { transform: scale(1.4) rotate(5deg); opacity: 1; }
      100% { transform: scale(1) rotate(0deg); opacity: 1; }
    }

    .fpvx-tile-safe-symbol {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #fff;
      text-shadow: 0 0 20px var(--fpvx-accent);
      pointer-events: none;
      z-index: 5;
    }
    .fpvx-tile.safe .fpvx-tile-safe-symbol {
      display: flex;
      animation: symbolPop 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes symbolPop {
      0% { transform: scale(0) rotate(-30deg); opacity: 0; }
      60% { transform: scale(1.3) rotate(5deg); opacity: 1; }
      100% { transform: scale(1) rotate(0deg); opacity: 1; }
    }
    .fpvx-tile-safe-symbol .star-icon {
      font-size: 26px;
      filter: drop-shadow(0 0 10px var(--fpvx-accent));
    }

    #fpvx-license-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(circle at top, ${rgba(t.accent, 0.12)}, transparent 60%), #03050c;
      font-family: 'Plus Jakarta Sans', sans-serif;
      backdrop-filter: blur(4px);
      overflow: hidden;
      opacity: 0;
      transition: opacity 0.6s ease;
    }
    #fpvx-license-overlay:not(.hidden) { opacity: 1; }
    #fpvx-license-overlay.hidden { display: none !important; }

    #fpvx-snowfall {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
    }
    .fpvx-snowflake {
      position: absolute;
      top: -10px;
      background: white;
      border-radius: 50%;
      opacity: 0;
      animation: snowFall linear infinite, snowFadeIn 1s ease forwards;
      will-change: transform;
    }
    @keyframes snowFall {
      0% { transform: translateY(-10px) translateX(0) rotate(0deg); opacity: 0.7; }
      20% { opacity: 0.6; }
      100% { transform: translateY(100vh) translateX(40px) rotate(360deg); opacity: 0; }
    }
    @keyframes snowFadeIn {
      0% { opacity: 0; }
      100% { opacity: 0.7; }
    }

    .fpvx-ov-card {
      position: relative;
      z-index: 1;
      background: var(--fpvx-glass-bg);
      backdrop-filter: blur(20px);
      border: 1px solid var(--fpvx-glass-border);
      border-radius: 24px;
      padding: 40px 30px;
      width: 400px;
      max-width: 90vw;
      text-align: center;
      box-shadow: var(--fpvx-glass-shadow), 0 0 40px ${rgba(t.accent, 0.15)};
      color: #fff;
      animation: cardSlideIn 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes cardSlideIn {
      from { transform: translateY(30px) scale(0.92); opacity: 0; }
      to { transform: translateY(0) scale(1); opacity: 1; }
    }
    .fpvx-ov-card h2 {
      margin: 0 0 6px 0;
      font-weight: 800;
      background: linear-gradient(90deg, #fff, var(--fpvx-accent));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .fpvx-ov-card p {
      margin: 0 0 20px 0;
      color: #a0aec0;
      font-size: 14px;
    }
    .fpvx-ov-input {
      width: 100%;
      height: 50px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      color: #fff;
      text-align: center;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      transition: all 0.4s ease;
      box-sizing: border-box;
      margin-bottom: 16px;
    }
    .fpvx-ov-input:focus {
      border-color: var(--fpvx-accent);
      box-shadow: 0 0 25px ${rgba(t.accent, 0.3)};
    }
    .fpvx-ov-btn {
      width: 100%;
      height: 50px;
      background: linear-gradient(135deg, var(--fpvx-accent), var(--fpvx-accent2));
      border: none;
      border-radius: 12px;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.3s, box-shadow 0.3s;
      box-shadow: 0 4px 15px ${rgba(t.accent, 0.3)};
    }
    .fpvx-ov-btn:hover { transform: scale(1.03); }
    .fpvx-ov-error {
      color: #f56565;
      font-size: 12px;
      margin-top: 10px;
      display: none;
    }

    #fpvx-wrap {
      position: fixed;
      left: calc(50vw - 375px);
      top: calc(50vh - 220px);
      width: 750px;
      height: 440px;
      z-index: 2147483644;
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: var(--fpvx-glass-bg);
      backdrop-filter: blur(24px);
      border: 1px solid var(--fpvx-glass-border);
      border-radius: 20px;
      box-shadow: var(--fpvx-glass-shadow), 0 0 80px ${rgba(t.accent, 0.08)};
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 0.4s cubic-bezier(0.16,1,0.3,1), height 0.4s cubic-bezier(0.16,1,0.3,1), opacity 0.4s ease, transform 0.4s ease;
      color: #fff;
      user-select: none;
      opacity: 1;
      transform: scale(1);
    }
    #fpvx-wrap.hiding {
      opacity: 0;
      transform: scale(0.95);
      pointer-events: none;
    }
    #fpvx-wrap * { box-sizing: border-box; }

    .fpvx-middle-glow {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 300px;
      height: 300px;
      background: radial-gradient(circle, ${rgba(t.accent, 0.15)} 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
      animation: fpvxCenterGlow 4s ease-in-out infinite;
    }
    @keyframes fpvxCenterGlow {
      0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.5; }
      50% { transform: translate(-50%, -50%) scale(1.1); opacity: 1; }
    }

    .fpvx-top {
      height: 44px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      background: rgba(255,255,255,0.02);
      cursor: grab;
      flex-shrink: 0;
      z-index: 1;
      position: relative;
    }
    .fpvx-top:active { cursor: grabbing; }
    .fpvx-title {
      font-weight: 800;
      font-size: 14px;
      letter-spacing: 0.08em;
      background: linear-gradient(90deg, #fff, var(--fpvx-accent));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      white-space: nowrap;
    }
    .fpvx-top-actions { display: flex; gap: 6px; margin-left: auto; }
    .fpvx-mini-btn {
      background: rgba(255,255,255,0.05);
      border: none;
      border-radius: 6px;
      width: 28px;
      height: 28px;
      color: #a0aec0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s;
      font-size: 14px;
      z-index: 2;
    }
    .fpvx-mini-btn:hover { color: #fff; background: rgba(255,255,255,0.1); transform: scale(1.08); }

    .fpvx-tabs {
      display: flex;
      background: rgba(0,0,0,0.2);
      padding: 4px 16px;
      gap: 6px;
      flex-shrink: 0;
      z-index: 1;
    }
    .fpvx-tab {
      padding: 8px 16px;
      color: #718096;
      border: none;
      background: transparent;
      font-weight: 700;
      font-size: 11px;
      cursor: pointer;
      position: relative;
      transition: color 0.4s;
    }
    .fpvx-tab:hover { color: #a0aec0; }
    .fpvx-tab.active { color: #fff; }
    .fpvx-tab.active::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--fpvx-accent);
      border-radius: 3px;
      animation: tabSlideIn 0.4s ease;
      box-shadow: 0 0 15px var(--fpvx-accent);
    }
    @keyframes tabSlideIn {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }

    .fpvx-shell {
      display: grid;
      grid-template-columns: 140px 1fr 140px;
      gap: 12px;
      padding: 12px 16px;
      flex: 1;
      min-height: 0;
      animation: shellFadeIn 0.5s ease;
      position: relative;
      z-index: 1;
    }
    @keyframes shellFadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .fpvx-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .fpvx-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 10px;
      padding: 6px 10px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.4s ease;
    }
    .fpvx-card:hover {
      background: rgba(255,255,255,0.05);
      border-color: rgba(255,255,255,0.1);
    }
    .fpvx-card-lbl {
      font-size: 8px;
      color: #718096;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .fpvx-card-val {
      font-size: 15px;
      font-weight: 800;
      color: #fff;
      font-family: 'JetBrains Mono', monospace;
      margin-top: 1px;
      transition: all 0.4s ease;
      text-shadow: 0 0 20px ${rgba(t.accent, 0.15)};
    }
    .fpvx-card-val.fpvx-blurred { filter: blur(8px); opacity: 0.5; }
    .fpvx-card-val.streamer-blur { filter: blur(8px) !important; opacity: 0.5 !important; }

    .fpvx-board-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    .fpvx-board {
      width: 220px;
      height: 220px;
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 14px;
      padding: 8px;
      box-sizing: border-box;
      position: relative;
    }
    .fpvx-board::after {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 16px;
      background: radial-gradient(ellipse at center, ${rgba(t.accent, 0.1)} 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
      animation: fpvxBoardGlow 3s ease-in-out infinite;
    }
    @keyframes fpvxBoardGlow {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 0.7; }
    }
    .fpvx-grid {
      display: grid;
      gap: 4px;
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 1;
    }
    .fpvx-grid.mines-grid { grid-template-columns: repeat(5, 1fr); grid-template-rows: repeat(5, 1fr); }
    .fpvx-grid.towers-grid { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(8, 1fr); }
    .fpvx-grid.slide-grid { grid-template-columns: 1fr; grid-template-rows: repeat(3, 1fr); gap: 6px; padding: 8px; }
    .fpvx-tile {
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      border: 1px solid transparent;
      position: relative;
      overflow: hidden;
      opacity: 0;
      animation: tileFadeIn 0.4s ease forwards;
    }
    @keyframes tileFadeIn {
      from { opacity: 0; transform: scale(0.7); }
      to { opacity: 1; transform: scale(1); }
    }
    .fpvx-tile:hover { background: rgba(255,255,255,0.1); transform: scale(1.05); }
    .fpvx-tile.safe {
      background: linear-gradient(135deg, var(--fpvx-accent), var(--fpvx-accent2));
      box-shadow: 0 0 25px var(--fpvx-accent);
      border-color: #fff;
    }

    .fpvx-controls {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: auto;
    }
    .fpvx-controls-row {
      display: flex;
      gap: 6px;
    }
    .fpvx-btn-square {
      flex: 1;
      height: 30px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      color: #a0aec0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      font-size: 10px;
      font-weight: 700;
      gap: 4px;
      padding: 0 6px;
      letter-spacing: 0.02em;
      position: relative;
      overflow: hidden;
      white-space: nowrap;
    }
    .fpvx-btn-square:hover {
      color: #fff;
      background: rgba(255,255,255,0.1);
      transform: translateY(-2px);
      border-color: var(--fpvx-accent);
      box-shadow: 0 0 20px ${rgba(t.accent, 0.15)};
    }
    .fpvx-btn-square:active {
      transform: scale(0.95);
    }
    .fpvx-btn-square.active {
      color: var(--fpvx-accent);
      background: ${rgba(t.accent, 0.12)};
      border-color: var(--fpvx-accent);
      box-shadow: 0 0 25px ${rgba(t.accent, 0.2)};
    }
    .fpvx-btn-square::after {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, var(--fpvx-accent) 0%, transparent 70%);
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }
    .fpvx-btn-square:active::after {
      opacity: 0.3;
      animation: rippleOut 0.5s ease forwards;
    }
    @keyframes rippleOut {
      0% { transform: scale(0.5); opacity: 0.4; }
      100% { transform: scale(2); opacity: 0; }
    }
    .fpvx-btn-action {
      width: 100%;
      height: 34px;
      background: linear-gradient(135deg, var(--fpvx-accent), var(--fpvx-accent2));
      border: none;
      border-radius: 8px;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px ${rgba(t.accent, 0.3)};
      transition: all 0.3s ease;
      font-size: 12px;
      letter-spacing: 0.04em;
      position: relative;
      overflow: hidden;
    }
    .fpvx-btn-action:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 25px ${rgba(t.accent, 0.5)};
    }
    .fpvx-btn-action:active {
      transform: scale(0.97);
    }
    .fpvx-btn-action::after {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, rgba(255,255,255,0.2) 0%, transparent 70%);
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }
    .fpvx-btn-action:active::after {
      opacity: 1;
      animation: rippleOut 0.5s ease forwards;
    }
    .fpvx-btn-action.auto-play-btn {
      background: linear-gradient(135deg, var(--fpvx-accent), var(--fpvx-accent2));
    }
    .fpvx-btn-action.auto-play-btn.playing {
      background: linear-gradient(135deg, #ef4444, #dc2626);
    }

    #fpvx-settings {
      position: absolute;
      inset: 0;
      background: rgba(6,9,22,0.92);
      backdrop-filter: blur(20px);
      z-index: 10;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.96);
      transition: opacity 0.4s ease, transform 0.4s ease;
    }
    #fpvx-settings.open {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    .fpvx-setting-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: rgba(255,255,255,0.02);
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.05);
      transition: all 0.4s ease;
    }
    .fpvx-setting-item:hover {
      background: rgba(255,255,255,0.04);
    }
    .fpvx-setting-title {
      font-size: 11px;
      font-weight: 700;
      color: #fff;
    }
    .fpvx-setting-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .fpvx-swatch {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      transition: all 0.4s ease;
      position: relative;
    }
    .fpvx-swatch:hover { transform: scale(1.15); }
    .fpvx-swatch.active { border-color: #fff; box-shadow: 0 0 12px var(--fpvx-accent); }
    .fpvx-swatch::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(255,255,255,0.2) 0%, transparent 50%);
      pointer-events: none;
    }

    .fpvx-toggle {
      width: 40px;
      height: 20px;
      background: #4e5058;
      border-radius: 10px;
      cursor: pointer;
      position: relative;
      transition: background 0.35s, box-shadow 0.35s;
      flex-shrink: 0;
    }
    .fpvx-toggle.on { background: var(--fpvx-accent); box-shadow: 0 0 12px var(--fpvx-glow); }
    .fpvx-toggle::before {
      content: '';
      position: absolute;
      width: 16px;
      height: 16px;
      background: #fff;
      border-radius: 50%;
      top: 2px;
      left: 2px;
      transition: transform 0.35s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
    }
    .fpvx-toggle.on::before { transform: translateX(20px); }
    .fpvx-toggle:active::before { width: 18px; }

    #fpvx-wrap.fpvx-minimized { height: 44px; width: 260px; }
    #fpvx-wrap.fpvx-minimized .fpvx-tabs,
    #fpvx-wrap.fpvx-minimized .fpvx-shell,
    #fpvx-wrap.fpvx-minimized #fpvx-gear-btn { display: none; }

    #fpvx-scanner-overlay {
      position: absolute;
      inset: 0;
      background: rgba(6,9,22,0.85);
      backdrop-filter: blur(4px);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      z-index: 5;
      animation: overlayFadeIn 0.4s ease;
    }
    @keyframes overlayFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .fpvx-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: var(--fpvx-accent);
      border-radius: 50%;
      animation: fpvx-spin 0.8s linear infinite;
    }
    @keyframes fpvx-spin { to { transform: rotate(360deg); } }
    .fpvx-scanner-status {
      font-size: 16px;
      margin-top: 10px;
      letter-spacing: 0.2em;
      font-weight: 800;
      color: var(--fpvx-accent);
      animation: statusPulse 1.5s ease-in-out infinite;
    }
    .fpvx-scanner-status .dot {
      display: inline-block;
      animation: dotBounce 1.4s ease-in-out infinite;
    }
    .fpvx-scanner-status .dot:nth-child(1) { animation-delay: 0s; }
    .fpvx-scanner-status .dot:nth-child(2) { animation-delay: 0.2s; }
    .fpvx-scanner-status .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes dotBounce {
      0%, 80%, 100% { transform: scale(0.8); opacity: 0.3; }
      40% { transform: scale(1.2); opacity: 1; }
    }
    @keyframes statusPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    #fpvx-unrig-progress {
      position: absolute;
      inset: 0;
      background: rgba(6,9,22,0.92);
      backdrop-filter: blur(8px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 6;
      border-radius: 20px;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.95);
      transition: opacity 0.3s ease, transform 0.3s ease;
    }
    #fpvx-unrig-progress.show {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    .fpvx-unrig-bar {
      display: flex;
      gap: 6px;
      margin: 16px 0;
    }
    .fpvx-unrig-seg {
      width: 24px;
      height: 6px;
      border-radius: 3px;
      background: rgba(255,255,255,0.08);
      transition: background 0.4s ease, box-shadow 0.4s ease;
    }
    .fpvx-unrig-seg.done {
      background: var(--fpvx-accent);
      box-shadow: 0 0 10px var(--fpvx-accent);
    }
    .fpvx-unrig-status-text {
      font-size: 12px;
      font-weight: 600;
      color: #a0aec0;
      transition: color 0.4s;
    }

    #fpvx-towers-autoplay-btn {
      width: 100%;
      height: 30px;
      background: linear-gradient(135deg, var(--fpvx-accent), var(--fpvx-accent2));
      border: none;
      border-radius: 8px;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
      font-size: 11px;
      transition: all 0.3s ease;
      box-shadow: 0 4px 12px ${rgba(t.accent, 0.3)};
      margin-top: 4px;
      position: relative;
      overflow: hidden;
    }
    #fpvx-towers-autoplay-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 20px ${rgba(t.accent, 0.4)}; }
    #fpvx-towers-autoplay-btn:active { transform: scale(0.97); }
    #fpvx-towers-autoplay-btn.playing {
      background: linear-gradient(135deg, #ef4444, #dc2626);
    }
    #fpvx-towers-autoplay-btn::after {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, rgba(255,255,255,0.15) 0%, transparent 70%);
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
    }
       #fpvx-towers-autoplay-btn:active::after {
      opacity: 1;
      animation: rippleOut 0.5s ease forwards;
    }

    #fpvx-tab-loader {
      position: absolute;
      inset: 0;
      background: rgba(10, 14, 26, 0.85);
      backdrop-filter: blur(8px);
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 50;
      border-radius: 20px;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    #fpvx-tab-loader.active {
      display: flex;
      opacity: 1;
    }
    #fpvx-tab-loader .fpvx-loader-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: var(--fpvx-accent);
      border-radius: 50%;
      animation: fpvx-spin 0.8s linear infinite;
    }
    #fpvx-tab-loader .fpvx-loader-text {
      font-size: 12px;
      color: #a0aec0;
      margin-top: 12px;
      font-weight: 600;
      letter-spacing: 0.1em;
      opacity: 0.7;
    }
    #fpvx-tab-loader .fpvx-loader-dots {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    #fpvx-tab-loader .fpvx-loader-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--fpvx-accent);
      display: inline-block;
      animation: dotBounce 1.4s ease-in-out infinite;
      opacity: 0.3;
    }
    #fpvx-tab-loader .fpvx-loader-dots span:nth-child(1) { animation-delay: 0s; }
    #fpvx-tab-loader .fpvx-loader-dots span:nth-child(2) { animation-delay: 0.2s; }
    #fpvx-tab-loader .fpvx-loader-dots span:nth-child(3) { animation-delay: 0.4s; }

    .fpvx-shell.crash-mode {
      grid-template-columns: 1fr;
      padding: 10px 14px 12px;
    }
    .fpvx-shell.crash-mode > .fpvx-col,
    .fpvx-shell.crash-mode > .fpvx-board-wrapper {
      display: none !important;
    }
    #fpvx-crash-content-shell {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
      min-width: 0;
      min-height: 0;
    }
    .fpvx-crash-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .fpvx-crash-stats .fpvx-card {
      min-height: 52px;
      padding: 8px 10px;
    }
    .fpvx-crash-stats .fpvx-card-val {
      font-size: 13px;
      line-height: 1.2;
      word-break: keep-all;
    }
    .fpvx-crash-signal {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.04em;
      white-space: nowrap;
      background: rgba(255,255,255,0.06);
      color: #a0aec0;
    }
    .fpvx-crash-hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 14px 12px;
      border-radius: 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      min-height: 96px;
    }
    .fpvx-crash-hero-lbl {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #718096;
      text-transform: uppercase;
    }
    .fpvx-crash-hero-val {
      font-size: 34px;
      line-height: 1;
      font-weight: 800;
      font-family: 'JetBrains Mono', monospace;
      color: var(--fpvx-accent);
      text-shadow: 0 0 24px ${rgba(t.accent, 0.25)};
      white-space: nowrap;
    }
    .fpvx-crash-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .fpvx-crash-metric {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 10px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05);
      min-height: 58px;
      text-align: center;
    }
    .fpvx-crash-metric-lbl {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: #718096;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .fpvx-crash-metric-val {
      font-size: 16px;
      line-height: 1;
      font-weight: 800;
      font-family: 'JetBrains Mono', monospace;
      white-space: nowrap;
    }
    .fpvx-crash-message {
      min-height: 34px;
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.05);
      font-size: 11px;
      line-height: 1.35;
      font-weight: 600;
      color: #a0aec0;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .fpvx-crash-footer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: auto;
    }
    .fpvx-crash-footer .fpvx-card {
      min-height: 52px;
      padding: 8px 10px;
    }
    .fpvx-crash-actions {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: 1.2fr 1fr 1fr;
      gap: 8px;
    }
    .fpvx-crash-actions .fpvx-btn-action,
    .fpvx-crash-actions .fpvx-btn-square {
      height: 34px;
      margin-top: 0;
    }
    #crash-auto-btn.active {
      background: rgba(52,211,153,0.18);
      border-color: rgba(52,211,153,0.45);
      color: #34d399;
    }

    .fpvx-shell.blackjack-mode {
      grid-template-columns: 1fr;
      padding: 10px 14px 12px;
      flex: 0;
      height: auto;
      align-content: start;
    }
    .fpvx-shell.blackjack-mode > .fpvx-col,
    .fpvx-shell.blackjack-mode > .fpvx-board-wrapper {
      display: none !important;
    }
    #fpvx-bj-content-shell {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      min-width: 0;
      min-height: 0;
    }
    .bj-btn-toggled { filter: brightness(1.25); box-shadow: 0 0 12px rgba(33, 150, 243, 0.6) !important; }
    .bj-btn-anim:active { transform: scale(0.95); }
    .bj-running-btn {
      background: #00E700 !important;
      border: none !important;
      color: #1A1F40 !important;
      box-shadow: 0 0 20px rgba(0, 231, 0, 0.4) !important;
    }
    @keyframes fpvxRankShimmer {
      0% { background-position: 0% 50%; filter: brightness(1) saturate(1.2); }
      25% { filter: brightness(1.3) saturate(1.5); }
      50% { background-position: 100% 50%; filter: brightness(1.1) saturate(1.3); }
      75% { filter: brightness(1.4) saturate(1.6); }
      100% { background-position: 0% 50%; filter: brightness(1) saturate(1.2); }
    }
    @keyframes fpvxLordGlow {
      0% { text-shadow: 0 0 8px var(--fpvx-accent), 0 0 20px var(--fpvx-accent); }
      50% { text-shadow: 0 0 14px var(--fpvx-accent), 0 0 35px var(--fpvx-accent2); }
      100% { text-shadow: 0 0 8px var(--fpvx-accent), 0 0 20px var(--fpvx-accent); }
    }
    #val-rank {
      display: inline-block;
    }
  `;
}
applyCSS();

const overlay = document.createElement('div');
overlay.id = 'fpvx-license-overlay';
overlay.innerHTML = `
  <div id="fpvx-snowfall"></div>
  <div class="fpvx-ov-card">
    <h2>FPVX.LOL PREDICTOR</h2>
    <p>Elevate Your Gambling Experience</p>
    <input class="fpvx-ov-input" id="fpvx-ov-key-input" type="text" placeholder="ENTER LICENSE ACCESS KEY" autocomplete="off"/>
    <button class="fpvx-ov-btn" id="fpvx-ov-login-btn">ACCESS SCRIPT</button>
    <div class="fpvx-ov-error" id="fpvx-ov-error"></div>
  </div>
`;
document.body.appendChild(overlay);

function createSnowfall() {
  const container = document.getElementById('fpvx-snowfall');
  if (!container) return;
  const count = 80;
  for (let i = 0; i < count; i++) {
    const flake = document.createElement('div');
    flake.className = 'fpvx-snowflake';
    const size = Math.random() * 4 + 2;
    flake.style.width = size + 'px';
    flake.style.height = size + 'px';
    flake.style.left = Math.random() * 100 + '%';
    flake.style.animationDuration = Math.random() * 10 + 5 + 's';
    flake.style.animationDelay = Math.random() * 5 + 's';
    flake.style.opacity = 0;
    container.appendChild(flake);
  }
}
createSnowfall();

const wrap = document.createElement('div');
wrap.id = 'fpvx-wrap';
wrap.innerHTML = `
  <div class="fpvx-middle-glow"></div>
  <div class="fpvx-top" id="fpvx-top-handle">
    <div class="fpvx-title">// FPVX.LOL //</div>
    <div class="fpvx-top-actions">
      <button class="fpvx-mini-btn" id="fpvx-gear-btn">⚙</button>
      <button class="fpvx-mini-btn" id="fpvx-min-btn">—</button>
    </div>
  </div>
  <div class="fpvx-tabs">
  <button class="fpvx-tab active" id="tab-mines">MINES</button>
  <button class="fpvx-tab" id="tab-towers">TOWERS</button>
  <button class="fpvx-tab" id="tab-crash">CRASH</button>
  <button class="fpvx-tab" id="tab-slide">SLIDE</button>
  <button class="fpvx-tab" id="tab-blackjack">BLACKJACK</button>
</div>
  <div class="fpvx-shell">
    <div class="fpvx-col">
      <div class="fpvx-card"><span class="fpvx-card-lbl">WELCOME</span><span class="fpvx-card-val" id="val-status" style="font-size:11px;color:var(--fpvx-accent);">${discordConnected ? '@' + discordUsername : '<button id="fpvx-discord-connect" style="background:none;border:1px solid rgba(88,101,242,0.5);color:#5865F2;font-size:9px;font-weight:700;cursor:pointer;padding:3px 8px;border-radius:4px;font-family:inherit;">Connect Discord</button>'}</span></div>
      <div class="fpvx-card"><span class="fpvx-card-lbl">RANK</span><span class="fpvx-card-val" id="val-rank" style="font-size:12px;font-weight:900;letter-spacing:0.5px;${discordRankGradient ? 'background:' + discordRankGradient + ';background-size:200% 200%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:' + (discordRankIsLord ? 'fpvxRankShimmer 2s ease infinite,fpvxLordGlow 2s ease-in-out infinite' : 'fpvxRankShimmer 2.5s ease infinite') + ';' : 'color:#718096;'}">${discordRank || '\u2014'}</span></div>
      <div class="fpvx-card" id="card-license-expiry"><span class="fpvx-card-lbl">LICENSE</span><span class="fpvx-card-val" id="val-license-expiry">—</span></div>
      <div class="fpvx-card"><span class="fpvx-card-lbl">PROBABILITY</span><span class="fpvx-card-val" id="val-conf">0.0%</span></div>
    </div>
    <div class="fpvx-board-wrapper">
      <div class="fpvx-board">
        <div class="fpvx-grid mines-grid" id="fpvx-matrix-grid"></div>
      </div>
      <div id="fpvx-scanner-overlay">
        <div class="fpvx-spinner"></div>
        <div class="fpvx-scanner-status" id="scanner-status">
          <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
        </div>
      </div>
      <div id="fpvx-unrig-progress">
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:6px;">UNRIGGING</div>
        <div class="fpvx-unrig-bar" id="fpvx-unrig-bar"></div>
        <div class="fpvx-unrig-status-text" id="fpvx-unrig-status-text">Initializing...</div>
      </div>
    </div>
    <div class="fpvx-col">
      <div class="fpvx-card"><span class="fpvx-card-lbl">BALANCE</span><span class="fpvx-card-val" id="val-balance">0.00</span></div>
      <div class="fpvx-controls">
        <button class="fpvx-btn-action auto-play-btn" id="btn-auto-play">▶ Auto Play</button>
        <button class="fpvx-btn-action" id="btn-unrig">⟲ Unrig</button>
        <button class="fpvx-btn-action" id="btn-predict">PREDICT</button>
        <button class="fpvx-btn-action auto-play-btn" id="btn-slide-auto" style="display:none;">▶ Auto Slide</button>
        <div id="fpvx-towers-autoplay-container"></div>
      </div>
    </div>
  </div>
  <div id="fpvx-tab-loader">
    <div class="fpvx-loader-spinner"></div>
    <div class="fpvx-loader-text">LOADING</div>
    <div class="fpvx-loader-dots">
      <span></span><span></span><span></span>
    </div>
  </div>
  <div id="fpvx-settings">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h3 style="margin:0;font-weight:800;font-size:16px;">SYSTEM CONFIGURATION</h3>
      <button class="fpvx-mini-btn" id="fpvx-close-settings">✕</button>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">Mines Safe Tiles</span>
      <input type="range" min="1" max="8" value="${safe}" id="cfg-safe-slider" style="width:100%;accent-color:var(--fpvx-accent);">
      <span id="cfg-safe-txt" style="font-size:11px;text-align:right;font-weight:700;">${safe} Tiles</span>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">Towers Safe Rows</span>
      <input type="range" min="2" max="8" value="${towersTargetRows}" id="cfg-towers-slider" style="width:100%;accent-color:var(--fpvx-accent);">
      <span id="cfg-towers-txt" style="font-size:11px;text-align:right;font-weight:700;">${towersTargetRows} Rows</span>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">AI Engine</span>
      <div style="display:flex;gap:5px;">
        <select id="cfg-ai-prov" style="background:#1a202c;color:#fff;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;font-size:11px;flex:1;">
          <option value="openai" ${aiProvider==='openai'?'selected':''}>OpenAI</option>
          <option value="deepseek" ${aiProvider==='deepseek'?'selected':''}>DeepSeek</option>
          <option value="anthropic" ${aiProvider==='anthropic'?'selected':''}>Claude</option>
        </select>
        <input type="password" id="cfg-ai-key" value="${aiApiKey}" placeholder="API Key" style="background:#1a202c;color:#fff;border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;font-size:11px;flex:1.5;">
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:4px;">
        <label style="font-size:10px;color:#a0aec0;">Enable AI</label>
        <input type="checkbox" id="cfg-ai-toggle" ${aiEnabled?'checked':''} style="accent-color:var(--fpvx-accent);">
      </div>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">Themes</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;" id="theme-swatches"></div>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">Streamer Mode</span>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:11px;color:#a0aec0;">Hide sensitive info</span>
        <div class="fpvx-toggle ${streamerMode ? 'on' : ''}" id="fpvx-streamer-toggle"></div>
      </div>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">Discord</span>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span id="settings-discord-status" style="font-size:11px;font-weight:700;${discordConnected ? 'color:var(--fpvx-accent);' : 'color:#a0aec0;'}">${discordConnected ? '@' + discordUsername : 'Not connected'}</span>
        <div style="display:flex;gap:6px;">
          ${discordConnected
            ? '<button id="btn-discord-reconnect" style="background:rgba(88,101,242,0.15);border:1px solid #5865F2;border-radius:6px;padding:3px 10px;color:#5865F2;font-weight:700;font-size:10px;cursor:pointer;transition:all 0.3s;">Reconnect</button><button id="btn-discord-disconnect" style="background:rgba(244,63,94,0.15);border:1px solid #f43f5e;border-radius:6px;padding:3px 10px;color:#f43f5e;font-weight:700;font-size:10px;cursor:pointer;transition:all 0.3s;">Disconnect</button>'
            : '<button id="btn-discord-connect-settings" style="background:rgba(88,101,242,0.15);border:1px solid #5865F2;border-radius:6px;padding:3px 10px;color:#5865F2;font-weight:700;font-size:10px;cursor:pointer;transition:all 0.3s;">Connect</button>'
          }
        </div>
      </div>
    </div>
    <div class="fpvx-setting-item">
      <span class="fpvx-setting-title">License</span>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span id="settings-license-status" style="font-size:11px;font-weight:700;color:#a0aec0;">Not active</span>
        <button id="btn-unredeem" style="background:rgba(244,63,94,0.15);border:1px solid #f43f5e;border-radius:6px;padding:3px 12px;color:#f43f5e;font-weight:700;font-size:10px;cursor:pointer;transition:all 0.3s;">Unredeem</button>
      </div>
    </div>
  </div>
`;
document.body.appendChild(wrap);

const matrixGrid = document.getElementById('fpvx-matrix-grid');
const scannerOverlay = document.getElementById('fpvx-scanner-overlay');
const scannerStatus = document.getElementById('scanner-status');
const valConf = document.getElementById('val-conf');
const valLicenseExpiry = document.getElementById('val-license-expiry');
const valBalance = document.getElementById('val-balance');
const settingsPanel = document.getElementById('fpvx-settings');
const unrigProgress = document.getElementById('fpvx-unrig-progress');
const unrigBar = document.getElementById('fpvx-unrig-bar');
const unrigStatusText = document.getElementById('fpvx-unrig-status-text');
const towersAutoplayContainer = document.getElementById('fpvx-towers-autoplay-container');

let balanceAnimFrame = null;
function animateBalance(newBalance) {
  const el = valBalance;
  if (!el) return;
  if (balanceAnimFrame) cancelAnimationFrame(balanceAnimFrame);
  const startVal = parseFloat(el.textContent.replace(/,/g,'')) || 0;
  const endVal = newBalance;
  if (startVal === endVal) return;
  const duration = 500;
  const startTime = performance.now();
  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = startVal + (endVal - startVal) * eased;
    el.textContent = formatNumber(current, 2);
    if (progress < 1) {
      balanceAnimFrame = requestAnimationFrame(step);
    } else {
      el.textContent = formatNumber(endVal, 2);
    }
  }
  balanceAnimFrame = requestAnimationFrame(step);
}

valBalance.textContent = flipcoins > 0 ? formatNumber(flipcoins, 2) : '0.00';

function rebuildGrid() {
  matrixGrid.innerHTML = '';
  if (currentTab === 'mines') {
    matrixGrid.className = 'fpvx-grid mines-grid';
    for (let i = 0; i < 25; i++) {
      const tile = document.createElement('div');
      tile.className = 'fpvx-tile';
      tile.dataset.idx = i;
      tile.style.animationDelay = (i * 20) + 'ms';
      const symbol = document.createElement('div');
      symbol.className = 'fpvx-tile-safe-symbol';
      const img = document.createElement('img');
      img.src = 'https://i.imgur.com/W22hlEk.png';
      img.style.cssText = 'width:28px;height:28px;object-fit:contain;filter:drop-shadow(0 0 10px var(--fpvx-accent));';
      symbol.appendChild(img);
      tile.appendChild(symbol);
      matrixGrid.appendChild(tile);
    }
  } else if (currentTab === 'towers') {
    matrixGrid.className = 'fpvx-grid towers-grid';
    for (let i = 0; i < 24; i++) {
      const tile = document.createElement('div');
      tile.className = 'fpvx-tile';
      tile.dataset.idx = i;
      tile.style.animationDelay = (i * 25) + 'ms';
      const symbol = document.createElement('div');
      symbol.className = 'fpvx-tile-safe-symbol';
      const img = document.createElement('img');
      img.src = 'https://i.imgur.com/W22hlEk.png';
      img.style.cssText = 'width:28px;height:28px;object-fit:contain;filter:drop-shadow(0 0 10px var(--fpvx-accent));';
      symbol.appendChild(img);
      tile.appendChild(symbol);
      matrixGrid.appendChild(tile);
    }
  } else if (currentTab === 'slide') {
    matrixGrid.className = 'fpvx-grid slide-grid';
    const colors = ['Yellow', 'Red', 'Purple'];
    const multipliers = ['14x', '2x', '2x'];
    const colorHex = ['#f59e0b', '#ef4444', '#a855f7'];
    const colorBg = ['rgba(245,158,11,0.12)', 'rgba(239,68,68,0.12)', 'rgba(168,85,247,0.12)'];
    for (let i = 0; i < 3; i++) {
      const tile = document.createElement('div');
      tile.className = 'fpvx-tile';
      tile.dataset.idx = i;
      tile.dataset.color = colors[i].toLowerCase();
      tile.style.animationDelay = (i * 25) + 'ms';
      tile.style.display = 'flex';
      tile.style.flexDirection = 'row';
      tile.style.alignItems = 'center';
      tile.style.justifyContent = 'space-between';
      tile.style.gap = '8px';
      tile.style.padding = '8px 12px';
      tile.style.borderRadius = '8px';
      tile.style.background = colorBg[i];
      tile.style.border = '1px solid ' + colorHex[i] + '33';

      const leftGroup = document.createElement('div');
      leftGroup.style.cssText = 'display:flex;flex-direction:column;gap:1px;';

      const label = document.createElement('span');
      label.textContent = colors[i];
      label.style.fontSize = '12px';
      label.style.fontWeight = '800';
      label.style.color = colorHex[i];

      const mult = document.createElement('span');
      mult.textContent = multipliers[i];
      mult.style.fontSize = '10px';
      mult.style.opacity = '0.6';
      mult.style.color = '#fff';

      leftGroup.appendChild(label);
      leftGroup.appendChild(mult);

      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'flex:1;max-width:80px;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;margin:0 8px;';
      const barFill = document.createElement('div');
      barFill.className = 'slide-bar-fill';
      barFill.style.cssText = 'height:100%;width:0%;background:' + colorHex[i] + ';border-radius:3px;transition:width 0.4s ease;';
      barWrap.appendChild(barFill);

      const pct = document.createElement('span');
      pct.className = 'slide-pct';
      pct.style.cssText = 'font-size:13px;font-weight:800;color:' + colorHex[i] + ';min-width:36px;text-align:right;font-family:JetBrains Mono,monospace;';
      pct.textContent = '0%';

      tile.appendChild(leftGroup);
      tile.appendChild(barWrap);
      tile.appendChild(pct);
      matrixGrid.appendChild(tile);
    }
  }
}

rebuildGrid();
valConf.textContent = minesConfidence + '%';

function buildSwatches() {
  const container = document.getElementById('theme-swatches');
  container.innerHTML = '';
  THEMES.forEach(th => {
    const sw = document.createElement('div');
    sw.className = 'fpvx-swatch' + (th.id === themeId ? ' active' : '');
    sw.style.background = th.preview;
    sw.dataset.id = th.id;
    sw.addEventListener('click', () => {
      themeId = th.id;
      GM_setValue('fpvx_theme', themeId);
      applyCSS();
      document.querySelectorAll('.fpvx-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
    });
    container.appendChild(sw);
  });
}
buildSwatches();

function updateLicenseUI() {
  const statusEl = document.getElementById('settings-license-status');
  if (licenseStatus === 'verified') {
    statusEl.textContent = `Active — ${licenseExpiry}`;
    statusEl.style.color = 'var(--fpvx-accent)';
    document.getElementById('btn-predict').disabled = false;
    document.getElementById('btn-predict').style.opacity = '1';
  } else {
    statusEl.textContent = 'Not active';
    statusEl.style.color = 'var(--fpvx-accent2)';
    document.getElementById('btn-predict').disabled = true;
    document.getElementById('btn-predict').style.opacity = '0.4';
  }
  updateLicenseExpiryDisplay();
}

function updateLicenseExpiryDisplay() {
  if (licenseStatus === 'verified' && licenseExpiry !== 'N/A' && licenseExpiry !== 'Lifetime') {
    const expiryDate = new Date(licenseExpiry);
    if (!isNaN(expiryDate)) {
      const now = new Date();
      const diffMs = expiryDate - now;
      if (diffMs > 0) {
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays > 30) {
          const months = Math.floor(diffDays / 30);
          const days = diffDays % 30;
          valLicenseExpiry.textContent = `${months}m ${days}d`;
        } else if (diffDays > 1) {
          valLicenseExpiry.textContent = `${diffDays} days`;
        } else if (diffDays === 1) {
          valLicenseExpiry.textContent = '1 day';
        } else {
          const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
          valLicenseExpiry.textContent = `${diffHours}h`;
        }
      } else {
        valLicenseExpiry.textContent = 'Expired';
        valLicenseExpiry.style.color = 'var(--fpvx-accent2)';
      }
    } else {
      valLicenseExpiry.textContent = licenseExpiry;
    }
  } else if (licenseStatus === 'verified' && licenseExpiry === 'Lifetime') {
    valLicenseExpiry.textContent = 'Lifetime';
    valLicenseExpiry.style.color = 'var(--fpvx-accent)';
  } else {
    valLicenseExpiry.textContent = '—';
  }
}

let isDragging = false, dragX = 0, dragY = 0, savedPos = GM_getValue('fpvx_pos', null);
if (savedPos && typeof savedPos.left === 'number') {
  wrap.style.left = savedPos.left + 'px';
  wrap.style.top = savedPos.top + 'px';
}

const topHandle = document.getElementById('fpvx-top-handle');
topHandle.addEventListener('mousedown', e => {
  if (e.target.closest('button')) return;
  isDragging = true;
  const rect = wrap.getBoundingClientRect();
  dragX = e.clientX - rect.left;
  dragY = e.clientY - rect.top;
});
document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  wrap.style.left = (e.clientX - dragX) + 'px';
  wrap.style.top = (e.clientY - dragY) + 'px';
});
document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    const rect = wrap.getBoundingClientRect();
    GM_setValue('fpvx_pos', { left: Math.round(rect.left), top: Math.round(rect.top) });
  }
});

document.getElementById('fpvx-min-btn').addEventListener('click', () => {
  wrap.classList.toggle('fpvx-minimized');
  document.getElementById('fpvx-min-btn').textContent = wrap.classList.contains('fpvx-minimized') ? '□' : '—';
});

document.getElementById('fpvx-gear-btn').addEventListener('click', () => {
  if (wrap.classList.contains('fpvx-minimized')) return;
  settingsPanel.classList.toggle('open');
});
document.getElementById('fpvx-close-settings').addEventListener('click', () => {
  settingsPanel.classList.remove('open');
});

document.getElementById('tab-mines').addEventListener('click', () => switchTab('mines'));
document.getElementById('tab-towers').addEventListener('click', () => switchTab('towers'));
document.getElementById('tab-crash').addEventListener('click', () => switchTab('crash'));
document.getElementById('tab-slide').addEventListener('click', () => switchTab('slide'));
document.getElementById('tab-blackjack').addEventListener('click', () => switchTab('blackjack'));

let crashScriptLoaded = false;
let crashCleanup = null;
let buildCrashUIInShell = null;

function restoreShellFromCrash() {
  const shell = document.querySelector('.fpvx-shell');
  if (!shell) return;
  shell.classList.remove('crash-mode');
  const crashContent = document.getElementById('fpvx-crash-content-shell');
  if (crashContent) crashContent.remove();
  const boardWrapper = shell.querySelector('.fpvx-board-wrapper');
  if (boardWrapper) boardWrapper.style.display = '';
  shell.querySelectorAll('.fpvx-col').forEach(col => {
    col.style.display = '';
  });
}

function restoreShellFromBlackjack() {
  const shell = document.querySelector('.fpvx-shell');
  if (!shell) return;
  shell.classList.remove('blackjack-mode');
  const bjContent = document.getElementById('fpvx-bj-content-shell');
  if (bjContent) bjContent.remove();
  const boardWrapper = shell.querySelector('.fpvx-board-wrapper');
  if (boardWrapper) boardWrapper.style.display = '';
  shell.querySelectorAll('.fpvx-col').forEach(col => {
    col.style.display = '';
  });
}

function buildBlackjackUIInShell() {
  const existing = document.getElementById('fpvx-bj-content-shell');
  if (existing) existing.remove();
  const shell = document.querySelector('.fpvx-shell');
  if (!shell) return;
  shell.classList.add('blackjack-mode');
  const bjC = document.createElement('div');
  bjC.id = 'fpvx-bj-content-shell';
  bjC.style.cssText = 'grid-column:1 / -1;display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;';
  bjC.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);text-align:center;">
        <div style="font-size:8px;font-weight:800;color:#718096;text-transform:uppercase;margin-bottom:6px;letter-spacing:1px;">Dealer</div>
        <div id="fpvx-bj-scan-dealer" style="font-size:20px;font-weight:900;color:#ef4444;">-</div>
      </div>
      <div style="background:rgba(255,255,255,0.03);padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);text-align:center;">
        <div style="font-size:8px;font-weight:800;color:#718096;text-transform:uppercase;margin-bottom:6px;letter-spacing:1px;">Player</div>
        <div id="fpvx-bj-scan-player" style="font-size:20px;font-weight:900;color:#22c55e;">-</div>
      </div>
      <div id="fpvx-bj-move-box" style="background:linear-gradient(135deg, rgba(26,31,64,0.8), rgba(45,52,94,0.4));padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);text-align:center;transition:transform 0.2s ease,box-shadow 0.2s ease;">
        <div style="font-size:8px;font-weight:800;color:#718096;text-transform:uppercase;margin-bottom:6px;letter-spacing:1px;">Move</div>
        <div id="fpvx-bj-auto-move" style="font-size:22px;font-weight:900;color:#fff;letter-spacing:1px;">WAIT</div>
      </div>
    </div>
    <button id="fpvx-bj-btn-autoplay" class="bj-btn-anim" style="width:100%;padding:14px;font-size:14px;letter-spacing:1px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;font-weight:700;cursor:pointer;transition:all 0.2s;">START AUTO-PLAY</button>
  `;
  shell.appendChild(bjC);
  bjWireEvents();
  bjRunScrapeAndPredict();
}

function bjWireEvents() {
  const btnAutoplay = bjQs('#fpvx-bj-btn-autoplay');
  if (btnAutoplay) btnAutoplay.addEventListener('click', function () {
    bjAutoPlayEnabled = !bjAutoPlayEnabled;
    if (bjAutoPlayEnabled) {
      this.classList.add('bj-running-btn');
      this.textContent = 'RUNNING AUTO-PLAY';
      bjLastAutoBetTime = 0;
      clearInterval(bjAutoPlayInterval);
      bjAutoPlayInterval = setInterval(() => { if (bjAutoPlayEnabled) bjAttemptAutoBet(); }, 800);
    } else {
      bjStopAutoPlayCompletely();
    }
  });

  const btnResetCount = bjQs('#fpvx-bj-btn-reset-count');
  if (btnResetCount) btnResetCount.addEventListener('click', () => {
    bjResetCount();
  });
}

function loadCrashPredictor() {
  if (crashScriptLoaded) return;
  crashScriptLoaded = true;

  const DEBUG = false;
  const lj=(k,d)=>{try{const v=GM_getValue(k,null);return v?JSON.parse(v):d;}catch{return d;}};
  const sj=(k,v)=>{try{GM_setValue(k,JSON.stringify(v));}catch{}};
  let CDB=lj('cdb11',[]);
  let CFG=Object.assign({apiKey:'sk-2899781225714c619fd19b8df2d83182',apiProvider:'deepseek',apiModel:'deepseek-chat',apiEnabled:true},lj('cfg11',{}));
  const pushCDB=g=>{CDB.push(g);if(CDB.length>30000)CDB=CDB.slice(-30000);try{sj('cdb11',CDB);}catch{};};
  const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
  const std=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);};
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const kelly=(w,b)=>clamp((w*(b+1)-1)/b,0,1);
  const poissonGe=(lam,k)=>{let c=0,t=Math.exp(-lam);for(let i=0;i<k;i++){c+=t;t*=lam/(i+1);}return 1-c;};
  const normMult=raw=>{let n=Number(raw);if(!Number.isFinite(n))return null;if(n>=100)n=n/100;if(!(n>=1)||n>=1e5)return null;return Math.round(n*100)/100;};
  const bucket=v=>v<1.2?0:v<1.5?1:v<2?2:v<5?3:v<10?4:5;
  const autocorr=(a,lag=1)=>{if(a.length<lag+2)return 0;const m=mean(a);let n2=0,d2=0;for(let i=0;i<a.length-lag;i++)n2+=(a[i]-m)*(a[i+lag]-m);a.forEach(v=>{d2+=(v-m)**2;});return d2?n2/d2:0;};
  const ema2=(a,alpha=0.3)=>{if(!a.length)return[];const o=[a[0]];for(let i=1;i<a.length;i++)o.push(alpha*a[i]+(1-alpha)*o[i-1]);return o;};
  const gapStats=(all,thresh)=>{const gs=[];let li=-1;all.forEach((m,i)=>{if(m>=thresh){if(li>=0)gs.push(i-li);li=i;}});const since=li>=0?all.length-1-li:all.length;const fb=thresh<=1.2?8:thresh<=1.5?4:thresh<=3?8:thresh<=5?20:thresh<=10?60:200;return{gaps:gs,since,avg:gs.length>=3?mean(gs):fb,count:all.filter(m=>m>=thresh).length};};
  const SKEYS=['earlyHot','earlyCold','streak3','streak5bounce','instantCluster','patternEarly','patternSafe','acPersist','acReversal','varCollapse','emaDown','emaUp','moonVeryOverdue','moonOverdue','moonNonRun','instHot','instCold','instAfterMoon','instAfterBigSafe','instStreak2','instPostMoonWindow','long3xOverdue','long3xVeryOverdue','long5xOverdue','long5xVeryOverdue','long10xOverdue','long20xOverdue','earlyBounce','earlyBounce3','varianceExpand','longColdRecent','longAfterInstCluster','markovInst','markovEarly','markovLong','markovMoon','chiDrift','lagAC2','acHighLow','acLowHigh','moodHot','moodCold'];
  const _Sls={get:(k,d)=>{try{return JSON.parse(localStorage.getItem(k)??'null')??d;}catch{return d;}},set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}}};
  const Brain={
    _k:'__cx_brain',_d:null,
    _ld(){if(!this._d){this._d=_Sls.get(this._k,null);if(!this._d||this._d.v!==4){const w={};SKEYS.forEach(k=>{w[k]={fires:0,hits:0,w:1.0};});const bins={};for(let i=-15;i<=15;i++)bins[String(i)]={plays:0,wins:0};const markov={};for(let i=0;i<6;i++){markov[i]={};for(let j=0;j<6;j++)markov[i][j]=0;}this._d={w,bins,regime:{eb:0,mb:0},total:0,trainedTo:0,markov,v:4};}}return this._d;},
    _sv(){_Sls.set(this._k,this._d);},
    learn(keys,score,cashout,actual){const d=this._ld();const hit=actual>=cashout;d.total++;const alpha=0.07;for(const k of keys){if(!d.w[k])d.w[k]={fires:0,hits:0,w:1.0};const s=d.w[k];s.fires++;if(hit)s.hits++;const hr=s.fires>=30?s.hits/s.fires:0.5;const target=hr<0.38?0.3:hr>0.65?2.2:1.0;s.w=clamp(s.w*(1-alpha)+target*alpha,0.10,2.8);}const bin=String(clamp(Math.round(score),-15,15));if(!d.bins[bin])d.bins[bin]={plays:0,wins:0};d.bins[bin].plays++;if(hit)d.bins[bin].wins++;this._sv();},
    learnBatch(records){const d=this._ld();const alpha=0.035;for(const{keys,score,cashout,actual,prev}of records){const hit=actual>=cashout;d.total++;if(prev!=null&&actual!=null){const fb=bucket(prev),tb=bucket(actual);if(!d.markov[fb])d.markov[fb]={};d.markov[fb][tb]=(d.markov[fb][tb]||0)+1;}for(const k of keys){if(!d.w[k])d.w[k]={fires:0,hits:0,w:1.0};const s=d.w[k];s.fires++;if(hit)s.hits++;const hr=s.fires>=30?s.hits/s.fires:0.5;const target=hr<0.38?0.3:hr>0.65?2.2:1.0;s.w=clamp(s.w*(1-alpha)+target*alpha,0.10,2.8);}const bin=String(clamp(Math.round(score),-15,15));if(!d.bins[bin])d.bins[bin]={plays:0,wins:0};d.bins[bin].plays++;if(hit)d.bins[bin].wins++;}this._sv();},
    updateMarkov(all){const d=this._ld();const sl=all.slice(-500);if(!d.markov){d.markov={};for(let i=0;i<6;i++){d.markov[i]={};for(let j=0;j<6;j++)d.markov[i][j]=0;}}for(let i=1;i<sl.length;i++){const fb=bucket(sl[i-1]),tb=bucket(sl[i]);if(!d.markov[fb])d.markov[fb]={};d.markov[fb][tb]=(d.markov[fb][tb]||0)+1;}this._sv();},
    markovProb(lastVal,tb){const d=this._ld();const fb=bucket(lastVal);const row=d.markov[fb]||{};const tot=Object.values(row).reduce((a,b)=>a+b,0);if(tot<10)return null;return(row[tb]||0)/tot;},
    updateRegime(all){const d=this._ld();const n=all.length;if(n<30)return;const rec=all.slice(-30);d.regime.eb=d.regime.eb*0.88+((rec.filter(m=>m<1.5).length/30)-(all.filter(m=>m<1.5).length/n))*0.12;d.regime.mb=d.regime.mb*0.88+((rec.filter(m=>m>=5).length/30)-(all.filter(m=>m>=5).length/n))*0.12;this._sv();},
    w(k){return this._ld().w[k]?.w??1.0;},regime(){return this._ld().regime;},total(){return this._ld().total;},trainedTo(){return this._ld().trainedTo;},setTrainedTo(n){this._ld().trainedTo=n;this._sv();}
  };
  const getCrashMults=()=>CDB.map(r=>{const v=normMult(r.multiplier||r)||r.multiplier||r;return typeof v==='number'&&v>=1?v:null;}).filter(Boolean);

  function detectDrift(all){const n=all.length;if(n<100)return{drift:false,chi:0,dir:'none'};const B=[1.2,1.5,2,5,10,Infinity];const cB=arr=>{const c=new Array(B.length).fill(0);for(const v of arr){for(let i=0;i<B.length;i++){if(v<B[i]){c[i]++;break;}}}return c;};const hist=cB(all.slice(0,-30)),rec=cB(all.slice(-30));const hN=Math.max(1,hist.reduce((a,b)=>a+b,0));const exp=hist.map(c=>c/hN*30);let chi=0;for(let i=0;i<rec.length;i++){if(exp[i]>0.5)chi+=(rec[i]-exp[i])**2/exp[i];}const histE=hist.slice(0,2).reduce((a,b)=>a+b,0)/hN;const recE=rec.slice(0,2).reduce((a,b)=>a+b,0)/30;return{drift:chi>10,chi:Math.round(chi*10)/10,dir:recE>histE+0.10?'early':recE<histE-0.10?'late':'none'};}
  function markovModel(all){if(all.length<30)return{instProb:null,earlyProb:null,longProb:null,moonProb:null,signals:[],keys:[],adj:0};const lastVal=all[all.length-1]||1;const sigs=[],keys=[];let adj=0;const instP=Brain.markovProb(lastVal,0);const earlyP=Brain.markovProb(lastVal,1);const longP=(Brain.markovProb(lastVal,3)||0)+(Brain.markovProb(lastVal,4)||0)+(Brain.markovProb(lastVal,5)||0);const moonP=(Brain.markovProb(lastVal,4)||0)+(Brain.markovProb(lastVal,5)||0);const base=all.filter(m=>m<1.2).length/all.length;if(instP!==null){if(instP>base*1.5){sigs.push(`Markov: after ${lastVal.toFixed(2)}x -> ${Math.round(instP*100)}% instant`);keys.push('markovInst');adj-=instP*30;}else if(instP<base*0.5){sigs.push('Markov: low instant probability');keys.push('markovLong');adj+=5;}}if(moonP!==null&&moonP>0.1){sigs.push(`Markov: ${Math.round(moonP*100)}% moon`);keys.push('markovMoon');}return{instProb:instP,earlyProb:earlyP,longProb:longP,moonProb:moonP,signals:sigs,keys,adj};}
  function instantModel(all){const n=all.length;if(n<20)return{prob:0,risk:'LOW',signals:[],keys:[],streak:0,rate10:0,rate30:0,base:0};const isI=m=>m<1.2,isMoon=m=>m>=5;const base=all.filter(isI).length/n;const w10=all.slice(-10).filter(isI).length/10;const w20=all.slice(-20).filter(isI).length/20;const w30=all.slice(-30).filter(isI).length/30;let iStreak=0;for(let i=n-1;i>=0;i--){if(isI(all[i]))iStreak++;else break;}const last1=all[n-1]||0,last5=all.slice(-5);const afterMoon=last1>=5;const afterBigSafe=last5.every(m=>m>=2);let postMoonWindow=false;for(let i=Math.max(0,n-4);i<n-1;i++){if(isMoon(all[i])){postMoonWindow=true;break;}}const clust5=last5.filter(isI).length;let sinceInst=n;for(let i=n-1;i>=0;i--){if(isI(all[i])){sinceInst=n-1-i;break;}}const wRate=w10*0.60+w20*0.25+w30*0.15;const mk=Brain.markovProb(last1,0);const sigs=[],keys=[];let adj=0;const add=(k,pts,msg)=>{const lw=Brain.w(k);adj+=pts*lw;sigs.push(msg);keys.push(k);};if(wRate>base*1.6)add('instHot',28,`Instant HOT - ${Math.round(wRate*100)}% vs ${Math.round(base*100)}% base`);else if(wRate>base*1.2)add('instHot',14,`Instant elevated ${Math.round(wRate*100)}%`);else if(wRate<base*0.4)add('instCold',-18,`Instant COLD - ${Math.round(wRate*100)}%`);if(iStreak>=2)add('instStreak2',22,`${iStreak}x instants - PATTERN`);if(clust5>=3)add('instantCluster',20,`${clust5}/5 recent instant`);if(afterMoon)add('instAfterMoon',20,`Just hit ${last1.toFixed(2)}x - rebalance`);if(afterBigSafe)add('instAfterBigSafe',14,'5 safe -> instant cluster risk');if(postMoonWindow&&!afterMoon)add('instPostMoonWindow',10,'Post-moon window active');if(sinceInst>18&&base>=0.10)add('instCold',10,`${sinceInst}r since last instant`);if(mk!==null&&mk>base*1.4)add('markovInst',Math.round(mk*25),`Markov: ${Math.round(mk*100)}% instant`);const regime=Brain.regime();adj+=regime.eb*22;const prob=clamp(Math.round(wRate*100+adj),1,96);return{prob,risk:prob>=55?'HIGH':prob>=35?'MED':'LOW',signals:sigs,keys,streak:iStreak,rate10:Math.round(w10*100),rate30:Math.round(w30*100),base:Math.round(base*100)};}
  function earlyModel(all){const n=all.length;if(n<15)return{prob:50,signals:[],keys:[],streak:0,instantStreak:0,ac:'0'};const isE=m=>m<1.5,isI=m=>m<1.2;const baseRate=all.filter(isE).length/n;const r10=all.slice(-10).filter(isE).length/10;const r20=all.slice(-20).filter(isE).length/20;const r50=all.slice(-50).filter(isE).length/Math.min(50,n);const wRate=r10*0.55+r20*0.30+r50*0.15;let eStreak=0,iStreak=0;for(let i=n-1;i>=0;i--){if(isE(all[i]))eStreak++;else break;}for(let i=n-1;i>=0;i--){if(isI(all[i]))iStreak++;else break;}const last3=all.slice(-3),b3=last3.map(bucket);let pm=0,pe=0;for(let i=3;i<n-1;i++){const s=all.slice(i-3,i).map(bucket);if(s[0]===b3[0]&&s[1]===b3[1]&&s[2]===b3[2]){pm++;if(isE(all[i]))pe++;}}const patRate=pm>=5?pe/pm:baseRate;const acArr=all.slice(-100).map(m=>isE(m)?1:0);const ac=autocorr(acArr,1),ac2=autocorr(acArr,2);const emaS=ema2(all.slice(-20),0.3);const slope=emaS.length>=6?emaS[emaS.length-1]-emaS[emaS.length-6]:0;const stdR=std(all.slice(-20)),stdG=std(all.slice(-200));const regime=Brain.regime(),drift=detectDrift(all);const sigs=[],keys=[];let adj=0;const add=(k,pts,msg)=>{const lw=Brain.w(k);adj+=pts*lw;sigs.push(msg);keys.push(k);};if(wRate>baseRate*1.4)add('earlyHot',20,`Hot early ${Math.round(wRate*100)}%`);else if(wRate<baseRate*0.65)add('earlyCold',-15,`Cold early ${Math.round(wRate*100)}%`);if(eStreak>=5)add('streak5bounce',-12,`${eStreak} early -> BOUNCE DUE`);else if(eStreak>=3)add('streak3',8,`${eStreak} early streak`);if(iStreak>=2)add('instantCluster',10,`${iStreak}x instant`);if(pm>=5){const d=Math.round((patRate-baseRate)*40);if(d>4)add('patternEarly',d,`Pattern ${Math.round(patRate*100)}% early`);else if(d<-4)add('patternSafe',d,'Pattern safe');}if(ac>0.15&&eStreak>=1)add('acPersist',6,`AC +${ac.toFixed(2)}`);if(ac<-0.15&&eStreak>=1)add('acReversal',-8,`AC ${ac.toFixed(2)} reversal`);if(ac2>0.12)add('lagAC2',4,`AC lag2 +${ac2.toFixed(2)}`);if(stdR<stdG*0.55)add('varCollapse',6,'Var collapse');if(slope<-0.3)add('emaDown',5,'EMA declining');if(slope>0.5)add('emaUp',-5,'EMA rising');if(drift.drift&&drift.dir==='early')add('chiDrift',10,`Drift EARLY chi2${drift.chi}`);else if(drift.drift&&drift.dir==='late')add('chiDrift',-8,`Drift LATE chi2${drift.chi}`);adj+=regime.eb*35;return{prob:clamp(Math.round(wRate*100+adj),4,96),signals:sigs,keys,streak:eStreak,instantStreak:iStreak,ac:ac.toFixed(2),drift};}
  function longModel(all){const n=all.length;if(n<20)return{prob3:30,prob5:10,prob10:4,prob20:1,signals:[],keys:[],overdueScore:0,earlyBounce:0,g3:{since:0,avg:8,count:0},g5:{since:0,avg:20,count:0},g10:{since:0,avg:60,count:0},g20:{since:0,avg:200,count:0}};const g3=gapStats(all,3),g5=gapStats(all,5),g10=gapStats(all,10),g20=gapStats(all,20);const base3=g3.count/n,base5=g5.count/n,base10=g10.count/n,base20=g20.count/n;const od3=poissonGe(g3.avg,g3.since),od5=poissonGe(g5.avg,g5.since),od10=poissonGe(g10.avg,g10.since),od20=poissonGe(g20.avg,g20.since);let earlyRun=0;for(let i=n-1;i>=0;i--){if(all[i]<1.5)earlyRun++;else break;}let nonLong=0;for(let i=n-1;i>=0;i--){if(all[i]>=3)break;nonLong++;}const r30_5=all.slice(-30).filter(m=>m>=5).length;const r30_3=all.slice(-30).filter(m=>m>=3).length;const stdR=std(all.slice(-20)),stdG=std(all.slice(-Math.min(200,n)));const varRatio=stdG>0?stdR/stdG:1;const recentInst=all.slice(-5).filter(m=>m<1.2).length;const last1=all[n-1]||1;const mk5=Brain.markovProb(last1,4),mk6=Brain.markovProb(last1,5);const drift=detectDrift(all);const regime=Brain.regime();const sigs=[],keys=[];let a3=0,a5=0,a10=0,a20=0;const add=(k,p3,p5,p10,p20,msg)=>{const lw=Brain.w(k);a3+=p3*lw;a5+=p5*lw;a10+=p10*lw;a20+=p20*lw;sigs.push(msg);keys.push(k);};if(od3>=0.85)add('long3xVeryOverdue',24,8,2,0.5,`3x VERY overdue - ${g3.since}r`);else if(od3>=0.65)add('long3xOverdue',14,4,1,0,`3x overdue - ${g3.since}r`);else if(g3.since<g3.avg*0.4)add('long3xOverdue',-10,-3,0,0,'3x too soon');if(od5>=0.88)add('long5xVeryOverdue',10,26,8,2,`5x VERY overdue - ${g5.since}r`);else if(od5>=0.65)add('long5xOverdue',5,14,3,1,`5x overdue - ${g5.since}r`);else if(g5.since<g5.avg*0.4)add('long5xOverdue',-3,-10,-2,0,'5x too soon');if(od10>=0.80)add('long10xOverdue',3,8,22,6,`10x overdue - ${g10.since}r`);if(od20>=0.80)add('long20xOverdue',1,3,8,24,`20x overdue - ${g20.since}r`);if(earlyRun>=5)add('earlyBounce',16,10,4,1,`${earlyRun} early - BOUNCE DUE`);else if(earlyRun>=3)add('earlyBounce3',9,5,1,0,`${earlyRun} early - bounce building`);if(nonLong>=10)add('long3xOverdue',10,5,2,0.5,`${nonLong}r without 3x`);if(r30_5===0&&g5.since>8)add('longColdRecent',4,12,4,1,'0 moons in last 30r');if(r30_3<2&&nonLong>=8)add('longColdRecent',9,5,1,0,'<2 longs in 30r');if(varRatio>1.4)add('varianceExpand',6,10,5,2,'Variance expanding');if(recentInst>=3)add('longAfterInstCluster',8,6,2,0.5,`${recentInst} instants -> bounce`);if(drift.drift&&drift.dir==='late')add('chiDrift',8,12,5,2,`Drift LATE chi2${drift.chi}`);if(mk5!=null&&mk5>0.08)add('markovMoon',4,Math.round(mk5*60),Math.round(mk5*30),Math.round(mk5*15),`Markov moon ${Math.round((mk5+(mk6||0))*100)}%`);a3+=regime.mb*15;a5+=regime.mb*38;a10+=regime.mb*16;a20+=regime.mb*8;const overdueScore=Math.round(Math.min(100,(od5*0.45+od3*0.30+od10*0.25)*100));return{prob3:clamp(Math.round(base3*100+a3),5,92),prob5:clamp(Math.round(base5*100+a5),2,82),prob10:clamp(Math.round(base10*100+a10),1,55),prob20:clamp(Math.round(base20*100+a20),0,30),signals:sigs,keys,overdueScore,earlyBounce:earlyRun,nonLong,g3,g5,g10,g20,recentInst};}
  function nextRoundCall(inst,earlyR,lng,mk,score){if(inst.prob>=60)return{action:'SKIP',reason:`${inst.prob}% instant - skip`,color:'#ff6b6b',tag:'INSTANT RISK'};if(inst.streak>=2)return{action:'SKIP',reason:`${inst.streak} instants in a row`,color:'#f87171',tag:'INST STREAK'};if(earlyR.prob>=68&&lng.overdueScore<60)return{action:'SKIP',reason:`${earlyR.prob}% early crash risk`,color:'#f87171',tag:'EARLY RISK'};if(lng.earlyBounce>=5&&lng.prob3>=40)return{action:'MOON',reason:`${lng.earlyBounce} early - LONG DUE`,color:'#34d399',tag:'LONG INCOMING'};if(lng.overdueScore>=78&&lng.prob5>=15)return{action:'MOON',reason:`Moon overdue ${lng.overdueScore}%`,color:'#a78bfa',tag:'LONG INCOMING'};if(earlyR.streak>=5)return{action:'PLAY',reason:`${earlyR.streak} early - bounce now`,color:'#34d399',tag:'BOUNCE'};if(score>=2&&earlyR.prob<50&&inst.prob<35)return{action:'PLAY',reason:`Score +${score.toFixed(1)}`,color:'#34d399',tag:'PLAY'};if(score<-1||earlyR.prob>=55)return{action:'CAUTION',reason:`Early ${earlyR.prob}%`,color:'#fbbf24',tag:'CAUTION'};return{action:'PLAY',reason:'Normal',color:'#a78bfa',tag:'NEUTRAL'};}
  function extractSignals(slice,prev){const n=slice.length;if(n<15)return{keys:[],score:0};const isE=m=>m<1.5,isI=m=>m<1.2;const baseE=slice.filter(isE).length/n,baseI=slice.filter(isI).length/n;const w10=slice.slice(-10),w20=slice.slice(-20);const r10=w10.filter(isE).length/10,r20=w20.filter(isE).length/20,r50e=slice.slice(-50).filter(isE).length/Math.min(50,n);const wRate=r10*0.55+r20*0.30+r50e*0.15;let eStreak=0,iStreak=0,mRun=0,earlyRun=0;for(let i=n-1;i>=0;i--){if(isE(slice[i]))eStreak++;else break;}for(let i=n-1;i>=0;i--){if(isI(slice[i]))iStreak++;else break;}for(let i=n-1;i>=0;i--){if(slice[i]<5)mRun++;else break;}for(let i=n-1;i>=0;i--){if(slice[i]<1.5)earlyRun++;else break;}const g5=gapStats(slice,5),g3=gapStats(slice,3);const acArr=slice.slice(-80).map(m=>isE(m)?1:0);const ac=autocorr(acArr,1);const emaS=ema2(slice.slice(-20),0.3);const slope=emaS.length>=6?emaS[emaS.length-1]-emaS[emaS.length-6]:0;const stdR2=std(slice.slice(-20)),stdG2=std(slice.slice(-Math.min(200,n)));const instRate10=w10.filter(isI).length/10;const lastV=slice[n-1]||1;const keys=[];let score=0;const add=(k,pts)=>{keys.push(k);score+=pts*Brain.w(k);};if(wRate>baseE*1.4)add('earlyHot',-3);else if(wRate<baseE*0.65)add('earlyCold',2);if(eStreak>=5)add('streak5bounce',3);else if(eStreak>=3)add('streak3',-1);if(iStreak>=2)add('instantCluster',-2);if(ac>0.15&&eStreak>=1)add('acPersist',-2);if(ac<-0.15&&eStreak>=1)add('acReversal',2);if(stdR2<stdG2*0.55)add('varCollapse',-2);if(slope<-0.3)add('emaDown',-1);if(slope>0.5)add('emaUp',1);if(g5.since>g5.avg*1.8)add('moonVeryOverdue',3);else if(g5.since>g5.avg*1.3)add('moonOverdue',2);if(mRun>=8)add('moonNonRun',2);if(g3.since>g3.avg*1.8)add('long3xVeryOverdue',2);if(earlyRun>=3)add('earlyBounce3',2);if(earlyRun>=5)add('earlyBounce',3);if(instRate10>baseI*1.5)add('instHot',-2);if(lastV>=5)add('instAfterMoon',1);return{keys,score};}
  let _training=false,_lastPredKeys=[],_lastPredScore=0,_lastPredCashout=null;
  async function trainOnHistory(force=false){const all=getCrashMults();const n=all.length;if(n<100||_training)return;const alreadyTrained=Brain.trainedTo();const startIdx=force?50:Math.max(50,alreadyTrained);if(!force&&startIdx>=n-10)return;_training=true;const batch=[];const sleep0=()=>new Promise(r=>setTimeout(r,0));for(let i=startIdx;i<n-1;i++){const slice=all.slice(Math.max(0,i-500),i);const{keys,score}=extractSignals(slice,all[i-1]);const sorted=[...slice].sort((a,b)=>a-b);const cashout=Math.max(1.10,sorted[Math.floor(sorted.length*0.40)]||1.30);batch.push({keys,score,cashout,actual:all[i],prev:all[i-1]||null});if(batch.length>=50){Brain.learnBatch(batch.splice(0,batch.length));Brain.updateRegime(all.slice(0,i));await sleep0();}}if(batch.length)Brain.learnBatch(batch);Brain.updateMarkov(all);Brain.setTrainedTo(n);_training=false;}
  const train=()=>{if(getCrashMults().length>=100)trainOnHistory().catch(()=>{});};

  function weightedSurvival(all, threshold, windowSize = 180) {
    const slice = all.slice(-Math.min(windowSize, all.length));
    if (!slice.length) return 0.5;
    let wSum = 0, wHit = 0;
    slice.forEach((m, i) => {
      const w = 0.35 + (i + 1) / slice.length;
      wSum += w;
      if (m >= threshold) wHit += w;
    });
    return wSum ? wHit / wSum : 0.5;
  }

  function findCashoutForSurvival(all, targetSurv, minCo, maxCo) {
    let best = minCo, bestDiff = 1;
    for (let c = minCo; c <= maxCo; c += 0.01) {
      const rounded = Math.round(c * 100) / 100;
      const surv = weightedSurvival(all, rounded);
      const diff = Math.abs(surv - targetSurv);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = rounded;
      }
    }
    return clamp(best, minCo, maxCo);
  }

 function predCrash() {
    const all = getCrashMults();
    const n = all.length;
    if (n < 20) return null;

    const sorted = [...all].sort((a, b) => a - b);
    const mean = all.reduce((s, v) => s + v, 0) / n;
    const median = sorted[Math.floor(n / 2)];
    const recent20 = all.slice(-20);
    const recentMean = recent20.reduce((s, v) => s + v, 0) / recent20.length;

    const p25 = sorted[Math.floor(n * 0.25)];
    const p50 = sorted[Math.floor(n * 0.50)];
    const p75 = sorted[Math.floor(n * 0.75)];
    const p85 = sorted[Math.floor(n * 0.85)];
    const p90 = sorted[Math.floor(n * 0.90)];
    const p95 = sorted[Math.floor(n * 0.95)];

    const recent10 = all.slice(-10);
    const recentMean10 = recent10.reduce((s, v) => s + v, 0) / 10;
    const previous10 = all.slice(-20, -10);
    const prevMean10 = previous10.reduce((s, v) => s + v, 0) / 10;
    const trend = recentMean10 - prevMean10;

    const maxAll = Math.max(...all);
    const minAll = Math.min(...all);
    const maxRecent = Math.max(...recent20);
    const minRecent = Math.min(...recent20);

    function actualSurvival(mult) {
        let count = 0;
        for (const m of all) {
            if (m >= mult) count++;
        }
        return count / n;
    }

    function getWeightedPercentile(weights) {
        let totalWeight = 0;
        let weightedSum = 0;
        for (let i = 0; i < sorted.length; i++) {
            const w = Math.exp(-i / weights.length);
            totalWeight += w;
            weightedSum += sorted[i] * w;
        }
        return weightedSum / totalWeight;
    }

    const calculationMethods = [
        function() {
            let target = 0.35 + Math.random() * 0.50;
            let minM = 1.02 + Math.random() * 0.3;
            let maxM = 1.5 + Math.random() * 8.5;
            let best = minM;
            let bestDiff = 1;
            for (let m = minM; m <= maxM; m += 0.005 + Math.random() * 0.02) {
                const surv = actualSurvival(m);
                const diff = Math.abs(surv - target);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = m;
                }
            }
            return best + (Math.random() - 0.5) * 0.3;
        },
        function() {
            const base = p50 + (p75 - p50) * (0.1 + Math.random() * 0.8);
            return base * (0.85 + Math.random() * 0.30);
        },
        function() {
            return (mean + median) / 2 * (0.7 + Math.random() * 0.6);
        },
        function() {
            const recentAvg = recentMean * (0.7 + Math.random() * 0.6);
            const historicalAvg = mean * (0.7 + Math.random() * 0.6);
            return (recentAvg * (0.3 + Math.random() * 0.4) + historicalAvg * (0.3 + Math.random() * 0.4));
        },
        function() {
            return p25 + (p75 - p25) * (0.1 + Math.random() * 0.9);
        },
        function() {
            const volatility = std(all.slice(-50)) || 0.5;
            const base = mean + (Math.random() - 0.5) * volatility * 1.5;
            return Math.max(1.02, base);
        },
        function() {
            const weights = [0.3, 0.5, 0.7, 0.9];
            const idx = Math.floor(Math.random() * weights.length);
            return sorted[Math.floor(sorted.length * weights[idx])] * (0.85 + Math.random() * 0.30);
        },
        function() {
            const survivalTarget = 0.2 + Math.random() * 0.65;
            let best = 1.02;
            let bestDiff = 1;
            const step = 0.005 + Math.random() * 0.02;
            const maxSearch = Math.min(p90 * 1.1, 10);
            for (let m = 1.02; m <= maxSearch; m += step) {
                const diff = Math.abs(actualSurvival(m) - survivalTarget);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = m;
                }
            }
            return best + (Math.random() - 0.5) * 0.2;
        },
        function() {
            const recentMax = Math.max(...recent20);
            const recentMin = Math.min(...recent20);
            const range = recentMax - recentMin;
            return recentMin + range * (0.1 + Math.random() * 0.9);
        },
        function() {
            const weighted = getWeightedPercentile([0.3, 0.5, 0.7]);
            return weighted * (0.8 + Math.random() * 0.4);
        },
        function() {
            const trendFactor = 1 + (trend / mean) * (0.5 + Math.random() * 1.0);
            return (mean * trendFactor) * (0.8 + Math.random() * 0.4);
        },
        function() {
            const randomPercentile = 0.05 + Math.random() * 0.90;
            const idx = Math.floor(sorted.length * randomPercentile);
            return sorted[idx] * (0.85 + Math.random() * 0.30);
        },
        function() {
            const base = (p25 + p50 + p75) / 3;
            return base * (0.7 + Math.random() * 0.6);
        },
        function() {
            const recentMedian = recent20.sort((a,b) => a-b)[Math.floor(recent20.length/2)];
            return recentMedian * (0.75 + Math.random() * 0.50);
        },
        function() {
            const volatility = std(all.slice(-30)) || 0.5;
            const momentum = (recentMean10 - prevMean10) * (0.5 + Math.random() * 1.5);
            return Math.max(1.02, recentMean + momentum + (Math.random() - 0.5) * volatility);
        },
        function() {
            const maxSearch = Math.min(p95 * 0.9, 8);
            const targetSurv = 0.15 + Math.random() * 0.70;
            let best = 1.02;
            let bestDiff = 1;
            for (let m = 1.02; m <= maxSearch; m += 0.01) {
                const diff = Math.abs(actualSurvival(m) - targetSurv);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = m;
                }
            }
            return best + (Math.random() - 0.5) * 0.25;
        },
        function() {
            const factors = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
            const f = factors[Math.floor(Math.random() * factors.length)];
            return (p25 * f + p75 * (1-f)) * (0.85 + Math.random() * 0.30);
        },
        function() {
            const streakCount = recent20.filter(m => m < 1.5).length;
            const bounceFactor = 1 + (streakCount / 20) * (0.5 + Math.random() * 1.0);
            return (mean * bounceFactor) * (0.7 + Math.random() * 0.6);
        },
        function() {
            const maxRecent = Math.max(...recent20);
            const minRecent = Math.min(...recent20);
            const randomPoint = minRecent + (maxRecent - minRecent) * (0.05 + Math.random() * 0.95);
            return randomPoint * (0.85 + Math.random() * 0.30);
        },
        function() {
            const sortedRecent = [...recent20].sort((a,b) => a-b);
            const idx = Math.floor(Math.random() * sortedRecent.length);
            return sortedRecent[idx] * (0.8 + Math.random() * 0.40);
        },
        function() {
            const maxSearch = Math.min(p90 * 0.85, 10);
            const minSearch = Math.max(1.02, p25 * 0.7);
            return minSearch + (maxSearch - minSearch) * (0.05 + Math.random() * 0.95);
        }
    ];

    let recommendedCashout = 1.05;
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        const method = calculationMethods[Math.floor(Math.random() * calculationMethods.length)];
        let candidate = method();
        const cap = Math.min(maxRecent * (0.85 + Math.random() * 0.15), Math.max(p75 * (0.75 + Math.random() * 0.25), 2.0));
        candidate = Math.min(candidate, cap);
        candidate = Math.max(1.02, Math.min(candidate, Math.max(p85 * 0.85, 1.8) + Math.random() * 1.0));

        const style = Math.floor(Math.random() * 5);
        switch(style) {
            case 0: candidate = Math.round(candidate * 2) / 2; break;
            case 1: candidate = Math.round(candidate * 4) / 4; break;
            case 2: candidate = Math.round(candidate * 8) / 8; break;
            case 3: candidate = Math.round(candidate * 10) / 10; break;
            case 4: candidate = Math.round(candidate * 20) / 20; break;
        }

        if (candidate >= 1.02 && candidate <= 10.0) {
            recommendedCashout = candidate;
            break;
        }
        attempts++;
    }

    if (recommendedCashout < 1.02 || recommendedCashout > 10.0) {
        recommendedCashout = Math.max(1.02, Math.min(4.0, mean * (0.5 + Math.random() * 1.0)));
    }

    let confidence = 20 + Math.random() * 20;
    if (n > 50) confidence += 10 + Math.random() * 15;
    if (n > 100) confidence += 5 + Math.random() * 10;
    if (n > 200) confidence += 5 + Math.random() * 10;

    const volatility = std(recent20) || 0;
    if (volatility > 2) confidence -= 10 + Math.random() * 15;
    else if (volatility > 1) confidence -= 5 + Math.random() * 10;

    if (Math.abs(trend) < 0.1) confidence += 5 + Math.random() * 10;
    else confidence -= 5 + Math.random() * 10;
    confidence = Math.max(20, Math.min(95, Math.round(confidence)));

    const survivalAtCashout = Math.round(actualSurvival(recommendedCashout) * 100);

    const actions = ['PLAY', 'PLAY', 'PLAY', 'CAUTION', 'PLAY', 'PLAY', 'SKIP', 'PLAY', 'PLAY', 'CAUTION'];
    let action = actions[Math.floor(Math.random() * actions.length)];
    let reason = `${Math.round(actualSurvival(recommendedCashout) * 100)}% survival at ${recommendedCashout.toFixed(2)}x | ${n} rounds`;
    let color = '#34d399';
    let tag = 'PLAY';

    const recentBelow1_5 = recent20.filter(m => m < 1.5).length / 20;
    if (recentBelow1_5 > 0.6 && recommendedCashout > 1.8) {
        action = Math.random() > 0.3 ? 'CAUTION' : 'SKIP';
        reason = `${Math.round(recentBelow1_5 * 100)}% below 1.5x - ${recommendedCashout.toFixed(2)}x`;
        color = Math.random() > 0.5 ? '#fbbf24' : '#f87171';
        tag = action;
    }

    const recentMoons = recent20.filter(m => m >= 5).length;
    if (recentMoons >= 2 && recommendedCashout > 2.5) {
        action = Math.random() > 0.4 ? 'CAUTION' : 'SKIP';
        reason = `${recentMoons} moons in 20 - ${recommendedCashout.toFixed(2)}x`;
        color = '#fbbf24';
        tag = 'CAUTION';
    }

    const streakLow = recent20.slice(-5).filter(m => m < 1.5).length;
    if (streakLow >= 4 && recommendedCashout > 1.8) {
        action = 'PLAY';
        reason = `${streakLow}/5 below 1.5x - bounce ${recommendedCashout.toFixed(2)}x`;
        color = '#34d399';
        tag = 'BOUNCE';
    }

    const streakHigh = recent20.slice(-5).filter(m => m >= 3).length;
    if (streakHigh >= 3 && recommendedCashout < 2.0) {
        action = Math.random() > 0.5 ? 'SKIP' : 'CAUTION';
        reason = `${streakHigh}/5 above 3x - ${recommendedCashout.toFixed(2)}x`;
        color = '#f87171';
        tag = 'SKIP';
    }

    const inst = instantModel(all);
    const earlyR = earlyModel(all);
    const lng = longModel(all);
    const mk = markovModel(all);
    const { keys, score } = extractSignals(all);

    _lastPredKeys = [...new Set([...keys, ...earlyR.keys, ...inst.keys, ...lng.keys, ...mk.keys])];
    _lastPredScore = score;
    _lastPredCashout = recommendedCashout;

    const allSigs = [...inst.signals.slice(0, 2), ...earlyR.signals.slice(0, 2), ...lng.signals.slice(0, 2), ...mk.signals.slice(0, 1)];
    const regime = Brain.regime();
    const regLabel = regime.eb > 0.08 ? 'early-heavy' : regime.eb < -0.08 ? 'safe-heavy' : regime.mb > 0.05 ? 'moon-heavy' : 'neutral';

    return {
        cashout: recommendedCashout.toFixed(2),
        safe: Math.max(1.02, recommendedCashout * (0.88 + Math.random() * 0.08)).toFixed(2),
        agg: Math.min(10.0, recommendedCashout * (1.05 + Math.random() * 0.15)).toFixed(2),
        surv: String(survivalAtCashout),
        conf: confidence,
        mood: action,
        moodColor: color,
        avg: mean.toFixed(2),
        ks: score >= 0 ? '+' + score.toFixed(1) : score.toFixed(1),
        kl: kelly(actualSurvival(recommendedCashout), recommendedCashout - 1).toFixed(2),
        n: n,
        reg: regLabel,
        call: { action: action, reason: reason, color: color, tag: tag },
        earlyProb: earlyR.prob || 50,
        instProb: inst.prob || 0,
        overdueScore: lng.overdueScore || 0,
        score: score || 0,
        signals: allSigs
    };
}

  const xget=url=>new Promise((resolve,reject)=>{
    GM_xmlhttpRequest({method:'GET',url,headers:{'Accept':'application/json','X-Requested-With':'XMLHttpRequest'},withCredentials:true,timeout:10000,
      onload:res=>resolve(res.responseText),
      onerror:e=>resolve('[]'),
      ontimeout:()=>resolve('[]')
    });
  });
  const parseAny=raw=>{try{const d=JSON.parse(raw);return d.data||d.history||d.games||(Array.isArray(d)?d:[]);}catch{return[];}};

  async function scrapeCrash(){
    let found=false;
    const urls=[
      'https://rest-bf.blox.land/games/crash/history?limit=200',
      'https://rest-bf.blox.land/games/crash/history',
      'https://api.bloxflip.com/games/crash/history?limit=200',
      'https://api.bloxflip.com/games/crash/history',
      'https://bloxflip.com/api/crash/history?limit=200',
      'https://bloxflip.com/api/crash/history',
      'https://bloxflip.com/api/crash/rounds'
    ];
    for(const u of urls){
      try{
        const text=await xget(u);
        const rows=parseAny(text);
        if(rows.length>0){
          rows.forEach(x=>{
            const raw=x.crashPoint||x.crashedAt||x.multiplier||x.crash_point||x.bust||x;
            const m=normMult(raw)||parseFloat(raw)||0;
            if(m>=1)pushCDB({multiplier:m});
          });
          found=true;
          break;
        }
      }catch(e){}
    }
    if(!found)found=scrapeCrashDOMChips();
    train();
    return found;
  }

  function scrapeCrashDOMChips(){
    const selectors='[class*="crashHistory"] span,[class*="crash-history"] span,[class*="CrashHistory"] span,[class*="historyItem"],[class*="history-item"],[class*="crashBadge"],[class*="crash-badge"],[class*="pastMultiplier"],[class*="past-multiplier"],[class*="cashoutChip"],[class*="cashout-chip"],[class*="gameHistory"] span,[class*="game-history"] span,[class*="roundHistory"] span,[class*="round-history"] span,[class*="multiplier"],[class*="Multiplier"],[data-testid*="crash"],[data-testid*="multiplier"],[class*="result"],[class*="Result"]';
    const chips=[...document.querySelectorAll(selectors)];
    let added=0;
    chips.forEach(el=>{
      const txt=(el.textContent||'').trim().replace(/[×xX💥🔥🚀]/g,'');
      const m=normMult(txt)||parseFloat(txt)||0;
      if(m>=1&&m<1000){pushCDB({multiplier:m});added++;}
    });
    if(added>0&&getCrashMults().length>5)train();
    return added>0;
  }

  function parseWSMsg(raw){
    try{const d=JSON.parse(raw);return[{_data:d?.data||d,_evt:''}];}catch{}
    try{const m=raw.match(/^\d+(\[.*\])$/s);if(m){const arr=JSON.parse(m[1]);if(Array.isArray(arr)){const evt=(typeof arr[0]==='string'?arr[0]:'').toLowerCase();return arr.slice(1).map(d=>({_data:d,_evt:evt}));}}}catch{}
    return[];
  }

  function ingestCrashSocket(raw){
    if(typeof raw!=='string')return false;
    if(!raw.includes('crash')&&!raw.includes('game')&&!raw.includes('multiplier')&&!raw.includes('bust'))return false;
    const pairs=[];
    const walk=(node,depth)=>{
      if(!node||typeof node!=='object'||depth>8)return;
      if(Array.isArray(node)){node.forEach(v=>walk(v,depth+1));return;}
      if(typeof node.channel==='string'&&(node.channel.startsWith('crash:')||node.channel.startsWith('crash-')||node.channel==='crash')){
        let dat=null;
        if(node.pub)dat=node.pub.data??node.pub;
        else if(node.data!=null)dat=node.data;
        pairs.push({ch:node.channel.replace(/^crash[:\\-]/,''),data:dat});
      }
      for(const k in node){const v=node[k];if(v&&typeof v==='object')walk(v,depth+1);}
    };
    try{walk(JSON.parse(raw),0);}catch{return false;}
    if(!pairs.length)return false;
    const numV=v=>{const n=Number(v);return Number.isFinite(n)&&n>=1&&n<1e5?(n>=100?n/100:n):null;};
    const getM=d=>{
      if(!d||typeof d!=='object')return null;
      for(const k of['multiplier','currentMultiplier','current','point','crashPoint','crash_point','value','bust','result','outcome']){
        const n=numV(d[k]);if(n)return n;
      }
      return null;
    };
    for(const{ch,data}of pairs){
      if(ch==='game-end'||ch==='crashed'||ch==='bust'||ch==='end'||ch==='complete'||ch==='finished'||ch==='exploded'||ch==='boom'){
        const bust=getM(data)||0;
        if(bust>=1){
          const m=normMult(bust)||bust;
          pushCDB({multiplier:m});
          train();
          if(_lastPredCashout!==null)Brain.learn(_lastPredKeys||[],_lastPredScore||0,_lastPredCashout,m);
          updateCrashDisplay();
        }
        stopCrashWatcher();
        if(autoCrash)_crashBetPending=true;
      }
    }
    return true;
  }

  function handleWSMsg(msg){
    const{_data:d,_evt:evt}=msg;
    const evtLower=(evt||'').toLowerCase();
    if(/crash.*start|crash.*waiting|crash.*betting|start.*crash|game.*start|round.*start/i.test(evtLower)){
      if(autoCrash)setTimeout(()=>{if(!crashBusy)onCrashRoundStart();},400);
    }
    if(/crash.*end|crash.*explode|crash.*boom|game.*end|round.*end|crash.*complete|crash.*finish/i.test(evtLower)){
      const cv=normMult(d?.crashPoint||d?.crashedAt||d?.multiplier||d?.crash_point||d?.bust||d?.result)||parseFloat(d?.crashPoint||d?.crashedAt||d?.multiplier||d?.crash_point||d?.bust||d?.result||0);
      if(cv>0){
        pushCDB({multiplier:cv});
        train();
        if(_lastPredCashout!==null)Brain.learn(_lastPredKeys||[],_lastPredScore||0,_lastPredCashout,cv);
        updateCrashDisplay();
      }
      stopCrashWatcher();
      if(autoCrash)_crashBetPending=true;
    }
    if(d&&typeof d==='object'){
      const ss=d.serverSeed||d.server_seed||d.privateKey||d.privateSeed||d.seed;
      const cs=d.clientSeed||d.client_seed||d.publicSeed||d.publicKey;
      const n=d.nonce??d.slideNonce??d.roundNonce;
      if(cs&&cs.length>3)slideClientSeed=cs;
      if(n!==undefined&&n!==null){const pn=parseInt(n);if(!isNaN(pn)&&pn>0){if(pn!==slideNonce){slideNonceOffset=0;_slideRoundPredicted=false;}slideNonce=pn;}}
      if(ss&&typeof ss==='string'&&ss.length>10&&!/not\s+revealed/i.test(ss)){
        const cur=_ActiveSlideSeed.get();
        if(!cur||cur.seed!==ss){
          slideNonceOffset=0;_slideRoundPredicted=false;
          _ActiveSlideSeed.set(ss,cs||slideClientSeed,parseInt(n)||slideNonce||0);
        }
      }
    }
    handleWSData(d);
  }

  function handleWSData(d){
    if(!d||typeof d!=='object')return;
    const cv=normMult(d.crashPoint||d.crashedAt||d.multiplier||d.crash_point||d.bust||d.result)||parseFloat(d.crashPoint||d.crashedAt||d.multiplier||d.crash_point||d.bust||d.result||0);
    if(cv>=1){pushCDB({multiplier:cv});if(CDB.length%10===0)train();updateCrashDisplay();}
  }

  function installHooks(win){
    try{
      const W=win.WebSocket;
      win.WebSocket=function(...a){
        const ws=new W(...a);
        const origAddEventListener=ws.addEventListener.bind(ws);
        ws.addEventListener=function(type,listener,options){
          if(type==='message'){
            const wrappedListener=function(e){
              try{if(typeof e.data==='string'){ingestCrashSocket(e.data);parseWSMsg(e.data).forEach(msg=>handleWSMsg(msg));}}catch(ex){}
              listener.call(this,e);
            };
            return origAddEventListener(type,wrappedListener,options);
          }
          return origAddEventListener(type,listener,options);
        };
        return ws;
      };
      win.WebSocket.prototype=W.prototype;
    }catch(e){}
    try{
      const F=win.fetch;
      win.fetch=async function(url,o){
        const r=await F(url,o);
        if(typeof url==='string'&&/crash/i.test(url)){
          try{const clone=r.clone();const text=await clone.text();const resp=JSON.parse(text);const d=resp.data||resp;if(!d.game&&!d.type)d.game='crash';handleWSData(d);}catch(ex){}
        }
        return r;
      };
    }catch(e){}
  }

  let lastCrashPrediction=null,crashBusy=false;
  let autoCrash=lj('cx_autocrash',false);
  let _crashBetPending=false,_autoCashTarget=0,_cashWatcher=null,_betRetryTimer=null,_sitOutConsec=0;

  function updateCrashDisplay(){
    const r=lastCrashPrediction;
    if(!r)return;
    const els={
      'crash-cashout':r.cashout+'x',
      'crash-survival':r.surv+'%',
      'crash-instant-risk':r.instProb+'%',
      'crash-early-risk':r.earlyProb+'%',
      'crash-confidence':r.conf+'%',
    };
    for(const[id,val]of Object.entries(els)){
      const el=document.getElementById(id);if(el)el.textContent=val;
    }
    const heroEl=document.getElementById('crash-cashout');
    if(heroEl){
      heroEl.style.color=r.moodColor||'var(--fpvx-accent)';
    }
    const sigEl=document.getElementById('crash-signal');
    if(sigEl){
      sigEl.textContent=r.mood||'—';
      sigEl.style.color=r.moodColor||'#a0aec0';
      sigEl.style.background=r.call?.action==='SKIP'?'rgba(248,113,113,0.14)':r.call?.action==='MOON'?'rgba(167,139,250,0.14)':r.call?.action==='PLAY'?'rgba(52,211,153,0.14)':'rgba(255,255,255,0.06)';
      sigEl.style.border='1px solid '+(r.moodColor||'rgba(255,255,255,0.08)');
    }
    const msgEl=document.getElementById('crash-message');
    if(msgEl){
      msgEl.textContent=r.call?r.call.reason:`Recommended ${r.cashout}x · ${r.surv}% survival · ${CDB.length} rounds`;
      msgEl.style.color=r.moodColor||'#a0aec0';
    }
  }

  function updateCrashSidebar(){
    const betEl=document.querySelector('input[type="number"]');
    const bet=betEl?parseFloat(betEl.value)||0:0;
    const betDisplay=document.getElementById('crash-bet');
    if(betDisplay)betDisplay.textContent=bet?bet.toFixed(2):'0.00';
    const dataDisplay=document.getElementById('crash-data');
    if(dataDisplay)dataDisplay.textContent=CDB.length+' rounds';
    const statusEl=document.getElementById('crash-status');
    if(statusEl)statusEl.textContent=CDB.length>=10?'Ready':CDB.length>=5?'Learning':'Loading';
  }

  function updateCrashBalanceDisplay(){
    const balanceEl = document.getElementById('crash-balance');
    if (balanceEl) {
      balanceEl.textContent = valBalance ? valBalance.textContent : '0.00';
    }
  }

 buildCrashUIInShell = function() {
  const existing = document.getElementById('fpvx-crash-content-shell');
  if (existing) existing.remove();

  const shell = document.querySelector('.fpvx-shell');
  if (!shell) return;

  shell.classList.add('crash-mode');

  const crashContainer = document.createElement('div');
  crashContainer.id = 'fpvx-crash-content-shell';
  crashContainer.style.cssText = 'grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden;';

  crashContainer.innerHTML = `
    <div class="fpvx-crash-stats" style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; flex-shrink: 0;">
      <div class="fpvx-card" style="min-height: 42px; padding: 6px 8px;"><span class="fpvx-card-lbl">Status</span><span class="fpvx-card-val" id="crash-status" style="font-size:11px;color:var(--fpvx-accent);">Ready</span></div>
      <div class="fpvx-card" style="min-height: 42px; padding: 6px 8px;"><span class="fpvx-card-lbl">Confidence</span><span class="fpvx-card-val" id="crash-confidence">0%</span></div>
      <div class="fpvx-card" style="min-height: 42px; padding: 6px 8px;"><span class="fpvx-card-lbl">Data</span><span class="fpvx-card-val" id="crash-data">0 rounds</span></div>
      <div class="fpvx-card" style="min-height: 42px; padding: 6px 8px;"><span class="fpvx-card-lbl">Signal</span><span class="fpvx-crash-signal" id="crash-signal" style="display:inline-flex;align-items:center;justify-content:center;margin-top:2px;padding:2px 8px;border-radius:999px;font-size:9px;font-weight:800;letter-spacing:0.04em;white-space:nowrap;background:rgba(255,255,255,0.06);color:#a0aec0;">—</span></div>
    </div>
    <div class="fpvx-crash-hero" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);min-height:70px;flex-shrink:0;">
      <span class="fpvx-crash-hero-lbl" style="font-size:8px;font-weight:700;letter-spacing:0.08em;color:#718096;text-transform:uppercase;">Recommended Cashout</span>
      <span class="fpvx-crash-hero-val" id="crash-cashout" style="font-size:28px;line-height:1;font-weight:800;font-family:'JetBrains Mono',monospace;color:var(--fpvx-accent);text-shadow:0 0 24px rgba(var(--fpvx-accent),0.25);white-space:nowrap;">1.00x</span>
    </div>
    <div class="fpvx-crash-metrics" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;flex-shrink:0;">
      <div class="fpvx-crash-metric" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 6px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);min-height:44px;text-align:center;">
        <span class="fpvx-crash-metric-lbl" style="font-size:7px;font-weight:700;letter-spacing:0.06em;color:#718096;text-transform:uppercase;white-space:nowrap;">Survival</span>
        <span class="fpvx-crash-metric-val" id="crash-survival" style="font-size:14px;line-height:1;font-weight:800;font-family:'JetBrains Mono',monospace;white-space:nowrap;color:#fff;">0%</span>
      </div>
      <div class="fpvx-crash-metric" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 6px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);min-height:44px;text-align:center;">
        <span class="fpvx-crash-metric-lbl" style="font-size:7px;font-weight:700;letter-spacing:0.06em;color:#718096;text-transform:uppercase;white-space:nowrap;">Instant Risk</span>
        <span class="fpvx-crash-metric-val" id="crash-instant-risk" style="font-size:14px;line-height:1;font-weight:800;font-family:'JetBrains Mono',monospace;white-space:nowrap;color:#f87171;">0%</span>
      </div>
      <div class="fpvx-crash-metric" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px 6px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);min-height:44px;text-align:center;">
        <span class="fpvx-crash-metric-lbl" style="font-size:7px;font-weight:700;letter-spacing:0.06em;color:#718096;text-transform:uppercase;white-space:nowrap;">Early Risk</span>
        <span class="fpvx-crash-metric-val" id="crash-early-risk" style="font-size:14px;line-height:1;font-weight:800;font-family:'JetBrains Mono',monospace;white-space:nowrap;color:#fbbf24;">0%</span>
      </div>
    </div>
    <div class="fpvx-crash-message" id="crash-message" style="min-height:28px;padding:4px 10px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);font-size:10px;line-height:1.3;font-weight:600;color:#a0aec0;text-align:center;display:flex;align-items:center;justify-content:center;flex-shrink:0;">Click PREDICT to analyze crash data</div>
   <div class="fpvx-crash-footer" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:auto;flex-shrink:0;">
  <div class="fpvx-card" style="min-height:40px;padding:4px 8px;grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;"><span class="fpvx-card-lbl">Balance</span><span class="fpvx-card-val" id="crash-balance" style="font-size:13px;">0.00</span></div>
  <div class="fpvx-crash-actions" style="grid-column:1/-1;display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:6px;">
    <button class="fpvx-btn-action" id="crash-predict-btn" style="height:30px;font-size:11px;padding:0 4px;">PREDICT</button>
    <button class="fpvx-btn-square" id="crash-auto-btn" style="height:30px;font-size:9px;">Auto Cash: OFF</button>
    <button class="fpvx-btn-square" id="crash-reload-btn" style="height:30px;font-size:9px;">RELOAD</button>
  </div>
</div>
  `;

  shell.appendChild(crashContainer);

  document.getElementById('crash-predict-btn').addEventListener('click', runCrashPredict);
  document.getElementById('crash-auto-btn').addEventListener('click', function() {
    autoCrash = !autoCrash;
    try{sj('cx_autocrash', autoCrash);}catch(e){}
    updateCrashAutoBtn();
    if (!autoCrash) stopCrashWatcher();
    if (autoCrash) { runCrashPredict(); _crashBetPending = true; }
  });
  document.getElementById('crash-reload-btn').addEventListener('click', async function() {
    this.textContent = '...';
    this.disabled = true;
    await scrapeCrash();
    if (CDB.length >= 10) { const r = predCrash(); if (r) { lastCrashPrediction = r; updateCrashDisplay(); } }
    updateCrashSidebar();
    this.textContent = 'RELOAD';
    this.disabled = false;
  });

  updateCrashDisplay();
  updateCrashSidebar();
  updateCrashBalanceDisplay();
  updateCrashAutoBtn();
  if (!lastCrashPrediction && CDB.length >= 10) {
    const r = predCrash();
    if (r) { lastCrashPrediction = r; updateCrashDisplay(); }
  }
}

  function getCrashLiveMult(){
    const allEls=document.querySelectorAll('h1,h2,h3,h4,p,span,div,label');
    for(const el of allEls){
      if(el.children.length>2)continue;
      const rect=el.getBoundingClientRect();
      if(rect.width<10||rect.height<6)continue;
      const t=(el.textContent||'').trim();
      const m=t.match(/^(\d{1,4}\.\d{1,2})\s*[×xX]?$/);
      if(m){const v=parseFloat(m[1]);if(v>=1&&v<1000)return v;}
    }
    return 0;
  }

  function clickCrashCashout(){
    const btns=[...document.querySelectorAll('button')];
    const b1=btns.find(b=>/cash\s*out|cashout/i.test(b.textContent)&&!b.disabled&&b.getBoundingClientRect().width>20);
    if(b1){b1.click();return true;}
    return false;
  }

  function setCrashAutoCashout(mult){
    _autoCashTarget=mult;
    const candidates=[...document.querySelectorAll('input[type="number"],input[type="text"]')].filter(inp=>{
      const rect=inp.getBoundingClientRect();
      if(rect.width<30||rect.height<10)return false;
      const ctx=(inp.closest('div,label,section')?.textContent||inp.placeholder||'').toLowerCase();
      return/auto|cashout|cash.?out|multiplier/i.test(ctx);
    });
    for(const inp of candidates){
      try{
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        setter.set.call(inp,mult.toFixed(2));
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        inp.dispatchEvent(new Event('change',{bubbles:true}));
      }catch{}
    }
    if(_cashWatcher)clearInterval(_cashWatcher);
    _cashWatcher=setInterval(()=>{
      if(!autoCrash||_autoCashTarget<=0){clearInterval(_cashWatcher);_cashWatcher=null;return;}
      const live=getCrashLiveMult();
      if(live<=0)return;
      if(live>=_autoCashTarget){
        clickCrashCashout();
        _autoCashTarget=0;
        clearInterval(_cashWatcher);
        _cashWatcher=null;
      }
    },80);
  }

  function stopCrashWatcher(){
    if(_cashWatcher){clearInterval(_cashWatcher);_cashWatcher=null;}
    _autoCashTarget=0;
    if(_betRetryTimer){clearInterval(_betRetryTimer);_betRetryTimer=null;}
  }

  function placeCrashBet(){
    const btn=[...document.querySelectorAll('button')].find(b=>/join.*game|place.*bet|bet now/i.test(b.textContent)&&!b.disabled);
    if(btn){btn.click();_crashBetPending=false;return;}
    if(_betRetryTimer)return;
    let retries=0;
    _betRetryTimer=setInterval(()=>{
      retries++;
      if(retries>125){clearInterval(_betRetryTimer);_betRetryTimer=null;_crashBetPending=false;return;}
      const b2=[...document.querySelectorAll('button')].find(b=>/join.*game|place.*bet|bet now/i.test(b.textContent)&&!b.disabled);
      if(b2){b2.click();_crashBetPending=false;clearInterval(_betRetryTimer);_betRetryTimer=null;}
    },80);
  }

  function updateCrashAutoBtn(){
    const b=document.getElementById('crash-auto-btn');
    if(!b)return;
    if(autoCrash){b.textContent='Auto Cash: ON';b.classList.add('active');}
    else{b.textContent='Auto Cash: OFF';b.classList.remove('active');}
  }

  function _isBadCrashRound(r){
    if(!r)return true;
    if(r.call?.action==='SKIP')return true;
    if(r.instProb>=55)return true;
    if(r.earlyProb>=65&&parseInt(r.surv)<42)return true;
    const recent=getCrashMults().slice(-8);
    if(recent.length>=6&&recent.filter(v=>v<1.5).length>=4)return true;
    return false;
  }

  function onCrashRoundStart(){
    lastCrashPrediction=null;
    if(autoCrash&&!_crashBetPending)_crashBetPending=true;
    predCrashAndApply();
  }

  async function predCrashAndApply(){
    if(CDB.length<5)return;
    const r=predCrash();
    if(!r)return;
    lastCrashPrediction=r;
    updateCrashDisplay();
    if(autoCrash){
      const bad=_isBadCrashRound(r);
      if(bad&&_sitOutConsec<4){_sitOutConsec++;_crashBetPending=false;return;}
      _sitOutConsec=0;
      const safeTarget=Math.max(1.05,parseFloat(r.cashout)||1.20);
      setCrashAutoCashout(safeTarget);
    }
    if(_crashBetPending&&autoCrash)placeCrashBet();
  }

  async function runCrashPredict(){
    if(crashBusy)return;
    crashBusy=true;
    const btn=document.getElementById('crash-predict-btn');
    const statusEl = document.getElementById('crash-status');
    const msgEl = document.getElementById('crash-message');

    if(btn){btn.textContent='...';btn.disabled=true;}
    if(statusEl){statusEl.textContent='SCANNING';statusEl.style.color='#fbbf24';}
    if(msgEl){msgEl.textContent='Analyzing crash history...';}

  try{
    await scrapeCrash();
    const r=predCrash();
    if(r){
      lastCrashPrediction=r;
      updateCrashDisplay();
      if(statusEl){statusEl.textContent='READY';statusEl.style.color='#34d399';}
      if(msgEl){msgEl.textContent='Prediction complete - ' + r.call.reason;}
    } else {
      if(msgEl){msgEl.textContent='Need more data (at least 10 rounds)';}
    }
  } catch(e){
    if(msgEl){msgEl.textContent='Error: ' + e.message;}
  } finally{
    crashBusy=false;
    if(btn){btn.textContent='PREDICT';btn.disabled=false;}
  }
}

  async function initCrash(){
    try{installHooks(unsafeWindow);}catch(e){}
    scrapeCrashDOMChips();
    await scrapeCrash();
    train();
    updateCrashSidebar();
    updateCrashAutoBtn();
    if(CDB.length>=10){
      const r=predCrash();
      if(r){lastCrashPrediction=r;updateCrashDisplay();}
    }
    setInterval(()=>{updateCrashSidebar();updateCrashAutoBtn();},3000);
    const observer=new MutationObserver(()=>{
      const startBtn=[...document.querySelectorAll('button')].find(b=>/join.*game|place.*bet|bet now/i.test(b.textContent)&&!b.disabled);
      if(startBtn&&autoCrash&&!_crashBetPending){_crashBetPending=true;setTimeout(()=>onCrashRoundStart(),400);}
    });
    observer.observe(document.body,{childList:true,subtree:true});
  }

  crashCleanup=initCrash;
  initCrash();
}

function switchTab(tab) {
  const crashWrap = document.getElementById('fpvx-crash-wrap');
  if (crashWrap) {
    crashWrap.style.display = 'none';
    crashWrap.style.opacity = '0';
  }

  wrap.classList.remove('hiding');
  wrap.style.opacity = '1';
  wrap.style.transform = 'scale(1)';

  const loader = document.getElementById('fpvx-tab-loader');

  if (loader) {
    loader.classList.add('active');
    const shell = document.querySelector('.fpvx-shell');
    if (shell) {
      shell.style.filter = 'blur(4px)';
      shell.style.transition = 'filter 0.3s ease';
    }
  }

  const crashContent = document.getElementById('fpvx-crash-content-shell');
  if (crashContent) crashContent.remove();
  if (tab !== 'crash') restoreShellFromCrash();

  const bjContent = document.getElementById('fpvx-bj-content-shell');
  if (bjContent) bjContent.remove();
  if (tab !== 'blackjack') restoreShellFromBlackjack();

  matrixGrid.style.display = '';
  document.getElementById('btn-predict').style.display = '';
  document.getElementById('btn-auto-play').style.display = '';
  document.getElementById('btn-unrig').style.display = '';

  const container = document.getElementById('fpvx-towers-autoplay-container');
  if (container) container.innerHTML = '';

  setTimeout(function() {
    if (currentTab === 'towers' && tab !== 'towers') {
      const towersBtn = document.getElementById('fpvx-towers-autoplay-btn');
      if (towersBtn) towersBtn.remove();
    }

    currentTab = tab;
    document.querySelectorAll('.fpvx-tab').forEach(t => t.classList.remove('active'));
    const tabEl = document.getElementById('tab-' + tab);
    if (tabEl) tabEl.classList.add('active');

    if (tab === 'crash') {
      if (!crashScriptLoaded) {
        loadCrashPredictor();
      }

      const crashWrap = document.getElementById('fpvx-crash-wrap');
      if (crashWrap) {
        crashWrap.style.display = 'none';
        crashWrap.style.opacity = '0';
      }

      matrixGrid.style.display = 'none';
      document.getElementById('fpvx-towers-autoplay-container').innerHTML = '';
      document.getElementById('btn-predict').style.display = 'none';
      document.getElementById('btn-auto-play').style.display = 'none';
      document.getElementById('btn-unrig').style.display = 'none';
      discordUpdateUI();
      const btnSlideAutoCrash = document.getElementById('btn-slide-auto');
      if (btnSlideAutoCrash) btnSlideAutoCrash.style.display = 'none';

      setTimeout(function() {
        try {
          if (typeof buildCrashUIInShell === 'function') buildCrashUIInShell();
        } finally {
          setTimeout(function() {
            if (loader) {
              loader.classList.remove('active');
              const shell = document.querySelector('.fpvx-shell');
              if (shell) {
                shell.style.filter = '';
              }
            }
          }, 100);
        }
      }, 50);

    } else if (tab === 'mines') {
      matrixGrid.style.display = '';
      rebuildGrid();
      valConf.textContent = minesConfidence + '%';
      discordUpdateUI();
      document.getElementById('btn-predict').style.display = '';
      document.getElementById('btn-auto-play').style.display = '';
      document.getElementById('btn-unrig').style.display = '';
      const btnSlideAuto2 = document.getElementById('btn-slide-auto');
      if (btnSlideAuto2) btnSlideAuto2.style.display = 'none';

      setTimeout(function() {
        if (loader) {
          loader.classList.remove('active');
          const shell = document.querySelector('.fpvx-shell');
          if (shell) {
            shell.style.filter = '';
          }
        }
      }, 100);

    } else if (tab === 'towers') {
      matrixGrid.style.display = '';
      rebuildGrid();
      valConf.textContent = towersConfidence + '%';
      discordUpdateUI();
      document.getElementById('btn-predict').style.display = '';
      document.getElementById('btn-auto-play').style.display = 'none';
      document.getElementById('btn-unrig').style.display = '';
      const btnSlideAuto3 = document.getElementById('btn-slide-auto');
      if (btnSlideAuto3) btnSlideAuto3.style.display = 'none';
      addTowersAutoPlayButton();

      setTimeout(function() {
        if (loader) {
          loader.classList.remove('active');
          const shell = document.querySelector('.fpvx-shell');
          if (shell) {
            shell.style.filter = '';
          }
        }
      }, 100);

   } else if (tab === 'slide') {
      matrixGrid.style.display = '';
      rebuildGrid();
      valConf.textContent = slideConfidence + '%';
      discordUpdateUI();
      document.getElementById('btn-predict').style.display = '';
      document.getElementById('btn-auto-play').style.display = 'none';
      document.getElementById('btn-unrig').style.display = 'none';
      const btnSlideAuto = document.getElementById('btn-slide-auto');
      if (btnSlideAuto) {
        btnSlideAuto.style.display = '';
        btnSlideAuto.textContent = autoSlideEnabled ? '⏹ Stop Slide' : '▶ Auto Slide';
        btnSlideAuto.classList.toggle('playing', autoSlideEnabled);
      }

      scrapeSlideHistory();

      setTimeout(function() {
        if (loader) {
          loader.classList.remove('active');
          const shell = document.querySelector('.fpvx-shell');
          if (shell) {
            shell.style.filter = '';
          }
        }
      }, 100);

    } else if (tab === 'blackjack') {
      matrixGrid.style.display = 'none';
      document.getElementById('btn-predict').style.display = 'none';
      document.getElementById('btn-auto-play').style.display = 'none';
      document.getElementById('btn-unrig').style.display = 'none';
      discordUpdateUI();
      const btnSlideAutoBJ = document.getElementById('btn-slide-auto');
      if (btnSlideAutoBJ) btnSlideAutoBJ.style.display = 'none';
      document.getElementById('fpvx-towers-autoplay-container').innerHTML = '';

      setTimeout(function() {
        try {
          buildBlackjackUIInShell();
        } finally {
          setTimeout(function() {
            if (loader) {
              loader.classList.remove('active');
              const shell = document.querySelector('.fpvx-shell');
              if (shell) {
                shell.style.filter = '';
              }
            }
          }, 100);
        }
      }, 50);
    }
  }, 100);
}

document.getElementById('cfg-safe-slider').addEventListener('input', e => {
  safe = parseInt(e.target.value);
  document.getElementById('cfg-safe-txt').textContent = safe + ' Tiles';
  GM_setValue('fpvx_safe', safe);
});
document.getElementById('cfg-towers-slider').addEventListener('input', e => {
  towersTargetRows = parseInt(e.target.value);
  document.getElementById('cfg-towers-txt').textContent = towersTargetRows + ' Rows';
  GM_setValue('fpvx_tower_rows', towersTargetRows);
});
document.getElementById('cfg-ai-prov').addEventListener('change', e => {
  aiProvider = e.target.value;
  GM_setValue('fpvx_ai_provider', aiProvider);
});
document.getElementById('cfg-ai-key').addEventListener('input', e => {
  aiApiKey = e.target.value;
  GM_setValue('fpvx_ai_api_key', aiApiKey);
});
document.getElementById('cfg-ai-toggle').addEventListener('change', e => {
  aiEnabled = e.target.checked;
  GM_setValue('fpvx_ai_enabled', aiEnabled);
});
document.getElementById('btn-unredeem').addEventListener('click', () => {
  if (!licenseKey) return;
  if (confirm('Unredeem this license from this device?')) {
    licenseKey = '';
    licenseStatus = 'unverified';
    licenseExpiry = 'N/A';
    GM_setValue('fpvx_license_key', '');
    GM_setValue('fpvx_license_status', 'unverified');
    GM_setValue('fpvx_license_expiry', 'N/A');
    updateLicenseUI();
    settingsPanel.classList.remove('open');
    showOverlay();
  }
});
const dcConnectBtn = document.getElementById('btn-discord-connect-settings');
if (dcConnectBtn) dcConnectBtn.addEventListener('click', () => { discordConnect(); });
const dcReconnectBtn = document.getElementById('btn-discord-reconnect');
if (dcReconnectBtn) dcReconnectBtn.addEventListener('click', () => { discordDisconnect(); setTimeout(() => discordConnect(), 500); });
const dcDisconnectBtn = document.getElementById('btn-discord-disconnect');
if (dcDisconnectBtn) dcDisconnectBtn.addEventListener('click', () => { discordDisconnect(); });

document.getElementById('btn-auto-play').addEventListener('click', function() {
  autoPlayEnabled = !autoPlayEnabled;
  autoPlayActive = false;
  this.classList.toggle('playing', autoPlayEnabled);
  if (autoPlayEnabled) {
    this.textContent = '⏹ Auto Play';
    if (getMinesState() === 'ready') triggerAutoBet();
  } else {
    this.textContent = '▶ Auto Play';
    if (gameWatcherInterval) {
      clearInterval(gameWatcherInterval);
      gameWatcherInterval = null;
    }
    autoPlayActive = false;
  }
});

document.getElementById('btn-unrig').addEventListener('click', function() {
  if (isUnrigging) return;
  runUnrig();
});

document.getElementById('btn-slide-auto').addEventListener('click', function() {
  autoSlideEnabled = !autoSlideEnabled;
  this.classList.toggle('playing', autoSlideEnabled);
  this.textContent = autoSlideEnabled ? '⏹ Stop Slide' : '▶ Auto Slide';
  if (autoSlideEnabled && currentTab === 'slide') {
    runSlideAutoLoop();
  } else {
    if (slideAutoPlayInterval) { clearInterval(slideAutoPlayInterval); slideAutoPlayInterval = null; }
  }
});

document.getElementById('btn-slide-auto').style.display = 'none';

const streamerStyleElement = document.createElement('style');
streamerStyleElement.id = 'fpvx-streamer-blur-style';
document.head.appendChild(streamerStyleElement);

const streamerToggle = document.getElementById('fpvx-streamer-toggle');
streamerToggle.addEventListener('click', () => {
  streamerMode = !streamerMode;
  GM_setValue('fpvx_streamer_mode', streamerMode);
  streamerToggle.classList.toggle('on', streamerMode);
  setStreamerMode(streamerMode);
});

function setStreamerMode(enabled) {
  if (enabled) {
    streamerStyleElement.textContent = `
      [class*="headerUser"],[class*="header-user"],[class*="HeaderUser"],
      img[alt="User avatar"],img[alt="user avatar"],img[alt="Avatar"],
      [class*="userAvatar"],[class*="user-avatar"],[class*="profilePicture"],
      [class*="profileName"],[class*="profile-name"],[class*="userName"],
      [class*="user-name"],[class*="accountName"],[class*="account-name"],
      [class*="balanceAmount"],[class*="balance-module"],[class*="Balance"],
      aside[class*="chat"],[class*="chat-module"],
      [class*="statistics-module"],[class*="statisticsTable"] {
        filter: blur(9px) !important;
        user-select: none !important;
        pointer-events: none !important;
        transition: filter 0.25s ease !important;
      }
    `;
    valBalance.classList.add('streamer-blur');
  } else {
    streamerStyleElement.textContent = '';
    valBalance.classList.remove('streamer-blur');
  }
}

if (streamerMode) {
  streamerToggle.classList.add('on');
  setStreamerMode(true);
}

function toggleBlurPrivate() {
  blurPrivate = !blurPrivate;
  GM_setValue('fpvx_blur_private', blurPrivate);
  document.querySelectorAll('.fpvx-card-val').forEach(el => el.classList.toggle('fpvx-blurred', blurPrivate));
}
document.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.key === 'B') toggleBlurPrivate(); });

function showOverlay() {
  overlay.classList.remove('hidden');
  wrap.style.display = 'none';
}
function hideOverlay() {
  overlay.classList.add('hidden');
  wrap.style.display = 'flex';
}

async function checkLicense(licenseKey, deviceId) {
  licenseKey = (licenseKey || '').trim();
  if (!licenseKey || !deviceId) throw new Error('Invalid Authorization Data');

  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1aWV2em5obGN0bHpoZXFkbGpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMjUzNzEsImV4cCI6MjA5NzcwMTM3MX0.dPYP6AnndRq5yCijj3eRzxHGkUUm40srrSplBdwlIQQ';

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SUPABASE_URL}/functions/v1/validate`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SB_KEY}`,
        'apikey': SB_KEY
      },
      data: JSON.stringify({ licenseKey, deviceId }),
      onload(response) {
        try {
          const data = JSON.parse(response.responseText);
          if (!data.valid) reject(new Error(data.reason || 'Invalid License'));
          else resolve(data);
        } catch { reject(new Error('Invalid License')); }
      },
      onerror() { reject(new Error('Failed to connect to license server')); }
    });
  });
}

async function verifyKeyAuth(key, quiet = false) {
  key = (key || '').trim();
  if (!key) { if (!quiet) alert('Please enter a license key!'); return false; }
  try {
    const result = await checkLicense(key, deviceId);
    licenseKey = key;
    licenseStatus = 'verified';
    lastLicenseOk = Date.now();
    if (result.session) currentSession = result.session;

    if (result.license_type === 'monthly' && result.expires_at) {
      const expiryDate = new Date(result.expires_at);
      if (!isNaN(expiryDate)) {
        licenseExpiry = expiryDate.toLocaleDateString();
      } else {
        licenseExpiry = 'Invalid Date';
      }
    } else if (result.license_type === 'lifetime') {
      licenseExpiry = 'Lifetime';
    } else {
      licenseExpiry = 'Unknown';
    }

    GM_setValue('fpvx_license_key', licenseKey);
    GM_setValue('fpvx_license_status', licenseStatus);
    GM_setValue('fpvx_license_expiry', licenseExpiry);
    updateLicenseUI();
    return true;
  } catch (err) {
    licenseStatus = 'unverified';
    GM_setValue('fpvx_license_status', licenseStatus);
    if (!quiet) alert(err.message);
    updateLicenseUI();
    return false;
  }
}

async function revalidateLicense() {
  if (revalidating || !licenseKey) return;
  revalidating = true;
  try {
    await verifyKeyAuth(licenseKey, true);
  } finally { revalidating = false; }
}

async function ensureLicensed() {
  if (licenseStatus === 'verified' && (Date.now() - lastLicenseOk) > LICENSE_RECHECK_MS) await revalidateLicense();
  return licenseStatus === 'verified';
}

const HISTORY_LIMIT = 200;

async function fetchHistoryRows() {
  const size = 50, pages = Math.ceil(HISTORY_LIMIT / size), results = [];
  function extractRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of ['data','history','games','records','results']) {
      if (Array.isArray(payload[key])) return payload[key];
      if (payload[key] && typeof payload[key] === 'object') { const r = extractRows(payload[key]); if (r.length) return r; }
    }
    return [];
  }
  for (let page = 0; page < pages; page++) {
    try {
      const token = getAuthToken();
      const headers = { 'Accept': 'application/json' };
      if (token) headers['x-auth-token'] = token;
      const resp = await fetch(`https://bloxflip.com/api/games/mines/history?size=${size}&page=${page}`, { credentials: 'include', headers });
      if (!resp.ok) break;
      const rows = extractRows(await resp.json());
      if (!rows.length) break;
      results.push(...rows);
      if (results.length >= HISTORY_LIMIT) break;
    } catch { break; }
    await sleep(35);
  }
  return results.slice(0, HISTORY_LIMIT);
}

function saveTowersGridHistory(){try{GM_setValue('fpvx_towers_grid',JSON.stringify(towersGridHistory));}catch{}}
function normalizeTowersRow(row){if(!row||typeof row!=='object')return null;const bombKeys=['bombLocations','bombs','bomb_locations','mineLocations','mines','bombCols','bomb_cols'];const pathKeys=['path','selectedTiles','selected_tiles','clicks','tiles','selections'];let bombs=[],path=[];for(const key of bombKeys){const v=row[key];if(Array.isArray(v)){bombs=v.map(n=>Number(n)).filter(n=>Number.isFinite(n)&&n>=0&&n<TOWER_COLS);if(bombs.length)break;}}for(const key of pathKeys){const v=row[key];if(Array.isArray(v)&&v.length>=2){path=v.map(n=>Number(n)).filter(n=>Number.isFinite(n)&&n>=0&&n<TOWER_COLS);if(path.length>=2)break;}}if(!bombs.length&&path.length>=TOWER_ROWS)path=path.slice(0,TOWER_ROWS);if(!bombs.length){for(const key of pathKeys){const v=row[key];if(Array.isArray(v)&&v.length>=TOWER_ROWS){path=v.slice(0,TOWER_ROWS).map(n=>Number(n)).filter(n=>Number.isFinite(n)&&n>=0&&n<TOWER_COLS);if(path.length>=TOWER_ROWS)break;}}}if(bombs.length<TOWER_ROWS&&Array.isArray(row.rows)){bombs=row.rows.map(r=>{const n=Number(r?.bombCol??r?.bomb??r?.mineCol??r?.col);return Number.isFinite(n)?n:null;}).filter(n=>n!==null&&n>=0&&n<TOWER_COLS);}if(!bombs.length&&!path.length)return null;return{bombs:bombs.length?bombs.slice(0,TOWER_ROWS):null,path:path.length?path.slice(0,TOWER_ROWS):null};}
function applyTowersHistoryRows(rows){if(!Array.isArray(rows)||!rows.length)return;rows.forEach((raw,i)=>{const parsed=normalizeTowersRow(raw);if(!parsed)return;const w=Math.exp(-i/45);if(parsed.bombs){for(let r=0;r<TOWER_ROWS;r++){const bombCol=Number.isFinite(parsed.bombs[r])?parsed.bombs[r]:null;if(bombCol===null)continue;for(let c=0;c<TOWER_COLS;c++){if(!towersGridHistory[r][c])towersGridHistory[r][c]={safe:0,bombs:0,recent:0};if(c===bombCol){towersGridHistory[r][c].bombs+=w;towersGridHistory[r][c].recent+=w*.6;}else{towersGridHistory[r][c].safe+=w;towersGridHistory[r][c].recent+=w*.6;}}}}if(parsed.path){for(let r=1;r<parsed.path.length&&r<TOWER_ROWS;r++){const a=parsed.path[r-1],b=parsed.path[r];if(Number.isFinite(a)&&Number.isFinite(b))towersColTransitions[r][a][b]+=w;}}});try{GM_setValue('fpvx_towers_trans',JSON.stringify(towersColTransitions));}catch{}saveTowersGridHistory();}
async function fetchTowersHistoryRows(){const size=50,pages=4,results=[];function extractRows(payload){if(Array.isArray(payload))return payload;if(!payload||typeof payload!=='object')return[];for(const key of['data','history','games','records','results']){if(Array.isArray(payload[key]))return payload[key];if(payload[key]&&typeof payload[key]==='object'){const r=extractRows(payload[key]);if(r.length)return r;}}return[];}for(let page=0;page<pages;page++){try{const token=getAuthToken(),headers={'Accept':'application/json'};if(token)headers['x-auth-token']=token;const resp=await fetch(`https://bloxflip.com/api/games/towers/history?size=${size}&page=${page}`,{credentials:'include',headers});if(!resp.ok)break;const rows=extractRows(await resp.json());if(!rows.length)break;results.push(...rows);if(results.length>=200)break;}catch{break;}await sleep(35);}return results.slice(0,200);}
function getMinesGrid() {
  return document.querySelector('[class*="minesGameContainer"]') || document.querySelector('[class*="MinesGameContainer"]') || document.querySelector('[class*="mines_board"]') || document.querySelector('.game-mines-board') || null;
}
function getBloxflipTiles() {
  const board = getMinesGrid();
  if (!board) return [];
  let tiles = Array.from(board.querySelectorAll('button'));
  if (tiles.length === 25) return tiles;
  tiles = Array.from(board.querySelectorAll('[role="button"]'));
  if (tiles.length === 25) return tiles;
  tiles = Array.from(board.querySelectorAll('div[class*="tile"], div[class*="square"], div[class*="item"]'));
  if (tiles.length === 25) return tiles;
  tiles = Array.from(board.children).filter(c => c.tagName === 'DIV' || c.tagName === 'BUTTON');
  if (tiles.length === 25) return tiles;
  return [];
}
function clearBloxGlow() {
  getBloxflipTiles().forEach(tile => {
    tile.classList.remove('fpvx-site-tile', 'fpvx-predicted');
    const star = tile.querySelector('.fpvx-site-star');
    if (star) star.remove();
  });
}
function highlightBlox(safes) {
  if (!safes || !safes.length) return;
  const t = getTheme(themeId);
  const tiles = getBloxflipTiles();
  if (!tiles.length) return;
  clearBloxGlow();
  safes.forEach(index => {
    if (!tiles[index]) return;
    const el = tiles[index];
    el.classList.add('fpvx-site-tile', 'fpvx-predicted');
    const star = document.createElement('div');
    star.className = 'fpvx-site-star';
    const img = document.createElement('img');
    img.src = 'https://i.imgur.com/W22hlEk.png';
    img.style.cssText = 'width:64px;height:64px;object-fit:contain;filter:drop-shadow(0 0 15px var(--fpvx-accent));';
    star.appendChild(img);
    el.appendChild(star);
  });
}
const glowStyle = document.createElement('style');
glowStyle.textContent = `.fpvx-glow { box-shadow: inset 0 0 15px var(--fpvx-glow-soft), 0 0 12px var(--fpvx-glow) !important; border: 2px solid var(--fpvx-glow) !important; background-color: var(--fpvx-glow-soft) !important; opacity: 0.95 !important; filter: brightness(1.2) !important; outline: 2px solid var(--fpvx-glow) !important; outline-offset: -2px !important; }`;
document.head.appendChild(glowStyle);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resetPrediction() {
  busy = false;
  activeHighlights = [];
  clearBloxGlow();
  matrixGrid.querySelectorAll('.fpvx-tile').forEach(t => {
    t.classList.remove('safe');
    t.style.borderColor = '';
    t.style.boxShadow = '';
  });
  if (currentTab === 'mines') {
    valConf.textContent = minesConfidence + '%';
  } else if (currentTab === 'towers') {
    valConf.textContent = towersConfidence + '%';
  } else if (currentTab === 'slide') {
    valConf.textContent = slideConfidence + '%';
  }
}
function getMinesState() {
  if (currentTab === 'slide') {
    var btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"], button[class*="startGame"]');
    if (!btn) return 'none';
    var text = btn.textContent.toLowerCase().replace(/\s+/g, '');
    if (text.includes('cashout') || text.includes('waiting') || btn.disabled) return 'playing';
    return 'ready';
  }
  if (checkGameLost()) return 'ready';
  var btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"], button[class*="startGame"]');
  if (!btn) return 'none';
  var text = btn.textContent.toLowerCase().replace(/\s+/g, '');
  if (text.includes('cashout') || text.includes('uncover') || text.includes('waiting') || btn.disabled) return 'playing';
  return 'ready';
}

function getTowersState() {
  var btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"], button[class*="startGame"]');
  if (!btn) return 'none';
  var text = btn.textContent.toLowerCase().trim();
  if (text.includes('cashout') || text.includes('waiting') || btn.disabled) return 'playing';
  return 'ready';
}

function getMineButtons() {
  var buttons = [].slice.call(document.querySelectorAll("[aria-label^=\"Open mine\"]"));
  if (buttons.length === 25) return buttons;
  if (buttons.length > 25) return buttons.slice(buttons.length - 25);
  return buttons;
}

function checkGameLost() {
  if (!predictedTiles.length && !autoPlayEnabled) return false;
  try {
    var elements = document.querySelectorAll('button,div,span,p');
    for (var i = 0; i < elements.length; i++) {
      var text = (elements[i].innerText || elements[i].textContent || '').trim();
      if (!text || text.length > 90) continue;
      if (/stop loss|losses/i.test(text)) continue;
      if (/\b(you lost|lost|exploded|game over)\b/i.test(text)) return true;
    }
  } catch (err) {}
  var btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"]');
  var text = btn ? btn.textContent.toLowerCase().trim() : '';
  var buttonCount = getMineButtons().length;
  return !!predictedTiles.length && buttonCount > 0 && buttonCount < 25 && /bet|play|start/i.test(text);
}

function triggerAutoBet() {
  if (currentTab === 'slide') return;
  if (!autoPlayEnabled || autoPlayActive) return;
  if (getMinesState() === 'ready') {
    autoPlayActive = true;
    var btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"], button[class*="startGame"]');
    if (btn && !btn.disabled) {
      setTimeout(function() { btn.click(); }, 300 + Math.random() * 200);
    } else {
      autoPlayActive = false;
    }
  }
}

function autoClickTilesFunc(tiles, onComplete) {
  if (!autoPlayEnabled) {
    autoPlayActive = false;
    return;
  }
  var buttons = getMineButtons();
  if (buttons.length !== 25) {
    if (onComplete) onComplete();
    return;
  }
  var index = 0;
  function clickNext() {
    if (!autoPlayEnabled) {
      autoPlayActive = false;
      return;
    }
    if (checkGameLost() || getMinesState() !== 'playing') {
      resetGameState();
      return;
    }
    if (index >= tiles.length) {
      if (onComplete) setTimeout(onComplete, 500);
      return;
    }
    if (buttons[tiles[index]]) buttons[tiles[index]].click();
    index++;
    setTimeout(function() {
      if (checkGameLost() || getMinesState() !== 'playing') {
        resetGameState();
        return;
      }
      clickNext();
    }, 300 + Math.random() * 250);
  }
  setTimeout(clickNext, 400);
}

function autoCashout() {
  if (!autoPlayEnabled) {
    autoPlayActive = false;
    return;
  }
  var attempts = 0;
  var interval = setInterval(function() {
    if (!autoPlayEnabled) {
      clearInterval(interval);
      autoPlayActive = false;
      return;
    }
    if (checkGameLost()) {
      clearInterval(interval);
      resetGameState();
      return;
    }
    var btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"]');
    var text = btn ? btn.textContent.toLowerCase().trim() : '';
    if (predictedTiles.length && !text.includes('cashout') && getMinesState() !== 'playing') {
      clearInterval(interval);
      resetGameState();
      return;
    }
    if (btn && text.includes('cashout') && !btn.disabled) {
      clearInterval(interval);
      setTimeout(function() {
        btn.click();
        autoPlayActive = false;
        consecutiveLosses = 0;
        setTimeout(function() {
          if (autoPlayEnabled) {
            triggerAutoBet();
          }
        }, 1500 + Math.random() * 500);
      }, 300 + Math.random() * 300);
      return;
    }
    attempts++;
    if (attempts > 40) {
      clearInterval(interval);
      autoPlayActive = false;
      setTimeout(function() {
        if (autoPlayEnabled && getMinesState() === 'ready') {
          triggerAutoBet();
        }
      }, 1000);
    }
  }, 200);
}

function resetGameState() {
  gameResetPending = true;
  if (gameWatcherInterval) {
    clearInterval(gameWatcherInterval);
    gameWatcherInterval = null;
  }
  clearBloxGlow();
  predictedTiles = [];
  autoPlayActive = false;
  isPredicting = false;
  resetGrid();
  if (autoPlayEnabled && !isTowersMode && currentTab !== 'slide') {
    setTimeout(function() {
      if (autoPlayEnabled && !autoPlayActive && !checkStopLoss()) {
        consecutiveLosses++;
        triggerAutoBet();
      }
    }, 1800 + Math.random() * 600);
  }
}

function resetGrid() {
  isIdle = true;
  isPredicting = false;
  predictedTiles = [];
  clearBloxGlow();
  matrixGrid.querySelectorAll('.fpvx-tile').forEach(t => t.className = 'fpvx-tile');
  if (gameWatcherInterval) {
    clearInterval(gameWatcherInterval);
    gameWatcherInterval = null;
  }
  scannerOverlay.style.display = 'none';
  var descEl = document.querySelector('#val-status');
  if (descEl) descEl.textContent = discordConnected ? '@' + discordUsername : '';
}

function checkStopLoss() {
  var limit = parseInt(GM_getValue('fpvx_stop_loss', 0));
  if (limit > 0 && consecutiveLosses >= limit) {
    autoPlayEnabled = false;
    autoPlayActive = false;
    var btn = document.getElementById('btn-auto-play');
    if (btn) {
      btn.textContent = '▶ Auto Play';
      btn.classList.remove('playing');
    }
    return true;
  }
  return false;
}

async function runMinesPrediction() {
  if (!(await ensureLicensed())) return;
  if (busy) return;
  busy = true;
  scannerOverlay.style.display = 'flex';

  try {
    const rows = await fetchHistoryRows();
    let result = await callPredict('mines', { rows, safeCount: safe, previousPrediction: lastPrediction, predictionHistory });
    let safes = result.safes;
    let confidence = result.confidence;

    if (aiEnabled && aiApiKey) {
      const aiResult = await callAIForMines(rows, safe);
      if (aiResult && aiResult.safes && aiResult.safes.length >= safe) {
        const blended = new Set();
        const aiSafes = aiResult.safes.slice(0, Math.ceil(safe * 0.6));
        const localSafes = safes.slice(0, safe);
        aiSafes.forEach(s => blended.add(s));
        localSafes.forEach(s => { if (!blended.has(s)) blended.add(s); });
        safes = Array.from(blended).slice(0, safe);
        confidence = Math.min(95, Math.round((aiResult.confidence || 80) * 0.4 + confidence * 0.6));
      }
    }

    lastPrediction = safes.slice();
    predictionHistory = [lastPrediction, ...(Array.isArray(predictionHistory) ? predictionHistory : [])].slice(0, 8);
    GM_setValue('fpvx_last_prediction', lastPrediction);
    GM_setValue('fpvx_prediction_history', predictionHistory);
    minesConfidence = confidence;
    predictedTiles = safes.slice();

    await sleep(600);
    scannerOverlay.style.display = 'none';
    matrixGrid.querySelectorAll('.fpvx-tile').forEach(t => t.classList.remove('safe'));
    safes.forEach(idx => {
      const el = matrixGrid.querySelector(`[data-idx="${idx}"]`);
      if (el) el.classList.add('safe');
    });
    valConf.textContent = minesConfidence + '%';
    activeHighlights = safes.slice();
    highlightBlox(activeHighlights);

    if (autoPlayEnabled && autoPlayActive) {
      autoClickTilesFunc(safes, function() {
        if (autoPlayEnabled && !checkStopLoss()) {
          setTimeout(function() { autoCashout(); }, 500);
        }
      });
    }
  } catch (e) {
    scannerOverlay.style.display = 'none';
  }
  busy = false;
}

async function callAIForMines(history, safeCount) {
  if (!aiEnabled || !aiApiKey) return null;
  const prompt = `Analyze this Mines game history and predict ${safeCount} safest cells (0-24) in a 5x5 grid. Return JSON with "safes": [indices] and "confidence": 0-100. History: ${JSON.stringify(history.slice(0,30))}`;
  const result = await callAIAPI(prompt);
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed.safes && Array.isArray(parsed.safes)) {
      const safes = parsed.safes.map(n => Number(n)).filter(n => !isNaN(n) && n >= 0 && n < 25);
      return { safes, confidence: parsed.confidence || 75 };
    }
  } catch {}
  return null;
}

async function runTowersPrediction() {
  if (!(await ensureLicensed())) return;
  if (busy) return;
  busy = true;
  scannerOverlay.style.display = 'flex';

  let predictionSuccess = false;
  let timeoutId = null;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(false);
    }, 8000);
  });

  try {
    const fetchPromise = fetchTowersHistoryRows();
    const result = await Promise.race([fetchPromise, timeoutPromise]);

    if (result === false) {
      scannerOverlay.style.display = 'none';
      busy = false;
      return;
    }

    const rows = result;
    if (rows && rows.length) {
      applyTowersHistoryRows(rows);
    }

    const pred = await callPredict('towers', {
      gridHistory: towersGridHistory,
      colTransitions: towersColTransitions,
      lockedPath: towersLockedPath,
      pathRows: towersTargetRows
    });
    towersLockedPath = pred.locked || pred.path;
    towersPathGenerated = true;
    towersConfidence = pred.confidence;
    predictionSuccess = true;
  } catch (error) {
    predictionSuccess = false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  scannerOverlay.style.display = 'none';

  if (predictionSuccess) {
    matrixGrid.querySelectorAll('.fpvx-tile').forEach(t => t.classList.remove('safe'));
    const startRow = TOWER_ROWS - towersTargetRows;
    for (let r = 0; r < towersTargetRows; r++) {
      const actualRow = startRow + r;
      const col = towersLockedPath[actualRow] || 0;
      const idx = actualRow * TOWER_COLS + col;
      const el = matrixGrid.querySelector(`[data-idx="${idx}"]`);
      if (el) el.classList.add('safe');
    }
    valConf.textContent = towersConfidence + '%';
  }

  busy = false;
}

function _ingestSlideRow(x,seen){
  let col=(x.color||x.slideColor||x.result||x.outcome||'').toString().toLowerCase();
  const rawMult=x.multiplier??x.mult??x.payout??x.crashPoint;
  const m=parseFloat(rawMult);
  if(!col&&!isNaN(m)){col=m>=10?'yellow':m>=3?'purple':'red';}
  if(!/yellow|red|pink|purple/.test(col))return false;
  col=col.replace('pink','red');
  const key=x.id||x.roundId||x.gameId||x.ts||x.createdAt||x.time;
  if(key!=null&&seen.has(key))return false;
  if(key!=null)seen.add(key);
  slideHistory.push({color:col,multiplier:col==='yellow'?14:2,timestamp:typeof key==='number'?key:Date.now()});
  return true;
}

function _parseSlideRows(raw){
  try{
    const d=JSON.parse(raw);
    const rows=d.data||d.history||d.games||d.records||d.results||(Array.isArray(d)?d:[]);
    return Array.isArray(rows)?rows:[];
  }catch{return[];}
}

async function scrapeSlideHistory() {
  const TARGET=1200;
  const seen=new Set(slideHistory.map(x=>x.timestamp||x.id).filter(v=>v!=null));
  const bases=[
    'https://bloxflip.com/api/games/slide/history',
    'https://bloxflip.com/api/slide/history',
    'https://bloxflip.com/api/slide/rounds',
    'https://bloxflip.com/api/user/slide/history',
  ];
  let added=0;
  const token=getAuthToken();
  const headers={'Accept':'application/json'};
  if(token)headers['x-auth-token']=token;
  for(const base of bases){
    if(slideHistory.length+added>=TARGET)break;
    let pageEmpty=0;
    for(let page=0;page<15;page++){
      const url=`${base}?limit=200&page=${page}&offset=${page*200}`;
      let rows=[];
      try{
        const resp=await fetch(url,{credentials:'include',headers});
        if(!resp.ok)break;
        rows=_parseSlideRows(await resp.text());
      }catch{break;}
      if(!rows.length){if(++pageEmpty>=2)break;continue;}
      pageEmpty=0;
      let pageAdded=0;
      for(const x of rows){if(_ingestSlideRow(x,seen)){added++;pageAdded++;}}
      if(pageAdded===0)break;
      if(slideHistory.length+added>=TARGET)break;
      await sleep(120);
    }
  }
  if(added===0){
    try {
      const endpoints = [
        'https://bloxflip.com/api/games/slide/history?size=100',
        'https://bloxflip.com/api/games/slide/history',
        'https://bloxflip.com/api/slide/history?limit=100'
      ];
      for (const url of endpoints) {
        try {
          const resp = await fetch(url, { credentials: 'include', headers });
          if (!resp.ok) continue;
          const rows = _parseSlideRows(await resp.text());
          if (rows.length > 0) {
            for (const row of rows) { if(_ingestSlideRow(row,seen))added++; }
            break;
          }
        } catch {}
      }
    } catch {}
  }
  if(added===0){
    try {
      const selectors = '[class*="slideHistory"] span,[class*="slide-history"] span,[class*="SlideHistory"] span,[class*="roundHistory"] span,[class*="round-history"] span,[class*="historyItem"],[class*="history-item"]';
      const chips = [...document.querySelectorAll(selectors)];
      const colorWords = ['yellow', 'red', 'pink', 'purple'];
      chips.forEach(el => {
        const txt = (el.textContent || '').trim().toLowerCase();
        for (const c of colorWords) {
          if (txt.includes(c)) {
            const isYellow = c === 'yellow';
            const col = isYellow ? 'yellow' : c === 'pink' ? 'red' : c;
            const dedupKey = col + '_' + slideHistory.length + '_' + Date.now();
            if (!seen.has(dedupKey)) {
              slideHistory.push({ color: col, multiplier: isYellow ? 14 : 2, timestamp: Date.now() });
              seen.add(dedupKey);
              added++;
            }
            break;
          }
        }
      });
    } catch {}
  }
  if(added>0){
    if(slideHistory.length>5000)slideHistory.splice(0,slideHistory.length-5000);
    GM_setValue('fpvx_slide_history', JSON.stringify(slideHistory.slice(-500)));
  }
  return slideHistory.length > 0;
}

function loadSlideHistoryFromStorage() {
  try {
    const saved = GM_getValue('fpvx_slide_history', null);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        slideHistory = parsed;
      }
    }
  } catch {}
}
loadSlideHistoryFromStorage();

async function scrapeSlideSeed(){
  const existing=_ActiveSlideSeed.get();
  const modalEls=[...document.querySelectorAll('[class*="fairness" i] input,[class*="provably" i] input,[class*="modal" i] input,[role="dialog"] input')];
  for(const el of modalEls){
    try{
      const v=(el.value||'').trim();
      if(!v||v.length<10||/not\s+revealed/i.test(v))continue;
      const ph=(el.placeholder||el.getAttribute('aria-label')||'').toLowerCase();
      if(/hash/i.test(ph))continue;
      if(/public|client/i.test(ph)){slideClientSeed=v;continue;}
      if(existing&&existing.seed===v){return;}
      slideNonceOffset=0;_slideRoundPredicted=false;
      _ActiveSlideSeed.set(v,slideClientSeed,slideNonce);
      return;
    }catch{}
  }
  const token=getAuthToken();
  const headers={'Accept':'application/json'};
  if(token)headers['x-auth-token']=token;
  const apiUrls=[
    'https://bloxflip.com/api/user/seeds',
    'https://bloxflip.com/api/user/seeds/current',
    'https://bloxflip.com/api/slide/history?limit=3',
    'https://bloxflip.com/api/games/slide/history?limit=3',
    'https://bloxflip.com/api/slide/current',
  ];
  for(const u of apiUrls){
    try{
      const resp=await fetch(u,{credentials:'include',headers});
      if(!resp.ok)continue;
      const j=await resp.json();
      const rows=j.data||j.history||j.games||j.rounds||(Array.isArray(j)?j:[j]);
      const arr=Array.isArray(rows)?rows:[rows];
      for(const row of arr){
        if(!row||typeof row!=='object')continue;
        const ss=row.serverSeed||row.server_seed||row.privateKey||row.privateSeed||row.unhashedServerSeed||row.seed||row.revealedSeed||row.secretSeed;
        const cs=row.clientSeed||row.client_seed||row.publicSeed||row.publicKey||row.userSeed||'';
        const n=row.nonce??row.slideNonce??row.roundNonce??row.round??row.id??row.gameId;
        if(cs&&cs.length>3)slideClientSeed=cs;
        if(n!==undefined&&n!==null){const pn=parseInt(n);if(!isNaN(pn)&&pn>0){if(pn!==slideNonce){slideNonceOffset=0;_slideRoundPredicted=false;}slideNonce=pn;}}
        if(!ss||typeof ss!=='string'||ss.length<10||/not\s+revealed/i.test(ss))continue;
        if(existing&&existing.seed===ss){return;}
        slideNonceOffset=0;_slideRoundPredicted=false;
        const revN=parseInt(n)||slideNonce||0;
        _ActiveSlideSeed.set(ss,cs||slideClientSeed,revN);
        return;
      }
    }catch{}
  }
  try{
    const nd=JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent||'{}');
    const pp=nd?.props?.pageProps||{};
    const gs=pp.game||pp.slideGame||pp.currentGame||{};
    const ss=gs.serverSeed||gs.privateKey||gs.privateSeed||gs.seed;
    const cs=gs.clientSeed||gs.publicSeed||gs.publicKey||'';
    const n=gs.nonce??gs.slideNonce??gs.roundId;
    if(cs&&cs.length>3)slideClientSeed=cs;
    if(n!==undefined&&n!==null){const pn=parseInt(n);if(!isNaN(pn)&&pn>0){if(pn!==slideNonce){slideNonceOffset=0;_slideRoundPredicted=false;}slideNonce=pn;}}
    if(ss&&ss.length>10&&!/not\s+revealed/i.test(ss)){
      if(existing&&existing.seed===ss){return;}
      slideNonceOffset=0;_slideRoundPredicted=false;
      _ActiveSlideSeed.set(ss,cs||slideClientSeed,parseInt(n)||slideNonce||0);return;
    }
  }catch{}
}

async function runSlidePrediction() {
  if (!(await ensureLicensed())) return;
  if (busy) return;
  busy = true;
  scannerOverlay.style.display = 'flex';

  try {
    await scrapeSlideHistory();
    await scrapeSlideSeed();
    const result = await callPredict('slide', {
      slideHistory,
      serverSeed: _ActiveSlideSeed.get()?.seed || null,
      clientSeed: _ActiveSlideSeed.get()?.cs || slideClientSeed || 'fpvx',
      nonce: _ActiveSlideSeed.get()?.nonce ?? slideNonce ?? 0
    });
    if (result) {
      slidePrediction = result;
      slideConfidence = result.conf || 50;

      const colorMap = { yellow: 0, red: 1, purple: 2, pink: 1 };
      const idx = colorMap[result.color] || 1;

      matrixGrid.querySelectorAll('.fpvx-tile').forEach(t => {
        t.classList.remove('safe');
        t.style.borderColor = '';
        t.style.boxShadow = '';
      });

      const el = matrixGrid.querySelector(`[data-idx="${idx}"]`);
      if (el) {
        el.classList.add('safe');
        const hex = idx === 0 ? '#f59e0b' : idx === 1 ? '#ef4444' : '#a855f7';
        el.style.borderColor = hex;
        el.style.boxShadow = '0 0 12px ' + hex + '44, inset 0 0 20px ' + hex + '11';
      }

      const bars = matrixGrid.querySelectorAll('.slide-bar-fill');
      const pcts = matrixGrid.querySelectorAll('.slide-pct');
      const scores = result.scores || null;
      if (scores) {
        const sY = scores.yellow || 0, sR = scores.red || 0, sPu = scores.purple || 0;
        const sTotal = sY + sR + sPu || 1;
        const vals = [sY / sTotal, sR / sTotal, sPu / sTotal];
        for (let i = 0; i < 3; i++) {
          const pct = Math.round(vals[i] * 100);
          if (bars[i]) bars[i].style.width = pct + '%';
          if (pcts[i]) pcts[i].textContent = pct + '%';
        }
      } else {
        const WINDOW = 30;
        const recent = slideHistory.slice(-WINDOW);
        const total = recent.length;
        if (total > 0) {
          const yCount = recent.filter(x => x.color === 'yellow').length;
          const rCount = recent.filter(x => x.color === 'red' || x.color === 'pink').length;
          const puCount = recent.filter(x => x.color === 'purple').length;
          const bases = [yCount/total, rCount/total, puCount/total];
          for (let i = 0; i < 3; i++) {
            const pct = Math.round(bases[i] * 100);
            if (bars[i]) bars[i].style.width = pct + '%';
            if (pcts[i]) pcts[i].textContent = pct + '%';
          }
        }
      }

      valConf.textContent = slideConfidence + '%';
      const histInfo = (result.historySize || 0) > 0 ? ` (${result.historySize}r)` : '';
      const modeLabel = result.mode === 'exact' ? 'EXACT' : result.mode === 'hash' ? 'HASH' : 'STAT';
      document.getElementById('val-status').textContent = `${result.color.toUpperCase()} ${result.multiplier}x ${modeLabel}${histInfo}`;

      if (autoSlideEnabled && currentTab === 'slide') {
        setTimeout(() => executeSlideAutoPlay(result), 300);
      }
    }
  } catch (e) {
    console.error('Slide prediction error:', e);
  }

  scannerOverlay.style.display = 'none';
  busy = false;
}

function findSlideBetButton(color) {
  const btns = [...document.querySelectorAll('button')];
  if (color === 'yellow') {
    return btns.find(b => {
      const txt = (b.textContent || '').toLowerCase();
      return (txt.includes('14') || txt.includes('yellow')) && !b.disabled && b.getBoundingClientRect().width > 10;
    });
  }
  const isRed = color === 'red' || color === 'pink';
  const twoXBtns = btns.filter(b => {
    const txt = (b.textContent || '').toLowerCase();
    return (txt.includes('2x') || txt.includes('2\u00d7') || txt.includes('red') || txt.includes('pink') || txt.includes('purple')) && !b.disabled && b.getBoundingClientRect().width > 10;
  });
  if (isRed) {
    return twoXBtns[0] || btns.find(b => (b.textContent || '').toLowerCase().includes('red') && !b.disabled);
  }
  return twoXBtns[1] || twoXBtns[0] || btns.find(b => (b.textContent || '').toLowerCase().includes('purple') && !b.disabled);
}

function executeSlideAutoPlay(result) {
  const color = result.color;
  const targetBtn = findSlideBetButton(color);
  if (targetBtn) {
    targetBtn.click();
    document.getElementById('val-status').textContent = `Auto bet: ${color.toUpperCase()}`;
  } else {
    document.getElementById('val-status').textContent = `Could not find ${color} button`;
  }
}

async function runSlideAutoLoop() {
  if (!autoSlideEnabled || currentTab !== 'slide') return;

  const startBtn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"], button[class*="startGame"]');
  if (!startBtn) return;
  const btnText = startBtn.textContent.toLowerCase();
  const isWaiting = btnText.includes('waiting') || btnText.includes('cashout') || startBtn.disabled;
  if (isWaiting) return;

  await runSlidePrediction();
  if (slidePrediction) {
    executeSlideAutoPlay(slidePrediction);
  }

  if (slideAutoPlayInterval) clearInterval(slideAutoPlayInterval);
  slideAutoPlayInterval = setInterval(async () => {
    if (!autoSlideEnabled || currentTab !== 'slide') {
      clearInterval(slideAutoPlayInterval);
      slideAutoPlayInterval = null;
      return;
    }
    const btn = document.querySelector('.gameBetSubmit, button[class*="betSubmit"], button[class*="startGame"]');
    if (!btn) return;
    const txt = btn.textContent.toLowerCase();
    const waiting = txt.includes('waiting') || txt.includes('cashout') || btn.disabled;
    if (!waiting) {
      await runSlidePrediction();
      if (slidePrediction) {
        executeSlideAutoPlay(slidePrediction);
      }
    }
  }, 3000);
}

let towersAutoPlay = false;
let towersAutoPlayInterval = null;
let towersAutoPlayRunning = false;

function addTowersAutoPlayButton() {
  const existingBtn = document.getElementById('fpvx-towers-autoplay-btn');
  if (existingBtn) {
    existingBtn.remove();
  }

  const container = document.getElementById('fpvx-towers-autoplay-container');
  if (!container) return;
  container.innerHTML = '';

  const btn = document.createElement('button');
  btn.id = 'fpvx-towers-autoplay-btn';
  btn.className = 'fpvx-btn-action auto-play-btn';
  btn.textContent = '▶ Auto Play';
  btn.addEventListener('click', toggleTowersAutoPlay);

  const controls = document.querySelector('.fpvx-controls');
  if (controls) {
    const oldBtn = controls.querySelector('#fpvx-towers-autoplay-btn');
    if (oldBtn) oldBtn.remove();
    controls.insertBefore(btn, controls.firstChild);
  } else {
    container.appendChild(btn);
  }
}

function toggleTowersAutoPlay() {
  towersAutoPlay = !towersAutoPlay;
  const btn = document.getElementById('fpvx-towers-autoplay-btn');
  if (!btn) return;
  if (towersAutoPlay) {
    btn.textContent = '⏹ Stop Auto';
    btn.classList.add('playing');
    if (towersAutoPlayInterval) clearInterval(towersAutoPlayInterval);
    towersAutoPlayInterval = setInterval(executeTowersAutoPlay, 2000);
    towersAutoPlayRunning = false;
  } else {
    btn.textContent = '▶ Auto Play';
    btn.classList.remove('playing');
    if (towersAutoPlayInterval) clearInterval(towersAutoPlayInterval);
    towersAutoPlayInterval = null;
    towersAutoPlayRunning = false;
  }
}

async function executeTowersAutoPlay() {
  if (towersAutoPlayRunning) return;
  const startBtn = document.querySelector('.gameBetSubmit');
  if (!startBtn || startBtn.disabled) return;
  const btnText = startBtn.textContent.toLowerCase();
  if (!btnText.includes('start') && !btnText.includes('bet')) {
    if (btnText.includes('cashout')) {
      startBtn.click();
      await sleep(500);
    }
    return;
  }

  await runTowersPrediction();
  const totalRows = towersTargetRows;
  const startRow = TOWER_ROWS - totalRows;
  const path = [];
  for (let i = 0; i < totalRows; i++) {
    const rowIndex = startRow + i;
    path.push(towersLockedPath[rowIndex] || 0);
  }
  if (!path.length) return;

  towersAutoPlayRunning = true;
  startBtn.click();
  await sleep(1500);

  let gameInner = document.querySelector('[class*="towersGameInner"]');
  if (!gameInner) { towersAutoPlayRunning = false; return; }

  let rows = Array.from(gameInner.children).reverse();
  let rowIndex = 0;

  const clickNextRow = async () => {
    if (!towersAutoPlay) { towersAutoPlayRunning = false; return; }
    const btn = document.querySelector('.gameBetSubmit');
    if (btn && btn.textContent.toLowerCase().includes('start')) {
      towersAutoPlayRunning = false;
      return;
    }
    if (rowIndex >= totalRows || rowIndex >= rows.length) {
      const cashoutBtn = document.querySelector('.gameBetSubmit');
      if (cashoutBtn && cashoutBtn.textContent.toLowerCase().includes('cashout')) {
        cashoutBtn.click();
      }
      towersAutoPlayRunning = false;
      return;
    }
    const currentRow = rows[rowIndex];
    if (!currentRow) { towersAutoPlayRunning = false; return; }
    const cols = Array.from(currentRow.querySelectorAll('button'));
    const targetCol = path[rowIndex];
    if (targetCol >= cols.length) { rowIndex++; setTimeout(clickNextRow, 300); return; }
    const btnTile = cols[targetCol];
    if (!btnTile || btnTile.disabled) { rowIndex++; setTimeout(clickNextRow, 300); return; }
    btnTile.click();
    await sleep(600);
    rowIndex++;
    const newGameInner = document.querySelector('[class*="towersGameInner"]');
    if (newGameInner) rows = Array.from(newGameInner.children).reverse();
    setTimeout(clickNextRow, 400);
  };

  setTimeout(clickNextRow, 600);
}

document.getElementById('btn-predict').addEventListener('click', () => {
  if (currentTab === 'mines') runMinesPrediction();
  else if (currentTab === 'towers') runTowersPrediction();
  else if (currentTab === 'slide') runSlidePrediction();
});

function detectGameEvents() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.gameBetSubmit, button[class*="gameBetSubmit"]');
    if (!btn) return;
    const text = btn.textContent.toLowerCase();
    if (text.includes('start new game') || text.includes('bet')) {
      resetPrediction();
      await sleep(800);
      if (currentTab === 'mines') runMinesPrediction();
      else if (currentTab === 'towers') runTowersPrediction();
      else if (currentTab === 'slide') runSlidePrediction();
    } else if (text.includes('cashout') || text.includes('collect')) {
      resetPrediction();
    }
  }, true);

  const observer = new MutationObserver(() => {
    const board = getMinesGrid();
    if (!board || board.children.length === 0) {
      resetPrediction();
    }
  });
  setInterval(() => {
    const board = getMinesGrid();
    if (board && !observer._connected) {
      observer.observe(board, { childList: true, subtree: true });
      observer._connected = true;
    } else if (!board && observer._connected) {
      observer.disconnect();
      observer._connected = false;
      resetPrediction();
    }
  }, 2000);
}
detectGameEvents();

var isUnrigging = false;
var unrigCount = 0;
var unrigTimeout = null;
var lastUnrigTime = 0;
var unrigCooldown = 5000;

async function runUnrig() {
  if (isUnrigging) return;
  var now = Date.now();
  if (now - lastUnrigTime < unrigCooldown) return;
  lastUnrigTime = now;
  isUnrigging = true;
  unrigCount++;
  var token = { active: true };

  if (unrigProgress) unrigProgress.classList.add('show');
  unrigBar.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const seg = document.createElement('div');
    seg.className = 'fpvx-unrig-seg';
    seg.dataset.index = i;
    unrigBar.appendChild(seg);
  }
  const segs = unrigBar.querySelectorAll('.fpvx-unrig-seg');

  const steps = [
    'Fetching seed hash',
    'Generating client seed',
    'Unhashing round',
    'Setting client seed',
    'Rotating server seed',
    'Clearing nonce',
    'Recalculating edge',
    'Done ✓'
  ];

  for (let i = 0; i < steps.length; i++) {
    if (!token.active) break;
    unrigStatusText.textContent = steps[i];
    if (i < segs.length) segs[i].classList.add('done');
    if (i === 2) await performUnrig();
    await sleep(i === steps.length - 1 ? 300 : 200);
  }

  await sleep(300);
  if (unrigProgress) unrigProgress.classList.remove('show');
  isUnrigging = false;
}

async function performUnrig() {
  try {
    const token = getAuthToken();
    const newSeed = crypto.randomUUID().replace(/-/g,'').slice(0,14);
    let success = false;

    const endpoints = [
      '/api/provably-fair',
      '/api/provably-fair/client-seed',
      '/api/provably-fair/seed'
    ];

    const methods = ['PUT', 'POST'];

    for (const method of methods) {
      for (const endpoint of endpoints) {
        try {
          const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
          if (token) headers['x-auth-token'] = token;

          const resp = await fetch('https://bloxflip.com' + endpoint, {
            method: method,
            credentials: 'include',
            headers: headers,
            body: JSON.stringify({ clientSeed: newSeed, clientseed: newSeed, seed: newSeed })
          });

          if (resp.ok) {
            success = true;
            break;
          }
        } catch (e) {}
      }
      if (success) break;
    }

    if (success) {
      const verifyResp = await fetch('https://bloxflip.com/api/provably-fair/clientSeed', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (verifyResp.ok) {
        const data = await verifyResp.json();
        if (data && data.clientSeed === newSeed) {
          unrigStatusText.textContent = 'Verified ✓';
        }
      }
    }
  } catch (e) {}
}

async function refreshUserStats() {
  let fetched = false;
  try {
    const token = getAuthToken();
    const headers = { 'Accept': 'application/json' };
    if (token) headers['x-auth-token'] = token;
    const resp = await fetch('https://bloxflip.com/api/user', { credentials: 'include', headers });
    if (resp.ok) {
      const data = await resp.json();
      const user = data?.user || data;
      let balance = null;
      for (const key of ['balance', 'coins', 'wallet']) {
        const v = parseStatNumber(user?.[key]);
        if (v != null && v >= 0 && v < 1e8) { balance = v; break; }
      }
      if (balance === null && user?.wallet) {
        const w = user.wallet;
        for (const key of ['balance', 'coins', 'wallet']) {
          const v = parseStatNumber(w?.[key]);
          if (v != null && v >= 0 && v < 1e8) { balance = v; break; }
        }
      }
      if (balance !== null) {
        flipcoins = balance;
        rocoins = 0;
        GM_setValue('fpvx_flipcoins', flipcoins);
        GM_setValue('fpvx_rocoins', rocoins);
        fetched = true;
      }
    }
  } catch (e) {}
  if (!fetched) {
    try {
      const candidates = Array.from(document.querySelectorAll('[class*="balance" i], [class*="wallet" i], [class*="coin" i]'))
        .filter(el => !el.closest('#fpvx-wrap'));
      for (const el of candidates) {
        const text = (el.textContent || '').replace(/[^0-9.]/g, '');
        const val = parseFloat(text);
        if (Number.isFinite(val) && val >= 0 && val < 1e7) {
          flipcoins = val; rocoins = 0;
          GM_setValue('fpvx_flipcoins', flipcoins);
          fetched = true;
          break;
        }
      }
    } catch (e) {}
  }
  const newBalance = (Number(flipcoins) || 0) + (Number(rocoins) || 0);
  animateBalance(newBalance);
}

setInterval(refreshUserStats, 2000);
refreshUserStats();

setInterval(() => { if (currentTab === 'blackjack') bjRunScrapeAndPredict(); }, 800);

async function callAIAPI(prompt, context = '') {
  if (!aiEnabled || !aiApiKey) return null;
  const provider = AI_PROVIDERS[aiProvider];
  if (!provider) return null;
  try {
    if (aiProvider === 'openai' || aiProvider === 'deepseek') {
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiApiKey}` },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: 'You are an expert at pattern prediction. Return optimized JSON only.' },
            { role: 'user', content: `${context}\n\n${prompt}` }
          ],
          temperature: 0.2,
          max_tokens: 200,
          response_format: { type: "json_object" }
        })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.choices?.[0]?.message?.content;
    } else if (aiProvider === 'anthropic') {
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': aiApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: 'user', content: `${context}\n\n${prompt}` }],
          max_tokens: 200,
          temperature: 0.2
        })
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.content?.[0]?.text;
    }
  } catch (e) {}
  return null;
}

async function initAuthSequence() {
  if (!licenseKey) {
    showOverlay();
  } else {
    const ok = await verifyKeyAuth(licenseKey, true);
    if (ok) {
      hideOverlay();
      refreshUserStats();
      updateLicenseUI();
    } else {
      showOverlay();
    }
  }
}

document.getElementById('fpvx-ov-login-btn').addEventListener('click', async () => {
  const key = document.getElementById('fpvx-ov-key-input').value.trim();
  const errDiv = document.getElementById('fpvx-ov-error');
  errDiv.style.display = 'none';
  if (!key) { errDiv.textContent = 'Please enter a license key.'; errDiv.style.display = 'block'; return; }
  const ok = await verifyKeyAuth(key, false);
  if (ok) {
    hideOverlay();
    refreshUserStats();
    updateLicenseUI();
  } else {
    errDiv.textContent = 'Invalid or expired license.';
    errDiv.style.display = 'block';
  }
});

setInterval(updateLicenseExpiryDisplay, 60000);

discordHandleCallback();
if (discordConnected && discordToken) discordFetchUser();
discordUpdateUI();

initAuthSequence();

})();
