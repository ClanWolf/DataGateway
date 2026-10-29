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

router.get("/highscore", async (req, res) => {
  /*
    #swagger.tags = ['Auxiliary users']
    #swagger.summary = 'All-time PCP ranking of all auxiliary users'
    #swagger.description = 'Every participant of the winning faction receives PCP, regardless of fightcreator or planet assignment (including c3_attack_id = 0). PCP are calculated live as current PCP_AUX times fight_teamsize across all seasons. Only confirmed fights with a positive winner count as played for every participant. Equal PCP totals share a rank.'
    #swagger.responses[200] = { description: 'Ranked users', schema: [{ rank: 1, id_user: 12, username: 'Player', fights: 3, pcp: 20 }] }
    #swagger.responses[500] = { description: 'Database error or invalid PCP reference' }
  */
  try {
    const references = await db.pool.query(
      "SELECT `Value` FROM c3_SCORE_REFERENCE WHERE `Key` = ?", ["PCP_AUX"]
    );
    if (references.length !== 1 || references[0].Value === null ||
        String(references[0].Value).trim() === "" ||
        !Number.isFinite(Number(references[0].Value))) {
      throw new Error("PCP_AUX reference is missing or invalid");
    }
    const rows = await db.pool.query(`
      SELECT u.id_user, u.username,
             COUNT(completed.id_fight) AS fights,
             COALESCE(SUM(CASE WHEN completed.won = 1
                         THEN ? * completed.team_size ELSE 0 END), 0) AS pcp
      FROM aux_users u
      LEFT JOIN (
        SELECT fu.user_id, f.id_fight,
               CASE WHEN f.fight_teamsize > 0 THEN f.fight_teamsize ELSE 1 END AS team_size,
               MAX(CASE WHEN fu.faction_id = f.winnerfaction_id
                        THEN 1 ELSE 0 END) AS won
        FROM aux_fightusers fu
        INNER JOIN aux_fights f ON f.id_fight = fu.fight_id
        WHERE f.confirmed = 1 AND f.winnerfaction_id > 0
        GROUP BY fu.user_id, f.id_fight, f.fight_teamsize
      ) completed ON completed.user_id = u.id_user
      GROUP BY u.id_user, u.username
      ORDER BY pcp DESC, u.username ASC, u.id_user ASC
    `, [Number(references[0].Value)]);
    let rank = 0;
    let previousPcp;
    const highscore = rows.map((row, index) => {
      const pcp = Number(row.pcp);
      if (!Number.isFinite(pcp)) throw new Error("Invalid highscore PCP total");
      if (index === 0 || pcp !== previousPcp) rank = index + 1;
      previousPcp = pcp;
      return { rank, id_user: Number(row.id_user), username: row.username, fights: Number(row.fights), pcp };
    });
    return res.status(200).json(highscore);
  } catch (err) {
    logger.error("Failed to load auxiliary highscore: " + err.message);
    return res.status(500).json({ message: "Server error" });
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
