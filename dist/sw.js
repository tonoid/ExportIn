// Clicking the toolbar icon opens the panel in its own tab, or focuses the one
// already open. The tab id is remembered rather than looked up with
// chrome.tabs.query, which would need the broad "tabs" permission just to match
// our own extension URL.

async function openPanel() {
  const { panelTabId } = await chrome.storage.local.get('panelTabId');
  if (panelTabId !== undefined) {
    try {
      const tab = await chrome.tabs.update(panelTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      /* the panel tab was closed since we noted it */
    }
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
  await chrome.storage.local.set({ panelTabId: tab.id });
}

chrome.action.onClicked.addListener(openPanel);

// On install, and on update or reload, which closes the panel tab. Not when
// Chrome itself updates: nobody asked for a tab then.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') openPanel();
});
