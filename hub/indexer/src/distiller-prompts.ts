// Distillation payload, v2 (spec §5.2). The in-session agent builds it (the
// /memory command → memory_distill_session → POST /memory/distill); the
// server validates and writes it. One run claim per session always; claims
// and experiences only when they earn their place.
import { z } from "zod/v4";
import { ACCESS_ORDER } from "./access-classes.js";
import { FACET_KEYS } from "./facet-keys.js";
import { DOMAIN_HELP, DOMAINS } from "./memory-domain.js";

export const PROMPT_VERSION = 2;

export const CONDITIONS_HELP = `Condition facets, key → values. Keys: ${FACET_KEYS.join(", ")}.`;
const Conditions = z.partialRecord(z.enum(FACET_KEYS), z.array(z.string().max(200)).max(20)).describe(CONDITIONS_HELP);

const AccessClass = z.enum(ACCESS_ORDER);
const Domain = z.enum(DOMAINS).describe(DOMAIN_HELP);

// Evidence is cited by URI (file://, s3://, chpc://, https://, transcript://).
// The agent never invents URIs: it cites paths, job IDs and links it saw.
const Evidence = z.object({
  uri:          z.string().min(1).max(2000).regex(/^[a-z][a-z0-9+.-]*:\/\//i, "must be a URI with a scheme"),
  role:         z.enum(["source", "input", "output", "qc"]).optional(),
  access_class: AccessClass.optional(),
});
const EvidenceList = z.array(Evidence).max(20).default([]).describe(
  "Evidence URIs you saw: file:///abs/path, chpc://job/<id>, s3://…, https://…. Never invent one. " +
  "Optional access_class: restricted or irb for controlled data.",
);

const Qc = z.object({
  status:  z.enum(["pass", "warn", "fail", "unknown"]),
  metrics: z.record(z.string(), z.union([z.number(), z.string().max(200)])).optional(),
});

const ClaimBase = {
  subject:     z.string().min(1).max(120).describe("What was studied, e.g. 'PBMC3k clustering'."),
  statement:   z.string().min(1).max(800).describe("What was done and found, with the key numbers."),
  conditions:  Conditions.default({}),
  evidence:    EvidenceList,
  observed_at: z.iso.datetime().optional().describe("ISO-8601 time of the experiment or run, if not now."),
  domain:      Domain.default("lab"),
};

export const RunClaim = z.object({
  ...ClaimBase,
  inputs:     z.array(z.string().max(500)).max(30).default([]),
  parameters: z.record(z.string(), z.union([z.number(), z.string().max(200), z.boolean()])).default({}),
  outputs:    z.array(z.string().max(500)).max(30).default([]),
  qc:         Qc.optional(),
});

export const Claim = z.object({
  ...ClaimBase,
  claim_kind: z.enum(["observation", "result", "interpretation", "decision", "feedback"]),
  confidence: z.number().min(0).max(1).optional(),
  qc:         Qc.optional(),
});

// Value bar: reusable on another task, names when it applies, names how it
// can fail. Anything less is not written.
export const Experience = z.object({
  task:                z.string().min(1).max(200),
  solution:            z.string().min(1).max(1200),
  applicability:       z.array(z.string().max(300)).min(1).max(10),
  boundary_conditions: z.array(z.string().max(300)).max(10).default([]),
  failure_modes:       z.array(z.string().max(300)).max(10).default([]),
  expected_qc:         z.record(z.string(), z.union([z.number(), z.string().max(200)])).default({}),
  search_keys:         z.array(z.string().max(80)).max(10).default([]),
  domain:              Domain,
  conditions:          Conditions.default({}),
  // The run claim, or an index into `claims`.
  source:              z.union([z.literal("run"), z.number().int().min(0)]).default("run")
    .describe("'run' or the index of the claim it derives from."),
}).refine(
  (e) => e.boundary_conditions.length + e.failure_modes.length > 0,
  { message: "an experience must name at least one boundary condition or failure mode" },
);

/** The payload's fields; DistillationResult adds the cross-field check. */
export const DistillationFields = z.object({
  run:         RunClaim.describe("Exactly one run claim for this session."),
  claims:      z.array(Claim).max(5).default([]),
  experiences: z.array(Experience).max(3).default([]),
});

export const experienceSourcesValid = (r: z.output<typeof DistillationFields>): boolean =>
  r.experiences.every((e) => e.source === "run" || e.source < r.claims.length);
export const EXPERIENCE_SOURCE_MESSAGE = "experience.source must be 'run' or an index into claims";

export const DistillationResult = DistillationFields.refine(experienceSourcesValid, { message: EXPERIENCE_SOURCE_MESSAGE });

export type RunClaim = z.infer<typeof RunClaim>;
export type Claim = z.infer<typeof Claim>;
export type Experience = z.infer<typeof Experience>;
export type EvidenceRef = z.infer<typeof Evidence>;
export type DistillationResult = z.infer<typeof DistillationResult>;
