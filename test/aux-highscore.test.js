const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

// Load real routers with isolated DB/logger dependencies, never production secrets.
function loadRouter(name, pool) {
  const filename = path.resolve(__dirname, '../routes', name);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const run = vm.runInThisContext(
    `(function(require, module, exports) { ${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename }
  );
  run((id) => {
    if (id === '../db.js') return { pool };
    if (id === '../logger.js') return { logger: { info() {}, error() {}, warn() {} } };
    return localRequire(id);
  }, module, module.exports);
  return module.exports;
}

async function serve(t, router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('live aggregation credits only winning initiators and deduplicates all completed participations', async (t) => {
  // SQLite executes the portable SELECT used by MariaDB, rather than returning
  // pre-aggregated mocks that could hide JOIN/SUM mistakes.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE aux_users (id_user INTEGER, username TEXT);
    CREATE TABLE aux_fights (id_fight INTEGER, confirmed INTEGER, winnerfaction_id INTEGER, fight_teamsize INTEGER);
    CREATE TABLE aux_fightusers (user_id INTEGER, fight_id INTEGER, faction_id INTEGER, fightcreator INTEGER);
    CREATE TABLE c3_SCORE_REFERENCE ("Key" TEXT, "Value" DOUBLE);
    INSERT INTO c3_SCORE_REFERENCE VALUES ('PCP_AUX', 10);
    INSERT INTO aux_users VALUES (1, 'Alpha'), (2, 'Bravo'), (3, 'Loser'), (4, 'New'), (5, 'Legacy'), (6, 'Twin');
    INSERT INTO aux_fights VALUES
      (1, 1, 10, 2), (2, 1, 20, 1), (3, 0, 10, 999),
      (4, 1, -1, 999), (5, 1, 10, NULL), (6, 1, 10, 0), (7, 1, 20, 1),
      (8, 1, 10, -2);
    INSERT INTO aux_fightusers VALUES
      (1, 1, 10, 1), (1, 1, 10, 1), (2, 1, 10, 0), (6, 1, 10, 0), (3, 1, 20, 0),
      (1, 2, 10, 1), (3, 2, 20, 0), (1, 3, 10, 1), (1, 4, 10, 1),
      (5, 5, 10, 1), (3, 5, 20, 0), (2, 6, 10, 1), (1, 7, 20, 1),
      (6, 8, 10, 1);
  `);
  const url = await serve(t, loadRouter('auxusers.js', {
    query: async (sql, args) => db.prepare(sql).all(...args),
  }));
  const response = await fetch(`${url}/highscore`);
  assert.equal(response.status, 200);
  const entries = await response.json();
  assert.deepEqual(entries.map(({ id_user, rank, fights, pcp }) =>
    [id_user, rank, fights, pcp]), [
    [1, 1, 3, 30],
    [2, 2, 2, 10],
    [5, 2, 1, 10],
    [6, 2, 2, 10],
    [3, 5, 3, 0],
    [4, 5, 0, 0],
  ]);
  assert.ok(entries.every((entry) => !('missing_pcp_fights' in entry)));
  db.exec("UPDATE c3_SCORE_REFERENCE SET Value = 2.5 WHERE `Key` = 'PCP_AUX'");
  const updated = await (await fetch(`${url}/highscore`)).json();
  assert.deepEqual(updated.map((entry) => entry.pcp), [7.5, 2.5, 2.5, 2.5, 0, 0]);
  db.exec("UPDATE c3_SCORE_REFERENCE SET Value = 0 WHERE `Key` = 'PCP_AUX'");
  const zero = await (await fetch(`${url}/highscore`)).json();
  assert.ok(zero.every((entry) => entry.pcp === 0 && entry.rank === 1));
});

test('empty user list and database failures have explicit responses', async (t) => {
  let fail = false;
  const url = await serve(t, loadRouter('auxusers.js', {
    query: async (sql) => {
      if (fail) throw new Error('private database details');
      return sql.includes('c3_SCORE_REFERENCE') ? [{ Value: 10 }] : [];
    },
  }));
  assert.deepEqual(await (await fetch(`${url}/highscore`)).json(), []);
  fail = true;
  const response = await fetch(`${url}/highscore`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: 'Server error' });
});

test('missing or invalid live PCP references fail instead of returning misleading totals', async (t) => {
  let references = [];
  const url = await serve(t, loadRouter('auxusers.js', { query: async () => references }));
  for (const value of [[], [{ Value: null }], [{ Value: '' }], [{ Value: 'invalid' }], [{ Value: 1 }, { Value: 2 }]]) {
    references = value;
    const response = await fetch(`${url}/highscore`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { message: 'Server error' });
  }
});

