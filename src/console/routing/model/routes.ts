// Model routing control-plane HTTP routes. The only module that touches Elysia.
import { Elysia, t, type AnyElysia } from "elysia";
import { consoleErrorHandler } from "../../shared/errors";
import { literalUnion } from "../../shared/elysia-schema";
import { modelComboStrategy, type ComboStrategy } from "../../../persistence/schema";
import {
  type ModelComboCreateInput,
  type ModelComboPatchInput,
  type ModelRoutingConfig,
} from "./contracts";
import { createModelRoutingOperations } from "./operations";

// Compile-time parity: the combo validation schemas below must accept exactly
// the canonical ComboStrategy. Adding a combo strategy to the schema enum
// without updating these literals fails here.
type ExpectComboParity<T extends true> = T;
export type ComboSchemaParity = ExpectComboParity<
  [ComboStrategy] extends ["fallback" | "round_robin"]
    ? (["fallback" | "round_robin"] extends [ComboStrategy] ? true : false)
    : false
>;
const createAliasBody = t.Object({ alias: t.String(), targetModel: t.String() });
const updateAliasBody = t.Object({
  alias: t.Optional(t.String()),
  targetModel: t.Optional(t.String()),
});
/** Full replacement order for the tenant's alias list. */
const reorderBody = t.Object({ ids: t.Array(t.String(), { minItems: 1 }) });
/** The combo-strategy enum's own values; see `ComboSchemaParity` above. */
const comboStrategySchema = literalUnion(modelComboStrategy.enumValues);
const createComboBody = t.Object({
  name: t.String(),
  members: t.Array(t.String(), { minItems: 1 }),
  strategy: t.Optional(comboStrategySchema),
});
const updateComboBody = t.Object({
  name: t.Optional(t.String()),
  members: t.Optional(t.Array(t.String(), { minItems: 1 })),
  strategy: t.Optional(comboStrategySchema),
});
export function createModelRoutingRoutes(config: ModelRoutingConfig): AnyElysia {
  const factory = createModelRoutingOperations(config);
  return new Elysia({ prefix: "/routing" })
    .error(consoleErrorHandler("Model routing operation failed"))
    .get("/aliases", async ({ request }) => {
      return await factory.listAliases(config.accessResolver(request));
    })
    .post("/aliases", { body: createAliasBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createAlias(config.accessResolver(request), body);
    })
    .patch("/aliases/:id", { body: updateAliasBody }, async ({ request, params, body }) => {
      return await factory.updateAlias(config.accessResolver(request), params.id, body);
    })
    .delete("/aliases/:id", async ({ request, params }) => {
      return await factory.deleteAlias(config.accessResolver(request), params.id);
    })
    .post("/aliases/reorder", { body: reorderBody }, async ({ request, body }) => {
      await factory.reorderAliases(config.accessResolver(request), body.ids);
      return { success: true };
    })
    .get("/combos", async ({ request }) => {
      return await factory.listCombos(config.accessResolver(request));
    })
    .post("/combos", { body: createComboBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createCombo(
        config.accessResolver(request),
        body as ModelComboCreateInput,
      );
    })
    .post("/combos/reorder", { body: reorderBody }, async ({ request, body }) => {
      await factory.reorderCombos(config.accessResolver(request), body.ids);
      return { success: true };
    })
    .post("/combos/:id/clone", async ({ request, params, set }) => {
      set.status = 201;
      return await factory.cloneCombo(config.accessResolver(request), params.id);
    })
    .patch("/combos/:id", { body: updateComboBody }, async ({ request, params, body }) => {
      return await factory.updateCombo(
        config.accessResolver(request),
        params.id,
        body as ModelComboPatchInput,
      );
    })
    .delete("/combos/:id", async ({ request, params }) => {
      return await factory.deleteCombo(config.accessResolver(request), params.id);
    });
}
