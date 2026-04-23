const config = require('../config');
const postgres = require('./postgresTaskStore');
const json = require('./jsonTaskStore');

function selectedStore() {
  const backend = config.get('storageBackend');
  if (backend === 'postgres') return postgres;
  return json;
}

module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      const store = selectedStore();
      if (prop === 'kind') return store.kind;
      if (prop === '_selectedStore') return selectedStore;
      return store[prop];
    },
  },
);
