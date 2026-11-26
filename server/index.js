import { spawn } from "child_process";
import os from "os";

import PairDropServer from "./server.js";
import PairDropWsServer from "./ws-server.js";
import LanShareStorage from "./storage.js";
import createFilesRouter from "./files-router.js";

process.on("SIGINT", () => {
    console.info("SIGINT Received, exiting...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.info("SIGTERM Received, exiting...");
    process.exit(0);
});

process.on("uncaughtException", (error, origin) => {
    console.log("----- Uncaught exception -----");
    console.log(error);
    console.log("----- Exception origin -----");
    console.log(origin);
});

process.on("unhandledRejection", (reason, promise) => {
    console.log("----- Unhandled Rejection at -----");
    console.log(promise);
    console.log("----- Reason -----");
    console.log(reason);
});

const conf = {};
conf.debugMode = process.env.DEBUG_MODE === "true";
conf.port = parseInt(process.env.PORT, 10) || 3000;
conf.hostLanUrl = (process.env.HOST_LAN_URL || "").trim() || null;
conf.hostLanIp = null;
if (conf.hostLanUrl) {
    try {
        conf.hostLanIp = new URL(conf.hostLanUrl).hostname;
    } catch (_) {
        conf.hostLanIp = null;
    }
}
conf.hostComputerName = (process.env.HOST_COMPUTER_NAME || "").trim() || os.hostname() || null;
conf.localhostOnly = process.argv.includes("--localhost-only");
conf.autoStart = process.argv.includes("--auto-restart");

let rateLimit = false;
if (process.argv.includes("--rate-limit") || process.env.RATE_LIMIT === "true") {
    rateLimit = 5;
} else {
    const envRateLimit = parseInt(process.env.RATE_LIMIT, 10);
    if (!isNaN(envRateLimit)) {
        rateLimit = envRateLimit;
    }
}
conf.rateLimit = rateLimit;
conf.buttons = {};

if (conf.autoStart) {
    process.on("uncaughtException", () => {
        process.once("exit", () =>
            spawn(process.argv.shift(), process.argv, {
                cwd: process.cwd(),
                detached: true,
                stdio: "inherit"
            })
        );
        process.exit();
    });
}

const storage = new LanShareStorage(process.env.DATA_DIR);
const pairDropServer = new PairDropServer(conf);
const wsServer = new PairDropWsServer(pairDropServer.server, conf, storage);

pairDropServer.mountApi(createFilesRouter(storage, wsServer, conf));
pairDropServer.finalizeRoutes();

console.log(`\nLAN-Share is running on HTTP port ${conf.port}`);
if (conf.hostLanUrl) {
    console.log(`Configured LAN URL: ${conf.hostLanUrl}`);
}
console.log(`Data directory: ${storage.dataDir}`);