function confirmationPool({ failConfirmation = false, failScore = false, attackId = 2, season = 1 } = {}) {
  const state = {
    confirmed: 0, winnerFaction: 10, attackId, reference: 10, commits: 0, rollbacks: 0,
    scores: [], confirmations: [], attackLookups: [], scoreWrites: 0, locks: 0,
    transactions: 0, releases: 0,
  };
  let snapshot;
  const connection = {
    async beginTransaction() {
      state.transactions++;
      snapshot = { confirmed: state.confirmed, scores: state.scores.slice(), confirmations: state.confirmations.slice() };
    },
    async query(sql, args) {
      if (sql === 'SELECT confirmed, winnerfaction_id, c3_attack_id, fight_teamsize FROM aux_fights WHERE id_fight = ? FOR UPDATE') {
        assert.deepEqual(args, [42]);
        state.locks++;
        return [{ confirmed: state.confirmed, winnerfaction_id: state.winnerFaction, c3_attack_id: state.attackId, fight_teamsize: 2 }];
      }
      if (sql === 'SELECT `Value` FROM c3_SCORE_REFERENCE WHERE `Key` = ?') {
        assert.deepEqual(args, ['PCP_AUX']);
        return [{ Value: state.reference }];
      }
      if (sql === 'SELECT Season FROM c3_ATTACK WHERE ID = ?') {
        state.attackLookups.push(args);
        assert.ok(Number(state.attackId) > 0, 'unassigned fights must not look up an attack');
        assert.deepEqual(args, [state.attackId]);
        return [{ Season: season }];
      }
      if (sql === 'INSERT INTO c3_SCORE (SeasonId, AttackID, FactionID, PCP) VALUES (?, ?, ?, ?)') {
        state.scoreWrites++;
        if (failScore) throw new Error('score write failed');
        state.scores.push(args);
        return {};
      }
      if (sql === 'UPDATE aux_fights SET confirmed = 1 WHERE id_fight = ?') {
        assert.deepEqual(args, [42]);
        if (failConfirmation) throw new Error('confirmation write failed');
        state.confirmations.push(args);
        state.confirmed = 1;
        return {};
      }
      if (sql === 'UPDATE aux_fights SET winnerfaction_id = NULL, c3_attack_id = NULL WHERE id_fight = ?') {
        assert.deepEqual(args, [42]);
        state.winnerFaction = null;
        state.attackId = null;
        return {};
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async commit() { state.commits++; },
    async rollback() {
      state.rollbacks++;
      Object.assign(state, snapshot);
    },
    release() { state.releases++; },
  };
  return { state, getConnection: async () => connection };
}

function winnerPool({ attackExists = true, participates = true } = {}) {
  const pool = confirmationPool({ attackId: null });
  const { state } = pool;
  state.winnerFaction = null;
  state.submissions = [];
  state.participantLookups = [];
  const getConnection = pool.getConnection;
  pool.getConnection = async () => {
    const connection = await getConnection();
    const query = connection.query.bind(connection);
    return {
      ...connection,
      async query(sql, args) {
        if (sql === 'SELECT confirmed, winnerfaction_id, c3_attack_id FROM aux_fights WHERE id_fight = ? FOR UPDATE') {
          assert.deepEqual(args, [42]);
          state.locks++;
          return [{ confirmed: state.confirmed, winnerfaction_id: state.winnerFaction, c3_attack_id: state.attackId }];
        }
        if (sql === 'SELECT ID FROM c3_ATTACK WHERE ID = ?') {
          state.attackLookups.push(args);
          assert.ok(args[0] > 0, 'zero submissions must not look up an attack');
          return attackExists ? [{ ID: args[0] }] : [];
        }
        if (sql === 'SELECT faction_id FROM aux_fightusers WHERE fight_id = ? AND faction_id = ?') {
          assert.deepEqual(args, [42, 10]);
          state.participantLookups.push(args);
          return participates ? [{ faction_id: 10 }] : [];
        }
        if (sql === 'UPDATE aux_fights SET winnerfaction_id = ?, c3_attack_id = ? WHERE id_fight = ?') {
          assert.equal(args[2], 42);
          state.submissions.push(args);
          [state.winnerFaction, state.attackId] = args;
          return {};
        }
        return query(sql, args);
      },
    };
  };
  return pool;
}

test('confirmation awards faction PCP once without storing a fight PCP snapshot', async (t) => {
  const pool = confirmationPool();
  const url = await serve(t, loadRouter('auxfights.js', pool));
  const confirm = () => fetch(`${url}/42/confirmed`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: 1 }),
  });
  assert.equal((await confirm()).status, 200);
  pool.state.reference = 99;
  assert.equal((await confirm()).status, 200);
  assert.deepEqual(pool.state.scores, [[1, 2, 10, 20]]);
  assert.deepEqual(pool.state.confirmations, [[42]]);
  assert.equal(pool.state.commits, 1);
});

