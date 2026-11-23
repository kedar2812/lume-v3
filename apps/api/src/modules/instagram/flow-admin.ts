import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  blocking,
  foldKeyword,
  flowRefs,
  graphRefs,
  isGraph,
  newId,
  toGraph,
  validateFlow,
  validateGraph,
  type FlowGraph,
  type FlowProblem,
  type FlowStep,
  type KeywordMode,
} from "@lume/core";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, conflict, notFound } from "../../http/errors";
import { assertModule } from "../../licence/plan";
import { FLOW_WORDS, pgArray, stopFlowRuns } from "./flow-run";
import { instagramOn, withAllScope } from "./service";

/**
 * Flows, as the business builds them (NEW_FEATURES_PLAN §4.5; plan 1B Task 3). A flow holds a draft the editor saves
 * freely and publishes into an unchangeable version; conversations already in a flow finish on their version.
 * Configuration, no lead data: reached only by routes that check instagram.flows.manage.
 */
export type TriggerKind = "comment" | "dm" | "story_reply" | "story_mention" | "ad" | "welcome";
export type TriggerIn = {
  kind: TriggerKind;
  accountId: string | null;
  keywords: string[];
  mode: KeywordMode;
  mediaIds: string[];
  adIds: string[];
  publicReplies: string[];
  cooldownHours: number;
  enabled: boolean;
};

/** Kinds a keyword belongs to: a comment keyword and a DM keyword are different claims. */
const KEYWORDED: TriggerKind[] = ["comment", "dm"];
/** One flow per account answers these (no keyword to tell two apart). */
const ONE_PER_ACCOUNT: TriggerKind[] = ["story_reply", "story_mention", "welcome"];

type FlowRow = {
  id: string;
  name: string;
  status: "draft" | "live" | "paused" | "archived";
  live_version_id: string | null;
  priority: number;
  /** A 1B list, or a graph ({ v: 2 }) once the builder has saved one. */
  draft_steps: FlowStep[] | FlowGraph;
  rev: number;
};

export async function requireFlows(req: FastifyRequest) {
  assertModule(req, "instagram");
  if (!(await instagramOn(req)))
    throw new HttpError(
      409,
      "INSTAGRAM_OFF",
      "Instagram is off. Switch it on in Settings → Integrations first.",
    );
}

async function flowOf(req: FastifyRequest, id: string, lock = true): Promise<FlowRow> {
  const r = await req.db.execute<FlowRow>(sql`
    SELECT id, name, status, live_version_id, priority, draft_steps, rev FROM instagram_flows WHERE id = ${id}
    ${lock ? sql`FOR UPDATE` : sql``}`);
  const f = r.rows[0];
  if (!f) throw notFound("FLOW_NOT_FOUND", "That flow isn't in LUME any more.");
  return f;
}

/** Stale edits are refused, never merged unseen: the editor reloads and shows what changed. */
function checkRev(f: FlowRow, rev: number) {
  if (f.rev !== rev)
    throw conflict("FLOW_CHANGED", "Someone else changed this flow meanwhile. Reload to see their changes.");
}

/** Who may answer which keyword is one question for the whole business: one change at a time decides it. */
const triggerLock = (req: FastifyRequest) =>
  req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume.instagram_triggers'))`);

