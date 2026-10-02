(() => {
  const requested = new URLSearchParams(location.search).get('theme');
  const mode = ['light', 'dark', 'system'].includes(requested) ? requested : 'light';
  const theme = mode === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  document.body.dataset.theme = theme;
  document.body.dataset.themeMode = mode;
  document.documentElement.dataset.theme = theme;
})();
