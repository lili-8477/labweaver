// Context graph for the memory panel, after OpenViking's three context types:
// memories (preferences/facts/experience), skills (how-to: the user's and the
// org's SKILL.md) and resources (the user's project folders plus the files and
// datasets memories cite). Topic hubs join memories sharing a gene or tool
// that names no skill. Edges are typed:
//   facet   memory → skill (tool/pipeline facet names it), resource (file/
//           dataset facet), topic (shared gene/tool)
//   project memory → its project folder; file/dataset resource → the project
//           folder its path lies in
//   mention SKILL.md text → another skill or a file/dataset resource it names
// Paths are as the user's container sees them (/workspace/...).

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Pool } from "pg";
import type { Scope } from "./memory-dirs.js";
import { graphMemories } from "./memory-repo.js";
import { encodeProjectDir } from "./path-decode.js";

export type GraphNode =
  | { id: string; kind: "memory"; label: string; description: string; scope: Scope; dir_key: string; deleted?: true }
  | { id: string; kind: "skill"; label: string; description: string; scope: "user" | "org"; path: string }
  | { id: string; kind: "resource"; label: string; type: "project" | "file" | "dataset"; path: string }
  | { id: string; kind: "topic"; label: string; facet: "gene" | "tool" };

export interface GraphEdge {
  source: string;
  target: string;
  kind:   "facet" | "project" | "mention";
}

export interface MemoryGraph {
  nodes:   GraphNode[];
  edges:   GraphEdge[];
  // Nodes left out by the caps, per kind (memories: lowest prior first;
  // others: fewest edges first).
  dropped: Record<GraphNode["kind"], number>;
}

export const GRAPH_MEMORY_LIMIT = 300;
export const GRAPH_NODE_LIMIT = 500;
const SKILL_TEXT_MAX = 64 * 1024;   // SKILL.md bytes scanned for mentions
const MENTION_MIN_LEN = 3;          // shorter names are too noisy to match

// The graph is for a human to inspect lab knowledge, so only skills about lab
// work (experiments, samples, sequencing, analysis, the cluster) are shown;
// UI-design, video and other general tooling skills a workspace carries are
// left out. Matched against a skill's name and description.
const LAB_SKILL = new RegExp("\\b(?:" + [
  "[a-z0-9]*-?seq[a-z]*", "rna", "dna", "chip", "atac", "cut&(?:run|tag)", "genom[a-z]*", "genes?",
  "cells?", "single-cell", "protein[a-z]*", "transcript[a-z]*", "pathways?", "enrichment", "differential",
  "fastq", "bam", "peaks?", "deseq[0-9]*", "bioinfo[a-z]*", "statistic[a-z]*", "data analysis", "datasets?",
  "matplotlib", "plots?", "figures?", "publication", "scientific", "geo", "ncbi", "tcga",
  "experiments?", "assays?", "protocols?", "samples?", "inventory", "reagents?", "antibod[a-z]*",
  "plasmids?", "primers?", "microscop[a-z]*", "cytometry", "qpcr", "western blot",
  "mouse", "mice", "tumou?rs?", "sarcoma", "lab", "slurm", "chpc", "hpc",
].join("|") + ")\\b", "i");

export const isLabSkill = (s: { label: string; description: string }) =>
  LAB_SKILL.test(`${s.label} ${s.description}`);

// Facet values and skill names compare case-insensitively with "-", "_" and
// spaces equivalent: "HCI_scRNAseq" names the skill "hci-scrnaseq".
export const normName = (s: string) => s.trim().toLowerCase().replace(/[-_\s]+/g, "-");

const CONTAINER_WORKSPACE = "/workspace";
const PROJECT_IN_PATH = /(?:^|\/)local_projects\/([^/]+)(?:\/|$)/;

