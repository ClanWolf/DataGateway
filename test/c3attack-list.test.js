const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

test('season attacks include winners, localized factions and correctly scoped booked PCP', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE c3_ATTACK (
      ID INTEGER PRIMARY KEY, Season INTEGER, StarSystemID INTEGER, Round INTEGER,
      FactionID_Attacker INTEGER, FactionID_Defender INTEGER, FactionID_Winner INTEGER
    );
    CREATE TABLE c3_STARSYSTEM (ID INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE c3_FACTION (ID INTEGER PRIMARY KEY, Name_de TEXT, Name_en TEXT);
    CREATE TABLE c3_SCORE (SeasonId INTEGER, AttackID INTEGER, FactionID INTEGER, PCP REAL);
    INSERT INTO c3_STARSYSTEM VALUES (1, 'Terra'), (2, 'Tukayyid');
    INSERT INTO c3_ATTACK VALUES
      (21, 1, 1, 3, 7, 8, NULL), (22, 1, 2, 4, 7, 99, 7),
      (23, 2, 1, 1, 7, 8, 8), (24, 1, 1, 2, NULL, NULL, NULL);
    INSERT INTO c3_FACTION VALUES (7, 'Rote Garde', 'Red Guard'), (8, 'Blaue Garde', 'Blue Guard');
    INSERT INTO c3_SCORE VALUES
      (1, 21, 7, 10), (1, 21, 7, 2.5), (1, 21, 8, 3),
      (1, 22, 7, 4), (1, 22, 99, 1), (2, 21, 7, 900),
      (2, 23, 8, 20), (1, 0, 7, 500);
  `);
  let fail = false;
  let queryCount = 0;
  const filename = path.resolve(__dirname, '../routes/c3attack.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const load = vm.runInThisContext(
    `(function(require, module, exports) { ${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  load((id) => {
    if (id === '../db.js') return { pool: { query: async (sql, args = []) => {
      queryCount++;
      if (fail) throw new Error('private database details');
      return db.prepare(sql).all(...args);
    } } };
    if (id === '../logger.js') return { logger: { info() {}, error() {} } };
    return localRequire(id);
  }, module, module.exports);
  const app = express();
  app.use('/c3attack', module.exports);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/c3attack/season`;
  const response = await fetch(`${url}/1/list`);
  assert.equal(response.status, 200);
  assert.equal(queryCount, 3);
  const attacks = await response.json();
  assert.deepEqual(attacks.map(({ id }) => id), [22, 21, 24]);
  assert.deepEqual(attacks[0], {
    id: 22, season: 1, name: 'Tukayyid', round: 4,
    winnerfaction_id: 7, has_winner: true,
    factions: [
      { faction_id: 7, name: { de: 'Rote Garde', en: 'Red Guard' }, pcp: 4 },
      { faction_id: 99, name: { de: null, en: null }, pcp: 1 },
    ],
  });
  assert.equal(attacks[1].winnerfaction_id, null);
  assert.equal(attacks[1].has_winner, false);
  assert.equal(attacks[1].factions[0].pcp, 12.5);
  assert.equal(attacks[1].factions[1].pcp, 3);
  assert.deepEqual(attacks[2].factions, []);
  db.exec('DELETE FROM c3_SCORE');
  const noScores = await (await fetch(`${url}/1/list`)).json();
  assert.deepEqual(noScores[1].factions.map(({ faction_id, pcp }) => ({ faction_id, pcp })), [
    { faction_id: 7, pcp: 0 }, { faction_id: 8, pcp: 0 },
  ]);
  for (const season of ['0', '-1', 'invalid', '1.5', '9007199254740992']) {
    assert.equal((await fetch(`${url}/${season}/list`)).status, 400);
  }
  assert.equal((await fetch(`${url}/99/list`)).status, 404);
  fail = true;
  const error = await fetch(`${url}/1/list`);
  assert.equal(error.status, 500);
  assert.deepEqual(await error.json(), { message: 'Server error' });
});

