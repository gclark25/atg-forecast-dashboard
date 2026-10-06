(function () {
  function getStoredTheme() {
    return localStorage.getItem('atg-theme') || 'light';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  // Runs synchronously during <head> parsing, before <body> paints --
  // avoids a flash of the wrong theme on load.
  applyTheme(getStoredTheme());

  window.ATGTheme = {
    get: getStoredTheme,
    toggle: function () {
      const next = getStoredTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem('atg-theme', next);
      applyTheme(next);
      return next;
    },
  };
})();