export async function memoryGraph(args: {
  pool:             Pool;
  workspacesRoot:   string;
  username:         string;
  include_deleted?: boolean;
}): Promise<MemoryGraph> {
  const home = path.join(args.workspacesRoot, args.username);
  const [mem, userSkills, orgSkills, projects] = await Promise.all([
    graphMemories({ pool: args.pool, username: args.username, include_deleted: args.include_deleted, limit: GRAPH_MEMORY_LIMIT }),
    readSkills(path.join(home, ".claude", "skills"), "user", `${CONTAINER_WORKSPACE}/.claude/skills`),
    readSkills(path.join(args.workspacesRoot, "shared", "skills"), "org", `${CONTAINER_WORKSPACE}/shared/skills`),
    readProjects(path.join(home, "local_projects")),
  ]);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const link = (source: string, target: string, kind: GraphEdge["kind"]) => {
    if (source !== target) edges.set(`${source}|${target}|${kind}`, { source, target, kind });
  };

  // Skills; on a name collision the user's skill wins, as in the container.
  const skillByName = new Map<string, string>();
  const skills = [...userSkills, ...orgSkills].filter((s) => isLabSkill(s.node));
  for (const s of skills) {
    nodes.set(s.node.id, s.node);
    for (const n of s.names) if (!skillByName.has(normName(n))) skillByName.set(normName(n), s.node.id);
  }

  const projectByEncoded = new Map<string, string>();
  const projectByDir = new Map<string, string>();
  for (const p of projects) {
    const id = `resource:project:${p.dir}`;
    const abs = `${CONTAINER_WORKSPACE}/local_projects/${p.dir}`;
    nodes.set(id, { id, kind: "resource", label: p.name, type: "project", path: abs });
    projectByEncoded.set(encodeProjectDir(abs), id);
    projectByDir.set(p.dir, id);
  }

  // Memories and their facets. Gene/tool values naming no skill are topic
  // candidates until we know how many memories share them.
  const topics = new Map<string, { facet: "gene" | "tool"; label: string; memories: Set<string> }>();
  for (const m of mem.rows) {
    nodes.set(m.memory_id, {
      id: m.memory_id, kind: "memory", label: m.name, description: m.description,
      scope: m.scope, dir_key: m.dir_key, ...(m.deleted ? { deleted: true as const } : {}),
    });
    const project = m.project_dir ? projectByEncoded.get(m.project_dir) : undefined;
    if (project) link(m.memory_id, project, "project");

    for (const [key, values] of Object.entries(m.facets)) {
      for (const raw of values) {
        const value = raw.trim();
        if (!value) continue;
        const skill = key === "tool" || key === "pipeline" ? skillByName.get(normName(value)) : undefined;
        if (skill) {
          link(m.memory_id, skill, "facet");
        } else if (key === "file" || key === "dataset") {
          const id = `resource:${key}:${value}`;
          if (!nodes.has(id)) {
            nodes.set(id, { id, kind: "resource", label: key === "file" ? path.posix.basename(value) || value : value, type: key, path: value });
            const inProject = projectByDir.get(PROJECT_IN_PATH.exec(value)?.[1] ?? "");
            if (inProject) link(id, inProject, "project");
          }
          link(m.memory_id, id, "facet");
        } else if (key === "gene" || key === "tool") {
          const id = `topic:${key}:${normName(value)}`;
          const t = topics.get(id) ?? { facet: key, label: value, memories: new Set<string>() };
          t.memories.add(m.memory_id);
          topics.set(id, t);
        }
      }
    }
  }
  for (const [id, t] of topics) {
    if (t.memories.size < 2) continue;
    nodes.set(id, { id, kind: "topic", label: t.label, facet: t.facet });
    for (const m of t.memories) link(m, id, "facet");
  }

  // Mentions, case-insensitive, in each SKILL.md. Skill names must be written
  // as a reference (`name`, /name, skills/name): many are plain words
  // ("extract", "single-cell") that prose would otherwise match. File and
  // dataset names are distinctive, so whole-word matching is enough.
  const terms: Array<{ term: string; id: string; skill: boolean }> = [];
  for (const sk of skills) for (const n of sk.names) terms.push({ term: n.toLowerCase(), id: skillByName.get(normName(n))!, skill: true });
  for (const n of nodes.values()) {
    if (n.kind !== "resource" || n.type === "project") continue;
    terms.push({ term: n.path.toLowerCase(), id: n.id, skill: false });
    if (n.label !== n.path) terms.push({ term: n.label.toLowerCase(), id: n.id, skill: false });
  }
  for (const sk of skills) {
    const own = new Set(sk.names.map((n) => n.toLowerCase()));
    for (const { term, id, skill } of terms) {
      if (term.length < MENTION_MIN_LEN || own.has(term) || !sk.text.includes(term)) continue;
      const pattern = skill ? skillRefPattern(term) : mentionPattern(term);
      if (pattern.test(sk.text)) link(sk.node.id, id, "mention");
    }
  }

  return capGraph([...nodes.values()], [...edges.values()], mem.total - mem.rows.length);
}

