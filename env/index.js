import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.preprocess(
    (val) => (val === undefined || val === '' ? undefined : Number(val)),
    z.number().default(5000)
  ),
  REDIS_HOST: z.string().default('stream.fulltraderdata.com'),
  REDIS_PORT: z.preprocess(
    (val) => (val === undefined || val === '' ? undefined : Number(val)),
    z.number().default(6499)
  ),
  REDIS_USERNAME: z.string().default('fulltbet'),
  REDIS_PASSWORD: z.string().default('5+K86vQ&0F%!x6£F<2Nhd5QK'),
  REDIS_DB: z.preprocess(
    (val) => (val === undefined || val === '' ? undefined : Number(val)),
    z.number().default(0)
  ),
  BETS_DATABASE_URL: z.string().optional(),
});

const env = envSchema.parse(process.env);

export default env;
