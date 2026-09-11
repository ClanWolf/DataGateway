const express = require("express");

const { logger } = require("./logger.js");
const listDir = require("./fileTools.js");

const bodyParser = require("body-parser");
const path = require("path");
const app = express();
const port = 3000;

const expHbs = require("express-handlebars");

const swaggerUi = require('swagger-ui-express');
const swaggerFile = require('./swagger_output.json');

let date = new Date().toISOString().split("T")[0];

logger.info("Starting up DataGateway (Database Webservice)...");

var handlebars = expHbs.create({
  defaultLayout: "main-layout",
  extname: ".handlebars",
  layoutsDir: path.join(__dirname, "views", "layouts"),
  helpers: {
    substr: function (length, context, options) {
      if (context.length > length) {
        return context.substring(0, length) + "...";
      } else {
        return context;
      }
    },
  },
});
app.engine(".handlebars", handlebars.engine);
app.set("view engine", ".handlebars");
app.set("views", "views");

// Allow CORS
const cors = require("cors");
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = ["https://sb.clanwolf.net", "https://aux.clanwolf.net"];
      if (allowedOrigins.includes(origin) || !origin) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerFile));

app.use("/login", require("./routes/login.js"));
app.use("/player", require("./routes/player.js"));
app.use("/games", require("./routes/games.js"));
app.use("/auxcampaign", require("./routes/auxcampaign.js"));
app.use("/auxcampaignfactions", require("./routes/auxcampaignfactions.js"));
app.use("/auxfights", require("./routes/auxfights.js"));
app.use("/auxfightusers", require("./routes/auxfightusers.js"));
app.use("/auxusers", require("./routes/auxusers.js"));
//app.use("/units", require("./routes/units"));

app.use("/", async (req, res) => {
    const result = await listDir("public/log/");
    const param = {
        pageTitle: "CWG DataGateway (dg.clanwolf.net)",
        favicon: "/favicon.png",
        cssFile: "/css/main.css",
        logPath: "/log/",
        logFiles: result.map(name => ({ name })),
    }
    res.render("home.handlebars", param);
});

app.listen(port, () => {
  logger.info(`Web service listening at http://localhost:${port}`);
});
