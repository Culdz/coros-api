import { z } from 'zod';

export const CorosResponseBase = z.object({
  // COROS error envelopes (e.g. result "1019" invalid token) omit apiCode, so it must be
  // optional — otherwise validation fails here before the real result/message is surfaced.
  apiCode: z.string().optional(),
  message: z.string(),
  result: z.string(),
});
export type CorosResponseBase = z.infer<typeof CorosResponseBase>;

export const CorosResponse = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    ...CorosResponseBase.shape,
    data: dataSchema,
  });

const CorosResponseWithData = CorosResponse(z.record(z.string(), z.unknown()));
export type CorosResponseWithData = z.infer<typeof CorosResponseWithData>;
