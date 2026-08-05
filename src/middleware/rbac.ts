import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export type UserRole = "student" | "partner" | "advertiser" | "institution" | "admin" | "super_admin";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
  };
}

const AUTH_TIMEOUT_MS = 8000; // 8 seconds max

export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];

    // Without this race, a slow/hung Supabase auth API leaves the request
    // stuck forever with no response.
    let authResult;
    try {
      authResult = await Promise.race([
        supabase.auth.getUser(token),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Auth service timeout")), AUTH_TIMEOUT_MS)
        )
      ]);
    } catch (raceErr: any) {
      if (raceErr?.message === "Auth service timeout") {
        return res.status(503).json({ error: "Authentication service temporarily unavailable. Please try again." });
      }
      throw raceErr;
    }

    const { data: { user }, error } = authResult as any;
    if (error || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Fetch user role
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email!,
      role: (roleData?.role as UserRole) || "student",
    };

    next();
  } catch (error) {
    res.status(401).json({ error: "Authentication failed" });
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!allowedRoles.includes(req.user.role) && req.user.role !== "super_admin") {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "super_admin")) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}
