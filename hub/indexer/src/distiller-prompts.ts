import { z } from "zod";

export const PROMPT_VERSION = 1;

const Facets = z
  .object({
    gene:     z.array(z.string()).optional(),
    dataset:  z.array(z.string()).optional(),
    tool:     z.array(z.string()).optional(),
    pipeline: z.array(z.string()).optional(),
    file:     z.array(z.string()).optional(),
  })
  .strict();

const Observation = z.object({
  type: z.enum([
    "decision",
    "finding",
    "file-touched",
    "command-result",
    "user-preference",
  ]),
  name:        z.string().max(80),
  description: z.string().max(200),
  body:        z.string().max(800),
  facets:      Facets,
});

export const DistillationResult = z.object({
  summary: z.object({
    name:        z.string().max(80),
    description: z.string().max(200),
    body:        z.string().max(1500),
  }),
  observations: z.array(Observation).max(8),
});

export type DistillationResult = z.infer<typeof DistillationResult>;
export type Observation = z.infer<typeof Observation>;

const SYSTEM_PROMPT = `You distill a Claude Code session transcript into structured memory rows for later retrieval. Output strict JSON matching the schema below. Be terse. Skip operational noise (file listings, command echoes, retries).

Schema:
{
  "summary": { "name": string ≤80c, "description": string ≤200c, "body": string ≤1500c },
  "observations": [  // 0..8 items
    {
      "type": "decision" | "finding" | "file-touched" | "command-result" | "user-preference",
      "name": string ≤80c,
      "description": string ≤200c,
      "body": string ≤800c,
      "facets": { "gene"?: string[], "dataset"?: string[], "tool"?: string[], "pipeline"?: string[], "file"?: string[] }
    }
  ]
}

Rules:
- 'user-preference' captures something the user expressed about how they want the agent to work or what they care about.
- 'decision' captures a chosen approach with the why; not what was tried and discarded.
- 'finding' captures a surprising fact the agent learned (data shape, bug root cause, env quirk).
- 'file-touched' is a path + one-line summary of what changed and why.
- 'command-result' is a command that produced a result the user is likely to need again (path-to-output, key number, error fingerprint).
- Skip everything else. Empty observations array is fine.`;

export function buildDistillationPrompt(args: { transcript: string }): {
  system: string;
  user: string;
  promptVersion: number;
} {
  return {
    system: SYSTEM_PROMPT,
    user: args.transcript,
    promptVersion: PROMPT_VERSION,
  };
}
