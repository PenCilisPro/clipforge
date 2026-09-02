import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { env, assertCriticalEnv } from "./config/env.js";
import { notFound, errorHandler } from "./middleware/errors.js";
import healthRoutes from "./routes/health.js";
import meRoutes from "./routes/me.js";
import projectRoutes from "./routes/projects.js";
import clipRoutes from "./routes/clips.js";
import scheduleRoutes from "./routes/schedule.js";
import shotstackWebhook from "./routes/webhooks/shotstack.js";
import socialRoutes from "./routes/social.js";

assertCriticalEnv();

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: [env.frontendUrl],
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// Webhook receiver must come before any auth middleware.
app.use(shotstackWebhook);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
});

app.use(apiLimiter);
app.use(healthRoutes);
app.use(meRoutes);
app.use(projectRoutes);
app.use(clipRoutes);
app.use(scheduleRoutes);
app.use(socialRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[clipforge-api] listening on :${env.port}`);
});
