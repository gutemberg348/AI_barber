import { initAuthCreds, proto } from '@whiskeysockets/baileys';

export function sqliteAuthState(store) {
  const creds = store.get('auth', 'creds') ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const data = {};
          for (const id of ids) {
            let value = store.get('auth', `${type}:${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        async set(data) {
          store.transaction(() => {
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries)) {
                if (value == null) store.delete('auth', `${type}:${id}`);
                else store.set('auth', `${type}:${id}`, value);
              }
            }
          });
        },
      },
    },
    saveCreds: () => store.set('auth', 'creds', creds),
  };
}
