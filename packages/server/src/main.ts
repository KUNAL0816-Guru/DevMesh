import { startServer } from "./bootstrap.js";

const server = await startServer();

process.on("unhandledRejection", (reason) => {
  server.app.log.error({ err: reason }, "unhandled rejection");
});

process.on("uncaughtException", (err) => {
  server.app.log.error({ err }, "uncaught exception");
});
