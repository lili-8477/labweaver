// Ambient shim so TS resolves `import("node-pty")` before npm install runs.
// Once node-pty is actually installed its bundled types take precedence.
declare module 'node-pty';
