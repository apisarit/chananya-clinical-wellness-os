(() => {
  'use strict';
  let trustedParent = false;
  try {
    trustedParent = window.parent !== window && window.parent.location.origin === location.origin;
  } catch {
    trustedParent = false;
  }
  if (!trustedParent) {
    location.replace('/luopan.html');
    return;
  }
  document.documentElement.dataset.luopanEmbedded = 'true';
})();
