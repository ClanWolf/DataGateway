const { logger } = require("../logger.js");
const db = require("../db.js");
const AuxUser = require("../models/AuxUser");

const express = require("express");
const router = express.Router();

const TABLE_NAME = "aux_users";
const PRIMARY_KEY_COLUMN = "id_user";

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
    const users = await db.pool.query(`SELECT * FROM ${TABLE_NAME}`);
    const auxUsers = users.map((user) => new AuxUser(user));
    logger.info("List of all auxuser records requested from ip: " + ip);

    res.status(200).send(auxUsers);
  } catch (err) {
    logger.error("Failed to load auxuser records: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/:id", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  try {
    const users = await db.pool.query(
      `SELECT * FROM ${TABLE_NAME} WHERE \`${PRIMARY_KEY_COLUMN}\` = ? LIMIT 1`,
      [req.params.id]
    );

    logger.info(
      "Auxuser record with id " + req.params.id + " requested from ip: " + ip
    );

    users.length > 0
      ? res.status(200).json(new AuxUser(users[0]))
      : res.sendStatus(404);
  } catch (err) {
    logger.error("Failed to load auxuser record: " + err.message);
    res.status(500).json({ message: "Server error" });
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
        message: "Unknown or read-only auxuser fields provided",
        fields: unknownColumns,
      });
    }

    const payloadColumns = requestColumns.filter((key) =>
      writableColumns.includes(key)
    );

    if (payloadColumns.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid auxuser fields provided" });
    }

    if (payloadColumns.includes("username")) {
      const existingUsers = await db.pool.query(
        `SELECT 1 FROM ${TABLE_NAME} WHERE \`username\` = ? LIMIT 1`,
        [payload.username]
      );

      if (existingUsers.length > 0) {
        logger.warn(
          "Attempted creation of existing auxuser '" +
            payload.username +
            "' from ip: " +
            ip
        );

        return res.status(403).json({
          message: "An auxuser with this username already exists",
        });
      }
    }

    const columns = payloadColumns.map((column) => `\`${column}\``).join(", ");
    const placeholders = payloadColumns.map(() => "?").join(", ");
    const values = payloadColumns.map((column) => payload[column]);

    const result = await db.pool.query(
      `INSERT INTO ${TABLE_NAME} (${columns}) VALUES (${placeholders})`,
      values
    );

    logger.info("Auxuser record created from ip: " + ip);

    res.status(201).json(serializeInsertResult(result));
  } catch (err) {
    logger.error("Failed to create auxuser record: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
