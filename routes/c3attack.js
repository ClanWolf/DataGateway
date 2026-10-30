const { logger } = require("../logger.js");
const db = require("../db.js");
const C3Attack = require("../models/C3Attack");

const express = require("express");
const router = express.Router();

const TABLE_NAME = "c3_ATTACK";
const PRIMARY_KEY_COLUMN = "id";

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
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  try {
    const attacks = await db.pool.query(`SELECT * FROM ${TABLE_NAME}`);
    const c3Attacks = attacks.map((attack) => new C3Attack(attack));
    logger.info("List of all c3_ATTACK records requested from ip: " + ip);

    res.status(200).send(c3Attacks);
  } catch (err) {
    logger.error("Failed to load c3_ATTACK records: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/season/:seasonId/list", async (req, res) => {

  /*
  #swagger.tags = ['C3 Attack']
  #swagger.summary = 'Get all season attacks with winner highlighting, faction names and booked PCP'
  #swagger.parameters['seasonId'] = { description: 'ID of the given season', required: true, type: 'integer' }
  #swagger.responses[200] = {
    description: 'List of attacks for the given season',
    schema: {
      type: 'array',
      items: { $ref: '#/definitions/C3Attack' }
    }
  }
  #swagger.responses[404] = {
    description: 'No attacks found for the given season',
    schema: {
      message: 'No attacks found for season {seasonId}'
    }
  }
  #swagger.responses[500] = {
    description: 'Server error',
    schema: {
      message: 'Server error'
    }
  }
  */

  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    null;

  const seasonId = Number(req.params.seasonId);
  if (!Number.isSafeInteger(seasonId) || seasonId <= 0) {
    return res.status(400).json({ message: "seasonId must be a positive integer" });
  }

  try {
    const attacks = await db.pool.query(
        `SELECT
           a.*,
           ss.Name
         FROM c3_ATTACK a
                JOIN c3_STARSYSTEM ss
                     ON ss.ID = a.StarSystemID
         WHERE a.Season = ?
         ORDER BY a.Round DESC, a.ID DESC`,
        [seasonId]
    );

    if(attacks.length === 0) {
      return  res.status(404).json({
        message: "No attacks found for season " + req.params.seasonId,
      });
    }

    // Aggregate before resolving names: multiple awards must not multiply PCP.
    const scores = await db.pool.query(
      `SELECT s.AttackID, s.FactionID, SUM(s.PCP) AS pcp
       FROM c3_SCORE s
       JOIN c3_ATTACK a ON a.ID = s.AttackID AND a.Season = s.SeasonId
       WHERE a.Season = ?
       GROUP BY s.AttackID, s.FactionID`,
      [seasonId]
    );
    const scoresByAttack = new Map();
    for (const score of scores) {
      const attackId = Number(score.AttackID);
      if (!scoresByAttack.has(attackId)) scoresByAttack.set(attackId, new Map());
      scoresByAttack.get(attackId).set(Number(score.FactionID), Number(score.pcp));
    }
    const factionIdsByAttack = new Map(attacks.map((attack) => [
      Number(attack.ID),
      [...new Set([
        ...C3Attack.factionIds(attack),
        ...(scoresByAttack.get(Number(attack.ID))?.keys() || []),
      ])].filter((id) => Number.isSafeInteger(id) && id > 0),
    ]));
    const factionIds = [...new Set([...factionIdsByAttack.values()].flat())];
    const factions = factionIds.length === 0 ? [] : await db.pool.query(
      `SELECT ID, Name_de, Name_en FROM c3_FACTION
       WHERE ID IN (${factionIds.map(() => "?").join(", ")})`,
      factionIds
    );
    const factionsById = new Map(factions.map((faction) => [Number(faction.ID), faction]));
    const c3Attacks = attacks.map((attack) => new C3Attack(attack,
      factionIdsByAttack.get(Number(attack.ID)).map((id) => ({
        faction_id: id,
        name: {
          de: factionsById.get(id)?.Name_de ?? null,
          en: factionsById.get(id)?.Name_en ?? null,
        },
        pcp: scoresByAttack.get(Number(attack.ID))?.get(id) ?? 0,
      }))
    ));

    logger.info(
      "c3_ATTACK records for season " +
        req.params.seasonId +
        " requested from ip: " +
        ip
    );

    res.status(200).json(c3Attacks);
  } catch (err) {
    logger.error(
      "Failed to load c3_ATTACK records: " + err.message
    );

    res.status(500).json({
      message: "Server error",
    });
  }
});

router.post("/", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const payload = req.body || {};

  try {
    if (Array.isArray(payload) || typeof payload !== "object") {
      return res.status(400).json({ message: "Request body must be an object" });
    }

    const writableColumns = await getWritableColumns();
    const requestColumns = Object.keys(payload);
    const unknownColumns = requestColumns.filter(
      (key) => !writableColumns.includes(key)
    );

    if (unknownColumns.length > 0) {
      return res.status(400).json({
        message: "Unknown or read-only c3_ATTACK fields provided",
        fields: unknownColumns,
      });
    }

    const payloadColumns = requestColumns.filter((key) =>
      writableColumns.includes(key)
    );

    if (payloadColumns.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid c3_ATTACK fields provided" });
    }

    const columns = payloadColumns.map((column) => `\`${column}\``).join(", ");
    const placeholders = payloadColumns.map(() => "?").join(", ");
    const values = payloadColumns.map((column) => payload[column]);

    const result = await db.pool.query(
      `INSERT INTO ${TABLE_NAME} (${columns}) VALUES (${placeholders})`,
      values
    );

    logger.info("c3_ATTACK record created from ip: " + ip);

    res.status(201).json(serializeInsertResult(result));
  } catch (err) {
    logger.error("Failed to create c3_ATTACK record: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
