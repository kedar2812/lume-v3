import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { FEEDBACK_KINDS, FEEDBACK_LIMITS as L, FEEDBACK_THEMES } from "@lume/core";
import { sendFeedback } from "./service";

const report = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    text: z
      .string()
      .max(L.text)
      .refine((t) => t.trim().length > 0, "Tell LUME what happened"),
    // Cut to its path here as well as in the browser (spec 2026-10-16 §1.3).
    page: z.string().min(1).max(2000),
    theme: z.enum(FEEDBACK_THEMES),
    screen: z.string().min(1).max(L.screen),
    images: z
      .array(
        z
          .object({
            type: z.enum(["image/webp", "image/jpeg"]),
            // 1.5 MB is 2,097,152 characters of base64.
            data: z
              .string()
              .min(1)
              .max(2_097_152)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
      )
      .max(L.images),
  })
  .strict();

/** Send feedback (spec 2026-10-16 §1.4): anyone signed in; 12 MB on this route only. */
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/feedback",
    {
      config: { permission: "auth.self", idempotent: false },
      bodyLimit: L.bodyBytes,
      schema: { body: report },
    },
    (req) => sendFeedback(req, req.body),
  );
}
