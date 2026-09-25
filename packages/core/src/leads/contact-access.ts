import { SCOPE_RANK } from "../rbac/catalog";
import { scopeOf, type Actor } from "../rbac/engine";

/**
 * Report §12.2 #4: may this role see full contact details on every lead it can see? Masked roles get no
 * contact columns, no contact filters and name-only search. One rule, used by the API and the web table.
 */
export function seesFullContacts(actor: Actor): boolean {
  if (actor.isOwner) return true;
  const full = scopeOf(actor, "leads.contact.full");
  const view = scopeOf(actor, "leads.view");
  return full !== null && view !== null && SCOPE_RANK[full] >= SCOPE_RANK[view];
}
