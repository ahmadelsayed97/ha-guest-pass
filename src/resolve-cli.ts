import { loadConfig } from "./config.ts";
import { fetchRegistries, HAClient } from "./ha-client.ts";
import { resolveScope, type ResolvedScope } from "./resolve.ts";
import { parseScopeDefinition } from "./scope-definition.ts";

async function main(definitionPath: string, outputArg: string | undefined): Promise<void> {
  const config = loadConfig();
  const outputPath = outputArg ?? config.scopeFile;
  const definition = parseScopeDefinition(await Bun.file(definitionPath).json());

  const client = await HAClient.connect(config);
  let resolved: ResolvedScope;
  try {
    resolved = resolveScope(definition, await fetchRegistries(client));
  } finally {
    client.close();
  }

  const { sources, ...scope } = resolved;
  await Bun.write(outputPath, JSON.stringify(scope, null, 2) + "\n");
  report(resolved, outputPath);
}

function report({ dashboards, entities, sources }: ResolvedScope, outputPath: string): void {
  const bySource = new Map<string, string[]>();
  for (const [entityId, source] of Object.entries(sources)) {
    bySource.set(source, [...(bySource.get(source) ?? []), `${entityId} (${entities[entityId]})`]);
  }
  for (const [source, lines] of bySource) {
    console.log(source);
    for (const line of lines.sort()) console.log(`  ${line}`);
  }
  console.log(`dashboards: ${dashboards.join(", ") || "(none)"}`);
  console.log(`wrote ${Object.keys(entities).length} entities to ${outputPath}`);
}

const [definitionPath, outputArg] = process.argv.slice(2);
if (!definitionPath) {
  console.error("usage: bun run resolve <definition.json> [output.json]");
  process.exit(2);
}
main(definitionPath, outputArg).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
