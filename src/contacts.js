import { appointmentPhoneVariants } from './phone.js';

// Normaliza somente números brasileiros; formas com/sem o nono dígito compartilham o controle.
export function contactPhone(value) {
  if (typeof value !== 'string' || !/^[+\d\s().-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+') && !/^55\d{10,11}$/.test(digits)) return null;
  if (/^55\d{10,11}$/.test(digits)) digits = digits.slice(2);
  if (!/^(?:[1-9]\d[1-9]\d{7}|[1-9]\d9\d{8})$/.test(digits)) return null;
  return appointmentPhoneVariants(digits).find(phone => phone.length === 11) ?? digits;
}

export function contactControl(store, phone) {
  const key = contactPhone(phone);
  return key ? store.get('contacts', key) : null;
}

export function listedContacts(store) {
  return store.entries('contacts').map(contact => ({ ...contact, enabled: contact.enabled
    && !appointmentPhoneVariants(contact.phone).some(phone => store.get('paused', phone)) }))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt ?? '').localeCompare(a.lastMessageAt ?? a.updatedAt ?? ''));
}

export function recordContact(store, phone) {
  const key = contactPhone(phone);
  if (!key) return null;
  const current = store.get('contacts', key);
  const next = { phone: key, name: '', enabled: true, revision: 0, updatedAt: null, ...current, lastMessageAt: new Date().toISOString() };
  store.set('contacts', key, next);
  return next;
}

export function saveContact(store, phone, { enabled, name }) {
  const key = contactPhone(phone);
  if (!key) return null;
  const current = store.get('contacts', key);
  const next = { phone: key, name: name ?? current?.name ?? '', enabled,
    revision: (current?.revision ?? 0) + ((current?.enabled ?? true) !== enabled ? 1 : 0),
    lastMessageAt: current?.lastMessageAt ?? null, updatedAt: new Date().toISOString() };
  store.transaction(() => {
    store.set('contacts', key, next);
    if (enabled) for (const alias of appointmentPhoneVariants(key)) store.delete('paused', alias);
  });
  return next;
}