test('confirmation errors roll back together with the faction award', async (t) => {
  const pool = confirmationPool({ failConfirmation: true });
  const url = await serve(t, loadRouter('auxfights.js', pool));
  const response = await fetch(`${url}/42/confirmed`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"confirmed":1}',
  });
  assert.equal(response.status, 500);
  assert.equal(pool.state.commits, 0);
  assert.equal(pool.state.rollbacks, 1);
});

test('rejected results do not confirm or award PCP', async (t) => {
  const pool = confirmationPool();
  const url = await serve(t, loadRouter('auxfights.js', pool));
  const response = await fetch(`${url}/42/confirmed`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"confirmed":0}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(pool.state.scores, []);
  assert.deepEqual(pool.state.confirmations, []);
});

function patchResult(url, endpoint, body) {
  return fetch(`${url}/42/${endpoint}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('zero attack submission persists and returns numeric zero, then confirms without an attack lookup', async (t) => {
  const pool = winnerPool();
  const url = await serve(t, loadRouter('auxfights.js', pool));
  const response = await patchResult(url, 'winner', { winnerfaction_id: 10, c3_attack_id: 0 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id_fight: 42, winnerfaction_id: 10, c3_attack_id: 0 });
  assert.deepEqual(pool.state.submissions, [[10, 0, 42]]);
  assert.equal(pool.state.attackId, 0);
  assert.deepEqual(pool.state.participantLookups, [[42, 10]]);
  assert.deepEqual(pool.state.scores, []);
  assert.equal(pool.state.confirmed, 0);

  const confirmation = await patchResult(url, 'confirmed', { confirmed: 1 });
  assert.equal(confirmation.status, 200);
  assert.deepEqual(await confirmation.json(), { id_fight: 42, confirmed: 1 });
  assert.deepEqual(pool.state.scores, [[1, 0, 10, 20]]);
  assert.deepEqual(pool.state.attackLookups, []);
  assert.equal(pool.state.commits, 2);
  assert.equal(pool.state.locks, 2);
  assert.equal(pool.state.releases, 2);
});

test('zero result retries are idempotent and conflicting submissions cannot overwrite it', async (t) => {
  const pool = winnerPool();
  const url = await serve(t, loadRouter('auxfights.js', pool));
  const body = { winnerfaction_id: 10, c3_attack_id: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await patchResult(url, 'winner', body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id_fight: 42, ...body });
  }
  for (const conflict of [
    { winnerfaction_id: 20, c3_attack_id: 0 },
    { winnerfaction_id: 10, c3_attack_id: 2 },
  ]) {
    assert.equal((await patchResult(url, 'winner', conflict)).status, 409);
  }
  assert.deepEqual(pool.state.submissions, [[10, 0, 42]]);
  assert.equal(pool.state.winnerFaction, 10);
  assert.equal(pool.state.attackId, 0);
  assert.equal(pool.state.commits, 1);
  assert.equal(pool.state.rollbacks, 3);
  assert.equal(pool.state.locks, 4);
  assert.deepEqual(pool.state.attackLookups, []);
  assert.deepEqual(pool.state.scores, []);
});

test('positive attack submissions still validate that the attack exists', async (t) => {
  for (const attackExists of [true, false]) {
    await t.test(attackExists ? 'known attack' : 'unknown attack', async (t) => {
      const pool = winnerPool({ attackExists });
      const url = await serve(t, loadRouter('auxfights.js', pool));
      const response = await patchResult(url, 'winner', { winnerfaction_id: 10, c3_attack_id: 2 });
      assert.equal(response.status, attackExists ? 200 : 400);
      assert.deepEqual(pool.state.attackLookups, [[2]]);
      assert.deepEqual(pool.state.submissions, attackExists ? [[10, 2, 42]] : []);
      assert.equal(pool.state.commits, attackExists ? 1 : 0);
      assert.equal(pool.state.rollbacks, attackExists ? 0 : 1);
      assert.deepEqual(pool.state.scores, []);
      if (attackExists) {
        assert.deepEqual(await response.json(), { id_fight: 42, winnerfaction_id: 10, c3_attack_id: 2 });
      }
    });
  }
});

test('zero attack does not bypass participating faction validation', async (t) => {
  const pool = winnerPool({ participates: false });
  const url = await serve(t, loadRouter('auxfights.js', pool));
  assert.equal((await patchResult(url, 'winner', { winnerfaction_id: 10, c3_attack_id: 0 })).status, 400);
  assert.deepEqual(pool.state.participantLookups, [[42, 10]]);
  assert.deepEqual(pool.state.attackLookups, []);
  assert.deepEqual(pool.state.submissions, []);
  assert.deepEqual(pool.state.scores, []);
  assert.equal(pool.state.commits, 0);
  assert.equal(pool.state.rollbacks, 1);
});

test('winner submissions require an explicit non-negative safe integer attack ID', async (t) => {
  const pool = winnerPool();
  const url = await serve(t, loadRouter('auxfights.js', pool));
  for (const attackId of [undefined, null, -1, 0.5, '0', '2', '', false, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await patchResult(url, 'winner', { winnerfaction_id: 10, c3_attack_id: attackId });
    assert.equal(response.status, 400, `attack ID ${JSON.stringify(attackId)}`);
  }
  assert.equal(pool.state.transactions, 0);
  assert.deepEqual(pool.state.attackLookups, []);
  assert.deepEqual(pool.state.participantLookups, []);
  assert.deepEqual(pool.state.submissions, []);
  assert.deepEqual(pool.state.scores, []);
});

test('stored zero attacks award PCP exactly once in fixed season 1', async (t) => {
  for (const attackId of [0, '0']) {
    await t.test(`stored ${typeof attackId} zero`, async (t) => {
      const pool = confirmationPool({ attackId, season: 7 });
      const url = await serve(t, loadRouter('auxfights.js', pool));
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await patchResult(url, 'confirmed', { confirmed: 1 });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { id_fight: 42, confirmed: 1 });
        pool.state.reference = 99;
      }
      assert.deepEqual(pool.state.scores, [[1, attackId, 10, 20]]);
      assert.deepEqual(pool.state.confirmations, [[42]]);
      assert.deepEqual(pool.state.attackLookups, []);
      assert.equal(pool.state.scoreWrites, 1);
      assert.equal(pool.state.commits, 1);
      assert.equal(pool.state.rollbacks, 1);
      assert.equal(pool.state.locks, 2);
      assert.equal(pool.state.releases, 2);
    });
  }
});

test('positive attack confirmation uses the actual attack season rather than season 1', async (t) => {
  const pool = confirmationPool({ attackId: 2, season: 7 });
  const url = await serve(t, loadRouter('auxfights.js', pool));
  assert.equal((await patchResult(url, 'confirmed', { confirmed: 1 })).status, 200);
  assert.deepEqual(pool.state.attackLookups, [[2]]);
  assert.deepEqual(pool.state.scores, [[7, 2, 10, 20]]);
  assert.equal(pool.state.commits, 1);
});

test('NULL and negative stored attacks cannot be confirmed or awarded PCP', async (t) => {
  for (const attackId of [null, -1]) {
    await t.test(`stored attack ${attackId}`, async (t) => {
      const pool = confirmationPool({ attackId });
      const url = await serve(t, loadRouter('auxfights.js', pool));
      assert.equal((await patchResult(url, 'confirmed', { confirmed: 1 })).status, 409);
      assert.deepEqual(pool.state.attackLookups, []);
      assert.deepEqual(pool.state.scores, []);
      assert.deepEqual(pool.state.confirmations, []);
      assert.equal(pool.state.confirmed, 0);
      assert.equal(pool.state.commits, 0);
      assert.equal(pool.state.rollbacks, 1);
    });
  }
});

test('rejecting an unassigned result clears the submission without awarding PCP', async (t) => {
  const pool = confirmationPool({ attackId: 0 });
  const url = await serve(t, loadRouter('auxfights.js', pool));
  const response = await patchResult(url, 'confirmed', { confirmed: 0 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id_fight: 42, confirmed: 0 });
  assert.equal(pool.state.winnerFaction, null);
  assert.equal(pool.state.attackId, null);
  assert.equal(pool.state.confirmed, 0);
  assert.deepEqual(pool.state.attackLookups, []);
  assert.deepEqual(pool.state.scores, []);
  assert.deepEqual(pool.state.confirmations, []);
  assert.equal(pool.state.commits, 1);
});

test('zero attack confirmation rolls back if either award or confirmation write fails', async (t) => {
  for (const failure of ['failScore', 'failConfirmation']) {
    await t.test(failure, async (t) => {
      const pool = confirmationPool({ attackId: 0, [failure]: true });
      const url = await serve(t, loadRouter('auxfights.js', pool));
      const response = await patchResult(url, 'confirmed', { confirmed: 1 });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { message: 'Server error' });
      assert.deepEqual(pool.state.attackLookups, []);
      assert.equal(pool.state.scoreWrites, 1);
      assert.deepEqual(pool.state.scores, []);
      assert.deepEqual(pool.state.confirmations, []);
      assert.equal(pool.state.confirmed, 0);
      assert.equal(pool.state.commits, 0);
      assert.equal(pool.state.rollbacks, 1);
      assert.equal(pool.state.releases, 1);
    });
  }
});
