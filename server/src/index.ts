import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import express from "express";
import cors from "cors";
import { workflowRoutes } from "./routes/workflows";
import { runRoutes } from "./routes/runs";
import { repoRoutes } from "./routes/repos";
import { inferRoutes } from "./routes/infer";
import { routeIntentRoutes } from "./routes/route-intent";
import { smartReplyRoutes } from "./routes/smart-reply";
import { harnessRoutes } from "./routes/harness";
import { policyRoutes } from "./routes/policy";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3100", 10);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api", repoRoutes);
app.use("/api", workflowRoutes);
app.use("/api", runRoutes);
app.use("/api", inferRoutes);
app.use("/api", routeIntentRoutes);
app.use("/api", smartReplyRoutes);
app.use("/api", harnessRoutes);
app.use("/api", policyRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Zeverse server listening on http://localhost:${PORT}`);
});

export default app;
