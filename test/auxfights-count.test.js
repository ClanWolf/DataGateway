const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

test('fight counts and faction wins include zero-attack fights without changing the default list', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE aux_fights (
      id_fight INTEGER, confirmed INTEGER, winnerfaction_id INTEGER,
      c3_attack_id INTEGER, fight_teamsize INTEGER
    );
    INSERT INTO aux_fights VALUES
      (1, 1, 10, 0, 1), (2, 1, 20, 2, 2),
      (3, 0, 10, 0, 1), (4, 1, -1, NULL, 1),
      (5, 1, NULL, NULL, 1), (6, 1, 0, 0, 1);
    CREATE TABLE c3_FACTION (ID INTEGER PRIMARY KEY, Name_de TEXT, Name_en TEXT);
    INSERT INTO c3_FACTION VALUES
      (10, 'Fraktion A', 'Faction A'), (20, 'Fraktion B', 'Faction B'),
      (30, 'Ohne Siege', 'No wins');
  `);
  let fail = false;
  const filename = path.resolve(__dirname, '../routes/auxfights.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const load = vm.runInThisContext(
    `(function(require, module, exports) { ${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  load((id) => {
    if (id === '../db.js') return { pool: { query: async (sql) => {
      if (fail) throw new Error('private database details');
      return db.prepare(sql).all();
    } } };
    if (id === '../logger.js') return { logger: { info() {}, error() {} } };
    return localRequire(id);
  }, module, module.exports);
  const app = express();
  app.use('/auxfights', module.exports);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/auxfights`;

  const response = await fetch(`${url}?count=true`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 2 });
  for (const suffix of ['', '?count=false', '?factions=false']) {
    const listResponse = await fetch(url + suffix);
    assert.equal(listResponse.status, 200);
    const fights = await listResponse.json();
    assert.equal(fights.length, 6);
    assert.equal(fights.find(({ id_fight }) => id_fight === 1).c3_attack_id, 0);
  }
  db.exec(`
    INSERT INTO aux_fights VALUES
      (7, 1, 20, 0, 1), (8, 1, 20, 0, 1), (9, 1, 99, 0, 1);
  `);
  const expectedFactions = [
    { faction_id: 20, name_de: 'Fraktion B', name_en: 'Faction B', wins: 3 },
    { faction_id: 10, name_de: 'Fraktion A', name_en: 'Faction A', wins: 1 },
    { faction_id: 99, name_de: null, name_en: null, wins: 1 },
  ];
  const factionResponse = await fetch(`${url}?factions=true`);
  assert.equal(factionResponse.status, 200);
  assert.deepEqual(await factionResponse.json(), { factions: expectedFactions });
  const combinedResponse = await fetch(`${url}?count=true&factions=true`);
  assert.equal(combinedResponse.status, 200);
  assert.deepEqual(await combinedResponse.json(), { count: 5, factions: expectedFactions });
  assert.deepEqual(await (await fetch(`${url}?count=true`)).json(), { count: 5 });
  db.exec('DELETE FROM aux_fights');
  assert.deepEqual(await (await fetch(`${url}?count=true`)).json(), { count: 0 });
  assert.deepEqual(await (await fetch(`${url}?factions=true`)).json(), { factions: [] });
  assert.deepEqual(await (await fetch(`${url}?count=true&factions=true`)).json(), { count: 0, factions: [] });
  fail = true;
  for (const suffix of ['?count=true', '?factions=true', '?count=true&factions=true']) {
    const errorResponse = await fetch(url + suffix);
    assert.equal(errorResponse.status, 500);
    assert.deepEqual(await errorResponse.json(), { message: 'Server error' });
  }
});
