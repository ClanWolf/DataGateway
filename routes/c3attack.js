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

router.get("/:seasonId", async (req, res) => {

  /*
  #swagger.tags = ['C3 Attack']
  #swagger.summary = 'Get all attacks of a given season'
  #swagger.parameters['seasonId'] = { description: 'ID of the given season', required: true, type: 'integer' }
  */

  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    null;

  try {
    const attacks = await db.pool.query(
      `SELECT
          a.ID,
          a.Season,
          ss.Name,
          a.Round
       FROM c3_ATTACK a
       JOIN c3_STARSYSTEM ss
         ON ss.ID = a.StarSystemID
       WHERE a.Season = ?`,
      [req.params.seasonId]
    );

    const c3Attacks = attacks.map(
      (attack) => new C3Attack(attack)
    );

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