/** The list: each flow, what starts it, and how many conversations are in it now. One query, any number of flows. */
export async function flowsView(req: FastifyRequest) {
  await requireFlows(req);
  // How many conversations are in each flow is a count for the whole business, whoever's leads they are.
  const r = await withAllScope(req, () =>
    req.db.execute<{
      id: string;
      name: string;
      status: string;
      priority: number;
      version: number | null;
      updated_at: Date;
      triggers: TriggerIn[] | null;
      active: number;
    }>(sql`
    WITH active AS (
      SELECT flow_id, count(*)::int AS n FROM instagram_flow_runs
       WHERE status IN ('running', 'waiting') GROUP BY flow_id)
    SELECT f.id, f.name, f.status, f.priority, v.version, f.updated_at,
           (SELECT json_agg(json_build_object(
                     'id', t.id, 'kind', t.kind, 'accountId', t.account_id, 'keywords', t.keywords, 'mode', t.mode,
                     'mediaIds', t.media_ids, 'adIds', t.ad_ids, 'publicReplies', t.public_replies,
                     'cooldownHours', t.cooldown_hours, 'enabled', t.enabled) ORDER BY t.created_at)
              FROM instagram_triggers t WHERE t.flow_id = f.id) AS triggers,
           coalesce(a.n, 0) AS active
      FROM instagram_flows f LEFT JOIN instagram_flow_versions v ON v.id = f.live_version_id
      LEFT JOIN active a ON a.flow_id = f.id
     WHERE f.status <> 'archived'
     ORDER BY f.priority DESC, f.created_at`),
  );
  return {
    flows: r.rows.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      priority: f.priority,
      version: f.version,
      updatedAt: f.updated_at,
      triggers: f.triggers ?? [],
      active: f.active,
    })),
  };
}

/** Flows a "Go to another flow" step may name: live or paused, never itself. */
async function gotoTargets(req: FastifyRequest, self: string): Promise<Set<string>> {
  const r = await req.db.execute<{ id: string }>(
    sql`SELECT id FROM instagram_flows WHERE status IN ('live', 'paused') AND id <> ${self}`,
  );
  return new Set(r.rows.map((x) => x.id));
}

/**
 * What stops a draft going live, both ways: `problems` in words (a 1B list's own check, or a graph's blocking ones),
 * and `issues` on the graph (each with its step, warnings too) for the builder, whichever form the draft is in.
 */
async function problemsOf(req: FastifyRequest, id: string, draft: FlowStep[] | FlowGraph) {
  const issues: FlowProblem[] = validateGraph(toGraph(draft), {
    ai: false,
    flows: await gotoTargets(req, id),
    self: id,
  });
  const problems = isGraph(draft) ? blocking(issues).map((p) => p.words) : validateFlow(draft);
  return { problems, issues };
}

export async function flowView(req: FastifyRequest, id: string) {
  await requireFlows(req);
  const f = await flowOf(req, id, false);
  const v = f.live_version_id
    ? await req.db.execute<{ version: number; steps: FlowStep[] | FlowGraph }>(
        sql`SELECT version, steps FROM instagram_flow_versions WHERE id = ${f.live_version_id}`,
      )
    : null;
  const triggers = await req.db.execute(sql`
    SELECT id, kind, account_id AS "accountId", keywords, mode, media_ids AS "mediaIds", ad_ids AS "adIds",
           public_replies AS "publicReplies", cooldown_hours AS "cooldownHours", enabled
      FROM instagram_triggers WHERE flow_id = ${id} ORDER BY created_at`);
  return {
    id: f.id,
    name: f.name,
    status: f.status,
    priority: f.priority,
    rev: f.rev,
    draft: f.draft_steps,
    /** The draft as the builder shows it: a 1B list laid out as a graph with the same step ids. */
    graph: toGraph(f.draft_steps),
    live: v?.rows[0] ?? null,
    ...(await problemsOf(req, id, f.draft_steps)),
    triggers: triggers.rows,
  };
}

const cleanName = (name: string) => {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) throw badRequest("FLOW_NAME", "Give the flow a name.");
  if ([...n].length > 120) throw badRequest("FLOW_NAME", "A flow's name can be at most 120 characters.");
  return n;
};

export async function createFlow(req: FastifyRequest, body: { name: string; template?: TemplateKey }) {
  await requireFlows(req);
  const id = newId();
  const steps = body.template ? FLOW_TEMPLATES[body.template].steps() : [];
  const name = cleanName(body.name);
  await req.db.execute(sql`
    INSERT INTO instagram_flows (id, name, status, draft_steps, created_by)
    VALUES (${id}, ${name}, 'draft', ${JSON.stringify(steps)}::jsonb, ${req.actor!.userId})`);
  await audit(req, {
    action: "instagram.flow.created",
    entityType: "instagram_flow",
    entityId: id,
    diff: { name },
  });
  return flowView(req, id);
}

