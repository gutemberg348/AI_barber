const formatters = new Map();
export const pauseSettings = store => store.get('system', 'bot-pause') ?? {
  enabled: false, time: '19:00', repeat: 'once', nextPauseAt: null, lastPausedAt: null,
};

// Busca a próxima ocorrência no fuso da barbearia, independentemente do host.
// Percorrer minutos também lida com mudanças de offset e horários repetidos.
export function nextPauseTime(time, timezone, now = Date.now()) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const formatter = formatters.get(timezone);
  const start = Math.floor(now / 60000) * 60000 + 60000;
  for (let step = 0; step < 3 * 24 * 60; step++) {
    const candidate = start + step * 60000;
    if (formatter.format(candidate) === time) return new Date(candidate).toISOString();
  }
  throw new Error('horario_de_pausa_invalido');
}

export function savePauseSettings(store, { enabled, time, repeat }, timezone, now = Date.now()) {
  const settings = { enabled, time, repeat, nextPauseAt: enabled ? nextPauseTime(time, timezone, now) : null,
    lastPausedAt: pauseSettings(store).lastPausedAt };
  store.set('system', 'bot-pause', settings);
  return settings;
}

// Executada pelo servidor e antes de cada envio; não depende do painel aberto.
export function applyScheduledPause(store, timezone, now = Date.now()) {
  const settings = pauseSettings(store);
  if (!settings.enabled || !settings.nextPauseAt || Date.parse(settings.nextPauseAt) > now) return false;
  store.transaction(() => {
    store.set('system', 'bot-enabled', false);
    store.set('system', 'bot-pause', { ...settings, enabled: settings.repeat === 'daily',
      nextPauseAt: settings.repeat === 'daily' ? nextPauseTime(settings.time, timezone, now) : null,
      lastPausedAt: new Date(now).toISOString() });
  });
  return true;
}

export function botEnabled(store, timezone, now = Date.now()) {
  applyScheduledPause(store, timezone, now);
  return store.get('system', 'bot-enabled') !== false;
}