// Whole word: no letter, digit, "_" or "-" either side, so "hci-chipseq"
// does not match inside "hci-chipseq-v2".
function mentionPattern(term: string): RegExp {
  const body = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${body}(?![\\w-])`);
}

// A skill name written as a reference: `name` or `/name`, a /name slash
// command, or a skills/name path.
function skillRefPattern(term: string): RegExp {
  const body = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\`/?${body}\`|(?<![\\w/-])/${body}(?![\\w-])|skills/${body}(?![\\w-])`);
}

// Keep every memory (already capped by the query); fill the rest of the node
// budget with the best-connected other nodes, then drop dangling edges.
function capGraph(nodes: GraphNode[], edges: GraphEdge[], droppedMemories: number): MemoryGraph {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const memories = nodes.filter((n) => n.kind === "memory");
  const others = nodes.filter((n) => n.kind !== "memory")
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  const kept = [...memories, ...others.slice(0, Math.max(0, GRAPH_NODE_LIMIT - memories.length))];
  const dropped = { memory: droppedMemories, skill: 0, resource: 0, topic: 0 };
  for (const n of others.slice(kept.length - memories.length)) dropped[n.kind]++;
  const ids = new Set(kept.map((n) => n.id));
  return { nodes: kept, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)), dropped };
}

interface SkillEntry {
  node:  Extract<GraphNode, { kind: "skill" }>;
  names: string[];   // folder name and frontmatter name
  text:  string;     // SKILL.md, lower-cased and bounded, for mention matching
}

async function readSkills(dir: string, scope: "user" | "org", shownDir: string): Promise<SkillEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = await Promise.all(entries.map(async (e): Promise<SkillEntry | null> => {
    if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name.startsWith(".")) return null;
    const manifest = await readFile(path.join(dir, e.name, "SKILL.md"), "utf8").catch(() => null);
    if (manifest === null) return null;
    const fmName = frontmatterField(manifest, "name");
    return {
      node: {
        id: `skill:${scope}:${e.name}`, kind: "skill", label: fmName || e.name,
        description: frontmatterField(manifest, "description"), scope,
        path: `${shownDir}/${e.name}/SKILL.md`,
      },
      names: fmName && fmName !== e.name ? [e.name, fmName] : [e.name],
      text: manifest.slice(0, SKILL_TEXT_MAX).toLowerCase(),
    };
  }));
  return out.filter((s): s is SkillEntry => s !== null).sort((a, b) => a.node.id.localeCompare(b.node.id));
}

// Single-line `key: value` from a leading YAML frontmatter block; "" if absent.
function frontmatterField(manifest: string, key: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(manifest)?.[1];
  const v = fm ? new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "m").exec(fm)?.[1] : undefined;
  return v ? v.replace(/^['"]|['"]$/g, "") : "";
}

// Project folders as adapter/src/projects.ts lists them: no "."/"_" names,
// display name from .labweaver-project.json.
async function readProjects(root: string): Promise<Array<{ dir: string; name: string }>> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out = await Promise.all(entries
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
    .map(async (e) => {
      const meta = await readFile(path.join(root, e.name, ".labweaver-project.json"), "utf8")
        .then((t) => JSON.parse(t) as { name?: unknown }).catch(() => null);
      const name = typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim() : e.name;
      return { dir: e.name, name };
    }));
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}
