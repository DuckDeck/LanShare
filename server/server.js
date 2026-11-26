import express from "express";
import RateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import path, { dirname } from "path";
import http from "http";

export default class PairDropServer {
    constructor(conf) {
        this._conf = conf;
        const app = express();
        this.app = app;

        if (conf.rateLimit) {
            const limiter = RateLimit({
                windowMs: 5 * 60 * 1000,
                max: 5000,
                message: "Too many requests from this IP Address, please try again after 5 minutes.",
                standardHeaders: true,
                legacyHeaders: false
            });
            app.use(limiter);
            app.set("trust proxy", conf.rateLimit);
        }

        app.use(express.json({ limit: "2mb" }));

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        this._publicPathAbs = path.join(__dirname, "../public");

        app.use(express.static(this._publicPathAbs));

        app.get("/config", (req, res) => {
            res.send({
                signalingServer: false,
                hostLanUrl: conf.hostLanUrl || null,
                buttons: conf.buttons
            });
        });

        const hostname = conf.localhostOnly ? "127.0.0.1" : undefined;
        const server = http.createServer(app);

        // Prevent Node.js 18/20+ default 300s requestTimeout from cutting off large LAN uploads
        server.requestTimeout = 0;
        server.headersTimeout = 60000;

        server.listen(conf.port, hostname);

        server.on("error", err => {
            if (err.code === "EADDRINUSE") {
                console.error(err);
                console.info("Error EADDRINUSE received, exiting process...");
                process.exit(1);
            }
        });

        this.server = server;
    }

    mountApi(router) {
        this.app.use("/api", router);
    }

    finalizeRoutes() {
        this.app.use("/api", (req, res) => {
            res.status(404).json({ error: "API route not found" });
        });

        this.app.get("/", (req, res) => {
            res.sendFile(path.join(this._publicPathAbs, "index.html"));
        });

        this.app.use((req, res) => {
            res.redirect(302, "/");
        });
    }
}
