import { AuthUser } from "./auth";
import type { Subscription, Plan } from "@prisma/client";
import type { Multer } from "multer";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      subscription?: Subscription & { plan: Plan };
      file?: Multer.File;
      files?: Multer.File[] | { [fieldname: string]: Multer.File[] };
    }
  }
}

export { };
