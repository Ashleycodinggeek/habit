// Rhythm v2 — Background Service Worker
// Clicking the toolbar icon opens/focuses the app dashboard tab

const DASHBOARD   = chrome.runtime.getURL('app.html');
const CUSTOM_START = 5000;

// ── On icon click: open or focus the dashboard ──
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

// ── On first install: seed defaults & apply any saved custom domains ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    ['customDomains','pornEnabled','gamblingEnabled',
     'streakStart','totalBlocks','blocksByType'],
    (r) => {
      const defaults = {};
      if (r.customDomains   === undefined) defaults.customDomains   = [];
      if (r.pornEnabled     === undefined) defaults.pornEnabled     = true;
      if (r.gamblingEnabled === undefined) defaults.gamblingEnabled = true;
      if (r.streakStart     === undefined) defaults.streakStart     = Date.now();
      if (r.totalBlocks     === undefined) defaults.totalBlocks     = 0;
      if (r.blocksByType    === undefined) defaults.blocksByType    = { porn:0, gamb:0, custom:0 };
      if (Object.keys(defaults).length) {
        chrome.storage.local.set(defaults, () => {
          // Apply any existing custom domains after seeding
          applyStoredCustomDomains();
        });
      } else {
        // Extension was already installed — restore custom domain rules
        applyStoredCustomDomains();
      }
    }
  );
});

// ── On browser startup: restore custom domain rules ──
// (Dynamic rules are lost when Chrome restarts — this re-applies them)
chrome.runtime.onStartup.addListener(() => {
  applyStoredCustomDomains();
});

// ── Load and apply custom domains from storage ──
function applyStoredCustomDomains() {
  chrome.storage.local.get(['customDomains'], (r) => {
    const domains = r.customDomains || [];
    if (domains.length > 0) {
      updateCustomRules(domains);
    }
  });
}

// ── Message bus ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Update custom blocking rules (called whenever domains change)
  if (msg.type === 'UPDATE_CUSTOM_DOMAINS') {
    // Persist to storage so rules survive browser restarts
    chrome.storage.local.set({ customDomains: msg.domains }, () => {
      updateCustomRules(msg.domains).then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  // Toggle an entire ruleset on or off
  if (msg.type === 'TOGGLE_CATEGORY') {
    const id = msg.category === 'porn' ? 'porn_rules' : 'gambling_rules';
    const op = msg.enabled
      ? chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] })
      : chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [id] });
    op.then(() => sendResponse({ ok: true }));
    return true;
  }

  // Record a block intercept
  if (msg.type === 'RECORD_BLOCK') {
    chrome.storage.local.get(['totalBlocks','blocksByType'], (r) => {
      const total = (r.totalBlocks || 0) + 1;
      const bt    = r.blocksByType || { porn:0, gamb:0, custom:0 };
      const cat   = msg.category;
      if      (cat === 'porn')     bt.porn   = (bt.porn   || 0) + 1;
      else if (cat === 'gambling') bt.gamb   = (bt.gamb   || 0) + 1;
      else                         bt.custom = (bt.custom || 0) + 1;
      chrome.storage.local.set({ totalBlocks: total, blocksByType: bt });
      // Forward live update to any open dashboard tab
      chrome.tabs.query({ url: DASHBOARD }, (tabs) => {
        tabs.forEach(t => {
          chrome.tabs.sendMessage(t.id, {
            type: 'RECORD_BLOCK', category: cat
          }).catch(() => {});
        });
      });
    });
    sendResponse({ ok: true });
    return true;
  }
});

// ── Build and apply dynamic rules from a domain list ──
async function updateCustomRules(domains) {
  // Remove all existing dynamic rules first
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds   = existing.map(r => r.id);

  // Build new rules — one per domain
  const newRules = domains.map((d, i) => ({
    id:       CUSTOM_START + i,
    priority: 2,
    action: {
      type: 'redirect',
      redirect: {
        extensionPath: `/blocked.html?type=custom&site=${encodeURIComponent(d)}`
      }
    },
    condition: {
      // ||domain matches the domain and all its subdomains
      urlFilter:     `||${d}`,
      resourceTypes: ['main_frame']
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldIds,
    addRules:      newRules
  });
}