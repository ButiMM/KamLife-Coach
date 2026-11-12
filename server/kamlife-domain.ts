import type { Request, Response, NextFunction } from "express";

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
