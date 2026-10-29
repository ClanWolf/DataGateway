const { logger } = require("../logger.js");
const db = require("../db.js");
const AuxFight = require("../models/AuxFight");

const express = require("express");
const router = express.Router();

const TABLE_NAME = "aux_fights";
const PRIMARY_KEY_COLUMN = "id_fight";
const UNASSIGNED_ATTACK_SEASON_ID = 1;

function serializeInsertResult(result) {
  return {
    affectedRows: Number(result.affectedRows || 0),
    insertId: result.insertId ? result.insertId.toString() : null,
  };
}

async function getWritableColumns() {
  const columns = await db.pool.query(`SHOW COLUMNS FROM ${TABLE_NAME}`);

  return columns
    .filter((column) => !String(column.Extra || "").includes("auto_increment"))
    .map((column) => column.Field);
}

router.get("/", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'List auxiliary fights'
    #swagger.parameters['count'] = { in: 'query', description: 'Return only the count of confirmed fights with a positive winner, including fights without a planet assignment.', required: false, type: 'boolean', default: false }
    #swagger.responses[200] = { description: 'Auxiliary fights, or { count: integer } when count=true' }
  */
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  try {
    if (req.query.count === "true") {
      const rows = await db.pool.query(
        `SELECT COUNT(*) AS count FROM ${TABLE_NAME} WHERE confirmed = 1 AND winnerfaction_id > 0`
      );
      logger.info("Auxfight count requested from ip: " + ip);
      return res.status(200).json({ count: Number(rows[0].count) });
    }

    const fights = await db.pool.query(`SELECT * FROM ${TABLE_NAME}`);
    const auxFights = fights.map((fight) => new AuxFight(fight));
    logger.info("List of all auxfight records requested from ip: " + ip);

    res.status(200).send(auxFights);
  } catch (err) {
    logger.error("Failed to load auxfight records: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/:id", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'Get a fight visible to a user'
    #swagger.description = 'Returns a fight for the supplied user ID only when it is unconfirmed or has a winner faction.'
    #swagger.parameters['id'] = { description: 'User ID', required: true, type: 'integer' }
    #swagger.responses[200] = { description: 'Visible auxiliary fight', schema: { $ref: '#/definitions/AuxFight' } }
    #swagger.responses[404] = { description: 'No visible fight for this user' }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  try {
    // Finde den fight für diese user_id
    const fightResult = await db.pool.query(
      `
        SELECT DISTINCT af.*
        FROM aux_fights af
        LEFT JOIN aux_fightusers au ON af.id_fight = au.fight_id
        WHERE (
          af.confirmed = 0
          OR (
            af.confirmed = 0 AND
            af.winnerfaction_id IS NOT NULL
            AND af.winnerfaction_id > 0
          )
        )
        AND au.user_id = ?
        LIMIT 1
      `,
      [req.params.id]
    );

    if (fightResult.length === 0) {
      return res.sendStatus(404);
    }

    const fight = new AuxFight(fightResult[0]);
    const fightId = fightResult[0].id_fight;

    // Hole alle fightusers für diesen fight
    const fightUsers = await db.pool.query(
      `SELECT user_id, fight_id, faction_id, fightcreator FROM aux_fightusers WHERE fight_id = ?`,
      [fightId]
    );

    logger.info(
      "Auxfight record with id " + req.params.id + " requested from ip: " + ip
    );

    res.status(200).json({
      fight: fight,
      fightusers: fightUsers
    });
  } catch (err) {
    logger.error("Failed to load auxfight record: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/:id/history", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'Get all fights of a user including participants'
    #swagger.description = 'Returns all auxiliary fights associated with the supplied user ID, including all participating users.'
    #swagger.parameters['id'] = { description: 'User ID', required: true, type: 'integer' }
    #swagger.responses[200] = { description: 'Auxiliary fights with participants and usernames', schema: { $ref: '#/definitions/AuxFightHistory' } }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  try {
    // Alle Fights ermitteln, an denen :id beteiligt ist.
    const fightResult = await db.pool.query(
        `
          SELECT DISTINCT af.*
          FROM aux_fights af
                 INNER JOIN aux_fightusers requested_user
                            ON requested_user.fight_id = af.id_fight
          WHERE requested_user.user_id = ?
          ORDER BY af.updated DESC
        `,
        [req.params.id]
    );

    if (fightResult.length === 0) {
      return res.status(200).json({ fights: [] });
    }

    const fightIds = fightResult.map((fight) => fight.id_fight);
    const placeholders = fightIds.map(() => "?").join(", ");

    // Alle Teilnehmer der gefundenen Fights inklusive Namen laden.
    const fightUsers = await db.pool.query(
        `
        SELECT
          afu.id_fightusers,
          afu.fight_id,
          afu.user_id,
          afu.faction_id,
          afu.fightcreator,
          afu.updated,
          au.username
        FROM aux_fightusers afu
        INNER JOIN aux_users au ON au.id_user = afu.user_id
        WHERE afu.fight_id IN (${placeholders})
        ORDER BY afu.fight_id, afu.fightcreator DESC
      `,
        fightIds
    );

    // fightusers per fight_id gruppieren.
    const fightUsersByFightId = new Map();

    for (const fightUser of fightUsers) {
      const fightId = String(fightUser.fight_id);

      if (!fightUsersByFightId.has(fightId)) {
        fightUsersByFightId.set(fightId, []);
      }

      fightUsersByFightId.get(fightId).push(fightUser);
    }

    const fights = fightResult.map((fightData) => ({
      fight: new AuxFight(fightData),
      fightusers: fightUsersByFightId.get(String(fightData.id_fight)) || [],
    }));

    logger.info(
        "Auxfight history for user " + req.params.id + " requested from ip: " + ip
    );

    return res.status(200).json({ fights });
  } catch (err) {
    logger.error("Failed to load auxfight history: " + err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'Create an auxiliary fight for two users'
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/CreateAuxFightRequest' } }
    #swagger.responses[201] = { description: 'Auxiliary fight created', schema: { $ref: '#/definitions/CreatedAuxFight' } }
    #swagger.responses[400] = { description: 'Validation error', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
  const ip =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  const {
    initiator_user_id,
    initiator_faction_id,
    opponent_user_id,
    opponent_faction_id,
    campaign_id = null,
    fight_name = "fight",
    fight_teamsize = 1,
  } = req.body || {};

  let connection;

  try {
    // ---------------------------------------------------------
    // Validation
    // ---------------------------------------------------------

    if (
      !Number.isInteger(initiator_user_id) ||
      !Number.isInteger(opponent_user_id)
    ) {
      return res.status(400).json({
        message: "initiator_user_id and opponent_user_id are required",
      });
    }

    if (initiator_user_id === opponent_user_id) {
      return res.status(400).json({
        message: "Initiator and opponent must be different users",
      });
    }

    if (
      !Number.isInteger(initiator_faction_id) ||
      !Number.isInteger(opponent_faction_id)
    ) {
      return res.status(400).json({
        message:
          "initiator_faction_id and opponent_faction_id are required",
      });
    }

    if (campaign_id !== null && !Number.isInteger(campaign_id)) {
      return res.status(400).json({
        message: "campaign_id must be an integer or null",
      });
    }

    if (!Number.isSafeInteger(fight_teamsize) || fight_teamsize < 1 || fight_teamsize > 2147483647) {
      return res.status(400).json({
        message: "fight_teamsize must be a positive integer no greater than 2147483647",
      });
    }

    if (typeof fight_name !== "string" || fight_name.trim().length === 0) {
      return res.status(400).json({
        message: "fight_name must be a non-empty string",
      });
    }

    // ---------------------------------------------------------
    // Transaction
    // ---------------------------------------------------------

    connection = await db.pool.getConnection();

    await connection.beginTransaction();

    // ---------------------------------------------------------
    // Create fight
    // ---------------------------------------------------------

    const fightResult = await connection.query(
      `
        INSERT INTO aux_fights (
          fight_name,
          fight_teamsize,
          confirmed,
          capmaign_id,
          c3_attack_id,
          winnerfaction_id
        )
        VALUES (?, ?, 0, ?, NULL, NULL)
      `,
      [fight_name.trim(), fight_teamsize, campaign_id]
    );

    const fightId = fightResult.insertId;

    // ---------------------------------------------------------
    // Add initiator
    // ---------------------------------------------------------

    await connection.query(
      `
        INSERT INTO aux_fightusers (
          fight_id,
          user_id,
          faction_id,
          fightcreator
        )
        VALUES (?, ?, ?, 1)
      `,
      [fightId, initiator_user_id, initiator_faction_id]
    );

    // ---------------------------------------------------------
    // Add opponent
    // ---------------------------------------------------------

    await connection.query(
      `
        INSERT INTO aux_fightusers (
          fight_id,
          user_id,
          faction_id,
          fightcreator
        )
        VALUES (?, ?, ?, 0)
      `,
      [fightId, opponent_user_id, opponent_faction_id]
    );

    // ---------------------------------------------------------
    // Commit
    // ---------------------------------------------------------

    await connection.commit();

    logger.info(
      `Auxfight ${fightId} created from ip: ${ip}. ` +
        `Initiator: ${initiator_user_id}, ` +
        `Opponent: ${opponent_user_id}`
    );

    return res.status(201).json({
      id_fight: fightId.toString(),
      fight_name: fight_name.trim(),
      fight_teamsize,
      confirmed: false,
      campaign_id,
      winnerfaction_id: null,
      users: [
        {
          user_id: initiator_user_id,
          faction_id: initiator_faction_id,
          fightcreator: true,
        },
        {
          user_id: opponent_user_id,
          faction_id: opponent_faction_id,
          fightcreator: false,
        },
      ],
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        logger.error(
          "Failed to rollback auxfight transaction: " +
            rollbackError.message
        );
      }
    }

    logger.error("Failed to create auxfight: " + err.message);

    return res.status(500).json({
      message: err.message,
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.patch("/:id/cancel", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'Cancel an auxiliary fight'
    #swagger.parameters['id'] = { description: 'Fight ID', required: true, type: 'integer' }
    #swagger.responses[200] = { description: 'Cancelled fight', schema: { $ref: '#/definitions/CancelledAuxFight' } }
    #swagger.responses[404] = { description: 'Fight not found', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[409] = { description: 'Fight already completed', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
  const ip =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  const fightId = req.params.id;

  try {
    const result = await db.pool.query(
      `
        UPDATE aux_fights
        SET
          winnerfaction_id = -1,
          confirmed = 1
        WHERE id_fight = ? AND confirmed = 0
      `,
      [fightId]
    );

    if (result.affectedRows === 0) {
      const fights = await db.pool.query("SELECT id_fight FROM aux_fights WHERE id_fight = ?", [fightId]);
      return res.status(fights.length ? 409 : 404).json({
        message: fights.length ? "Auxfight already completed" : "Auxfight not found",
      });
    }

    logger.info(
      `Auxfight ${fightId} cancelled from ip: ${ip}`
    );

    return res.status(200).json({
      id_fight: fightId,
      winnerfaction_id: -1,
      confirmed: 1,
      cancelled: true,
    });
  } catch (err) {
    logger.error(
      "Failed to cancel auxfight: " + err.message
    );

    return res.status(500).json({
      message: err.message,
    });
  }
});

router.patch("/:id/confirmed", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'Confirm an auxiliary fight and insert its own PCP score row exactly once, or reject the submitted result'
    #swagger.description = 'Without a planet assignment (c3_attack_id = 0), PCP are recorded with AttackID 0 and fixed SeasonId 1. Assigned attacks use their own season.'
    #swagger.parameters['id'] = { description: 'Fight ID', required: true, type: 'integer' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ConfirmationUpdateRequest' } }
    #swagger.responses[200] = { description: 'Updated confirmation status', schema: { $ref: '#/definitions/ConfirmationUpdate' } }
    #swagger.responses[400] = { description: 'Invalid confirmation status', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[404] = { description: 'Fight not found', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[409] = { description: 'Fight already completed, result incomplete, PCP reference invalid or planet fight season invalid', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
  const ip =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  const fightId = Number(req.params.id);
  const { confirmed } = req.body || {};
  let connection;
  let committed = false;

  try {
    if (!Number.isSafeInteger(fightId) || fightId <= 0) {
      return res.status(400).json({ message: "id must be a positive integer" });
    }
    if (confirmed !== 0 && confirmed !== 1) {
      return res.status(400).json({
        message: "confirmed must be either 0 or 1",
      });
    }

    connection = await db.pool.getConnection();
    await connection.beginTransaction();
    const fights = await connection.query(
      "SELECT confirmed, winnerfaction_id, c3_attack_id, fight_teamsize FROM aux_fights WHERE id_fight = ? FOR UPDATE",
      [fightId]
    );

    if (!fights.length) {
      return res.status(404).json({
        message: "Auxfight not found",
      });
    }
    const fight = fights[0];
    if (Number(fight.confirmed) !== 0) {
      if (confirmed === 1 && Number(fight.confirmed) === 1 && Number(fight.winnerfaction_id) > 0) {
        return res.status(200).json({ id_fight: fightId, confirmed: 1 });
      }
      return res.status(409).json({ message: "Auxfight already completed" });
    }
    if (confirmed === 0) {
      // Rejection reopens the match for the creator to submit a corrected result.
      // No PCP score has been awarded while the fight is unconfirmed.
      await connection.query(
        "UPDATE aux_fights SET winnerfaction_id = NULL, c3_attack_id = NULL WHERE id_fight = ?",
        [fightId]
      );
      await connection.commit();
      committed = true;
      return res.status(200).json({ id_fight: fightId, confirmed: 0 });
    }
    if (!Number.isSafeInteger(Number(fight.winnerfaction_id)) || Number(fight.winnerfaction_id) <= 0 ||
        fight.c3_attack_id === null ||
        !Number.isSafeInteger(Number(fight.c3_attack_id)) || Number(fight.c3_attack_id) < 0) {
      return res.status(409).json({ message: "Winner and planet fight ID (0 for no assignment) must be submitted first" });
    }

    const references = await connection.query(
      "SELECT `Value` FROM c3_SCORE_REFERENCE WHERE `Key` = ?",
      ["PCP_AUX"]
    );
    if (references.length !== 1 || references[0].Value === null ||
        String(references[0].Value).trim() === "" ||
        !Number.isFinite(Number(references[0].Value))) {
      return res.status(409).json({ message: "PCP_AUX reference is missing or invalid" });
    }
    const teamSize = new AuxFight(fight).fight_teamsize;
    const pcpAward = Number(references[0].Value) * teamSize;
    if (!Number.isFinite(pcpAward)) {
      return res.status(409).json({ message: "Calculated PCP award is invalid" });
    }
    let seasonId = UNASSIGNED_ATTACK_SEASON_ID;
    if (Number(fight.c3_attack_id) > 0) {
      const attacks = await connection.query(
        "SELECT Season FROM c3_ATTACK WHERE ID = ?",
        [fight.c3_attack_id]
      );
      seasonId = Number(attacks[0]?.Season);
      if (attacks.length !== 1 || !Number.isSafeInteger(seasonId) || seasonId <= 0) {
        return res.status(409).json({ message: "Planet fight has no valid season" });
      }
    }

    // Each confirmed aux fight gets a separate award, even for the same
    // faction/attack/season. The fight row locked above prevents duplicate
    // awards on retries; insert and confirmation commit atomically.
    await connection.query(
      "INSERT INTO c3_SCORE (SeasonId, AttackID, FactionID, PCP) VALUES (?, ?, ?, ?)",
      [seasonId, fight.c3_attack_id, fight.winnerfaction_id, pcpAward]
    );
    await connection.query(
      "UPDATE aux_fights SET confirmed = 1 WHERE id_fight = ?",
      [fightId]
    );
    await connection.commit();
    committed = true;

    logger.info(
      `Confirmed for auxfight ${fightId} updated to ${confirmed} from ip: ${ip}`
    );

    return res.status(200).json({
      id_fight: fightId,
      confirmed,
    });
  } catch (err) {
    logger.error(
      "Failed to update auxfight confirmation: " + err.message
    );

    return res.status(500).json({
      message: "Server error",
    });
  } finally {
    if (connection) {
      if (!committed) {
        try { await connection.rollback(); }
        catch (err) { logger.error("Failed to rollback confirmation: " + err.message); }
      }
      connection.release();
    }
  }
});

router.patch("/:id/winner", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary fights']
    #swagger.summary = 'Submit the winning faction and planet fight ID (0 for no assignment; no PCP awarded yet)'
    #swagger.parameters['id'] = { description: 'Fight ID', required: true, type: 'integer' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/WinnerUpdateRequest' } }
    #swagger.responses[200] = { description: 'Updated winning faction', schema: { $ref: '#/definitions/WinnerUpdate' } }
    #swagger.responses[400] = { description: 'Invalid winner faction or attack ID', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[404] = { description: 'Fight not found', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[409] = { description: 'Fight already submitted or completed', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
  const ip =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  const fightId = Number(req.params.id);
  const { winnerfaction_id, c3_attack_id } = req.body || {};
  let connection;
  let committed = false;

  try {
    if (!Number.isSafeInteger(fightId) || fightId <= 0 ||
        !Number.isSafeInteger(winnerfaction_id) || winnerfaction_id <= 0 ||
        !Number.isSafeInteger(c3_attack_id) || c3_attack_id < 0) {
      return res.status(400).json({
        message: "id and winnerfaction_id must be positive integers; c3_attack_id must be a non-negative integer (0 for no assignment)",
      });
    }

    connection = await db.pool.getConnection();
    await connection.beginTransaction();
    const fights = await connection.query(
      "SELECT confirmed, winnerfaction_id, c3_attack_id FROM aux_fights WHERE id_fight = ? FOR UPDATE",
      [fightId]
    );

    if (!fights.length) {
      return res.status(404).json({
        message: "Auxfight not found",
      });
    }
    const fight = fights[0];
    if (Number(fight.confirmed) !== 0 || fight.winnerfaction_id !== null) {
      if (Number(fight.confirmed) === 0 && Number(fight.winnerfaction_id) === winnerfaction_id &&
          Number(fight.c3_attack_id) === c3_attack_id) {
        return res.status(200).json({ id_fight: fightId, winnerfaction_id, c3_attack_id });
      }
      return res.status(409).json({ message: "Auxfight already submitted or completed" });
    }
    if (c3_attack_id > 0) {
      const attacks = await connection.query("SELECT ID FROM c3_ATTACK WHERE ID = ?", [c3_attack_id]);
      if (!attacks.length) {
        return res.status(400).json({ message: "Unknown attack or winner faction does not participate in this fight" });
      }
    }
    const participants = await connection.query(
      "SELECT faction_id FROM aux_fightusers WHERE fight_id = ? AND faction_id = ?",
      [fightId, winnerfaction_id]
    );
    if (!participants.length) {
      return res.status(400).json({ message: "Unknown attack or winner faction does not participate in this fight" });
    }
    await connection.query(
      "UPDATE aux_fights SET winnerfaction_id = ?, c3_attack_id = ? WHERE id_fight = ?",
      [winnerfaction_id, c3_attack_id, fightId]
    );
    await connection.commit();
    committed = true;

    logger.info(
      `Winner faction for auxfight ${fightId} updated to ${winnerfaction_id} from ip: ${ip}`
    );

    return res.status(200).json({
      id_fight: fightId,
      winnerfaction_id,
      c3_attack_id,
    });
  } catch (err) {
    logger.error(
      "Failed to update auxfight winner faction: " + err.message
    );

    return res.status(500).json({
      message: "Server error",
    });
  } finally {
    if (connection) {
      if (!committed) {
        try { await connection.rollback(); }
        catch (err) { logger.error("Failed to rollback result submission: " + err.message); }
      }
      connection.release();
    }
  }
});

module.exports = router;