/** The editor's save: any draft, publishable or not (problems come back in words). */
export async function saveDraft(
  req: FastifyRequest,
  id: string,
  body: { rev: number; name?: string; steps?: FlowStep[]; graph?: FlowGraph; priority?: number },
) {
  await requireFlows(req);
  const f = await flowOf(req, id);
  if (f.status === "archived")
    throw conflict("FLOW_ARCHIVED", "This flow is archived. Duplicate it to use it again.");
  checkRev(f, body.rev);
  const name = body.name !== undefined ? cleanName(body.name) : f.name;
  await req.db.execute(sql`
    UPDATE instagram_flows
       SET name = ${name},
           draft_steps = ${JSON.stringify(body.graph ?? body.steps ?? f.draft_steps)}::jsonb,
           priority = ${body.priority ?? f.priority},
           rev = rev + 1, updated_at = now()
     WHERE id = ${id}`);
  return flowView(req, id);
}

/** Tags, stages and people the flow names must exist (and people still use LUME), so a run never fails on them. */
async function checkRefs(req: FastifyRequest, draft: FlowStep[] | FlowGraph): Promise<string[]> {
  const { tagIds, stageIds, userIds } = isGraph(draft) ? graphRefs(draft) : flowRefs(draft);
  const out: string[] = [];
  if (tagIds.length) {
    const r = await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tags WHERE id = ANY(${pgArray(tagIds)}::uuid[])`,
    );
    if (r.rows[0]!.n < tagIds.length) out.push("A tag this flow uses was deleted. Choose another.");
  }
  if (stageIds.length) {
    const r = await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM stages WHERE id = ANY(${pgArray(stageIds)}::uuid[]) AND archived_at IS NULL`,
    );
    if (r.rows[0]!.n < stageIds.length) out.push("A stage this flow uses was deleted. Choose another.");
  }
  if (userIds.length) {
    const r = await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM users WHERE id = ANY(${pgArray(userIds)}::uuid[]) AND status = 'active'`,
    );
    if (r.rows[0]!.n < userIds.length) out.push("Someone this flow assigns leads to no longer uses LUME.");
  }
  // A question's answer goes to the lead field of that name when there is one (email, phone or a custom field); any
  // other name keeps it on the conversation's run, for the flow's own conditions. So it's never refused here.
  return out;
}

/** The draft becomes the live version. Conversations already in the flow finish on the version they started on. */
export async function publishFlow(req: FastifyRequest, id: string, body: { rev: number }) {
  await requireFlows(req);
  await triggerLock(req);
  const f = await flowOf(req, id);
  if (f.status === "archived")
    throw conflict("FLOW_ARCHIVED", "This flow is archived. Duplicate it to use it again.");
  checkRev(f, body.rev);
  const problems = [
    ...(await problemsOf(req, id, f.draft_steps)).problems,
    ...(await checkRefs(req, f.draft_steps)),
  ];
  const triggers = await triggersOf(req, id);
  if (!triggers.some((t) => t.enabled))
    problems.push("Add what starts this flow: a keyword, a story reply, an ad or a first message.");
  if (problems.length) throw new HttpError(422, "FLOW_INVALID", problems[0]!, { problems });
  const clash = await clashes(req, id, triggers);
  if (clash) throw conflict("TRIGGER_TAKEN", clash);
  const vid = newId();
  const n = await req.db.execute<{ version: number }>(sql`
    INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by)
    SELECT ${vid}, ${id}, coalesce(max(version), 0) + 1, ${JSON.stringify(f.draft_steps)}::jsonb, ${req.actor!.userId}
      FROM instagram_flow_versions WHERE flow_id = ${id}
    RETURNING version`);
  await req.db.execute(sql`
    UPDATE instagram_flows
       -- A paused flow stays paused: publishing changes what it says, resuming is its own choice.
       SET live_version_id = ${vid}, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'live' END,
           rev = rev + 1, updated_at = now()
     WHERE id = ${id}`);
  await audit(req, {
    action: "instagram.flow.published",
    entityType: "instagram_flow",
    entityId: id,
    diff: { version: n.rows[0]!.version },
  });
  return flowView(req, id);
}

/** Pause: nothing new starts; conversations in it go on. Resume: back to live (a published flow only). */
export async function setFlowStatus(
  req: FastifyRequest,
  id: string,
  body: { rev: number; to: "paused" | "live" },
) {
  await requireFlows(req);
  await triggerLock(req);
  const f = await flowOf(req, id);
  checkRev(f, body.rev);
  if (f.status === "archived")
    throw conflict("FLOW_ARCHIVED", "This flow is archived. Duplicate it to use it again.");
  if (body.to === "live") {
    if (!f.live_version_id) throw conflict("FLOW_UNPUBLISHED", "Publish this flow first.");
    const clash = await clashes(req, id, await triggersOf(req, id));
    if (clash) throw conflict("TRIGGER_TAKEN", clash);
  }
  await req.db.execute(
    sql`UPDATE instagram_flows SET status = ${body.to}, rev = rev + 1, updated_at = now() WHERE id = ${id}`,
  );
  await audit(req, {
    action: body.to === "paused" ? "instagram.flow.paused" : "instagram.flow.resumed",
    entityType: "instagram_flow",
    entityId: id,
    diff: {},
  });
  return flowView(req, id);
}

export const ARCHIVED_REASON = FLOW_WORDS.archived;

/** Archive: it stops, and so does every conversation in it, saying why on each. Its numbers stay. */
export async function archiveFlow(req: FastifyRequest, id: string) {
  await requireFlows(req);
  const f = await flowOf(req, id);
  if (f.status === "archived") return { ok: true, stopped: 0 };
  await req.db.execute(
    sql`UPDATE instagram_flows SET status = 'archived', rev = rev + 1, updated_at = now() WHERE id = ${id}`,
  );
  // Runs are seen through their leads: this admin action stops every one, whoever's lead it is (no lead data read).
  const stopped = await withAllScope(req, () => stopFlowRuns(req, { flowId: id }, ARCHIVED_REASON));
  await audit(req, {
    action: "instagram.flow.archived",
    entityType: "instagram_flow",
    entityId: id,
    diff: { stopped },
  });
  return { ok: true, stopped };
}

/** A copy as a new draft, with its triggers switched off (two flows can't claim the same keyword). */
export async function duplicateFlow(req: FastifyRequest, id: string) {
  await requireFlows(req);
  const f = await flowOf(req, id, false);
  const copy = newId();
  const base = f.name.replace(/ \(copy( \d+)?\)$/, "");
  await req.db.execute(sql`
    INSERT INTO instagram_flows (id, name, status, draft_steps, priority, created_by)
    VALUES (${copy}, ${[...`${base} (copy)`].slice(0, 120).join("")}, 'draft', ${JSON.stringify(f.draft_steps)}::jsonb,
            ${f.priority}, ${req.actor!.userId})`);
  await req.db.execute(sql`
    INSERT INTO instagram_triggers
      (id, flow_id, account_id, kind, keywords, mode, media_ids, ad_ids, public_replies, cooldown_hours, enabled)
    SELECT gen_random_uuid(), ${copy}, account_id, kind, keywords, mode, media_ids, ad_ids, public_replies,
           cooldown_hours, false
      FROM instagram_triggers WHERE flow_id = ${id}`);
  await audit(req, {
    action: "instagram.flow.created",
    entityType: "instagram_flow",
    entityId: copy,
    diff: { from: id },
  });
  return flowView(req, copy);
}

async function triggersOf(req: FastifyRequest, flowId: string): Promise<(TriggerIn & { id: string })[]> {
  const r = await req.db.execute<TriggerIn & { id: string }>(sql`
    SELECT id, kind, account_id AS "accountId", keywords, mode, media_ids AS "mediaIds", ad_ids AS "adIds",
           public_replies AS "publicReplies", cooldown_hours AS "cooldownHours", enabled
      FROM instagram_triggers WHERE flow_id = ${flowId}`);
  return r.rows;
}

/** The words of a trigger as LUME compares them: folded, blanks gone, each once. */
const foldAll = (ks: string[]) => [...new Set(ks.map(foldKeyword).filter(Boolean))];

/**
 * The first claim another live or paused flow already holds, in words; null when none. A keyword is one flow's on
 * one account (a trigger for every account overlaps each), as are "any comment", a story reply and a first DM.
 */
async function clashes(req: FastifyRequest, flowId: string, mine: TriggerIn[]): Promise<string | null> {
  const on = mine.filter((t) => t.enabled);
  if (!on.length) return null;
  const others = await req.db.execute<{
    name: string;
    kind: TriggerKind;
    account_id: string | null;
    keywords: string[];
    mode: KeywordMode;
    media_ids: string[];
    ad_ids: string[];
  }>(sql`
    SELECT f.name, t.kind, t.account_id, t.keywords, t.mode, t.media_ids, t.ad_ids
      FROM instagram_triggers t JOIN instagram_flows f ON f.id = t.flow_id
     WHERE t.enabled AND f.id <> ${flowId} AND f.status IN ('live', 'paused')
       AND t.kind = ANY(${pgArray([...new Set(on.map((t) => t.kind))])}::text[])`);
  const overlap = (a: string[], b: string[]) => !a.length || !b.length || a.some((x) => b.includes(x));
  for (const t of on)
    for (const o of others.rows) {
      if (o.kind !== t.kind) continue;
      if (t.accountId && o.account_id && t.accountId !== o.account_id) continue;
      if (!overlap(t.mediaIds, o.media_ids) || !overlap(t.adIds, o.ad_ids)) continue;
      if (KEYWORDED.includes(t.kind)) {
        if (t.mode === "any" || o.mode === "any") {
          if (t.mode === o.mode)
            return `${o.name} already answers every ${t.kind === "comment" ? "comment" : "DM"} here.`;
          continue; // a keyword flow wins over an "any" one by its words; both may exist
        }
        const mineK = foldAll(t.keywords);
        const hit = foldAll(o.keywords).find((k) => mineK.includes(k));
        if (hit) return `“${hit}” already starts ${o.name}. Pick another keyword, or pause ${o.name} first.`;
        continue;
      }
      if (ONE_PER_ACCOUNT.includes(t.kind) || t.kind === "ad")
        return `${o.name} already answers these. Pause it first, or narrow one of them.`;
    }
  return null;
}

/** All of a flow's triggers at once, as the editor holds them; a live flow's are checked for clashes first. */
export async function setTriggers(
  req: FastifyRequest,
  flowId: string,
  body: { rev: number; triggers: TriggerIn[] },
) {
  await requireFlows(req);
  await triggerLock(req);
  const f = await flowOf(req, flowId);
  if (f.status === "archived")
    throw conflict("FLOW_ARCHIVED", "This flow is archived. Duplicate it to use it again.");
  checkRev(f, body.rev);
  for (const t of body.triggers) {
    if (KEYWORDED.includes(t.kind) && t.mode !== "any" && !foldAll(t.keywords).length)
      throw badRequest("TRIGGER_KEYWORDS", "Add at least one keyword, or choose any comment or message.");
    if (t.kind !== "comment" && t.publicReplies.length)
      throw badRequest("TRIGGER_PUBLIC", "Public replies go under comments only.");
    if (t.kind !== "comment" && t.mediaIds.length)
      throw badRequest("TRIGGER_MEDIA", "Only a comment trigger can be limited to posts.");
    if (t.kind !== "comment" && t.kind !== "ad" && t.adIds.length)
      throw badRequest("TRIGGER_ADS", "Only a comment or ad trigger can be limited to ads.");
  }
  if (body.triggers.some((t) => t.accountId)) {
    const ids = [...new Set(body.triggers.map((t) => t.accountId).filter((x): x is string => !!x))];
    const r = await req.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM instagram_accounts WHERE id = ANY(${pgArray(ids)}::uuid[]) AND status <> 'disconnected'`);
    if (r.rows[0]!.n < ids.length)
      throw badRequest("TRIGGER_ACCOUNT", "That Instagram account isn't connected now.");
  }
  if (f.status === "live" || f.status === "paused") {
    const clash = await clashes(req, flowId, body.triggers);
    if (clash) throw conflict("TRIGGER_TAKEN", clash);
  }
  await req.db.execute(sql`DELETE FROM instagram_triggers WHERE flow_id = ${flowId}`);
  for (const t of body.triggers)
    await req.db.execute(sql`
      INSERT INTO instagram_triggers
        (id, flow_id, account_id, kind, keywords, mode, media_ids, ad_ids, public_replies, cooldown_hours, enabled)
      VALUES (${newId()}, ${flowId}, ${t.accountId}, ${t.kind}, ${pgArray(t.keywords.map((k) => k.trim()).filter(Boolean))}::text[],
              ${t.mode}, ${pgArray(t.mediaIds)}::text[], ${pgArray(t.adIds)}::text[], ${pgArray(t.publicReplies.map((p) => p.trim()).filter(Boolean))}::text[],
              ${t.cooldownHours}, ${t.enabled})`);
  await req.db.execute(
    sql`UPDATE instagram_flows SET rev = rev + 1, updated_at = now() WHERE id = ${flowId}`,
  );
  await audit(req, {
    action: "instagram.flow.triggers",
    entityType: "instagram_flow",
    entityId: flowId,
    diff: { triggers: body.triggers.length },
  });
  return flowView(req, flowId);
}

