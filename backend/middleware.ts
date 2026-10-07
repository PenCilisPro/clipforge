import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOWED_ORIGINS = ["https://clipforge-frontend-zeta.vercel.app"];

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin") ?? "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  // Answer preflight OPTIONS requests
  if (request.method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    if (isAllowed) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.headers.set("Access-Control-Max-Age", "86400");
    }
    return res;
  }

  const res = NextResponse.next();
  if (isAllowed) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    // res.headers.set("Access-Control-Allow-Credentials", "true"); // uncomment if you use cookies
  }
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
