/** Keep small structural fields and a complete, retrievable result before reducing large values. */
export function preserveToolResult(h, session, agent, name, value, limit = 6000) {
  const text = JSON.stringify(value);
  if (text.length <= limit) return value;
  const artifact = h.artifact(session, `${name}-result.json`, text, agent.id);
  function project(input, depth = 0) {
    if (typeof input === "string")
      return input.length <= 1200
        ? input
        : { preview: input.slice(0, 1200), totalCharacters: input.length, truncated: true };
    if (Array.isArray(input))
      return input.length <= 20 && depth < 3
        ? input.map((v) => project(v, depth + 1))
        : {
            preview: input.slice(0, 5).map((v) => project(v, depth + 1)),
            totalItems: input.length,
            truncated: true,
          };
    if (input && typeof input === "object")
      return depth < 4
        ? Object.fromEntries(
            Object.entries(input)
              .slice(0, 40)
              .map(([k, v]) => [k, project(v, depth + 1)]),
          )
        : { truncated: true };
    return input;
  }
  return {
    ...(value && typeof value === "object" && !Array.isArray(value)
      ? project(value)
      : { result: project(value) }),
    artifactId: artifact.id,
    totalCharacters: text.length,
    truncated: true,
    readWith: { tool: "artifact_read", id: artifact.id, offset: 0 },
  };
}
