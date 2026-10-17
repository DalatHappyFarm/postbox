import { route, type Env } from "../../lib/api.ts";

export const onRequest: PagesFunction<Env> = (ctx) => route(ctx.request, ctx.env);
