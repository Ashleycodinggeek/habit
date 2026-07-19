// Rhythm v2 — Background Service Worker
// Clicking the toolbar icon opens/focuses the app dashboard tab

const DASHBOARD = chrome.runtime.getURL('app.html');
const CUSTOM_START = 5000;

// Open dashboard on toolbar icon click
chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({ url: DASHBOARD }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: DASHBOARD });
    }
  });
});

// Seed defaults on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    ['customDomains','pornEnabled','gamblingEnabled','streakStart','totalBlocks','blocksByType'],
    (r) => {
      const defaults = {};
      if (r.customDomains   === undefined) defaults.customDomains   = [];
      if (r.pornEnabled     === undefined) defaults.pornEnabled     = true;
      if (r.gamblingEnabled === undefined) defaults.gamblingEnabled = true;
      if (r.streakStart     === undefined) defaults.streakStart     = Date.now();
      if (r.totalBlocks     === undefined) defaults.totalBlocks     = 0;
      if (r.blocksByType    === undefined) defaults.blocksByType    = { porn:0, gamb:0, custom:0 };
      if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
      refreshCustomRulesFromStorage().catch(() => {});
    }
  );
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local' || !changes.customDomains) return;
  const domains = Array.isArray(changes.customDomains.newValue)
    ? changes.customDomains.newValue
    : [];
  updateCustomRules(domains).catch(() => {});
});

function normalizeDomain(value) {
  let v = String(value || '').trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  v = v.replace(/[^a-z0-9.-]/g, '');
  v = v.replace(/^\.+|\.+$/g, '');
  if (!v) return '';
  if (!v.includes('.')) v = `${v}.com`;
  return v;
}

function matchesCustomDomain(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const hostNoWww = host.replace(/^www\./, '');
    return hostNoWww === normalized || hostNoWww.endsWith(`.${normalized}`);
  } catch (e) {
    return false;
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0 || !details.url) return;
  if (!details.url.startsWith('http')) return;
  chrome.storage.local.get(['customDomains'], (r) => {
    const domains = Array.isArray(r.customDomains) ? r.customDomains : [];
    const shouldBlock = domains.some(d => matchesCustomDomain(details.url, d));
    if (!shouldBlock) return;
    const blockedUrl = `${chrome.runtime.getURL('blocked.html')}?type=custom&site=${encodeURIComponent(new URL(details.url).hostname)}`;
    chrome.tabs.update(details.tabId, { url: blockedUrl }).catch(() => {});
  });
});

// Message bus — receives messages from app.html and blocked.html
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'UPDATE_CUSTOM_DOMAINS') {
    const domains = Array.isArray(msg.domains) ? msg.domains : [];
    chrome.storage.local.set({ customDomains: domains });
    updateCustomRules(domains).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'TOGGLE_CATEGORY') {
    const id = msg.category === 'porn' ? 'porn_rules' : 'gambling_rules';
    const op = msg.enabled
      ? chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] })
      : chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [id] });
    op.then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'RECORD_BLOCK') {
    chrome.storage.local.get(['totalBlocks','blocksByType'], (r) => {
      const total = (r.totalBlocks || 0) + 1;
      const bt    = r.blocksByType || { porn:0, gamb:0, custom:0 };
      const cat   = msg.category;
      if      (cat === 'porn')     bt.porn    = (bt.porn    || 0) + 1;
      else if (cat === 'gambling') bt.gamb    = (bt.gamb    || 0) + 1;
      else                         bt.custom  = (bt.custom  || 0) + 1;
      chrome.storage.local.set({ totalBlocks: total, blocksByType: bt });
      // Forward live update to any open dashboard tab
      chrome.tabs.query({ url: DASHBOARD }, (tabs) => {
        tabs.forEach(t => {
          chrome.tabs.sendMessage(t.id, { type:'RECORD_BLOCK', category: cat }).catch(() => {});
        });
      });
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function refreshCustomRulesFromStorage() {
  const r = await chrome.storage.local.get(['customDomains']);
  const domains = Array.isArray(r.customDomains) ? r.customDomains : [];
  await updateCustomRules(domains);
}

async function updateCustomRules(domains) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds   = existing.map(r => r.id);
  const newRules = domains.map((d, i) => ({
    id:       CUSTOM_START + i,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { extensionPath: `/blocked.html?type=custom&site=${encodeURIComponent(d)}` }
    },
    condition: { urlFilter: `||${d}`, resourceTypes: ['main_frame'] }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldIds,
    addRules:      newRules
  });
}
