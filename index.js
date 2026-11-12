/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import { config } from "./config/env.js";
import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import router from "./routes/index.js";
import fs from 'fs';
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import { MySQLSessionStore } from "./middleware/sessionStore.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { requestId } from "./middleware/requestId.js";
import { csrfProtection } from "./middleware/csrf.js";
import { loadCurrentUser } from "./middleware/auth.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { registerViewHelpers } from "./utils/viewHelpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = config.port;

app.disable("x-powered-by");
app.use(securityHeaders);
app.use(requestId);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

export const sessionStore = new MySQLSessionStore({ ttlMs: config.session.ttlMinutes * 60000 });
app.use(session({
  name: "hotelpos.sid",
  store: sessionStore,
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: config.session.cookieSecure,
    maxAge: config.session.ttlMinutes * 60000,
  },
}));
app.use(flash());

app.engine("xian", async (filePath, options, callback) => {
  try {
     const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, 'views');

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");
// Every page renders inside views/layouts/main.xian unless it sets `layout`.
app.set("view options", { layout: "layouts/main" });
registerViewHelpers(hbs);

// Register partials synchronously (including subfolders, e.g. {{> pos/order-pad}})
// so they exist before the first request is served.
const partialsDir = path.join(__dirname, "views/partials");
const registerPartials = (dir, prefix = "") => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      registerPartials(fullPath, `${prefix}${entry.name}/`);
    } else if (entry.name.endsWith(".xian")) {
      hbs.registerPartial(prefix + entry.name.replace(".xian", ""), fs.readFileSync(fullPath, "utf8"));
    }
  }
};
try {
  registerPartials(partialsDir);
} catch (err) {
  console.error("❌ Could not register partials:", err);
}

app.use(loadCurrentUser);
app.use(csrfProtection);
app.use((req, res, next) => {
  // JSON/API calls (e.g. from the POS terminal) must not consume flash messages that were
  // set for the next page the browser loads.
  const isApi = req.originalUrl.startsWith("/api/");
  res.locals.success_msg = isApi ? [] : req.flash("success_msg");
  res.locals.warning_msg = isApi ? [] : req.flash("warning_msg");
  res.locals.error_msg = isApi ? [] : req.flash("error_msg");
  res.locals.appName = config.appName;
  res.locals.currencySymbol = config.currencySymbol;
  next();
});

app.use("/", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = (port = PORT) => {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 XianFire running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
