(function () {
  const iframe_name = getIframeName();

  _th_impl._init(iframe_name);

  // Runs before the card's module imports, so import/syntax failures are visible
  // even when registerMvuSchema is never reached. Opt-in filter lives in Nora.
  function trace(stage, detail) {
    try { parent.NoraMvu?.trace?.recordScript(stage, iframe_name, detail); } catch { /* Logging only. */ }
  }
  trace('schema-script-start', {});
  window.addEventListener('error', event => trace('schema-script-error', {
    message: event.message || 'resource error', filename: event.filename, line: event.lineno,
    resource: event.target?.src || '',
  }), true);
  window.addEventListener('unhandledrejection', event => trace('schema-script-rejection', {
    message: String(event.reason?.message || event.reason),
  }));

  function override(level) {
    const original = console[level];
    console[level] = (...args) => {
      if (level === 'error' || level === 'warn') trace('schema-script-console', { level, message: args.map(String).join(' ').slice(0, 8000) });
      _th_impl._log(iframe_name, level, ...args);
      original(...args);
    };
  }
  override('log');
  override('debug');
  override('info');
  override('warn');
  override('error');

  $(window).on('pagehide', () => {
    _th_impl._clearLog(iframe_name);
  });
})();
