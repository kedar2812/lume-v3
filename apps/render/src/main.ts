import { renderServer } from "./server";

const port = Number(process.env.PORT ?? 3020);
const server = renderServer();
server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ msg: "render listening", port })));

// Docker's stop: finish the job in hand, take no more.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
