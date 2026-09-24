// Runs in the page's own JavaScript world, not the extension's.
//
// Why this file exists at all: a content script lives in an isolated world and
// wrapping window.fetch there intercepts nothing, because the page holds its own
// untouched copy. Facebook's GraphQL calls are persisted queries keyed by a
// doc_id that changes on every deploy, so the only durable way to learn the
// current one is to watch the page ask for it.
//
// This file does exactly that and nothing else: no storage, no chrome.*, no
// network of its own. It forwards the request body to the isolated world, where
// content-facebook.js decides what to do with it. Instagram runs on the same
// Relay stack, so the file is loaded there too, for content-instagram.js.
//
// The body carries the page's CSRF token. That is not a new exposure: any script
// already running on facebook.com can read it from the DOM. It never leaves the
// tab and it is never written to disk.

(() => {
  'use strict';

  const WANTED = /\/api\/graphql|\/graphql\/query/;

  // Armed unless told otherwise. The isolated side asks for silence while no
  // collection is running, which spares a message and a parse on every GraphQL
  // call Facebook makes, all day. Defaulting to silent would be the wrong way
  // round: a lost message would then look exactly like Facebook having changed
  // something, which is the one failure this project must not fake.
  let armed = true;

  // This file runs at document_start, the isolated side only at document_idle.
  // Queries the page sends while it loads would be lost in between, and a fresh
  // load is exactly when Facebook sends the ones we need without any scrolling.
  // So the last body per query name is kept and sent again on request.
  const kept = new Map();
  const KEEP = 64;
  const post = (body) => {
    try {
      window.postMessage({ __exportin: 'gql', body }, location.origin);
    } catch {
      /* a body we cannot forward is a query we will catch on the next call */
    }
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data) return;
    if (data.__exportin === 'arm' && typeof data.on === 'boolean') armed = data.on;
    if (data.__exportin === 'replay') for (const body of kept.values()) post(body);
    // The page ships each query's doc_id in a module long before it sends the
    // query, and a background tab may never scroll far enough to send it. Only
    // this world can read the module registry, so the question is asked here.
    if (data.__exportin === 'docIdAsk' && /^\w+$/.test(String(data.name))) {
      let id = null;
      for (const suffix of ['_facebookRelayOperation', '_instagramRelayOperation']) {
        try {
          id = window.require(data.name + suffix);
          if (id != null) break;
        } catch {
          /* not loaded on this page, or not this network */
        }
      }
      window.postMessage({ __exportin: 'docId', name: data.name, id: id == null ? null : String(id) }, location.origin);
    }
  });

  function forward(url, body) {
    if (typeof body !== 'string' || !WANTED.test(String(url))) return;
    const name = /fb_api_req_friendly_name=([^&]+)/.exec(body);
    if (name) {
      kept.delete(name[1]);
      kept.set(name[1], body);
      if (kept.size > KEEP) kept.delete(kept.keys().next().value);
    }
    if (armed) post(body);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const input = args[0];
      forward(input && input.url ? input.url : input, args[1] && args[1].body);
    } catch {
      /* never let the hook break the page it is watching */
    }
    return nativeFetch.apply(this, args);
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__exportinUrl = url;
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      forward(this.__exportinUrl, body);
    } catch {
      /* same */
    }
    return send.call(this, body);
  };
})();