/**
 * Ready-made starts (generic copy, LUME's voice; every link the business must fill is left empty so the flow can't
 * be published until it is). Step ids are fresh each time.
 */
const sid = () => newId().replace(/-/g, "").slice(-12);
export const FLOW_TEMPLATES = {
  lead_magnet: {
    name: "Lead magnet",
    steps: (): FlowStep[] => [
      {
        id: sid(),
        type: "send",
        text: "Thanks for your comment! Here's the guide you asked for.",
        buttons: [{ title: "Get the guide", url: "" }],
      },
      {
        id: sid(),
        type: "ask",
        text: "Want more like this? What's your email?",
        save: { field: "email", kind: "email" },
        fallback: "That doesn't look like an email. Could you check it?",
      },
      { id: sid(), type: "handoff", to: "person", note: "Got the guide" },
    ],
  },
  qualify_and_book: {
    name: "Qualify and book",
    steps: (): FlowStep[] => {
      const q = sid();
      return [
        {
          id: q,
          type: "ask",
          text: "Happy to help! What are you looking for?",
          save: { field: "interest", kind: "choice" },
          choices: ["Prices", "Book a call", "Something else"],
          fallback: "Tap one of the options above.",
        },
        {
          id: sid(),
          type: "condition",
          when: { on: "answer", key: "interest", op: "is", value: "Something else" },
          then: [{ id: sid(), type: "handoff", to: "person", note: "Asked about something else" }],
          else: [
            {
              id: sid(),
              type: "book",
              text: "The quickest way is a short call. Pick a time that suits you.",
              url: "",
            },
          ],
        },
      ];
    },
  },
  story_reply_thanks: {
    name: "Story reply thanks",
    steps: (): FlowStep[] => [
      { id: sid(), type: "send", text: "Thanks for replying to our story! What caught your eye?" },
    ],
  },
  ad_welcome: {
    name: "Ad welcome",
    steps: (): FlowStep[] => [
      { id: sid(), type: "send", text: "Hi! Thanks for reaching out from our ad. How can we help?" },
      { id: sid(), type: "handoff", to: "person", note: "Came from an ad" },
    ],
  },
} as const;
export type TemplateKey = keyof typeof FLOW_TEMPLATES;
