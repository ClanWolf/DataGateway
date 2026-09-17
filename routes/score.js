const { logger } = require("../logger.js");
const db = require("../db.js");

const express = require("express");
const router = express.Router();

const TABLE_NAME = "c3_SCORE";

router.get("/", async (req, res) => {
  /*
    #swagger.tags = ['Score']
    #swagger.summary = 'Get sum of scores filtered by season, attack and faction'
    #swagger.parameters['seasonid'] = { description: 'Season ID to filter by', required: true, type: 'integer' }
    #swagger.parameters['attackid'] = { description: 'Attack ID to filter by', required: true, type: 'integer' }
    #swagger.parameters['factionid'] = { description: 'Faction ID to filter by', required: true, type: 'integer' }
    #swagger.responses[200] = { description: 'Sum of scores', schema: { type: 'object', properties: { sum: { type: 'number' } } } }
    #swagger.responses[400] = { description: 'Missing required parameters', schema: { $ref: '#/definitions/Error' } }
    #swagger.responses[500] = { description: 'Database error', schema: { $ref: '#/definitions/Error' } }
  */
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

  const { seasonid, attackid, factionid } = req.query;

  // Validate required parameters
  if (!seasonid || !attackid || !factionid) {
    return res.status(400).json({
      message: "seasonid, attackid, and factionid are required query parameters",
    });
  }

  // Validate that parameters are integers
  const seasonIdInt = parseInt(seasonid, 10);
  const attackIdInt = parseInt(attackid, 10);
  const factionIdInt = parseInt(factionid, 10);

  if (
    isNaN(seasonIdInt) ||
    isNaN(attackIdInt) ||
    isNaN(factionIdInt)
  ) {
    return res.status(400).json({
      message: "seasonid, attackid, and factionid must be valid integers",
    });
  }

  try {
    // Query to sum all values from c3_SCORE table matching the criteria
    const result = await db.pool.query(
      `
        SELECT COALESCE(SUM(PCP), 0) as totalScore
        FROM ${TABLE_NAME}
        WHERE SeasonId = ?
          AND Attackid = ?
          AND Factionid = ?
      `,
      [seasonIdInt, attackIdInt, factionIdInt]
    );

    const totalScore = result[0]?.totalScore || 0;

    logger.info(
      `Score sum requested for season=${seasonIdInt}, attack=${attackIdInt}, faction=${factionIdInt} from ip: ${ip}`
    );

    res.status(200).json({
      seasonid: seasonIdInt,
      attackid: attackIdInt,
      factionid: factionIdInt,
      sum: totalScore,
    });
  } catch (err) {
    logger.error("Failed to get score sum: " + err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
