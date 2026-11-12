import express, { type Express, type Request, type Response, type NextFunction } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

// kamlife.co.za is the manual-coaching brand. Its front door is the /start page,
// not the Coach K app that the Railway root serves.
export function isKamlifeDomain(host: string | undefined): boolean {
  const h = (host ?? "").toLowerCase().split(":")[0];
  return h === "kamlife.co.za" || h === "www.kamlife.co.za";
}

export function kamlifeDomainRoot(req: Request, res: Response, next: NextFunction) {
  if ((req.method === "GET" || req.method === "HEAD") && req.path === "/" && isKamlifeDomain(req.headers.host)) {
    return res.redirect(302, "/start/");
  }
  next();
}
