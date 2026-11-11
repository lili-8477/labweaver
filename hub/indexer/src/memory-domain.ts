// Memory domain (GLOSSARY.md): whether a memory is lab knowledge a scientist
// reads in the UI, or technical know-how only the agent uses. The writer —
// the agent, through memory_write or distill — decides, guided by DOMAIN_HELP.
// Dependency-free so the distill schema and the memory contract can share it.

export const DOMAINS = ["lab", "technical"] as const;
export type Domain = (typeof DOMAINS)[number];

/** The domain the chat UI shows: its users are life scientists, not programmers. */
export const UI_DOMAIN: Domain = "lab";

export const DOMAIN_HELP =
  "Who this memory is for. 'lab': science a researcher would want to read — samples, experiments, " +
  "protocols, reagents, analysis choices and their results, biological findings, lab decisions and " +
  "preferences. 'technical': software know-how only you need — code, packages, environment, file " +
  "formats, tool errors and workarounds, notebook mechanics. When a memory is about how to analyse " +
  "data scientifically (e.g. which normalisation suits low-depth samples), it is 'lab'; when it is " +
  "about making the code run (e.g. setting MPLCONFIGDIR), it is 'technical'.";
